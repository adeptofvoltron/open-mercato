import type {
  PaymentGatewayDescriptorService,
  ResolvedPaymentGatewayDescriptor,
} from '@open-mercato/core/modules/payment_gateways/lib/descriptor-service'
import { tryResolve } from './tryResolve'

// Release 5, Step 2.13 (§5.5). This Step lists ONLY the gateway methods a buyer can pay
// with today — `on_account` and `request_quote` both depend on `customer_groups` terms
// (`allow_purchase_on_account`/`allow_quote_requests`) that are not yet wired into
// checkout (B.5, Step 3.5+); their absence from this response is expected, not a gap.

export type CheckoutPaymentMethod = {
  providerKey: string
  label: string
  kind: 'gateway'
}

function supportsCurrency(descriptor: ResolvedPaymentGatewayDescriptor, currencyCode: string): boolean {
  const supported = descriptor.sessionConfig?.supportedCurrencies
  if (!supported || supported === '*') return true
  return supported.includes(currencyCode)
}

export type PaymentMethodsContainer = { resolve: <T = unknown>(name: string) => T }

/**
 * Storefront/API/agent/POS sessions (no `linkId`) list every configured, currency-
 * compatible gateway descriptor for the tenant — `ecommerce` has no per-store gateway
 * selection yet (a gap, follow-up needed), so this is "every gateway the tenant has
 * configured", not "every gateway this store offers". A link session (B.2, not reachable
 * via the public API until Step 3.5) is restricted to its own single configured
 * `gatewayProviderKey` instead, unchanged from Phase A's own one-provider-per-link model.
 */
export async function listCheckoutPaymentMethods(
  container: PaymentMethodsContainer,
  scope: { tenantId: string; organizationId: string },
  input: { currencyCode: string; linkGatewayProviderKey: string | null },
): Promise<CheckoutPaymentMethod[]> {
  const descriptorService = tryResolve<PaymentGatewayDescriptorService>(container, 'paymentGatewayDescriptorService')
  if (!descriptorService) return []

  const resolved = await descriptorService.listResolved(scope)
  const available = resolved.filter((descriptor) => descriptor.isConfigured && supportsCurrency(descriptor, input.currencyCode))

  const scoped = input.linkGatewayProviderKey
    ? available.filter((descriptor) => descriptor.providerKey === input.linkGatewayProviderKey)
    : available

  return scoped.map((descriptor) => ({ providerKey: descriptor.providerKey, label: descriptor.label, kind: 'gateway' as const }))
}
