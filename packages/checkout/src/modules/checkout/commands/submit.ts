import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { buildTrustedCommandContext } from '@open-mercato/shared/lib/commands/trusted-context'
import { CrudHttpError, notFound } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { SalesLineSnapshot } from '@open-mercato/core/modules/sales/lib/types'
import type { SalesCalculationService } from '@open-mercato/core/modules/sales/services/salesCalculationService'
import type { CartService } from '@open-mercato/core/modules/cart/lib/cartService'
import type { CartSalesSnapshot } from '@open-mercato/core/modules/cart/lib/toSalesSnapshots'
import type {
  CustomerCreditService,
  ReserveCreditResult,
} from '@open-mercato/core/modules/customer_groups/services/customerCreditService'
import { CheckoutSession } from '../data/entities'
import {
  assertCartMatchesCheckoutScope,
  resolveRequestStoreIdForConsistencyCheck,
} from '../lib/cartSessionConsistency'
import { lookupCartEnteredCodes, lookupCartPeerById } from '../lib/cartPeer'
import { lookupCartLinePeers } from '../lib/cartLinesPeer'
import { getOrComputeDeliveryOptions } from '../lib/deliveryRateCache'
import { computeDeliveryOptions } from '../lib/deliveryRateQuote'
import { hashAddressForCache, hashCartLinesForCache, resolveDestinationAddress } from '../lib/deliveryAddress'
import { evaluateDeliveryDiscount } from '../lib/promotionsDeliveryEvaluation'
import { writeSessionEvent } from '../lib/sessionEvents'
import { tryResolve } from '../lib/tryResolve'
import { emitCheckoutEvent } from '../events'

// Release 5, Step 4.1 (checkout B.4 submit, §7.1/§7.2 steps 1-5, C3/C7/C19, D-R5-24/D-R5-30).
// Builds EXACTLY steps 1-5 of the revised submit sequence — preconditions, `cart.lock`,
// `availability.reserve`, on-account `reserveCredit`, idempotent document creation plus the
// C7 goods-totals equality check — and STOPS there. `availability.commit`, credit linkage,
// code usage, the gateway step and `markConverted`'s `lineMap` are Step 4.2's own scope; this
// command never reaches a terminal session status (`completed`/`failed`) — on success the
// session is left `submitting`, `submitProgress: 'document_created'`, with
// `salesQuoteId`/`salesOrderId` written, ready for Step 4.2 to continue from exactly this
// point. `purpose` stays `'order'` always in this Step (the quote/`request_quote` branch is
// Step 5.1's own scope — see NOTIFY.md for why `request_quote` is refused here outright).
//
// Payment-method-selection question (tracked in NOTIFY.md after Step 2.13): RESOLVED as
// "submit takes the method as a direct input" — `paymentMethodCode` is a required field on
// this command's own input, never read off the session. No `POST /sessions/current/payment`
// selection route is built by this Step (nor by any Step before it); a caller that wants one
// can add it later purely as a convenience that stores the choice ahead of submit — this
// command does not depend on it existing.
//
// Each of steps 1-5 is dispatched as its own, separately-committing call (cart.lock,
// availability.reserve, customerCreditService.reserveCredit, sales.quotes.create,
// sales.quotes.convert_to_order) — this orchestrating function is NOT itself wrapped in one
// outer transaction (§7.2's own "each step is a separate transaction"). Idempotency is
// carried by each step's own key (`stock_reservation_key`/`credit_reservation_key`/
// `external_reference`, all derived from `sessionId` + `attempt`), not by this function being
// re-entrant mid-flight — a genuinely crashed process is Step 4.2's `recover-stuck-submits`
// job (C24), not a second client call while `status = 'submitting'` (§7.4: that is the
// uniform `409 submit_in_progress`, never a resume).

const logger = createLogger('checkout')

