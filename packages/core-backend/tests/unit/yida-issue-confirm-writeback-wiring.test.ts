// YiDa 发料确认日期回写 — the HOST half of the wiring at unit level (slice Y9; design baseline v2.3 §7.3, D5 b, D13 a):
//   - POST /issue-confirm-writeback: the generic 404 while the switch is OFF (no port call), the closed body, the closed
//     values-free reply projection;
//   - the owner runtime: the write-back binding members come together or not at all, the enabled bit, DISABLED before
//     any proof, the live proof BEFORE the capability is even created, the closed run input, the send port's original
//     closed options from every binding, and the post-ACK write-back as a tracked run of its own AFTER submit returned
//     (D5 a; result first, a failing or hanging hook never changes or delays the result, stop() drains it);
//   - the D13 a role rule (pure) and the re-check's refusal of a foreign scope before any transaction.
// The real-PG proofs are tests/integration/stock-preparation-yida-issue-confirm-writeback-realdb.test.ts.
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { createIntegrationYidaOwnerRouter, yidaOwnerNoStoreMiddleware, type YidaOwnerHttpPort } from '../../src/routes/integration-yida-owner'
import { createYidaOwnerRuntime } from '../../src/integration/yida-owner-runtime'
import { issueConfirmRoleGrantSatisfied, yidaIssueConfirmLiveRecheck } from '../../src/integration/yida-issue-confirm-writeback-authority'

const actor = Object.freeze({ actorId: 'synthetic-wb-owner', tenantId: 'synthetic-wb-tenant', workspaceId: null })
const LEDGER = '55555555-5555-4555-8555-555555555555'

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
  it('ON: the closed body reaches the runtime as the authenticated owner, with only ledgerIds / limit', async () => {
    const { port, calls } = owner(() => true)
    expect(await dispatch({}, port)).toEqual({ status: 200, result: { ok: true, data: { enabled: true, results: [] } } })
    expect((await dispatch({ limit: 5 }, port)).status).toBe(200)
    expect((await dispatch({ ledgerIds: [LEDGER] }, port)).status).toBe(200)
    expect((await dispatch(undefined, port)).status).toBe(400)
    expect(calls).toEqual([{ who: actor, input: {} }, { who: actor, input: { limit: 5 } }, { who: actor, input: { ledgerIds: [LEDGER] } }])
  })
  it.each([
    ['an extra key', { limit: 1, tenantId: 'x' }], ['limit 0', { limit: 0 }], ['limit 101', { limit: 101 }], ['limit as text', { limit: '5' }],
    ['empty ledgerIds', { ledgerIds: [] }], ['duplicate ledgerIds', { ledgerIds: [LEDGER, LEDGER] }], ['non-string id', { ledgerIds: [1] }],
    ['101 ledgerIds', { ledgerIds: Array.from({ length: 101 }, (_, index) => `ledger-${index}`) }], ['padded id', { ledgerIds: [' x'] }],
    ['an owner key', { ownerId: 'synthetic-other' }],
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
    expect((await dispatch({}, owner(() => true, good).port)).result).toEqual({ ok: true, data: good })
    for (const bad of [
      { ...good, extra: 1 },
      { enabled: true, results: [{ ...good.results[0], projectNo: 'DEMO-P1' }] },
      { enabled: true, results: [{ ledgerId: LEDGER, kind: 'retryable', code: 'lowercase message' }] },
      { enabled: true, results: [{ ledgerId: LEDGER, kind: 'outcome', outcome: 'written', recorded: true, date: 'today', timeZone: 'Asia/Shanghai' }] },
      { enabled: true, results: [], stopped: 'OTHER' },
    ]) {
      const reply = await dispatch({}, owner(() => true, bad).port)
      expect(reply).toEqual({ status: 503, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_UNAVAILABLE' } } })
      expect(JSON.stringify(reply).includes('DEMO-P1')).toBe(false)
    }
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
