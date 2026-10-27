import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { AssistedSellingAttribution, AssistedSellingProposal } from '../data/entities'
import type { AssistedSellingAttributionActorType } from '../data/entities'
import { emitAssistedSellingEvent } from '../events'
import { resolveCartService } from './cartAccess'

const logger = createLogger('assisted_selling').child({ component: 'attribution' })

// Step 5.4 (§5.5/§6.7, S18/D-R5-16/D-R5-26). "A subscriber on `cart.cart.converted` writes
// one `AssistedSellingAttribution` per cart line." Unconditional — every converted BASKET
// cart that names an order or a quote outcome gets fully attributed, line by line, whether
// or not this module ever opened a thread on it (a cart the buyer converted on their own has
// every line attributed to `actor_type: 'buyer'`/`'system'`/`'merge'`, with `thread_id`/
// `proposal_id` NULL — correct per §6.7, not a gap). A conversion naming NEITHER
// `salesOrderId` nor `salesQuoteId` (the pre-Release-5 `cart.markConverted` call shape) has
// no document outcome to attribute against at all — skipped silently, not degraded.

export type AssistedSellingAttributionSubscriberContext = {
  resolve: <T = unknown>(name: string) => T
  container?: { resolve: <T = unknown>(name: string) => T }
  tenantId?: string | null
  organizationId?: string | null
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

type RawLineMapEntry = { cartLineId: string; salesOrderLineId?: string; salesQuoteLineId?: string }

/**
 * §9.1/§6.7: `lineMap` is valid for THIS conversion only when it is an array, every entry
 * carries the discriminant matching whichever of `salesOrderId`/`salesQuoteId` fired
 * (`cart.markConverted`'s own bijection guard already enforces this shape at write time —
 * this is a second, independent read-side check, not a re-trust of the payload), and it
 * covers every live line of the cart exactly once. Any other shape — absent, not an array,
 * a line missing, an extra/foreign id, the wrong discriminant — is "does not cover a line"
 * per §6.7 and degrades the whole conversion, never a partial per-line guess.
 */
function resolveLineMap(
  raw: unknown,
  lineIds: string[],
  outcome: 'order' | 'quote',
): Map<string, RawLineMapEntry> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const key = outcome === 'order' ? 'salesOrderLineId' : 'salesQuoteLineId'
  const byCartLineId = new Map<string, RawLineMapEntry>()
  for (const item of raw) {
    const record = toRecord(item)
    const cartLineId = readString(record, 'cartLineId')
    const lineId = readString(record, key)
    if (!cartLineId || !lineId || byCartLineId.has(cartLineId)) return null
    const entry: RawLineMapEntry = { cartLineId }
    if (outcome === 'order') entry.salesOrderLineId = lineId
    else entry.salesQuoteLineId = lineId
    byCartLineId.set(cartLineId, entry)
  }
  if (byCartLineId.size !== lineIds.length) return null
  for (const id of lineIds) {
    if (!byCartLineId.has(id)) return null
  }
  return byCartLineId
}

function toAmountNumber(value: string): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function formatAmount(value: number): string {
  return (Math.round((value + Number.EPSILON) * 10000) / 10000).toFixed(4)
}

