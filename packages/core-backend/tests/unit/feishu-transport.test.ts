/**
 * Feishu transport: redirects, the retry matrix per tier, per-attempt timeouts, the closed host set,
 * hidden response bodies, retry observation, and what the logs may carry. Requests go to a local
 * server (tests/helpers/feishu-mock-server.ts); the global fetch is wrapped so that anything outside
 * the loopback fails the test.
 */
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import {
  recordDirectoryPullRetry,
  createDirectoryPullRetryCounters,
} from '../../src/directory/directory-sync'
import {
  FEISHU_ENDPOINTS,
  __feishuEndpointsForTests,
  feishuEndpointUrl,
  isFeishuUrlAllowed,
} from '../../src/integrations/feishu/endpoints'
import {
  FeishuBusinessError,
  FeishuHostNotAllowedError,
  FeishuMalformedResponseError,
  FeishuRequestError,
  FeishuTimeoutError,
  describeFeishuFailure,
  isFeishuOutcomeUnknown,
} from '../../src/integrations/feishu/errors'
import {
  FEISHU_TRANSPORT_LIMITS,
  observeFeishuTransportRetries,
  requestFeishuJson,
  type FeishuCallKind,
  type FeishuTransportRetryEvent,
} from '../../src/integrations/feishu/transport'
import {
  installNoExternalFetchGuard,
  startFeishuMockServer,
  type MockFeishuServer,
  type MockFeishuStep,
  type NoExternalFetchGuard,
} from '../helpers/feishu-mock-server'

const KINDS: readonly FeishuCallKind[] = ['read', 'exchange', 'send']
const ROUTE = 'GET /open-apis/probe'

