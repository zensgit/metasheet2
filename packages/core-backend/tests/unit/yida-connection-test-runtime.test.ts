import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createYidaConnectionTestRuntime, yidaConnectionTestErrorCode, YidaConnectionTestError,
  YIDA_CONNECTION_TEST_BUDGET_MS, YIDA_CONNECTION_TEST_COOLDOWN_MS, YIDA_CONNECTION_TEST_START_WINDOW_MS,
  type YidaConnectionTestInput, type YidaConnectionTestRuntimeBinding,
} from '../../src/integration/yida-connection-test-runtime'
import type { YidaInitializationDatabase } from '../../src/integration/yida-initialization-bootstrap'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

// CONTROL/QUERY CONTRACT ONLY: the actual live-ACL code runs over a synthetic query model and the
// actual plugin probe binding runs over an injected fetch. No PostgreSQL, socket or credential.
// The real-DB proofs are tests/integration/yida-host-connection-test-realdb.test.ts and
// tests/integration/yida-connection-test-http-realdb.test.ts.
type Row = Record<string, unknown>
const requireCjs = createRequire(import.meta.url)
const { createYidaConnectionProbeBinding } = requireCjs(path.resolve(__dirname, '../../../../plugins/plugin-integration-core/lib/yida-connection-probe.cjs')) as {
  createYidaConnectionProbeBinding(): YidaConnectionTestRuntimeBinding
}
// Literal on purpose: never imported from the exchange module.
const DINGTALK_OAUTH_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const actor = Object.freeze({ actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null })
const secondAdmin = Object.freeze({ ...actor, actorId: 'synthetic-second-admin' })
const commandId = '00000000-0000-4000-8000-000000000001'
const otherCommand = '00000000-0000-4000-8000-000000000009'
const input = (overrides: Partial<Row> = {}): YidaConnectionTestInput => ({ commandId, mode: 'candidate',
  material: { appKey: ' synthetic-app ', appSecret: ' synthetic-secret ' }, ...overrides } as YidaConnectionTestInput)
const tokenResponse = () => new Response(JSON.stringify({ accessToken: 'synthetic-access-token', expireIn: 7200 }), { status: 200 })
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async () => { for (let index = 0; index < 50; index++) await Promise.resolve() }

function fixture(options: { anchor?: Row | null; initialized?: boolean; target?: boolean; denied?: string[]
  beforeCommit?: () => Promise<void> | void; beforeQuery?: (sql: string) => Promise<void> | void
  respond?: (url: unknown, init: RequestInit | undefined) => Promise<Response> | Response
  binding?: YidaConnectionTestRuntimeBinding; enablement?: unknown } = {}) {
  const events: string[] = [], sql: string[] = []
  let enablement: unknown = Object.hasOwn(options, 'enablement') ? options.enablement : 'true', transactions = 0, commits = 0
  const anchor = options.anchor === undefined ? { slot: 1, command_id: commandId, owner_id: actor.actorId, tenant_id: actor.tenantId, workspace_id: null } : options.anchor
  const denied = new Set(options.denied ?? [])
  const query: Queryable['query'] = vi.fn(async (text: string, params?: unknown[]) => {
    sql.push(text)
    await options.beforeQuery?.(text)
    let rows: Row[] = []
    const user = params?.[0]
    if (text.includes('transaction_isolation')) rows = [{ isolation: 'read committed' }]
    else if (text.includes('pg_current_xact_id')) rows = [{ xid: 'synthetic-stable-xid' }]
    else if (text.includes('pg_advisory_xact_lock')) rows = [{}]
    else if (/FROM user_roles\b/u.test(text)) rows = denied.has(String(user)) ? [] : [{ role_id: 'admin' }]
    else if (/FROM role_permissions\b|FROM user_permissions\b/u.test(text)) rows = []
    else if (/FROM users\b/u.test(text)) rows = [{ id: user, role: denied.has(String(user)) ? 'user' : 'admin', is_active: true, activation_status: 'activated', permissions: [] }]
    else if (/FROM user_orgs\b/u.test(text)) rows = [{ user_id: user, org_id: params?.[1], is_active: true }]
    else if (/FROM user_namespace_admissions\b/u.test(text)) rows = []
    else if (text.includes('FROM integration_yida_initialization_anchor')) rows = anchor ? [anchor] : []
    else if (text.includes('FROM integration_yida_initializations')) rows = options.initialized ? [{ slot: 1 }] : []
    else if (text.includes('FROM integration_yida_approved_target')) rows = options.target ? [{ slot: 1 }] : []
    else throw new Error('Unexpected synthetic query')
    return { rows, rowCount: rows.length }
  })
  const database: YidaInitializationDatabase = { async transaction<T>(work: (trx: Queryable) => Promise<T>) {
    transactions++; events.push('begin')
    const result = await work({ query })
    await options.beforeCommit?.()
    commits++; events.push('commit')
    return result
  } }
  const fetchCalls: Array<{ url: unknown; init: RequestInit | undefined }> = []
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    events.push('fetch'); fetchCalls.push({ url, init })
    return options.respond ? options.respond(url, init) : tokenResponse()
  }) as unknown as typeof globalThis.fetch
  const runtime = createYidaConnectionTestRuntime({ database, fetch, readEnablement: () => enablement })
  return { runtime, events, sql, fetchCalls, binding: options.binding ?? createYidaConnectionProbeBinding(),
    setEnablement(value: unknown) { enablement = value },
    get transactions() { return transactions }, get commits() { return commits } }
}
async function active(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options)
  const registration = await f.runtime.createPluginCapability().activate(f.binding)
  return { f, registration }
}
const rejected = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code: `YIDA_CONNECTION_TEST_${code}` })
const okView = (outcome = 'ok') => ({ commandId, mode: 'candidate', outcome, tokenIssued: outcome === 'ok',
  tokenRetained: false, externalWriteAttempted: false, canSend: false })
