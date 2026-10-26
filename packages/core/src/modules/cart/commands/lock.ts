import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandBus, CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { emitCrudSideEffects } from '@open-mercato/shared/lib/commands/helpers'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { CrudHttpError, notFound } from '@open-mercato/shared/lib/crud/errors'
import type { CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { E } from '#generated/entities.ids.generated'
import { Cart, CartLine } from '../data/entities'
import type { ResolvedCartRouteContext } from '../lib/routeContext'
import { resolveCartLockTimeoutMs } from '../lib/sweepConfig'
import { assertCartNotLocked } from '../lib/lockGuard'
import { emitCartEvent } from '../events'
import { repriceCartCommand, toCartSummary } from './cart'
import type { CartRepriceInput, CartRepriceResult, CartSummary } from './cart'

// Step 7.5 — §9's `active -> locked`, `locked -> active` and `locked -> converted` rows:
// `cart.lock`, `cart.unlock`, `cart.markConverted`. §10 is explicit that none of the three
// has a public route in this release ("`checkout` calls the DI service/command directly,
// in-process") — there is no `checkout` module in this worktree yet, so none of these three
// commands has a real caller today. That is the expected state this step leaves them in,
// not a gap: the DI facade (`cart/di.ts`'s `cartService`) and these commands are the seam
// a future `checkout` module reaches for.
//
// None of the three is in §3.1a's undo table ("a lock is a checkout-session concern, not
// buyer content"; "terminal; the cart becomes read-only history once a `SalesOrder`
// exists") — no `undo` handler, matching this file set's own precedent for a non-undoable
// command (`cart.reprice`, `cart.lines.update`, `cart.promotions.apply`/`.remove`), none of
// which carry a `buildLog` audit entry either. Same choice made here: the significant-event
// trail for these three lives in the `cart.lock.*`/`cart.cart.converted` events below, not
// in `action_logs`.

const CART_ENTITY_ID = E.cart.cart
const cartCrudIndexer: CrudIndexerConfig<Cart> = { entityType: CART_ENTITY_ID }
const cartCrudEvents: CrudEventsConfig<Cart> = {
  module: 'cart',
  entity: 'cart',
  persistent: true,
  buildPayload: (ctx) => ({
    id: ctx.identifiers.id,
    organizationId: ctx.identifiers.organizationId,
    tenantId: ctx.identifiers.tenantId,
  }),
}

function getCartIdentifiers(cart: Cart) {
  return { id: cart.id, organizationId: cart.organizationId, tenantId: cart.tenantId }
}

type CartLockScope = { tenantId: string; organizationId: string }

async function loadBasketCart(em: EntityManager, scope: CartLockScope, cartId: string): Promise<Cart | null> {
  return findOneWithDecryption(
    em,
    Cart,
    { id: cartId, tenantId: scope.tenantId, organizationId: scope.organizationId, kind: 'basket' as const },
    {},
    scope,
  )
}

// §9.1 (rev 10 — C1): `lockTtlMs` bounds, verbatim from the spec's own signature comment
// ("60_000..86_400_000; default 1_800_000 (30 min)"). The default is NOT the literal
// 1_800_000 constant but `resolveCartLockTimeoutMs()` — the existing env-configurable
// default (`CART_LOCK_TIMEOUT_MINUTES`) — so a caller that never passes `lockTtlMs` keeps
// today's exact behaviour, including any non-default env override already in place.
const MIN_LOCK_TTL_MS = 60_000
const MAX_LOCK_TTL_MS = 86_400_000

function resolveLockTtlMs(lockTtlMs: number | undefined): number {
  if (lockTtlMs === undefined) return resolveCartLockTimeoutMs()
  if (!Number.isFinite(lockTtlMs) || lockTtlMs < MIN_LOCK_TTL_MS || lockTtlMs > MAX_LOCK_TTL_MS) {
    throw new CrudHttpError(400, { error: '[internal] invalid_lock_ttl_ms', code: 'invalid_lock_ttl_ms' })
  }
  return lockTtlMs
}

// ---------------------------------------------------------------------------
// cart.lock
// ---------------------------------------------------------------------------

export type CartLockInput = {
  cartId: string
  tenantId: string
  organizationId: string
  /** Opaque id supplied by the lock caller (§4.1/§9) — persisted as `Cart.checkoutSessionId`
   * and returned in every subsequent `423 cart_locked` body until the lock clears. */
  checkoutSessionId: string
  /**
   * The route-edge-resolved buyer context, when the caller has one on hand — forwarded
   * verbatim to `cart.reprice`'s own dispatch below, exactly like `cart.merge`'s own
   * `routeContext` field. Optional for the same reason `CartRepriceInput.routeContext` and
   * every non-storefront command input in this module leave it optional (§6a.4: a `pos`/
   * `pay_link`/`agent`/`api` cart never resolves one at all) — there is no real caller yet
   * to enforce "a storefront cart's lock caller must always supply one" against, so this
   * step does not add that assertion speculatively (unlike `commands/lines.ts`'s
   * `assertStorefrontHasRouteContext`, which protects an EXISTING, exercised call path).
   */
  routeContext?: ResolvedCartRouteContext
  /** (rev 10 — C1) Bounded lock lifetime override (§9.1: `60_000..86_400_000`); defaults to
   * `resolveCartLockTimeoutMs()` (today's behaviour) when omitted. Additive — every pre-
   * Release-5 caller that never passed this keeps the exact same TTL it always got. */
  lockTtlMs?: number
}

export type CartLockResult = {
  cart: CartSummary
  priceChanges: CartRepriceResult['priceChanges']
  warnings?: CartRepriceResult['warnings']
  /** (rev 10 — C1) `true` when this call was an idempotent extend of an already-locked cart
   * under the SAME `checkoutSessionId` (no re-price, no visibility pass, no approval gate
   * ran); `false` for an ordinary fresh `active -> locked` transition. */
  extended: boolean
}

const lockCartCommand: CommandHandler<CartLockInput, CartLockResult> = {
  id: 'cart.lock',
  isUndoable: false,
  async execute(input, ctx) {
    const scope: CartLockScope = { tenantId: input.tenantId, organizationId: input.organizationId }
    const lockTtlMs = resolveLockTtlMs(input.lockTtlMs)

    // Pre-check on its own short-lived `em` fork — never reused below. `cart.reprice`
    // (dispatched next) runs its own write in a SEPARATE fork/transaction and commits
    // independently, so any entity loaded on THIS fork would go stale the moment that
    // commit lands; discarding this fork after the pre-check, rather than carrying it
    // forward, is what keeps the final write (below) reading genuinely fresh state instead
    // of a pre-reprice identity-mapped snapshot.
    const precheckEm = (ctx.container.resolve('em') as EntityManager).fork()
    const existingCart = await loadBasketCart(precheckEm, scope, input.cartId)
    if (!existingCart) throw notFound('[internal] cart not found')
    if (existingCart.status === 'locked') {
      // §9/§9.1 (rev 10 — C1/X15): a second `cart.lock` carrying the SAME `checkoutSessionId`
      // as the cart's own stored session is an idempotent EXTEND, not a re-lock attempt — it
      // only moves `lockExpiresAt` forward and returns the cart as-is: no re-price, no
      // visibility pass, no approval gate (none of them need to re-run for a session that
      // already holds the lock). A DIFFERENT (or absent) `checkoutSessionId` keeps the
      // ordinary 423 `cart_locked` refusal exactly as it was before this step.
      if (existingCart.checkoutSessionId === input.checkoutSessionId) {
        return extendCartLock(ctx, scope, input.cartId, input.checkoutSessionId, lockTtlMs)
      }
      // §9: a locked cart's own re-lock attempt (by a different/no session) is itself a
      // "client tries to mutate" case — the blanket 423 rule has no stated carve-out for
      // `cart.lock` calling itself.
      assertCartNotLocked(existingCart)
    }
    // Every OTHER non-active status (converted/merged/expired/abandoned) collapses to the
    // same generic 404 `commands/lines.ts`'s `loadMutableCart` already uses for a
    // `requireActive` caller — `cart.lock` only ever fires `active -> locked` (§9).
    if (existingCart.status !== 'active') throw notFound('[internal] cart not found')

    // §9/§6a.2/§6a.5/D-R4-22: forces a whole-cart re-price AND (via this step's own
    // extension of `commands/cart.ts`'s `runWholeCartRevisibilityPass`) the whole-cart
    // re-visibility pass, with a freshly-resolved buyer context, BEFORE this command ever
    // checks for a still-flagged line.
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const repriceInput: CartRepriceInput = {
      cartId: input.cartId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      trigger: 'lock',
      routeContext: input.routeContext,
    }
    const { result: repriceResult } = await commandBus.execute<CartRepriceInput, CartRepriceResult>(
      repriceCartCommand.id,
      { input: repriceInput, ctx },
    )

    // Fresh fork, fresh reads: the mechanics for "any line still flagged after the forced
    // re-price" (documented judgment call, Step 7.5) is a plain re-read of every
    // non-deleted `CartLine` AFTER the reprice dispatch above has committed, rather than
    // having `cart.reprice` return flag data on `CartRepriceResult` itself — `flag_state` is
    // already a persisted column this command can read directly, and extending the shared,
    // widely-reused `CartRepriceResult` shape just for this one caller would ripple into
    // every other site that already destructures it (`cart.get`, `cart.merge`,
    // `cart.mergeUndo`, `cart.promotions.apply`/`.remove`).
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const lines = (await findWithDecryption(
      em,
      CartLine,
      { cartId: input.cartId, deletedAt: null, tenantId: scope.tenantId, organizationId: scope.organizationId },
      {},
      scope,
    )) as CartLine[]
    if (lines.some((line) => line.flagState != null)) {
      throw new CrudHttpError(409, { error: '[internal] cart_has_unavailable_lines', code: 'cart_has_unavailable_lines' })
    }

    const cart = await loadBasketCart(em, scope, input.cartId)
    if (!cart) throw notFound('[internal] cart not found')
    // Defense in depth: nothing in this worktree can race this command yet (no real caller
    // exists — §10), but re-asserting the same two guards the pre-check already ran, against
    // the POST-reprice fresh read, costs nothing and protects a future concurrent in-process
    // caller from locking (or double-locking) a cart that changed status while the reprice
    // dispatch was in flight.
    assertCartNotLocked(cart)
    if (cart.status !== 'active') throw notFound('[internal] cart not found')

    const now = new Date()
    await withAtomicFlush(
      em,
      [
        () => {
          cart.status = 'locked'
          cart.lockedAt = now
          cart.lockExpiresAt = new Date(now.getTime() + lockTtlMs)
          cart.checkoutSessionId = input.checkoutSessionId
        },
      ],
      { transaction: true, label: 'cart.lock' },
    )

    const dataEngine = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine,
      action: 'updated',
      entity: cart,
      identifiers: getCartIdentifiers(cart),
      events: cartCrudEvents,
      indexer: cartCrudIndexer,
    })
    await emitCartEvent('cart.lock.acquired', {
      cartId: cart.id,
      tenantId: cart.tenantId,
      organizationId: cart.organizationId,
      checkoutSessionId: cart.checkoutSessionId,
    })

    return {
      cart: toCartSummary(cart),
      priceChanges: repriceResult.priceChanges,
      extended: false,
      ...(repriceResult.warnings && repriceResult.warnings.length > 0 ? { warnings: repriceResult.warnings } : {}),
    }
  },
}

