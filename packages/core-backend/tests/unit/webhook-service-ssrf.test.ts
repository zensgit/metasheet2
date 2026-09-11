/**
 * F-3 — the WEBHOOK SUBSCRIPTION delivery path is SSRF-gated (the follow-up registered by the #5619
 * security review: "webhook-service.ts:394 订阅投递是同 EventBus 的另一条未接守卫出口").
 *
 * WHAT WAS WRONG: `checkWebhookTargetUrl` was wired into the button route (#2897) and, since #5619, into
 * the rule-driven `send_webhook` action. The THIRD egress out of the same EventBus — the subscription
 * fan-out in `WebhookService.executeDelivery` — handed `multitable_webhooks.url` straight to `fetch`
 * with no check and with `redirect` left at its default. Its write surface is the WIDEST of the three:
 * `POST /api/multitable/webhooks` needs only a session (`routes/api-tokens.ts:320`), and the PATCH
 * route accepts any parseable URL with no scheme check at all (`webhook-service.ts:286-293`).
 *
 * THE LOAD-BEARING ASSERTION in every refusal case below is `expect(fetch).toHaveBeenCalledTimes(0)`:
 * "refused" is worth something only if NOTHING left the process. The second one is
 * `expect(signPayload).toHaveBeenCalledTimes(0)` — the gate sits BEFORE the HMAC, so a refused target
 * never gets the subscription's secret exercised over the payload.
 *
 * Both entry points into the single dispatch site are covered: the `deliverEvent` fan-out and the
 * `retryFailedDeliveries` tick.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Kysely } from 'kysely'

import { WebhookService } from '../../src/multitable/webhook-service'
import type { SsrfLookupFn } from '../../src/multitable/webhook-ssrf-guard'
import type { Database } from '../../src/db/types'
import type { WebhookDelivery, WebhookEventType } from '../../src/multitable/webhooks'
import { Logger } from '../../src/core/logger'

/**
 * The REAL client, captured at MODULE LOAD — i.e. BEFORE `tests/setup.ts`'s `beforeAll` replaces the
 * global with `vi.stubGlobal('fetch', vi.fn())`. The request-construction suite at the bottom injects
 * THIS through the `fetchFn` seam so that path runs undici's genuine `fetch` and its genuine exception.
 */
const NATIVE_FETCH = globalThis.fetch

/** TEST-NET-3 (RFC 5737): documentation-only, not routable. Public as far as the guard is concerned. */
const PUBLIC_ADDR = '203.0.113.10'
/** An IP LITERAL target → the guard needs no DNS at all, so the allowed cases touch no resolver. */
const PUBLIC_URL = `https://${PUBLIC_ADDR}/hook`
const publicLookup: SsrfLookupFn = async () => [{ address: PUBLIC_ADDR, family: 4 }]

const WH_ID = 'wh_f3'
const DELIVERY_ID = 'dlv_f3'
const SECRET = 'subscription-hmac-secret'

interface DbWrite {
  table: string
  set: Record<string, unknown>
  /** The `.where(...)` arguments of the SAME chain, by reference — Kysely calls `.where()` AFTER
   *  `.set()`, so this array is still empty when the write is recorded and full by the time it is read. */
  where: unknown[]
}

/** Lets a test make one specific UPDATE fail, so the refusal branch's write fault can be observed. */
type FailWrite = (w: { table: string; set: Record<string, unknown> }) => unknown

interface MockState {
  /** Row returned by `getWebhookById` / the active-webhook scan. */
  webhookRow: Record<string, unknown>
  /** Rows the retry tick claims. */
  dueDeliveries: Record<string, unknown>[]
  writes: DbWrite[]
  inserts: Array<{ table: string; values: Record<string, unknown> }>
  failWrite?: FailWrite
}

function webhookRow(url: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WH_ID,
    name: 'F3 subscription',
    url,
    secret: SECRET,
    events: JSON.stringify(['record.created'] satisfies WebhookEventType[]),
    active: true,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    failure_count: 0,
    max_retries: 3,
    ...over,
  }
}

function deliveryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DELIVERY_ID,
    webhook_id: WH_ID,
    event: 'record.created',
    payload: { recordId: 'rec_1' },
    status: 'pending',
    http_status: null,
    response_body: null,
    attempt_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    next_retry_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function pendingDelivery(over: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: DELIVERY_ID,
    webhookId: WH_ID,
    event: 'record.created',
    payload: { recordId: 'rec_1' },
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** Chainable Kysely stand-in: every builder method returns itself; terminals answer from `state`. */
function makeChain(table: string, op: 'select' | 'insert' | 'update' | 'delete', state: MockState) {
  const self: Record<string, unknown> = {}
  const whereArgs: unknown[] = []
  const pass = () => self
  for (const m of [
    'selectAll', 'select', 'orderBy', 'limit', 'offset', 'groupBy',
    'forUpdate', 'skipLocked', 'returningAll', 'onConflict', 'columns', 'doUpdateSet', 'leftJoin',
  ]) {
    self[m] = vi.fn(pass)
  }
  self.where = vi.fn((...args: unknown[]) => {
    whereArgs.push(...args)
    return self
  })
  let lastSet: Record<string, unknown> = {}
  self.set = vi.fn((obj: Record<string, unknown>) => {
    lastSet = { ...obj }
    state.writes.push({ table, set: { ...obj }, where: whereArgs })
    return self
  })
  self.values = vi.fn((obj: Record<string, unknown>) => {
    state.inserts.push({ table, values: { ...obj } })
    return self
  })
  self.execute = vi.fn(async () => {
    if (op === 'update') {
      const boom = state.failWrite?.({ table, set: lastSet })
      if (boom) throw boom
    }
    if (op === 'select' && table === 'multitable_webhooks') return [state.webhookRow]
    if (op === 'select' && table === 'multitable_webhook_deliveries') return state.dueDeliveries
    return []
  })
  self.executeTakeFirst = vi.fn(async () =>
    op === 'select' && table === 'multitable_webhooks' ? state.webhookRow : undefined,
  )
  self.executeTakeFirstOrThrow = vi.fn(async () => state.webhookRow)
  return self
}

function createMockDb(state: MockState): Kysely<Database> {
  const root = {
    selectFrom: (t: string) => makeChain(t, 'select', state),
    insertInto: (t: string) => makeChain(t, 'insert', state),
    updateTable: (t: string) => makeChain(t, 'update', state),
    deleteFrom: (t: string) => makeChain(t, 'delete', state),
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) =>
        fn({
          selectFrom: (t: string) => makeChain(t, 'select', state),
          insertInto: (t: string) => makeChain(t, 'insert', state),
          updateTable: (t: string) => makeChain(t, 'update', state),
          deleteFrom: (t: string) => makeChain(t, 'delete', state),
        }),
    }),
  }
  return root as unknown as Kysely<Database>
}

interface Harness {
  svc: WebhookService
  fetch: ReturnType<typeof vi.fn>
  state: MockState
  /** Every `updateTable(...).set(...)` the service issued, in order. */
  deliveryWrites: () => Record<string, unknown>[]
  webhookWrites: () => Record<string, unknown>[]
}

interface HarnessOpts {
  url?: string
  lookup?: SsrfLookupFn
  response?: unknown
  reject?: unknown
  webhookOver?: Record<string, unknown>
  nativeFetch?: boolean
  dueDeliveries?: Record<string, unknown>[]
  failWrite?: FailWrite
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const state: MockState = {
    webhookRow: webhookRow(opts.url ?? PUBLIC_URL, opts.webhookOver ?? {}),
    dueDeliveries: opts.dueDeliveries ?? [],
    writes: [],
    inserts: [],
    failWrite: opts.failWrite,
  }
  const fetchSpy = vi.fn(async () => {
    if (opts.reject !== undefined) throw opts.reject
    return (opts.response ?? { ok: true, status: 200, text: async () => 'ok' }) as unknown as Response
  })
  const svc = new WebhookService(
    createMockDb(state),
    (opts.nativeFetch ? NATIVE_FETCH : (fetchSpy as unknown as typeof fetch)) as typeof fetch,
    opts.lookup ?? publicLookup,
  )
  return {
    svc,
    fetch: fetchSpy,
    state,
    deliveryWrites: () =>
      state.writes.filter((w) => w.table === 'multitable_webhook_deliveries').map((w) => w.set),
    webhookWrites: () =>
      state.writes.filter((w) => w.table === 'multitable_webhooks').map((w) => w.set),
  }
}

