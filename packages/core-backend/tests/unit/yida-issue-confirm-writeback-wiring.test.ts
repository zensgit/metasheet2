// YiDa 发料确认日期回写 — the HOST half of the wiring at unit level (slice Y9; design baseline v2.3 §7.3, D5 b, D13 a):
//   - POST /issue-confirm-writeback: the generic 404 while the switch is OFF (no port call), the closed body, the closed
//     values-free reply projection;
//   - the owner runtime: the write-back binding members come together or not at all, the enabled bit, DISABLED before
//     any proof, the live proof BEFORE the capability is even created, the closed run input, the send port's original
//     closed options from every binding, and the post-ACK write-back as a tracked run of its own AFTER submit returned
//     (D5 a; result first, a failing or hanging hook never changes or delays the result, stop() drains it), and its
//     two fixed log codes (a failed run; C2: a run that finished with a retryable row, never a skip or a traced outcome);
//   - the D13 a role rule (pure) and the re-check's refusal of a foreign scope before any transaction.
// The real-PG proofs are tests/integration/stock-preparation-yida-issue-confirm-writeback-realdb.test.ts.
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { createIntegrationYidaOwnerRouter, yidaOwnerNoStoreMiddleware, type YidaOwnerHttpPort } from '../../src/routes/integration-yida-owner'
import { createYidaOwnerRuntime, YidaOwnerRuntimeError } from '../../src/integration/yida-owner-runtime'
import { issueConfirmRoleGrantSatisfied, yidaIssueConfirmLiveRecheck } from '../../src/integration/yida-issue-confirm-writeback-authority'

const actor = Object.freeze({ actorId: 'synthetic-wb-owner', tenantId: 'synthetic-wb-tenant', workspaceId: null })
const LEDGER = '55555555-5555-4555-8555-555555555555'
// A sweep cursor as the host sees it: opaque base64url text (the plugin core decodes and judges it).
const CURSOR = Buffer.from(JSON.stringify({ v: 2, s: '0123456789abcdef0123456789abcdef', t: '66666666-6666-4666-8666-666666666666',
  c: '2026-03-01T00:00:00.000001Z', i: LEDGER }), 'utf8').toString('base64url')

async function dispatch(body: unknown, owner: Partial<YidaOwnerHttpPort>, options: { url?: string; headers?: Record<string, string> } = {}) {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: options.url ?? '/issue-confirm-writeback',
    originalUrl: '/api/integration/yida-owner-send/issue-confirm-writeback', headers: options.headers ?? {}, query: {},
    body, user: { id: actor.actorId }, authenticatedTenantId: actor.tenantId, aborted: false })
  let status = 0
  const router = createIntegrationYidaOwnerRouter(owner as YidaOwnerHttpPort)
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, setHeader() {},
    status(value: number) { status = value; return this }, json(_body: unknown) {} })
  const result = await new Promise<unknown>((resolve, reject) => {
    res.json = (payload: unknown) => { res.writableEnded = true; resolve(payload) }
    yidaOwnerNoStoreMiddleware(req as unknown as Request, res as unknown as Response, () => {
      router(req as unknown as Request, res as unknown as Response, reject)
    })
  })
  await Promise.resolve()
  return { status, result }
}
function owner(enabled: () => unknown, answer: unknown = { enabled: true, results: [] }) {
  const calls: unknown[] = []
  const port: Partial<YidaOwnerHttpPort> = {
    issueConfirmWritebackEnabled: enabled as () => boolean,
    async issueConfirmWriteback(who: unknown, input: unknown) { calls.push({ who, input }); return answer as never },
  }
  return { port, calls }
}

