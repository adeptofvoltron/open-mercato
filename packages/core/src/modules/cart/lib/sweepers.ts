import type { FilterQuery } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { Cart, CartLine, CartMergeLog, CartPromotionApplication } from '../data/entities'
import { emitCartEvent } from '../events'
import { DAY_MS, PURGE_RETENTION_DAYS, resolveCartInactivityWindowMs } from './sweepConfig'

const logger = createLogger('cart')

// K11 (ANALYSIS-2026-10-26-cart-module-release-5.md, §12 as revised): `expire`/
// `mark-abandoned` must release the promotions-side code RESERVATION a basket holds, by
// `cartId` (`promotions/lib/code-service.ts#PromotionCodeService.releaseCode`), closing
// the Release 4 deferral this file used to carry at this exact spot. Duck-typed onto that
// service's own surface — never a static `promotions` entity import — same cross-module
// discipline `availability`'s `WmsReservationServiceLike` (Step 2.3) already established
// for this run's sibling sweepers.
export type CartCodeServiceLike = {
  releaseCode(
    em: EntityManager,
    codeId: string,
    cartId: string,
    scope: { tenantId: string; organizationId: string },
  ): Promise<void>
}

/**
 * Enumerates the distinct code reservations a basket still holds
 * (`CartPromotionApplication.codeId`, one row per applied promotion — §4.3) and releases
 * each one by `cartId`, mirroring `commands/promotions.ts#removePromotionCommand`'s own
 * "release happens by cartId on cart expiry, abandonment or code removal" (§6). Best-
 * effort, same reasoning as `emitCartLifecycleEvent` below: the cart's own status
 * transition already committed by the time this runs, so a failed release must not be
 * re-thrown (which would retry a transition that already landed) nor treated as a failed
 * sweep — `promotions`' own `code-reservation-sweeper.ts` (its TTL-based independent
 * safety net) is still there to catch whatever this call does not reach.
 */
async function releaseCartCodeReservations(
  em: EntityManager,
  codeService: CartCodeServiceLike,
  cart: Cart,
  workerLabel: string,
): Promise<void> {
  const applications = await em.find(
    CartPromotionApplication,
    { cartId: cart.id, tenantId: cart.tenantId, organizationId: cart.organizationId },
    { fields: ['codeId'] },
  )
  const codeIds = Array.from(
    new Set(applications.map((application) => application.codeId).filter((id): id is string => !!id)),
  )
  for (const codeId of codeIds) {
    try {
      await codeService.releaseCode(em, codeId, cart.id, {
        tenantId: cart.tenantId,
        organizationId: cart.organizationId,
      })
    } catch (error) {
      logger.warn(`${workerLabel} failed to release code reservation`, {
        cartId: cart.id,
        codeId,
        error: error instanceof Error ? error.message : error,
      })
    }
  }
}

// The active-cart backlog grows with the tenant, so every sweep walks it in pages instead of
// loading every matching row into memory at once. Mirrors
// warranty_claims/workers/sla-escalation-sweep.ts's own SWEEP_PAGE_SIZE.
const SWEEP_PAGE_SIZE = 500
// Defensive circuit breaker: one tick must never loop forever even against a pathological
// backlog. 500 * 1000 rows is far beyond any real per-tenant tick.
const MAX_PAGES_PER_TICK = 1000

export type CartSweepScope = { tenantId: string }
export type CartSweepResult = { transitioned: number }

type CartLifecycleEventId = 'cart.cart.abandoned' | 'cart.cart.expired' | 'cart.cart.purged'

// Best-effort, same reasoning as every other background sweep in this codebase (e.g.
// warranty_claims' `logClaimSweepError`): the DB transition already committed by the time this
// runs, so a failed emit must not be treated as a failed sweep, nor re-thrown to retry a
// transition that already landed.
async function emitCartLifecycleEvent(
  eventId: CartLifecycleEventId,
  payload: Record<string, unknown>,
  scope: { tenantId: string; organizationId: string },
  workerLabel: string,
): Promise<void> {
  try {
    await emitCartEvent(eventId, payload, {
      persistent: true,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })
  } catch (error) {
    logger.warn(`${workerLabel} failed to emit ${eventId}`, {
      cartId: payload.cartId,
      error: error instanceof Error ? error.message : error,
    })
  }
}