/** Capture the values-free log lines this file emits (and silence them). */
function spyLogs() {
  return vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
}
function webhookLogs(warn: ReturnType<typeof spyLogs>) {
  return warn.mock.calls.filter((c) => String(c[0]).startsWith('[webhook.delivery.'))
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  1. The gate: an internal target is never dispatched to
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe('subscription delivery — internal targets are refused before any request', () => {
  const cases: Array<[string, string, string]> = [
    // [url, refusalClass, hostFamily]
    ['http://sink.example.com/hook', 'scheme-not-allowed', 'name'],
    ['ftp://sink.example.com/hook', 'scheme-not-allowed', 'name'],
    ['http://127.0.0.1/hook', 'loopback', 'ipv4'],
    ['https://127.0.0.1/hook', 'loopback', 'ipv4'],
    ['https://127.1.2.3:8080/hook', 'loopback', 'ipv4'],
    ['https://10.1.2.3/hook', 'private', 'ipv4'],
    ['https://172.16.0.1/hook', 'private', 'ipv4'],
    ['https://192.168.1.5/hook', 'private', 'ipv4'],
    ['https://169.254.169.254/latest/meta-data/iam/security-credentials/', 'link-local', 'ipv4'],
    ['https://0.0.0.0/hook', 'unspecified', 'ipv4'],
    ['https://[::1]/hook', 'loopback', 'ipv6'],
    ['https://[::]/hook', 'unspecified', 'ipv6'],
    ['https://[fd00::1]/hook', 'unique-local', 'ipv6'],
    ['https://[fe80::1]/hook', 'link-local', 'ipv6'],
    ['https://[::ffff:127.0.0.1]/hook', 'loopback', 'ipv4-mapped-ipv6'],
    ['https://[::ffff:10.0.0.1]/hook', 'private', 'ipv4-mapped-ipv6'],
    ['https://localhost/hook', 'loopback', 'name'],
    ['https://api.localhost/hook', 'loopback', 'name'],
    ['https://vault.internal/hook', 'internal-name', 'name'],
    ['https://printer.local/hook', 'internal-name', 'name'],
    ['not-a-url', 'invalid-url', 'none'],
    ['', 'invalid-url', 'none'],
  ]

  test.each(cases)('%s is refused as %s (zero egress)', async (url, refusalClass, hostFamily) => {
    const warn = spyLogs()
    const h = makeHarness({ url })

    await h.svc.executeDelivery(pendingDelivery())

    // THE assertion: nothing left the process.
    expect(h.fetch).toHaveBeenCalledTimes(0)
    const logs = webhookLogs(warn)
    expect(logs).toHaveLength(1)
    expect(logs[0][0]).toBe('[webhook.delivery.refused]')
    expect(logs[0][1]).toMatchObject({
      code: 'WEBHOOK_TARGET_REJECTED',
      refusalClass,
      hostFamily,
      webhookId: WH_ID,
      deliveryId: DELIVERY_ID,
    })
  })

  test('a name that RESOLVES to an internal address is refused (multi-record: one bad is enough)', async () => {
    const h = makeHarness({
      url: 'https://sink.example.com/hook',
      lookup: async () => [
        { address: PUBLIC_ADDR, family: 4 },
        { address: '10.0.0.7', family: 4 },
      ],
    })
    const warn = spyLogs()

    await h.svc.executeDelivery(pendingDelivery())

    expect(h.fetch).toHaveBeenCalledTimes(0)
    expect(webhookLogs(warn)[0][1]).toMatchObject({ refusalClass: 'dns-resolved-internal', hostFamily: 'name' })
  })

  test('a name that does not resolve is refused fail-closed', async () => {
    const h = makeHarness({
      url: 'https://sink.example.com/hook',
      lookup: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    const warn = spyLogs()

    await h.svc.executeDelivery(pendingDelivery())

    expect(h.fetch).toHaveBeenCalledTimes(0)
    expect(webhookLogs(warn)[0][1]).toMatchObject({ refusalClass: 'dns-unresolved' })
  })

  test('the injected resolver is a SEAM, not a switch: a lying resolver is still refused', async () => {
    // The seam only supplies addresses; `checkWebhookTargetUrl` still judges each one.
    const h = makeHarness({
      url: 'https://totally-public.example.com/hook',
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    })

    await h.svc.executeDelivery(pendingDelivery())

    expect(h.fetch).toHaveBeenCalledTimes(0)
  })

  test('the subscription secret is never signed over the payload for a refused target', async () => {
    const sign = vi.spyOn(WebhookService, 'signPayload')
    const refused = makeHarness({ url: 'https://169.254.169.254/hook' })

    await refused.svc.executeDelivery(pendingDelivery())

    expect(refused.fetch).toHaveBeenCalledTimes(0)
    // Placement proof: the gate is BEFORE the header/HMAC assembly, not merely before `fetch`.
    expect(sign).toHaveBeenCalledTimes(0)

    const allowed = makeHarness({ url: PUBLIC_URL })
    await allowed.svc.executeDelivery(pendingDelivery())
    expect(allowed.fetch).toHaveBeenCalledTimes(1)
    expect(sign).toHaveBeenCalledTimes(1)
  })

  test('the refusal log carries no URL, no host, no secret and no query token', async () => {
    const warn = spyLogs()
    const h = makeHarness({ url: 'https://admin:hunter2@vault.internal/hook?token=SEKRET' })

    await h.svc.executeDelivery(pendingDelivery())

    const dumped = JSON.stringify(webhookLogs(warn))
    expect(dumped).not.toContain('hunter2')
    expect(dumped).not.toContain('SEKRET')
    expect(dumped).not.toContain('vault.internal')
    expect(dumped).not.toContain(SECRET)
    expect(dumped).toContain('internal-name')
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  2. What a refusal does to the delivery row (the operator-facing face)
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe('subscription delivery — refusal bookkeeping', () => {
  test('persists a closed-set token, never the URL, and re-uses the existing retry ledger', async () => {
    const h = makeHarness({ url: 'https://10.0.0.9/hook' })

    await h.svc.executeDelivery(pendingDelivery())

    const deliveryWrite = h.deliveryWrites().at(-1)
    expect(deliveryWrite).toMatchObject({
      status: 'pending', // attempt 1 of max_retries 3 → the existing backoff ledger, unchanged
      attempt_count: 1,
      http_status: null,
      response_body: 'WEBHOOK_TARGET_REJECTED:private',
    })
    expect(JSON.stringify(deliveryWrite)).not.toContain('10.0.0.9')
    // …and the failure counter moved exactly as an unreachable receiver would have moved it.
    expect(h.webhookWrites().at(-1)).toMatchObject({ failure_count: 1 })
  })

  test('a refused target terminates once its retries are spent (no infinite re-check)', async () => {
    const h = makeHarness({ url: 'https://10.0.0.9/hook', webhookOver: { max_retries: 1 } })

    await h.svc.executeDelivery(pendingDelivery())

    expect(h.deliveryWrites().at(-1)).toMatchObject({
      status: 'failed',
      attempt_count: 1,
      response_body: 'WEBHOOK_TARGET_REJECTED:private',
    })
  })

  test('a stale http_status from an earlier attempt is not re-persisted as this attempt outcome', async () => {
    const h = makeHarness({ url: 'https://10.0.0.9/hook' })

    await h.svc.executeDelivery(pendingDelivery({ httpStatus: 500, responseBody: 'old body' }))

    expect(h.deliveryWrites().at(-1)).toMatchObject({ http_status: null })
    expect(JSON.stringify(h.deliveryWrites().at(-1))).not.toContain('old body')
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  3. Both entry points funnel through the one gate
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe('subscription delivery — every entry point is gated', () => {
  test('deliverEvent fan-out: an internal subscription is persisted but never dispatched to', async () => {
    const h = makeHarness({ url: 'https://127.0.0.1/hook' })

    const deliveries = await h.svc.deliverEvent('record.created', { recordId: 'rec_1' })
    await new Promise((r) => setTimeout(r, 20)) // the send is fire-and-forget

    expect(deliveries).toHaveLength(1) // the durable row still exists, so the refusal is visible
    expect(h.fetch).toHaveBeenCalledTimes(0)
  })

  test('retryFailedDeliveries tick: a claimed row aimed at the metadata address is never dispatched to', async () => {
    const h = makeHarness({
      url: 'https://169.254.169.254/hook',
      dueDeliveries: [deliveryRow({ attempt_count: 1 })],
    })
    const warn = spyLogs()

    const retried = await h.svc.retryFailedDeliveries()

    expect(retried).toBe(1) // the tick DID process it…
    expect(h.fetch).toHaveBeenCalledTimes(0) // …and still sent nothing
    expect(webhookLogs(warn)[0][1]).toMatchObject({ refusalClass: 'link-local' })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  4. Redirects are not followed
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe('subscription delivery — redirect posture', () => {
  test('runtime precondition: the platform default really is `follow` (this is what we override)', () => {
    // In-process, no network: `Request` records the init the dispatcher would use.
    expect(new Request(PUBLIC_URL, { method: 'POST' }).redirect).toBe('follow')
    expect(new Request(PUBLIC_URL, { method: 'POST', redirect: 'manual' }).redirect).toBe('manual')
  })

  test('the dispatch asks for manual redirects', async () => {
    const h = makeHarness({ url: PUBLIC_URL })

    await h.svc.executeDelivery(pendingDelivery())

    const init = h.fetch.mock.calls[0][1] as RequestInit
    expect(init.redirect).toBe('manual')
    expect(init.method).toBe('POST')
  })

  test.each([301, 302, 303, 307, 308])('a %i is a terminal refusal, not a hop', async (status) => {
    const text = vi.fn(async () => 'redirect body')
    const headers = { get: vi.fn(() => 'http://169.254.169.254/steal') }
    const h = makeHarness({
      url: PUBLIC_URL,
      response: { ok: false, status, type: 'basic', headers, text },
    })
    const warn = spyLogs()

    await h.svc.executeDelivery(pendingDelivery())

    expect(h.fetch).toHaveBeenCalledTimes(1) // the FIRST hop went out; nothing followed it
    expect(headers.get).not.toHaveBeenCalled() // `Location` is never even read
    expect(text).not.toHaveBeenCalled() // nothing from the redirect response is persisted
    expect(h.deliveryWrites().at(-1)).toMatchObject({
      status: 'failed',
      http_status: status,
      response_body: 'WEBHOOK_TARGET_REJECTED:redirect-not-allowed',
      next_retry_at: null, // terminal: the tick only claims `pending` rows
    })
    const logs = webhookLogs(warn)
    expect(logs[0][1]).toMatchObject({
      code: 'WEBHOOK_TARGET_REJECTED',
      refusalClass: 'redirect-not-allowed',
      webhookId: WH_ID,
    })
    expect(JSON.stringify(logs)).not.toContain('169.254.169.254')
  })

  test('a browser-profile opaque redirect (status 0) is refused too', async () => {
    const h = makeHarness({
      url: PUBLIC_URL,
      response: { ok: false, status: 0, type: 'opaqueredirect', text: async () => '' },
    })

    await h.svc.executeDelivery(pendingDelivery())

    expect(h.deliveryWrites().at(-1)).toMatchObject({
      status: 'failed',
      response_body: 'WEBHOOK_TARGET_REJECTED:redirect-not-allowed',
    })
  })

  test('a 2xx is untouched by the redirect check', async () => {
    const h = makeHarness({ url: PUBLIC_URL })

    await h.svc.executeDelivery(pendingDelivery())

    expect(h.deliveryWrites().at(-1)).toMatchObject({ status: 'success', http_status: 200 })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  5. The failure log is a closed set (no transport free text)
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe('subscription delivery — failure logging is values-free', () => {
  test('a transport failure is labelled structurally; `message` is never read', async () => {
    // A message getter that THROWS is the proof: any code path that reads `.message` explodes.
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }),
    })
    Object.defineProperty(err, 'message', {
      get() {
        throw new Error('message must never be read by the log path')
      },
    })
    const h = makeHarness({ url: PUBLIC_URL, reject: err })
    const warn = spyLogs()

    await h.svc.executeDelivery(pendingDelivery())

    const logs = webhookLogs(warn)
    expect(logs).toHaveLength(1)
    expect(logs[0][0]).toBe('[webhook.delivery.failed]')
    expect(logs[0][1]).toMatchObject({
      failureClass: 'conn-refused',
      hostFamily: 'ipv4',
      webhookId: WH_ID,
      deliveryId: DELIVERY_ID,
    })
    expect(h.deliveryWrites().at(-1)).toMatchObject({
      response_body: 'WEBHOOK_DELIVERY_FAILED:conn-refused',
      http_status: null,
    })
  })

  test.each([
    ['ENOTFOUND', 'dns-failure'],
    ['EAI_AGAIN', 'dns-failure'],
    ['CERT_HAS_EXPIRED', 'tls-failure'],
    ['ECONNRESET', 'transport-error'],
  ])('%s is reported as %s', async (code, failureClass) => {
    const h = makeHarness({
      url: PUBLIC_URL,
      reject: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) }),
    })
    const warn = spyLogs()

    await h.svc.executeDelivery(pendingDelivery())

    expect(webhookLogs(warn)[0][1]).toMatchObject({ failureClass })
  })

  test('our own timeout is reported as `timeout`', async () => {
    const h = makeHarness({ url: PUBLIC_URL, reject: Object.assign(new Error('aborted'), { name: 'AbortError' }) })
    const warn = spyLogs()

    await h.svc.executeDelivery(pendingDelivery())

    expect(webhookLogs(warn)[0][1]).toMatchObject({ failureClass: 'timeout' })
  })

  test('an HTTP failure response still stores the RECEIVER body (unchanged) and logs nothing new', async () => {
    const h = makeHarness({
      url: PUBLIC_URL,
      response: { ok: false, status: 503, type: 'basic', text: async () => 'receiver said no' },
    })
    const warn = spyLogs()

    await h.svc.executeDelivery(pendingDelivery())

    expect(h.deliveryWrites().at(-1)).toMatchObject({ http_status: 503, response_body: 'receiver said no' })
    expect(webhookLogs(warn)).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  6. The credential-bearing URL case, against the REAL client
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `createWebhook` accepts `https://user:pass@host/path` (it only checks that `new URL()` parses), and the
 * guard passes it too (the HOST is public). On this runtime the native client then throws while
 * CONSTRUCTING the Request — before any socket, so this suite makes no network request — and the
 * exception's message IS the whole URL. That is exactly the string the old
 * `logger.error(...err.message)` wrote out.
 */
describe('subscription delivery — a native request-construction exception leaks nothing', () => {
  const PW = 'nEver-in-a-log-9182'
  const CRED_URL = `https://svc:${PW}@${PUBLIC_ADDR}/hook?token=QUERY-SEKRET`

  test('runtime precondition: the native client throws with the credentials in its message', async () => {
    let caught: unknown
    try {
      // No socket is opened: the throw happens at Request construction. (If a future runtime changed
      // that, this assertion fails loudly instead of the suite silently proving nothing.)
      await NATIVE_FETCH(CRED_URL, { method: 'POST', body: '{}', redirect: 'manual' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TypeError)
    expect(String((caught as Error).message)).toContain('includes credentials')
    expect(String((caught as Error).message)).toContain(PW)
  })

  test('the delivery log has the class, not the credentials', async () => {
    const h = makeHarness({ url: CRED_URL, nativeFetch: true })
    const warn = spyLogs()

    await h.svc.executeDelivery(pendingDelivery())

    const dumped = JSON.stringify(webhookLogs(warn))
    expect(dumped).not.toContain(PW)
    expect(dumped).not.toContain('QUERY-SEKRET')
    expect(dumped).not.toContain('includes credentials')
    expect(dumped).toContain('invalid-request')
  })

  test('and neither does the persisted delivery row', async () => {
    const h = makeHarness({ url: CRED_URL, nativeFetch: true })

    await h.svc.executeDelivery(pendingDelivery())

    const dumped = JSON.stringify(h.state.writes)
    expect(dumped).not.toContain(PW)
    expect(dumped).not.toContain('QUERY-SEKRET')
    expect(dumped).toContain('WEBHOOK_DELIVERY_FAILED:invalid-request')
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  7. A refusal whose BOOKKEEPING fails cannot take the rest of the retry batch with it
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The refusal branch runs BEFORE the `try` that wraps the dispatch, and it calls
 * `handleDeliveryFailure`, which issues two UPDATEs. The retry tick awaits `executeDelivery` per
 * claimed row with no guard of its own (`webhook-service.ts:731`), so an exception there would leave
 * `retryFailedDeliveries` entirely: every row that pass already CLAIMED has had `next_retry_at` leased
 * forward, so they would sit undelivered until the lease expires, and `WebhookRetryScheduler.ts:157`
 * would log the DB driver's raw `err.message`.
 *
 * These cases pin the containment: the write fault stays inside its own row, the line it produces is
 * closed-set, and the gate's verdict is unchanged (still zero egress).
 */
describe('subscription delivery — a failed refusal WRITE stays inside its own row', () => {
  /** A DB fault with a READABLE message, so an escape shows up as a failed assertion (and so the
   *  values-free check has a string to hunt for). */
  function dbError(): Error {
    return Object.assign(new Error('pg: connection terminated; password=hunter2-db'), {
      name: 'DatabaseError',
      detail: 'UPDATE multitable_webhooks SET failure_count=$1 WHERE id=$2',
    })
  }
  const failWebhookWrite = ({ table }: { table: string }) =>
    table === 'multitable_webhooks' ? dbError() : undefined

  test('the retry tick still processes the REST of the batch after one row fails to record', async () => {
    let webhookUpdates = 0
    const h = makeHarness({
      url: 'https://10.0.0.9/hook',
      dueDeliveries: [
        deliveryRow({ id: 'dlv_a', attempt_count: 1 }),
        deliveryRow({ id: 'dlv_b', attempt_count: 1 }),
      ],
      // Only the FIRST claimed row's bookkeeping fails; the tick processes rows in order.
      failWrite: ({ table }) =>
        table === 'multitable_webhooks' && ++webhookUpdates === 1 ? dbError() : undefined,
    })
    const warn = spyLogs()

    const retried = await h.svc.retryFailedDeliveries()

    expect(retried).toBe(2) // the pass completed instead of aborting on the first row
    expect(h.fetch).toHaveBeenCalledTimes(0) // both rows were refused by the gate; still zero egress
    // dlv_a's delivery UPDATE never ran (its webhook UPDATE threw first); dlv_b's did.
    // (Filtered on `response_body` so the tick's own claim/lease UPDATE is not counted.)
    const deliveryTargets = h.state.writes
      .filter((w) => w.table === 'multitable_webhook_deliveries' && 'response_body' in w.set)
      .map((w) => w.where)
    expect(deliveryTargets).toHaveLength(1)
    expect(deliveryTargets[0]).toContain('dlv_b')
    expect(h.deliveryWrites().at(-1)).toMatchObject({
      status: 'pending',
      attempt_count: 2,
      response_body: 'WEBHOOK_TARGET_REJECTED:private',
    })
    // One unrecorded line for dlv_a only — dlv_b recorded normally.
    const unrecorded = webhookLogs(warn).filter((c) => c[0] === '[webhook.delivery.refusal_unrecorded]')
    expect(unrecorded).toHaveLength(1)
    expect(unrecorded[0][1]).toMatchObject({ deliveryId: 'dlv_a' })
  })

  test('the line it logs carries no DB free text, no URL and no secret', async () => {
    const h = makeHarness({
      url: 'https://admin:hunter2@10.0.0.9/hook?token=SEKRET',
      failWrite: failWebhookWrite,
    })
    const warn = spyLogs()

    await h.svc.executeDelivery(pendingDelivery())

    const dumped = JSON.stringify(webhookLogs(warn))
    expect(dumped).not.toContain('hunter2') // neither the URL's password nor the driver's message
    expect(dumped).not.toContain('SEKRET')
    expect(dumped).not.toContain('10.0.0.9')
    expect(dumped).not.toContain('DatabaseError')
    expect(dumped).not.toContain('UPDATE multitable_webhooks')
    expect(dumped).not.toContain(SECRET)
    expect(dumped).toContain('private') // the closed-set label survives
  })

  test('executeDelivery does not throw, and never reads the DB error message', async () => {
    // A `message` getter that THROWS is the proof, same idiom as the transport-failure case above:
    // any code path that reads it explodes instead of quietly leaking.
    const exploding = Object.assign(new Error('placeholder'), { name: 'DatabaseError' })
    Object.defineProperty(exploding, 'message', {
      get() {
        throw new Error('the DB error message must never be read by the refusal path')
      },
    })
    const h = makeHarness({
      url: 'https://10.0.0.9/hook',
      failWrite: ({ table }) => (table === 'multitable_webhooks' ? exploding : undefined),
    })
    const warn = spyLogs()

    // No `.rejects` — the point is that this resolves.
    await h.svc.executeDelivery(pendingDelivery())

    expect(h.fetch).toHaveBeenCalledTimes(0) // the gate's verdict is unchanged
    const logs = webhookLogs(warn)
    expect(logs.map((c) => c[0])).toEqual([
      '[webhook.delivery.refused]',
      '[webhook.delivery.refusal_unrecorded]',
    ])
    expect(logs[1][1]).toMatchObject({
      code: 'WEBHOOK_TARGET_REJECTED',
      refusalClass: 'private',
      hostFamily: 'ipv4',
      webhookId: WH_ID,
      deliveryId: DELIVERY_ID,
      event: 'record.created',
    })
  })
})