afterEach(() => { vi.useRealTimers() })

describe('YiDa connection test host runtime — order, authority and limiter', () => {
  it.each([undefined, 'false', 'TRUE', ' true', 'true ', '1', true])('switch %j is DISABLED before any transaction or fetch', async value => {
    const { f } = await active({ enablement: value })
    await rejected(f.runtime.test(actor, input()), 'DISABLED')
    expect([f.transactions, f.fetchCalls.length]).toEqual([0, 0])
    expect(f.runtime.connectionTestEnabled()).toBe(false)
  })
  it('a throwing or rejected-promise switch is DISABLED and never an unhandled rejection', async () => {
    const unhandled = vi.fn(); process.on('unhandledRejection', unhandled)
    try {
      for (const read of [() => { throw new Error('PRIVATE_SWITCH') }, () => Promise.reject(new Error('PRIVATE_SWITCH'))]) {
        const f = fixture()
        const runtime = createYidaConnectionTestRuntime({ database: { transaction: async () => { throw new Error('unused') } }, fetch: (async () => tokenResponse()) as typeof fetch, readEnablement: read })
        await runtime.createPluginCapability().activate(f.binding)
        await rejected(runtime.test(actor, input()), 'DISABLED')
        expect(runtime.connectionTestEnabled()).toBe(false)
      }
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally { process.off('unhandledRejection', unhandled) }
  })
  it("'true': exactly one fetch, only after COMMIT, to the fixed endpoint with exactly the pasted pair", async () => {
    const { f } = await active()
    expect(f.runtime.connectionTestEnabled()).toBe(true)
    const result = await f.runtime.test(actor, input())
    expect(result).toEqual(okView())
    expect(Object.isFrozen(result)).toBe(true)
    expect(f.events).toEqual(['begin', 'commit', 'fetch'])
    expect(f.fetchCalls).toHaveLength(1)
    expect(f.fetchCalls[0].url).toBe(DINGTALK_OAUTH_ENDPOINT)
    expect(f.fetchCalls[0].init?.method).toBe('POST'); expect(f.fetchCalls[0].init?.redirect).toBe('error')
    const body = JSON.parse(String(f.fetchCalls[0].init?.body))
    expect(Object.keys(body)).toEqual(['appKey', 'appSecret'])
    expect(body.appKey === ' synthetic-app ' && body.appSecret === ' synthetic-secret ').toBe(true)
    expect(JSON.stringify(result).includes('synthetic-access-token')).toBe(false)
    expect(f.sql.some(text => /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/u.test(text))).toBe(false)
    expect(f.sql.findIndex(text => text.includes('FROM users'))).toBeLessThan(f.sql.findIndex(text => text.includes('pg_advisory_xact_lock')))
  })
  it('the actual probe classification reaches the view: upstream_rejected and unreachable', async () => {
    const rejectedAnswer = await active({ respond: () => new Response('{}', { status: 401 }) })
    expect(await rejectedAnswer.f.runtime.test(actor, input())).toEqual(okView('upstream_rejected'))
    const unreachable = await active({ respond: () => { throw new TypeError('fetch failed') } })
    expect(await unreachable.f.runtime.test(actor, input())).toEqual(okView('unreachable'))
  })
  it('the switch flipped OFF between COMMIT and the exchange is DISABLED with zero fetch', async () => {
    let f!: ReturnType<typeof fixture>
    ;({ f } = await active({ beforeCommit: () => { f.setEnablement('false') } }))
    await rejected(f.runtime.test(actor, input()), 'DISABLED')
    expect(f.commits).toBe(1); expect(f.fetchCalls).toHaveLength(0)
  })
  it.each([
    ['another live admin who is not the anchor owner', secondAdmin],
    ['the anchor owner under another tenant', { ...actor, tenantId: 'synthetic-other-tenant' }],
  ])('DENIED: %s, with zero fetch', async (_name, caller) => {
    const { f } = await active()
    await rejected(f.runtime.test(caller, input()), 'DENIED')
    expect(f.fetchCalls).toHaveLength(0)
    expect(f.sql.some(text => text.includes('FROM integration_yida_initializations'))).toBe(false)
  })
  it('DENIED when the live ACL refuses the anchor owner; UNAVAILABLE without an anchor', async () => {
    const acl = await active({ denied: [actor.actorId] })
    await rejected(acl.f.runtime.test(actor, input()), 'DENIED')
    const missing = await active({ anchor: null })
    await rejected(missing.f.runtime.test(actor, input()), 'UNAVAILABLE')
    expect([acl.f.fetchCalls.length, missing.f.fetchCalls.length]).toEqual([0, 0])
  })
  it('CONFLICT for another commandId and once the slot is initialized or targeted, with zero fetch', async () => {
    const mismatch = await active()
    await rejected(mismatch.f.runtime.test(actor, input({ commandId: otherCommand })), 'CONFLICT')
    const both = await active({ initialized: true, target: true })
    await rejected(both.f.runtime.test(actor, input()), 'CONFLICT')
    expect([mismatch.f.fetchCalls.length, both.f.fetchCalls.length]).toEqual([0, 0])
  })
  // Each half of the "already sealed" check on its own. On real PostgreSQL a lone initialization row
  // cannot exist (migration 096: target_ref REFERENCES integration_yida_approved_target), so only this
  // synthetic query model can pin the initialization half by itself.
  it.each([
    ['an initialization row alone', { initialized: true, target: false }],
    ['an approved target row alone', { initialized: false, target: true }],
  ])('CONFLICT for %s, with zero fetch', async (_name, rows) => {
    const { f } = await active(rows)
    await rejected(f.runtime.test(actor, input()), 'CONFLICT')
    expect(f.fetchCalls).toHaveLength(0)
  })
  it('a DENIED caller immediately followed by the owner: the owner is admitted with exactly one fetch', async () => {
    const { f } = await active()
    await rejected(f.runtime.test(secondAdmin, input()), 'DENIED')
    await rejected(f.runtime.test(actor, input({ commandId: otherCommand })), 'CONFLICT')
    expect(await f.runtime.test(actor, input())).toEqual(okView())
    expect(f.fetchCalls).toHaveLength(1)
  })
  it('a DENIED caller held inside its transaction never blocks a concurrent owner', async () => {
    const held = deferred(), entered = deferred()
    const { f } = await active({ beforeQuery: async text => {
      if (text.includes('FROM user_roles') && f.events.filter(event => event === 'begin').length === 1) { entered.resolve(); await held.promise }
    } })
    const intruder = f.runtime.test(secondAdmin, input())
    await entered.promise
    expect(await f.runtime.test(actor, input())).toEqual(okView())
    held.resolve(); await rejected(intruder, 'DENIED')
    expect(f.fetchCalls).toHaveLength(1)
  })
  it('two authorized concurrent callers: the second is CONFLICT while the first exchange is in flight', async () => {
    const answer = deferred<Response>()
    const { f } = await active({ respond: () => answer.promise })
    const first = f.runtime.test(actor, input())
    await vi.waitFor(() => expect(f.fetchCalls).toHaveLength(1))
    await rejected(f.runtime.test(actor, input()), 'CONFLICT')
    answer.resolve(tokenResponse())
    expect(await first).toEqual(okView())
    expect(f.fetchCalls).toHaveLength(1)
  })
  it('cooldown: THROTTLED within the window after a started exchange, admitted after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    const { f } = await active()
    expect(await f.runtime.test(actor, input())).toEqual(okView())
    vi.setSystemTime(1_800_000_000_000 + YIDA_CONNECTION_TEST_COOLDOWN_MS - 1)
    await rejected(f.runtime.test(actor, input()), 'THROTTLED')
    vi.setSystemTime(1_800_000_000_000 + YIDA_CONNECTION_TEST_COOLDOWN_MS)
    expect(await f.runtime.test(actor, input())).toEqual(okView())
    expect(f.fetchCalls).toHaveLength(2)
  })
  it('refused callers (DISABLED, DENIED, CONFLICT, UNAVAILABLE) never stamp the cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    const { f } = await active()
    f.setEnablement('false'); await rejected(f.runtime.test(actor, input()), 'DISABLED'); f.setEnablement('true')
    await rejected(f.runtime.test(secondAdmin, input()), 'DENIED')
    await rejected(f.runtime.test(actor, input({ commandId: otherCommand })), 'CONFLICT')
    expect(await f.runtime.test(actor, input())).toEqual(okView())
  })
  // The stamp sits with the exchange start, not with admission: a caller that passed the THROTTLED
  // check but was refused before the exchange leaves no stamp, so the next authorized call at the
  // very same instant reaches the probe.
  it('a refusal after admission but before the exchange (switch re-check OFF) leaves no cooldown stamp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    let f!: ReturnType<typeof fixture>, flips = 0
    ;({ f } = await active({ beforeCommit: () => { if (flips++ === 0) f.setEnablement('false') } }))
    await rejected(f.runtime.test(actor, input()), 'DISABLED')
    f.setEnablement('true')
    expect(await f.runtime.test(actor, input())).toEqual(okView())
    expect(f.fetchCalls).toHaveLength(1)
  })
  it('a refusal after admission but before the exchange (invalid probe from the binding) leaves no cooldown stamp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    const real = createYidaConnectionProbeBinding()
    let created = 0
    const binding: YidaConnectionTestRuntimeBinding = { createConnectionProbe: options =>
      created++ === 0 ? Object.freeze({ probe: 'synthetic-not-a-function' }) as never : real.createConnectionProbe(options) }
    const { f } = await active({ binding })
    await rejected(f.runtime.test(actor, input()), 'UNAVAILABLE')
    expect(f.fetchCalls).toHaveLength(0)
    expect(await f.runtime.test(actor, input())).toEqual(okView())
    expect(f.fetchCalls).toHaveLength(1)
  })
  it('start window: the exchange must start within 2 s of entry; a slower authorization is UNAVAILABLE with zero fetch and no stamp', async () => {
    expect(YIDA_CONNECTION_TEST_START_WINDOW_MS).toBe(2000)
    // Worst case on the server (window + budget) stays under the web client's 15 s abort.
    expect(YIDA_CONNECTION_TEST_START_WINDOW_MS + YIDA_CONNECTION_TEST_BUDGET_MS).toBeLessThan(15000)
    vi.useFakeTimers({ toFake: ['Date'] })
    const base = 1_800_000_000_000
    vi.setSystemTime(base)
    let delay = YIDA_CONNECTION_TEST_START_WINDOW_MS + 1
    const { f } = await active({ beforeQuery: text => {
      if (text.includes('FROM integration_yida_initialization_anchor')) vi.setSystemTime(Date.now() + delay)
    } })
    await rejected(f.runtime.test(actor, input()), 'UNAVAILABLE')
    expect(f.commits).toBe(1); expect(f.fetchCalls).toHaveLength(0)
    // Nothing was stamped: the next call right after is admitted (exactly at the window edge).
    delay = YIDA_CONNECTION_TEST_START_WINDOW_MS
    expect(await f.runtime.test(actor, input())).toEqual(okView())
    expect(f.fetchCalls).toHaveLength(1)
  })
  it('a backward wall-clock step never throttles or fails the start window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const base = 1_800_000_000_000
    vi.setSystemTime(base)
    let step = 0
    const { f } = await active({ beforeQuery: text => {
      if (step !== 0 && text.includes('FROM integration_yida_initialization_anchor')) vi.setSystemTime(Date.now() - step)
    } })
    expect(await f.runtime.test(actor, input())).toEqual(okView())
    // The clock steps back a minute right after a started exchange: the next click is not THROTTLED.
    vi.setSystemTime(base - 60_000)
    expect(await f.runtime.test(actor, input())).toEqual(okView())
    // A backward step during the authorization phase (negative elapsed) is inside the window.
    vi.setSystemTime(base + 10 * YIDA_CONNECTION_TEST_COOLDOWN_MS); step = 30_000
    expect(await f.runtime.test(actor, input())).toEqual(okView())
    expect(f.fetchCalls).toHaveLength(3)
  })
})

