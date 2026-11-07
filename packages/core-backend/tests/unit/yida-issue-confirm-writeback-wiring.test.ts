// YiDa 发料确认日期回写 — the HOST half of the wiring at unit level (slice Y9; design baseline v2.3 §7.3, D5 b, D13 a):
//   - POST /issue-confirm-writeback: the generic 404 while the switch is OFF (no port call), the closed body, the closed
//     values-free reply projection;
//   - the owner runtime: the write-back binding members come together or not at all, the enabled bit, DISABLED before
//     any proof, the live proof BEFORE the capability is even created, the closed run input, and the send port gets the
//     host re-check only from a binding that carries the capability;
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
  'loadExecutionMaterialInTransaction', 'previewInTransaction', 'prepareDraftInTransaction']
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
  it('submit hands the send port the host re-check ONLY when the binding carries the capability', async () => {
    const plain = runtimeFixture()
    await plain.runtime.createPluginCapability().activate(plain.base as never)
    await expect(plain.runtime.submit(actor, { grantId: 'g', submissionId: 's' })).rejects.toBeTruthy()
    expect(plain.calls.sendOptions).toEqual([['authority', 'context', 'fetch', 'readEnablement', 'timeoutMs']])
    const armed = runtimeFixture()
    await armed.runtime.createPluginCapability().activate({ ...armed.base, ...armed.writeback } as never)
    await expect(armed.runtime.submit(actor, { grantId: 'g', submissionId: 's' })).rejects.toBeTruthy()
    expect(armed.calls.sendOptions).toEqual([['authority', 'context', 'fetch', 'issueConfirmRecheck', 'readEnablement', 'timeoutMs']])
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