/**
 * §12 `mark-abandoned-carts` (every 15 min): `kind = 'basket' AND status = 'active' AND
 * lastActivityAt < now() - inactivityWindow` → `status = 'abandoned'`, `resolvedAt = now()`.
 * Baskets only — a proposal is never abandoned by inactivity (§7a.1, §9).
 *
 * No cursor needed: each page's `nativeUpdate` flips every selected row's `status` away from
 * `'active'`, so the identical next `find` call naturally excludes them and returns the next
 * batch — there is nothing left for a page to re-select.
 *
 * (rev 10 — K9/K11) `cart.cart.abandoned`'s payload grows to the full Release 5 shape
 * (§11), and every transitioned basket's code reservations are released by `cartId`
 * (`releaseCartCodeReservations` above, K11).
 */
export async function sweepAbandonedCarts(
  em: EntityManager,
  scope: CartSweepScope,
  codeService: CartCodeServiceLike,
  now: Date = new Date(),
): Promise<CartSweepResult> {
  const cutoff = new Date(now.getTime() - resolveCartInactivityWindowMs())
  let transitioned = 0

  for (let page = 0; page < MAX_PAGES_PER_TICK; page += 1) {
    const candidates = await findWithDecryption(
      em,
      Cart,
      { tenantId: scope.tenantId, kind: 'basket' as const, status: 'active' as const, lastActivityAt: { $lt: cutoff } },
      { limit: SWEEP_PAGE_SIZE, orderBy: { id: 'ASC' } },
      { tenantId: scope.tenantId },
    )
    if (!candidates.length) break

    const ids = candidates.map((cart) => cart.id)
    const affected = await em.nativeUpdate(
      Cart,
      { id: { $in: ids }, tenantId: scope.tenantId, kind: 'basket', status: 'active' },
      { status: 'abandoned', resolvedAt: now, updatedAt: now },
    )
    if (affected === 0) break

    // Emit events for the rows THIS update actually transitioned, not every pre-fetched
    // candidate: a racing tick on the same tenant can flip some of these ids away from
    // `'active'` between the `find` above and this `nativeUpdate`, and looping over
    // `candidates` would still fire `cart.cart.abandoned` for ids this call never touched —
    // a duplicate-event bug a concurrent-tick test caught in review. `resolvedAt: now` is
    // this call's own transition marker, so re-selecting on it identifies exactly the rows
    // this `nativeUpdate` matched.
    const transitionedCarts = await findWithDecryption(
      em,
      Cart,
      { id: { $in: ids }, tenantId: scope.tenantId, kind: 'basket', status: 'abandoned', resolvedAt: now },
      {},
      { tenantId: scope.tenantId },
    )

    // K9: `lineCount` is never denormalized onto `Cart` — batched in ONE query across
    // every row THIS page transitioned, mirroring `api/carts/route.ts`'s own `afterList`
    // "never N+1" discipline for the identical field.
    const transitionedIds = transitionedCarts.map((cart) => cart.id)
    const lines = transitionedIds.length
      ? await em.find(CartLine, { cartId: { $in: transitionedIds }, tenantId: scope.tenantId, deletedAt: null }, { fields: ['cartId'] })
      : []
    const lineCountByCartId = new Map<string, number>()
    for (const line of lines) {
      lineCountByCartId.set(line.cartId, (lineCountByCartId.get(line.cartId) ?? 0) + 1)
    }

    for (const cart of transitionedCarts) {
      await emitCartLifecycleEvent(
        'cart.cart.abandoned',
        {
          cartId: cart.id,
          tenantId: cart.tenantId,
          organizationId: cart.organizationId,
          storeId: cart.storeId ?? null,
          channel: cart.channel,
          customerId: cart.customerId ?? null,
          customerUserId: cart.customerUserId ?? null,
          hasEmail: Boolean(cart.email),
          currencyCode: cart.currencyCode,
          grandTotalGrossAmount: cart.grandTotalGrossAmount ?? null,
          lineCount: lineCountByCartId.get(cart.id) ?? 0,
          lastActivityAt: cart.lastActivityAt,
        },
        { tenantId: cart.tenantId, organizationId: cart.organizationId },
        'cart:mark-abandoned',
      )
      await releaseCartCodeReservations(em, codeService, cart, 'cart:mark-abandoned')
    }
    transitioned += affected
    if (candidates.length < SWEEP_PAGE_SIZE) break
  }

  return { transitioned }
}

/**
 * §12 `expire-carts` (hourly): `kind = 'basket' AND status IN ('active','abandoned','locked')
 * AND expiresAt < now()` → `status = 'expired'`, `resolvedAt = now()`.
 *
 * (rev 10 — K11) Every transitioned basket's code reservations are released by `cartId`
 * (`releaseCartCodeReservations` above), closing the Release 4 deferral this file used to
 * carry at this exact spot. `cart.cart.expired`'s own payload is unchanged (K9 only grows
 * `cart.cart.abandoned`, §11).
 */
