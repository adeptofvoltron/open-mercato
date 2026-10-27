import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { lockCartCommand, markConvertedCommand, unlockCartCommand } from '../commands/lock'
import type {
  CartLockInput,
  CartLockResult,
  CartMarkConvertedInput,
  CartMarkConvertedResult,
  CartUnlockInput,
  CartUnlockResult,
} from '../commands/lock'
import { toCartSummary, type CartSummary } from '../commands/cart'
import { Cart, CartLine } from '../data/entities'
import { isCartStoreContextUnavailableError, resolveCartRouteContext } from './routeContext'
import { getCartSalesSnapshot, type CartSalesSnapshot, type GetCartSalesSnapshotInput } from './toSalesSnapshots'

// Step 7.5 — §9/§3.1a's own prose repeatedly says `cartService.lock`/`.unlock`/
// `.markConverted` ("checkout calls the DI service/command directly, in-process") — but
// this module has never built an actual `cartService` class before this step; every other
// "service-shaped" capability here is a plain command dispatched via
// `commandBus.execute(...)`. Mirrors `promotions/lib/promotions-service.ts`'s
// `PromotionsServiceImpl` (Step 2.6) at this module's own much smaller scale: a thin class
// wrapping `container.resolve('commandBus').execute(...)` per method, so the spec's own
// named call shape is real and callable for whenever `checkout` lands. The commands in
// `commands/lock.ts` remain the actual source of truth — this facade adds no logic of its
// own beyond resolving the command bus and building a minimal `CommandRuntimeContext`.

export type CartServiceContainer = {
  resolve: <T = unknown>(name: string) => T
}

/**
 * Release 5 Phase 4 (checkout C2). `cart.lock` itself only ever takes an ALREADY-resolved
 * `ResolvedCartRouteContext` (§6a.1a: "an internal, branded type... the ONLY function
 * permitted to construct one is `resolveCartRouteContext`"), so a cross-module caller like
 * `checkout` cannot build one directly without violating that invariant. `request` is this
 * facade's own additive input — when supplied (and `storeContextService` is available),
 * `lock()` resolves a fresh `ResolvedCartRouteContext` itself, in-module, and forwards it;
 * when absent, or when resolution fails because `ecommerce` is not registered, `routeContext`
 * stays whatever the caller already passed (usually `undefined`) — `cart.lock`'s own
 * storefront assertion (`commands/lock.ts`) is the backstop for a `storefront`-channel cart
 * that still has no context by the time the command runs.
 */
export type CartServiceLockInput = CartLockInput & { request?: Request | null }

/**
 * Step 4.4 (`assisted_selling`, S9/§6.1). `POST /threads` resolves the target basket "through
 * `cart`'s admin detail read — the same read `GET /api/cart/carts/:id` serves (K6), scoped to
 * the caller's `organizationIds`" (§6.1's own text) — a LIST, not the single `organizationId`
 * `cart.get` (the only other by-id read) accepts. No existing primitive supports a multi-org
 * scoped-by-list read without a direct `Cart` entity import, which root AGENTS.md forbids for a
 * cross-module caller. `organizationIds: null` means unrestricted (mirrors
 * `cart/lib/adminCartScope.ts#organizationIdsFromCartScope`'s own "null = unrestricted" contract,
 * reused by name in `assisted_selling`'s own copy of that helper).
 */
export type CartServiceGetForOrganizationsInput = {
  tenantId: string
  organizationIds: string[] | null
  cartId: string
}

/**
 * Step 4.4. `POST /proposals/:id/reauthor` (§6.4) re-authors "from the old one's lines" — a
 * `kind: 'proposal'` cart's own `CartLine` rows, read back into `cart.proposal.create`'s own
 * `CartProposalCreateLineInput` shape. No existing read exposes a proposal cart's lines to an
 * external caller either, for the identical "no direct ORM relationship across modules" reason.
 */
export type CartServiceGetProposalCartLinesInput = {
  tenantId: string
  organizationId: string
  proposalCartId: string
}

export type CartServiceProposalCartLine = {
  productId: string
  variantId: string | null
  quantity: string
  configuration: Record<string, unknown> | null
}

export type CartService = {
  lock(input: CartServiceLockInput): Promise<CartLockResult>
  unlock(input: CartUnlockInput): Promise<CartUnlockResult>
  markConverted(input: CartMarkConvertedInput): Promise<CartMarkConvertedResult>
  /** (C7, `.ai/specs/2026-08-14-cart-module.md` §3.1a/§9.1 rev 10) The only source checkout
   * uses to build its quote — see `lib/toSalesSnapshots.ts`'s own header comment. */
  getSalesSnapshot(input: GetCartSalesSnapshotInput): Promise<CartSalesSnapshot>
  /** Step 4.4 (S9). A `kind: 'basket'` cart scoped to a LIST of organization ids, `null`
   * list restriction (`organizationIds: null`) means unrestricted — never a direct `Cart`
   * entity import outside this module. */
  getForOrganizations(input: CartServiceGetForOrganizationsInput): Promise<CartSummary | null>
  /** Step 4.4 (§6.4). A `kind: 'proposal'` cart's own lines, mapped to
   * `cart.proposal.create`'s own line-input shape. */
  getProposalCartLines(input: CartServiceGetProposalCartLinesInput): Promise<CartServiceProposalCartLine[]>
}