describe('YiDa connection test host runtime — receipts, deadline and lifetime', () => {
  it.each([
    ['token-bearing', () => Object.freeze({ outcome: 'ok', token: 'synthetic-leaked-token' })],
    ['proxy', () => new Proxy(Object.freeze({ outcome: 'ok' }), {})],
    ['unfrozen', () => ({ outcome: 'ok' })],
    ['timeout claimed by the plugin', () => Object.freeze({ outcome: 'timeout' })],
    ['unknown outcome', () => Object.freeze({ outcome: 'synthetic' })],
    ['non-object', () => 'ok'],
  ])('a hostile %s receipt is UNAVAILABLE and nothing of it leaks', async (_name, make) => {
    const binding: YidaConnectionTestRuntimeBinding = { createConnectionProbe: ({ fetch }) => Object.freeze({
      async probe() { await fetch(DINGTALK_OAUTH_ENDPOINT, {}); return make() },
    }) }
    const { f } = await active({ binding })
    const pending = f.runtime.test(actor, input())
    await rejected(pending, 'UNAVAILABLE')
    await pending.catch(error => { expect(JSON.stringify(error)).not.toContain('synthetic-leaked-token'); expect(Object.hasOwn(error, 'cause')).toBe(false) })
  })
  it("an abort-honouring fetch that never answers is 'timeout' exactly at the 12 s budget", async () => {
    vi.useFakeTimers()
    const { f } = await active({ respond: (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }) })
    expect(YIDA_CONNECTION_TEST_BUDGET_MS).toBe(12000)
    let result: unknown
    const pending = f.runtime.test(actor, input()).then(value => { result = value })
    await vi.advanceTimersByTimeAsync(YIDA_CONNECTION_TEST_BUDGET_MS - 1)
    expect(result).toBeUndefined(); expect(f.fetchCalls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1); await pending
    expect(result).toEqual(okView('timeout'))
    expect(f.fetchCalls[0].init?.signal?.aborted).toBe(true)
  })
  it('an abort-ignoring fetch: no view before it settles, stop()/drain wait for it, no unhandled rejection', async () => {
    vi.useFakeTimers()
    const unhandled = vi.fn(); process.on('unhandledRejection', unhandled)
    try {
      const late = deferred<Response>()
      const { f, registration } = await active({ respond: () => late.promise })
      let result: unknown, stopped = false
      const pending = f.runtime.test(actor, input()).then(value => { result = value })
      await vi.advanceTimersByTimeAsync(YIDA_CONNECTION_TEST_BUDGET_MS + 1000)
      expect(result).toBeUndefined()
      // A second authorized click is still CONFLICT: the exchange is charged until it settles.
      await rejected(f.runtime.test(actor, input()), 'CONFLICT')
      late.reject(new TypeError('synthetic late socket failure'))
      await pending
      expect(result).toEqual(okView('timeout'))
      const second = deferred<Response>()
      const g = await active({ respond: () => second.promise })
      const held = g.f.runtime.test(actor, input()); void held.catch(() => {})
      await vi.waitFor(() => expect(g.f.fetchCalls).toHaveLength(1))
      const stopping = g.registration.stop().then(() => { stopped = true })
      await vi.advanceTimersByTimeAsync(YIDA_CONNECTION_TEST_BUDGET_MS * 2)
      expect(stopped).toBe(false)
      second.reject(new TypeError('synthetic late socket failure'))
      await stopping; expect(stopped).toBe(true)
      await rejected(held, 'CANCELLED')
      await registration.stop()
      vi.useRealTimers(); await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally { process.off('unhandledRejection', unhandled) }
  })
  it('an abandoned DENIED or caller-aborted promise never becomes an unhandled rejection', async () => {
    // Nobody but the runtime's own rejection subscriber observes these runs (no stop()/drain either).
    const unhandled = vi.fn(); process.once('unhandledRejection', unhandled)
    try {
      const { f } = await active({ respond: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }) })
      f.runtime.test(secondAdmin, input()) // deliberately never observed: rejects DENIED
      const control = new AbortController()
      f.runtime.test(actor, input(), { signal: control.signal }) // deliberately never observed: rejects CANCELLED
      await vi.waitFor(() => expect(f.fetchCalls).toHaveLength(1))
      control.abort()
      for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally { process.off('unhandledRejection', unhandled) }
  })
  it('an abandoned caller promise cancelled by stop() never becomes an unhandled rejection', async () => {
    const unhandled = vi.fn(); process.on('unhandledRejection', unhandled)
    try {
      const { f, registration } = await active({ respond: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }) })
      f.runtime.test(actor, input()) // deliberately never observed by this caller
      await vi.waitFor(() => expect(f.fetchCalls).toHaveLength(1))
      await registration.stop()
      for (let index = 0; index < 3; index++) await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally { process.off('unhandledRejection', unhandled) }
  })
  it('caller abort is CANCELLED (never timeout); runtime stop aborts an in-flight fetch', async () => {
    const hang = (_url: unknown, init: RequestInit | undefined) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    const { f } = await active({ respond: hang })
    const control = new AbortController()
    const pending = f.runtime.test(actor, input(), { signal: control.signal })
    await vi.waitFor(() => expect(f.fetchCalls).toHaveLength(1))
    control.abort(); await rejected(pending, 'CANCELLED')
    const aborted = new AbortController(); aborted.abort()
    await rejected(f.runtime.test(actor, input(), { signal: aborted.signal }), 'CANCELLED')
    const g = await active({ respond: hang })
    const running = g.f.runtime.test(actor, input())
    await vi.waitFor(() => expect(g.f.fetchCalls).toHaveLength(1))
    await g.f.runtime.stop()
    await expect(running).rejects.toBeInstanceOf(YidaConnectionTestError)
    expect(g.f.fetchCalls[0].init?.signal?.aborted).toBe(true)
    await rejected(g.f.runtime.test(actor, input()), 'INACTIVE')
    expect(() => g.f.runtime.createPluginCapability()).toThrow(YidaConnectionTestError)
  })
  it('closed input: wrong mode, extra keys, whitespace or oversized material never reach a transaction', async () => {
    const { f } = await active()
    for (const bad of [input({ mode: 'stored' }), input({ extra: true }), input({ commandId: 'not-a-uuid' }),
      input({ material: { appKey: '   ', appSecret: 'synthetic' } }), input({ material: { appKey: 'synthetic', appSecret: 'x'.repeat(4097) } }),
      input({ material: { appKey: 'synthetic', appSecret: 'synthetic', systemToken: 'synthetic' } }),
      input({ material: { appKey: 'é'.repeat(4096), appSecret: 'é'.repeat(4096) } })]) {
      await rejected(f.runtime.test(actor, bad), 'INPUT')
    }
    await rejected(f.runtime.test({ ...actor, workspaceId: 'synthetic' } as never, input()), 'INPUT')
    expect([f.transactions, f.fetchCalls.length]).toEqual([0, 0])
  })
  it('inactive until registered; one registration only; the decoder reads only its own errors', async () => {
    const f = fixture()
    await rejected(f.runtime.test(actor, input()), 'INACTIVE')
    const capability = f.runtime.createPluginCapability()
    await expect(capability.activate({ createConnectionProbe: 'x' } as never)).rejects.toMatchObject({ code: 'YIDA_CONNECTION_TEST_INPUT' })
    await expect(capability.activate(f.binding)).rejects.toMatchObject({ code: 'YIDA_CONNECTION_TEST_INACTIVE' })
    expect(yidaConnectionTestErrorCode(new YidaConnectionTestError('DENIED'))).toBe('YIDA_CONNECTION_TEST_DENIED')
    expect(yidaConnectionTestErrorCode(Object.assign(new Error('YIDA_CONNECTION_TEST_DENIED'), { code: 'YIDA_CONNECTION_TEST_DENIED' }))).toBeUndefined()
    expect(new YidaConnectionTestError('SYNTHETIC').code).toBe('YIDA_CONNECTION_TEST_UNAVAILABLE')
    await settle()
  })
})