export async function sweepExpiredCarts(
  em: EntityManager,
  scope: CartSweepScope,
  codeService: CartCodeServiceLike,
  now: Date = new Date(),
): Promise<CartSweepResult> {
  let transitioned = 0

  for (let page = 0; page < MAX_PAGES_PER_TICK; page += 1) {
    const candidates = await findWithDecryption(
      em,
      Cart,
      {
        tenantId: scope.tenantId,
        kind: 'basket' as const,
        status: { $in: ['active', 'abandoned', 'locked'] as const },
        expiresAt: { $lt: now },
      },
      { limit: SWEEP_PAGE_SIZE, orderBy: { id: 'ASC' } },
      { tenantId: scope.tenantId },
    )
    if (!candidates.length) break

    const ids = candidates.map((cart) => cart.id)
    const affected = await em.nativeUpdate(
      Cart,
      {
        id: { $in: ids },
        tenantId: scope.tenantId,
        kind: 'basket',
        status: { $in: ['active', 'abandoned', 'locked'] },
      },
      { status: 'expired', resolvedAt: now, updatedAt: now },
    )
    if (affected === 0) break

    // Same reasoning as `sweepAbandonedCarts` above — re-select on this call's own
    // `resolvedAt: now` marker so a racing tick's already-transitioned rows don't get a
    // duplicate `cart.cart.expired` event.
    const transitionedCarts = await findWithDecryption(
      em,
      Cart,
      { id: { $in: ids }, tenantId: scope.tenantId, kind: 'basket', status: 'expired', resolvedAt: now },
      {},
      { tenantId: scope.tenantId },
    )
    for (const cart of transitionedCarts) {
      await emitCartLifecycleEvent(
        'cart.cart.expired',
        { cartId: cart.id },
        { tenantId: cart.tenantId, organizationId: cart.organizationId },
        'cart:expire',
      )
      await releaseCartCodeReservations(em, codeService, cart, 'cart:expire')
    }
    transitioned += affected
    if (candidates.length < SWEEP_PAGE_SIZE) break
  }

  return { transitioned }
}

/**
 * §12 `release-stale-locks` (every 5 min): `status = 'locked' AND lockExpiresAt < now()` →
 * `status = 'active'`, clearing `lockedAt`/`lockExpiresAt`/`checkoutSessionId` — §9's
 * `locked → active` row: "a lock timeout ... clearing locked_at/lock_expires_at". No `kind`
 * filter: a proposal is never locked, so it never matches regardless. No event: `events.ts`
 * declares none for this transition and neither does the spec's §11 event table.
 *
 * TODO(Step 7.5): once `cartService.unlock` / command `cart.unlock` ships, this sweep should
 * delegate to it per row instead of transitioning the row directly, so a timeout-driven unlock
 * gets the same command side effects (audit log, events) a caller-initiated unlock gets.
 */
export async function releaseStaleCartLocks(
  em: EntityManager,
  scope: CartSweepScope,
  now: Date = new Date(),
): Promise<CartSweepResult> {
  let transitioned = 0

  for (let page = 0; page < MAX_PAGES_PER_TICK; page += 1) {
    const candidates = await findWithDecryption(
      em,
      Cart,
      { tenantId: scope.tenantId, status: 'locked' as const, lockExpiresAt: { $lt: now } },
      { limit: SWEEP_PAGE_SIZE, orderBy: { id: 'ASC' } },
      { tenantId: scope.tenantId },
    )
    if (!candidates.length) break

    const ids = candidates.map((cart) => cart.id)
    const affected = await em.nativeUpdate(
      Cart,
      { id: { $in: ids }, tenantId: scope.tenantId, status: 'locked' },
      { status: 'active', lockedAt: null, lockExpiresAt: null, checkoutSessionId: null, updatedAt: now },
    )
    if (affected === 0) break

    transitioned += affected
    if (candidates.length < SWEEP_PAGE_SIZE) break
  }

  return { transitioned }
}

type PurgeCursor = { resolvedAt: Date; id: string } | null

// Keyset rather than "loop until empty": unlike the other three sweeps, a row this sweep skips
// (because `CartMergeLog` still references it) never leaves the candidate set on its own, so a
// cursor-less re-run of the same WHERE could loop on the same excluded rows forever instead of
// reaching the rest of the backlog. Mirrors
// warranty_claims/workers/sla-escalation-sweep.ts's `pageWhere`.
function purgePageWhere(base: FilterQuery<Cart>, cursor: PurgeCursor): FilterQuery<Cart> {
  if (!cursor) return base
  return {
    $and: [
      base,
      {
        $or: [{ resolvedAt: { $gt: cursor.resolvedAt } }, { resolvedAt: cursor.resolvedAt, id: { $gt: cursor.id } }],
      },
    ],
  } as FilterQuery<Cart>
}

