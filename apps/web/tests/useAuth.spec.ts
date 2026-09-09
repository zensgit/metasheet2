import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAuth } from '../src/composables/useAuth'
import { effectScope } from 'vue'
import { onAuthPrincipalChange } from '../src/composables/authPrincipal'

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
    sessionStorage.clear()
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

  it('replaces only an explicitly selected same-actor session and preserves login hints', () => {
    const jwt = (tenantId: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const original = jwt('org-a')
    const next = jwt('org-b')
    auth.setToken(original)
    expect(auth.setExplicitSessionOrg(next, 'org-b', original)).toBe(true)
    expect(auth.getToken()).toBe(next)
    expect(store.tenantId).toBe('org-a')
    expect(store.workspaceId).toBe('org-a')
  })

  it.each(['', 'invalid', 'a.b.c'])('rejects invalid explicit-session responses without changing storage: %s', (token) => {
    const auth = useAuth()
    auth.setToken('original')
    const before = { ...store }
    expect(auth.setExplicitSessionOrg(token, 'org-b', 'original')).toBe(false)
    expect(store).toEqual(before)
  })

  it('rejects explicit-session responses for a replaced session, actor, tenant or expiration', () => {
    const jwt = (userId: string, tenantId: string, exp = Math.floor(Date.now() / 1000) + 60) => `header.${btoa(JSON.stringify({ userId, tenantId, exp }))}.signature`
    const auth = useAuth()
    const original = jwt('actor', 'org-a')
    auth.setToken(original)
    for (const token of [jwt('other', 'org-b'), jwt('actor', 'other'), jwt('actor', 'org-b', 1)]) {
      expect(auth.setExplicitSessionOrg(token, 'org-b', original)).toBe(false)
      expect(auth.getToken()).toBe(original)
    }
    auth.setToken(jwt('other', 'org-c'))
    const before = { ...store }
    expect(auth.setExplicitSessionOrg(jwt('actor', 'org-b'), 'org-b', original)).toBe(false)
    expect(store).toEqual(before)
  })

  it('keeps the login hint across explicit-session bootstrap and priming', async () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    auth.setToken(jwt('org-a'))
    expect(auth.setExplicitSessionOrg(jwt('org-b'), 'org-b', jwt('org-a'))).toBe(true)
    const payload = { data: { user: { id: 'actor', tenantId: 'org-b', permissions: [] } } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload }))
    await auth.bootstrapSession(true)
    auth.primeSession(payload)
    expect(store.tenantId).toBe('org-a')
    expect(store.workspaceId).toBe('org-a')
    expect(auth.buildAuthHeaders()['x-tenant-id']).toBe('org-b')
  })

  it('preserves token aliases if the shared explicit-session barrier cannot be stored', () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    auth.setToken(jwt('org-a'))
    const before = { ...store }
    const storage = ls.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    try {
      expect(auth.setExplicitSessionOrg(jwt('org-b'), 'org-b', jwt('org-a'))).toBe(false)
      expect(store).toEqual(before)
      expect(store['metasheet.explicitSessionOrg.v1']).toBeUndefined()
    } finally { storage.mockImplementation((k: string, v: string) => (store[k] = v)) }
  })

  it('ignores priming payloads for another tenant during an explicit session', () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    auth.setToken(jwt('org-a'))
    auth.setExplicitSessionOrg(jwt('org-b'), 'org-b', jwt('org-a'))
    auth.primeSession({ data: { user: { id: 'actor', tenantId: 'org-a', roles: ['stale'] } } })
    expect(auth.getCurrentUser()).toBeNull()
    expect(store.user_roles).toBeUndefined()
    expect(store.tenantId).toBe('org-a')
  })

  it.each(['jwt', 'ready'])('restores the original explicit session when the %s write fails', failure => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a')
    auth.setToken(a)
    expect(auth.setExplicitSessionOrg(a, 'org-a', a)).toBe(true)
    const before = { ...store }
    let failed = false
    ls.setItem.mockImplementation((key, value) => {
      if (!failed && ((failure === 'jwt' && key === 'jwt')
        || (failure === 'ready' && key === 'metasheet.explicitSessionOrg.v1' && JSON.parse(value).state === 'ready'))) {
        failed = true
        throw new Error('synthetic storage failure')
      }
      return (store[key] = value)
    })
    try {
      expect(auth.setExplicitSessionOrg(jwt('org-b'), 'org-b', a)).toBe(false)
      expect(failed).toBe(true)
      expect(JSON.stringify(store) === JSON.stringify(before)).toBe(true)
      expect(auth.buildAuthHeaders()['x-tenant-id']).toBe('org-a')
    } finally { ls.setItem.mockImplementation((key, value) => (store[key] = value)) }
  })

  it.each(['switch', 'login'])('does not overwrite a newer overlapping %s with the old transition', replacement => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a'), b = jwt('org-b'), c = jwt('org-c')
    auth.setToken(a)
    let replaced = false
    ls.setItem.mockImplementation((key, value) => {
      store[key] = value
      if (!replaced && key === 'auth_token' && value === b) {
        replaced = true
        if (replacement === 'switch') expect(auth.setExplicitSessionOrg(c, 'org-c', b)).toBe(true)
        else auth.setToken(c)
      }
      return value
    })
    try {
      expect(auth.setExplicitSessionOrg(b, 'org-b', a)).toBe(false)
      expect(replaced).toBe(true)
      expect(store.auth_token === c && store.jwt === c).toBe(true)
      expect(auth.buildAuthHeaders()['x-tenant-id']).toBe('org-c')
    } finally { ls.setItem.mockImplementation((key, value) => (store[key] = value)) }
  })

  it('keeps requests blocked when token rollback storage also fails', () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a'), b = jwt('org-b')
    auth.setToken(a)
    let failed = false
    ls.setItem.mockImplementation((key, value) => {
      if (key === 'jwt' && value === b) { failed = true; throw new Error('synthetic write failure') }
      if (failed && key === 'auth_token' && value === a) throw new Error('synthetic rollback failure')
      return (store[key] = value)
    })
    try {
      expect(auth.setExplicitSessionOrg(b, 'org-b', a)).toBe(false)
      expect(failed).toBe(true)
      expect(() => auth.buildAuthHeaders()).toThrow('SESSION_ORG_REAUTH_REQUIRED')
      expect(JSON.parse(store['metasheet.explicitSessionOrg.v1']).state).toBe('changing')
    } finally { ls.setItem.mockImplementation((key, value) => (store[key] = value)) }
  })

  // Model another realm's completed storage writes without this realm's auth
  // notifications. Real two-tab browser validation is a separate gate.
  function externalSession(token: string, epoch: string) {
    const payload = JSON.parse(atob(token.split('.')[1]))
    store.auth_token = token
    store.jwt = token
    store['metasheet.explicitSessionOrg.v1'] = JSON.stringify({ state: 'ready', token,
      actor: payload.userId, tenantId: payload.tenantId, exp: payload.exp, epoch })
  }

  it('deduplicates explicit storage notifications and releases its scoped listener', () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    auth.setToken(jwt('org-a'))
    auth.primeSession({ data: { user: { id: 'actor', tenantId: 'org-a' } } })
    const scope = effectScope()
    scope.run(() => { useAuth(); useAuth() })
    const changed = vi.fn()
    const unsubscribe = onAuthPrincipalChange(changed)
    const dispatch = () => window.dispatchEvent(new StorageEvent('storage', {
      key: 'metasheet.explicitSessionOrg.v1', newValue: store['metasheet.explicitSessionOrg.v1'],
    }))
    try {
      externalSession(jwt('org-b'), 'external-b')
      dispatch()
      expect(changed).toHaveBeenCalledTimes(1)
      expect(auth.getCurrentUser()).toBeNull()
      dispatch()
      expect(changed).toHaveBeenCalledTimes(1)
      scope.stop()
      externalSession(jwt('org-a'), 'external-a2')
      dispatch()
      expect(changed).toHaveBeenCalledTimes(1)
    } finally { scope.stop(); unsubscribe() }
  })

  it('does not return an old cached user before the explicit storage event arrives', () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    auth.setToken(jwt('org-a'))
    auth.primeSession({ data: { user: { id: 'actor', tenantId: 'org-a' } } })
    externalSession(jwt('org-b'), 'external-b')
    expect(auth.getCurrentUser() === null).toBe(true)
    expect(store.tenantId).toBe('org-a')
  })

  it('rejects a late bootstrap after an unobserved external A-B-A epoch change', async () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a')
    auth.setToken(a)
    auth.setExplicitSessionOrg(a, 'org-a', a)
    let finish!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve })))
    const pending = auth.bootstrapSession(true)
    externalSession(jwt('org-b'), 'external-b')
    externalSession(a, 'external-a2')
    finish({ ok: true, status: 200, json: async () => ({ data: { user: { id: 'actor', tenantId: 'org-a', roles: ['old'] } } }) })
    expect((await pending).ok).toBe(false)
    expect(auth.getCurrentUser()).toBeNull()
    expect(store.user_roles).toBeUndefined()
  })

  it('does not let an old bootstrap overwrite an explicit switch or its login hint', async () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    auth.setToken(jwt('org-a'))
    let resolve!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(done => { resolve = done })))
    const pending = auth.bootstrapSession(true)
    auth.setExplicitSessionOrg(jwt('org-b'), 'org-b', jwt('org-a'))
    resolve({ ok: true, status: 200, json: async () => ({ data: { user: { id: 'actor', tenantId: 'org-a', roles: ['stale'] } } }) })
    expect((await pending).ok).toBe(false)
    expect(auth.getCurrentUser()).toBeNull()
    expect(store.user_roles).toBeUndefined()
    expect(auth.buildAuthHeaders()['x-tenant-id']).toBe('org-b')
  })

  it('does not evict the new bootstrap promise when the old organization response settles', async () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a')
    auth.setToken(a)
    const pending: Array<(value: unknown) => void> = []
    const fetchMock = vi.fn().mockImplementation(() => new Promise(done => pending.push(done)))
    vi.stubGlobal('fetch', fetchMock)
    const old = auth.bootstrapSession()
    expect(auth.setExplicitSessionOrg(jwt('org-b'), 'org-b', a)).toBe(true)
    const current = auth.bootstrapSession()
    pending[0]({ ok: true, status: 200, json: async () => ({}) })
    expect((await old).ok).toBe(false)
    const concurrent = auth.bootstrapSession()
    const calls = fetchMock.mock.calls.length
    for (const resolve of pending.slice(1)) resolve({ ok: true, status: 200,
      json: async () => ({ data: { user: { id: 'actor', tenantId: 'org-b' } } }) })
    await Promise.all([current, concurrent])
    expect(calls).toBe(2)
    expect(store.tenantId).toBe('org-a')
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
