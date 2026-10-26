import { asValue, createContainer, InjectionMode } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { register } from '../di'

describe('customer_groups DI wiring', () => {
  test('registers customerGroupsService with a resolveGroups method', () => {
    const container = createContainer<Record<string, unknown>>({ injectionMode: InjectionMode.CLASSIC }) as unknown as AppContainer
    container.register({
      em: asValue({} as EntityManager),
    })

    register(container)

    const customerGroupsService = container.resolve<{ resolveGroups: unknown }>('customerGroupsService')

    expect(typeof customerGroupsService.resolveGroups).toBe('function')
  })

  test('registers customerCreditService with its own methods, not grown onto customerGroupsService (G26)', () => {
    const container = createContainer<Record<string, unknown>>({ injectionMode: InjectionMode.CLASSIC }) as unknown as AppContainer
    container.register({
      em: asValue({} as EntityManager),
    })

    register(container)

    const customerCreditService = container.resolve<{
      checkCredit: unknown
      reserveCredit: unknown
      releaseCredit: unknown
      settleCredit: unknown
    }>('customerCreditService')
    const customerGroupsService = container.resolve<Record<string, unknown>>('customerGroupsService')

    expect(typeof customerCreditService.checkCredit).toBe('function')
    expect(typeof customerCreditService.reserveCredit).toBe('function')
    expect(typeof customerCreditService.releaseCredit).toBe('function')
    expect(typeof customerCreditService.settleCredit).toBe('function')
    expect(customerGroupsService.checkCredit).toBeUndefined()
    expect(customerGroupsService.reserveCredit).toBeUndefined()
  })
})
