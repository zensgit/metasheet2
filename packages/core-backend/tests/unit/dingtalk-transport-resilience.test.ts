import http from 'node:http'
import { getEventListeners } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import {
  DingTalkBusinessError,
  DingTalkRequestError,
  DingTalkTimeoutError,
  __resetDingTalkAppAccessTokenCacheForTests,
  exchangeCodeForUserAccessToken,
  fetchDingTalkAppAccessToken,
  getDingTalkUserInfoByAuthCode,
  isDingTalkOutcomeUnknown,
  listDingTalkDepartments,
  sendDingTalkWorkNotification,
} from '../../src/integrations/dingtalk/client'
import {
  DINGTALK_TRANSPORT_DEFAULTS,
  computeDingTalkRetryDelayMs,
  isDingTalkFlowControlErrcode,
  parseRetryAfterMs,
  requestDingTalkTransportJson,
  resolveDingTalkTransportConfig,
} from '../../src/integrations/dingtalk/transport'

/**
 * Roadmap §7.2 unified DingTalk transport: retry / backoff / rate-limit handling at
 * the ONE seam every client.ts call goes through. The tier matrix under test
 * (business semantics, never inferred from the HTTP verb):
 *
 *   read      → retried on network error, HTTP 429, selected 5xx (500/502/503/504),
 *               and flow-control errcodes in HTTP-200 envelopes
 *   exchange  → never retried (single-use codes; ambiguous retry burns them)
 *   send      → never retried; uncertain outcomes (network/timeout/5xx) are marked
 *               isDingTalkOutcomeUnknown for ledger writers
 *   (omitted) → defaults to 'exchange', the most conservative tier
 *
 * Error shapes after exhaustion/non-retryable failures must be IDENTICAL to the
 * pre-retry client (callers pattern-match DingTalkRequestError/BusinessError);
 * the send-tier marker is additive only.
 */

const MESSAGE_CONFIG = { appKey: 'k', appSecret: 's', agentId: '42' }
const NOTIFICATION = { userIds: ['u1'], title: 'T', content: 'C' }
const OAUTH_CONFIG = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://app.example.com/cb', corpId: null }

const jsonResponse = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const okDeptEnvelope = () => jsonResponse({
  errcode: 0,
  errmsg: 'ok',
  result: [{ dept_id: 1, parent_id: null, name: '技术部' }],
})

