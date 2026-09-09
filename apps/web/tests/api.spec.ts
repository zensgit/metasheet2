import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, authHeaders, clearStoredAuthState } from '../src/utils/api'
import { useAuth } from '../src/composables/useAuth'
import { getAuthPrincipalKey } from '../src/composables/authPrincipal'
import { createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'

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
    sessionStorage.clear()
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

  it('uses the explicit current-token org in both header builders without changing login hints', () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a')
    const b = jwt('org-b')
    auth.setToken(a)
    expect(auth.setExplicitSessionOrg(b, 'org-b', a)).toBe(true)
    expect(authHeaders()['x-tenant-id']).toBe('org-b')
    expect(auth.buildAuthHeaders()['x-tenant-id']).toBe('org-b')
    expect(authHeaders(a)['x-tenant-id']).toBe('org-a')
    expect(auth.buildAuthHeaders(a)['x-tenant-id']).toBe('org-a')
    expect(store.tenantId).toBe('org-a')
    expect(store.workspaceId).toBe('org-a')
    auth.setToken(a)
    expect(authHeaders()['x-tenant-id']).toBe('org-a')
    expect(store['metasheet.explicitSessionOrg.v1']).toBeUndefined()
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

  it('keeps the explicit organization when another tab has no tab-local metadata', () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a')
    const b = jwt('org-b')
    auth.setToken(a)
    expect(auth.setExplicitSessionOrg(b, 'org-b', a)).toBe(true)
    // Model the storage boundary, not a browser E2E: tabs share localStorage
    // but a separately opened tab has no copy of this tab's sessionStorage.
    sessionStorage.clear()
    expect(authHeaders()['x-tenant-id']).toBe('org-b')
    expect(auth.buildAuthHeaders()['x-tenant-id']).toBe('org-b')
    expect(store.tenantId).toBe('org-a')
  })

  it('blocks network requests when shared explicit-session metadata is corrupt', async () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a')
    auth.setToken(a)
    expect(auth.setExplicitSessionOrg(jwt('org-b'), 'org-b', a)).toBe(true)
    store['metasheet.explicitSessionOrg.v1'] = '{corrupt'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiFetch('/api/attendance/records', { suppressUnauthorizedRedirect: true }))
      .rejects.toThrow('SESSION_ORG_REAUTH_REQUIRED')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.tenantId).toBe('org-a')
  })

  it.each(['token', 'actor', 'tenantId', 'exp'])('rejects a marker with a mismatching %s binding', field => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    auth.setToken(jwt('org-a'))
    auth.setExplicitSessionOrg(jwt('org-b'), 'org-b', jwt('org-a'))
    const marker = JSON.parse(store['metasheet.explicitSessionOrg.v1'])
    marker[field] = 'mismatch'
    store['metasheet.explicitSessionOrg.v1'] = JSON.stringify(marker)
    expect(() => authHeaders()).toThrow('SESSION_ORG_REAUTH_REQUIRED')
    expect(() => auth.buildAuthHeaders()).toThrow('SESSION_ORG_REAUTH_REQUIRED')
    expect(store['metasheet.explicitSessionOrg.v1']).toBeTruthy()
  })

  it('does not reuse an expired explicit marker and clears it on logout', () => {
    const expires = Math.floor(Date.now() / 1000) + 60
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: expires }))}.signature`
    const auth = useAuth()
    auth.setToken(jwt('org-a'))
    auth.setExplicitSessionOrg(jwt('org-b'), 'org-b', jwt('org-a'))
    const now = vi.spyOn(Date, 'now').mockReturnValue((expires + 1) * 1000)
    try { expect(() => authHeaders()).toThrow('SESSION_ORG_REAUTH_REQUIRED') } finally { now.mockRestore() }
    auth.clearToken()
    expect(authHeaders().Authorization).toBeUndefined()
  })

  it('blocks an old page before storage events, including an unobserved A-B-A round trip', async () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a')
    const b = jwt('org-b')
    auth.setToken(a)
    expect(auth.setExplicitSessionOrg(a, 'org-a', a)).toBe(true)
    const original = getAuthPrincipalKey()
    const oldPage = createAttendanceSessionGuard('org-a')
    const unobservedPage = createAttendanceSessionGuard('org-a')
    const send = vi.fn()
    expect(auth.setExplicitSessionOrg(b, 'org-b', a)).toBe(true)
    sessionStorage.clear()
    expect(authHeaders()['x-tenant-id']).toBe('org-b')
    await expect(oldPage.wrapFetch(send)('/cleaning-apply', { method: 'POST' })).rejects.toThrow('ATTENDANCE_SESSION_CHANGED_RELOAD_REQUIRED')
    expect(auth.setExplicitSessionOrg(a, 'org-a', b)).toBe(true)
    expect(getAuthPrincipalKey()).not.toBe(original)
    await expect(unobservedPage.wrapFetch(send)('/cleaning-apply', { method: 'POST' })).rejects.toThrow('ATTENDANCE_SESSION_CHANGED_RELOAD_REQUIRED')
    expect(send).not.toHaveBeenCalled()
    expect(store.tenantId).toBe('org-a')
  })

  it('blocks at each token-alias write while an explicit switch is incomplete', () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a')
    const b = jwt('org-b')
    auth.setToken(a)
    const observations: string[] = []
    localStorageMock.setItem.mockImplementation((key, value) => {
      store[key] = value
      if (key === 'auth_token' || key === 'jwt') {
        expect(() => authHeaders()).toThrow('SESSION_ORG_REAUTH_REQUIRED')
        observations.push(key)
      }
    })
    try {
      expect(auth.setExplicitSessionOrg(b, 'org-b', a)).toBe(true)
      expect(observations).toEqual(['auth_token', 'jwt'])
      expect(authHeaders()['x-tenant-id']).toBe('org-b')
    } finally { localStorageMock.setItem.mockImplementation((key, value) => { store[key] = value }) }
  })

  it('does not release the explicit marker before a fresh login replaces both token aliases', () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a')
    const b = jwt('org-b')
    auth.setToken(a)
    auth.setExplicitSessionOrg(b, 'org-b', a)
    const blocked: boolean[] = []
    localStorageMock.setItem.mockImplementation((key, value) => {
      store[key] = value
      if (key === 'auth_token' || key === 'jwt') {
        try { authHeaders(); blocked.push(false) } catch { blocked.push(true) }
      }
    })
    try {
      auth.setToken(a)
      expect(blocked).toEqual([true, true])
      expect(authHeaders()['x-tenant-id']).toBe('org-a')
      expect(store['metasheet.explicitSessionOrg.v1']).toBeUndefined()
    } finally { localStorageMock.setItem.mockImplementation((key, value) => { store[key] = value }) }
  })

  it('clears explicit metadata through the API unauthorized-session cleanup path', () => {
    const jwt = (org: string) => `header.${btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 60 }))}.signature`
    const auth = useAuth()
    const a = jwt('org-a')
    auth.setToken(a)
    auth.setExplicitSessionOrg(jwt('org-b'), 'org-b', a)
    clearStoredAuthState()
    expect(store['metasheet.explicitSessionOrg.v1'] === undefined).toBe(true)
    expect(authHeaders().Authorization).toBeUndefined()
  })
})
