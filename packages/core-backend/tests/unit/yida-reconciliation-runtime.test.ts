import { describe, expect, it, vi } from 'vitest'
import {
  createYidaReconciliationRuntime, yidaReconciliationErrorCode, YIDA_RECONCILIATION_MAX_RUNS,
  type YidaReconciliationInput, type YidaReconciliationRuntimeBinding,
} from '../../src/integration/yida-reconciliation-runtime'
import type { YidaInitializationDatabase } from '../../src/integration/yida-initialization-bootstrap'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

// R-71 ⑦.5 reconciliation host runtime (RC18): switch, live-ACL + anchor-owner authorization, closed input and
// closed view, lifecycle drain. The actual live-ACL code runs over a synthetic query model; the plugin port is a
// double. No PostgreSQL, socket or credential. Real-DB proofs live in the existing YiDa realdb files.
type Row = Record<string, unknown>
const actor = Object.freeze({ actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null })
const runId = '00000000-0000-4000-8000-0000000000a1'
const commandId = '00000000-0000-4000-8000-0000000000c1'
const input = (patch: Row = {}): YidaReconciliationInput => ({ commandId, mode: 'count', projectNo: 'DEMO-P1', projectKeyTarget: 'project',
  expectedKeyTargets: ['project', 'drawingNo'], ...patch } as YidaReconciliationInput)
const counts = () => Object.freeze(Object.fromEntries(['scanned', 'registered', 'would_register', 'already_reconciled', 'duplicate_remote',
  'own_acknowledged', 'duplicate_with_own', 'own_in_flight', 'observed_for_unknown', 'own_not_sent', 'project_mismatch',
  'key_unmatchable'].map(key => [key, 0])))
const view = (patch: Row = {}) => Object.freeze({ runId, commandId, targetRef: 'synthetic-target', mode: 'count', status: 'completed',
  nextPageNumber: 2, pagesDone: 1, totalCountFirst: 0, totalCountLast: 0, counts: counts(), lastErrorCode: null, tokenIssued: true,
  canSend: false, externalWriteAttempted: false, businessVerified: false, historyVerified: false, formOwnershipVerified: false, ...patch })

function fixture(options: { anchor?: Row | null; denied?: boolean; enablement?: unknown; multiTarget?: unknown
  step?: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>; abandon?: (input: unknown) => Promise<unknown> } = {}) {
  let enablement: unknown = Object.hasOwn(options, 'enablement') ? options.enablement : 'true'
  const anchor = options.anchor === undefined ? { slot: 1, owner_id: actor.actorId, tenant_id: actor.tenantId, workspace_id: null } : options.anchor
  let transactions = 0
  const query: Queryable['query'] = vi.fn(async (text: string, params?: unknown[]) => {
    let rows: Row[] = []
    const user = params?.[0]
    if (text.includes('transaction_isolation')) rows = [{ isolation: 'read committed' }]
    else if (text.includes('pg_current_xact_id')) rows = [{ xid: 'synthetic-stable-xid' }]
    else if (text.includes('pg_advisory_xact_lock')) rows = [{}]
    else if (/FROM user_roles\b/u.test(text)) rows = options.denied ? [] : [{ role_id: 'admin' }]
    else if (/FROM role_permissions\b|FROM user_permissions\b/u.test(text)) rows = []
    else if (/FROM users\b/u.test(text)) rows = [{ id: user, role: options.denied ? 'user' : 'admin', is_active: true, activation_status: 'activated', permissions: [] }]
    else if (/FROM user_orgs\b/u.test(text)) rows = [{ user_id: user, org_id: params?.[1], is_active: true }]
    else if (/FROM user_namespace_admissions\b/u.test(text)) rows = []
    else if (text.includes('FROM integration_yida_initialization_anchor')) rows = anchor ? [anchor] : []
    else throw new Error('Unexpected synthetic query')
    return { rows, rowCount: rows.length }
  })
  const database: YidaInitializationDatabase = { async transaction<T>(work: (trx: Queryable) => Promise<T>) { transactions++; return work({ query }) } }
  const fetch = vi.fn(async () => new Response('{}')) as unknown as typeof globalThis.fetch
  const portInputs: unknown[] = []
  const abandonInputs: unknown[] = []
  const created: unknown[] = []
  const binding: YidaReconciliationRuntimeBinding = {
    createReconciliationPort(config) {
      created.push(config)
      return Object.freeze({
        step: async (value: unknown, stepOptions: { signal: AbortSignal }) => { portInputs.push(value); return options.step ? options.step(value, stepOptions) : view() },
        inspect: async () => view(),
        abandon: async (value: unknown) => { abandonInputs.push(value); return options.abandon ? options.abandon(value)
          : view({ status: 'failed', lastErrorCode: 'ABORTED' }) },
      })
    },
  }
  const runtime = createYidaReconciliationRuntime({ database, fetch, readEnablement: () => enablement,
    readMultiTargetEnablement: () => options.multiTarget ?? 'false' })
  return { runtime, binding, portInputs, abandonInputs, created, fetch, transactions: () => transactions, setEnablement: (value: unknown) => { enablement = value } }
}
async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; return 'resolved' } catch (error) { return yidaReconciliationErrorCode(error) ?? 'foreign' }
}

