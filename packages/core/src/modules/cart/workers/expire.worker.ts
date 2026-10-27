import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { CustomerPurchaseApprovalService } from '@open-mercato/core/modules/customer_groups/services/customerPurchaseApprovalService'
import { CART_EXPIRE_QUEUE } from '../lib/queues'
import { sweepExpiredCarts, type CartCodeServiceLike } from '../lib/sweepers'

const logger = createLogger('cart')

/** See `mark-abandoned.worker.ts`'s `CartSweepTickPayload` doc comment — identical shape. */
export type CartSweepTickPayload = {
  scope?: { tenantId?: string | null }
  tenantId?: string | null
}

export const metadata: WorkerMeta = {
  queue: CART_EXPIRE_QUEUE,
  id: 'cart:expire',
  concurrency: 1,
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(job: QueuedJob<CartSweepTickPayload>, ctx: HandlerContext): Promise<void> {
  const raw = (job?.payload ?? {}) as CartSweepTickPayload
  const tenantId = raw.scope?.tenantId ?? raw.tenantId ?? null
  if (!tenantId) {
    logger.warn('cart:expire skipping tick — payload has no tenantId', { payload: raw })
    return
  }

  const em = (ctx.resolve('em') as EntityManager).fork()
  // K11: `promotionCodeService` is `promotions`' own frozen DI token
  // (`promotions/di.ts`, §Release 4 Contract Freeze) — resolved here, not imported
  // statically, so this module never takes a hard dependency on `promotions`' entities.
  const codeService = ctx.resolve<CartCodeServiceLike>('promotionCodeService')
  // (rev 10 — K3) Soft-resolved, same reasoning as `codeService` above: `customer_groups`
  // is a hard `requires` of `cart`, but this degrades to `null` (skip the withdrawal,
  // never throw) rather than take a hard dependency on another module's DI registration
  // staying exactly as expected.
  let approvalService: CustomerPurchaseApprovalService | null = null
  try {
    approvalService = ctx.resolve<CustomerPurchaseApprovalService>('customerPurchaseApprovalService')
  } catch {
    approvalService = null
  }
  try {
    const result = await sweepExpiredCarts(em, { tenantId }, codeService, approvalService)
    if (result.transitioned > 0) {
      logger.info('cart:expire swept carts', { tenantId, transitioned: result.transitioned })
    }
  } catch (error) {
    logger.error('cart:expire sweep failed', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
