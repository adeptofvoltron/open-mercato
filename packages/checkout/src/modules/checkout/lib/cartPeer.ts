import type { EntityManager } from '@mikro-orm/postgresql'
import { hashCartTokenForLookup } from './sessionToken'

/** The cart's own header name (`cart/lib/currentCartRoute.ts#CART_TOKEN_HEADER`, D-R4-6),
 * reproduced here as a literal — not imported, same "checkout imports nothing from
 * cart/lib" reasoning as this file's other helpers. */
export const CART_TOKEN_HEADER = 'X-Cart-Token'

export function readCartTokenHeader(request: Request): string | null {
  const value = request.headers.get(CART_TOKEN_HEADER)
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * Minimal, read-only, scope-free peek at another module's `carts` table by its globally
 * unique `token_hash` (cart's own `@Unique(['tokenHash'])`, `cart/data/entities.ts`) — a
 * raw Kysely select against the table name, never an import of `cart`'s `Cart` entity or
 * any `cart/lib` function (the spec's own "checkout imports nothing from cart/lib" rule,
 * §6). This is the "FK-id + snapshot" coupling `packages/core/AGENTS.md` § Cross-Module
 * Coupling sanctions, the SAME style `ecommerce/lib/storeContextService.ts#
 * lookupStoreTenantId` already uses for its own one-column cross-table read.
 *
 * Only called after the caller's own `tryResolve('cartService')` gate has already
 * confirmed the `cart` module is active (D-R5-18) — so the table is guaranteed to exist.
 *
 * Scope-free by design: a bare cart token is the ONLY credential a guest buyer holds
 * (§9.0), so the lookup has no tenant/organization to filter by until AFTER it resolves —
 * exactly how `cart`'s own token resolves a basket with no a-priori scope either. The
 * returned row's own `tenantId`/`organizationId` become the new session's ground truth.
 */
export type CartPeerDatabase = {
  carts: {
    id: string
    tenant_id: string
    organization_id: string
    store_id: string | null
    channel: string
    kind: string
    status: string
    currency_code: string
    locale: string
    customer_id: string | null
    customer_user_id: string | null
    token_hash: string
  }
}

export type CartPeerRow = {
  id: string
  tenantId: string
  organizationId: string
  storeId: string | null
  channel: string
  kind: string
  status: string
  currencyCode: string
  locale: string
  customerId: string | null
  customerUserId: string | null
}

export async function lookupCartPeerByToken(em: EntityManager, cartToken: string): Promise<CartPeerRow | null> {
  const tokenHash = hashCartTokenForLookup(cartToken)
  const row = await em
    .getKysely<CartPeerDatabase>()
    .selectFrom('carts')
    .select([
      'id',
      'tenant_id',
      'organization_id',
      'store_id',
      'channel',
      'kind',
      'status',
      'currency_code',
      'locale',
      'customer_id',
      'customer_user_id',
    ])
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst()
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    channel: row.channel,
    kind: row.kind,
    status: row.status,
    currencyCode: row.currency_code,
    locale: row.locale,
    customerId: row.customer_id,
    customerUserId: row.customer_user_id,
  }
}
