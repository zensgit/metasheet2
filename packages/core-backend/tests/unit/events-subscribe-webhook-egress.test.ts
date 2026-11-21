/**
 * POST /api/events/subscribe — webhook delivery goes through the S0-a egress guard (2026-11-17).
 *
 * Before this slice the delivery closure in `routes/events.ts` called the platform `fetch(webhookUrl)`
 * directly: no address check, no resolve-then-pin, the platform's default redirect FOLLOW (a 307/308
 * re-sends the POST body to a `Location` nobody judged), and a free-text error log that, for a userinfo
 * URL, quotes the whole URL. The endpoint is authenticated and admin-only, so this was a missed guard, not
 * a privilege escalation — but `/emit` and `/replay` let the same admin re-trigger the server-side POST at
 * will.
 *
 * The fix reuses S0-a AS IS (the same policy as the other three webhook egress paths — no allowlist, no
 * flag, no env): `checkWebhookTargetUrlShape` as an early 400 at subscribe, `checkWebhookTargetUrl` on
 * EVERY delivery, `pinnedHttpsFetch` to the approved address, a 3xx refused and never followed, and
 * closed-set labels in every log line and every thrown message.
 *
 * Driven through the real router (pinned per-suite server, #4154) with the event bus mocked so the
 * delivery closure handed to `eventBus.subscribe` can be invoked directly. `fetch` is ALWAYS stubbed, so
 * neither the red run on the pre-fix code nor any run after it can make a real request or DNS lookup;
 * after the fix it must never be called at all.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const PUBLIC_A = '93.184.216.34'
const PUBLIC_B = '2606:2800:220:1:248:1893:25c8:1946'
const PUBLIC_NAME_URL = 'https://hooks.example.test/in'
const SECRET_MARK = 'S3cr3tPw0rd'
const USERINFO_URL = `https://svc:${SECRET_MARK}@hooks.example.test/in?token=${SECRET_MARK}`

type CapturedHandler = (event: unknown, context: unknown) => Promise<unknown>

const pinned = usePinnedServer()

interface Mounted {
  subscribe: ReturnType<typeof vi.fn>
  handlers: CapturedHandler[]
  subscribeOptions: unknown[]
  fetchSpy: ReturnType<typeof vi.fn>
  logCalls: unknown[][]
}

interface MountOpts {
  /** Replaces `pinnedHttpsFetch` in its module (the transport the handler uses when no seam is injected). */
  mockPinnedModule?: ReturnType<typeof vi.fn>
  /**
   * Replaces `lookup` in `node:dns/promises`, the module the S0-a guard's DEFAULT resolver calls. With
   * this, a zero-seam mount (`eventsRouter()` exactly as `index.ts` mounts it) still makes no real DNS
   * lookup: the system resolver it reaches is this mock.
   */
  mockDnsLookup?: ReturnType<typeof vi.fn>
}

async function mount(deps: Record<string, unknown> | undefined, opts: MountOpts = {}): Promise<Mounted> {
  vi.resetModules()
  const handlers: CapturedHandler[] = []
  const subscribeOptions: unknown[] = []
  const subscribe = vi.fn(async (_sid: string, _pattern: string, handler: CapturedHandler, options?: unknown) => {
    handlers.push(handler)
    subscribeOptions.push(options)
    return `sub_${handlers.length}`
  })
  vi.doMock('../../src/core/EventBusService', () => ({ eventBus: { subscribe } }))
  vi.doMock('../../src/db/db', () => ({ db: {} }))
  vi.doMock('../../src/middleware/auth', () => {
    const authenticate = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: 'admin_1', role: 'admin', roles: ['admin'], perms: ['*:*'] } as never
      next()
    }
    return { authenticate, authMiddleware: authenticate, default: authenticate }
  })
  vi.doMock('../../src/rbac/service', () => ({ isAdmin: vi.fn().mockResolvedValue(true) }))
  if (opts.mockPinnedModule) {
    const replacement = opts.mockPinnedModule
    vi.doMock('../../src/multitable/webhook-pinned-fetch', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      pinnedHttpsFetch: replacement,
    }))
  }
  if (opts.mockDnsLookup) {
    const lookup = opts.mockDnsLookup
    vi.doMock('node:dns/promises', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>()
      return { ...actual, lookup, default: { ...((actual.default as Record<string, unknown>) ?? {}), lookup } }
    })
  }

  // Tripwire: the platform fetch must never carry a subscription delivery (it re-resolves and follows).
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, type: 'basic' }))
  vi.stubGlobal('fetch', fetchSpy)

  const logCalls: unknown[][] = []
  const { Logger } = await import('../../src/core/logger')
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(((...args: unknown[]) => {
      logCalls.push([level, ...args])
    }) as never)
  }

  const { eventsRouter } = await import('../../src/routes/events')
  const app = express()
  app.use(express.json())
  app.use((eventsRouter as (d?: unknown) => express.Router)(deps))
  pinned.setApp(app)
  return { subscribe, handlers, subscribeOptions, fetchSpy, logCalls }
}

