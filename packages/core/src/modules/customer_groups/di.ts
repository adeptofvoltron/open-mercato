import { asFunction, asValue } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createCustomerGroupsService } from './services/customerGroupsService'
import { createCustomerCreditService } from './services/customerCreditService'
import { CustomerGroup, CustomerGroupMembership } from './data/entities'

type AppCradle = AppContainer['cradle'] & {
  em: EntityManager
}

export function register(container: AppContainer) {
  container.register({
    // `em` is registered per request (`createRequestContainer()` in
    // packages/shared/src/lib/di/container.ts forks a fresh EntityManager and
    // builds a brand-new Awilix container for every request), so `.singleton()`
    // here resolves to "one instance per request container", not one instance for
    // the process — same pattern as `warrantyClaimNumberGenerator` in
    // `warranty_claims/di.ts`.
    customerGroupsService: asFunction(({ em }: AppCradle) => createCustomerGroupsService(em))
      .singleton()
      .proxy(),
    // Release 5 Phase 3 (G26): its own DI key and interface, registered beside
    // `customerGroupsService` rather than added to it — see `services/customerCreditService.ts`.
    customerCreditService: asFunction(({ em }: AppCradle) => createCustomerCreditService(em))
      .singleton()
      .proxy(),
    CustomerGroup: asValue(CustomerGroup),
    CustomerGroupMembership: asValue(CustomerGroupMembership),
  })
}
