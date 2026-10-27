import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { buildTrustedCommandContext } from '@open-mercato/shared/lib/commands/trusted-context'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CART_PROPOSAL_MAX_TTL_SECONDS, CART_PROPOSAL_MIN_TTL_SECONDS } from '../data/validators'
import { Cart, CartLine } from '../data/entities'
import type { CartLineActorType } from '../data/entities'
import type { CartProposalCreateInput, CartProposalCreateResult, CartProposalRejectInput } from '../commands/proposal'

const logger = createLogger('cart')

// Step 3.3 (rev 10 — D-R5-14/S11) — the §7a seam's re-author-on-merge mechanism.
//
// The AUTHORITATIVE spec (`.ai/specs/2026-09-22-assisted-selling.md` §8.1/§6.4, R10/R13)
// places this subscriber in `assisted_selling`, not `cart` ("a `kind = 'basket'`
// subscriber on `cart.cart.merged` re-points `buyer_cart_id`... a live proposal is
// re-authored as its original author... through `buildTrustedCommandContext`"). That module
// does not exist as code yet — it is this run's own Phase 4 (Steps 4.3-4.5), and `cart` must
// never gain an inbound dependency on it (§7a.6: "`cart` never learns that a conversation
// exists"). This file is a PROVISIONAL, cart-only implementation of the part of that
// mechanism `cart` itself can see and own — re-pointing a pending proposal to a basket's new
// home after a login merge, re-running `cart`'s OWN visibility/pricing/line-add logic
// (`cart.proposal.create`) under the original author's identity, with the exact fallback
// D-R5-14 states. It does NOT touch anything `assisted_selling` owns (no thread, no
// `superseded_by_proposal_id`, no `live_proposal_count`) — see NOTIFY.md's Step 3.3 entry
// for the full reasoning, including why "supersede-on-merge" and "re-author" are one
// mechanism here, not two.
export type ProposalRetargetSubscriberContext = {
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

function resolveRemainingTtlSeconds(proposal: Cart, now: Date): number {
  const remainingSeconds = Math.floor((proposal.expiresAt.getTime() - now.getTime()) / 1000)
  if (remainingSeconds < CART_PROPOSAL_MIN_TTL_SECONDS) return CART_PROPOSAL_MIN_TTL_SECONDS
  if (remainingSeconds > CART_PROPOSAL_MAX_TTL_SECONDS) return CART_PROPOSAL_MAX_TTL_SECONDS
  return remainingSeconds
}

function buildRuntimeContext(
  container: { resolve: <T = unknown>(name: string) => T },
  trusted: ReturnType<typeof buildTrustedCommandContext>['ctx'],
): CommandRuntimeContext {
  return { ...trusted, container: container as unknown as CommandRuntimeContext['container'] } as CommandRuntimeContext
}

/**
 * Rejects the OLD proposal under a trusted, request-less system context — the one call
 * every branch below ends with (a successful re-author supersedes the old row; an
 * ineligible-author or a failed re-author supersedes it with nothing re-authored). Never
 * built under the original author's own context: by the time this runs, that identity has
 * either already proved itself (the create call just succeeded) or has already been found
 * wanting (the create call just failed) — re-checking `cart.proposals.author` a second time
 * here would gate a cart-owned cleanup on a feature check that has nothing left to decide.
 */
async function supersedeOldProposal(
  commandBus: CommandBus,
  container: { resolve: <T = unknown>(name: string) => T },
  scope: { tenantId: string; organizationId: string },
  proposalCartId: string,
  reason: string,
): Promise<void> {
  const { ctx } = buildTrustedCommandContext({
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    actorType: 'system',
    reason,
  })
  const runtimeCtx = buildRuntimeContext(container, ctx)
  await commandBus.execute<CartProposalRejectInput, unknown>('cart.proposal.reject', {
    input: { proposalCartId, tenantId: scope.tenantId, organizationId: scope.organizationId, rejectedBy: 'author' },
    ctx: runtimeCtx,
  })
}

async function retargetOrSupersedeOneProposal(params: {
  em: EntityManager
  container: { resolve: <T = unknown>(name: string) => T }
  commandBus: CommandBus
  proposal: Cart
  newTargetCartId: string
  scope: { tenantId: string; organizationId: string }
}): Promise<void> {
  const { em, container, commandBus, proposal, newTargetCartId, scope } = params

  const proposalLines = (await findWithDecryption(
    em,
    CartLine,
    { cartId: proposal.id, deletedAt: null, tenantId: scope.tenantId, organizationId: scope.organizationId },
    {},
    scope,
  )) as CartLine[]
  if (proposalLines.length === 0) {
    // Nothing to re-author; supersede is still the correct terminal state for a stray,
    // lineless proposal row (should not happen in practice — `cart.proposal.create` always
    // refuses to create one with zero lines).
    await supersedeOldProposal(commandBus, container, scope, proposal.id, 'cart.proposal.supersede:no_lines')
    return
  }

  const author = proposalLines[0]
  const authorActorType: CartLineActorType = author.addedByActorType
  const authorActorId = author.addedByActorId ?? null

  // D-R5-14's fallback applies whenever there is no eligible HUMAN identity to re-author
  // as — Release 5 never writes `'ai_agent'` to a proposal line (S10), and `'buyer'`/
  // `'merge'`/`'system'` are not proposal-authoring actor types at all. The "is deactivated"
  // and "live mode refuses the actor type" halves of D-R5-14's fallback are checked
  // indirectly, via `cart.proposal.create`'s own `cart.proposals.author` feature check
  // below — `cart` has no store-mode concept of its own (§7a.6) to check the second half
  // directly.
  if (authorActorType !== 'rep' || !authorActorId) {
    await supersedeOldProposal(commandBus, container, scope, proposal.id, 'cart.proposal.supersede:ineligible_author_type')
    return
  }

  const createInput: CartProposalCreateInput = {
    targetCartId: newTargetCartId,
    lines: proposalLines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId ?? null,
      quantity: line.quantity,
      configuration: line.configuration ?? null,
    })),
    ttlSeconds: resolveRemainingTtlSeconds(proposal, new Date()),
  }

  const { ctx: authorCtx } = buildTrustedCommandContext({
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    actorType: 'user',
    actorId: authorActorId,
    reason: 'cart.proposal.reauthor',
  })
  const runtimeCtx = buildRuntimeContext(container, authorCtx)

  try {
    await commandBus.execute<CartProposalCreateInput, CartProposalCreateResult>('cart.proposal.create', {
      input: createInput,
      ctx: runtimeCtx,
    })
  } catch (err) {
    // D-R5-14's fallback: the author lost `cart.proposals.author`, is deactivated (the
    // `rbacService` resolution fails to grant it), or the create call refused for any other
    // reason (e.g. the new target itself is no longer `active`/`abandoned`). Any failure
    // here means "do not re-author" — supersede instead, never re-throw.
    logger.warn('[cart:proposal-retarget-on-merge] re-author failed, superseding instead', {
      proposalCartId: proposal.id,
      newTargetCartId,
      error: err instanceof Error ? err.message : err,
    })
    await supersedeOldProposal(commandBus, container, scope, proposal.id, 'cart.proposal.supersede:reauthor_failed')
    return
  }

  await supersedeOldProposal(commandBus, container, scope, proposal.id, 'cart.proposal.supersede:reauthored')
}

