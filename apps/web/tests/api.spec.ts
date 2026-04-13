import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../src/utils/api'

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
})