describe('Feishu transport', () => {
  let server: MockFeishuServer
  let guard: NoExternalFetchGuard
  let warnSpy: ReturnType<typeof vi.spyOn>
  let sleeps: number[]

  const sleep = async (ms: number): Promise<boolean> => {
    sleeps.push(ms)
    return false
  }

  const call = (kind: FeishuCallKind | undefined, extra: { timeoutMs?: number; url?: string; signal?: AbortSignal } = {}) =>
    requestFeishuJson({
      url: extra.url ?? `${server.origin}/open-apis/probe`,
      init: { method: 'GET', headers: { Authorization: 'Bearer t-fixture-token-0001' } },
      kind,
      envelope: 'open_api',
      sleep,
      random: () => 0.5,
      timeoutMs: extra.timeoutMs ?? 400,
      signal: extra.signal,
    })

  const repeat = (count: number, step: MockFeishuStep): MockFeishuStep[] => Array.from({ length: count }, () => step)
  const ok: MockFeishuStep = { kind: 'json', body: { code: 0, data: { fixture: true } } }

  async function failureOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise
    } catch (error) {
      return error
    }
    throw new Error('expected the call to fail')
  }

  beforeEach(async () => {
    sleeps = []
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined) as ReturnType<typeof vi.spyOn>
    server = await startFeishuMockServer()
    __feishuEndpointsForTests.replace(server.origins())
    guard = installNoExternalFetchGuard()
  })

  afterEach(async () => {
    guard.restore()
    __feishuEndpointsForTests.restore()
    await server.close()
    vi.restoreAllMocks()
    expect(guard.violations).toEqual([])
    expect(server.unscripted).toEqual([])
  })

  it('pins the transport constants', () => {
    expect(FEISHU_TRANSPORT_LIMITS).toEqual({
      maxAttempts: 3,
      backoffBaseMs: 300,
      backoffCapMs: 5_000,
      attemptTimeoutMs: 10_000,
      rateLimitWaitCapMs: 30_000,
    })
    expect(Object.isFrozen(FEISHU_TRANSPORT_LIMITS)).toBe(true)
  })

  it('returns the payload of a success', async () => {
    server.script(ROUTE, [ok])
    await expect(call('read')).resolves.toEqual({ code: 0, data: { fixture: true } })
    expect(server.requests[0].headers.authorization).toBe('Bearer <token>')
  })

  describe('FX-T01 redirects are never followed', () => {
    const REDIRECT_STATUSES = [301, 302, 307, 308] as const
    for (const kind of KINDS) {
      for (const status of REDIRECT_STATUSES) {
        it(`${kind} tier, HTTP ${status}: one request, a typed non-retryable failure, nothing sent to the other host`, async () => {
          const other = await startFeishuMockServer()
          try {
            other.script(ROUTE, [ok])
            server.script(ROUTE, [{ kind: 'redirect', status, location: `${other.origin}/open-apis/probe` }])
            const error = await failureOf(call(kind))
            expect(error).toBeInstanceOf(FeishuRequestError)
            expect((error as FeishuRequestError).statusCode).toBe(status)
            expect(isFeishuOutcomeUnknown(error)).toBe(false)
            expect(server.count(ROUTE)).toBe(1)
            expect(other.count()).toBe(0)
            expect(sleeps).toEqual([])
          } finally {
            await other.close()
          }
        })
      }
    }
  })

  describe('FX-T02 retry matrix', () => {
    interface Cell {
      name: string
      steps: () => MockFeishuStep[]
      timeoutMs?: number
      expectError: (error: unknown) => void
      /** Request count by tier. */
      count: Record<FeishuCallKind, number>
      unknown: Record<FeishuCallKind, boolean>
    }
    const CALLS_THREE = { read: 3, exchange: 1, send: 1 }
    const CALLS_ONE = { read: 1, exchange: 1, send: 1 }
    const UNKNOWN_ON_SEND = { read: false, exchange: false, send: true }
    const NEVER_UNKNOWN = { read: false, exchange: false, send: false }

    const cells: Cell[] = [
      {
        name: 'network error (connection destroyed)',
        steps: () => repeat(3, { kind: 'reset' }),
        expectError: (error) => expect(error).not.toBeInstanceOf(FeishuRequestError),
        count: CALLS_THREE,
        unknown: UNKNOWN_ON_SEND,
      },
      {
        name: 'timeout (never answered)',
        steps: () => repeat(3, { kind: 'hang' }),
        timeoutMs: 120,
        expectError: (error) => expect(error).toBeInstanceOf(FeishuTimeoutError),
        count: CALLS_ONE,
        unknown: UNKNOWN_ON_SEND,
      },
      {
        name: 'HTTP 429',
        steps: () => repeat(3, { kind: 'json', status: 429, body: { code: 99991400 } }),
        expectError: (error) => expect((error as FeishuRequestError).statusCode).toBe(429),
        count: CALLS_THREE,
        unknown: NEVER_UNKNOWN,
      },
      {
        name: 'body code 99991400 in an HTTP-200 envelope',
        steps: () => repeat(3, { kind: 'json', body: { code: 99991400, msg: 'frequency limit' } }),
        expectError: (error) => expect((error as FeishuBusinessError).code).toBe(99991400),
        count: CALLS_THREE,
        unknown: NEVER_UNKNOWN,
      },
      {
        name: 'body code 99991400 with HTTP 400',
        steps: () => repeat(3, { kind: 'json', status: 400, body: { code: 99991400 } }),
        expectError: (error) => expect((error as FeishuBusinessError).code).toBe(99991400),
        count: CALLS_THREE,
        unknown: NEVER_UNKNOWN,
      },
      ...[500, 502, 503, 504].map((status): Cell => ({
        name: `HTTP ${status}`,
        steps: () => repeat(3, { kind: 'json', status, body: { code: -1 } }),
        expectError: (error) => expect((error as FeishuRequestError).statusCode).toBe(status),
        count: CALLS_THREE,
        unknown: UNKNOWN_ON_SEND,
      })),
      {
        name: 'HTTP 501 (not a transient status)',
        steps: () => repeat(3, { kind: 'json', status: 501, body: { code: -1 } }),
        expectError: (error) => expect((error as FeishuRequestError).statusCode).toBe(501),
        count: CALLS_ONE,
        unknown: UNKNOWN_ON_SEND,
      },
      ...[20050, 20072].map((code): Cell => ({
        name: `body code ${code} in an HTTP-200 envelope`,
        steps: () => repeat(3, { kind: 'json', body: { code } }),
        expectError: (error) => expect((error as FeishuBusinessError).code).toBe(code),
        count: CALLS_THREE,
        unknown: UNKNOWN_ON_SEND,
      })),
      {
        name: 'HTTP 2xx with a body that is not JSON',
        steps: () => repeat(3, { kind: 'raw', body: '<html>bad gateway</html>' }),
        expectError: (error) => expect((error as FeishuMalformedResponseError).reason).toBe('unparseable_body'),
        count: CALLS_THREE,
        unknown: UNKNOWN_ON_SEND,
      },
      {
        name: 'HTTP 2xx JSON object without the envelope code',
        steps: () => repeat(3, { kind: 'json', body: { data: {} } }),
        expectError: (error) => expect((error as FeishuMalformedResponseError).reason).toBe('missing_code'),
        count: CALLS_THREE,
        unknown: UNKNOWN_ON_SEND,
      },
      ...[99991661, 99991663, 99991664, 99991665, 99991671, 20013].map((code): Cell => ({
        name: `token-refused code ${code} (replayed by the client layer, never here)`,
        steps: () => repeat(3, { kind: 'json', status: 400, body: { code } }),
        expectError: (error) => expect((error as FeishuBusinessError).code).toBe(code),
        count: CALLS_ONE,
        unknown: NEVER_UNKNOWN,
      })),
      {
        name: 'any other code that is not 0',
        steps: () => repeat(3, { kind: 'json', status: 400, body: { code: 230013 } }),
        expectError: (error) => expect((error as FeishuBusinessError).code).toBe(230013),
        count: CALLS_ONE,
        unknown: NEVER_UNKNOWN,
      },
      {
        name: 'an error status without a code',
        steps: () => repeat(3, { kind: 'json', status: 403, body: {} }),
        expectError: (error) => expect((error as FeishuRequestError).statusCode).toBe(403),
        count: CALLS_ONE,
        unknown: NEVER_UNKNOWN,
      },
    ]

    for (const cell of cells) {
      for (const kind of KINDS) {
        it(`${kind}: ${cell.name} -> ${cell.count[kind]} request(s), outcome unknown ${cell.unknown[kind]}`, async () => {
          server.script(ROUTE, cell.steps())
          const error = await failureOf(call(kind, { timeoutMs: cell.timeoutMs }))
          cell.expectError(error)
          expect(server.count(ROUTE)).toBe(cell.count[kind])
          expect(isFeishuOutcomeUnknown(error)).toBe(cell.unknown[kind])
        })
      }
    }

    it('an undeclared tier is an exchange: no retry', async () => {
      server.script(ROUTE, repeat(3, { kind: 'reset' }))
      await failureOf(call(undefined))
      expect(server.count(ROUTE)).toBe(1)
    })

    it('a read that succeeds on a later attempt returns the success', async () => {
      server.script(ROUTE, [{ kind: 'json', status: 503, body: {} }, { kind: 'reset' }, ok])
      await expect(call('read')).resolves.toEqual({ code: 0, data: { fixture: true } })
      expect(server.count(ROUTE)).toBe(3)
    })

    it('waits for the reset hint on a rate limit, capped, and backs off when the hint is absent', async () => {
      server.script(ROUTE, [
        { kind: 'json', status: 429, body: {}, headers: { 'x-ogw-ratelimit-reset': '2' } },
        { kind: 'json', status: 429, body: {}, headers: { 'x-ogw-ratelimit-reset': '100' } },
        ok,
      ])
      await call('read')
      expect(sleeps).toEqual([2_000, 30_000])

      sleeps = []
      server.script(ROUTE, [{ kind: 'json', status: 429, body: {} }, { kind: 'json', status: 429, body: {} }, ok])
      await call('read')
      // random() is 0.5: half of min(cap, base * 2^(attempt - 1))
      expect(sleeps).toEqual([150, 300])
    })

    it('does not start a request when the caller signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      const error = await failureOf(call('read', { signal: controller.signal }))
      expect(error).toBeInstanceOf(FeishuTimeoutError)
      expect(server.count()).toBe(0)
    })
  })

  describe('FX-T03 the attempt budget covers the body and is per attempt', () => {
    it('a body that stalls after the headers ends as a timeout, not retried', async () => {
      server.script(ROUTE, repeat(3, { kind: 'stall-body' }))
      const started = Date.now()
      const error = await failureOf(call('read', { timeoutMs: 150 }))
      expect(error).toBeInstanceOf(FeishuTimeoutError)
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(server.count(ROUTE)).toBe(1)
    }, 4_000)

    it('a request that never answers ends as the same timeout error', async () => {
      server.script(ROUTE, [{ kind: 'hang' }])
      const error = await failureOf(call('read', { timeoutMs: 150 }))
      expect(error).toBeInstanceOf(FeishuTimeoutError)
    }, 4_000)

    it('each attempt has its own timer: slow-but-in-budget attempts add up beyond one budget', async () => {
      server.script(ROUTE, [
        { kind: 'json', status: 503, body: {}, delayMs: 100 },
        { kind: 'json', status: 503, body: {}, delayMs: 100 },
        { kind: 'json', body: { code: 0 }, delayMs: 100 },
      ])
      const started = Date.now()
      await expect(call('read', { timeoutMs: 180 })).resolves.toEqual({ code: 0 })
      expect(Date.now() - started).toBeGreaterThanOrEqual(280)
      expect(server.count(ROUTE)).toBe(3)
    }, 4_000)

    it('a connection cut in the middle of the body is a network failure (read: retried)', async () => {
      server.script(ROUTE, repeat(3, { kind: 'truncate' }))
      const error = await failureOf(call('read'))
      expect(error).not.toBeInstanceOf(FeishuTimeoutError)
      expect(server.count(ROUTE)).toBe(3)
    })
  })

  describe('FX-T05 the closed host set', () => {
    const REFUSED = [
      'https://open.feishu.cn.evil.example/open-apis/x',
      'https://evilopen.feishu.cn/open-apis/x',
      'https://open.feishu.cn@evil.example/open-apis/x',
      'https://user:pw@open.feishu.cn/open-apis/x',
      'http://open.feishu.cn/open-apis/x',
      'https://open.feishu.cn:8443/open-apis/x',
      'https://accounts.feishu.cn.evil.example/oauth/v3/token',
      'ftp://open.feishu.cn/open-apis/x',
      'http://127.0.0.1:9/open-apis/x',
      'open.feishu.cn/open-apis/x',
      '',
    ]

    it('refuses every foreign, spoofed, credentialed or non-https target before any request (production table)', async () => {
      __feishuEndpointsForTests.restore()
      const fetchFn = vi.fn()
      for (const target of REFUSED) {
        for (const kind of KINDS) {
          const error = await failureOf(
            requestFeishuJson({ url: target, kind, envelope: 'open_api', fetchFn: fetchFn as unknown as typeof fetch }),
          )
          expect(error, target).toBeInstanceOf(FeishuHostNotAllowedError)
        }
        expect(isFeishuUrlAllowed(target), target).toBe(false)
      }
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('accepts the two production origins and sends the request with redirects set to manual', async () => {
      __feishuEndpointsForTests.restore()
      const seen: Array<{ url: string; init: RequestInit }> = []
      const fetchFn = (async (url: string, init: RequestInit) => {
        seen.push({ url, init })
        return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch
      for (const target of [
        feishuEndpointUrl('feishu', FEISHU_ENDPOINTS.tenantQuery),
        feishuEndpointUrl('feishu', FEISHU_ENDPOINTS.tenantAccessToken),
      ]) {
        expect(isFeishuUrlAllowed(target)).toBe(true)
        await requestFeishuJson({ url: target, kind: 'read', envelope: 'open_api', fetchFn })
      }
      expect(seen).toHaveLength(2)
      for (const entry of seen) expect(entry.init.redirect).toBe('manual')
    })

    it('a caller cannot override redirect handling', async () => {
      const seen: RequestInit[] = []
      const fetchFn = (async (_url: string, init: RequestInit) => {
        seen.push(init)
        return new Response(JSON.stringify({ code: 0 }), { status: 200 })
      }) as unknown as typeof fetch
      await requestFeishuJson({
        url: `${server.origin}/open-apis/probe`,
        init: { method: 'GET', redirect: 'follow' } as RequestInit,
        kind: 'read',
        envelope: 'open_api',
        fetchFn,
      })
      expect(seen[0].redirect).toBe('manual')
    })

    it('the test seam takes loopback origins only', () => {
      expect(() => __feishuEndpointsForTests.replace({ openApi: 'https://open.feishu.cn', accounts: 'https://accounts.feishu.cn' })).toThrow()
      expect(() => __feishuEndpointsForTests.replace({ openApi: 'http://192.0.2.1:80', accounts: 'http://127.0.0.1:80' })).toThrow()
    })
  })

  describe('FX-T07 error objects do not carry the response body in any serialisation', () => {
    const SECRETISH = 'provider-text-with-secret-looking-value'

    it('business and status errors', async () => {
      server.script(ROUTE, [
        { kind: 'json', status: 400, body: { code: 230013, msg: SECRETISH, log_id: 'req-log-id' } },
        { kind: 'json', status: 403, body: { msg: SECRETISH, log_id: 'req-log-id' } },
      ])
      const business = (await failureOf(call('send'))) as FeishuBusinessError
      const status = (await failureOf(call('send'))) as FeishuRequestError
      for (const error of [business, status]) {
        for (const text of [
          JSON.stringify(error),
          JSON.stringify({ error }),
          JSON.stringify({ ...error }),
          inspect(error),
          inspect({ error }),
          error.message,
        ]) {
          expect(text).not.toContain(SECRETISH)
          expect(text).not.toContain('req-log-id')
        }
        expect(Object.keys(error)).not.toContain('responseBody')
        expect(Object.getOwnPropertyDescriptor(error, 'responseBody')).toMatchObject({ enumerable: false, writable: false })
        expect(() => {
          ;(error as { responseBody: unknown }).responseBody = null
        }).toThrow()
      }
      expect(business.responseBody).toMatchObject({ code: 230013, msg: SECRETISH })
      expect(status.responseBody).toMatchObject({ msg: SECRETISH })
    })
  })

  describe('FX-T09 retry observation', () => {
    it('reports each retry with a fixed reason, and the reasons land in the four directory buckets', async () => {
      const events: FeishuTransportRetryEvent[] = []
      const observe = (run: () => Promise<unknown>) => observeFeishuTransportRetries((event) => events.push(event), run)
      server.script(ROUTE, [{ kind: 'json', status: 429, body: {} }, ok])
      await observe(() => call('read'))
      server.script(ROUTE, [{ kind: 'json', body: { code: 99991400 } }, ok])
      await observe(() => call('read'))
      server.script(ROUTE, [{ kind: 'reset' }, ok])
      await observe(() => call('read'))
      server.script(ROUTE, [{ kind: 'json', status: 500, body: {} }, ok])
      await observe(() => call('read'))

      expect(events.map((event) => event.reason)).toEqual(['http_429', 'flow_control_errcode_99991400', 'network_error', 'http_500'])
      expect(events.every((event) => event.kind === 'read' && event.attempt === 1)).toBe(true)

      const counters = createDirectoryPullRetryCounters()
      for (const event of events) recordDirectoryPullRetry(counters, event)
      expect(counters).toEqual({ total: 4, flowControl: 1, http429: 1, network: 1, other: 1 })
    })

    it('an observer that throws changes nothing; calls outside the context are not reported', async () => {
      server.script(ROUTE, [{ kind: 'json', status: 503, body: {} }, ok])
      await expect(
        observeFeishuTransportRetries(() => {
          throw new Error('observer failure')
        }, () => call('read')),
      ).resolves.toMatchObject({ code: 0 })

      const events: FeishuTransportRetryEvent[] = []
      server.script(ROUTE, [{ kind: 'json', status: 503, body: {} }, ok])
      await observeFeishuTransportRetries((event) => events.push(event), async () => undefined)
      await call('read')
      expect(events).toEqual([])
    })
  })

  describe('failure sentences and logs', () => {
    it('carry fixed text and numeric codes only', async () => {
      server.script(ROUTE, [{ kind: 'json', status: 400, body: { code: 230013, msg: 'provider text', log_id: 'req-1' } }])
      const business = await failureOf(call('send'))
      expect(describeFeishuFailure(business, 'Send failed')).toBe('Send failed: Feishu rejected the request (code 230013)')
      expect(describeFeishuFailure(new FeishuRequestError(502, { msg: 'provider text' }), 'Read failed')).toBe(
        'Read failed: Feishu answered with an error status (HTTP 502)',
      )
      expect(describeFeishuFailure(new FeishuTimeoutError(10), 'Read failed')).toBe('Read failed: Feishu did not answer in time')
      expect(describeFeishuFailure(new FeishuMalformedResponseError('unparseable_body', 200), 'Read failed')).toBe(
        'Read failed: Feishu returned an unusable response (HTTP 200)',
      )
      expect(describeFeishuFailure(new Error('driver text with host db.internal'), 'Read failed')).toBe('Read failed')
    })

    it('the retry warn line carries no provider text, no credential and no URL', async () => {
      server.script(ROUTE, [
        { kind: 'json', status: 503, body: { msg: 'provider text with secret-ish value' } },
        { kind: 'json', status: 429, body: { msg: 'provider text with secret-ish value' } },
        ok,
      ])
      await call('read')
      expect(warnSpy).toHaveBeenCalledTimes(2)
      const lines = warnSpy.mock.calls.map((args) => JSON.stringify(args))
      for (const line of lines) {
        expect(line).not.toContain('secret-ish')
        expect(line).not.toContain('t-fixture-token-0001')
        expect(line).not.toContain('127.0.0.1')
        expect(line).not.toContain('/open-apis/')
      }
      expect(lines[0]).toContain('after http_503 (read)')
    })
  })
})
