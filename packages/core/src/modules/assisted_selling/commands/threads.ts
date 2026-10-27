import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { CrudHttpError, isUniqueViolation, notFound } from '@open-mercato/shared/lib/crud/errors'
import { ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  AssistedSellingMessage,
  AssistedSellingParticipant,
  AssistedSellingThread,
} from '../data/entities'
import { resolveEffectiveAssistedSellingSettings } from '../lib/settings'
import { resolveCartService } from '../lib/cartAccess'
import { resolveOrBuildRepParticipant } from '../lib/participants'
import { emitAssistedSellingEvent } from '../events'
import { requireAssistedSellingFeatures } from './shared'

// Step 4.4 (§6.1, §6.3 step 0, §5.1, S9). `POST /threads`: "Staff opens a conversation about a
// basket, by cart id ... The cart is read through cart's organization-scoped admin detail read
// (S9)." The thread inherits the cart's `organization_id` — never the caller's selected one.

export type AssistedSellingThreadOpenInput = {
  tenantId: string
  /** The caller's own allowed organizations (S9) — `null` means unrestricted (superadmin with
   * no selected organization). The target cart must resolve WITHIN this list; the thread then
   * inherits the cart's own `organizationId`, which is why this input carries a list rather
   * than a single expected value. */
  organizationIds: string[] | null
  cartId: string
  message?: string
}

export type AssistedSellingThreadOpenResult = {
  threadId: string
  organizationId: string
  storeId: string
  buyerCartId: string
  customerId: string | null
  customerUserId: string | null
  status: string
  modeSnapshot: string
  liveProposalCount: number
  lastActivityAt: string
  createdAt: string
  updatedAt: string
  participantId: string
  messageId: string
  alreadyOpen: boolean
}

function toIso(value: Date): string {
  return value.toISOString()
}

async function findOpenThreadByBuyerCart(
  em: EntityManager,
  scope: { tenantId: string },
  buyerCartId: string,
): Promise<AssistedSellingThread | null> {
  return em.findOne(AssistedSellingThread, {
    tenantId: scope.tenantId,
    buyerCartId,
    status: 'open',
    deletedAt: null,
  })
}

function toResult(thread: AssistedSellingThread, participant: AssistedSellingParticipant, message: AssistedSellingMessage, alreadyOpen: boolean): AssistedSellingThreadOpenResult {
  return {
    threadId: thread.id,
    organizationId: thread.organizationId,
    storeId: thread.storeId,
    buyerCartId: thread.buyerCartId,
    customerId: thread.customerId ?? null,
    customerUserId: thread.customerUserId ?? null,
    status: thread.status,
    modeSnapshot: thread.modeSnapshot,
    liveProposalCount: thread.liveProposalCount,
    lastActivityAt: toIso(thread.lastActivityAt),
    createdAt: toIso(thread.createdAt),
    updatedAt: toIso(thread.updatedAt),
    participantId: participant.id,
    messageId: message.id,
    alreadyOpen,
  }
}