/**
 * §12 `purge-expired-carts` (daily): `kind = 'basket' AND resolvedAt IS NOT NULL AND
 * resolvedAt < now() - 90 days`, excluding any cart `CartMergeLog` still names as its
 * `sourceCartId`/`targetCartId`/`proposalCartId` → hard-delete the `Cart` row.
 * `CartLine`/`CartPromotionApplication`/`CartIdempotencyKey` cascade automatically
 * (`deleteRule: 'cascade'` on `cart_id`); `CartMergeLog`'s own cart FKs are
 * `deleteRule: 'restrict'`, which is exactly why a still-referenced cart is filtered out up
 * front rather than left to a failing `DELETE`.
 *
 * A two-step fetch-then-filter against `CartMergeLog` rather than a single `NOT EXISTS` query —
 * `CartMergeLog` won't even have rows until Phase 7/merge ships, so this is not worth fighting
 * the ORM's query builder for.
 *
 * (Step 2.11/K11 scope check) This sweep's own WHERE (`kind: 'basket'`, `resolvedAt` past the
 * retention cutoff) carries no `status` filter, so it also reaches `converted`/`merged` rows —
 * neither of which passes through `sweepAbandonedCarts`/`sweepExpiredCarts` first (`cart.
 * markConverted`/`cart.merge` set `resolvedAt` directly). K11 names only `expire`/`mark-
 * abandoned`; this sweep deliberately does NOT call `releaseCartCodeReservations` — see
 * NOTIFY.md for why that is a real, scoped-out gap rather than a verified no-op.
 */
export async function purgeExpiredCarts(
  em: EntityManager,
  scope: CartSweepScope,
  now: Date = new Date(),
): Promise<CartSweepResult> {
  const cutoff = new Date(now.getTime() - PURGE_RETENTION_DAYS * DAY_MS)
  const base: FilterQuery<Cart> = {
    tenantId: scope.tenantId,
    kind: 'basket' as const,
    resolvedAt: { $ne: null, $lt: cutoff },
  }

  let cursor: PurgeCursor = null
  let purged = 0

  for (let page = 0; page < MAX_PAGES_PER_TICK; page += 1) {
    const candidates: Cart[] = await findWithDecryption<Cart>(
      em,
      Cart,
      purgePageWhere(base, cursor),
      { limit: SWEEP_PAGE_SIZE, orderBy: { resolvedAt: 'ASC', id: 'ASC' } },
      { tenantId: scope.tenantId },
    )
    if (!candidates.length) break

    const candidateIds = candidates.map((cart) => cart.id)
    const mergeLogRefs = await em.find(
      CartMergeLog,
      {
        tenantId: scope.tenantId,
        $or: [
          { sourceCartId: { $in: candidateIds } },
          { targetCartId: { $in: candidateIds } },
          { proposalCartId: { $in: candidateIds } },
        ],
      },
      { fields: ['sourceCartId', 'targetCartId', 'proposalCartId'] },
    )
    const excludedIds = new Set<string>()
    for (const ref of mergeLogRefs) {
      excludedIds.add(ref.sourceCartId)
      excludedIds.add(ref.targetCartId)
      if (ref.proposalCartId) excludedIds.add(ref.proposalCartId)
    }

    const purgeable = candidates.filter((cart) => !excludedIds.has(cart.id))
    if (purgeable.length) {
      // One `nativeDelete` per row rather than one batched call over the whole page: a
      // batched delete's `affected` count can't tell us WHICH of `purgeable`'s ids a racing
      // tick already deleted, and emitting `cart.cart.purged` for every pre-fetched candidate
      // regardless would fire a duplicate event for a cart the race partner already removed
      // (review finding — mirrors the abandon/expire sweeps' same race). A page tops out at
      // `SWEEP_PAGE_SIZE`, so the extra round trips stay bounded.
      for (const cart of purgeable) {
        const affected = await em.nativeDelete(Cart, { id: cart.id, tenantId: scope.tenantId })
        if (affected === 0) continue
        await emitCartLifecycleEvent(
          'cart.cart.purged',
          { cartId: cart.id, kind: cart.kind, proposedToCartId: cart.proposedToCartId ?? null },
          { tenantId: cart.tenantId, organizationId: cart.organizationId },
          'cart:purge-expired',
        )
        purged += 1
      }
    }

    const lastCandidate = candidates[candidates.length - 1]
    cursor = lastCandidate.resolvedAt ? { resolvedAt: lastCandidate.resolvedAt, id: lastCandidate.id } : cursor
    if (candidates.length < SWEEP_PAGE_SIZE) break
    if (!cursor) break
  }

  return { transitioned: purged }
}
