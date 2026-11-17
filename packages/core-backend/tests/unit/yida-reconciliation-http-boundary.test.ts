// R-71 ⑦.5 reconciliation HTTP boundary (plan RC17, verifier F1/F4): the ACTUAL Express owner router wired to the
// ACTUAL reconciliation host runtime. The runtime's switch reader stands in for INTEGRATION_YIDA_RECONCILE_READ_ENABLED;
// its live-ACL check runs over a synthetic query model and the plugin port is a double. Dispatch over an EventEmitter
// request (no listener, no socket, no supertest app). The full MetaSheetServer wiring (src/index.ts) is proved over
// real JWT HTTP in yida-host-boundaries-realdb.test.ts (T4).
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { createIntegrationYidaOwnerRouter, yidaOwnerNoStoreMiddleware,
  type YidaInitializationHttpPort, type YidaOwnerHttpPort } from '../../src/routes/integration-yida-owner'
import { createYidaReconciliationRuntime, type YidaReconciliationRuntimeBinding } from '../../src/integration/yida-reconciliation-runtime'
import { YIDA_OWNER_HTTP_PREFIX as PREFIX } from '../../src/integration/yida-owner-http-observation'
import type { YidaInitializationDatabase } from '../../src/integration/yida-initialization-bootstrap'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { draftInput, syntheticMaterial } from '../utils/stock-preparation-yida-owner-http-fixture'

type Row = Record<string, unknown>
const actor = Object.freeze({ actorId: 'synthetic-http-owner', tenantId: 'synthetic-http-tenant', workspaceId: null })
const runId = '00000000-0000-4000-8000-0000000000a1'
const commandId = '00000000-0000-4000-8000-0000000000c1'
const initCommand = '11111111-1111-4111-8111-111111111111'
const body = (patch: Row = {}) => ({ commandId, mode: 'count', projectNo: 'DEMO-P1', projectKeyTarget: 'project',
  expectedKeyTargets: ['project', 'drawingNo'], ...patch })
const counts = () => Object.freeze(Object.fromEntries(['scanned', 'registered', 'would_register', 'already_reconciled', 'duplicate_remote',
  'own_acknowledged', 'duplicate_with_own', 'own_in_flight', 'observed_for_unknown', 'own_not_sent', 'project_mismatch',
  'key_unmatchable'].map(key => [key, 0])))
const view = (patch: Row = {}) => Object.freeze({ runId, commandId, targetRef: 'synthetic-target', mode: 'count', status: 'completed',
  nextPageNumber: 2, pagesDone: 1, totalCountFirst: 0, totalCountLast: 0, counts: counts(), lastErrorCode: null, tokenIssued: true,
  canSend: false, externalWriteAttempted: false, businessVerified: false, historyVerified: false, formOwnershipVerified: false, ...patch })
const ready = () => ({ commandId: initCommand, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false })
const initPort: YidaInitializationHttpPort = { async status() { return ready() }, async initialize() { return ready() } }

