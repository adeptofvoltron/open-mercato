// Release 5 Phase 3 (G21, Step 1.8) — the exposure-audit job recomputes `SUM(amount)`
// per `CustomerCreditAccount` and compares it against the latest ledger entry's
// `balance_after`. Proves the comparison actually catches a genuine divergence (not just
// "no crash"), and that the reused `limit_exceeded` notification fires ONLY when the
// drifting account is also over its limit.

const reportErrorMock = jest.fn()
const createCreditLimitExceededNotificationMock = jest.fn(async () => {})

jest.mock('@open-mercato/shared/lib/telemetry/runtime', () => ({
  getTelemetryRuntime: () => ({ reportError: reportErrorMock }),
}))
jest.mock('../../lib/creditNotifications', () => ({
  createCreditLimitExceededNotification: (...args: unknown[]) => createCreditLimitExceededNotificationMock(...args),
}))

import handle from '../credit-exposure-audit'
import { CustomerCreditAccount, CustomerCreditLedgerEntry } from '../../data/entities'

const TENANT = 'tenant-1'
const ORG = 'org-1'
const ACCOUNT_ID = 'account-1'
const CUSTOMER_ID = 'customer-1'

type Row = Record<string, unknown>

function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key]
    if (condition === null) return value === null || value === undefined
    return value === condition
  })
}

function createFakeEm(tables: Map<Function, Row[]>) {
  const em = {
    find: async (entity: Function, where: Row) => (tables.get(entity) ?? []).filter((row) => matchesWhere(row, where)),
    clear: () => {},
    fork: () => em,
  }
  return em as unknown as import('@mikro-orm/postgresql').EntityManager
}

function buildCtx(em: import('@mikro-orm/postgresql').EntityManager) {
  return { resolve: <T = unknown>(name: string) => (name === 'em' ? (em as unknown as T) : (undefined as T)) }
}

function buildAccount(overrides: Partial<Row> = {}): Row {
  return {
    id: ACCOUNT_ID,
    tenantId: TENANT,
    organizationId: ORG,
    customerId: CUSTOMER_ID,
    currencyCode: 'USD',
    creditLimit: '100.00',
    isOnHold: false,
    deletedAt: null,
    ...overrides,
  }
}

function buildLedger(): Row[] {
  return [
    {
      id: 'entry-1',
      tenantId: TENANT,
      creditAccountId: ACCOUNT_ID,
      entryType: 'reserve',
      amount: '80.00',
      balanceAfter: '80.00',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: 'entry-2',
      tenantId: TENANT,
      creditAccountId: ACCOUNT_ID,
      entryType: 'adjust',
      amount: '10.00',
      // Intentionally wrong: `SUM(amount)` is 80.00 + 10.00 = 90.00, but this entry's own
      // `balance_after` claims 95.00 — the drift this job must catch.
      balanceAfter: '95.00',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    },
  ]
}

describe('customer_groups credit-exposure-audit worker', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('detects a drifting account and reports it without notifying when still under the limit', async () => {
    const tables = new Map<Function, Row[]>([
      [CustomerCreditAccount, [buildAccount({ creditLimit: '100.00' })]],
      [CustomerCreditLedgerEntry, buildLedger()],
    ])
    const em = createFakeEm(tables)

    await handle({ id: 'job-1', payload: { scope: { tenantId: TENANT, organizationId: ORG } }, createdAt: new Date().toISOString() }, buildCtx(em))

    expect(reportErrorMock).toHaveBeenCalledTimes(1)
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        module: 'customer_groups',
        code: 'customer_groups.credit_exposure_drift',
        attributes: expect.objectContaining({ creditAccountId: ACCOUNT_ID }),
      }),
    )
    expect(createCreditLimitExceededNotificationMock).not.toHaveBeenCalled()
  })

  it('reuses the limit_exceeded notification when the drifting exposure is also over the limit', async () => {
    const tables = new Map<Function, Row[]>([
      [CustomerCreditAccount, [buildAccount({ creditLimit: '50.00' })]],
      [CustomerCreditLedgerEntry, buildLedger()],
    ])
    const em = createFakeEm(tables)

    await handle({ id: 'job-2', payload: { scope: { tenantId: TENANT, organizationId: ORG } }, createdAt: new Date().toISOString() }, buildCtx(em))

    expect(reportErrorMock).toHaveBeenCalledTimes(1)
    expect(createCreditLimitExceededNotificationMock).toHaveBeenCalledTimes(1)
    expect(createCreditLimitExceededNotificationMock).toHaveBeenCalledWith(
      em,
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT,
        organizationId: ORG,
        creditAccountId: ACCOUNT_ID,
        customerId: CUSTOMER_ID,
        currencyCode: 'USD',
        requestedAmount: '90.00',
        creditLimit: '50.00',
      }),
    )
  })

  it('reports no drift when SUM(amount) matches the latest balance_after', async () => {
    const tables = new Map<Function, Row[]>([
      [CustomerCreditAccount, [buildAccount({ creditLimit: '100.00' })]],
      [
        CustomerCreditLedgerEntry,
        [
          {
            id: 'entry-1',
            tenantId: TENANT,
            creditAccountId: ACCOUNT_ID,
            entryType: 'reserve',
            amount: '80.00',
            balanceAfter: '80.00',
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      ],
    ])
    const em = createFakeEm(tables)

    await handle({ id: 'job-3', payload: { scope: { tenantId: TENANT, organizationId: ORG } }, createdAt: new Date().toISOString() }, buildCtx(em))

    expect(reportErrorMock).not.toHaveBeenCalled()
    expect(createCreditLimitExceededNotificationMock).not.toHaveBeenCalled()
  })

  it('is a no-op without a scope in the payload', async () => {
    const em = createFakeEm(new Map())
    await expect(handle({ id: 'job-4', payload: {}, createdAt: new Date().toISOString() }, buildCtx(em))).resolves.toBeUndefined()
    expect(reportErrorMock).not.toHaveBeenCalled()
  })
})
