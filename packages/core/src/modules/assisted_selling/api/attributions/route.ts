import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { CrudHttpError, isCrudHttpError, translateCrudErrorBody } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { AssistedSellingAttribution } from '../../data/entities'
import { organizationIdsFromAssistedSellingScope } from '../../lib/organizationScope'

const logger = createLogger('assisted_selling').child({ component: 'api' })

// Step 5.4 (§6.7/§11 Phase 4, S18). `GET /attributions` — the commission/attribution report
// read, scoped to the caller's organizations (S9's own precedent, one module boundary over),
// never a single expected org. Filterable by the ids a report consumer already has on hand
// (a proposal, a thread, an order, a quote) and by `convertedAt` date range.

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['assisted_selling.attributions.view'] },
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  proposalId: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  cartId: z.string().uuid().optional(),
  salesOrderId: z.string().uuid().optional(),
  salesQuoteId: z.string().uuid().optional(),
  convertedFrom: z.coerce.date().optional(),
  convertedTo: z.coerce.date().optional(),
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
  return { container, tenantId: auth.tenantId, organizationIds, translate }
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
    const where: Record<string, unknown> = { tenantId }
    if (Array.isArray(organizationIds)) {
      if (organizationIds.length === 0) return NextResponse.json({ items: [], total: 0, page, pageSize })
      where.organizationId = { $in: organizationIds }
    }
    if (query.proposalId) where.proposalId = query.proposalId
    if (query.threadId) where.threadId = query.threadId
    if (query.cartId) where.cartId = query.cartId
    if (query.salesOrderId) where.salesOrderId = query.salesOrderId
    if (query.salesQuoteId) where.salesQuoteId = query.salesQuoteId
    if (query.convertedFrom || query.convertedTo) {
      const range: Record<string, Date> = {}
      if (query.convertedFrom) range.$gte = query.convertedFrom
      if (query.convertedTo) range.$lte = query.convertedTo
      where.convertedAt = range
    }

    const [rows, total] = await em.findAndCount(AssistedSellingAttribution, where, {
      orderBy: { convertedAt: 'DESC' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })

    return NextResponse.json({
      items: rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        cartId: row.cartId,
        cartLineId: row.cartLineId ?? null,
        salesOrderId: row.salesOrderId ?? null,
        salesOrderLineId: row.salesOrderLineId ?? null,
        salesQuoteId: row.salesQuoteId ?? null,
        salesQuoteLineId: row.salesQuoteLineId ?? null,
        actorType: row.actorType,
        actorId: row.actorId ?? null,
        threadId: row.threadId ?? null,
        proposalId: row.proposalId ?? null,
        lineNetAmount: row.lineNetAmount,
        lineGrossAmount: row.lineGrossAmount,
        currencyCode: row.currencyCode,
        convertedAt: row.convertedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
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
    logger.error('assisted_selling.attributions.list failed', { err })
    return NextResponse.json({ error: translate('assisted_selling.errors.list_failed', 'Failed to list sales attribution.') }, { status: 500 })
  }
}

const attributionRowSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  cartId: z.string().uuid(),
  cartLineId: z.string().uuid().nullable(),
  salesOrderId: z.string().uuid().nullable(),
  salesOrderLineId: z.string().uuid().nullable(),
  salesQuoteId: z.string().uuid().nullable(),
  salesQuoteLineId: z.string().uuid().nullable(),
  actorType: z.string(),
  actorId: z.string().uuid().nullable(),
  threadId: z.string().uuid().nullable(),
  proposalId: z.string().uuid().nullable(),
  lineNetAmount: z.string(),
  lineGrossAmount: z.string(),
  currencyCode: z.string(),
  convertedAt: z.string(),
  createdAt: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Assisted Selling',
  summary: 'Sales attribution (Phase 4, §6.7)',
  methods: {
    GET: {
      summary: 'List sales attribution rows',
      description:
        'Scoped to the caller\'s organizations (S9). pageSize <= 100. Filters by proposal, thread, cart, order, quote and convertedAt range. One row per converted cart line (or, when the conversion degraded for a missing lineMap, one row per actor, §6.7).',
      query: listQuerySchema,
      responses: [{ status: 200, description: 'Paged list of attribution rows', schema: z.object({ items: z.array(attributionRowSchema), total: z.number(), page: z.number(), pageSize: z.number() }) }],
      errors: [
        { status: 401, description: 'Unauthorized' },
        { status: 403, description: 'Missing required feature' },
      ],
    },
  },
}
