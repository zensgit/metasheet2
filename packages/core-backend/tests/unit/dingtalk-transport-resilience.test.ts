import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import {
  DingTalkBusinessError,
  DingTalkRequestError,
  DingTalkTimeoutError,
  __resetDingTalkAppAccessTokenCacheForTests,
  fetchDingTalkAppAccessToken,
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
 * the ONE seam every client.ts call goes through. The safety matrix under test:
 *
 *   idempotent-read       → retried on network error, HTTP 429, HTTP 5xx, and
 *                           flow-control errcodes in HTTP-200 envelopes
 *   non-idempotent-write  → retried ONLY on network-error-before-response and 429
 *   per-attempt timeout   → never retried (either class)
 *
 * Error shapes after exhaustion/non-retryable failures must be IDENTICAL to the
 * pre-retry client (callers pattern-match DingTalkRequestError/BusinessError).
 */

const MESSAGE_CONFIG = { appKey: 'k', appSecret: 's', agentId: '42' }
const NOTIFICATION = { userIds: ['u1'], title: 'T', content: 'C' }

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

const okSendEnvelope = () => jsonResponse({ errcode: 0, errmsg: 'ok', task_id: 7 })

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

  describe('idempotent reads', () => {
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
      expect(retryLogs()).toEqual([expect.stringMatching(/retry 2\/3 after http_429 \(idempotent-read\)/)])
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

    it('exhausted retries rethrow the ORIGINAL error shape (statusCode + responseBody intact), one warn per retry', async () => {
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

  describe('non-idempotent writes (sends)', () => {
    it('does NOT retry HTTP 5xx (duplicate notification risk) and throws today\'s error shape', async () => {
      const fetchFn = vi.fn(async () => jsonResponse({ message: 'boom' }, 500)) as unknown as typeof fetch

      await expect(sendDingTalkWorkNotification('tok', NOTIFICATION, MESSAGE_CONFIG, { fetchFn }))
        .rejects.toMatchObject({ name: 'DingTalkRequestError', statusCode: 500, message: 'boom' })
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(retryLogs()).toEqual([])
    })

    it('does NOT retry a flow-control errcode on a send (app layer may have processed it)', async () => {
      const fetchFn = vi.fn(async () => jsonResponse({ errcode: 90018, errmsg: '流控' })) as unknown as typeof fetch

      await expect(sendDingTalkWorkNotification('tok', NOTIFICATION, MESSAGE_CONFIG, { fetchFn }))
        .rejects.toBeInstanceOf(DingTalkBusinessError)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('DOES retry a network error before any response was received', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const fetchFn = vi.fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(okSendEnvelope()) as unknown as typeof fetch

      const result = await sendDingTalkWorkNotification('tok', NOTIFICATION, MESSAGE_CONFIG, { fetchFn })

      expect(result.taskId).toBe('7')
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(retryLogs()).toEqual([expect.stringMatching(/network_error \(non-idempotent-write\)/)])
    })

    it('DOES retry HTTP 429 (rejected before processing)', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ message: 'limited' }, 429))
        .mockResolvedValueOnce(okSendEnvelope()) as unknown as typeof fetch

      const result = await sendDingTalkWorkNotification('tok', NOTIFICATION, MESSAGE_CONFIG, { fetchFn })

      expect(result.taskId).toBe('7')
      expect(fetchFn).toHaveBeenCalledTimes(2)
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
        safety: 'idempotent-read',
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
        safety: 'idempotent-read',
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
        safety: 'idempotent-read',
        envelope: 'oapi',
        fetchFn,
        timeoutMs: 120,
      })

      expect(payload.errcode).toBe(0)
      expect(seenAborted).toEqual([false, false])
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

    it('DINGTALK_TRANSPORT_MAX_ATTEMPTS=1 disables retries end-to-end', async () => {
      vi.stubEnv('DINGTALK_TRANSPORT_MAX_ATTEMPTS', '1')
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'limited' }, 429))
      vi.stubGlobal('fetch', fetchMock)

      await expect(listDingTalkDepartments('tok', '1')).rejects.toMatchObject({ statusCode: 429 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('a raised DINGTALK_TRANSPORT_MAX_ATTEMPTS bounds the loop exactly', async () => {
      vi.stubEnv('DINGTALK_TRANSPORT_MAX_ATTEMPTS', '2')
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'down' }, 503))
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
  })
})