export type CheckoutSessionSubmitCommandInput = {
  sessionId: string
  tenantId: string
  organizationId: string
  idempotencyKey: string
  paymentMethodCode: string
  request?: Request | null
}

export type CheckoutSessionSubmitStageResult = {
  session: CheckoutSession
  attempt: number
  stockReservationKey: string | null
  creditReservationKey: string | null
  salesQuoteId: string
  salesOrderId: string
}

type SubmitScope = { tenantId: string; organizationId: string }

function buildTrustedCtx(
  container: CommandRuntimeContext['container'],
  scope: SubmitScope,
  reason: string,
): CommandRuntimeContext {
  const { ctx } = buildTrustedCommandContext({
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    actorType: 'system',
    reason,
  })
  return { ...ctx, container }
}

function roundTo2dp(amount: number): string {
  return amount.toFixed(2)
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

const TOTALS_EPSILON = 0.0005

function amountsEqual(a: number, b: number, epsilon = TOTALS_EPSILON): boolean {
  return Math.abs(a - b) <= epsilon
}

// C7's "goods totals equal the locked cart's totals" — compared on the keys a document's
// own shipping/delivery-discount adjustments can never touch (`taxTotalAmount` only stays
// untouched because this command never puts a tax rate on either of its own shipping/
// discount adjustment drafts, below).
const GOODS_TOTALS_KEYS = [
  'subtotalNetAmount',
  'subtotalGrossAmount',
  'discountTotalAmount',
  'taxTotalAmount',
  'grandTotalNetAmount',
  'grandTotalGrossAmount',
] as const

function findGoodsTotalsMismatch(
  cartTotals: Record<string, unknown>,
  goodsCalcTotals: Record<string, unknown>,
): string | null {
  for (const key of GOODS_TOTALS_KEYS) {
    if (!amountsEqual(toNumber(cartTotals[key]), toNumber(goodsCalcTotals[key]))) return key
  }
  return null
}

// Per-(catalogProductId, catalogVariantId) sum — `availability.reserve`'s own input schema
// refuses a duplicate pair per call ("the caller sums duplicate cart lines").
function buildReservationItems(
  lines: SalesLineSnapshot[],
): Array<{ catalogProductId: string; catalogVariantId: string | null; quantity: number }> {
  const byKey = new Map<string, { catalogProductId: string; catalogVariantId: string | null; quantity: number }>()
  for (const line of lines) {
    if (!line.productId) continue
    const key = `${line.productId}:${line.productVariantId ?? ''}`
    const existing = byKey.get(key)
    if (existing) {
      existing.quantity += line.quantity
    } else {
      byKey.set(key, { catalogProductId: line.productId, catalogVariantId: line.productVariantId ?? null, quantity: line.quantity })
    }
  }
  return Array.from(byKey.values())
}

type CompensationFlags = { releaseCredit: boolean; releaseStock: boolean; unlockCart: boolean }

/**
 * §7.3's compensation table for steps 1-5: release whatever was taken, in reverse order,
 * then return the session to `open` — UNLESS the compensation itself fails, in which case
 * the session is left `submitting` (recoverable by Step 4.2's own job) rather than silently
 * returning to `open` while a reservation may still be live (§7.3: "never swallowed").
 */
async function compensate(
  container: CommandRuntimeContext['container'],
  em: EntityManager,
  session: CheckoutSession,
  scope: SubmitScope,
  flags: CompensationFlags,
  keys: { stockReservationKey: string | null; creditReservationKey: string | null },
): Promise<void> {
  const ctx = buildTrustedCtx(container, scope, `checkout:submit:compensate:${session.id}`)
  const failures: string[] = []

  if (flags.releaseCredit && keys.creditReservationKey) {
    const customerCreditService = tryResolve<CustomerCreditService>(container, 'customerCreditService')
    if (customerCreditService) {
      try {
        await customerCreditService.releaseCredit({
          scope,
          reserveIdempotencyKey: keys.creditReservationKey,
          reason: 'checkout_submit_aborted',
        })
      } catch (err) {
        logger.error('[internal] checkout submit compensation: credit release failed', { err, sessionId: session.id })
        failures.push('credit')
      }
    }
  }

  if (flags.releaseStock && keys.stockReservationKey && tryResolve(container, 'policyResolutionService')) {
    const commandBus = container.resolve('commandBus') as CommandBus
    try {
      await commandBus.execute('availability.release', {
        input: { tenantId: scope.tenantId, organizationId: scope.organizationId, idempotencyKey: keys.stockReservationKey, reason: 'checkout_submit_aborted' },
        ctx,
      })
    } catch (err) {
      logger.error('[internal] checkout submit compensation: stock release failed', { err, sessionId: session.id })
      failures.push('stock')
    }
  }

  if (flags.unlockCart && session.cartId) {
    const cartService = tryResolve<CartService>(container, 'cartService')
    if (cartService) {
      try {
        await cartService.unlock({ cartId: session.cartId, tenantId: scope.tenantId, organizationId: scope.organizationId, checkoutSessionId: session.id })
      } catch (err) {
        logger.error('[internal] checkout submit compensation: cart unlock failed', { err, sessionId: session.id })
        failures.push('cart')
      }
    }
  }

  if (failures.length > 0) {
    await writeSessionEvent(em, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      sessionId: session.id,
      kind: 'failure',
      actor: 'system',
      payload: { stage: 'compensation', failed: failures },
    })
    await emitCheckoutEvent('checkout.compensation.failed', {
      sessionId: session.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      failed: failures,
    }).catch(() => undefined)
    // Deliberately left `submitting` — a leaked reservation is invisible exposure/inventory
    // and needs a human or Step 4.2's recovery job, not a silent return to `open`.
    return
  }

  await em.nativeUpdate(
    CheckoutSession,
    { id: session.id, tenantId: scope.tenantId, organizationId: scope.organizationId, status: 'submitting' },
    { status: 'open', updatedAt: new Date() },
  )
  await writeSessionEvent(em, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    sessionId: session.id,
    kind: 'compensation',
    actor: 'system',
    payload: { released: flags },
  })
  await emitCheckoutEvent('checkout.compensation.executed', {
    sessionId: session.id,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  }).catch(() => undefined)
}

