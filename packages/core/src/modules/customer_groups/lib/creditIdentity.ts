import type { EntityManager } from '@mikro-orm/postgresql'

// Release 5 §6.5 (G11): credit belongs to the company. From a buyer's `customerIds`
// (person first, then company — §6.0), this picks the first id that is a company
// entity; with no company it falls back to the first-listed id (the person, per the
// `customerIds` ordering convention). Reads the entity kind through a direct query
// against `customers`' own table — FK id only, no import of `customers` — mirroring
// `lib/customerScope.ts`'s established "FK-id + snapshot" coupling rule for this module.
const CUSTOMER_TABLE = 'customer_entities'

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
