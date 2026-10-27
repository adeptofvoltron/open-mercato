// Step 4.4. `cart` is a hard `requires` of this module (`index.ts`), but its `lib/cartService.ts`
// is still module-private per root AGENTS.md's Cross-Module Coupling guidance (the same reason
// `cart/lib/adminCartScope.ts`'s own header comment gives for NOT importing `customer_groups/
// lib/customerScope.ts` directly: "root AGENTS.md forbids a cross-module import of another
// module's internal `lib/` helper"). This file duck-types the ONE DI surface this module
// actually calls (`cartService`, registered in `cart/di.ts`) — resolved by name through the
// container, never a static value OR type import of `cart`'s own `lib/cartService.ts` —
// mirroring `cart/commands/proposal.ts`'s own `CartProposalCodeServiceLike` precedent for the
// identical situation one module boundary over.

export type AssistedSellingCartSummary = {
  id: string
  tenantId: string
  organizationId: string
  storeId: string | null
  status: string
  customerId: string | null
  customerUserId: string | null
}

export type AssistedSellingProposalCartLine = {
  productId: string
  variantId: string | null
  quantity: string
  configuration: Record<string, unknown> | null
}

/**
 * Step 4.5 (§5.1/§6.2, D-R5-21). The buyer thread routes' own "resolve the `X-Cart-Token`
 * header to its basket cart through `cart`'s DI service" — the same `cartService` surface
 * this file already duck-types, one more method. `status` is a plain string here (never
 * `cart`'s own `Cart['status']` literal union type), consistent with `AssistedSellingCartSummary`
 * above — this file intentionally carries no type import from `cart/data/entities.ts` either.
 */
export type AssistedSellingResolvedBasket = {
  id: string
  tenantId: string
  organizationId: string
  storeId: string | null
  status: string
  customerId: string | null
  customerUserId: string | null
}

export type AssistedSellingCartServiceLike = {
  getForOrganizations(input: {
    tenantId: string
    organizationIds: string[] | null
    cartId: string
  }): Promise<AssistedSellingCartSummary | null>
  getProposalCartLines(input: {
    tenantId: string
    organizationId: string
    proposalCartId: string
  }): Promise<AssistedSellingProposalCartLine[]>
  /** Step 4.5. Scope-free `kind: 'basket'` resolution by token — `null` for an unknown
   * token, collapsing with every other "no match" outcome (no enumeration oracle). */
  resolveBasketByToken(input: { token: string }): Promise<AssistedSellingResolvedBasket | null>
}

export function resolveCartService(container: {
  resolve: <T = unknown>(name: string) => T
}): AssistedSellingCartServiceLike {
  return container.resolve<AssistedSellingCartServiceLike>('cartService')
}
