import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands/command-bus'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi/types'
import { Message } from '../../../data/entities'
import { updateDraftSchema } from '../../../data/validators'
import { attachOperationMetadataHeader } from '../../../lib/operationMetadata'
import { canUseMessageEmailFeature, hasOrganizationAccess, resolveMessageContext } from '../../../lib/routeHelpers'
import { errorResponseSchema, okResponseSchema, updateDraftSchema as updateDraftOpenApiSchema } from '../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['messages.compose'] },
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { ctx, scope } = await resolveMessageContext(req)
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  const commandBus = ctx.container.resolve('commandBus') as CommandBus
  const body = await req.json().catch(() => ({}))
  const input = updateDraftSchema.parse(body)

  const message = await em.findOne(Message, {
    id: params.id,
    tenantId: scope.tenantId,
    deletedAt: null,
  })

  if (!message) {
    return Response.json({ error: 'Message not found' }, { status: 404 })
  }

  if (!hasOrganizationAccess(scope.organizationId, message.organizationId)) {
    return Response.json({ error: 'Access denied' }, { status: 403 })
  }

  if (message.senderUserId !== scope.userId) {
    return Response.json({ error: 'Access denied' }, { status: 403 })
  }

  if (!message.isDraft) {
    return Response.json({ error: 'Only draft messages can be sent this way' }, { status: 409 })
  }

  const resolvedVisibility = input.visibility ?? message.visibility
  const resolvedSendViaEmail = input.sendViaEmail ?? message.sendViaEmail
  if (resolvedVisibility === 'public' || resolvedSendViaEmail) {
    if (!(await canUseMessageEmailFeature(ctx, scope))) {
      return Response.json({ error: 'Missing feature: messages.email' }, { status: 403 })
    }
  }

  try {
    const { result, logEntry } = await commandBus.execute('messages.messages.send_draft', {
      input: {
        ...input,
        messageId: params.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        userId: scope.userId,
      },
      ctx: {
        container: ctx.container,
        auth: ctx.auth ?? null,
        organizationScope: null,
        selectedOrganizationId: scope.organizationId,
        organizationIds: scope.organizationId ? [scope.organizationId] : null,
        request: req,
      },
    })

    const { id } = result as { ok: boolean; id: string }
    const response = Response.json({ ok: true, id })
    attachOperationMetadataHeader(response, logEntry, {
      resourceKind: 'messages.message',
      resourceId: id,
    })
    return response
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Only draft messages can be sent this way') {
        return Response.json({ error: error.message }, { status: 409 })
      }
      if (error.message === 'Access denied') {
        return Response.json({ error: error.message }, { status: 403 })
      }
      if (
        error.message === 'at least one recipient is required'
        || error.message === 'externalEmail is required when visibility is public'
        || error.message === 'subject is required'
        || error.message === 'body is required'
      ) {
        return Response.json({ error: error.message }, { status: 400 })
      }
    }
    throw error
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Messages',
  methods: {
    POST: {
      summary: 'Send a draft message',
      requestBody: { schema: updateDraftOpenApiSchema },
      responses: [
        { status: 200, description: 'Draft sent', schema: okResponseSchema },
      ],
      errors: [
        { status: 400, description: 'Validation error', schema: errorResponseSchema },
        { status: 403, description: 'Access denied', schema: errorResponseSchema },
        { status: 404, description: 'Message not found', schema: errorResponseSchema },
        { status: 409, description: 'Message is not a draft', schema: errorResponseSchema },
      ],
    },
  },
}
