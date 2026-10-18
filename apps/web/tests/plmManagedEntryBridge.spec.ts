import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearManagedDescriptor,
  clearManagedProbeMarker,
  getAuthPrincipalKey,
  installManagedDescriptor,
  readManagedDescriptor,
  setManagedProbeMarker,
} from '../src/composables/authPrincipal'
import { useAuth } from '../src/composables/useAuth'
import { useFeatureFlags } from '../src/stores/featureFlags'
import {
  bridgeCorrelationMatches,
  completeManagedBrowserBridge,
  logoutManagedBrowserBridge,
  managedEntryBody,
  rememberBridgeCorrelation,
  startManagedBrowserBridge,
  startManagedLogin,
} from '../src/services/plm/plmManagedCompanion'
import { apiFetch } from '../src/utils/api'

const descriptor = (userId: string, tenantId: string, sessionId: string) => ({
  mode: 'managed-cookie' as const,
  userId,
  tenantId,
  sessionId,
  revision: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
})

const snapshot = (userId: string, tenantId: string, sessionId: string, plm = true) => ({
  success: true,
  data: {
    user: { id: userId, tenantId, role: 'user', permissions: [], must_change_password: false },
    features: { plm, attendance: false, workflow: false },
    managedSession: descriptor(userId, tenantId, sessionId),
  },
})

function installQueueLock(): void {
  let tail = Promise.resolve()
  const request = (_name: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
    const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as () => unknown
    const run = tail.then(() => callback())
    tail = run.then(() => undefined, () => undefined)
    return run
  }
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
}

function removeQueueLock(): void {
  Reflect.deleteProperty(navigator, 'locks')
}

