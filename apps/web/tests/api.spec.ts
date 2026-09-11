import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, authHeaders, clearStoredAuthState } from '../src/utils/api'
import { useAuth } from '../src/composables/useAuth'
import { getAuthPrincipalKey } from '../src/composables/authPrincipal'
import { createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'
import { NETWORK_UNAVAILABLE, networkUnavailableMessage } from '../src/utils/networkErrors'

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

  // ---------------------------------------------------------------------------
  // F4-B: transport-failure copy + idempotent-read retry (apps/web/src/utils/api.ts
  // fetchWithTransportCopy). The upgrade window takes the backend offline for ~2.5
  // minutes; `fetch` then rejects with the browser literal "Failed to fetch", which
  // every multitable catch site puts on screen verbatim via `e.message`.
  // ---------------------------------------------------------------------------
  /** Let already-settled promise reactions run while timers are faked. */
  async function flushMicrotasks(times = 8): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve()
  }

  function transportFailure(): TypeError {
    // The literal Chromium produces when the upstream connection is refused/reset.
    return new TypeError('Failed to fetch')
  }

  it('F4-B: an idempotent GET retries exactly twice, at 1200ms then 3500ms, and returns the eventual response', async () => {
    vi.useFakeTimers()
    try {
      const okResponse = { ok: true, status: 200, statusText: 'OK' } as unknown as Response
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(okResponse)
      vi.stubGlobal('fetch', fetchMock)

      const pending = apiFetch('/api/multitable/records', { suppressUnauthorizedRedirect: true })
      await flushMicrotasks()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // Backoff is a real wait, not a tight loop: nothing fires one tick early.
      await vi.advanceTimersByTimeAsync(1199)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await flushMicrotasks()
      expect(fetchMock).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(3499)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await flushMicrotasks()
      expect(fetchMock).toHaveBeenCalledTimes(3)

      await expect(pending).resolves.toBe(okResponse)
      // Retry replays the SAME request line, not a mangled one.
      expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
        fetchMock.mock.calls[0][0],
        fetchMock.mock.calls[0][0],
        fetchMock.mock.calls[0][0],
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('F4-B: a GET that never comes back rejects with neutral human copy (code/status/cause) after 3 attempts total', async () => {
    vi.useFakeTimers()
    try {
      const original = transportFailure()
      const fetchMock = vi.fn().mockRejectedValue(original)
      vi.stubGlobal('fetch', fetchMock)

      const pending = apiFetch('/api/multitable/records', { suppressUnauthorizedRedirect: true })
      const settled = pending.then(() => null, (error: unknown) => error)
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(1200)
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(3500)
      await flushMicrotasks()

      const caught = await settled as Error & { code?: string; status?: number; cause?: unknown }
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(caught.code).toBe(NETWORK_UNAVAILABLE)
      expect(caught.status).toBe(0)
      expect(caught.cause).toBe(original)
      // The browser literal is what testers were shown before this fix; it must be gone.
      expect(caught.message).toBe(networkUnavailableMessage(false))
      expect(caught.message).not.toContain('Failed to fetch')
      // Neutral by owner ruling: never announce an upgrade to the customer.
      expect(caught.message.toLowerCase()).not.toContain('upgrad')
    } finally {
      vi.useRealTimers()
    }
  })

  it('F4-B: a DELETE is NOT retried even once — a reset can land after the server already committed', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn().mockRejectedValue(transportFailure())
      vi.stubGlobal('fetch', fetchMock)

      const settled = apiFetch('/api/multitable/records/rec_1', {
        method: 'DELETE',
        suppressUnauthorizedRedirect: true,
      }).then(() => null, (error: unknown) => error)

      await flushMicrotasks()
      // Give any (wrongly scheduled) backoff a full window to fire.
      await vi.advanceTimersByTimeAsync(60_000)
      await flushMicrotasks()

      const caught = await settled as Error & { code?: string }
      expect(caught.code).toBe(NETWORK_UNAVAILABLE)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['POST', 'PUT', 'PATCH'])('F4-B: a %s is NOT retried either', async method => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn().mockRejectedValue(transportFailure())
      vi.stubGlobal('fetch', fetchMock)

      const settled = apiFetch('/api/multitable/records', {
        method,
        body: JSON.stringify({ fields: {} }),
        suppressUnauthorizedRedirect: true,
      }).then(() => null, (error: unknown) => error)

      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(60_000)
      await flushMicrotasks()

      expect((await settled as { code?: string }).code).toBe(NETWORK_UNAVAILABLE)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('F4-B: a GET carrying a body is treated as non-idempotent and is not retried', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn().mockRejectedValue(transportFailure())
      vi.stubGlobal('fetch', fetchMock)

      const settled = apiFetch('/api/multitable/search', {
        method: 'GET',
        body: JSON.stringify({ q: 'x' }),
        suppressUnauthorizedRedirect: true,
      }).then(() => null, (error: unknown) => error)

      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(60_000)
      await flushMicrotasks()

      expect((await settled as { code?: string }).code).toBe(NETWORK_UNAVAILABLE)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('F4-B: an AbortError passes through by identity — an abort is not an outage', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortError = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    const fetchMock = vi.fn().mockRejectedValue(abortError)
    vi.stubGlobal('fetch', fetchMock)

    const caught = await apiFetch('/api/multitable/records', {
      signal: controller.signal,
      suppressUnauthorizedRedirect: true,
    }).then(() => null, (error: unknown) => error)

    expect(caught).toBe(abortError)
    expect((caught as { code?: string }).code).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('F4-B: a GET whose signal is ALREADY aborted buys no retry, even when the stub rejects with a TypeError', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      controller.abort()
      const fetchMock = vi.fn().mockRejectedValue(transportFailure())
      vi.stubGlobal('fetch', fetchMock)

      const settled = apiFetch('/api/multitable/records', {
        signal: controller.signal,
        suppressUnauthorizedRedirect: true,
      }).then(() => null, (error: unknown) => error)

      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(60_000)
      await flushMicrotasks()

      const caught = await settled as { name?: string; message?: string }
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // The caller cancelled — do not relabel their own cancellation as an outage.
      expect(caught.name).toBe('AbortError')
      expect(caught.message).not.toBe(networkUnavailableMessage(false))
    } finally {
      vi.useRealTimers()
    }
  })

  it('F4-B: aborting DURING the backoff stops the retry immediately and reports the abort, not an outage', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const fetchMock = vi.fn().mockRejectedValue(transportFailure())
      vi.stubGlobal('fetch', fetchMock)

      const settled = apiFetch('/api/multitable/records', {
        signal: controller.signal,
        suppressUnauthorizedRedirect: true,
      }).then(() => null, (error: unknown) => error)

      await flushMicrotasks()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      controller.abort()
      await flushMicrotasks()
      const caught = await settled as { name?: string; message?: string }
      expect(caught.name).toBe('AbortError')
      expect(caught.message).not.toBe(networkUnavailableMessage(false))

      // The pending backoff timer must not resurrect the request afterwards.
      await vi.advanceTimersByTimeAsync(60_000)
      await flushMicrotasks()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('F4-B: an HTTP 5xx RESPONSE is returned untouched and never retried (no retry storm on a backend that just came up)', async () => {
    const gatewayError = { ok: false, status: 502, statusText: 'Bad Gateway' } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValue(gatewayError)
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetch('/api/multitable/records', { suppressUnauthorizedRedirect: true }))
      .resolves.toBe(gatewayError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('F4-B: POSITIVE CONTROL — a successful GET still calls fetch exactly once and returns the same Response', async () => {
    const okResponse = { ok: true, status: 200, statusText: 'OK' } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValue(okResponse)
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetch('/api/multitable/records', { suppressUnauthorizedRedirect: true }))
      .resolves.toBe(okResponse)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('F4-B: the copy follows the stored UI locale (zh) without ever saying "升级"', async () => {
    store.metasheet_locale = 'zh-CN'
    const fetchMock = vi.fn().mockRejectedValue(transportFailure())
    vi.stubGlobal('fetch', fetchMock)

    const caught = await apiFetch('/api/multitable/records/rec_1', {
      method: 'DELETE',
      suppressUnauthorizedRedirect: true,
    }).then(() => null, (error: unknown) => error) as Error

    expect(caught.message).toBe(networkUnavailableMessage(true))
    expect(caught.message).toBe('服务暂时不可用，请稍后重试')
    expect(caught.message).not.toContain('升级')
    expect(caught.message).not.toContain('Failed to fetch')
  })
})
