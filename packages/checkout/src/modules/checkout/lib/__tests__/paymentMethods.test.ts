import { listCheckoutPaymentMethods } from '../paymentMethods'

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    providerKey: 'stripe',
    label: 'Stripe',
    isConfigured: true,
    requiresConfiguration: true,
    configurationStatus: 'configured',
    sessionConfig: { supportedCurrencies: '*' },
    ...overrides,
  }
}

function makeContainer(descriptorService: unknown) {
  return {
    resolve: (name: string) => {
      if (name === 'paymentGatewayDescriptorService') {
        if (!descriptorService) throw new Error('paymentGatewayDescriptorService is not registered')
        return descriptorService
      }
      throw new Error(`Unexpected DI token: ${name}`)
    },
  }
}

const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' }

describe('listCheckoutPaymentMethods (§5.5, B.3 gateway half only)', () => {
  it('returns an empty list — never throws — when payment_gateways is absent (C10/D-R5-18)', async () => {
    const container = makeContainer(null)

    const result = await listCheckoutPaymentMethods(container, SCOPE, { currencyCode: 'USD', linkGatewayProviderKey: null })

    expect(result).toEqual([])
  })

  it('lists every configured descriptor supporting the session currency for a non-link session', async () => {
    const listResolved = jest.fn().mockResolvedValue([
      descriptor({ providerKey: 'stripe', sessionConfig: { supportedCurrencies: ['USD', 'EUR'] } }),
      descriptor({ providerKey: 'paypal', sessionConfig: { supportedCurrencies: ['GBP'] } }),
      descriptor({ providerKey: 'unconfigured', isConfigured: false }),
    ])
    const container = makeContainer({ listResolved })

    const result = await listCheckoutPaymentMethods(container, SCOPE, { currencyCode: 'USD', linkGatewayProviderKey: null })

    expect(result).toEqual([{ providerKey: 'stripe', label: 'Stripe', kind: 'gateway' }])
    expect(listResolved).toHaveBeenCalledWith(SCOPE)
  })

  it('restricts to the link\'s own single configured provider for a link session', async () => {
    const listResolved = jest.fn().mockResolvedValue([
      descriptor({ providerKey: 'stripe', label: 'Stripe' }),
      descriptor({ providerKey: 'paypal', label: 'PayPal' }),
    ])
    const container = makeContainer({ listResolved })

    const result = await listCheckoutPaymentMethods(container, SCOPE, { currencyCode: 'USD', linkGatewayProviderKey: 'paypal' })

    expect(result).toEqual([{ providerKey: 'paypal', label: 'PayPal', kind: 'gateway' }])
  })

  it('treats a currency not in the descriptor\'s supported list as unavailable', async () => {
    const listResolved = jest.fn().mockResolvedValue([
      descriptor({ providerKey: 'stripe', sessionConfig: { supportedCurrencies: ['EUR'] } }),
    ])
    const container = makeContainer({ listResolved })

    const result = await listCheckoutPaymentMethods(container, SCOPE, { currencyCode: 'USD', linkGatewayProviderKey: null })

    expect(result).toEqual([])
  })
})