type CartServiceAuthContext = CommandRuntimeContext['auth']

// Same "resolve `auth` off whatever is registered on the container, tolerate it being
// absent" convention `promotions-service.ts`'s `resolvePromotionsServiceScope` documents at
// length — unlike that facade, none of `cart.lock`/`.unlock`/`.markConverted` read
// `ctx.auth` themselves (every scope field they need arrives explicitly on the command
// input, since `checkout`, the only intended caller, already has its own resolved
// tenant/organization by the time it reaches this facade), so a missing `auth` token is not
// a failure here — it only affects the command bus's own interceptor/audit attribution.
function resolveCartServiceAuth(container: CartServiceContainer): CartServiceAuthContext {
  try {
    return (container.resolve<CartServiceAuthContext>('auth') ?? null) as CartServiceAuthContext
  } catch {
    return null
  }
}

function buildCartServiceCommandContext(
  container: CartServiceContainer,
  input: { tenantId: string; organizationId: string },
): CommandRuntimeContext {
  return {
    container: container as unknown as CommandRuntimeContext['container'],
    auth: resolveCartServiceAuth(container),
    organizationScope: null,
    selectedOrganizationId: input.organizationId,
    organizationIds: [input.organizationId],
  }
}

function resolveCartServiceCommandBus(container: CartServiceContainer): CommandBus {
  return container.resolve<CommandBus>('commandBus')
}

export class CartServiceImpl implements CartService {
  constructor(private readonly container: CartServiceContainer) {}

  async lock(input: CartServiceLockInput): Promise<CartLockResult> {
    const { request, ...commandInput } = input
    let routeContext = commandInput.routeContext
    if (!routeContext && request) {
      try {
        routeContext = await resolveCartRouteContext(request, this.container as unknown as {
          resolve: <T = unknown>(name: string) => T
        }, { fresh: true })
      } catch (err) {
        if (!isCartStoreContextUnavailableError(err)) throw err
        // No `ecommerce` peer registered — leave `routeContext` unset; a storefront-channel
        // cart will then correctly hit `cart.lock`'s own `assortment_scope_required_for_
        // storefront_channel` refusal rather than this facade silently swallowing the gap.
      }
    }
    const commandBus = resolveCartServiceCommandBus(this.container)
    const ctx = buildCartServiceCommandContext(this.container, commandInput)
    const { result } = await commandBus.execute<CartLockInput, CartLockResult>(lockCartCommand.id, {
      input: { ...commandInput, routeContext },
      ctx,
    })
    return result
  }

  async getSalesSnapshot(input: GetCartSalesSnapshotInput): Promise<CartSalesSnapshot> {
    const em = (this.container.resolve('em') as EntityManager).fork()
    return getCartSalesSnapshot(em, input)
  }

  async unlock(input: CartUnlockInput): Promise<CartUnlockResult> {
    const commandBus = resolveCartServiceCommandBus(this.container)
    const ctx = buildCartServiceCommandContext(this.container, input)
    const { result } = await commandBus.execute<CartUnlockInput, CartUnlockResult>(unlockCartCommand.id, { input, ctx })
    return result
  }

  async markConverted(input: CartMarkConvertedInput): Promise<CartMarkConvertedResult> {
    const commandBus = resolveCartServiceCommandBus(this.container)
    const ctx = buildCartServiceCommandContext(this.container, input)
    const { result } = await commandBus.execute<CartMarkConvertedInput, CartMarkConvertedResult>(
      markConvertedCommand.id,
      { input, ctx },
    )
    return result
  }

  async getForOrganizations(input: CartServiceGetForOrganizationsInput): Promise<CartSummary | null> {
    const em = (this.container.resolve('em') as EntityManager).fork()
    const scope = { tenantId: input.tenantId }
    const where: Record<string, unknown> = {
      id: input.cartId,
      tenantId: input.tenantId,
      kind: 'basket' as const,
    }
    if (Array.isArray(input.organizationIds)) {
      if (input.organizationIds.length === 0) return null
      where.organizationId = { $in: input.organizationIds }
    }
    const cart = (await findOneWithDecryption(em, Cart, where as Parameters<typeof findOneWithDecryption>[2], {}, scope)) as Cart | null
    return cart ? toCartSummary(cart) : null
  }

  async getProposalCartLines(input: CartServiceGetProposalCartLinesInput): Promise<CartServiceProposalCartLine[]> {
    const em = (this.container.resolve('em') as EntityManager).fork()
    const scope = { tenantId: input.tenantId, organizationId: input.organizationId }
    const lines = (await findWithDecryption(
      em,
      CartLine,
      { cartId: input.proposalCartId, deletedAt: null, tenantId: input.tenantId, organizationId: input.organizationId },
      { orderBy: { lineNumber: 'ASC' } },
      scope,
    )) as CartLine[]
    return lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId ?? null,
      quantity: line.quantity,
      configuration: line.configuration ?? null,
    }))
  }
}
