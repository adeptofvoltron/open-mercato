jest.mock('@open-mercato/shared/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() }),
}))

import { forbidden } from '@open-mercato/shared/lib/crud/errors'
import { Cart, CartLine } from '../../data/entities'
import { handleCartMergedForProposalRetarget } from '../proposalRetarget'

type Row = Record<string, any>

const TENANT_ID = 'tenant-retarget-1'
const ORG_ID = 'org-retarget-1'
const OLD_TARGET_ID = 'cart-old-target'
const NEW_TARGET_ID = 'cart-new-target'
const AUTHOR_USER_ID = 'rep-user-1'

let seededCarts: Row[] = []
let seededCartLines: Row[] = []

function matchesSimpleWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true
    return row[key] === (value ?? null)
  })
}

function filterRows(rows: Row[], where: Row): Row[] {
  return rows.filter((row) => matchesSimpleWhere(row, where))
}

const mockFindWithDecryption = jest.fn(async (_em: unknown, entity: unknown, where: Row) => {
  if (entity === Cart) return filterRows(seededCarts, where)
  if (entity === CartLine) return filterRows(seededCartLines, where)
  return []
})

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => mockFindWithDecryption(...(args as [unknown, unknown, Row])),
}))

function makeProposalFixture(overrides: Row = {}): Row {
  return {
    id: 'proposal-1',
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    kind: 'proposal',
    proposedToCartId: OLD_TARGET_ID,
    status: 'active',
    expiresAt: new Date(Date.now() + 100_000 * 1000),
    ...overrides,
  }
}

function makeProposalLineFixture(overrides: Row = {}): Row {
  return {
    id: 'proposal-line-1',
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    cartId: 'proposal-1',
    productId: 'product-1',
    variantId: null,
    quantity: '2',
    configuration: null,
    addedByActorType: 'rep',
    addedByActorId: AUTHOR_USER_ID,
    deletedAt: null,
    ...overrides,
  }
}

function makeContainer(opts: { commandBus: { execute: jest.Mock } }) {
  const em = { fork: jest.fn() }
  em.fork = jest.fn().mockReturnValue(em)
  return {
    resolve: (token: string): any => {
      if (token === 'em') return em
      if (token === 'commandBus') return opts.commandBus
      throw new Error(`Unexpected DI token: ${token}`)
    },
  }
}

function makeMergedPayload(overrides: Row = {}): Row {
  return {
    sourceCartId: OLD_TARGET_ID,
    targetCartId: NEW_TARGET_ID,
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    kind: 'basket',
    strategy: 'sum',
    ...overrides,
  }
}

beforeEach(() => {
  seededCarts = [makeProposalFixture()]
  seededCartLines = [makeProposalLineFixture()]
  jest.clearAllMocks()
})

