/** @jest-environment node */

const mockGetAuthFromRequest = jest.fn()
const mockCreateRequestContainer = jest.fn()
const mockCreateJob = jest.fn()

const mockProgressService = {
  createJob: jest.fn((...args: unknown[]) => mockCreateJob(...args)),
}

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn((request: Request) => mockGetAuthFromRequest(request)),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(() => mockCreateRequestContainer()),
}))

type RouteModule = typeof import('../route')
let postHandler: RouteModule['POST']

beforeAll(async () => {
  const routeModule = await import('../route')
  postHandler = routeModule.POST
})

describe('progress jobs create route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthFromRequest.mockResolvedValue({
      sub: 'user-1',
      tenantId: 'tenant-1',
      orgId: 'org-1',
    })
    mockCreateRequestContainer.mockResolvedValue({
      resolve: (token: string) => {
        if (token === 'progressService') return mockProgressService
        throw new Error(`Unexpected token: ${token}`)
      },
    })
    mockCreateJob.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' })
  })

  it('does not leak error message or stack in the 500 response body', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const secretError = new Error('connection to postgres://user:secret@db failed')
    mockCreateJob.mockRejectedValueOnce(secretError)

    const response = await postHandler(new Request('http://localhost/api/progress/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobType: 'bulk_delete', name: 'Bulk delete' }),
    }))

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toEqual({ error: 'Failed to create progress job.' })
    expect(body).not.toHaveProperty('message')
    expect(body).not.toHaveProperty('stack')
    expect(consoleErrorSpy).toHaveBeenCalledWith('[progress.jobs.create] unhandled error', expect.objectContaining({
      message: secretError.message,
      stack: secretError.stack,
    }))

    consoleErrorSpy.mockRestore()
  })

  it('creates a progress job and returns its id', async () => {
    const response = await postHandler(new Request('http://localhost/api/progress/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobType: 'bulk_delete', name: 'Bulk delete' }),
    }))

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ id: '11111111-1111-4111-8111-111111111111' })
    expect(mockCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: 'bulk_delete', name: 'Bulk delete' }),
      expect.objectContaining({ tenantId: 'tenant-1', organizationId: 'org-1', userId: 'user-1' }),
    )
  })
})
