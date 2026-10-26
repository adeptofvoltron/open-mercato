import type { EntityManager } from '@mikro-orm/postgresql'

// Release 5 §6.5 (G11): credit belongs to the company. From a buyer's `customerIds`
// (person first, then company — §6.0), this picks the first id that is a company
// entity; with no company it falls back to the first-listed id (the person, per the
// `customerIds` ordering convention). Reads the entity kind through a direct query
// against `customers`' own table — FK id only, no import of `customers` — mirroring
// `lib/customerScope.ts`'s established "FK-id + snapshot" coupling rule for this module.
const CUSTOMER_TABLE = 'customer_entities'

// Release 5 Phase 3 (G15, Step 1.8). The `customer_groups.credit.limit_exceeded`
// notification routes to the company's `account_manager` role, which lives on
// `customers`' own `customer_entity_roles` table (`CustomerEntityRole` in
// `customers/data/entities.ts`). Same FK-id-only, direct-SQL coupling as the company
// resolution above — no ORM import of `customers`.
const CUSTOMER_ENTITY_ROLES_TABLE = 'customer_entity_roles'
const ACCOUNT_MANAGER_ROLE_TYPE = 'account_manager'

export async function resolveCompanyFirstCustomerId(
  em: EntityManager,
  customerIds: string[],
  tenantId: string,
): Promise<string> {
  const distinctIds = customerIds.filter((id) => typeof id === 'string' && id.length > 0)
  if (!distinctIds.length) {
    throw new Error('[internal] resolveCompanyFirstCustomerId requires at least one customerId')
  }
  if (distinctIds.length === 1) return distinctIds[0]

  const placeholders = distinctIds.map(() => '?').join(', ')
  const rows = await em
    .getConnection()
    .execute(
      `select id, kind from ${CUSTOMER_TABLE} where tenant_id = ? and id in (${placeholders}) and deleted_at is null`,
      [tenantId, ...distinctIds],
    )
  const kindById = new Map<string, string>()
  if (Array.isArray(rows)) {
    for (const row of rows as Array<{ id?: unknown; kind?: unknown }>) {
      if (typeof row.id === 'string' && typeof row.kind === 'string') kindById.set(row.id, row.kind)
    }
  }
  const companyId = distinctIds.find((id) => kindById.get(id) === 'company')
  return companyId ?? distinctIds[0]
}

// Not-deleted, active role assignment only (`deleted_at is null`) — a removed account
// manager must not keep receiving limit-exceeded notifications. Returns `null` when the
// company has no `account_manager` assigned, so the caller falls back to staff holding
// `customer_groups.credit.manage` (G15).
export async function resolveAccountManagerUserId(
  em: EntityManager,
  customerId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<string | null> {
  const rows = await em
    .getConnection()
    .execute(
      `select user_id from ${CUSTOMER_ENTITY_ROLES_TABLE}
       where tenant_id = ? and organization_id = ? and entity_id = ? and role_type = ? and deleted_at is null
       limit 1`,
      [scope.tenantId, scope.organizationId, customerId, ACCOUNT_MANAGER_ROLE_TYPE],
    )
  const row = Array.isArray(rows) ? (rows[0] as { user_id?: unknown } | undefined) : undefined
  return typeof row?.user_id === 'string' && row.user_id.length > 0 ? row.user_id : null
}

// Used to deep-link a credit notification to the right detail page
// (`/backend/customers/companies/:id` vs `/backend/customers/people/:id`) — credit
// usually resolves to a company (G11), but falls back to a person when the buyer has
// no company, so the link target cannot be hard-coded.
export async function resolveCustomerEntityKind(
  em: EntityManager,
  customerId: string,
  tenantId: string,
): Promise<'company' | 'person' | null> {
  const rows = await em
    .getConnection()
    .execute(`select kind from ${CUSTOMER_TABLE} where tenant_id = ? and id = ? and deleted_at is null limit 1`, [
      tenantId,
      customerId,
    ])
  const row = Array.isArray(rows) ? (rows[0] as { kind?: unknown } | undefined) : undefined
  return row?.kind === 'company' || row?.kind === 'person' ? row.kind : null
}