describe('managed entry bridge', () => {
  beforeEach(() => {
    removeQueueLock()
    clearManagedProbeMarker()
    clearManagedDescriptor()
    localStorage.removeItem('metasheet_managed_complete_pending')
    useAuth().clearToken()
    sessionStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.VITE_API_URL
    removeQueueLock()
    clearManagedProbeMarker()
    clearManagedDescriptor()
    localStorage.removeItem('metasheet_managed_complete_pending')
    useAuth().clearToken()
  })

  it('keys a cookie principal by person, tenant, and session, and ignores a forged marker', () => {
    installManagedDescriptor(descriptor('person-a', 'tenant-a', 'session-a'))
    const first = getAuthPrincipalKey()
    clearManagedDescriptor()
    installManagedDescriptor(descriptor('person-b', 'tenant-a', 'session-a'))
    const second = getAuthPrincipalKey()
    clearManagedDescriptor()
    installManagedDescriptor(descriptor('person-a', 'tenant-b', 'session-a'))
    const third = getAuthPrincipalKey()
    clearManagedDescriptor()
    installManagedDescriptor(descriptor('person-a', 'tenant-a', 'session-b'))
    const fourth = getAuthPrincipalKey()
    expect(new Set([first, second, third, fourth]).size).toBe(4)
    expect(first).toContain('managed-cookie')
    clearManagedDescriptor()
    localStorage.setItem('metasheet_managed_probe', '1')
    localStorage.setItem('managedSession', JSON.stringify(descriptor('forged', 'tenant-a', 'session-a')))
    expect(getAuthPrincipalKey()).toBeNull()
    expect(readManagedDescriptor()).toBeNull()
  })

  it('does not acquire a dev token on the managed path, including a failed probe', async () => {
    setManagedProbeMarker()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await useAuth().ensureToken()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 401 }))
    const failed = await useAuth().bootstrapSession()
    expect(failed.ok).toBe(false)
    expect(localStorage.getItem('devToken')).toBeNull()
    expect(localStorage.getItem('auth_token')).toBeNull()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/plm/managed-login/current')
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ credentials: 'include' }))
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined()
    expect(fetchMock.mock.calls[0][1].headers['x-user-id']).toBeUndefined()
    expect(localStorage.getItem('metasheet_managed_probe')).toBe('1')
  })

  it('drops a late managed snapshot after another person takes the tab', async () => {
    setManagedProbeMarker()
    let release: (response: Response) => void = () => undefined
    const pendingFetch = new Promise<Response>((resolve) => {
      release = resolve
    })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/api/plm/managed-login/logout')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      }
      return pendingFetch
    }))
    const pending = useAuth().bootstrapSession()
    const tokenB = `header.${btoa(JSON.stringify({ userId: 'person-b', tenantId: 'tenant-b' }))}.signature`
    await useAuth().commitOrdinaryAuthTransition(() => {
      useAuth().setToken(tokenB)
    })
    release(new Response(JSON.stringify(snapshot('person-a', 'tenant-a', 'session-a')), { status: 200 }))
    const result = await pending
    expect(result.ok).toBe(false)
    expect(useAuth().getToken()).toBe(tokenB)
    expect(getAuthPrincipalKey()).toContain('person-b')
    expect(getAuthPrincipalKey()).not.toContain('person-a')
    expect(readManagedDescriptor()).toBeNull()
    const flags = useFeatureFlags()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/auth/me')) {
        return new Response(JSON.stringify({
          success: true,
          data: { user: { id: 'person-b', tenantId: 'tenant-b', role: 'user', permissions: [] }, features: { plm: false, attendance: false, workflow: false } },
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))
    const features = await flags.loadProductFeatures(true)
    expect(features.plm).toBe(false)
    expect(useAuth().getToken()).toBe(tokenB)
  })

  it('adopts a verified current snapshot for the cookie principal', async () => {
    setManagedProbeMarker()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot('person-a', 'tenant-a', 'session-a')), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await useAuth().bootstrapSession()
    expect(result.ok).toBe(true)
    expect(readManagedDescriptor()).toMatchObject({ userId: 'person-a', tenantId: 'tenant-a', sessionId: 'session-a' })
    expect(useAuth().getToken()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not let a public feature load answer the next principal', async () => {
    let releasePlugins: (response: Response) => void = () => undefined
    const fetchMock = vi.fn((url: string) => {
      const text = String(url)
      if (text.includes('/api/plugins')) {
        return new Promise<Response>((resolve) => {
          releasePlugins = resolve
        })
      }
      if (text.includes('/api/auth/me')) {
        return Promise.resolve(new Response(JSON.stringify({
          success: true,
          data: {
            user: { id: 'person-b', role: 'user', permissions: [] },
            features: { plm: true, attendance: true, workflow: false },
          },
        }), { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const flags = useFeatureFlags()
    const first = flags.loadProductFeatures(true, { skipSessionProbe: true })
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/plugins'))).toBe(true)
    })
    const tokenB = `header.${btoa(JSON.stringify({ userId: 'person-b', tenantId: 'tenant-b' }))}.signature`
    useAuth().setToken(tokenB)
    const second = flags.loadProductFeatures(true)
    releasePlugins(new Response(JSON.stringify({ list: [] }), { status: 200 }))
    const features = await second
    await first
    expect(features.plm).toBe(true)
    expect(useAuth().getToken()).toBe(tokenB)
    expect(getAuthPrincipalKey()).toContain('person-b')
  })

  it('rechecks an expired managed snapshot instead of returning cached success', async () => {
    setManagedProbeMarker()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot('person-a', 'tenant-a', 'session-a')), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect((await useAuth().bootstrapSession()).ok).toBe(true)
      clock.mockReturnValue(now + 120_000)
      expect((await useAuth().bootstrapSession()).ok).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(readManagedDescriptor()).toBeNull()
    } finally {
      clock.mockRestore()
    }
  })

  it('refuses a foreign API base in the actual managed bootstrap before fetching', async () => {
    setManagedProbeMarker()
    process.env.VITE_API_URL = 'http://foreign.example.test'
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await useAuth().bootstrapSession()).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a managed API base on another origin before the request', async () => {
    setManagedProbeMarker()
    process.env.VITE_API_URL = 'http://foreign.example.test'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiFetch('/api/plm/managed-login/current')).rejects.toThrow('托管接口源不匹配')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the exact hint selector and keeps correlation as hashes', async () => {
    installQueueLock()
    const query = '?issuer=http://127.0.0.1:9/installation&tenant_id=default&org_id=fixture-org&client_id=managed-fixture&root_part_id=part&native_subject_hint=42'
    expect(managedEntryBody(query)).toEqual({
      issuer: 'http://127.0.0.1:9/installation',
      nativeTenantId: 'default',
      nativeOrgId: 'fixture-org',
      clientId: 'managed-fixture',
      rootPartId: 'part',
      nativeSubjectHint: '42',
    })
    expect(() => managedEntryBody(`${query}&email=person@example.test`)).toThrow('托管入口参数被拒绝')
    const navigation = 'http://127.0.0.1:9/managed-login?state=state-one&code_challenge=abc'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, navigationUrl: navigation }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const started = await startManagedBrowserBridge(query)
    expect(started.state).toBe('state-one')
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(init.body))).toEqual(managedEntryBody(query))
    expect(init.headers['x-metasheet-managed-bridge']).toBe('browser-start')
    expect(init.credentials).toBe('include')
    expect(await bridgeCorrelationMatches('state-one')).toBe(true)
    const stored = [...Array(sessionStorage.length)].map((_, index) => sessionStorage.getItem(sessionStorage.key(index) ?? '') ?? '')
    expect(stored.join('')).not.toContain('state-one')
    expect(stored.join('')).not.toContain('yur_')
    localStorage.setItem('auth_token', 'header.person.signature')
    localStorage.setItem('jwt', 'header.person.signature')
    expect(await bridgeCorrelationMatches('state-one')).toBe(false)
  })

  it('keeps a complete result when a cooperating writer cannot land during the exchange', async () => {
    installQueueLock()
    await rememberBridgeCorrelation('state-one')
    let release: (response: Response) => void = () => undefined
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/api/plm/managed-login/logout')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      }
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const pending = completeManagedBrowserBridge('one-use-code', 'state-one')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(() => useAuth().setToken('header.other-person.signature')).toThrow('AUTH_IDENTITY_LOCK_REQUIRED')
    expect(useAuth().getToken()).toBeNull()
    release(new Response(JSON.stringify({ ok: true, destination: '/plm/bom-review?managed=ready' }), { status: 200 }))
    await expect(pending).resolves.toEqual({ destination: '/plm/bom-review?managed=ready', stale: false })
    expect(localStorage.getItem('metasheet_managed_probe')).toBe('1')
    expect(localStorage.getItem('metasheet_managed_complete_pending')).toBeNull()
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/logout'))).toBe(false)
  })

  it('does not adopt a complete result after a non-cooperating storage change', async () => {
    installQueueLock()
    await rememberBridgeCorrelation('state-one')
    let release: (response: Response) => void = () => undefined
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/api/plm/managed-login/logout')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      }
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const pending = completeManagedBrowserBridge('one-use-code', 'state-one')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    localStorage.setItem('auth_token', 'header.other-person.signature')
    localStorage.setItem('jwt', 'header.other-person.signature')
    release(new Response(JSON.stringify({ ok: true, destination: '/plm/bom-review?managed=ready' }), { status: 200 }))
    await expect(pending).resolves.toEqual({ destination: '', stale: true })
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/logout'))).toBe(true)
    expect(localStorage.getItem('auth_token')).toBe('header.other-person.signature')
    expect(localStorage.getItem('metasheet_managed_complete_pending')).toBeNull()
  })

  it('accepts public credential-like text and rejects credential keys and unexpected fields', async () => {
    const entry = (rootPartId: string) =>
      `?issuer=http://127.0.0.1:9/installation&tenant_id=default&org_id=fixture-org&client_id=managed-fixture&root_part_id=${rootPartId}&native_subject_hint=42`
    const publicId = 'client_secret-text'
    const navigationUrl = `http://127.0.0.1:9/managed-login?root_part_id=${publicId}&state=state-text`
    const destination = `/plm/bom-review?partId=${publicId}&managed=ready`
    const ownerNavigation = 'https://native.example.test/managed-login?root_part_id=yur_public-part&client_id=managed-fixture'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, navigationUrl }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, destination }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        navigationUrl: 'http://127.0.0.1:9/managed-login?code_verifier=abc&state=state-no',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        navigationUrl: 'http://127.0.0.1:9/managed-login?client_secret=abc&state=state-no',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        navigationUrl,
        credential: 'yur_secret',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        destination: 'https://foreign.example.test/plm/bom-review?partId=part&managed=ready',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        destination: '/plm/bom-review?code_verifier=abc&managed=ready',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        destination: '/plm/bom-review-extra?partId=part&managed=ready',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, navigationUrl: ownerNavigation }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    installQueueLock()
    await expect(startManagedBrowserBridge(entry(publicId))).resolves.toEqual({ navigationUrl, state: 'state-text' })
    await expect(completeManagedBrowserBridge('one-use-code', 'state-text')).resolves.toEqual({ destination, stale: false })
    await expect(startManagedBrowserBridge(entry('part'))).rejects.toThrow('托管登录未能开始')
    await expect(startManagedBrowserBridge(entry('part'))).rejects.toThrow('托管登录未能开始')
    await expect(startManagedBrowserBridge(entry('part'))).rejects.toThrow('托管登录响应被拒绝')
    await expect(completeManagedBrowserBridge('one-use-code', 'state-text')).rejects.toThrow('托管登录被拒绝')
    await expect(completeManagedBrowserBridge('one-use-code', 'state-text')).rejects.toThrow('托管登录被拒绝')
    await expect(completeManagedBrowserBridge('one-use-code', 'state-text')).rejects.toThrow('托管登录被拒绝')
    await expect(startManagedLogin('source-1', 'part')).resolves.toEqual({ navigationUrl: ownerNavigation })
  })

  it('allows public part IDs containing credential-like text in bridge navigation', async () => {
    const query = '?issuer=http://127.0.0.1:9/installation&tenant_id=default&org_id=fixture-org&client_id=managed-fixture&root_part_id=yur_public-part&native_subject_hint=42'
    const navigationUrl = 'http://127.0.0.1:9/managed-login?root_part_id=yur_public-part&state=state-public'
    const destination = '/plm/bom-review?partId=yur_public-part&managed=ready'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, navigationUrl }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, destination }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    installQueueLock()
    await expect(startManagedBrowserBridge(query)).resolves.toEqual({ navigationUrl, state: 'state-public' })
    await expect(completeManagedBrowserBridge('one-use-code', 'state-public')).resolves.toEqual({ destination, stale: false })
  })

  it('clears the managed marker on logout and leaves an ordinary token in place', async () => {
    localStorage.setItem('auth_token', 'ordinary-token')
    setManagedProbeMarker()
    installManagedDescriptor(descriptor('person-a', 'tenant-a', 'session-a'))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    installQueueLock()
    await logoutManagedBrowserBridge()
    expect(localStorage.getItem('metasheet_managed_probe')).toBeNull()
    expect(readManagedDescriptor()).toBeNull()
    expect(localStorage.getItem('auth_token')).toBe('ordinary-token')
    expect(localStorage.getItem('devToken')).toBeNull()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/plm/managed-login/logout')
    expect(fetchMock.mock.calls[0][1].headers['x-metasheet-managed-bridge']).toBe('logout')
  })
})