/** The actual host runtime over a synthetic live-ACL model (the same model as yida-reconciliation-runtime.test.ts). */
async function host(enablement: unknown, multiTarget: unknown = 'false', anchorOwner: string = actor.actorId) {
  let transactions = 0
  const query: Queryable['query'] = vi.fn(async (text: string, params?: unknown[]) => {
    let rows: Row[] = []
    const user = params?.[0]
    if (text.includes('transaction_isolation')) rows = [{ isolation: 'read committed' }]
    else if (text.includes('pg_current_xact_id')) rows = [{ xid: 'synthetic-stable-xid' }]
    else if (text.includes('pg_advisory_xact_lock')) rows = [{}]
    else if (/FROM user_roles\b/u.test(text)) rows = [{ role_id: 'admin' }]
    else if (/FROM role_permissions\b|FROM user_permissions\b/u.test(text)) rows = []
    else if (/FROM users\b/u.test(text)) rows = [{ id: user, role: 'admin', is_active: true, activation_status: 'activated', permissions: [] }]
    else if (/FROM user_orgs\b/u.test(text)) rows = [{ user_id: user, org_id: params?.[1], is_active: true }]
    else if (/FROM user_namespace_admissions\b/u.test(text)) rows = []
    else if (text.includes('FROM integration_yida_initialization_anchor')) rows = [{ slot: 1, owner_id: anchorOwner, tenant_id: actor.tenantId, workspace_id: null }]
    else throw new Error('Unexpected synthetic query')
    return { rows, rowCount: rows.length }
  })
  const database: YidaInitializationDatabase = { async transaction<T>(work: (trx: Queryable) => Promise<T>) { transactions++; return work({ query }) } }
  const fetch = vi.fn(async () => new Response('{}')) as unknown as typeof globalThis.fetch
  const calls: Array<[string, unknown]> = []
  const binding: YidaReconciliationRuntimeBinding = {
    createReconciliationPort() {
      return Object.freeze({
        step: async (value: unknown) => { calls.push(['step', value]); return view() },
        inspect: async (value: unknown) => { calls.push(['inspect', value]); return view() },
        abandon: async (value: unknown) => { calls.push(['abandon', value]); return view({ status: 'failed', lastErrorCode: 'ABORTED' }) },
      })
    },
  }
  const runtime = createYidaReconciliationRuntime({ database, fetch, readEnablement: () => enablement,
    readMultiTargetEnablement: () => multiTarget })
  await runtime.createPluginCapability().activate(binding)
  return { runtime, calls, fetch, transactions: () => transactions }
}

async function dispatch(method: string, url: string, payload: unknown,
  reconciliationPort?: Parameters<typeof createIntegrationYidaOwnerRouter>[4], multiTarget = false) {
  const req = Object.assign(new EventEmitter(), { method, url, originalUrl: PREFIX + url, headers: {},
    query: {}, body: payload, user: { id: actor.actorId }, authenticatedTenantId: actor.tenantId, aborted: false })
  let status = 0
  const owner = { sendEnabled: () => false, multiTargetEnabled: () => multiTarget } as unknown as YidaOwnerHttpPort
  const router = createIntegrationYidaOwnerRouter(owner, initPort, undefined, undefined, reconciliationPort)
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, setHeader() {},
    status(value: number) { status = value; return this }, json(_body: unknown) {} })
  const result = await new Promise<unknown>((resolve, reject) => {
    res.json = (sent: unknown) => { res.writableEnded = true; resolve(sent) }
    yidaOwnerNoStoreMiddleware(req as unknown as Request, res as unknown as Response, () => {
      router(req as unknown as Request, res as unknown as Response, reject)
    })
  })
  await Promise.resolve()
  return { status, result }
}
const notFound = { status: 404, result: { ok: false, error: { code: 'NOT_FOUND' } } }
const requests = (): Array<[string, string, unknown]> => [
  ['POST', '/reconciliations', body()],
  ['POST', '/reconciliations/abandon', {}],
  ['GET', `/reconciliations/${runId}`, undefined],
]