function subscribeBody(webhookUrl: string, options?: Record<string, unknown>) {
  return { subscriberId: 'ops-subscriber', eventPattern: 'record.created', webhookUrl, ...(options ? { options } : {}) }
}

const EVENT = { event_id: 'evt_1', event_name: 'record.created', payload: { recordId: 'rec_1' } }

function lookupReturning(...answers: Array<Array<{ address: string; family: number }> | Error>) {
  let i = 0
  return vi.fn(async (_host: string) => {
    const answer = answers[Math.min(i, answers.length - 1)]
    i += 1
    if (answer instanceof Error) throw answer
    return answer
  })
}

function okSend(status = 200) {
  return vi.fn(async () => ({ status, ok: status >= 200 && status < 300 }))
}

async function subscribeOk(m: Mounted, url: string, options?: Record<string, unknown>): Promise<CapturedHandler> {
  const res = await request(pinned.url()).post('/api/events/subscribe').send(subscribeBody(url, options))
  expect(res.status).toBe(200)
  expect(m.subscribe).toHaveBeenCalledTimes(1)
  return m.handlers[0]
}

function serializedLogs(m: Mounted): string {
  return JSON.stringify(m.logCalls.map((c) => c.map((v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v))))
}

describe('POST /api/events/subscribe — S0-a egress guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    // `vi.doMock` registrations survive `resetModules`; drop the optional ones so no case inherits them.
    vi.doUnmock('../../src/multitable/webhook-pinned-fetch')
    vi.doUnmock('node:dns/promises')
    vi.resetModules()
  })

  describe('subscribe-time early error (URL shape only, no DNS)', () => {
    const refused: Array<[string, string, string]> = [
      ['http scheme', 'http://hooks.example.test/in', 'scheme-not-allowed'],
      ['loopback literal', 'https://127.0.0.1/in', 'loopback'],
      ['loopback over http', 'http://127.0.0.1:8900/in', 'loopback'],
      ['private literal', 'https://10.1.2.3/in', 'private'],
      ['private 192.168 literal', 'https://192.168.1.10/in', 'private'],
      ['link-local / metadata literal', 'https://169.254.169.254/latest/meta-data', 'link-local'],
      ['IPv6 loopback literal', 'https://[::1]/in', 'loopback'],
      ['IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/in', 'loopback'],
      ['IPv6 unique-local literal', 'https://[fd00::1]/in', 'unique-local'],
      ['localhost name', 'https://localhost/in', 'loopback'],
      ['*.internal name', 'https://svc.cluster.internal/in', 'internal-name'],
    ]
    for (const [label, url, refusalClass] of refused) {
      it(`refuses ${label} with a values-free 400 before eventBus.subscribe`, async () => {
        const send = okSend()
        const lookup = lookupReturning([{ address: PUBLIC_A, family: 4 }])
        const m = await mount({ ssrfLookupFn: lookup, pinnedSendFn: send })
        const res = await request(pinned.url()).post('/api/events/subscribe').send(subscribeBody(url))
        expect(res.status).toBe(400)
        // Whole body: nothing beyond the closed-set token may ride along (a raw-URL echo included).
        expect(res.body).toEqual({ ok: false, error: { code: 'WEBHOOK_TARGET_REJECTED', refusalClass } })
        expect(res.text).not.toContain(new URL(url).hostname.replace(/^\[|\]$/g, ''))
        expect(m.subscribe).not.toHaveBeenCalled()
        expect(lookup).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
        expect(m.fetchSpy).not.toHaveBeenCalled()
      })
    }

    it('refuses URL userinfo with a values-free 400 (pinnedHttpsFetch refuses it at send; surfaced early)', async () => {
      const send = okSend()
      const m = await mount({ ssrfLookupFn: lookupReturning([{ address: PUBLIC_A, family: 4 }]), pinnedSendFn: send })
      const res = await request(pinned.url()).post('/api/events/subscribe').send(subscribeBody(USERINFO_URL))
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ ok: false, error: { code: 'VALIDATION_ERROR', reason: 'url-credentials-not-allowed' } })
      expect(res.text).not.toContain(SECRET_MARK)
      expect(m.subscribe).not.toHaveBeenCalled()
      expect(serializedLogs(m)).not.toContain(SECRET_MARK)
    })

    it('accepts a public https name without resolving it (the same posture S0-a gives the other webhook paths)', async () => {
      const lookup = lookupReturning([{ address: PUBLIC_A, family: 4 }])
      const m = await mount({ ssrfLookupFn: lookup, pinnedSendFn: okSend() })
      await subscribeOk(m, PUBLIC_NAME_URL)
      expect(lookup).not.toHaveBeenCalled()
    })
  })

  describe('delivery-time gate (every delivery, pinned, no redirect)', () => {
    it('refuses a public-looking name that resolves to a private address: nothing is sent', async () => {
      const send = okSend()
      const m = await mount({ ssrfLookupFn: lookupReturning([{ address: PUBLIC_A, family: 4 }, { address: '10.0.0.5', family: 4 }]), pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      await expect(handler(EVENT, {})).rejects.toThrow(/^WEBHOOK_TARGET_REJECTED:dns-resolved-internal$/)
      expect(send).not.toHaveBeenCalled()
      expect(m.fetchSpy).not.toHaveBeenCalled()
    })

    it('refuses a name that resolves to the metadata / link-local address', async () => {
      const send = okSend()
      const m = await mount({ ssrfLookupFn: lookupReturning([{ address: '169.254.169.254', family: 4 }]), pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      await expect(handler(EVENT, {})).rejects.toThrow(/^WEBHOOK_TARGET_REJECTED:dns-resolved-internal$/)
      expect(send).not.toHaveBeenCalled()
      expect(m.fetchSpy).not.toHaveBeenCalled()
    })

    it('refuses a name that resolves to loopback (IPv6)', async () => {
      const send = okSend()
      const m = await mount({ ssrfLookupFn: lookupReturning([{ address: '::1', family: 6 }]), pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      await expect(handler(EVENT, {})).rejects.toThrow(/^WEBHOOK_TARGET_REJECTED:dns-resolved-internal$/)
      expect(send).not.toHaveBeenCalled()
    })

    it('fails closed when the name does not resolve', async () => {
      const send = okSend()
      const m = await mount({ ssrfLookupFn: lookupReturning(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })), pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      await expect(handler(EVENT, {})).rejects.toThrow(/^WEBHOOK_TARGET_REJECTED:dns-unresolved$/)
      expect(send).not.toHaveBeenCalled()
      expect(m.fetchSpy).not.toHaveBeenCalled()
    })

    it('connects to the PINNED address the gate approved, with the event as the JSON body and a bounded timeout', async () => {
      const send = okSend()
      const lookup = lookupReturning([{ address: PUBLIC_A, family: 4 }])
      const m = await mount({ ssrfLookupFn: lookup, pinnedSendFn: send, now: () => 1_000 })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      await expect(handler(EVENT, {})).resolves.toBe(true)
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(lookup).toHaveBeenCalledWith('hooks.example.test')
      expect(send).toHaveBeenCalledTimes(1)
      const [url, pin, family, sendOpts] = send.mock.calls[0] as unknown as [string, string, number, Record<string, unknown>]
      expect(url).toBe(PUBLIC_NAME_URL)
      expect(pin).toBe(PUBLIC_A)
      expect(family).toBe(4)
      expect(sendOpts.method).toBe('POST')
      expect(sendOpts.body).toBe(JSON.stringify(EVENT))
      expect(sendOpts.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(sendOpts.timeoutMs).toBe(5000)
      expect(sendOpts.responseBodyLimit).toBeUndefined()
      expect(m.fetchSpy).not.toHaveBeenCalled()
    })

    it('pins an IPv6 answer with family 6 and honours the subscription timeout_ms', async () => {
      const send = okSend()
      const m = await mount({ ssrfLookupFn: lookupReturning([{ address: PUBLIC_B, family: 6 }]), pinnedSendFn: send, now: () => 1_000 })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL, { timeout_ms: 2500 })
      await handler(EVENT, {})
      const [, pin, family, sendOpts] = send.mock.calls[0] as unknown as [string, string, number, Record<string, unknown>]
      expect(pin).toBe(PUBLIC_B)
      expect(family).toBe(6)
      expect(sendOpts.timeoutMs).toBe(2500)
    })

    it('DNS rebinding: delivery 1 goes to the public pin; delivery 2 re-resolves privately and is refused', async () => {
      const send = okSend()
      const lookup = lookupReturning([{ address: PUBLIC_A, family: 4 }], [{ address: '127.0.0.1', family: 4 }])
      const m = await mount({ ssrfLookupFn: lookup, pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      await expect(handler(EVENT, {})).resolves.toBe(true)
      // One resolution for delivery 1, and the transport was handed THAT answer: it never re-resolves.
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledTimes(1)
      expect((send.mock.calls[0] as unknown[])[1]).toBe(PUBLIC_A)
      await expect(handler(EVENT, {})).rejects.toThrow(/^WEBHOOK_TARGET_REJECTED:dns-resolved-internal$/)
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledTimes(1)
      expect(m.fetchSpy).not.toHaveBeenCalled()
    })

    // Every 3xx, not only the four that re-send a body: 300/303/304 are refused on the status alone too.
    const REDIRECT_QUERY_MARK = 'QmarkR3d1r'
    for (const status of [300, 301, 302, 303, 304, 307, 308]) {
      it(`a ${status} is refused, never followed: exactly one send, Location never read, no target in the logs`, async () => {
        let headersRead = 0
        const response = {
          status,
          ok: false,
          get headers() {
            headersRead += 1
            return { get: () => 'https://other.example.test/x', location: 'https://other.example.test/x' }
          },
        }
        const send = vi.fn(async () => response)
        const m = await mount({ ssrfLookupFn: lookupReturning([{ address: PUBLIC_A, family: 4 }]), pinnedSendFn: send })
        // The subscribed URL carries a query marker: a subscribed URL may carry a token in its query.
        const handler = await subscribeOk(m, `${PUBLIC_NAME_URL}?sig=${REDIRECT_QUERY_MARK}`)
        await expect(handler(EVENT, {})).rejects.toThrow(/^WEBHOOK_TARGET_REJECTED:redirect-not-allowed$/)
        expect(send).toHaveBeenCalledTimes(1)
        expect(headersRead).toBe(0)
        expect(m.fetchSpy).not.toHaveBeenCalled()
        const logs = serializedLogs(m)
        expect(logs).toContain('redirect-not-allowed')
        expect(logs).not.toContain('other.example.test')
        expect(logs).not.toContain('hooks.example.test')
        expect(logs).not.toContain(REDIRECT_QUERY_MARK)
      })
    }

    it('a non-2xx answer stays a false return (bookkeeping unchanged), still pinned and still no fetch', async () => {
      const send = okSend(500)
      const m = await mount({ ssrfLookupFn: lookupReturning([{ address: PUBLIC_A, family: 4 }]), pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      await expect(handler(EVENT, {})).resolves.toBe(false)
      expect(send).toHaveBeenCalledTimes(1)
      expect(m.fetchSpy).not.toHaveBeenCalled()
    })

    it('a transport error throws a closed-set code, and no log line or thrown message quotes the URL', async () => {
      const send = vi.fn(async (url: string) => {
        throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url} ${SECRET_MARK}`)
      })
      const m = await mount({ ssrfLookupFn: lookupReturning([{ address: PUBLIC_A, family: 4 }]), pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      let thrown: unknown
      try {
        await handler(EVENT, {})
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toBe('EVENT_WEBHOOK_DELIVERY_FAILED:invalid-request')
      expect((thrown as Error).message).not.toContain(SECRET_MARK)
      expect((thrown as { cause?: unknown }).cause).toBeUndefined()
      const logs = serializedLogs(m)
      expect(logs).not.toContain(SECRET_MARK)
      expect(logs).not.toContain('hooks.example.test')
      expect(m.fetchSpy).not.toHaveBeenCalled()
    })

    it('a refusal log carries closed-set labels and identifiers only', async () => {
      const m = await mount({ ssrfLookupFn: lookupReturning([{ address: '10.9.9.9', family: 4 }]), pinnedSendFn: okSend() })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      await expect(handler(EVENT, {})).rejects.toThrow()
      const logs = serializedLogs(m)
      expect(logs).toContain('dns-resolved-internal')
      expect(logs).not.toContain('hooks.example.test')
      expect(logs).not.toContain('10.9.9.9')
    })
  })

  // Review P2 (2026-11-21): the name resolution used to sit OUTSIDE the transport's timer, and the bus's
  // `executeWithTimeout` (EventBusService) is a `Promise.race` that books the failure but never cancels the
  // handler — so a resolver slower than the budget let the bus record `success = false` and the handler then
  // send anyway. One deadline now covers the resolution and the exchange; a late answer sends nothing.
  describe('one deadline for the resolution and the exchange', () => {
    type Answer = Array<{ address: string; family: number }>
    function deferredLookup() {
      const pending: Array<(a: Answer) => void> = []
      const fn = vi.fn((_host: string) => new Promise<Answer>((resolve) => { pending.push(resolve) }))
      return { fn, release: (a: Answer) => pending.forEach((r) => r(a)) }
    }
    function failedLines(m: Mounted) {
      return m.logCalls.filter((c) => c[1] === '[events.webhook.failed]')
    }

    afterEach(() => {
      vi.useRealTimers()
    })

    it('a resolution slower than the budget: rejected at the deadline, and the late answer sends NOTHING', async () => {
      const send = okSend()
      const dns = deferredLookup()
      const m = await mount({ ssrfLookupFn: dns.fn, pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL, { timeout_ms: 1000 })
      vi.useFakeTimers()
      let outcome: string | undefined
      void handler(EVENT, {}).then(() => { outcome = 'resolved' }, (e: Error) => { outcome = e.message })
      await vi.advanceTimersByTimeAsync(999)
      expect(outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome).toBe('EVENT_WEBHOOK_DELIVERY_FAILED:timeout')
      // The resolver answers late, with a public address the gate would have approved.
      dns.release([{ address: PUBLIC_A, family: 4 }])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(dns.fn).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
      expect(m.fetchSpy).not.toHaveBeenCalled()
      expect(failedLines(m)).toHaveLength(1)
      expect(failedLines(m)[0][2]).toEqual({ failureClass: 'timeout', hostFamily: 'name', subscriberId: 'ops-subscriber' })
      expect(serializedLogs(m)).not.toContain('hooks.example.test')
    })

    it('under the bus race (handler called first, same timeout_ms): the bus books the handler\'s closed-set timeout and nothing is sent after it', async () => {
      const send = okSend()
      const dns = deferredLookup()
      const m = await mount({ ssrfLookupFn: dns.fn, pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL, { timeout_ms: 1000 })
      vi.useFakeTimers()
      // Same shape and order as EventBusService.processEvent → executeWithTimeout(handler(event, ctx), timeout_ms):
      // the handler is called first, then the race timer is armed.
      const handlerPromise = handler(EVENT, {})
      const busTimer = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Handler timeout')), 1000)
      })
      let booked: string | undefined
      void Promise.race([handlerPromise, busTimer]).then(
        () => { booked = 'success' },
        (e: Error) => { booked = e.message },
      )
      await vi.advanceTimersByTimeAsync(1000)
      // What the bus would persist as the delivery's error: the handler's closed-set token, not the bus's own.
      expect(booked).toBe('EVENT_WEBHOOK_DELIVERY_FAILED:timeout')
      dns.release([{ address: PUBLIC_A, family: 4 }])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(send).not.toHaveBeenCalled()
    })

    it('the transport gets only what is left of the one budget', async () => {
      let clock = 10_000
      const send = okSend()
      const lookup = vi.fn(async (_host: string) => {
        clock += 1_500
        return [{ address: PUBLIC_A, family: 4 }]
      })
      const m = await mount({ ssrfLookupFn: lookup, pinnedSendFn: send, now: () => clock })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL, { timeout_ms: 5000 })
      await expect(handler(EVENT, {})).resolves.toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
      expect(((send.mock.calls[0] as unknown[])[3] as { timeoutMs: number }).timeoutMs).toBe(3_500)
    })

    it('a resolution that used up the whole budget sends nothing, even before the deadline timer fires', async () => {
      let clock = 10_000
      const send = okSend()
      const lookup = vi.fn(async (_host: string) => {
        clock += 5_000
        return [{ address: PUBLIC_A, family: 4 }]
      })
      const m = await mount({ ssrfLookupFn: lookup, pinnedSendFn: send, now: () => clock })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL, { timeout_ms: 5000 })
      await expect(handler(EVENT, {})).rejects.toThrow(/^EVENT_WEBHOOK_DELIVERY_FAILED:timeout$/)
      expect(send).not.toHaveBeenCalled()
      expect(failedLines(m)).toHaveLength(1)
    })

    it('a request that started in time but is unanswered at the deadline: rejected at the deadline, one send, one log line', async () => {
      const pendingSends: Array<(e: Error) => void> = []
      const send = vi.fn(() => new Promise<{ status: number; ok: boolean }>((_, reject) => { pendingSends.push(reject) }))
      const m = await mount({ ssrfLookupFn: lookupReturning([{ address: PUBLIC_A, family: 4 }]), pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL, { timeout_ms: 1000 })
      vi.useFakeTimers()
      let outcome: string | undefined
      void handler(EVENT, {}).then(() => { outcome = 'resolved' }, (e: Error) => { outcome = e.message })
      await vi.advanceTimersByTimeAsync(1000)
      expect(outcome).toBe('EVENT_WEBHOOK_DELIVERY_FAILED:timeout')
      expect(send).toHaveBeenCalledTimes(1)
      // The transport's own (equal) deadline then fails it: already given up, so no second line.
      pendingSends.forEach((reject) => reject(Object.assign(new Error('late'), { name: 'TimeoutError' })))
      await vi.advanceTimersByTimeAsync(10)
      expect(failedLines(m)).toHaveLength(1)
    })

    it('a delivery that settles in time clears its deadline timer', async () => {
      const send = okSend()
      const m = await mount({ ssrfLookupFn: lookupReturning([{ address: PUBLIC_A, family: 4 }]), pinnedSendFn: send })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL, { timeout_ms: 1000 })
      vi.useFakeTimers()
      await expect(handler(EVENT, {})).resolves.toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(failedLines(m)).toHaveLength(0)
    })
  })

  it('default transport (only the resolver injected): delivery goes through pinnedHttpsFetch, never the platform fetch', async () => {
    const pinnedModuleSend = vi.fn(async () => ({ status: 204, ok: true }))
    const lookup = lookupReturning([{ address: PUBLIC_A, family: 4 }])
    // Only the resolver is injected; the transport is the module default (mocked here, so no socket).
    const m = await mount({ ssrfLookupFn: lookup }, { mockPinnedModule: pinnedModuleSend })
    const handler = await subscribeOk(m, PUBLIC_NAME_URL)
    await expect(handler(EVENT, {})).resolves.toBe(true)
    expect(pinnedModuleSend).toHaveBeenCalledTimes(1)
    expect((pinnedModuleSend.mock.calls[0] as unknown[])[1]).toBe(PUBLIC_A)
    expect(m.fetchSpy).not.toHaveBeenCalled()
  })
  // Zero seams: the router mounted EXACTLY as production mounts it (`index.ts`: `eventsRouter()`, no deps).
  // Every case above injects at least a resolver, so without these a handler or route that applies the guard
  // only when a seam is injected would stay green. No real DNS: `node:dns/promises` (what the guard's default
  // resolver calls) is module-mocked; no socket: the pinned transport module is mocked.
  describe('zero seams: eventsRouter() exactly as production mounts it', () => {
    const literalRefused: Array<[string, string, string]> = [
      ['loopback literal', 'https://127.0.0.1/in', 'loopback'],
      ['loopback over http', 'http://127.0.0.1:8900/in', 'loopback'],
      ['private literal', 'https://10.1.2.3/in', 'private'],
      ['link-local / metadata literal', 'https://169.254.169.254/latest/meta-data', 'link-local'],
      ['IPv6 loopback literal', 'https://[::1]/in', 'loopback'],
      ['IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/in', 'loopback'],
      ['http public literal', `http://${PUBLIC_A}/in`, 'scheme-not-allowed'],
      ['http public name', 'http://hooks.example.test/in', 'scheme-not-allowed'],
    ]
    for (const [label, url, refusalClass] of literalRefused) {
      it(`refuses ${label} with the closed-set 400 and never reaches eventBus.subscribe`, async () => {
        const dns = vi.fn(async () => [{ address: PUBLIC_A, family: 4 }])
        const pinnedModuleSend = okSend()
        const m = await mount(undefined, { mockDnsLookup: dns, mockPinnedModule: pinnedModuleSend })
        const res = await request(pinned.url()).post('/api/events/subscribe').send(subscribeBody(url))
        expect(res.status).toBe(400)
        expect(res.body).toEqual({ ok: false, error: { code: 'WEBHOOK_TARGET_REJECTED', refusalClass } })
        expect(m.subscribe).not.toHaveBeenCalled()
        expect(dns).not.toHaveBeenCalled()
        expect(pinnedModuleSend).not.toHaveBeenCalled()
        expect(m.fetchSpy).not.toHaveBeenCalled()
      })
    }

    it('asks the system resolver once and refuses an internal answer: nothing is sent', async () => {
      const dns = vi.fn(async () => [{ address: PUBLIC_A, family: 4 }, { address: '10.0.0.5', family: 4 }])
      const pinnedModuleSend = okSend()
      const m = await mount(undefined, { mockDnsLookup: dns, mockPinnedModule: pinnedModuleSend })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      expect(dns).not.toHaveBeenCalled() // subscribe is shape-only
      await expect(handler(EVENT, {})).rejects.toThrow(/^WEBHOOK_TARGET_REJECTED:dns-resolved-internal$/)
      expect(dns).toHaveBeenCalledTimes(1)
      expect(dns).toHaveBeenCalledWith('hooks.example.test', { all: true })
      expect(pinnedModuleSend).not.toHaveBeenCalled()
      expect(m.fetchSpy).not.toHaveBeenCalled()
    })

    it('asks the system resolver once and hands its public answer to the pinned transport as the pin', async () => {
      const dns = vi.fn(async () => [{ address: PUBLIC_A, family: 4 }])
      const pinnedModuleSend = okSend(204)
      const m = await mount(undefined, { mockDnsLookup: dns, mockPinnedModule: pinnedModuleSend })
      const handler = await subscribeOk(m, PUBLIC_NAME_URL)
      await expect(handler(EVENT, {})).resolves.toBe(true)
      expect(dns).toHaveBeenCalledTimes(1)
      expect(dns).toHaveBeenCalledWith('hooks.example.test', { all: true })
      expect(pinnedModuleSend).toHaveBeenCalledTimes(1)
      const [url, pin, family, sendOpts] = pinnedModuleSend.mock.calls[0] as unknown as [string, string, number, Record<string, unknown>]
      expect(url).toBe(PUBLIC_NAME_URL)
      expect(pin).toBe(PUBLIC_A)
      expect(family).toBe(4)
      expect(sendOpts.body).toBe(JSON.stringify(EVENT))
      expect(sendOpts.timeoutMs).toBe(5000)
      expect(m.fetchSpy).not.toHaveBeenCalled()
    })
  })
})