describe('POST /issue-confirm-writeback (route)', () => {
  it.each([
    ['off', () => false], ['truthy non-boolean', () => 'true'], ['throws', () => { throw new Error('SYNTHETIC') }],
  ])('switch %s: the generic 404, and the port is never called', async (_name, enabled) => {
    const { port, calls } = owner(enabled)
    expect(await dispatch({}, port)).toEqual({ status: 404, result: { ok: false, error: { code: 'NOT_FOUND' } } })
    expect(calls).toEqual([])
  })
  it('no enabled bit on the port (an older runtime): the generic 404', async () => {
    const { port, calls } = owner(() => true)
    delete port.issueConfirmWritebackEnabled
    expect((await dispatch({}, port)).status).toBe(404)
    expect(calls).toEqual([])
  })
  it('ON: the closed body reaches the runtime as the authenticated owner, with only ledgerIds / limit / after', async () => {
    const { port, calls } = owner(() => true)
    expect(await dispatch({}, port)).toEqual({ status: 200, result: { ok: true, data: { enabled: true, results: [], report: { counts: { written_inactive: 0, row_absent: 0, duplicate_key: 0, kept_existing: 0 }, writtenInactive: [] } } } })
    expect((await dispatch({ limit: 5 }, port)).status).toBe(200)
    expect((await dispatch({ ledgerIds: [LEDGER] }, port)).status).toBe(200)
    expect((await dispatch({ after: CURSOR, limit: 7 }, port)).status).toBe(200)
    expect((await dispatch(undefined, port)).status).toBe(400)
    expect(calls).toEqual([{ who: actor, input: {} }, { who: actor, input: { limit: 5 } }, { who: actor, input: { ledgerIds: [LEDGER] } },
      { who: actor, input: { limit: 7, after: CURSOR } }])
  })
  it.each([
    ['an extra key', { limit: 1, tenantId: 'x' }], ['limit 0', { limit: 0 }], ['limit 101', { limit: 101 }], ['limit as text', { limit: '5' }],
    ['empty ledgerIds', { ledgerIds: [] }], ['duplicate ledgerIds', { ledgerIds: [LEDGER, LEDGER] }], ['non-string id', { ledgerIds: [1] }],
    ['101 ledgerIds', { ledgerIds: Array.from({ length: 101 }, (_, index) => `ledger-${index}`) }], ['padded id', { ledgerIds: [' x'] }],
    ['an owner key', { ownerId: 'synthetic-other' }],
    // The sweep cursor: batch mode only (never with ledgerIds), base64url text of at most 2048 characters.
    ['after with ledgerIds', { ledgerIds: [LEDGER], after: CURSOR }], ['after not a string', { after: 7 }], ['after null', { after: null }],
    ['empty after', { after: '' }], ['after with padding', { after: `${CURSOR}=` }], ['after with a slash', { after: 'ab/cd' }],
    ['after padded', { after: ` ${CURSOR}` }], ['after too long', { after: 'A'.repeat(2049) }], ['after as an object', { after: { v: 1 } }],
  ])('ON: %s is a 400 and the port is never called', async (_name, body) => {
    const { port, calls } = owner(() => true)
    expect(await dispatch(body, port)).toEqual({ status: 400, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_INPUT' } } })
    expect(calls).toEqual([])
  })
  it('a scope header is refused before the port', async () => {
    const { port, calls } = owner(() => true)
    expect((await dispatch({}, port, { headers: { 'x-tenant-id': 'synthetic-other' } })).status).toBe(400)
    expect(calls).toEqual([])
  })
  it('the reply is a closed, values-free projection: an unexpected field in a result is a 503, never echoed', async () => {
    const good = { enabled: true, results: [
      { ledgerId: LEDGER, kind: 'outcome', outcome: 'written', recorded: true, date: '2026-03-02', timeZone: 'Asia/Shanghai' },
      { ledgerId: 'l-2', kind: 'skip', reason: 'project_sheets_disabled' },
      { ledgerId: 'l-3', kind: 'retryable', code: 'STOCK_PREP_PROJECT_WRITE_LOCKED' },
      { ledgerId: 'l-4', kind: 'outcome', outcome: 'row_absent', recorded: false },
    ], stopped: 'SWITCH_OFF' }
    // D3-1: every enabled reply carries the run report, recomputed by the route from the closed rows (every key, zeros too).
    const goodReport = { counts: { written_inactive: 0, row_absent: 1, duplicate_key: 0, kept_existing: 0 }, writtenInactive: [] }
    expect((await dispatch({}, owner(() => true, good).port)).result).toEqual({ ok: true, data: { ...good, report: goodReport } })
    // A sweep page carries `next` (the opaque cursor, or null once the sweep is exhausted) through unchanged.
    for (const next of [CURSOR, null]) {
      const page = { enabled: true, results: [], next }
      expect((await dispatch({}, owner(() => true, page).port)).result).toEqual({ ok: true, data: { ...page, report: { counts: { written_inactive: 0, row_absent: 0, duplicate_key: 0, kept_existing: 0 }, writtenInactive: [] } } })
    }
    // An answer of a switched-off core (enabled false) carries no report.
    expect((await dispatch({}, owner(() => true, { enabled: false, results: [] }).port)).result).toEqual({ ok: true, data: { enabled: false, results: [] } })
    for (const bad of [
      { enabled: true, results: [], next: 7 }, { enabled: true, results: [], next: 'not a cursor' }, { enabled: true, results: [], next: 'A'.repeat(2049) },
      { enabled: true, results: [], refused: 'AFTER' }, { enabled: true, results: [], refused: 'STALE' },
      { ...good, extra: 1 },
      { enabled: true, results: [{ ...good.results[0], projectNo: 'DEMO-P1' }] },
      { enabled: true, results: [{ ledgerId: LEDGER, kind: 'retryable', code: 'lowercase message' }] },
      { enabled: true, results: [{ ledgerId: LEDGER, kind: 'outcome', outcome: 'written', recorded: true, date: 'today', timeZone: 'Asia/Shanghai' }] },
      { enabled: true, results: [], stopped: 'OTHER' },
      // D3-1: a record id only on a dated written_inactive row; a runtime report that is not the rows' own; a report while off.
      { enabled: true, results: [{ ...good.results[0], recordId: 'rec-1' }] },
      { enabled: true, results: [{ ledgerId: LEDGER, kind: 'outcome', outcome: 'written_inactive', recorded: true, date: '2026-03-02', timeZone: 'Asia/Shanghai' }] },
      { enabled: true, results: [{ ledgerId: LEDGER, kind: 'outcome', outcome: 'written_inactive', recorded: true, recordId: 'rec-1' }] },
      { enabled: true, results: [{ ledgerId: LEDGER, kind: 'outcome', outcome: 'kept_existing', recorded: true, recordId: 'rec-1' }] },
      { enabled: true, results: [], report: { counts: { written_inactive: 1, row_absent: 0, duplicate_key: 0, kept_existing: 0 }, writtenInactive: [] } },
      { enabled: true, results: [], report: { counts: {}, writtenInactive: [] } },
      { enabled: false, results: [], report: { counts: { written_inactive: 0, row_absent: 0, duplicate_key: 0, kept_existing: 0 }, writtenInactive: [] } },
    ]) {
      const reply = await dispatch({}, owner(() => true, bad).port)
      expect(reply).toEqual({ status: 503, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_UNAVAILABLE' } } })
      expect(JSON.stringify(reply).includes('DEMO-P1')).toBe(false)
    }
  })
  it('D3-1: a written_inactive row reaches the caller with its record id, and the run report counts written_inactive, row_absent, duplicate_key and kept_existing and lists the written_inactive rows', async () => {
    const day = { date: '2026-03-02', timeZone: 'Asia/Shanghai' }
    const results = [
      { ledgerId: LEDGER, kind: 'outcome', outcome: 'written_inactive', recorded: true, ...day, recordId: 'rec-predecessor-1' },
      { ledgerId: 'l-2', kind: 'outcome', outcome: 'written', recorded: true, ...day },
      { ledgerId: 'l-3', kind: 'outcome', outcome: 'duplicate_key', recorded: true },
      { ledgerId: 'l-4', kind: 'outcome', outcome: 'kept_existing', recorded: false },
      { ledgerId: 'l-5', kind: 'outcome', outcome: 'written_inactive', recorded: false, ...day, recordId: 'rec-predecessor-5' },
      { ledgerId: 'l-6', kind: 'skip', reason: 'project_sheets_disabled' },
    ]
    const report = { counts: { written_inactive: 2, row_absent: 0, duplicate_key: 1, kept_existing: 1 },
      writtenInactive: [{ ledgerId: LEDGER, recordId: 'rec-predecessor-1' }, { ledgerId: 'l-5', recordId: 'rec-predecessor-5' }] }
    // Without the runtime's report (recomputed) and with an equal one (checked, then recomputed): the same reply.
    for (const answer of [{ enabled: true, results, next: null }, { enabled: true, results, report, next: null }]) {
      expect((await dispatch({}, owner(() => true, answer).port)).result).toEqual({ ok: true, data: { enabled: true, results, report, next: null } })
    }
  })
  it('a cursor the core refuses reaches the caller as the runtime INPUT code: a 400, nothing echoed', async () => {
    const port: Partial<YidaOwnerHttpPort> = { issueConfirmWritebackEnabled: () => true,
      async issueConfirmWriteback() { throw new YidaOwnerRuntimeError('INPUT') } }
    expect(await dispatch({ after: CURSOR }, port)).toEqual({ status: 400, result: { ok: false, error: { code: 'YIDA_OWNER_RUNTIME_INPUT' } } })
  })
  it('a cursor issued under another listed target set reaches the caller as YIDA_ISSUE_CONFIRM_CURSOR_STALE: a 409 (restart without after), nothing echoed', async () => {
    const stale = new YidaOwnerRuntimeError('CURSOR_STALE')
    expect([stale.code, stale.message]).toEqual(['YIDA_ISSUE_CONFIRM_CURSOR_STALE', 'YIDA_ISSUE_CONFIRM_CURSOR_STALE'])
    const port: Partial<YidaOwnerHttpPort> = { issueConfirmWritebackEnabled: () => true,
      async issueConfirmWriteback() { throw stale } }
    expect(await dispatch({ after: CURSOR }, port)).toEqual({ status: 409, result: { ok: false, error: { code: 'YIDA_ISSUE_CONFIRM_CURSOR_STALE' } } })
    // A foreign error that merely carries that text is not the runtime's own: the generic 503.
    const forged: Partial<YidaOwnerHttpPort> = { issueConfirmWritebackEnabled: () => true,
      async issueConfirmWriteback() { throw Object.assign(new Error('YIDA_ISSUE_CONFIRM_CURSOR_STALE'), { code: 'YIDA_ISSUE_CONFIRM_CURSOR_STALE' }) } }
    expect(await dispatch({ after: CURSOR }, forged)).toEqual({ status: 503, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_UNAVAILABLE' } } })
  })
})

const PRIMITIVE_KEYS = ['resolveSelectionInTransaction', 'executionPayloadDigest', 'sendBudget', 'draftSendBudget', 'prepareInTransaction',
  'loadExecutionMaterialInTransaction', 'previewInTransaction', 'prepareDraftInTransaction',
  // Y6 P1 (generated-layout seal): the core authority requires this primitive too; never reached here (no approval runs).
  'sealGeneratedLayoutInTransaction']
function runtimeFixture(options: { enabled?: () => unknown; recheck?: () => Promise<boolean> } = {}) {
  const calls = { transaction: 0, create: 0, sendOptions: [] as string[][], recheck: 0 }
  const runtime = createYidaOwnerRuntime({
    database: { async transaction() { calls.transaction++; throw new Error('SYNTHETIC_DATABASE_UNAVAILABLE') } },
    security: { async encrypt() { throw new Error('NO') }, async decrypt() { throw new Error('NO') } },
    fetch: (() => { throw new Error('NO_NETWORK') }) as unknown as typeof fetch,
    readEnablement: () => 'true',
    issueConfirmRecheck: async () => { calls.recheck++; return options.recheck ? options.recheck() : true },
  })
  const primitives = Object.fromEntries(PRIMITIVE_KEYS.map(key => [key, () => { throw new Error('NO_PRIMITIVE_IO') }]))
  const base = {
    createPrimitives: () => primitives,
    createSendPort: (input: Record<string, unknown>) => {
      calls.sendOptions.push(Object.keys(input).sort())
      return { async submit() { throw new Error('SYNTHETIC_SUBMIT') } }
    },
  }
  const writeback = {
    createIssueConfirmWriteback: () => { calls.create++; return { async run() { return { enabled: true, results: [] } } } },
    issueConfirmWritebackEnabled: options.enabled ?? (() => true),
  }
  return { runtime, calls, base, writeback }
}

describe('owner runtime: the write-back members', () => {
  it('the two write-back members come together or not at all', async () => {
    for (const binding of [
      (f: ReturnType<typeof runtimeFixture>) => ({ ...f.base, createIssueConfirmWriteback: f.writeback.createIssueConfirmWriteback }),
      (f: ReturnType<typeof runtimeFixture>) => ({ ...f.base, issueConfirmWritebackEnabled: f.writeback.issueConfirmWritebackEnabled }),
      (f: ReturnType<typeof runtimeFixture>) => ({ ...f.base, ...f.writeback, issueConfirmWritebackEnabled: 'yes' }),
    ]) {
      const f = runtimeFixture()
      await expect(f.runtime.createPluginCapability().activate(binding(f) as never)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    }
  })
  it('enabled bit: false without an active binding or without the capability; the binding\'s exact true otherwise; a throw is false', async () => {
    const plain = runtimeFixture()
    expect(plain.runtime.issueConfirmWritebackEnabled()).toBe(false)
    await plain.runtime.createPluginCapability().activate(plain.base as never)
    expect(plain.runtime.issueConfirmWritebackEnabled()).toBe(false)
    for (const [value, expected] of [[true, true], ['true', false], [1, false]] as const) {
      const f = runtimeFixture({ enabled: () => value })
      await f.runtime.createPluginCapability().activate({ ...f.base, ...f.writeback } as never)
      expect(f.runtime.issueConfirmWritebackEnabled()).toBe(expected)
    }
    const thrown = runtimeFixture({ enabled: () => { throw new Error('SYNTHETIC') } })
    await thrown.runtime.createPluginCapability().activate({ ...thrown.base, ...thrown.writeback } as never)
    expect(thrown.runtime.issueConfirmWritebackEnabled()).toBe(false)
  })
  it('OFF: DISABLED before any proof, transaction or capability call; ON: the live proof runs FIRST (a refused proof creates nothing)', async () => {
    const off = runtimeFixture({ enabled: () => false })
    await off.runtime.createPluginCapability().activate({ ...off.base, ...off.writeback } as never)
    await expect(off.runtime.issueConfirmWriteback(actor, {})).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' })
    expect([off.calls.transaction, off.calls.create, off.calls.recheck]).toEqual([0, 0, 0])
    const on = runtimeFixture()
    await on.runtime.createPluginCapability().activate({ ...on.base, ...on.writeback } as never)
    // proveDraftTarget opens a transaction first; this one is refused, so the write-back capability is never created.
    await expect(on.runtime.issueConfirmWriteback(actor, {})).rejects.toBeTruthy()
    expect(on.calls.transaction).toBe(1)
    expect([on.calls.create, on.calls.recheck]).toEqual([0, 0])
    // Without the capability the entry is UNAVAILABLE and touches nothing.
    const plain = runtimeFixture()
    await plain.runtime.createPluginCapability().activate(plain.base as never)
    await expect(plain.runtime.issueConfirmWriteback(actor, {})).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_UNAVAILABLE' })
    expect(plain.calls.transaction).toBe(0)
  })
  it.each([
    ['extra key', { limit: 1, ownerId: 'x' }], ['limit 0', { limit: 0 }], ['limit 101', { limit: 101 }], ['empty ids', { ledgerIds: [] }],
    ['duplicate ids', { ledgerIds: ['a', 'a'] }], ['padded id', { ledgerIds: [' a'] }], ['not an object', 'x'],
    ['after with ledgerIds', { ledgerIds: ['a'], after: CURSOR }], ['after not a string', { after: 1 }], ['after with padding', { after: `${CURSOR}=` }],
    ['after too long', { after: 'A'.repeat(2049) }],
  ])('run input %s is INPUT before anything runs', async (_name, input) => {
    const f = runtimeFixture()
    await f.runtime.createPluginCapability().activate({ ...f.base, ...f.writeback } as never)
    await expect(f.runtime.issueConfirmWriteback(actor, input as never)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    expect([f.calls.transaction, f.calls.create]).toEqual([0, 0])
  })
  it('the send port gets the original closed options from every binding: the post-ACK write-back is the host runtime\'s own run', async () => {
    for (const armed of [false, true]) {
      const f = runtimeFixture()
      await f.runtime.createPluginCapability().activate((armed ? { ...f.base, ...f.writeback } : f.base) as never)
      await expect(f.runtime.submit(actor, { grantId: 'g', submissionId: 's' })).rejects.toBeTruthy()
      expect(f.calls.sendOptions).toEqual([['authority', 'context', 'fetch', 'readEnablement', 'timeoutMs']])
      // A failed send never schedules a write-back.
      await new Promise(resolve => setTimeout(resolve, 20))
      expect([f.calls.create, f.calls.recheck]).toEqual([0, 0])
    }
  })
})

// ── Y9 r1 M2 ruling (design baseline v2.3 D5 a / §7.3): the post-ACK hook runs AFTER submit returned ────────────────
const GRANT = 'synthetic-wb-grant'
function sendResponse(options: { reused?: boolean; status?: string; ledgerId?: string } = {}) {
  const status = options.status ?? 'acknowledged'
  const approval = Object.freeze({ grantId: GRANT, operationId: 'synthetic-wb-op', rowKey: 'synthetic-wb-row', targetRef: 'synthetic-wb-target',
    approvedAt: 1, expiresAt: 2, maxAttempts: 1, remainingAttempts: 0, status: 'admitted', revoked: false,
    admissionId: 'synthetic-wb-admission', ledgerId: LEDGER, canSend: false, externalWriteAttempted: false })
  return { approval, delivery: { id: options.ledgerId ?? LEDGER, status, durable: true }, reused: options.reused ?? false, status,
    externalWriteAttempted: !options.reused, businessVerified: false, durable: true }
}
type Deferred = { promise: Promise<void>; release(): void }
function deferred(): Deferred {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const pause = (ms: number) => new Promise<'PAUSED'>(resolve => setTimeout(() => resolve('PAUSED'), ms))
function hookFixture(options: { run?: (input: unknown) => Promise<unknown>; response?: () => unknown; capability?: boolean; offAfterReceipt?: boolean } = {}) {
  const calls = { runs: [] as unknown[], contexts: [] as unknown[], warnings: [] as string[], settledAtRunStart: [] as boolean[], sends: 0 }
  const state = { sendSettled: false, enablement: 'true' }
  const runtime = createYidaOwnerRuntime({
    database: { async transaction() { throw new Error('SYNTHETIC_DATABASE_UNAVAILABLE') } },
    security: { async encrypt() { throw new Error('NO') }, async decrypt() { throw new Error('NO') } },
    fetch: (() => { throw new Error('NO_NETWORK') }) as unknown as typeof fetch,
    readEnablement: () => state.enablement,
    issueConfirmRecheck: async () => true,
    warn: code => { calls.warnings.push(code) },
  })
  const primitives = Object.fromEntries(PRIMITIVE_KEYS.map(key => [key, () => { throw new Error('NO_PRIMITIVE_IO') }]))
  const binding = {
    createPrimitives: () => primitives,
    createSendPort: () => ({ async submit() {
      calls.sends++
      if (options.offAfterReceipt) state.enablement = 'false'
      return options.response ? options.response() : sendResponse()
    } }),
    ...(options.capability === false ? {} : {
      createIssueConfirmWriteback: (input: { context: unknown }) => {
        calls.contexts.push(input.context)
        return { run: (request: unknown) => {
          calls.settledAtRunStart.push(state.sendSettled)
          calls.runs.push(request)
          return options.run ? options.run(request) : Promise.resolve({ enabled: true, results: [] })
        } }
      },
      issueConfirmWritebackEnabled: () => true,
    }),
  }
  async function send() {
    const pending = runtime.submit(actor, { grantId: GRANT, submissionId: 'synthetic-wb-submission' })
    pending.then(() => { state.sendSettled = true }, () => { state.sendSettled = true })
    return pending
  }
  return { runtime, binding, calls, send, state }
}
async function until(predicate: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('SYNTHETIC_WAIT_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('owner runtime: the post-ACK write-back is a tracked run AFTER submit returned (D5 a)', () => {
  it('result first: the send resolves while the hook is still parked, and the hook starts only after the send settled', async () => {
    const gate = deferred()
    const f = hookFixture({ run: async () => { await gate.promise; return { enabled: true, results: [] } } })
    await f.runtime.createPluginCapability().activate(f.binding as never)
    const outcome = await Promise.race([f.send(), pause(1000)])
    expect(outcome).not.toBe('PAUSED')
    expect((outcome as { status: string }).status).toBe('acknowledged')
    await until(() => f.calls.runs.length === 1)
    // The hook began strictly after the send's promise had settled; it is still parked now.
    expect(f.calls.settledAtRunStart).toEqual([true])
    expect(f.calls.runs).toEqual([{ ledgerIds: [LEDGER] }])
    expect(f.calls.contexts).toEqual([actor])
    // Released before stop(), the run completes on its own: no warning. (Released only after stop() began, its
    // post-run checkpoint answers CANCELLED — the hanging-hook case below.)
    gate.release()
    await pause(30)
    await f.runtime.stop()
    expect(f.calls.warnings).toEqual([])
  })
  it('a failing hook (throw or rejection) neither changes nor delays the send result; one fixed values-free warning', async () => {
    const plain = hookFixture({ capability: false })
    await plain.runtime.createPluginCapability().activate(plain.binding as never)
    const expected = await plain.send()
    for (const run of [
      () => { throw new Error('SYNTHETIC_HOOK_THROW DEMO-P1') },
      () => Promise.reject(new Error('SYNTHETIC_HOOK_REJECT DEMO-P1')),
      () => Promise.resolve({ enabled: true, results: [{ ledgerId: LEDGER, kind: 'outcome', outcome: 'written', recorded: true, projectNo: 'DEMO-P1' }] }),
    ]) {
      const f = hookFixture({ run })
      await f.runtime.createPluginCapability().activate(f.binding as never)
      const result = await Promise.race([f.send(), pause(1000)])
      expect(result).toEqual(expected)
      await until(() => f.calls.warnings.length === 1)
      expect(f.calls.warnings).toEqual(['YIDA_ISSUE_CONFIRM_WRITEBACK_AFTER_ACK_FAILED'])
      await f.runtime.stop()
    }
  })
  // Stock-prep condition C2: a post-ACK run that FINISHED normally with a retryable row logs one fixed values-free code, once.
  const DEFERRED = 'YIDA_ISSUE_CONFIRM_WRITEBACK_DEFERRED'
  // Stock-prep ruling (post-ACK terminal non-write outcomes): a run that FINISHED normally with such an outcome logs the
  // fixed code plus `outcome=count` pairs in the core's vocabulary order, once per run.
  const UNWRITTEN = 'YIDA_ISSUE_CONFIRM_WRITEBACK_UNWRITTEN'
  const TERMINAL_NON_WRITE = ['row_absent', 'duplicate_key', 'project_absent', 'project_archived', 'project_mismatch',
    'payload_unmapped', 'sheet_mismatch', 'permission_revoked', 'source_unbound'] as const
  const terminal = (outcome: string, ledgerId = LEDGER) => ({ ledgerId, kind: 'outcome', outcome, recorded: true })
  const OTHER = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`
  it.each([
    ...TERMINAL_NON_WRITE.map(outcome => [`outcome ${outcome}`, { enabled: true, results: [terminal(outcome)] }, [`${UNWRITTEN} ${outcome}=1`]] as const),
    // Several rows (a fake answer: the real post-ACK run names one ledger row): counts per outcome, vocabulary order
    // (not answer order), written / already_set / kept_existing / skips not counted, one line for the run.
    ['mixed terminal outcomes', { enabled: true, results: [terminal('source_unbound', OTHER(1)), terminal('row_absent', OTHER(2)),
      { ledgerId: OTHER(3), kind: 'outcome', outcome: 'written', recorded: true, date: '2026-03-01', timeZone: 'Asia/Shanghai' },
      terminal('row_absent', OTHER(4)), { ledgerId: OTHER(5), kind: 'outcome', outcome: 'kept_existing', recorded: false },
      { ledgerId: OTHER(6), kind: 'skip', reason: 'already_traced' }, terminal('sheet_mismatch', OTHER(7))] },
    [`${UNWRITTEN} row_absent=2 sheet_mismatch=1 source_unbound=1`]],
    // DEFERRED and UNWRITTEN from one run: both, each once, DEFERRED first.
    ['a retryable row and a terminal non-write outcome', { enabled: true, results: [terminal('project_archived', OTHER(1)),
      { ledgerId: OTHER(2), kind: 'retryable', code: 'STOCK_PREP_PROJECT_WRITE_LOCKED' },
      { ledgerId: OTHER(3), kind: 'retryable', code: 'YIDA_ISSUE_CONFIRM_RECORDS_INVALID' }, terminal('project_archived', OTHER(4))] },
    [DEFERRED, `${UNWRITTEN} project_archived=2`]],
    // A recorded:false answer (another run traced first) still names the outcome this run decided.
    ['a terminal outcome another run traced first (recorded false)', { enabled: true, results: [{ ...terminal('duplicate_key'), recorded: false }] },
      [`${UNWRITTEN} duplicate_key=1`]],
  ] as Array<readonly [string, unknown, readonly string[]]>)('UNWRITTEN signal, %s', async (_name, answer, expected) => {
    const f = hookFixture({ run: async () => answer })
    await f.runtime.createPluginCapability().activate(f.binding as never)
    expect((await Promise.race([f.send(), pause(1000)]) as { status: string }).status).toBe('acknowledged')
    await until(() => f.calls.runs.length === 1)
    await until(() => f.calls.warnings.length >= expected.length)
    await pause(30)
    // Once per run, values-free: the fixed codes and outcome=count only (no ledger id, no value).
    expect(f.calls.warnings).toEqual([...expected])
    for (const text of f.calls.warnings) expect(text.includes(LEDGER) || /\d{4}-\d{2}-\d{2}/.test(text)).toBe(false)
    await f.runtime.stop()
    expect(f.calls.warnings).toEqual([...expected])
  })
  it('UNWRITTEN signal: a terminal outcome from a run that stop() cancelled is the failure code alone, never UNWRITTEN as well', async () => {
    const gate = deferred()
    const f = hookFixture({ run: async () => {
      await gate.promise
      return { enabled: true, results: [terminal('row_absent')] }
    } })
    await f.runtime.createPluginCapability().activate(f.binding as never)
    await f.send()
    await until(() => f.calls.runs.length === 1)
    const stopping = f.runtime.stop()
    gate.release()
    await stopping
    await until(() => f.calls.warnings.length > 0)
    await pause(30)
    expect(f.calls.warnings).toEqual(['YIDA_ISSUE_CONFIRM_WRITEBACK_AFTER_ACK_FAILED'])
  })
  it.each([
    ['retryable: the sheet lease is held (WRITE_LOCKED)', { enabled: true, results: [{ ledgerId: LEDGER, kind: 'retryable', code: 'STOCK_PREP_PROJECT_WRITE_LOCKED' }] }, [DEFERRED]],
    ['retryable: the write-back switch turned off mid-run', { enabled: true, results: [{ ledgerId: LEDGER, kind: 'retryable', code: 'SWITCH_OFF' }], stopped: 'SWITCH_OFF' }, [DEFERRED]],
    ['skip project_sheets_disabled (D14: the project-sheets switch is off)', { enabled: true, results: [{ ledgerId: LEDGER, kind: 'skip', reason: 'project_sheets_disabled' }] }, []],
    ['skip already_traced', { enabled: true, results: [{ ledgerId: LEDGER, kind: 'skip', reason: 'already_traced' }] }, []],
    ['skip acknowledgement_missing', { enabled: true, results: [{ ledgerId: LEDGER, kind: 'skip', reason: 'acknowledgement_missing' }] }, []],
    ['outcome written', { enabled: true, results: [{ ledgerId: LEDGER, kind: 'outcome', outcome: 'written', recorded: true, date: '2026-03-01', timeZone: 'Asia/Shanghai' }] }, []],
    ['outcome permission_revoked (terminal, non-write: UNWRITTEN, never DEFERRED)', { enabled: true, results: [{ ledgerId: LEDGER, kind: 'outcome', outcome: 'permission_revoked', recorded: true }] }, [`${UNWRITTEN} permission_revoked=1`]],
    ['outcome already_set (the date is there)', { enabled: true, results: [{ ledgerId: LEDGER, kind: 'outcome', outcome: 'already_set', recorded: true, date: '2026-03-01', timeZone: 'Asia/Shanghai' }] }, []],
    ['outcome kept_existing (D8: another value stays)', { enabled: true, results: [{ ledgerId: LEDGER, kind: 'outcome', outcome: 'kept_existing', recorded: true }] }, []],
    ['an empty answer (not selected)', { enabled: true, results: [] }, []],
    ['the write-back switch off (enabled false)', { enabled: false, results: [] }, []],
  ])('C2 signal, %s', async (_name, answer, expected) => {
    const f = hookFixture({ run: async () => answer })
    await f.runtime.createPluginCapability().activate(f.binding as never)
    expect((await Promise.race([f.send(), pause(1000)]) as { status: string }).status).toBe('acknowledged')
    await until(() => f.calls.runs.length === 1)
    if (expected.length > 0) await until(() => f.calls.warnings.length > 0)
    await pause(30)
    // Exactly once, the fixed code alone: no id, no value, no count.
    expect(f.calls.warnings).toEqual(expected)
    await f.runtime.stop()
    expect(f.calls.warnings).toEqual(expected)
  })
  it('C2 signal: a retryable answer from a run that stop() cancelled is the failure code alone, never DEFERRED as well', async () => {
    const gate = deferred()
    const f = hookFixture({ run: async () => {
      await gate.promise
      return { enabled: true, results: [{ ledgerId: LEDGER, kind: 'retryable', code: 'STOCK_PREP_PROJECT_WRITE_LOCKED' }] }
    } })
    await f.runtime.createPluginCapability().activate(f.binding as never)
    await f.send()
    await until(() => f.calls.runs.length === 1)
    const stopping = f.runtime.stop()
    gate.release()
    await stopping
    await until(() => f.calls.warnings.length > 0)
    await pause(30)
    expect(f.calls.warnings).toEqual(['YIDA_ISSUE_CONFIRM_WRITEBACK_AFTER_ACK_FAILED'])
  })
  it('scheduled on either settlement, independent of the send switch: OFF after the receipt rejects the send, the run still runs once', async () => {
    // T-level default (Y9 r2 L-e): the acknowledgement is durable even when the send run's exit refuses to expose it.
    // The switch flips OFF after the receipt and stays OFF while the post-ACK run is scheduled and runs.
    const f = hookFixture({ offAfterReceipt: true })
    await f.runtime.createPluginCapability().activate(f.binding as never)
    await expect(f.send()).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' })
    await until(() => f.calls.runs.length === 1)
    expect(f.calls.settledAtRunStart).toEqual([true])
    expect(f.calls.runs).toEqual([{ ledgerIds: [LEDGER] }])
    await pause(30)
    expect([f.calls.runs.length, f.calls.warnings]).toEqual([1, []])
    expect(f.state.enablement).toBe('false')
    await f.runtime.stop()
  })
  it('a hanging hook delays nothing but stop(): stop() waits for the in-flight hook within the barrier, then resolves', async () => {
    const gate = deferred()
    const f = hookFixture({ run: async () => { await gate.promise; return { enabled: true, results: [] } } })
    await f.runtime.createPluginCapability().activate(f.binding as never)
    expect((await Promise.race([f.send(), pause(1000)]) as { status: string }).status).toBe('acknowledged')
    // A second send is not held up by the first one's parked hook either.
    expect((await Promise.race([f.send(), pause(1000)]) as { status: string }).status).toBe('acknowledged')
    await until(() => f.calls.runs.length === 2)
    let stopped = false
    const stopping = f.runtime.stop().then(() => { stopped = true })
    expect(await Promise.race([stopping.then(() => 'STOPPED'), pause(100)])).toBe('PAUSED')
    expect(stopped).toBe(false)
    gate.release()
    await stopping
    expect(stopped).toBe(true)
  })
  it.each([
    ['a reused submit (history only)', { reused: true }],
    ['outcome_unknown', { status: 'outcome_unknown' }],
    ['prepared', { status: 'prepared' }],
    ['not_sent', { status: 'not_sent' }],
    ['a delivery row that is not this grant\'s ledger row', { ledgerId: '66666666-6666-4666-8666-666666666666' }],
  ])('%s never schedules a write-back', async (_name, response) => {
    const f = hookFixture({ response: () => sendResponse(response) })
    await f.runtime.createPluginCapability().activate(f.binding as never)
    await f.send()
    await pause(30)
    expect([f.calls.runs.length, f.calls.contexts.length]).toEqual([0, 0])
    await f.runtime.stop()
  })
  it('a binding without the capability never schedules; a send cancelled by stop() schedules nothing', async () => {
    const plain = hookFixture({ capability: false })
    await plain.runtime.createPluginCapability().activate(plain.binding as never)
    await plain.send()
    await pause(30)
    expect(plain.calls.warnings).toEqual([])
    const f = hookFixture()
    await f.runtime.createPluginCapability().activate(f.binding as never)
    const sent = f.runtime.submit(actor, { grantId: GRANT, submissionId: 'synthetic-wb-submission' })
    const stopping = f.runtime.stop()
    await expect(sent).rejects.toBeTruthy()
    await stopping
    await pause(30)
    expect([f.calls.sends, f.calls.runs.length, f.calls.warnings.length]).toEqual([0, 0, 0])
  })
})

describe('D13 a live re-check', () => {
  const codes = ['stock-prep:admin', 'stock-prep:operate', 'stock-prep:read', 'role:admin', 'integration:admin', 'stock-prep:pull']
  it('the role-granted operator tier: stock-prep:admin, or operate AND read; platform-admin codes do not substitute', () => {
    for (let mask = 0; mask < 1 << codes.length; mask++) {
      const held = codes.filter((_, index) => mask & (1 << index))
      const expected = held.includes('stock-prep:admin') || (held.includes('stock-prep:operate') && held.includes('stock-prep:read'))
      expect(issueConfirmRoleGrantSatisfied(held), held.join(',')).toBe(expected)
    }
  })
  it('a scope that is not the authenticated owner is refused before any transaction (never a verdict)', async () => {
    let transactions = 0
    const database = { async transaction() { transactions++; throw new Error('NO') } }
    for (const input of [null, {}, { tenantId: 'other', ownerId: actor.actorId, sheetId: 's' }, { tenantId: actor.tenantId, ownerId: 'other', sheetId: 's' },
      { tenantId: actor.tenantId, ownerId: actor.actorId, sheetId: ' s' }]) {
      await expect(yidaIssueConfirmLiveRecheck(database, actor, input)).rejects.toMatchObject({ code: 'YIDA_ISSUE_CONFIRM_AUTHORITY_UNAVAILABLE' })
    }
    expect(transactions).toBe(0)
    // A failing transaction is UNAVAILABLE, not a "false" verdict.
    await expect(yidaIssueConfirmLiveRecheck(database, actor, { tenantId: actor.tenantId, ownerId: actor.actorId, sheetId: 's' }))
      .rejects.toMatchObject({ code: 'YIDA_ISSUE_CONFIRM_AUTHORITY_UNAVAILABLE' })
    expect(transactions).toBe(1)
  })
})