describe('YiDa ⑦.5 reconciliation HTTP boundary — actual router + actual host runtime, no IO', () => {
  // F1: OFF = the generic 404 of an unknown path, before any transaction, port or fetch.
  it.each([[undefined], ['false'], ['TRUE'], [' true'], ['true '], ['1'], [''], [true]])(
    'switch %j: every reconciliation path answers the generic 404 and nothing runs', async (value) => {
      const h = await host(value)
      for (const [method, url, payload] of requests()) expect(await dispatch(method, url, payload, h.runtime)).toEqual(notFound)
      expect(h.calls).toEqual([])
      expect(h.transactions()).toBe(0)
      expect(h.fetch).not.toHaveBeenCalled()
    })

  it('no reconciliation port wired: the paths are the generic 404 even with the switch on', async () => {
    for (const [method, url, payload] of requests()) expect(await dispatch(method, url, payload)).toEqual(notFound)
  })

  // F1: route -> runtime wiring. Exact 'true' reaches the actual runtime, which authorizes and calls the port.
  it("exact 'true': step, abandon and inspect go through the runtime's authorization to the port and return the closed view", async () => {
    const h = await host('true')
    expect(await dispatch('POST', '/reconciliations', body(), h.runtime)).toEqual({ status: 200, result: { ok: true, data: view() } })
    expect(await dispatch('POST', '/reconciliations/abandon', {}, h.runtime))
      .toEqual({ status: 200, result: { ok: true, data: view({ status: 'failed', lastErrorCode: 'ABORTED' }) } })
    expect(await dispatch('GET', `/reconciliations/${runId}`, undefined, h.runtime)).toEqual({ status: 200, result: { ok: true, data: view() } })
    expect(h.calls.map(([name]) => name)).toEqual(['step', 'abandon', 'inspect'])
    expect(h.calls[0][1]).toEqual(body())
    expect(h.calls[1][1]).toEqual({})
    expect(h.calls[2][1]).toEqual({ runId })
    // One authorization transaction per call.
    expect(h.transactions()).toBe(3)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it("exact 'true': closed bodies; targetRef only while multi-target is ON; runtime refusals map to their statuses", async () => {
    const h = await host('true')
    const input = { status: 400, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_INPUT' } } }
    expect(await dispatch('POST', '/reconciliations', body({ extra: 1 }), h.runtime)).toEqual(input)
    expect(await dispatch('POST', '/reconciliations', body({ targetRef: 'synthetic-target' }), h.runtime)).toEqual(input)
    expect(await dispatch('POST', '/reconciliations/abandon', { targetRef: 'synthetic-target' }, h.runtime)).toEqual(input)
    expect(await dispatch('POST', '/reconciliations/abandon', { runId }, h.runtime)).toEqual(input)
    expect(await dispatch('GET', '/reconciliations/not-a-uuid', undefined, h.runtime)).toEqual(input)
    expect(h.calls).toEqual([])
    const multi = await host('true', 'true')
    expect((await dispatch('POST', '/reconciliations/abandon', { targetRef: 'synthetic-target' }, multi.runtime, true)).status).toBe(200)
    expect(multi.calls).toEqual([['abandon', { targetRef: 'synthetic-target' }]])
    // A caller who is not the anchor owner: the runtime's DENIED, mapped by the router, port never called.
    const other = await host('true', 'false', 'synthetic-other-owner')
    const denied = { status: 403, result: { ok: false, error: { code: 'YIDA_RECONCILE_DENIED' } } }
    for (const [method, url, payload] of requests()) expect(await dispatch(method, url, payload, other.runtime)).toEqual(denied)
    expect(other.calls).toEqual([])
  })

  // F4: the shipped web bundle parses /initialization with a closed key set; the reconcile bit must not appear there
  // (it ships with the panel in PR-B), even while the switch is on.
  it("exact 'true': GET and POST /initialization never carry a reconcileEnabled key", async () => {
    const h = await host('true')
    expect(h.runtime.reconcileEnabled()).toBe(true)
    const get = await dispatch('GET', '/initialization', undefined, h.runtime)
    const post = await dispatch('POST', '/initialization', { commandId: initCommand, material: syntheticMaterial(), draft: draftInput(),
      attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-http-review', organizationId: 'synthetic-http-organization',
        executionIdentity: syntheticMaterial().userId } }, h.runtime)
    for (const result of [get, post]) {
      const data = (result.result as { data?: Row }).data
      expect(data).toBeDefined()
      expect(Object.keys(data ?? {}).sort()).toEqual(['canSend', 'commandId', 'draft', 'externalWriteAttempted', 'sendEnabled', 'status', 'tokenIssued'])
    }
    expect([get.status, post.status]).toEqual([200, 201])
  })
})