// ---------------------------------------------------------------------------
// cart.lock — idempotent extend (§9.1, rev 10 — C1/X15)
// ---------------------------------------------------------------------------

/**
 * A second `cart.lock` call carrying the SAME `checkoutSessionId` the cart is already
 * locked under. Runs on its OWN fresh fork (never the pre-check's), so a race between the
 * pre-check read and this write still observes the cart's true current state before
 * committing — if by the time this fork reads it the cart is no longer locked under the
 * SAME session (e.g. a concurrent `cart.unlock`/timeout/second extend already ran), this
 * falls back to the ordinary 423/404 rules a second `cart.lock` call would hit on retry,
 * rather than extending a lock that already moved on.
 */
async function extendCartLock(
  ctx: CommandRuntimeContext,
  scope: CartLockScope,
  cartId: string,
  checkoutSessionId: string,
  lockTtlMs: number,
): Promise<CartLockResult> {
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  const cart = await loadBasketCart(em, scope, cartId)
  if (!cart) throw notFound('[internal] cart not found')
  if (cart.status !== 'locked' || cart.checkoutSessionId !== checkoutSessionId) {
    // The fresh fork disagrees with the pre-check: another in-flight call already changed
    // the lock state. Replay the ordinary rules a second `cart.lock` would hit right now —
    // 423 if someone else holds (or still holds) the lock, 404 otherwise.
    if (cart.status === 'locked') assertCartNotLocked(cart)
    throw notFound('[internal] cart not found')
  }

  const now = new Date()
  await withAtomicFlush(
    em,
    [
      () => {
        cart.lockExpiresAt = new Date(now.getTime() + lockTtlMs)
      },
    ],
    { transaction: true, label: 'cart.lock.extend' },
  )

  const dataEngine = ctx.container.resolve('dataEngine') as DataEngine
  await emitCrudSideEffects({
    dataEngine,
    action: 'updated',
    entity: cart,
    identifiers: getCartIdentifiers(cart),
    events: cartCrudEvents,
    indexer: cartCrudIndexer,
  })
  await emitCartEvent('cart.lock.extended', {
    cartId: cart.id,
    tenantId: cart.tenantId,
    organizationId: cart.organizationId,
    checkoutSessionId: cart.checkoutSessionId,
  })

  return {
    cart: toCartSummary(cart),
    priceChanges: [],
    extended: true,
  }
}

