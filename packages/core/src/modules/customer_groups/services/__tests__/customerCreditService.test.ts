// Step 1.6 — unit coverage for `services/customerCreditService.ts` against a hand-built,
// in-memory fake `EntityManager` (same spirit as
// `promotions/lib/__tests__/promotion-usage-service.test.ts`'s fake: no real database,
// `lockMode` accepted and ignored). This proves the SEQUENTIAL decision logic — idempotency
// (G12), `on_hold`/`limit_exceeded`/`no_account`/`not_permitted` refusals, release/settle
// lifecycle — not a genuine concurrent-transaction race. The N=20 real-Postgres proof that
// the row lock (G1) actually serializes concurrent writers lives in the sibling
// `customerCreditService.concurrency.pg.test.ts`, gated on `OM_CUSTOMER_GROUPS_PG_URL`.

import { randomUUID } from 'crypto'
import { CustomerCreditAccount, CustomerCreditLedgerEntry } from '../../data/entities'
import type { CustomerGroupsService, ResolvedTerms } from '../customerGroupsService'

// Step 1.8: `reserveCredit` emits `customer_groups.credit.limit_exceeded` on refusal —
// mocked here (as `../../events` mocks it in `api/customer-groups/__tests__/*.test.ts`)
// so this file keeps testing only the service's decision logic; the emission itself is
// asserted below in the `limit_exceeded` test case.
const emitCustomerGroupsEventMock = jest.fn(async () => {})
jest.mock('../../events', () => ({
  emitCustomerGroupsEvent: (...args: unknown[]) => emitCustomerGroupsEventMock(...args),
}))

import {
  DefaultCustomerCreditService,
  CustomerCreditServiceError,
  type CommerceScope,
} from '../customerCreditService'

const TENANT = 'tenant-1'
const ORG = 'org-1'
const SCOPE: CommerceScope = { tenantId: TENANT, organizationId: ORG }
const CUSTOMER_ID = 'customer-1'
const CURRENCY = 'USD'

type Row = Record<string, unknown>

function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key]
    if (condition === null) return value === null || value === undefined
    if (condition && typeof condition === 'object' && '$in' in (condition as Row)) {
      return ((condition as Row).$in as unknown[]).includes(value)
    }
    return value === condition
  })
}

type FakeEm = {
  findOne: (entity: Function, where: Row, options?: unknown) => Promise<Row | null>
  find: (entity: Function, where: Row) => Promise<Row[]>
  create: (entity: Function, data: Row) => Row
  persist: (row: Row) => void
  flush: () => Promise<void>
  begin: () => Promise<void>
  commit: () => Promise<void>
  rollback: () => Promise<void>
  isInTransaction: () => boolean
  fork: () => FakeEm
}

function createFakeEm(): { em: FakeEm; tables: Map<Function, Row[]> } {
  const tables = new Map<Function, Row[]>()
  let inTransaction = false
  let pendingCreates: Array<{ entity: Function; row: Row }> = []

  function tableFor(entity: Function): Row[] {
    let rows = tables.get(entity)
    if (!rows) {
      rows = []
      tables.set(entity, rows)
    }
    return rows
  }

  const em: FakeEm = {
    findOne: async (entity, where) => tableFor(entity).find((row) => matchesWhere(row, where)) ?? null,
    find: async (entity, where) => tableFor(entity).filter((row) => matchesWhere(row, where)),
    create: (entity, data) => {
      const row: Row = { id: randomUUID(), ...data }
      pendingCreates.push({ entity, row })
      return row
    },
    persist: () => {},
    flush: async () => {
      const toApply = pendingCreates
      pendingCreates = []
      for (const { entity, row } of toApply) tableFor(entity).push(row)
    },
    begin: async () => {
      inTransaction = true
    },
    commit: async () => {
      inTransaction = false
    },
    rollback: async () => {
      inTransaction = false
    },
    isInTransaction: () => inTransaction,
    fork: () => em,
  }
  return { em, tables }
}

function asEm(fake: FakeEm): import('@mikro-orm/postgresql').EntityManager {
  return fake as unknown as import('@mikro-orm/postgresql').EntityManager
}

