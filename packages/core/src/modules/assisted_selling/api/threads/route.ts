import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { CrudHttpError, isCrudHttpError, translateCrudErrorBody } from '@open-mercato/shared/lib/crud/errors'
import { getCommandInterceptorHttpRejection } from '@open-mercato/shared/lib/commands/errors'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { AssistedSellingThread } from '../../data/entities'
import { assistedSellingThreadOpenRequestSchema } from '../../data/validators'
import { organizationIdsFromAssistedSellingScope } from '../../lib/organizationScope'
import { openThreadCommand, type AssistedSellingThreadOpenInput, type AssistedSellingThreadOpenResult } from '../../commands/threads'

const logger = createLogger('assisted_selling').child({ component: 'api' })

// Step 4.4 (§6.1). `GET /threads` (list, scoped to the caller's organizations) and `POST
// /threads` (staff opens a conversation about a basket) — both under `assisted_selling.
// threads.*`, S9-scoped by the caller's `organizationIds`, never a single expected org.

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['assisted_selling.threads.view'] },
  POST: { requireAuth: true, requireFeatures: ['assisted_selling.threads.participate', 'cart.carts.view'] },
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  storeId: z.string().uuid().optional(),
  status: z.enum(['open', 'closed']).optional(),
})

async function resolveCallerContext(req: Request) {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(req)
  const { translate } = await resolveTranslations()
  if (!auth || !auth.tenantId) {
    throw new CrudHttpError(401, { error: translate('assisted_selling.errors.unauthorized', 'Unauthorized') })
  }
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req }).catch(() => null)
  const organizationIds = organizationIdsFromAssistedSellingScope(scope, scope?.selectedId ?? auth.orgId ?? null)
  return { container, auth, tenantId: auth.tenantId, organizationIds, translate }
}

export async function GET(req: Request) {
  const { translate } = await resolveTranslations()
  try {
    const { container, tenantId, organizationIds } = await resolveCallerContext(req)
    const url = new URL(req.url)
    const query = listQuerySchema.parse(Object.fromEntries(url.searchParams.entries()))
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 25

    const em = (container.resolve('em') as EntityManager).fork()
    const where: Record<string, unknown> = { tenantId, deletedAt: null }
    if (Array.isArray(organizationIds)) {
      if (organizationIds.length === 0) return NextResponse.json({ items: [], total: 0, page, pageSize })
      where.organizationId = { $in: organizationIds }
    }
    if (query.storeId) where.storeId = query.storeId
    if (query.status) where.status = query.status

    const [rows, total] = await em.findAndCount(AssistedSellingThread, where, {
      orderBy: { lastActivityAt: 'DESC' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })

    return NextResponse.json({
      items: rows.map((thread) => ({
        id: thread.id,
        organizationId: thread.organizationId,
        storeId: thread.storeId,
        buyerCartId: thread.buyerCartId,
        customerId: thread.customerId ?? null,
        customerUserId: thread.customerUserId ?? null,
        status: thread.status,
        modeSnapshot: thread.modeSnapshot,
        assignedActorId: thread.assignedActorId ?? null,
        liveProposalCount: thread.liveProposalCount,
        lastActivityAt: thread.lastActivityAt.toISOString(),
        closedAt: thread.closedAt ? thread.closedAt.toISOString() : null,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(translateCrudErrorBody(err.body, translate), { status: err.status })
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: translate('assisted_selling.errors.invalidInput', 'Invalid input') }, { status: 400 })
    }
    logger.error('assisted_selling.threads.list failed', { err })
    return NextResponse.json({ error: translate('assisted_selling.errors.list_failed', 'Failed to list selling conversations.') }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const { translate } = await resolveTranslations()
  try {
    const { container, auth, tenantId, organizationIds } = await resolveCallerContext(req)
    const rawBody = await readJsonSafe<Record<string, unknown>>(req, {})
    const body = assistedSellingThreadOpenRequestSchema.parse(rawBody)

    const ctx: CommandRuntimeContext = {
      container,
      auth,
      organizationScope: null,
      selectedOrganizationId: organizationIds && organizationIds.length === 1 ? organizationIds[0] : (auth.orgId ?? null),
      organizationIds,
      request: req,
    }

    const commandInput: AssistedSellingThreadOpenInput = {
      tenantId,
      organizationIds,
      cartId: body.cartId,
      message: body.message,
    }

    const commandBus = container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<AssistedSellingThreadOpenInput, AssistedSellingThreadOpenResult>(openThreadCommand.id, {
      input: commandInput,
      ctx,
    })

    return NextResponse.json({ ok: true, result }, { status: 201 })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(translateCrudErrorBody(err.body, translate), { status: err.status })
    const interceptorRejection = getCommandInterceptorHttpRejection(err)
    if (interceptorRejection) return NextResponse.json(interceptorRejection.body, { status: interceptorRejection.status })
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: translate('assisted_selling.errors.invalidInput', 'Invalid input') }, { status: 400 })
    }
    logger.error('assisted_selling.threads.open failed', { err })
    return NextResponse.json({ error: translate('assisted_selling.errors.unexpected', 'Unexpected error') }, { status: 500 })
  }
}

const threadRowSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  storeId: z.string().uuid(),
  buyerCartId: z.string().uuid(),
  customerId: z.string().uuid().nullable(),
  customerUserId: z.string().uuid().nullable(),
  status: z.enum(['open', 'closed']),
  modeSnapshot: z.string(),
  assignedActorId: z.string().uuid().nullable(),
  liveProposalCount: z.number(),
  lastActivityAt: z.string(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Assisted Selling',
  summary: 'Selling conversations (threads)',
  methods: {
    GET: {
      summary: 'List selling conversations',
      description: 'Scoped to the caller\'s organizations (S9). pageSize <= 100.',
      query: listQuerySchema,
      responses: [{ status: 200, description: 'Paged list of threads', schema: z.object({ items: z.array(threadRowSchema), total: z.number(), page: z.number(), pageSize: z.number() }) }],
    },
    POST: {
      summary: 'Open a conversation about a basket',
      description: 'Staff opens a conversation about a basket by cart id (§6.1). The cart is read through a cart DI read scoped to the caller\'s organizations (S9); the thread inherits the cart\'s organization_id.',
      requestBody: { contentType: 'application/json', schema: assistedSellingThreadOpenRequestSchema },
      responses: [{ status: 201, description: 'The newly opened thread' }],
      errors: [
        { status: 400, description: 'Invalid body, or store_required' },
        { status: 401, description: 'Unauthorized' },
        { status: 403, description: 'Missing required feature(s)' },
        { status: 404, description: 'Cart not found or outside the caller\'s organizations' },
        { status: 409, description: 'cart_not_active, thread_already_open, or assisted_selling_unavailable' },
      ],
    },
  },
}