// ---------------------------------------------------------------------------
// cart.unlock
// ---------------------------------------------------------------------------

export type CartUnlockInput = {
  cartId: string
  tenantId: string
  organizationId: string
  /** (rev 10 — C1) When supplied, must match the cart's own stored `checkoutSessionId`; a
   * mismatch is the uniform `404` (§9.1, §15a). Optional and additive — omitting it keeps
   * Release 4's original, session-agnostic call shape unchanged (documented in PLAN.md's
   * Step 2.8 decision: no real caller predates checkout, but the signature stays additive
   * per `BACKWARD_COMPATIBILITY.md` all the same). */
  checkoutSessionId?: string
}

export type CartUnlockResult = { cart: CartSummary }

const unlockCartCommand: CommandHandler<CartUnlockInput, CartUnlockResult> = {
  id: 'cart.unlock',
  isUndoable: false,
  async execute(input, ctx) {
    const scope: CartLockScope = { tenantId: input.tenantId, organizationId: input.organizationId }
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const cart = await loadBasketCart(em, scope, input.cartId)
    if (!cart) throw notFound('[internal] cart not found')
    // §9: `locked -> active` is the only transition this command fires. A cart that is not
    // currently locked (active already, or any other status) has nothing for `cart.unlock`
    // to do — same uniform no-oracle 404 collapse `commands/lines.ts`'s `loadMutableCart`
    // already uses for a status mismatch, rather than a silent no-op success.
    if (cart.status !== 'locked') throw notFound('[internal] cart not found')
    // §9.1 (rev 10 — C1): a caller-supplied `checkoutSessionId` that does not match the
    // cart's own stored session gets the SAME uniform 404 — a stale session cannot unlock a
    // cart another session now holds, and the response gives it nothing to distinguish
    // "wrong session" from "wrong cart".
    if (input.checkoutSessionId !== undefined && cart.checkoutSessionId !== input.checkoutSessionId) {
      throw notFound('[internal] cart not found')
    }

    await withAtomicFlush(
      em,
      [
        () => {
          cart.status = 'active'
          cart.lockedAt = null
          cart.lockExpiresAt = null
          cart.checkoutSessionId = null
        },
      ],
      { transaction: true, label: 'cart.unlock' },
    )

    const dataEngine = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine,
      action: 'updated',
      entity: cart,
      identifiers: getCartIdentifiers(cart),
      events: cartCrudEvents,
      indexer: cartCrudIndexer,
    })
    // `cart.lock.released` — the EXPLICIT-unlock event. `cart.lock.timed_out` stays the
    // sweeper's own signal (`lib/sweepers.ts`'s `releaseStaleCartLocks`, left untouched by
    // this step per PLAN.md's own note); the two events only ever fire from their own
    // distinct call site, never both for the same transition.
    await emitCartEvent('cart.lock.released', {
      cartId: cart.id,
      tenantId: cart.tenantId,
      organizationId: cart.organizationId,
    })

    return { cart: toCartSummary(cart) }
  },
}

