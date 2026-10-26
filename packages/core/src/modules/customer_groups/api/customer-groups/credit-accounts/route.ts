import { z } from 'zod'
import {
  customerCreditAccountCrud,
  customerCreditAccountListQuerySchema,
  customerCreditAccountRouteMetadata,
} from './crud'
import { createCustomerGroupsCrudOpenApi, createPagedListResponseSchema, defaultOkResponseSchema } from '../../openapi'

// GET (list, or detail via `?id=`) + PUT (update, id in body) — no `[id]` dynamic
// segment, same shared-`makeCrudRoute`-instance convention as `../route.ts` /
// `../memberships/route.ts`. No POST/DELETE export: account provisioning and deletion
// are out of this Step's scope (see `./crud.ts`'s header comment), so the methods are
// simply absent rather than wired to a 501 stub.
export const metadata = customerCreditAccountRouteMetadata

export const GET = customerCreditAccountCrud.GET
export const PUT = customerCreditAccountCrud.PUT

export const customerCreditAccountListItemSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  currency_code: z.string(),
  credit_limit: z.string(),
  is_on_hold: z.boolean(),
  hold_reason: z.string().nullable().optional(),
  updated_by_user_id: z.string().uuid().nullable().optional(),
  created_at: z.string().nullable().optional(),
  // Optimistic locking (default ON — root AGENTS.md § Always): the list/detail response
  // returns `updated_at` so `buildOptimisticLockHeader` can derive the lock header from
  // it, exactly like every other entity in this module.
  updated_at: z.string().nullable().optional(),
  // Computed, display-only (§6.5) — never persisted columns. See `./crud.ts`'s
  // `hooks.afterList` for how these are populated via `customerCreditService.checkCredit`.
  exposure: z.string().nullable().optional(),
  available: z.string().nullable().optional(),
})

const customerCreditAccountUpdateRequestSchema = z.object({
  id: z.string().uuid(),
  creditLimit: z.number().min(0).optional(),
  isOnHold: z.boolean().optional(),
  holdReason: z.string().nullable().optional(),
})

export const openApi = createCustomerGroupsCrudOpenApi({
  resourceName: 'CustomerCreditAccount',
  pluralName: 'CustomerCreditAccounts',
  querySchema: customerCreditAccountListQuerySchema,
  listResponseSchema: createPagedListResponseSchema(customerCreditAccountListItemSchema),
  update: {
    schema: customerCreditAccountUpdateRequestSchema,
    responseSchema: defaultOkResponseSchema,
    description:
      'Edits a customer credit account\'s limit and/or hold state. A hold reason is required when isOnHold is set to true. Supports optimistic locking via the extension header.',
  },
})