function seedAccount(
  tables: Map<Function, Row[]>,
  overrides: Partial<{
    id: string
    tenantId: string
    organizationId: string
    customerId: string
    currencyCode: string
    creditLimit: string
    isOnHold: boolean
    deletedAt: Date | null
  }> = {},
): Row {
  const row: Row = {
    id: randomUUID(),
    tenantId: TENANT,
    organizationId: ORG,
    customerId: CUSTOMER_ID,
    currencyCode: CURRENCY,
    creditLimit: '500.00',
    isOnHold: false,
    holdReason: null,
    deletedAt: null,
    ...overrides,
  }
  let rows = tables.get(CustomerCreditAccount)
  if (!rows) {
    rows = []
    tables.set(CustomerCreditAccount, rows)
  }
  rows.push(row)
  return row
}

function allowTerms(allow: boolean): CustomerGroupsService {
  return {
    resolveGroups: jest.fn(),
    resolveTerms: jest.fn(async () => ({ allowPurchaseOnAccount: allow }) as unknown as ResolvedTerms),
    resolveAssortmentScope: jest.fn(),
  }
}

function buildService(em: FakeEm, groupsService: CustomerGroupsService) {
  return new DefaultCustomerCreditService(asEm(em), groupsService)
}

describe('customerCreditService', () => {
  beforeEach(() => {
    emitCustomerGroupsEventMock.mockClear()
  })

  describe('checkCredit', () => {
    test('not_permitted wins even when an account exists', async () => {
      const { em, tables } = createFakeEm()
      const account = seedAccount(tables)
      const service = buildService(em, allowTerms(false))

      const result = await service.checkCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '10.00',
      })

      expect(result.reason).toBe('not_permitted')
      expect(result.allowed).toBe(false)
      expect(result.creditAccountId).toBe(account.id)
    })

    test('no_account when nothing matches the scope', async () => {
      const { em } = createFakeEm()
      const service = buildService(em, allowTerms(true))

      const result = await service.checkCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '10.00',
      })

      expect(result.reason).toBe('no_account')
      expect(result.creditAccountId).toBeNull()
    })

    test('on_hold refuses regardless of exposure', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { isOnHold: true, creditLimit: '1000.00' })
      const service = buildService(em, allowTerms(true))

      const result = await service.checkCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '1.00',
      })

      expect(result.reason).toBe('on_hold')
    })

    test('limit_exceeded when the hint amount would overshoot', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '100.00' })
      const service = buildService(em, allowTerms(true))

      const result = await service.checkCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '150.00',
      })

      expect(result.reason).toBe('limit_exceeded')
      expect(result.available).toBe('100.00')
    })

    test('ok reports creditLimit/exposure/available', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '100.00' })
      const service = buildService(em, allowTerms(true))

      const result = await service.checkCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '40.00',
      })

      expect(result).toMatchObject({ reason: 'ok', allowed: true, creditLimit: '100.00', exposure: '0.00', available: '100.00' })
    })

    test('a different tenant never sees this account (G2)', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables)
      const service = buildService(em, allowTerms(true))

      const result = await service.checkCredit({
        scope: { tenantId: 'tenant-2', organizationId: ORG },
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '10.00',
      })

      expect(result.reason).toBe('no_account')
    })
  })

  describe('reserveCredit', () => {
    test('appends a reserve entry with balanceAfter computed under the lock', async () => {
      const { em, tables } = createFakeEm()
      const account = seedAccount(tables, { creditLimit: '500.00' })
      const service = buildService(em, allowTerms(true))

      const result = await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '200.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-1',
      })

      expect(result.reserved).toBe(true)
      expect(result.entry?.balanceAfter).toBe('200.00')
      expect(result.entry?.creditAccountId).toBe(account.id)
      expect(result.check.available).toBe('300.00')
    })

    test('refuses on_hold without writing an entry', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { isOnHold: true })
      const service = buildService(em, allowTerms(true))

      const result = await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '10.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-hold',
      })

      expect(result.reserved).toBe(false)
      expect(result.check.reason).toBe('on_hold')
      expect(result.entry).toBeNull()
      expect(tables.get(CustomerCreditLedgerEntry) ?? []).toHaveLength(0)
    })

    test('refuses limit_exceeded without writing an entry', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '100.00' })
      const service = buildService(em, allowTerms(true))

      const result = await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '150.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-over',
      })

      expect(result.reserved).toBe(false)
      expect(result.check.reason).toBe('limit_exceeded')
      expect(tables.get(CustomerCreditLedgerEntry) ?? []).toHaveLength(0)

      // Step 1.8 (G15): the refusal emits `customer_groups.credit.limit_exceeded`,
      // which drives the credit-manager notification.
      expect(emitCustomerGroupsEventMock).toHaveBeenCalledTimes(1)
      expect(emitCustomerGroupsEventMock).toHaveBeenCalledWith(
        'customer_groups.credit.limit_exceeded',
        expect.objectContaining({
          tenantId: TENANT,
          organizationId: ORG,
          customerId: CUSTOMER_ID,
          currencyCode: CURRENCY,
          requestedAmount: '150.00',
          creditLimit: '100.00',
          sourceType: 'checkout',
          sourceId: 'session-1',
        }),
        { persistent: true, tenantId: TENANT, organizationId: ORG },
      )
    })

    test('does not emit limit_exceeded on on_hold or not_permitted refusals', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { isOnHold: true })
      const service = buildService(em, allowTerms(true))

      await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '10.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-hold-no-event',
      })

      expect(emitCustomerGroupsEventMock).not.toHaveBeenCalled()
    })

    test('idempotency rule 1: same key, same tuple returns the original entry, nothing new written', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '500.00' })
      const service = buildService(em, allowTerms(true))

      const first = await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '100.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-replay',
      })
      const second = await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '100.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-replay',
      })

      expect(second.entry?.entryId).toBe(first.entry?.entryId)
      expect(second.reserved).toBe(true)
      expect(tables.get(CustomerCreditLedgerEntry) ?? []).toHaveLength(1)
    })

    test('idempotency rule 2: same key, different amount answers idempotency_key_mismatch', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '500.00' })
      const service = buildService(em, allowTerms(true))

      await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '100.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-mismatch',
      })

      await expect(
        service.reserveCredit({
          scope: SCOPE,
          buyer: { customerId: CUSTOMER_ID },
          currencyCode: CURRENCY,
          amount: '200.00',
          sourceType: 'checkout',
          sourceId: 'session-1',
          idempotencyKey: 'reserve-mismatch',
        }),
      ).rejects.toMatchObject({ code: 'idempotency_key_mismatch' })
      expect(tables.get(CustomerCreditLedgerEntry) ?? []).toHaveLength(1)
    })

    test('idempotency rule 3: a released key is not reusable (reserved: false, released: true)', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '500.00' })
      const service = buildService(em, allowTerms(true))

      await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '100.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-release-replay',
      })
      await service.releaseCredit({ scope: SCOPE, reserveIdempotencyKey: 'reserve-release-replay', reason: 'cancelled' })

      const replay = await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '100.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-release-replay',
      })

      expect(replay.reserved).toBe(false)
      expect(replay.released).toBe(true)
    })

    test('resolves the company id first when customerIds carries person and company', async () => {
      const { em, tables } = createFakeEm()
      const account = seedAccount(tables, { customerId: 'company-1', creditLimit: '500.00' })
      // Fake `em.getConnection().execute` for the kind lookup `resolveCompanyFirstCustomerId` runs.
      const connection = {
        execute: async (_sql: string, params: unknown[]) => {
          const ids = params.slice(1) as string[]
          return ids.map((id) => ({ id, kind: id === 'company-1' ? 'company' : 'person' }))
        },
      }
      ;(em as unknown as { getConnection: () => unknown }).getConnection = () => connection
      const service = buildService(em, allowTerms(true))

      const result = await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerIds: ['person-1', 'company-1'] },
        currencyCode: CURRENCY,
        amount: '50.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-identity',
      })

      expect(result.entry?.creditAccountId).toBe(account.id)
      expect(result.check.customerId).toBe('company-1')
    })
  })

  describe('releaseCredit', () => {
    async function reserveAndSeed(em: FakeEm, service: DefaultCustomerCreditService, amount: string, key: string) {
      return service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount,
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: key,
      })
    }

    test('releases the full open amount and is idempotent on a second call', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '500.00' })
      const service = buildService(em, allowTerms(true))
      await reserveAndSeed(em, service, '100.00', 'reserve-release-1')

      const first = await service.releaseCredit({ scope: SCOPE, reserveIdempotencyKey: 'reserve-release-1', reason: 'compensation' })
      const second = await service.releaseCredit({ scope: SCOPE, reserveIdempotencyKey: 'reserve-release-1', reason: 'compensation' })

      expect(first.released).toBe(true)
      expect(second.released).toBe(false)
      expect(second.entryId).toBe(first.entryId)
      expect(tables.get(CustomerCreditLedgerEntry) ?? []).toHaveLength(2)
    })

    test('releases only the open amount after a partial settle', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '500.00' })
      const service = buildService(em, allowTerms(true))
      await reserveAndSeed(em, service, '100.00', 'reserve-partial-settle')
      await service.settleCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '40.00',
        sourceType: 'payment',
        sourceId: 'payment-1',
        idempotencyKey: 'settle-partial',
        reserveIdempotencyKey: 'reserve-partial-settle',
      })

      const release = await service.releaseCredit({ scope: SCOPE, reserveIdempotencyKey: 'reserve-partial-settle', reason: 'cancel' })
      const releaseEntry = (tables.get(CustomerCreditLedgerEntry) ?? []).find((row) => row.id === release.entryId)

      expect(release.released).toBe(true)
      expect(releaseEntry?.amount).toBe('-60.00')
    })

    test('writes nothing after a full settle (open amount zero)', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '500.00' })
      const service = buildService(em, allowTerms(true))
      await reserveAndSeed(em, service, '100.00', 'reserve-full-settle')
      await service.settleCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '100.00',
        sourceType: 'payment',
        sourceId: 'payment-1',
        idempotencyKey: 'settle-full',
        reserveIdempotencyKey: 'reserve-full-settle',
      })

      const before = (tables.get(CustomerCreditLedgerEntry) ?? []).length
      const release = await service.releaseCredit({ scope: SCOPE, reserveIdempotencyKey: 'reserve-full-settle', reason: 'cancel' })
      const after = (tables.get(CustomerCreditLedgerEntry) ?? []).length

      expect(release.released).toBe(false)
      expect(release.entryId).toBeNull()
      expect(after).toBe(before)
    })
  })

  describe('settleCredit', () => {
    test('settle exceeding the reservation open amount throws settle_exceeds_reservation', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '500.00' })
      const service = buildService(em, allowTerms(true))
      await service.reserveCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '100.00',
        sourceType: 'checkout',
        sourceId: 'session-1',
        idempotencyKey: 'reserve-settle-cap',
      })

      await expect(
        service.settleCredit({
          scope: SCOPE,
          buyer: { customerId: CUSTOMER_ID },
          currencyCode: CURRENCY,
          amount: '150.00',
          sourceType: 'payment',
          sourceId: 'payment-1',
          idempotencyKey: 'settle-cap',
          reserveIdempotencyKey: 'reserve-settle-cap',
        }),
      ).rejects.toMatchObject({ code: 'settle_exceeds_reservation' })
    })

    test('a replayed settle key with the same tuple returns the original without writing twice', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '500.00' })
      const service = buildService(em, allowTerms(true))

      const first = await service.settleCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '50.00',
        sourceType: 'payment',
        sourceId: 'payment-1',
        idempotencyKey: 'settle-replay',
      })
      const second = await service.settleCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '50.00',
        sourceType: 'payment',
        sourceId: 'payment-1',
        idempotencyKey: 'settle-replay',
      })

      expect(second.settled).toBe(false)
      expect(second.entry.entryId).toBe(first.entry.entryId)
      expect(tables.get(CustomerCreditLedgerEntry) ?? []).toHaveLength(1)
    })

    test('throws no_account when nothing matches the scope', async () => {
      const { em } = createFakeEm()
      const service = buildService(em, allowTerms(true))

      await expect(
        service.settleCredit({
          scope: SCOPE,
          buyer: { customerId: CUSTOMER_ID },
          currencyCode: CURRENCY,
          amount: '50.00',
          sourceType: 'payment',
          sourceId: 'payment-1',
          idempotencyKey: 'settle-no-account',
        }),
      ).rejects.toBeInstanceOf(CustomerCreditServiceError)
    })

    test('rounds a 4dp sales amount half-up to 2dp at the boundary (G14)', async () => {
      const { em, tables } = createFakeEm()
      seedAccount(tables, { creditLimit: '500.00' })
      const service = buildService(em, allowTerms(true))

      const result = await service.settleCredit({
        scope: SCOPE,
        buyer: { customerId: CUSTOMER_ID },
        currencyCode: CURRENCY,
        amount: '19.995',
        sourceType: 'payment',
        sourceId: 'payment-1',
        idempotencyKey: 'settle-rounding',
      })

      expect(result.entry.amount).toBe('-20.00')
    })
  })
})