/**
 * `cart.cart.merged` handler (persistent). `sourceCartId` is the ABSORBED cart (the one
 * that just left `active` for `merged`, §7.1/§7.4) — any `kind = 'proposal'` cart still
 * `status: 'active'` and `proposedToCartId = sourceCartId` was targeting a basket that just
 * stopped being the buyer's live one (the §8.1 "stranded thread" scenario, minus the
 * thread). Each one is retargeted independently (assisted-selling §6.1's own rule —
 * "Both proposals are live... neither blocks the other" — applies here too: this handler
 * never treats a sibling proposal for the SAME target as something to supersede merely for
 * existing; only THIS cart's own absorption triggers anything).
 *
 * Idempotent on redelivery by construction: a proposal this handler already processed is no
 * longer `status: 'active'` (the terminal `cart.proposal.reject` call always runs, in both
 * the re-author-succeeded and the supersede-only branches), so the query below finds nothing
 * on a second delivery of the same event. The one gap (documented, not closed, in
 * NOTIFY.md's Step 3.3 entry): a crash between a successful re-author and the matching
 * supersede call leaves the OLD proposal still `active`, so a redelivery can re-author a
 * SECOND time before finally rejecting the first old row.
 */
export async function handleCartMergedForProposalRetarget(
  payload: unknown,
  ctx: ProposalRetargetSubscriberContext,
): Promise<void> {
  const record = toRecord(payload)
  const sourceCartId = readString(record, 'sourceCartId')
  const targetCartId = readString(record, 'targetCartId')
  const tenantId = readString(record, 'tenantId') ?? ctx.tenantId ?? null
  const organizationId = readString(record, 'organizationId') ?? ctx.organizationId ?? null

  if (!sourceCartId || !targetCartId || !tenantId || !organizationId) {
    logger.debug('[cart:proposal-retarget-on-merge] skipped incomplete payload', {
      hasSourceCartId: Boolean(sourceCartId),
      hasTargetCartId: Boolean(targetCartId),
      hasTenantId: Boolean(tenantId),
      hasOrganizationId: Boolean(organizationId),
    })
    return
  }

  const container = ctx.container ?? { resolve: ctx.resolve }
  const scope = { tenantId, organizationId }

  try {
    const em = container.resolve<EntityManager>('em').fork()
    const pendingProposals = (await findWithDecryption(
      em,
      Cart,
      { kind: 'proposal' as const, proposedToCartId: sourceCartId, status: 'active' as const, tenantId, organizationId },
      {},
      scope,
    )) as Cart[]
    if (pendingProposals.length === 0) return

    const commandBus = container.resolve<CommandBus>('commandBus')
    for (const proposal of pendingProposals) {
      await retargetOrSupersedeOneProposal({ em, container, commandBus, proposal, newTargetCartId: targetCartId, scope })
    }
  } catch (err) {
    logger.warn('[cart:proposal-retarget-on-merge] failed', {
      sourceCartId,
      targetCartId,
      error: err instanceof Error ? err.message : err,
    })
  }
}
