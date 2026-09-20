import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, authHeaders, clearStoredAuthState } from '../src/utils/api'
import { useAuth } from '../src/composables/useAuth'
import { getAuthPrincipalKey } from '../src/composables/authPrincipal'
import { createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'
import { NETWORK_UNAVAILABLE, networkUnavailableMessage } from '../src/utils/networkErrors'
import { getDeleteTransport, probeDeleteTransport, resetDeleteTransportForTests } from '../src/utils/delete-fallback'

/** A fetch-mock response that carries (or omits) the server's override receipt header. */
function httpResponse(status: number, opts: { receipt?: boolean } = {}): Response {
  const headers = new Headers()
  if (opts.receipt) headers.set('X-Method-Overridden', 'DELETE')
  return { ok: status >= 200 && status < 300, status, statusText: String(status), headers } as unknown as Response
}

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
    resetDeleteTransportForTests()
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
      // The assertion above is SELF-REFERENTIAL (expectation = the function under test), so it
      // survives any rewrite of the EN copy. Pin the literal too, exactly as the zh case further
      // down does: garbling networkErrors.ts's `en` string must turn this file red.
      // P5: `fetch` REJECTED, so there is no response to speak of and the copy must say so.
      expect(caught.message).toBe('Cannot reach the server (no response received). Check your network connection, or try again later.')
      // ...and must NOT be the sentence reserved for "the server answered but cannot serve you",
      // which is what misled the customer on 2026-09-14.
      expect(caught.message).not.toBe('The service is temporarily unavailable. Please try again in a moment.')
      expect(caught.message).not.toContain('Failed to fetch')
      // Neutral by owner ruling: never announce an upgrade to the customer.
      expect(caught.message.toLowerCase()).not.toContain('upgrad')
    } finally {
      vi.useRealTimers()
    }
  })

  it('F4-B/DELETE-fallback: a DELETE that gets no response is re-sent ONCE as POST+X-HTTP-Method-Override, never backoff-retried', async () => {
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
      // Exactly two wire attempts: the native DELETE, then the one POST+override fallback
      // (utils/delete-fallback.ts). Deletes are idempotent, so that single replay is safe; the
      // 1200/3500ms backoff loop still never applies to DELETE.
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
      expect(fetchMock.mock.calls[1][1].method).toBe('POST')
      expect((fetchMock.mock.calls[1][1].headers as Headers).get('X-HTTP-Method-Override')).toBe('DELETE')
      // Both attempts got no response: nothing was learned (the whole link is down), so the
      // session does NOT flip — the next DELETE tries native first again.
      expect(getDeleteTransport()).toBe('native')
    } finally {
      vi.useRealTimers()
    }
  })

  it('DELETE-fallback: the POST+override retry is only accepted with the server receipt', async () => {
    // The retry reaches something that answers 200 WITHOUT `X-Method-Overridden` — i.e. a hop stripped
    // the header, or a same-path POST twin handled it. apiFetch must not hand that back as a
    // successful delete.
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transportFailure())
      .mockResolvedValueOnce(httpResponse(200))
    vi.stubGlobal('fetch', fetchMock)

    const caught = await apiFetch('/api/comments/c1/reactions', {
      method: 'DELETE',
      suppressUnauthorizedRedirect: true,
    }).then(() => null, (error: unknown) => error) as Error & { code?: string }

    expect(caught?.code).toBe('DELETE_TRANSPORT_UNCONFIRMED')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getDeleteTransport()).toBe('override-unavailable')
  })

  it('DELETE-fallback: a receipt-carrying retry IS accepted and latches the tunnel', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transportFailure())
      .mockResolvedValueOnce(httpResponse(200, { receipt: true }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await apiFetch('/api/multitable/records/rec_1', {
      method: 'DELETE',
      suppressUnauthorizedRedirect: true,
    })

    expect(response.status).toBe(200)
    expect(getDeleteTransport()).toBe('override')
  })

  it('DELETE-fallback: a DELETE that gets an HTTP response (404) is returned as-is, no second attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
    vi.stubGlobal('fetch', fetchMock)

    const response = await apiFetch('/api/multitable/records/rec_1', {
      method: 'DELETE',
      suppressUnauthorizedRedirect: true,
    })

    expect(response.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
    expect(getDeleteTransport()).toBe('native')
  })

  it('DELETE-fallback: bypassDeleteFallback keeps the probe a literal DELETE with no fallback attempt', async () => {
    const fetchMock = vi.fn().mockRejectedValue(transportFailure())
    vi.stubGlobal('fetch', fetchMock)

    const caught = await apiFetch('/api/method-probe', {
      method: 'DELETE',
      suppressUnauthorizedRedirect: true,
      bypassDeleteFallback: true,
    }).then(() => null, (error: unknown) => error) as Error & { code?: string }

    expect(caught.code).toBe(NETWORK_UNAVAILABLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
    expect(getDeleteTransport()).toBe('native')
  })

  /**
   * THE PROBE'S TUNNEL LEG, COMPOSED WITH THE REAL `apiFetch` — i.e. main.ts's lambda verbatim.
   *
   * Refuter finding, CONFIRMED red before the fix. `withOverride` (utils/delete-fallback.ts) hands
   * apiFetch a **Headers instance**, and apiFetch used to merge headers with an OBJECT SPREAD, which
   * yields `{}` for that shape (no own enumerable properties). The override header therefore never
   * went on the wire: the server saw a plain `POST /api/method-probe`, answered without a receipt,
   * and the probe latched 'override-unavailable' — which also forbids `sendDelete`'s one-shot retry
   * (delete-fallback.ts) for the rest of the session. In the customer's condition (native DELETE
   * dropped) that turned the fix into a no-op AND was worse than shipping no probe at all.
   *
   * Every OTHER probe test injects a mock `baseFetch` (tests/delete-fallback.spec.ts), so this is the
   * only place the two modules are composed the way production composes them.
   */
  it('DELETE-fallback: the probe tunnel leg keeps X-HTTP-Method-Override THROUGH apiFetch and latches on the receipt', async () => {
    store.tenantId = 'tenant_42'
    store.auth_token = 'token-abc'
    const fetchMock = vi.fn()
      // Leg 1: the native DELETE gets no response — the customer's condition.
      .mockRejectedValueOnce(transportFailure())
      // Leg 2: the tunnel IS honoured by this server (receipt present).
      .mockResolvedValueOnce(httpResponse(200, { receipt: true }))
    vi.stubGlobal('fetch', fetchMock)

    const mode = await probeDeleteTransport((url, init) =>
      apiFetch(url, { ...init, suppressUnauthorizedRedirect: true, bypassDeleteFallback: true }))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
    // Leg 1 is a literal DELETE: it may not carry the override claim, or it would not measure DELETE.
    expect((fetchMock.mock.calls[0][1].headers as Headers).get('X-HTTP-Method-Override')).toBeNull()
    expect(fetchMock.mock.calls[1][1].method).toBe('POST')
    // The one bit the whole fallback turns on. It must survive apiFetch's header merge.
    expect((fetchMock.mock.calls[1][1].headers as Headers).get('X-HTTP-Method-Override')).toBe('DELETE')
    // ...and the merge may not drop the auth headers apiFetch itself injects either.
    expect((fetchMock.mock.calls[1][1].headers as Headers).get('Authorization')).toBe('Bearer token-abc')
    expect((fetchMock.mock.calls[1][1].headers as Headers).get('x-tenant-id')).toBe('tenant_42')
    expect(mode).toBe('override')
    expect(getDeleteTransport()).toBe('override')
  })

  it('DELETE-fallback: through apiFetch, a tunnel leg answered WITHOUT a receipt still latches override-unavailable', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transportFailure())
      .mockResolvedValueOnce(httpResponse(404))
    vi.stubGlobal('fetch', fetchMock)

    const mode = await probeDeleteTransport((url, init) =>
      apiFetch(url, { ...init, suppressUnauthorizedRedirect: true, bypassDeleteFallback: true }))

    // Negative control for the test above: the header DID go out (call 1), so 'override-unavailable'
    // here is the server's verdict on the tunnel, not the client losing its own header.
    expect((fetchMock.mock.calls[1][1].headers as Headers).get('X-HTTP-Method-Override')).toBe('DELETE')
    expect(mode).toBe('override-unavailable')
  })

  it('apiFetch merges a Headers INSTANCE the caller passes (object-spreading one silently yields {})', async () => {
    store.auth_token = 'token-abc'
    const fetchMock = vi.fn().mockResolvedValue(httpResponse(200))
    vi.stubGlobal('fetch', fetchMock)

    const callerHeaders = new Headers({ 'X-Custom': 'kept', Authorization: 'Bearer caller-wins' })
    await apiFetch('/api/multitable/records', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: callerHeaders,
      suppressUnauthorizedRedirect: true,
    })

    const sent = fetchMock.mock.calls[0][1].headers as Headers
    expect(sent.get('X-Custom')).toBe('kept')
    // Caller-wins precedence is preserved (the object spread had it too).
    expect(sent.get('Authorization')).toBe('Bearer caller-wins')
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
    expect(caught.message).toBe('无法连接服务器（未收到任何响应），请检查网络或稍后重试')
    expect(caught.message).not.toBe('服务暂时不可用，请稍后重试')
    expect(caught.message).not.toContain('升级')
    expect(caught.message).not.toContain('Failed to fetch')
  })
})
