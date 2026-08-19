import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, authHeaders, clearStoredAuthState } from '../src/utils/api'

describe('apiFetch', () => {
  const store: Record<string, string> = {}
  const localStorageMock = {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
  }

  const originalLocalStorage = globalThis.localStorage as Storage | undefined

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { localStorage: typeof localStorageMock }).localStorage = localStorageMock
    Object.keys(store).forEach((key) => delete store[key])
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (originalLocalStorage) {
      ;(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = originalLocalStorage
    }
  })

  it('omitHeaders deletes globally injected headers AFTER auth headers apply (SR-1 self-service mechanic, #5012)', async () => {
    store.tenantId = 'tenant_42'
    store.auth_token = 'token-abc'

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' })
    vi.stubGlobal('fetch', fetchMock)

    // POSITIVE CONTROL: without omitHeaders the hint IS sent — proves the omit case
    // below discriminates rather than passing against a hint that was never there.
    await apiFetch('/api/attendance/rules/me', { suppressUnauthorizedRedirect: true })
    const controlHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(controlHeaders.get('x-tenant-id')).toBe('tenant_42')

    await apiFetch('/api/attendance/rules/me', {
      suppressUnauthorizedRedirect: true,
      omitHeaders: ['x-tenant-id'],
    })
    const omittedHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers
    expect(omittedHeaders.has('x-tenant-id')).toBe(false)
    // Non-subject headers survive the omit.
    expect(omittedHeaders.get('authorization')).toBe('Bearer token-abc')
  })

  it('forwards the stored tenant hint through auth headers', async () => {
    store.tenantId = 'tenant_42'

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    })
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.com', password: 'secret' }),
      suppressUnauthorizedRedirect: true,
    })

    const requestHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(requestHeaders.get('x-tenant-id')).toBe('tenant_42')
  })

  it('clears tenant hints together with auth state', () => {
    store.auth_token = 'jwt-token'
    store.tenantId = 'tenant_42'
    store.workspaceId = 'tenant_42'

    clearStoredAuthState()

    expect(store.auth_token).toBeUndefined()
    expect(store.tenantId).toBeUndefined()
    expect(store.workspaceId).toBeUndefined()
    expect(authHeaders()['x-tenant-id']).toBeUndefined()
  })
})
