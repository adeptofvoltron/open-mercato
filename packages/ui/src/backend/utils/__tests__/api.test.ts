/**
 * @jest-environment jsdom
 */
jest.mock('../../FlashMessages', () => ({
  flash: jest.fn(),
}))

import { flash } from '../../FlashMessages'
import {
  ForbiddenError,
  UnauthorizedError,
  apiFetch,
  _resetAuthRedirectConfig,
  setAuthRedirectConfig,
} from '../../utils/api'

function createMockResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  const serializedBody =
    typeof body === 'string' ? body : JSON.stringify(body ?? {})
  const headerMap = new Map<string, string>(
    Object.entries(headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  )
  const build = () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (key: string) => headerMap.get(key.toLowerCase()) ?? null,
      },
      json: async () => JSON.parse(serializedBody),
      text: async () => serializedBody,
      clone: () => build(),
    }) as Response
  return build()
}

describe('apiFetch', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.useFakeTimers()
    window.history.pushState({}, '', '/backend/sales/documents')
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = undefined
    _resetAuthRedirectConfig()
  })

  afterEach(() => {
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = undefined
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
    _resetAuthRedirectConfig()
  })

  it('throws ForbiddenError when backend returns ACL hints', async () => {
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () =>
      createMockResponse(403, {
        error: 'Forbidden',
        requiredRoles: ['Admin'],
      }),
    )

    await expect(apiFetch('/api/private')).rejects.toBeInstanceOf(ForbiddenError)
    expect(flash).toHaveBeenCalledWith(
      'Insufficient permissions. Redirecting to login…',
      'warning',
    )
  })

  it('throws ForbiddenError when ACL hints are missing', async () => {
    const response = createMockResponse(403, {
      error: 'Forbidden',
      message: 'Access denied without ACL hints',
    })
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () => response)

    await expect(apiFetch('/api/private')).rejects.toBeInstanceOf(ForbiddenError)
    expect(flash).not.toHaveBeenCalled()
  })

  it('does not redirect on login page and returns 403 payload', async () => {
    window.history.pushState({}, '', '/login')
    const response = createMockResponse(403, {
      error: 'Forbidden',
      requiredRoles: ['Admin'],
    })
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () => response)

    const result = await apiFetch('/api/private')
    expect(result).toBe(response)
    expect(flash).not.toHaveBeenCalled()
  })

  it('returns 401 payload when unauthorized redirect is disabled', async () => {
    const response = createMockResponse(401, {
      error: 'checkout.payPage.errors.password',
    })
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () => response)

    const result = await apiFetch('/api/private', {
      headers: {
        'x-om-unauthorized-redirect': '0',
      },
    })

    expect(result).toBe(response)
    expect(flash).not.toHaveBeenCalled()
  })

  it('throws UnauthorizedError for 401 responses by default', async () => {
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () =>
      createMockResponse(401, { error: 'Unauthorized' }),
    )

    await expect(apiFetch('/api/private')).rejects.toBeInstanceOf(UnauthorizedError)
    expect(flash).toHaveBeenCalledWith(
      'Session expired. Redirecting to sign in…',
      'warning',
    )
  })

  it('returns 401 response without redirect when RegExp portal pattern is registered', async () => {
    setAuthRedirectConfig({ skipAuthRedirectPatterns: [/\/[^/]+\/portal(\/|$)/] })
    window.history.pushState({}, '', '/acme/portal/dashboard')
    const response = createMockResponse(401, { error: 'Unauthorized' })
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () => response)

    const result = await apiFetch('/api/customer_accounts/portal/nav')
    expect(result).toBe(response)
    expect(flash).not.toHaveBeenCalled()
  })

  it('throws UnauthorizedError for portal 401 when no pattern is registered', async () => {
    window.history.pushState({}, '', '/acme/portal/dashboard')
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () =>
      createMockResponse(401, { error: 'Unauthorized' }),
    )

    await expect(apiFetch('/api/customer_accounts/portal/nav')).rejects.toBeInstanceOf(UnauthorizedError)
    expect(flash).toHaveBeenCalledWith(
      'Session expired. Redirecting to sign in…',
      'warning',
    )
  })

  it('still throws UnauthorizedError for backoffice 401 after portal pattern is registered', async () => {
    setAuthRedirectConfig({ skipAuthRedirectPatterns: [/\/[^/]+\/portal(\/|$)/] })
    window.history.pushState({}, '', '/backend/sales')
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () =>
      createMockResponse(401, { error: 'Unauthorized' }),
    )

    await expect(apiFetch('/api/sales')).rejects.toBeInstanceOf(UnauthorizedError)
    expect(flash).toHaveBeenCalledWith(
      'Session expired. Redirecting to sign in…',
      'warning',
    )
  })

  it('returns 401 response without redirect when string pattern matches via startsWith', async () => {
    setAuthRedirectConfig({ skipAuthRedirectPatterns: ['/acme/portal'] })
    window.history.pushState({}, '', '/acme/portal/dashboard')
    const response = createMockResponse(401, { error: 'Unauthorized' })
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () => response)

    const result = await apiFetch('/api/customer_accounts/portal/nav')
    expect(result).toBe(response)
    expect(flash).not.toHaveBeenCalled()
  })

  it('accumulates patterns across two setAuthRedirectConfig calls (append semantics)', async () => {
    setAuthRedirectConfig({ skipAuthRedirectPatterns: ['/acme/portal'] })
    setAuthRedirectConfig({ skipAuthRedirectPatterns: ['/partner/portal'] })

    window.history.pushState({}, '', '/acme/portal/orders')
    const responseA = createMockResponse(401, { error: 'Unauthorized' })
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () => responseA)
    const resultA = await apiFetch('/api/orders')
    expect(resultA).toBe(responseA)

    window.history.pushState({}, '', '/partner/portal/orders')
    const responseB = createMockResponse(401, { error: 'Unauthorized' })
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () => responseB)
    const resultB = await apiFetch('/api/orders')
    expect(resultB).toBe(responseB)

    expect(flash).not.toHaveBeenCalled()
  })

  it('returns 403 response without flash or redirect when portal pattern is registered', async () => {
    setAuthRedirectConfig({ skipAuthRedirectPatterns: [/\/[^/]+\/portal(\/|$)/] })
    window.history.pushState({}, '', '/acme/portal/dashboard')
    const response = createMockResponse(403, {
      error: 'Forbidden',
      requiredFeatures: ['portal.orders.view'],
    })
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () => response)

    const result = await apiFetch('/api/customer_accounts/portal/nav')
    expect(result).toBe(response)
    expect(flash).not.toHaveBeenCalled()
  })
})