const submitSessionCommand: CommandHandler<CheckoutSessionSubmitCommandInput, CheckoutSessionSubmitStageResult> = {
  id: 'checkout.session.submit',
  isUndoable: false,
  async execute(input, ctx) {
    const scope: SubmitScope = { tenantId: input.tenantId, organizationId: input.organizationId }
    const container = ctx.container
    const em = (container.resolve('em') as EntityManager).fork()

    const session = await findOneWithDecryption(em, CheckoutSession, { id: input.sessionId, ...scope }, undefined, scope)
    if (!session) throw notFound('[internal] checkout session not found')

    if (session.status === 'submitting') {
      // §7.4: a repeat while an attempt is in flight is a uniform 409, never a resume — a
      // crashed attempt is recovered by Step 4.2's own job (C24), not by calling this
      // command a second time.
      throw new CrudHttpError(409, { error: '[internal] a submit attempt is already in flight for this session', code: 'submit_in_progress' })
    }
    if (session.status !== 'open') {
      throw new CrudHttpError(409, { error: '[internal] checkout session is not open', code: 'session_not_open' })
    }
    if (!session.cartId) {
      throw new CrudHttpError(422, { error: '[internal] no cart is attached to this session', code: 'steps_incomplete' })
    }
    if (!session.shippingMethod) {
      throw new CrudHttpError(422, { error: '[internal] a delivery method must be selected before submit', code: 'steps_incomplete' })
    }
    // C15/§5.5 (request_quote, D-R5-20): Step 5.1's own scope — `cart.lock`'s `purpose`
    // stays `'order'` unconditionally in this Step, so a quote-branch payment method cannot
    // be honored correctly yet. Refused with the spec's own "method not offered" code rather
    // than silently treated as a gateway/on-account method.
    if (input.paymentMethodCode === 'request_quote') {
      throw new CrudHttpError(422, { error: '[internal] request_quote is not available yet', code: 'payment_method_unavailable' })
    }

    // Preconditions check 4 (C9, re-verified at submit per the C9 guard's own contract —
    // Step 3.5's cart/session may have drifted since session creation). Three of the four
    // comparisons compare the session's OWN stored fields against the FRESH cart peer read
    // just below; the store comparison re-resolves the request's store context.
    const cartPeer = await lookupCartPeerById(em, session.cartId, scope)
    if (!cartPeer || cartPeer.kind !== 'basket') throw notFound('[internal] cart not found')
    const resolvedStoreId = await resolveRequestStoreIdForConsistencyCheck(container, cartPeer.storeId, input.request)
    assertCartMatchesCheckoutScope({
      cart: {
        storeId: cartPeer.storeId,
        channel: cartPeer.channel,
        currencyCode: cartPeer.currencyCode,
        tenantId: cartPeer.tenantId,
        organizationId: cartPeer.organizationId,
      },
      session: {
        channel: session.channel,
        currencyCode: session.currencyCode,
        tenantId: session.tenantId,
        organizationId: session.organizationId,
      },
      resolvedStoreId,
    })

    // §7.2 step 0: CAS open -> submitting, submit_attempt += 1, fresh keys.
    const attempt = session.submitAttempt + 1
    const stockReservationKey = `checkout:${session.id}:${attempt}:stock`
    const creditReservationKey = `checkout:${session.id}:${attempt}:credit`
    const externalReference = `checkout:${session.id}:${attempt}`

    const casAffected = await em.nativeUpdate(
      CheckoutSession,
      { id: session.id, ...scope, status: 'open' },
      {
        status: 'submitting',
        submitAttempt: attempt,
        submitIdempotencyKey: input.idempotencyKey,
        stockReservationKey,
        creditReservationKey,
        submitStartedAt: new Date(),
        submitProgress: null,
        failureCode: null,
        failureDetail: null,
        updatedAt: new Date(),
      },
    )
    if (casAffected === 0) {
      throw new CrudHttpError(409, { error: '[internal] a submit attempt is already in flight for this session', code: 'submit_in_progress' })
    }
    session.status = 'submitting'
    session.submitAttempt = attempt
    session.stockReservationKey = stockReservationKey
    session.creditReservationKey = creditReservationKey

    await emitCheckoutEvent('checkout.session.submitted', {
      sessionId: session.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      cartId: session.cartId,
      attempt,
    }).catch(() => undefined)

    const trustedCtx = buildTrustedCtx(container, scope, `checkout:submit:${session.id}:${attempt}`)

    // ---------------------------------------------------------------------
    // Step 1 (§7.2 step 1, C1/C2): cart.lock
    // ---------------------------------------------------------------------
    const cartService = tryResolve<CartService>(container, 'cartService')
    if (!cartService) {
      throw new CrudHttpError(503, { error: '[internal] checkout sessions are unavailable without the cart module', code: 'checkout_sessions_unavailable' })
    }

    let lockResult
    try {
      lockResult = await cartService.lock({
        cartId: session.cartId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        checkoutSessionId: session.id,
        purpose: 'order',
        request: input.request,
      })
    } catch (err) {
      await compensate(container, em, session, scope, { releaseCredit: false, releaseStock: false, unlockCart: false }, { stockReservationKey, creditReservationKey })
      throw err
    }
    if (lockResult.priceChanges.length > 0) {
      await compensate(container, em, session, scope, { releaseCredit: false, releaseStock: false, unlockCart: true }, { stockReservationKey, creditReservationKey })
      throw new CrudHttpError(409, { error: '[internal] the cart re-priced at submit', code: 'price_changed', priceChanges: lockResult.priceChanges })
    }

    await writeSessionEvent(em, { ...scope, sessionId: session.id, kind: 'cart_locked', actor: 'system', payload: { cartId: session.cartId } })

    // ---------------------------------------------------------------------
    // §7.2 step 2 (delivery re-evaluation, D-R5-17): re-validate the stored shipping rate
    // and delivery promotion against the SAME deliveryMethodCode, closing the §7.2-step-2
    // gap Step 2.13's own NOTIFY entry flagged for this Step to close "for real" — codes are
    // re-derived from the cart's own `cart_promotion_applications` rows, never `codes: []`.
    // ---------------------------------------------------------------------
    const shippingMethod = session.shippingMethod as { deliveryMethodCode: string; price: string } | null
    if (!shippingMethod) {
      await compensate(container, em, session, scope, { releaseCredit: false, releaseStock: false, unlockCart: true }, { stockReservationKey, creditReservationKey })
      throw new CrudHttpError(422, { error: '[internal] a delivery method must be selected before submit', code: 'steps_incomplete' })
    }

    const containerWithRegister = container as unknown as {
      resolve: <T = unknown>(name: string) => T
      register: (registrations: Record<string, unknown>) => unknown
    }
    const destination = resolveDestinationAddress(session.shippingAddress)
    let freshDeliveryCost = shippingMethod.price
    if (destination) {
      const lines = await lookupCartLinePeers(em, session.cartId, scope)
      const addressHash = hashAddressForCache(destination)
      const cartHash = hashCartLinesForCache(lines)
      const options = await getOrComputeDeliveryOptions(
        containerWithRegister,
        { tenantId: scope.tenantId, organizationId: scope.organizationId, sessionId: session.id },
        addressHash,
        cartHash,
        () =>
          computeDeliveryOptions(
            containerWithRegister,
            em,
            {
              id: session.id,
              tenantId: session.tenantId,
              organizationId: session.organizationId,
              cartId: session.cartId ?? null,
              storeId: session.storeId ?? null,
              linkId: session.linkId ?? null,
              channel: session.channel,
              currencyCode: session.currencyCode,
            },
            destination,
          ),
      )
      const stillOffered = options.find((option) => option.deliveryMethodCode === shippingMethod.deliveryMethodCode)
      if (!stillOffered) {
        await compensate(container, em, session, scope, { releaseCredit: false, releaseStock: false, unlockCart: true }, { stockReservationKey, creditReservationKey })
        throw new CrudHttpError(409, { error: '[internal] the delivery method is no longer available', code: 'price_changed', reason: 'delivery_changed' })
      }
      freshDeliveryCost = stillOffered.cost
    }

    const enteredCodes = await lookupCartEnteredCodes(em, session.cartId, scope)
    const freshDeliveryDiscount = await evaluateDeliveryDiscount(containerWithRegister, em, {
      sessionId: session.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      cartId: session.cartId,
      currencyCode: session.currencyCode,
      deliveryMethodCode: shippingMethod.deliveryMethodCode,
      deliveryCost: freshDeliveryCost,
      codes: enteredCodes,
    })

    const storedQuotedTotals = (session.quotedTotals ?? {}) as { deliveryCost?: string; deliveryDiscount?: string | null }
    const freshDeliveryDiscountGross = freshDeliveryDiscount ? freshDeliveryDiscount.amountGross : null
    if (
      storedQuotedTotals.deliveryCost !== undefined &&
      !amountsEqual(toNumber(storedQuotedTotals.deliveryCost), toNumber(freshDeliveryCost))
    ) {
      await compensate(container, em, session, scope, { releaseCredit: false, releaseStock: false, unlockCart: true }, { stockReservationKey, creditReservationKey })
      throw new CrudHttpError(409, { error: '[internal] the delivery cost changed at submit', code: 'price_changed', reason: 'delivery_changed' })
    }
    if (
      storedQuotedTotals.deliveryDiscount !== undefined &&
      !amountsEqual(toNumber(storedQuotedTotals.deliveryDiscount ?? '0'), toNumber(freshDeliveryDiscountGross ?? '0'))
    ) {
      await compensate(container, em, session, scope, { releaseCredit: false, releaseStock: false, unlockCart: true }, { stockReservationKey, creditReservationKey })
      throw new CrudHttpError(409, { error: '[internal] a newly-eligible delivery promotion changed the price', code: 'price_changed', reason: 'promotion_newly_eligible' })
    }

    // ---------------------------------------------------------------------
    // cartService.getSalesSnapshot (C7) — the one source checkout uses to build the quote.
    // ---------------------------------------------------------------------
    let snapshot: CartSalesSnapshot
    try {
      snapshot = await cartService.getSalesSnapshot({
        cartId: session.cartId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        checkoutSessionId: session.id,
      })
    } catch (err) {
      await compensate(container, em, session, scope, { releaseCredit: false, releaseStock: false, unlockCart: true }, { stockReservationKey, creditReservationKey })
      throw err
    }
    // Precondition 3 (§7.1): "Cart non-empty, active..." — checked here, right after the
    // one read that can prove it, rather than a second, earlier cart-lines read of its own.
    if (snapshot.lines.length === 0) {
      await compensate(container, em, session, scope, { releaseCredit: false, releaseStock: false, unlockCart: true }, { stockReservationKey, creditReservationKey })
      throw new CrudHttpError(409, { error: '[internal] the cart has no lines', code: 'cart_empty' })
    }

    // ---------------------------------------------------------------------
    // Step 3 (§7.2 step 3, A6/A15, D-R5-9): availability.reserve
    // ---------------------------------------------------------------------
    const availabilityActive = !!tryResolve(container, 'policyResolutionService')
    if (availabilityActive) {
      const items = buildReservationItems(snapshot.lines.map((line) => line.snapshot))
      if (items.length > 0) {
        const commandBus = container.resolve('commandBus') as CommandBus
        const { result: reserveResult } = await commandBus.execute<unknown, {
          reserved: boolean
          shortfall: Array<{ catalogProductId: string; catalogVariantId: string | null; requested: number; available: number }>
        }>('availability.reserve', {
          input: {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            items,
            sourceType: 'checkout',
            sourceId: session.id,
            idempotencyKey: stockReservationKey,
            ttlSeconds: 900,
          },
          ctx: trustedCtx,
        })
        if (!reserveResult.reserved) {
          await compensate(container, em, session, scope, { releaseCredit: false, releaseStock: true, unlockCart: true }, { stockReservationKey, creditReservationKey })
          throw new CrudHttpError(409, { error: '[internal] one or more lines are out of stock', code: 'stock_shortfall', shortfall: reserveResult.shortfall })
        }
      }
    }
    await writeSessionEvent(em, { ...scope, sessionId: session.id, kind: 'stock_reserved', actor: 'system', payload: { stockReservationKey } })

    // ---------------------------------------------------------------------
    // Step 4 (§7.2 step 4, D-R5-24): on-account reserveCredit, for the FULL PAYABLE amount
    // (goods gross after promotions + delivery cost - delivery discount).
    // ---------------------------------------------------------------------
    const goodsGross = toNumber(snapshot.totals.grandTotalGrossAmount)
    const deliveryDiscountGrossAbs = freshDeliveryDiscount ? Math.abs(toNumber(freshDeliveryDiscount.amountGross)) : 0
    const payableGross = goodsGross + toNumber(freshDeliveryCost) - deliveryDiscountGrossAbs
    const payableAmount = roundTo2dp(payableGross)

    const isOnAccount = input.paymentMethodCode === 'on_account'
    if (isOnAccount) {
      const customerCreditService = tryResolve<CustomerCreditService>(container, 'customerCreditService')
      let reserveResult: ReserveCreditResult | null = null
      if (customerCreditService) {
        reserveResult = await customerCreditService.reserveCredit({
          scope,
          buyer: { customerIds: cartPeer.customerIds },
          currencyCode: session.currencyCode,
          amount: payableAmount,
          sourceType: 'checkout',
          sourceId: session.id,
          idempotencyKey: creditReservationKey,
        })
      }
      if (!reserveResult || !reserveResult.reserved) {
        await compensate(container, em, session, scope, { releaseCredit: false, releaseStock: true, unlockCart: true }, { stockReservationKey, creditReservationKey })
        throw new CrudHttpError(402, { error: '[internal] credit was refused', code: 'credit_refused', reason: reserveResult?.check.reason ?? 'no_account' })
      }
      await writeSessionEvent(em, { ...scope, sessionId: session.id, kind: 'credit_reserved', actor: 'system', payload: { creditReservationKey } })
    }

    // ---------------------------------------------------------------------
    // Step 5 (§7.2 step 5, C3/C7/D-R5-24): idempotent document creation.
    // ---------------------------------------------------------------------
    const commandBus = container.resolve('commandBus') as CommandBus
    const salesCalculationService = tryResolve<SalesCalculationService>(container, 'salesCalculationService')
    if (!salesCalculationService) {
      await compensate(container, em, session, scope, { releaseCredit: isOnAccount, releaseStock: true, unlockCart: true }, { stockReservationKey, creditReservationKey })
      throw new CrudHttpError(503, { error: '[internal] checkout submit is unavailable without the sales module', code: 'checkout_sessions_unavailable' })
    }

    const existingQuote = await findExistingQuoteByExternalReference(em, scope, externalReference)
    let quoteId: string
    if (existingQuote) {
      quoteId = existingQuote.id
    } else {
      const quoteLines = snapshot.lines.map((line, index) => ({
        ...line.snapshot,
        lineNumber: index + 1,
        metadata: { ...(line.snapshot.metadata ?? {}), cartLineId: line.cartLineId },
      }))
      const { result: createResult } = await commandBus.execute<unknown, { quoteId: string }>('sales.quotes.create', {
        input: {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          externalReference,
          currencyCode: session.currencyCode,
          customerEntityId: session.customerId ?? undefined,
          shippingAddressSnapshot: session.shippingAddress ?? undefined,
          billingAddressSnapshot: session.billingSameAsShipping ? session.shippingAddress ?? undefined : session.billingAddress ?? undefined,
          shippingMethodCode: shippingMethod.deliveryMethodCode,
          shippingMethodSnapshot: session.shippingMethod ?? undefined,
          paymentMethodCode: input.paymentMethodCode,
          lines: quoteLines,
          adjustments: [
            ...snapshot.adjustments,
            {
              scope: 'order' as const,
              kind: 'shipping',
              label: 'Shipping',
              amountNet: toNumber(freshDeliveryCost),
              amountGross: toNumber(freshDeliveryCost),
              currencyCode: session.currencyCode,
            },
            ...(freshDeliveryDiscount
              ? [
                  {
                    scope: 'order' as const,
                    kind: 'discount',
                    label: freshDeliveryDiscount.promotionName,
                    promotionId: freshDeliveryDiscount.promotionId,
                    amountNet: Number(freshDeliveryDiscount.amountNet),
                    amountGross: Number(freshDeliveryDiscount.amountGross),
                    currencyCode: session.currencyCode,
                  },
                ]
              : []),
          ],
          metadata: { sourceModule: 'checkout', checkoutSessionId: session.id },
        },
        ctx: trustedCtx,
      })
      quoteId = createResult.quoteId
    }

    // C7: the goods totals that will land on this quote's LINES must equal the cart's own
    // locked totals — computed independently, via the SAME engine and the SAME lines +
    // (goods-only) adjustments, rather than read off the persisted quote row (which also
    // carries the shipping/delivery-discount adjustments added just above and therefore is
    // not directly comparable key-for-key, since the calculation engine folds a `shipping`
    // adjustment into `subtotalNet/GrossAmount` by design).
    const goodsCalc = await salesCalculationService.calculateDocumentTotals({
      documentKind: 'quote',
      lines: snapshot.lines.map((line) => line.snapshot),
      adjustments: snapshot.adjustments,
      context: { tenantId: scope.tenantId, organizationId: scope.organizationId, currencyCode: session.currencyCode, metadata: { source: 'checkout', sessionId: session.id } },
    })
    const mismatchKey = findGoodsTotalsMismatch(snapshot.totals, goodsCalc.totals as unknown as Record<string, unknown>)
    const payableMismatch = isOnAccount && !amountsEqual(toNumber(payableAmount), toNumber(goodsCalc.totals.grandTotalGrossAmount) + toNumber(freshDeliveryCost) - deliveryDiscountGrossAbs)
    if (mismatchKey || payableMismatch) {
      logger.error('[internal] checkout submit: totals mismatch at document creation, raising an ops notification', {
        sessionId: session.id,
        mismatchKey,
        payableMismatch,
      })
      await compensate(container, em, session, scope, { releaseCredit: isOnAccount, releaseStock: true, unlockCart: true }, { stockReservationKey, creditReservationKey })
      throw new CrudHttpError(500, { error: '[internal] totals did not match at document creation', code: 'totals_mismatch' })
    }

    const existingOrder = await findExistingOrderById(em, scope, quoteId)
    let orderId: string
    if (existingOrder) {
      orderId = existingOrder.id
    } else {
      const { result: convertResult } = await commandBus.execute<unknown, { orderId: string }>('sales.quotes.convert_to_order', {
        input: { quoteId },
        ctx: trustedCtx,
      })
      orderId = convertResult.orderId
    }

    await em.nativeUpdate(
      CheckoutSession,
      { id: session.id, ...scope },
      { salesQuoteId: quoteId, salesOrderId: orderId, submitProgress: 'document_created', updatedAt: new Date() },
    )
    session.salesQuoteId = quoteId
    session.salesOrderId = orderId
    session.submitProgress = 'document_created'

    await writeSessionEvent(em, { ...scope, sessionId: session.id, kind: 'document_created', actor: 'system', payload: { quoteId, orderId } })

    return {
      session,
      attempt,
      stockReservationKey: availabilityActive ? stockReservationKey : null,
      creditReservationKey: isOnAccount ? creditReservationKey : null,
      salesQuoteId: quoteId,
      salesOrderId: orderId,
    }
  },
}

async function findExistingQuoteByExternalReference(
  em: EntityManager,
  scope: SubmitScope,
  externalReference: string,
): Promise<{ id: string } | null> {
  const row = await em
    .getKysely<{
      sales_quotes: { id: string; tenant_id: string; organization_id: string; external_reference: string | null; deleted_at: Date | null }
    }>()
    .selectFrom('sales_quotes')
    .select(['id'])
    .where('tenant_id', '=', scope.tenantId)
    .where('organization_id', '=', scope.organizationId)
    .where('external_reference', '=', externalReference)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return row ? { id: row.id } : null
}

async function findExistingOrderById(
  em: EntityManager,
  scope: SubmitScope,
  orderId: string,
): Promise<{ id: string } | null> {
  const row = await em
    .getKysely<{ sales_orders: { id: string; tenant_id: string; organization_id: string; deleted_at: Date | null } }>()
    .selectFrom('sales_orders')
    .select(['id'])
    .where('id', '=', orderId)
    .where('tenant_id', '=', scope.tenantId)
    .where('organization_id', '=', scope.organizationId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return row ? { id: row.id } : null
}

registerCommand(submitSessionCommand)

export { submitSessionCommand }