const openThreadCommand: CommandHandler<AssistedSellingThreadOpenInput, AssistedSellingThreadOpenResult> = {
  id: 'assisted_selling.thread.open',
  // Opening a thread has no meaningful undo (closing it again is a separate, explicit
  // action a later Step owns) — same treatment `cart.proposal.create` gives itself.
  isUndoable: false,
  async execute(input, ctx: CommandRuntimeContext) {
    ensureTenantScope(ctx, input.tenantId)
    await requireAssistedSellingFeatures(ctx, ['assisted_selling.threads.participate'])

    const cartService = resolveCartService(ctx.container)
    const cart = await cartService.getForOrganizations({
      tenantId: input.tenantId,
      organizationIds: input.organizationIds,
      cartId: input.cartId,
    })
    if (!cart) throw notFound('[internal] cart not found')
    if (cart.status !== 'active') {
      throw new CrudHttpError(409, { error: '[internal] cart_not_active', code: 'cart_not_active', status: cart.status })
    }
    // §5.1's own column is a non-nullable `ecommerce.EcommerceStore.id`; a basket cart with
    // no resolved store (e.g. a `pos`/`api` cart created before any store binding) has
    // nowhere to read `AssistedSellingStoreSettings.mode` from and cannot be opened on — not
    // named explicitly by §6.1's own text, but the smallest faithful reading of a column the
    // spec declares non-nullable.
    if (!cart.storeId) {
      throw new CrudHttpError(400, { error: '[internal] store_required', code: 'store_required' })
    }

    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const existingOpen = await findOpenThreadByBuyerCart(em, { tenantId: input.tenantId }, cart.id)
    if (existingOpen) {
      throw new CrudHttpError(409, {
        error: '[internal] thread_already_open',
        code: 'thread_already_open',
        threadId: existingOpen.id,
      })
    }

    const settings = await resolveEffectiveAssistedSellingSettings(em, {
      tenantId: input.tenantId,
      organizationId: cart.organizationId,
      storeId: cart.storeId,
    })
    // §6.3 step 0: "`rep` requires `mode ∈ {rep, both}` ... The same check gates `POST
    // /threads`." Release 5's only reachable value besides `off` is `rep` (S10).
    if (settings.mode !== 'rep') {
      throw new CrudHttpError(409, { error: '[internal] assisted_selling_unavailable', code: 'assisted_selling_unavailable' })
    }

    const authorActorId = ctx.auth?.sub
    if (!authorActorId) {
      throw notFound('[internal] no authenticated principal to open this thread as')
    }

    const now = new Date()
    const threadId = randomUUID()
    const thread = em.create(AssistedSellingThread, {
      id: threadId,
      tenantId: input.tenantId,
      organizationId: cart.organizationId,
      storeId: cart.storeId,
      buyerCartId: cart.id,
      customerId: cart.customerId ?? null,
      customerUserId: cart.customerUserId ?? null,
      status: 'open' as const,
      modeSnapshot: settings.mode,
      liveProposalCount: 0,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })
    // §6.1: "creates the thread, adds the rep as a participant and posts an opening
    // message" — a fresh thread never has an existing participant, so this always builds a
    // new one (`resolveOrBuildRepParticipant` is shared with `commands/proposals.ts`, where
    // the actor MAY already be a participant from an earlier `POST /threads` call).
    const { participant } = await resolveOrBuildRepParticipant(
      em,
      { tenantId: input.tenantId, organizationId: cart.organizationId, threadId },
      authorActorId,
    )
    const message = em.create(AssistedSellingMessage, {
      id: randomUUID(),
      tenantId: input.tenantId,
      organizationId: cart.organizationId,
      threadId,
      participantId: participant.id,
      body: input.message?.trim() ?? '',
      bodyFormat: 'text' as const,
      sentAt: now,
      createdAt: now,
      updatedAt: now,
    })

    try {
      await withAtomicFlush(
        em,
        [
          async () => {
            em.persist(thread)
            em.persist(participant)
            em.persist(message)
          },
        ],
        { transaction: true, label: 'assisted_selling.thread.open' },
      )
    } catch (error) {
      // §5.1: the partial unique index (`tenant_id`, `buyer_cart_id` where `status =
      // 'open'`) is the race backstop for two concurrent opens on the same basket — the
      // loser answers the same `409 thread_already_open` a sequential second call gets.
      if (isUniqueViolation(error)) {
        const winner = await findOpenThreadByBuyerCart(
          (ctx.container.resolve('em') as EntityManager).fork(),
          { tenantId: input.tenantId },
          cart.id,
        )
        throw new CrudHttpError(409, {
          error: '[internal] thread_already_open',
          code: 'thread_already_open',
          threadId: winner?.id ?? null,
        })
      }
      throw error
    }

    await emitAssistedSellingEvent('assisted_selling.thread.opened', {
      threadId: thread.id,
      tenantId: thread.tenantId,
      organizationId: thread.organizationId,
    })
    await emitAssistedSellingEvent('assisted_selling.participant.joined', {
      threadId: thread.id,
      participantId: participant.id,
      tenantId: thread.tenantId,
      organizationId: thread.organizationId,
    })
    await emitAssistedSellingEvent('assisted_selling.message.posted', {
      threadId: thread.id,
      messageId: message.id,
      tenantId: thread.tenantId,
      organizationId: thread.organizationId,
    })

    return toResult(thread, participant, message, false)
  },
}

registerCommand(openThreadCommand)

export { openThreadCommand }
