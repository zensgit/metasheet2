import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAuth } from '../src/composables/useAuth'

describe('useAuth', () => {
  const store: Record<string, string> = {}
  const ls = {
    getItem: vi.fn((k: string) => store[k] ?? null),
    setItem: vi.fn((k: string, v: string) => (store[k] = v)),
    removeItem: vi.fn((k: string) => delete store[k])
  }

  const original = globalThis.localStorage as any

  beforeEach(() => {
    ;(globalThis as any).localStorage = ls
    Object.keys(store).forEach((k) => delete store[k])
    vi.clearAllMocks()
  })

  afterEach(() => {
    ;(globalThis as any).localStorage = original
  })

  it('builds headers with Bearer when jwt exists', () => {
    ls.setItem('jwt', 'abc')
    const { buildAuthHeaders } = useAuth()
    const h = buildAuthHeaders()
    expect(h.Authorization).toBe('Bearer abc')
    expect(h['x-user-id']).toBeUndefined()
  })

  it('falls back to x-user-id when no token', () => {
    const { buildAuthHeaders } = useAuth()
    const h = buildAuthHeaders()
    expect(h.Authorization).toBeUndefined()
    expect(h['x-user-id']).toBe('dev-user')
  })

  it('persists auth_token and jwt when setToken is called', () => {
    const { setToken, getToken } = useAuth()
    setToken('persisted-token')

    expect(store.auth_token).toBe('persisted-token')
    expect(store.jwt).toBe('persisted-token')
    expect(getToken()).toBe('persisted-token')
  })

  it('clears all supported token aliases', () => {
    store.auth_token = 'auth-token'
    store.jwt = 'jwt-token'
    store.devToken = 'dev-token'

    const { clearToken, getToken } = useAuth()
    clearToken()

    expect(store.auth_token).toBeUndefined()
    expect(store.jwt).toBeUndefined()
    expect(store.devToken).toBeUndefined()
    expect(getToken()).toBeNull()
  })

  it('refreshes dev token and stores aliases', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'dev-jwt-token' }),
    }))

    const { refreshDevToken, getToken } = useAuth()
    await expect(refreshDevToken()).resolves.toBe('dev-jwt-token')

    expect(store.auth_token).toBe('dev-jwt-token')
    expect(store.jwt).toBe('dev-jwt-token')
    expect(store.devToken).toBe('dev-jwt-token')
    expect(getToken()).toBe('dev-jwt-token')
  })
})