// ---------------------------------------------------------------------------
// cart.markConverted
// ---------------------------------------------------------------------------

export type CartMarkConvertedInput = {
  cartId: string
  tenantId: string
  organizationId: string
  /** (rev 10 — C1) Same contract as `CartUnlockInput.checkoutSessionId`: optional, but when
   * supplied must match the cart's own stored session or the call gets the uniform `404`. */
  checkoutSessionId?: string
}

export type CartMarkConvertedResult = { cart: CartSummary }

const markConvertedCommand: CommandHandler<CartMarkConvertedInput, CartMarkConvertedResult> = {
  id: 'cart.markConverted',
  isUndoable: false,
  async execute(input, ctx) {
    const scope: CartLockScope = { tenantId: input.tenantId, organizationId: input.organizationId }
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const cart = await loadBasketCart(em, scope, input.cartId)
    if (!cart) throw notFound('[internal] cart not found')
    // §9: `locked -> converted` only. A cart that is not currently locked — including one
    // ALREADY `converted` (a second `cart.markConverted` call, or any other mutation attempt
    // against an already-terminal cart) — gets the identical generic 404: "terminal; no
    // command mutates a converted cart" (§3.1a) is enforced here by giving a converted cart
    // no distinguishable signal of its own, the same uniform collapse every other non-active,
    // non-locked status already gets throughout this module. There is no dedicated
    // "already converted" error code in §15a's catalogue, so this documented judgment call
    // reuses the existing no-oracle 404 rather than inventing one.
    if (cart.status !== 'locked') throw notFound('[internal] cart not found')
    // §9.1 (rev 10 — C1): same session-match rule as `cart.unlock` — a mismatched
    // `checkoutSessionId` is the uniform 404, so a stale session cannot convert a cart
    // another session now holds.
    if (input.checkoutSessionId !== undefined && cart.checkoutSessionId !== input.checkoutSessionId) {
      throw notFound('[internal] cart not found')
    }

    const now = new Date()
    await withAtomicFlush(
      em,
      [
        () => {
          cart.status = 'converted'
          cart.resolvedAt = now
        },
      ],
      { transaction: true, label: 'cart.markConverted' },
    )

    const dataEngine = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine,
      action: 'updated',
      entity: cart,
      identifiers: getCartIdentifiers(cart),
      events: cartCrudEvents,
      indexer: cartCrudIndexer,
    })
    await emitCartEvent('cart.cart.converted', {
      cartId: cart.id,
      tenantId: cart.tenantId,
      organizationId: cart.organizationId,
    })

    return { cart: toCartSummary(cart) }
  },
}

registerCommand(lockCartCommand)
registerCommand(unlockCartCommand)
registerCommand(markConvertedCommand)

export { lockCartCommand, unlockCartCommand, markConvertedCommand }