describe('handleCartMergedForProposalRetarget — D-R5-14 re-author / supersede fallback', () => {
  it('re-authors the proposal under the original author identity, then supersedes (rejects) the old proposal', async () => {
    const commandBusExecute = jest.fn(async (id: string, options: { input: unknown; ctx: unknown }) => {
      if (id === 'cart.proposal.create') return { result: { proposalCartId: 'proposal-2' } }
      if (id === 'cart.proposal.reject') return { result: { proposalCartId: 'proposal-1', status: 'abandoned', alreadyResolved: false } }
      throw new Error(`unexpected command ${id}`)
    })
    const container = makeContainer({ commandBus: { execute: commandBusExecute } })

    await handleCartMergedForProposalRetarget(makeMergedPayload(), { resolve: container.resolve, container })

    expect(commandBusExecute).toHaveBeenCalledTimes(2)

    const createCall = commandBusExecute.mock.calls.find(([id]) => id === 'cart.proposal.create')!
    const [, createOptions] = createCall as [string, { input: any; ctx: any }]
    expect(createOptions.input.targetCartId).toBe(NEW_TARGET_ID)
    expect(createOptions.input.lines).toEqual([{ productId: 'product-1', variantId: null, quantity: '2', configuration: null }])
    // Re-authored under the ORIGINAL author's identity via the trusted-context helper, never
    // a request — `ctx.auth.sub` is the stored author id, and this is a "user"-type trusted
    // context, not a bare system actor.
    expect(createOptions.ctx.auth).toEqual(expect.objectContaining({ sub: AUTHOR_USER_ID }))

    const rejectCall = commandBusExecute.mock.calls.find(([id]) => id === 'cart.proposal.reject')!
    const [, rejectOptions] = rejectCall as [string, { input: any; ctx: any }]
    expect(rejectOptions.input).toEqual({
      proposalCartId: 'proposal-1',
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      rejectedBy: 'author',
    })
    // The supersede call itself runs under a bare system actor — no `auth`, trusted by
    // construction — never re-attributed to the author a second time.
    expect(rejectOptions.ctx.auth).toBeNull()
  })

  it('falls back to supersede-only (no re-author) when cart.proposal.create refuses — e.g. the author lost cart.proposals.author', async () => {
    const commandBusExecute = jest.fn(async (id: string) => {
      if (id === 'cart.proposal.create') throw forbidden('[internal] Missing required feature "cart.proposals.author"')
      if (id === 'cart.proposal.reject') return { result: { proposalCartId: 'proposal-1', status: 'abandoned', alreadyResolved: false } }
      throw new Error(`unexpected command ${id}`)
    })
    const container = makeContainer({ commandBus: { execute: commandBusExecute } })

    await handleCartMergedForProposalRetarget(makeMergedPayload(), { resolve: container.resolve, container })

    expect(commandBusExecute).toHaveBeenCalledWith('cart.proposal.create', expect.anything())
    expect(commandBusExecute).toHaveBeenCalledWith('cart.proposal.reject', expect.objectContaining({ input: expect.objectContaining({ proposalCartId: 'proposal-1', rejectedBy: 'author' }) }))
    expect(commandBusExecute).toHaveBeenCalledTimes(2)
  })

  it('falls back to supersede-only without ever attempting re-author when the proposal author is not an eligible actor type', async () => {
    seededCartLines = [makeProposalLineFixture({ addedByActorType: 'system', addedByActorId: null })]
    const commandBusExecute = jest.fn(async (id: string) => {
      if (id === 'cart.proposal.reject') return { result: { proposalCartId: 'proposal-1', status: 'abandoned', alreadyResolved: false } }
      throw new Error(`unexpected command ${id}`)
    })
    const container = makeContainer({ commandBus: { execute: commandBusExecute } })

    await handleCartMergedForProposalRetarget(makeMergedPayload(), { resolve: container.resolve, container })

    expect(commandBusExecute).not.toHaveBeenCalledWith('cart.proposal.create', expect.anything())
    expect(commandBusExecute).toHaveBeenCalledWith('cart.proposal.reject', expect.anything())
    expect(commandBusExecute).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when no pending proposal targets the absorbed cart', async () => {
    seededCarts = []
    const commandBusExecute = jest.fn()
    const container = makeContainer({ commandBus: { execute: commandBusExecute } })

    await handleCartMergedForProposalRetarget(makeMergedPayload(), { resolve: container.resolve, container })

    expect(commandBusExecute).not.toHaveBeenCalled()
  })

  it('ignores a payload missing tenant/organization scope (S3/D-R5-32)', async () => {
    const commandBusExecute = jest.fn()
    const container = makeContainer({ commandBus: { execute: commandBusExecute } })

    await handleCartMergedForProposalRetarget(makeMergedPayload({ tenantId: undefined, organizationId: undefined }), {
      resolve: container.resolve,
      container,
    })

    expect(commandBusExecute).not.toHaveBeenCalled()
  })

  it('processes two sibling proposals targeting the same absorbed cart independently', async () => {
    seededCarts = [makeProposalFixture(), makeProposalFixture({ id: 'proposal-2' })]
    seededCartLines = [
      makeProposalLineFixture({ cartId: 'proposal-1' }),
      makeProposalLineFixture({ id: 'proposal-line-2', cartId: 'proposal-2' }),
    ]
    const commandBusExecute = jest.fn(async (id: string) => {
      if (id === 'cart.proposal.create') return { result: { proposalCartId: 'generated' } }
      if (id === 'cart.proposal.reject') return { result: { proposalCartId: 'generated', status: 'abandoned', alreadyResolved: false } }
      throw new Error(`unexpected command ${id}`)
    })
    const container = makeContainer({ commandBus: { execute: commandBusExecute } })

    await handleCartMergedForProposalRetarget(makeMergedPayload(), { resolve: container.resolve, container })

    const rejectedIds = commandBusExecute.mock.calls
      .filter(([id]) => id === 'cart.proposal.reject')
      .map(([, options]: any) => options.input.proposalCartId)
    expect(new Set(rejectedIds)).toEqual(new Set(['proposal-1', 'proposal-2']))
  })
})
