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
    useAuth().clearToken()
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
    store.tenantId = 'tenant_42'
    store.workspaceId = 'tenant_42'

    const { clearToken, getToken } = useAuth()
    clearToken()

    expect(store.auth_token).toBeUndefined()
    expect(store.jwt).toBeUndefined()
    expect(store.devToken).toBeUndefined()
    expect(store.tenantId).toBeUndefined()
    expect(store.workspaceId).toBeUndefined()
    expect(getToken()).toBeNull()
  })

  it('refreshes dev token and stores aliases', async () => {
    store.tenantId = 'tenant_42'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'dev-jwt-token' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { refreshDevToken, getToken, buildAuthHeaders } = useAuth()
    await expect(refreshDevToken()).resolves.toBe('dev-jwt-token')

    expect(store.auth_token).toBe('dev-jwt-token')
    expect(store.jwt).toBe('dev-jwt-token')
    expect(store.devToken).toBe('dev-jwt-token')
    expect(store.tenantId).toBe('tenant_42')
    expect(store.workspaceId).toBe('tenant_42')
    expect(getToken()).toBe('dev-jwt-token')
    expect(buildAuthHeaders()['x-tenant-id']).toBe('tenant_42')
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('tenantId=tenant_42'))
  })

  it('derives admin access from token payload and stored permissions', () => {
    const payload = {
      email: 'admin@example.com',
      role: 'admin',
      perms: ['roles:write'],
    }
    const token = `header.${btoa(JSON.stringify(payload))}.sig`
    store.jwt = token
    store.user_permissions = JSON.stringify(['permissions:write'])
    store.user_roles = JSON.stringify(['admin'])

    const { getAccessSnapshot, hasAdminAccess } = useAuth()
    const snapshot = getAccessSnapshot()

    expect(snapshot.email).toBe('admin@example.com')
    expect(snapshot.roles).toContain('admin')
    expect(snapshot.permissions).toContain('permissions:write')
    expect(hasAdminAccess()).toBe(true)
  })

  it('matches integration permissions with backend-compatible hierarchy', () => {
    store.user_permissions = JSON.stringify(['integration:write'])
    const { hasPermission } = useAuth()

    expect(hasPermission('integration:read')).toBe(true)
    expect(hasPermission('integration:write')).toBe(true)
    expect(hasPermission('integration:admin')).toBe(false)
    expect(hasPermission('attendance:read')).toBe(false)
  })

  it('allows resource admin and role admin permissions through the shared helper', () => {
    store.user_permissions = JSON.stringify(['integration:admin'])
    const { hasPermission, clearStoredUserSnapshot } = useAuth()

    expect(hasPermission('integration:read')).toBe(true)
    expect(hasPermission('integration:write')).toBe(true)
    expect(hasPermission('integration:admin')).toBe(true)

    clearStoredUserSnapshot()
    store.user_roles = JSON.stringify(['admin'])

    expect(hasPermission('integration:write')).toBe(true)
  })

  it('bootstraps session only once for the same token and reuses the cached payload', async () => {
    store.jwt = 'stable-token'
    store.tenantId = 'tenant_42'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          user: {
            email: 'alpha@example.com',
            role: 'admin',
            permissions: ['users:write'],
          },
          features: {
            attendance: true,
            workflow: false,
            attendanceAdmin: true,
            attendanceImport: false,
            mode: 'attendance',
          },
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { bootstrapSession, getAccessSnapshot } = useAuth()
    const first = await bootstrapSession()
    const second = await bootstrapSession()

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer stable-token',
        'x-tenant-id': 'tenant_42',
      }),
    })
    expect(getAccessSnapshot().roles).toContain('admin')
    expect(getAccessSnapshot().permissions).toContain('users:write')
    expect(store.user_roles).toBe(JSON.stringify(['admin']))
  })

  it('clears stale tokens when bootstrap session receives 401', async () => {
    store.auth_token = 'stale-token'
    store.user_roles = JSON.stringify(['admin'])
    store.user_permissions = JSON.stringify(['users:write'])

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ success: false, error: 'Invalid token' }),
    }))

    const { bootstrapSession, getToken, getAccessSnapshot } = useAuth()
    const result = await bootstrapSession()

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(getToken()).toBeNull()
    expect(store.user_roles).toBeUndefined()
    expect(store.user_permissions).toBeUndefined()
    expect(getAccessSnapshot().roles).toEqual([])
  })
})