describe('YiDa ⑦.5 reconciliation host runtime', () => {
  it('authorizes, then hands the actor context and a closed input to the plugin port and returns a closed view', async () => {
    const f = fixture()
    await f.runtime.createPluginCapability().activate(f.binding)
    const result = await f.runtime.step(actor, input())
    expect(result).toEqual(view())
    expect(Object.isFrozen(result)).toBe(true)
    expect(f.transactions()).toBe(1)
    expect(f.created).toHaveLength(1)
    expect((f.created[0] as Row).context).toEqual(actor)
    expect(f.portInputs).toEqual([{ ...input() }])
  })

  it('switch: only the exact literal opens it, before any transaction or port', async () => {
    for (const value of ['TRUE', ' true', 'true ', '', undefined, Promise.resolve('true')]) {
      const f = fixture({ enablement: value })
      await f.runtime.createPluginCapability().activate(f.binding)
      expect(await code(f.runtime.step(actor, input()))).toBe('YIDA_RECONCILE_DISABLED')
      expect(f.runtime.reconcileEnabled()).toBe(false)
      expect(f.transactions()).toBe(0)
      expect(f.created).toHaveLength(0)
    }
  })

  it('a non-anchor owner, a missing anchor or a revoked admin is DENIED with no port', async () => {
    for (const options of [{ anchor: { slot: 1, owner_id: 'synthetic-other', tenant_id: actor.tenantId, workspace_id: null } },
      { anchor: { slot: 1, owner_id: actor.actorId, tenant_id: 'synthetic-other-tenant', workspace_id: null } }, { anchor: null }, { denied: true }]) {
      const f = fixture(options)
      await f.runtime.createPluginCapability().activate(f.binding)
      expect(await code(f.runtime.step(actor, input()))).toBe('YIDA_RECONCILE_DENIED')
      expect(f.created).toHaveLength(0)
    }
  })

  it('closed input: targetRef only while multi-target is ON; bounds and extra keys are INPUT', async () => {
    const off = fixture()
    await off.runtime.createPluginCapability().activate(off.binding)
    expect(await code(off.runtime.step(actor, input({ targetRef: 'synthetic-target' })))).toBe('YIDA_RECONCILE_INPUT')
    for (const patch of [{ extra: 1 }, { mode: 'update' }, { commandId: 'not-a-uuid' }, { pageSize: 101 }, { pagesPerStep: 11 },
      { projectNo: 'x'.repeat(65) }, { projectNo: ' DEMO-P1' }, { expectedKeyTargets: [] }]) {
      expect(await code(off.runtime.step(actor, input(patch)))).toBe('YIDA_RECONCILE_INPUT')
    }
    expect(off.created).toHaveLength(0)
    const on = fixture({ multiTarget: 'true' })
    await on.runtime.createPluginCapability().activate(on.binding)
    expect(await code(on.runtime.step(actor, input({ targetRef: 'synthetic-target' })))).toBe('resolved')
    expect((on.portInputs[0] as Row).targetRef).toBe('synthetic-target')
  })

  it('closed view: an extra or missing key, a true safety bit or an unknown code is UNAVAILABLE', async () => {
    for (const bad of [{ ...view(), extra: 1 }, { ...view(), canSend: true }, { ...view(), externalWriteAttempted: true },
      { ...view(), historyVerified: true }, { ...view(), lastErrorCode: 'OTHER' }, { ...view(), projectNo: 'DEMO-P1' },
      (() => { const copy: Row = { ...view() }; delete copy.counts; return copy })(), { ...view(), counts: { ...counts(), extra: 0 } }]) {
      const f = fixture({ step: async () => Object.freeze(bad) })
      await f.runtime.createPluginCapability().activate(f.binding)
      expect(await code(f.runtime.step(actor, input()))).toBe('YIDA_RECONCILE_UNAVAILABLE')
    }
    const unfrozen = fixture({ step: async () => ({ ...view() }) })
    await unfrozen.runtime.createPluginCapability().activate(unfrozen.binding)
    expect(await code(unfrozen.runtime.step(actor, input()))).toBe('YIDA_RECONCILE_UNAVAILABLE')
  })

  it('plugin port codes pass through only from the closed vocabulary', async () => {
    const portError = (value: string) => Object.assign(new Error('synthetic'), { code: value })
    for (const [thrown, expected] of [['YIDA_RECONCILE_CONFLICT', 'YIDA_RECONCILE_CONFLICT'], ['YIDA_RECONCILE_NOT_FOUND', 'YIDA_RECONCILE_NOT_FOUND'],
      ['YIDA_RECONCILE_DENIED', 'YIDA_RECONCILE_UNAVAILABLE'], ['YIDA_OTHER', 'YIDA_RECONCILE_UNAVAILABLE']]) {
      const f = fixture({ step: async () => { throw portError(thrown) } })
      await f.runtime.createPluginCapability().activate(f.binding)
      expect(await code(f.runtime.step(actor, input()))).toBe(expected)
    }
  })

  it('inactive before activation; deactivate aborts the lifetime signal and drains the in-flight step', async () => {
    let lifetime: AbortSignal | undefined
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ step: async (_value, options) => { lifetime = options.signal; await gate; return view() } })
    expect(await code(f.runtime.step(actor, input()))).toBe('YIDA_RECONCILE_INACTIVE')
    await f.runtime.createPluginCapability().activate(f.binding)
    const pending = code(f.runtime.step(actor, input()))
    for (let index = 0; index < 50 && !lifetime; index++) await Promise.resolve()
    expect(lifetime?.aborted).toBe(false)
    let drained = false
    const drain = f.runtime.deactivate().then(() => { drained = true })
    expect(lifetime?.aborted).toBe(true)
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await drain
    expect(await pending).toBe('YIDA_RECONCILE_CANCELLED')
  })

  it('a caller signal is read once at entry: already aborted is CANCELLED, a later abort does not reach the port', async () => {
    const f = fixture()
    await f.runtime.createPluginCapability().activate(f.binding)
    const aborted = new AbortController(); aborted.abort()
    expect(await code(f.runtime.step(actor, input(), { signal: aborted.signal }))).toBe('YIDA_RECONCILE_CANCELLED')
    const later = new AbortController()
    const pending = f.runtime.step(actor, input(), { signal: later.signal })
    later.abort()
    expect(await code(pending)).toBe('resolved')
  })

  // Verifier F2: owner-only abandon of the target's running run, after the same authorization as a step.
  it('F2 abandon: authorized like a step (switch, live admin, anchor owner), closed input, closed view, no fetch', async () => {
    const f = fixture()
    await f.runtime.createPluginCapability().activate(f.binding)
    const result = await f.runtime.abandon(actor, {})
    expect(result).toEqual(view({ status: 'failed', lastErrorCode: 'ABORTED' }))
    expect(f.abandonInputs).toEqual([{}])
    expect(f.transactions()).toBe(1)
    expect((f.created[0] as Row).context).toEqual(actor)
    expect(f.portInputs).toHaveLength(0)
    expect(f.fetch).not.toHaveBeenCalled()
    // targetRef only while multi-target is ON; any other key is INPUT before any transaction.
    expect(await code(f.runtime.abandon(actor, { targetRef: 'synthetic-target' }))).toBe('YIDA_RECONCILE_INPUT')
    expect(await code(f.runtime.abandon(actor, { runId } as unknown as { targetRef?: string }))).toBe('YIDA_RECONCILE_INPUT')
    expect(f.transactions()).toBe(1)
    const on = fixture({ multiTarget: 'true' })
    await on.runtime.createPluginCapability().activate(on.binding)
    expect(await code(on.runtime.abandon(actor, { targetRef: 'synthetic-target' }))).toBe('resolved')
    expect(on.abandonInputs).toEqual([{ targetRef: 'synthetic-target' }])
    for (const options of [{ anchor: { slot: 1, owner_id: 'synthetic-other', tenant_id: actor.tenantId, workspace_id: null } }, { denied: true }]) {
      const denied = fixture(options)
      await denied.runtime.createPluginCapability().activate(denied.binding)
      expect(await code(denied.runtime.abandon(actor, {}))).toBe('YIDA_RECONCILE_DENIED')
      expect(denied.abandonInputs).toHaveLength(0)
    }
    for (const value of ['TRUE', ' true', undefined]) {
      const off = fixture({ enablement: value })
      await off.runtime.createPluginCapability().activate(off.binding)
      expect(await code(off.runtime.abandon(actor, {}))).toBe('YIDA_RECONCILE_DISABLED')
      expect(off.transactions()).toBe(0)
      expect(off.abandonInputs).toHaveLength(0)
    }
    const bad = fixture({ abandon: async () => Object.freeze({ ...view(), canSend: true }) })
    await bad.runtime.createPluginCapability().activate(bad.binding)
    expect(await code(bad.runtime.abandon(actor, {}))).toBe('YIDA_RECONCILE_UNAVAILABLE')
    // A plugin port without abandon is refused as a whole (closed port shape), before the port is called.
    const partial = fixture()
    await partial.runtime.createPluginCapability().activate({ createReconciliationPort: () => Object.freeze({
      step: async () => view(), inspect: async () => view() }) } as unknown as YidaReconciliationRuntimeBinding)
    expect(await code(partial.runtime.step(actor, input()))).toBe('YIDA_RECONCILE_INPUT')
  })

  it('inspect returns the closed view of the requested run only', async () => {
    const f = fixture()
    await f.runtime.createPluginCapability().activate(f.binding)
    expect(await code(f.runtime.inspect(actor, { runId }))).toBe('resolved')
    expect(await code(f.runtime.inspect(actor, { runId: '00000000-0000-4000-8000-0000000000ff' }))).toBe('YIDA_RECONCILE_UNAVAILABLE')
    expect(await code(f.runtime.inspect(actor, { runId: 'x' } as { runId: string }))).toBe('YIDA_RECONCILE_INPUT')
    expect(YIDA_RECONCILIATION_MAX_RUNS).toBe(32)
  })
})
