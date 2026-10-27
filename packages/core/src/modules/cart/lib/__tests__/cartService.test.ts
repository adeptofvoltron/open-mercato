const mockGetCartSalesSnapshot = jest.fn(async () => ({ lines: [], adjustments: [], totals: {}, currencyCode: 'USD', updatedAt: new Date() }))
jest.mock('../toSalesSnapshots', () => ({
  getCartSalesSnapshot: (...args: unknown[]) => mockGetCartSalesSnapshot(...args),
}))

const mockResolveCartRouteContext = jest.fn()
class FakeCartStoreContextUnavailableError extends Error {}
jest.mock('../routeContext', () => ({
  resolveCartRouteContext: (...args: unknown[]) => mockResolveCartRouteContext(...args),
  isCartStoreContextUnavailableError: (err: unknown) => err instanceof FakeCartStoreContextUnavailableError,
}))

import { CartServiceImpl } from '../cartService'

function makeContainer(overrides: Record<string, unknown> = {}) {
  const commandBus = { execute: jest.fn(async () => ({ result: { cart: { status: 'locked' }, priceChanges: [], extended: false } })) }
  const registrations: Record<string, unknown> = {
    em: { fork: () => ({}) },
    commandBus,
    ...overrides,
  }
  return {
    commandBus,
    container: { resolve: (name: string) => registrations[name] },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('CartServiceImpl.getSalesSnapshot (C7)', () => {
  it('forks a fresh em and delegates to getCartSalesSnapshot', async () => {
    const { container } = makeContainer()
    const service = new CartServiceImpl(container)

    await service.getSalesSnapshot({ cartId: 'cart-1', tenantId: 'tenant-1', organizationId: 'org-1', checkoutSessionId: 'session-1' })

    expect(mockGetCartSalesSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      { cartId: 'cart-1', tenantId: 'tenant-1', organizationId: 'org-1', checkoutSessionId: 'session-1' },
    )
  })
})

describe('CartServiceImpl.lock — request-based routeContext resolution (C2)', () => {
  it('resolves a fresh routeContext from the request and forwards it to cart.lock when the caller supplies neither', async () => {
    const resolved = { tenantId: 't', organizationId: 'o', storeId: 's', channel: 'storefront' as const }
    mockResolveCartRouteContext.mockResolvedValue(resolved)
    const { container, commandBus } = makeContainer()
    const service = new CartServiceImpl(container)
    const request = new Request('https://example.com')

    await service.lock({ cartId: 'cart-1', tenantId: 'tenant-1', organizationId: 'org-1', checkoutSessionId: 'session-1', request })

    expect(mockResolveCartRouteContext).toHaveBeenCalledWith(request, expect.anything(), { fresh: true })
    const call = (commandBus.execute as jest.Mock).mock.calls[0]
    expect(call[0]).toBe('cart.lock')
    expect(call[1].input.routeContext).toBe(resolved)
    expect(call[1].input.request).toBeUndefined()
  })

  it('leaves routeContext undefined when no request is supplied', async () => {
    const { container, commandBus } = makeContainer()
    const service = new CartServiceImpl(container)

    await service.lock({ cartId: 'cart-1', tenantId: 'tenant-1', organizationId: 'org-1', checkoutSessionId: 'session-1' })

    expect(mockResolveCartRouteContext).not.toHaveBeenCalled()
    const call = (commandBus.execute as jest.Mock).mock.calls[0]
    expect(call[1].input.routeContext).toBeUndefined()
  })

  it('degrades to no routeContext when ecommerce is unavailable (never throws)', async () => {
    mockResolveCartRouteContext.mockRejectedValue(new FakeCartStoreContextUnavailableError('no ecommerce'))
    const { container, commandBus } = makeContainer()
    const service = new CartServiceImpl(container)

    await service.lock({
      cartId: 'cart-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      checkoutSessionId: 'session-1',
      request: new Request('https://example.com'),
    })

    const call = (commandBus.execute as jest.Mock).mock.calls[0]
    expect(call[1].input.routeContext).toBeUndefined()
  })

  it('does not call resolveCartRouteContext when the caller already supplies a routeContext', async () => {
    const { container, commandBus } = makeContainer()
    const service = new CartServiceImpl(container)
    const routeContext = { tenantId: 't', organizationId: 'o', storeId: 's', channel: 'storefront' as const }

    await service.lock({
      cartId: 'cart-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      checkoutSessionId: 'session-1',
      routeContext: routeContext as any,
      request: new Request('https://example.com'),
    })

    expect(mockResolveCartRouteContext).not.toHaveBeenCalled()
    const call = (commandBus.execute as jest.Mock).mock.calls[0]
    expect(call[1].input.routeContext).toBe(routeContext)
  })
})
