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
  const originalLocation = window.location
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    ;(globalThis as any).localStorage = ls
    Object.keys(store).forEach((k) => delete store[k])
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://app.example.com' },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    ;(globalThis as any).localStorage = original
    globalThis.fetch = originalFetch
    vi.unstubAllEnvs()
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
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

  it('persists and clears DingTalk external auth context', () => {
    const auth = useAuth()
    const context = {
      provider: 'dingtalk' as const,
      mode: 'login' as const,
      redirect: '/settings',
      state: 'state-123',
      createdAt: Date.now(),
    }

    auth.setExternalAuthContext(context)
    expect(auth.getExternalAuthContext()).toEqual(context)

    auth.clearExternalAuthContext()
    expect(auth.getExternalAuthContext()).toBeNull()
  })

  it('expires stale DingTalk external auth context on read', () => {
    const auth = useAuth()
    auth.setExternalAuthContext({
      provider: 'dingtalk',
      mode: 'login',
      redirect: '/settings',
      state: 'state-123',
      createdAt: Date.now() - (16 * 60 * 1000),
    })

    expect(auth.getExternalAuthContext()).toBeNull()
    expect(ls.removeItem).toHaveBeenCalledWith('metasheet_external_auth_context')
  })

  it('clears DingTalk external auth context when token is cleared', () => {
    const auth = useAuth()
    ls.setItem('auth_token', 'session-token')
    ls.setItem('jwt', 'session-token')
    ls.setItem('devToken', 'session-token')
    ls.setItem('metasheet_features', '{"attendance":true}')
    ls.setItem('metasheet_product_mode', 'attendance')
    ls.setItem('user_permissions', '["attendance:admin"]')
    ls.setItem('user_roles', '["admin"]')
    auth.setExternalAuthContext({
      provider: 'dingtalk',
      mode: 'bind',
      redirect: '/settings',
      state: null,
      createdAt: Date.now(),
    })

    auth.clearToken()
    expect(auth.getExternalAuthContext()).toBeNull()
    expect(store.auth_token).toBeUndefined()
    expect(store.jwt).toBeUndefined()
    expect(store.devToken).toBeUndefined()
    expect(store.metasheet_features).toBeUndefined()
    expect(store.metasheet_product_mode).toBeUndefined()
    expect(store.user_permissions).toBeUndefined()
    expect(store.user_roles).toBeUndefined()
  })

  it('uses window origin instead of loopback API env during session bootstrap', async () => {
    vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:7778')
    ls.setItem('auth_token', 'token-123')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: {
          user: {
            id: 'user-1',
            email: 'zen0888@live.com',
            name: 'Administrator',
            role: 'admin',
            permissions: ['attendance:admin'],
          },
          features: {
            attendance: true,
            workflow: false,
            attendanceAdmin: true,
            attendanceImport: true,
            mode: 'attendance',
          },
        },
      }),
    }) as unknown as typeof fetch

    const auth = useAuth()
    const result = await auth.bootstrapSession()

    expect(result.ok).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://app.example.com/api/auth/me',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
        }),
      }),
    )
  })
})