describe('DingTalk transport resilience (roadmap §7.2)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined) as ReturnType<typeof vi.spyOn>
  })

  afterEach(() => {
    __resetDingTalkAppAccessTokenCacheForTests()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const retryLogs = () => warnSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('DingTalk transport retry'))

  describe("'read' tier (safe reads)", () => {
    it('retries HTTP 429 with a real backoff delay and succeeds on attempt 2', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(1) // full jitter at its ceiling: base=300ms
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ message: 'too many requests' }, 429))
        .mockResolvedValueOnce(okDeptEnvelope())
      vi.stubGlobal('fetch', fetchMock)

      const startedAt = Date.now()
      const departments = await listDingTalkDepartments('tok', '1')
      const elapsedMs = Date.now() - startedAt

      expect(departments).toEqual([expect.objectContaining({ id: '1', name: '技术部' })])
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(elapsedMs).toBeGreaterThanOrEqual(280) // the backoff actually waited
      expect(retryLogs()).toEqual([expect.stringMatching(/retry 2\/3 after http_429 \(read\)/)])
    })

    it('honors Retry-After (server floor wins over a zero-jitter delay)', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0) // jitter alone would back off 0ms
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ message: 'limited' }, 429, { 'Retry-After': '1' }))
        .mockResolvedValueOnce(okDeptEnvelope())
      vi.stubGlobal('fetch', fetchMock)

      const startedAt = Date.now()
      await listDingTalkDepartments('tok', '1')
      const elapsedMs = Date.now() - startedAt

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(elapsedMs).toBeGreaterThanOrEqual(950)
    })

    it('retries a flow-control errcode inside an HTTP-200 envelope', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ errcode: 90018, errmsg: '触发流控' }))
        .mockResolvedValueOnce(okDeptEnvelope())
      vi.stubGlobal('fetch', fetchMock)

      const departments = await listDingTalkDepartments('tok', '1')

      expect(departments).toHaveLength(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(retryLogs()).toEqual([expect.stringMatching(/flow_control_errcode_90018/)])
    })

    it('retries a network error', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(okDeptEnvelope())
      vi.stubGlobal('fetch', fetchMock)

      await listDingTalkDepartments('tok', '1')

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(retryLogs()).toEqual([expect.stringMatching(/network_error \(read\)/)])
    })

    it('does NOT retry a non-flow-control business errcode (same DingTalkBusinessError shape)', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValue(jsonResponse({ errcode: 40035, errmsg: 'invalid param' }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(listDingTalkDepartments('tok', '1')).rejects.toMatchObject({
        name: 'DingTalkBusinessError',
        // errmsg is not a normalizeErrorMessage candidate → fallback text (pre-retry behavior)
        message: 'Failed to list DingTalk departments',
        responseBody: expect.objectContaining({ errcode: 40035 }),
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry a non-transient 5xx (501 is a contract error, not a blip)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'not implemented' }, 501))
      vi.stubGlobal('fetch', fetchMock)

      await expect(listDingTalkDepartments('tok', '1')).rejects.toMatchObject({ statusCode: 501 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('exhausted retries rethrow the ORIGINAL error shape (statusCode + responseBody intact), one warn per retry, not outcome-unknown', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const fetchFn = vi.fn(async () => jsonResponse({ message: 'unavailable' }, 503)) as unknown as typeof fetch

      let caught: unknown
      try {
        await fetchDingTalkAppAccessToken({ appKey: 'k', appSecret: 's' }, { fetchFn })
      } catch (error) {
        caught = error
      }
      const requestError = caught as DingTalkRequestError
      expect(requestError).toBeInstanceOf(DingTalkRequestError)
      expect(requestError.statusCode).toBe(503)
      expect(requestError.message).toBe('unavailable')
      expect(requestError.responseBody).toEqual({ message: 'unavailable' })
      expect(isDingTalkOutcomeUnknown(requestError)).toBe(false) // marker is send-tier only
      expect(fetchFn).toHaveBeenCalledTimes(3) // default maxAttempts
      expect(retryLogs()).toHaveLength(2) // one warn per retry: attempts 2 and 3
    })

    it('does NOT retry a per-attempt timeout (H06 wall-time bound is preserved)', async () => {
      const abortError = new Error('aborted')
      abortError.name = 'TimeoutError'
      const fetchFn = vi.fn(async () => { throw abortError }) as unknown as typeof fetch

      await expect(fetchDingTalkAppAccessToken({ appKey: 'k', appSecret: 's' }, { fetchFn }))
        .rejects.toBeInstanceOf(DingTalkTimeoutError)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })
  })

  describe("'send' tier (side-effect sends, asyncsend_v2)", () => {
    it('does NOT resend on network error; the failure is marked outcome-unknown', async () => {
      const networkError = new TypeError('fetch failed')
      const fetchFn = vi.fn().mockRejectedValue(networkError) as unknown as typeof fetch

      let caught: unknown
      try {
        await sendDingTalkWorkNotification('tok', NOTIFICATION, MESSAGE_CONFIG, { fetchFn })
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(networkError) // original error object, unwrapped
      expect(isDingTalkOutcomeUnknown(caught)).toBe(true)
      expect((caught as { outcomeUnknown?: unknown }).outcomeUnknown).toBe(true)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(retryLogs()).toEqual([])
    })

    it('does NOT resend on HTTP 5xx; same DingTalkRequestError shape + outcome-unknown marker', async () => {
      const fetchFn = vi.fn(async () => jsonResponse({ message: 'boom' }, 500)) as unknown as typeof fetch

      let caught: unknown
      try {
        await sendDingTalkWorkNotification('tok', NOTIFICATION, MESSAGE_CONFIG, { fetchFn })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(DingTalkRequestError)
      expect(caught).toMatchObject({ statusCode: 500, message: 'boom' })
      expect(isDingTalkOutcomeUnknown(caught)).toBe(true)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('does NOT resend on a timeout; DingTalkTimeoutError is marked outcome-unknown', async () => {
      const abortError = new Error('aborted')
      abortError.name = 'TimeoutError'
      const fetchFn = vi.fn(async () => { throw abortError }) as unknown as typeof fetch

      let caught: unknown
      try {
        await sendDingTalkWorkNotification('tok', NOTIFICATION, MESSAGE_CONFIG, { fetchFn })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(DingTalkTimeoutError)
      expect(isDingTalkOutcomeUnknown(caught)).toBe(true)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry HTTP 429 in this slice (definite rejection → NOT outcome-unknown)', async () => {
      const fetchFn = vi.fn(async () => jsonResponse({ message: 'limited' }, 429)) as unknown as typeof fetch

      let caught: unknown
      try {
        await sendDingTalkWorkNotification('tok', NOTIFICATION, MESSAGE_CONFIG, { fetchFn })
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ name: 'DingTalkRequestError', statusCode: 429 })
      expect(isDingTalkOutcomeUnknown(caught)).toBe(false)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry a flow-control errcode (definite app-layer rejection → NOT outcome-unknown)', async () => {
      const fetchFn = vi.fn(async () => jsonResponse({ errcode: 90018, errmsg: '流控' })) as unknown as typeof fetch

      let caught: unknown
      try {
        await sendDingTalkWorkNotification('tok', NOTIFICATION, MESSAGE_CONFIG, { fetchFn })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(DingTalkBusinessError)
      expect(isDingTalkOutcomeUnknown(caught)).toBe(false)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })
  })

  describe("'exchange' tier (one-shot code exchanges)", () => {
    it('OAuth code exchange is NOT retried on a network error (single-use code)', async () => {
      const networkError = new TypeError('fetch failed')
      const fetchMock = vi.fn().mockRejectedValue(networkError)
      vi.stubGlobal('fetch', fetchMock)

      await expect(exchangeCodeForUserAccessToken('code-1', OAUTH_CONFIG)).rejects.toBe(networkError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(retryLogs()).toEqual([])
    })

    it('OAuth code exchange is NOT retried on HTTP 429/5xx', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'limited' }, 429))
      vi.stubGlobal('fetch', fetchMock)
      await expect(exchangeCodeForUserAccessToken('code-2', OAUTH_CONFIG)).rejects.toMatchObject({ statusCode: 429 })
      expect(fetchMock).toHaveBeenCalledTimes(1)

      const fetchMock5xx = vi.fn().mockResolvedValue(jsonResponse({ message: 'down' }, 503))
      vi.stubGlobal('fetch', fetchMock5xx)
      await expect(exchangeCodeForUserAccessToken('code-3', OAUTH_CONFIG)).rejects.toMatchObject({ statusCode: 503 })
      expect(fetchMock5xx).toHaveBeenCalledTimes(1)
    })

    it('container authCode exchange is NOT retried on a network error', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('socket hang up'))
      vi.stubGlobal('fetch', fetchMock)

      await expect(getDingTalkUserInfoByAuthCode('tok', 'auth-code')).rejects.toBeInstanceOf(TypeError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('default tier is conservative', () => {
    it("an unclassified transport call defaults to 'exchange' — no retry even on 429", async () => {
      const fetchFn = vi.fn(async () => jsonResponse({ message: 'limited' }, 429)) as unknown as typeof fetch

      await expect(requestDingTalkTransportJson({
        input: 'https://oapi.dingtalk.com/topapi/v2/department/listsub?access_token=x',
        init: { method: 'POST' },
        fallbackError: 'failed',
        // kind deliberately omitted
        envelope: 'oapi',
        fetchFn,
      })).rejects.toMatchObject({ statusCode: 429 })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('abort composition (H06 per-attempt timeout + overall signal)', () => {
    it('caller abort mid-backoff exits immediately (no residual sleep, no further attempts)', async () => {
      vi.stubEnv('DINGTALK_TRANSPORT_BACKOFF_BASE_MS', '3000')
      vi.stubEnv('DINGTALK_TRANSPORT_BACKOFF_CAP_MS', '3000')
      vi.spyOn(Math, 'random').mockReturnValue(1) // deterministic 3000ms backoff
      const controller = new AbortController()
      const fetchFn = vi.fn(async () => jsonResponse({ message: 'limited' }, 429)) as unknown as typeof fetch

      const startedAt = Date.now()
      setTimeout(() => controller.abort(), 50)
      await expect(requestDingTalkTransportJson({
        input: 'https://oapi.dingtalk.com/topapi/v2/department/listsub?access_token=x',
        init: { method: 'POST' },
        fallbackError: 'failed',
        kind: 'read',
        envelope: 'oapi',
        fetchFn,
        signal: controller.signal,
      })).rejects.toBeInstanceOf(DingTalkTimeoutError)
      const elapsedMs = Date.now() - startedAt

      expect(elapsedMs).toBeLessThan(1500) // exited the 3000ms backoff early
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('an already-aborted caller signal short-circuits before any fetch', async () => {
      const controller = new AbortController()
      controller.abort()
      const fetchFn = vi.fn() as unknown as typeof fetch

      await expect(requestDingTalkTransportJson({
        input: 'https://oapi.dingtalk.com/gettoken?appkey=x&appsecret=y',
        init: { method: 'GET' },
        fallbackError: 'failed',
        kind: 'read',
        envelope: 'oapi',
        fetchFn,
        signal: controller.signal,
      })).rejects.toBeInstanceOf(DingTalkTimeoutError)
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('every attempt gets its own FRESH timeout signal (a retry must not start with a spent budget)', async () => {
      // timeout (120ms) shorter than the backoff (300ms): a signal created once and
      // reused across attempts would already be aborted when attempt 2 fires.
      vi.spyOn(Math, 'random').mockReturnValue(1)
      const seenAborted: boolean[] = []
      const fetchFn = vi.fn(async (_input: unknown, init?: RequestInit) => {
        seenAborted.push(init?.signal?.aborted ?? true)
        if (seenAborted.length === 1) return jsonResponse({ message: 'limited' }, 429)
        return okDeptEnvelope()
      }) as unknown as typeof fetch

      const payload = await requestDingTalkTransportJson({
        input: 'https://oapi.dingtalk.com/topapi/v2/department/listsub?access_token=x',
        init: { method: 'POST' },
        fallbackError: 'failed',
        kind: 'read',
        envelope: 'oapi',
        fetchFn,
        timeoutMs: 120,
      })

      expect(payload.errcode).toBe(0)
      expect(seenAborted).toEqual([false, false])
    })
  })

  describe('body-phase timeout — headers arrive, then the BODY stalls (real undici fetch, real server)', () => {
    // The per-attempt budget must cover the response BODY read, not just the wait
    // for headers: undici ties the body stream to the request signal, so a stalled
    // body rejects res.json() with the abort reason once the per-attempt timeout
    // fires. That rejection must surface as DingTalkTimeoutError with the SAME
    // per-tier classification as a request-phase timeout — never be swallowed into
    // a `null` payload (which the oapi envelope would normalize to `{}` and report
    // as a SUCCESS for a call whose outcome is unknown).
    let stall: { url: string; requests: { count: number }; close: () => Promise<void> } | null = null

    beforeEach(() => {
      // tests/setup.ts protectively stubs global fetch with a bare vi.fn(); these
      // tests exist precisely to exercise the REAL undici fetch body-stream/abort
      // integration against a real socket — restore it explicitly.
      vi.unstubAllGlobals()
    })

    const startStallServer = async (status = 200) => {
      const requests = { count: 0 }
      const server = http.createServer((_req, res) => {
        requests.count += 1
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.write('{"errcode":') // headers + partial body, then stall forever
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const { port } = server.address() as AddressInfo
      const handle = {
        url: `http://127.0.0.1:${port}/stall`,
        requests,
        close: async () => {
          server.closeAllConnections()
          await new Promise<void>((resolve) => server.close(() => resolve()))
        },
      }
      stall = handle
      return handle
    }

    afterEach(async () => {
      if (stall) {
        await stall.close()
        stall = null
      }
    })

    const transportCall = (url: string, kind: 'read' | 'exchange' | 'send') => requestDingTalkTransportJson({
      input: url,
      init: { method: 'POST' },
      fallbackError: 'failed',
      kind,
      envelope: 'oapi',
      timeoutMs: 200,
    })

    it("read tier: a body stall past the per-attempt timeout fails as DingTalkTimeoutError — bounded, NOT retried, NOT a silent {} success", async () => {
      const { url, requests } = await startStallServer()

      const startedAt = Date.now()
      let caught: unknown
      try {
        await transportCall(url, 'read')
      } catch (error) {
        caught = error
      }
      const elapsedMs = Date.now() - startedAt

      expect(caught).toBeInstanceOf(DingTalkTimeoutError)
      expect(caught).toMatchObject({ timeoutMs: 200 })
      expect(isDingTalkOutcomeUnknown(caught)).toBe(false) // marker is send-tier only
      expect(requests.count).toBe(1) // timeouts are never retried, body-phase included
      expect(elapsedMs).toBeLessThan(3000) // budget actually bounds the body read
    })

    it('exchange tier: body stall fails as DingTalkTimeoutError, single attempt', async () => {
      const { url, requests } = await startStallServer()

      await expect(transportCall(url, 'exchange')).rejects.toBeInstanceOf(DingTalkTimeoutError)
      expect(requests.count).toBe(1)
    })

    it('send tier: body stall fails as DingTalkTimeoutError, marked outcome-unknown (the send may have executed)', async () => {
      const { url, requests } = await startStallServer()

      let caught: unknown
      try {
        await transportCall(url, 'send')
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(DingTalkTimeoutError)
      expect(isDingTalkOutcomeUnknown(caught)).toBe(true)
      expect(requests.count).toBe(1) // never resent
    })

    it('a body stall on a NON-ok response is still a timeout (read tier: not misclassified as retryable http_500)', async () => {
      const { url, requests } = await startStallServer(500)

      await expect(transportCall(url, 'read')).rejects.toBeInstanceOf(DingTalkTimeoutError)
      expect(requests.count).toBe(1) // http_500 would have retried; timeout must not
    })
  })

  describe('pre-Node-20.3 AbortSignal.any fallback (composition + cleanup)', () => {
    // CI's test(18.x) lane exercises this path only incidentally; force it here so
    // the composition itself is pinned: with AbortSignal.any absent, the per-attempt
    // timeout must STILL fire when a caller signal is present (the naive fallback of
    // "just use the caller signal" silently drops the timeout), the caller signal
    // must still abort the in-flight attempt, and the manual composition must not
    // leak abort listeners on the long-lived caller signal across attempts.
    const abortSignalStatics = AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }
    const originalAny = abortSignalStatics.any

    beforeEach(() => {
      abortSignalStatics.any = undefined
    })

    afterEach(() => {
      abortSignalStatics.any = originalAny
    })

    /** Resolves nothing: hangs until the composed signal aborts, then rejects with its reason. */
    const hangingFetch = (guardMs: number) => vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return reject(new Error('no signal reached fetch'))
      if (signal.aborted) return reject(signal.reason)
      const guard = setTimeout(() => reject(new Error('composed signal never fired under the fallback')), guardMs)
      signal.addEventListener('abort', () => {
        clearTimeout(guard)
        reject(signal.reason)
      }, { once: true })
    })) as unknown as typeof fetch

    it('per-attempt timeout still fires when a caller signal is present (naive caller-signal-only fallback drops it)', async () => {
      const controller = new AbortController() // live, never aborted
      const fetchFn = hangingFetch(1500)

      const startedAt = Date.now()
      await expect(requestDingTalkTransportJson({
        input: 'https://oapi.dingtalk.com/gettoken?appkey=x&appsecret=y',
        init: { method: 'GET' },
        fallbackError: 'failed',
        kind: 'exchange',
        envelope: 'oapi',
        fetchFn,
        timeoutMs: 120,
        signal: controller.signal,
      })).rejects.toBeInstanceOf(DingTalkTimeoutError)

      expect(Date.now() - startedAt).toBeLessThan(1200) // timeout fired, not the guard
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('caller abort still cancels the in-flight attempt under the fallback', async () => {
      const controller = new AbortController()
      const fetchFn = hangingFetch(3000)
      setTimeout(() => controller.abort(), 60)

      const startedAt = Date.now()
      await expect(requestDingTalkTransportJson({
        input: 'https://oapi.dingtalk.com/gettoken?appkey=x&appsecret=y',
        init: { method: 'GET' },
        fallbackError: 'failed',
        kind: 'read',
        envelope: 'oapi',
        fetchFn,
        timeoutMs: 5000, // far beyond the caller abort — the caller must win
        signal: controller.signal,
      })).rejects.toBeInstanceOf(DingTalkTimeoutError)

      expect(Date.now() - startedAt).toBeLessThan(2000)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('detaches its abort listeners from the long-lived caller signal once each attempt settles (no leak)', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0) // zero backoff between attempts
      const controller = new AbortController() // long-lived, never aborted
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ message: 'limited' }, 429))
        .mockResolvedValueOnce(okDeptEnvelope()) as unknown as typeof fetch

      const payload = await requestDingTalkTransportJson({
        input: 'https://oapi.dingtalk.com/topapi/v2/department/listsub?access_token=x',
        init: { method: 'POST' },
        fallbackError: 'failed',
        kind: 'read',
        envelope: 'oapi',
        fetchFn: fetchMock,
        signal: controller.signal,
      })

      expect(payload.errcode).toBe(0)
      expect(fetchMock).toHaveBeenCalledTimes(2) // two attempts BOTH composed against the caller signal
      // once-listeners that never fired are NOT auto-removed — without explicit
      // dispose-on-settle each attempt would leave one behind on the caller signal.
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    })
  })

  describe('env knobs (DINGTALK_TRANSPORT_*)', () => {
    it('falls back to defaults on invalid values', () => {
      vi.stubEnv('DINGTALK_TRANSPORT_MAX_ATTEMPTS', 'abc')
      vi.stubEnv('DINGTALK_TRANSPORT_BACKOFF_BASE_MS', '-5')
      vi.stubEnv('DINGTALK_TRANSPORT_BACKOFF_CAP_MS', '0')
      expect(resolveDingTalkTransportConfig()).toEqual(DINGTALK_TRANSPORT_DEFAULTS)

      vi.stubEnv('DINGTALK_TRANSPORT_MAX_ATTEMPTS', '')
      vi.stubEnv('DINGTALK_TRANSPORT_BACKOFF_BASE_MS', '   ')
      vi.stubEnv('DINGTALK_TRANSPORT_BACKOFF_CAP_MS', 'Infinity')
      expect(resolveDingTalkTransportConfig()).toEqual(DINGTALK_TRANSPORT_DEFAULTS)
    })

    it('applies valid overrides (fractions truncated)', () => {
      vi.stubEnv('DINGTALK_TRANSPORT_MAX_ATTEMPTS', '5')
      vi.stubEnv('DINGTALK_TRANSPORT_BACKOFF_BASE_MS', '100.9')
      vi.stubEnv('DINGTALK_TRANSPORT_BACKOFF_CAP_MS', '2000')
      expect(resolveDingTalkTransportConfig()).toEqual({ maxAttempts: 5, backoffBaseMs: 100, backoffCapMs: 2000 })
    })

    it('DINGTALK_TRANSPORT_MAX_ATTEMPTS=1 disables read retries end-to-end', async () => {
      vi.stubEnv('DINGTALK_TRANSPORT_MAX_ATTEMPTS', '1')
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'limited' }, 429))
      vi.stubGlobal('fetch', fetchMock)

      await expect(listDingTalkDepartments('tok', '1')).rejects.toMatchObject({ statusCode: 429 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('a raised DINGTALK_TRANSPORT_MAX_ATTEMPTS bounds the loop exactly', async () => {
      vi.stubEnv('DINGTALK_TRANSPORT_MAX_ATTEMPTS', '2')
      vi.spyOn(Math, 'random').mockReturnValue(0)
      // Fresh Response per attempt — a real fetch never resolves an already-consumed
      // body, and since the body-timeout fix the transport no longer swallows the
      // double-read TypeError a shared mockResolvedValue Response would produce.
      const fetchMock = vi.fn(async () => jsonResponse({ message: 'down' }, 503))
      vi.stubGlobal('fetch', fetchMock)

      await expect(listDingTalkDepartments('tok', '1')).rejects.toMatchObject({ statusCode: 503 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('pure helpers', () => {
    it('computeDingTalkRetryDelayMs: Retry-After overrides jitter and is clamped to the cap', () => {
      const config = { maxAttempts: 3, backoffBaseMs: 300, backoffCapMs: 5000 }
      expect(computeDingTalkRetryDelayMs(1, config, 2000, () => 0)).toBe(2000)
      expect(computeDingTalkRetryDelayMs(1, config, 60_000, () => 0)).toBe(5000)
      expect(computeDingTalkRetryDelayMs(1, config, null, () => 1)).toBe(300)
      expect(computeDingTalkRetryDelayMs(2, config, null, () => 1)).toBe(600)
      expect(computeDingTalkRetryDelayMs(6, config, null, () => 1)).toBe(5000) // cap
      expect(computeDingTalkRetryDelayMs(1, config, null, () => 0)).toBe(0) // full jitter floor
    })

    it('parseRetryAfterMs: seconds, HTTP-date, and garbage', () => {
      expect(parseRetryAfterMs('2')).toBe(2000)
      expect(parseRetryAfterMs('0')).toBe(0)
      expect(parseRetryAfterMs('-1')).toBeNull()
      expect(parseRetryAfterMs('garbage')).toBeNull()
      expect(parseRetryAfterMs(null)).toBeNull()
      expect(parseRetryAfterMs(undefined)).toBeNull()
      const inThreeSeconds = new Date(Date.now() + 3000).toUTCString()
      const parsed = parseRetryAfterMs(inThreeSeconds)
      expect(parsed).not.toBeNull()
      expect(parsed as number).toBeGreaterThanOrEqual(1500)
      expect(parsed as number).toBeLessThanOrEqual(3100)
    })

    it('isDingTalkFlowControlErrcode matches the documented + delivery-layer-parity set only', () => {
      for (const code of [90018, -1, 408, 429, 500, 503, 599, 50001]) {
        expect(isDingTalkFlowControlErrcode(code), String(code)).toBe(true)
      }
      for (const code of [0, 88, 400, 404, 40001, 40035, 60020, 600, 49999]) {
        expect(isDingTalkFlowControlErrcode(code), String(code)).toBe(false)
      }
    })

    it('isDingTalkOutcomeUnknown is false for unmarked/foreign values', () => {
      expect(isDingTalkOutcomeUnknown(new Error('plain'))).toBe(false)
      expect(isDingTalkOutcomeUnknown(null)).toBe(false)
      expect(isDingTalkOutcomeUnknown(undefined)).toBe(false)
      expect(isDingTalkOutcomeUnknown('string')).toBe(false)
      expect(isDingTalkOutcomeUnknown({ outcomeUnknown: true })).toBe(true) // property form
    })
  })
})