export async function handleCartConvertedForAttribution(
  payload: unknown,
  ctx: AssistedSellingAttributionSubscriberContext,
): Promise<void> {
  const record = toRecord(payload)
  const cartId = readString(record, 'cartId')
  const tenantId = readString(record, 'tenantId') ?? ctx.tenantId ?? null
  const organizationId = readString(record, 'organizationId') ?? ctx.organizationId ?? null
  const salesOrderId = readString(record, 'salesOrderId')
  const salesQuoteId = readString(record, 'salesQuoteId')

  if (!cartId || !tenantId || !organizationId) {
    logger.debug('skipped incomplete payload', {
      hasCartId: Boolean(cartId),
      hasTenantId: Boolean(tenantId),
      hasOrganizationId: Boolean(organizationId),
    })
    return
  }
  // §5.5's check constraint: exactly one of sales_order_id/sales_quote_id. Neither present
  // means no document outcome exists for this conversion — nothing to attribute, and this
  // is NOT the §6.7 degraded case (that requires a document outcome with a missing map).
  if (salesOrderId && salesQuoteId) {
    logger.warn('skipped conversion naming both an order and a quote outcome', { cartId, tenantId, organizationId })
    return
  }
  if (!salesOrderId && !salesQuoteId) return

  const container = ctx.container ?? { resolve: ctx.resolve }

  try {
    const em = container.resolve<EntityManager>('em').fork()

    // §5.5's own redelivery guard: "a `cart.cart.converted` for a cart that already has
    // attribution rows writes nothing."
    const existing = await em.count(AssistedSellingAttribution, { tenantId, organizationId, cartId })
    if (existing > 0) return

    const cartService = resolveCartService(container)
    const detail = await cartService.getAttributionLines({ tenantId, organizationId, cartId })
    if (!detail || detail.lines.length === 0) return

    const proposalCartIds = Array.from(
      new Set(detail.lines.map((line) => line.proposalCartId).filter((id): id is string => Boolean(id))),
    )
    const proposals = proposalCartIds.length
      ? await em.find(AssistedSellingProposal, {
          tenantId,
          organizationId,
          proposalCartId: { $in: proposalCartIds },
          deletedAt: null,
        })
      : []
    const proposalByCartId = new Map(proposals.map((proposal) => [proposal.proposalCartId, proposal]))

    const outcome: 'order' | 'quote' = salesOrderId ? 'order' : 'quote'
    const lineMap = resolveLineMap(record.lineMap, detail.lines.map((line) => line.id), outcome)

    const now = new Date()
    const rows: AssistedSellingAttribution[] = []

    if (lineMap) {
      for (const line of detail.lines) {
        const mapEntry = lineMap.get(line.id)
        if (!mapEntry) continue
        const proposal = line.proposalCartId ? proposalByCartId.get(line.proposalCartId) : undefined
        const row = new AssistedSellingAttribution()
        row.tenantId = tenantId
        row.organizationId = organizationId
        row.cartId = cartId
        row.cartLineId = line.id
        row.salesOrderId = salesOrderId ?? null
        row.salesOrderLineId = mapEntry.salesOrderLineId ?? null
        row.salesQuoteId = salesQuoteId ?? null
        row.salesQuoteLineId = mapEntry.salesQuoteLineId ?? null
        row.actorType = line.addedByActorType as AssistedSellingAttributionActorType
        row.actorId = line.addedByActorId
        row.threadId = proposal?.threadId ?? null
        row.proposalId = proposal?.id ?? null
        row.lineNetAmount = line.netAmount
        row.lineGrossAmount = line.grossAmount
        row.currencyCode = detail.currencyCode
        row.convertedAt = now
        rows.push(row)
      }
    } else {
      // §6.7's safety net: "the subscriber degrades to document-level attribution — the
      // line id NULL, amounts summed per actor." Grouped by (actor_type, actor_id) so a
      // commission report still gets a usable, if coarser, split.
      const groups = new Map<string, { actorType: string; actorId: string | null; net: number; gross: number }>()
      for (const line of detail.lines) {
        const key = `${line.addedByActorType}:${line.addedByActorId ?? ''}`
        const group = groups.get(key) ?? { actorType: line.addedByActorType, actorId: line.addedByActorId, net: 0, gross: 0 }
        group.net += toAmountNumber(line.netAmount)
        group.gross += toAmountNumber(line.grossAmount)
        groups.set(key, group)
      }
      for (const group of groups.values()) {
        const row = new AssistedSellingAttribution()
        row.tenantId = tenantId
        row.organizationId = organizationId
        row.cartId = cartId
        row.cartLineId = null
        row.salesOrderId = salesOrderId ?? null
        row.salesOrderLineId = null
        row.salesQuoteId = salesQuoteId ?? null
        row.salesQuoteLineId = null
        row.actorType = group.actorType as AssistedSellingAttributionActorType
        row.actorId = group.actorId
        row.threadId = null
        row.proposalId = null
        row.lineNetAmount = formatAmount(group.net)
        row.lineGrossAmount = formatAmount(group.gross)
        row.currencyCode = detail.currencyCode
        row.convertedAt = now
        rows.push(row)
      }
    }

    for (const row of rows) em.persist(row)
    await em.flush()

    if (!lineMap) {
      await emitAssistedSellingEvent('assisted_selling.attribution.degraded', {
        cartId,
        tenantId,
        organizationId,
        salesOrderId: salesOrderId ?? null,
        salesQuoteId: salesQuoteId ?? null,
      })
    }
  } catch (err) {
    logger.warn('failed to attribute converted cart', {
      cartId,
      tenantId,
      organizationId,
      error: err instanceof Error ? err.message : err,
    })
  }
}
