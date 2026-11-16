/**
 * R-69 1c follow-up (iPaaS close-out slice I6c, TEST ONLY): the pull-batch install's write lease → held, END TO END.
 *
 * Every hop of "a write-lock refusal whose holder is the pull-batch install becomes held(pull_batch_installing)" has
 * its own test (the lock unit, the real-DB BI-R-WL HTTP leg, the port's P-03/P-04, gate ③ in
 * automation-integration-run-finished.test.ts) — but there the lock error is built by hand or stops at the HTTP 409.
 * This file runs ONE real lock error across the whole chain:
 *
 *   a REAL pull-batch install (the real route, the real ledger store and the real sheet write lock over the kit's
 *   faithful fake of migrations 105 + 100) parked mid-write on its first fenced records.patchRecord (the BI-R9 hook
 *   pattern), so it HOLDS the real install lease
 *   → the REAL AutomationExecutor runs one run_integration_job over the synthetic project
 *   → the plugin's REAL IntegrationRunPort (createIntegrationRunPort({ governedEntries }) — the governed entries the
 *     route registration itself returned, exactly what index.cjs hands the port)
 *   → runGovernedStockPrepPull → the governed precheck (assertNoLiveWriter on the sheet's write scope) refuses with
 *     the lock's own StockPreparationProjectWriteLockError BEFORE the B2a claim, the credential load and the PLM read
 *   → the port classifies it held(pull_batch_installing) → core sanitize → the executor unit → ONE run_finished event.
 *
 * It pins the two facts no other test asserts: on the GOVERNED path (non-null governedEntry) the precheck refuses
 * before any source read, and the scope + purpose the install actually leases are the ones the precheck reads.
 * Calibration keeps it from passing vacuously: after the install resolves, the same step reads the source and
 * succeeds; a lease held by small_apply is failed(STOCK_PREP_PROJECT_WRITE_LOCKED), never held.
 *
 * Synthetic values only; R-69 is OPEN — dry run only, every switch default OFF (stubbed ON for this file only).
 * The mount / seedSheet / makeEnvelopeRecords helpers are COPIED from
 * plugins/plugin-integration-core/__tests__/stock-preparation-pull-batch-install-routes.test.cjs (stock-prep owned,
 * not edited); harness() / captureSink() are copied from automation-integration-run-finished.test.ts (unchanged).
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationStepResult,
  type ClassAActionIdentity,
  type ExecutionContext,
} from '../../src/multitable/automation-executor'
import type { IntegrationRunPort } from '../../src/core/integration-run-port'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  INTEGRATION_RUN_FINISHED_COUNT_KEYS,
  clearIntegrationRunFinishedSinkForTest,
  registerIntegrationRunFinishedSink,
  type IntegrationRunEventRoute,
  type IntegrationRunFinishedEvent,
} from '../../src/core/integration-run-events'
import { createFakeJobDb } from '../utils/run-integration-job-fake-db'

// The plugin is CommonJS and untyped; its objects are handled loosely here, as the real-DB cases do.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const requireFromTest = createRequire(import.meta.url)
const PLUGIN = '../../../../plugins/plugin-integration-core'
const httpRoutes: Loose = requireFromTest(`${PLUGIN}/lib/http-routes.cjs`)
const { createIntegrationRunPort }: Loose = requireFromTest(`${PLUGIN}/lib/integration-run-port.cjs`)
const { STOCK_PREP_ADMIN, STOCK_PREP_PULL, STOCK_PREP_READ, STOCK_PREP_OPERATE }: Loose = requireFromTest(`${PLUGIN}/lib/stock-preparation-workbench-access.cjs`)
const { createStockPreparationPullBatchStore }: Loose = requireFromTest(`${PLUGIN}/lib/stock-preparation-pull-batch-store.cjs`)
const pullBatchInstall: Loose = requireFromTest(`${PLUGIN}/lib/stock-preparation-pull-batch-install.cjs`)
const lockLib: Loose = requireFromTest(`${PLUGIN}/lib/stock-preparation-project-write-lock.cjs`)
const { PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS }: Loose = requireFromTest(`${PLUGIN}/lib/stock-preparation-project-targets.cjs`)
const sheetHarness: Loose = requireFromTest(`${PLUGIN}/__tests__/support/stock-preparation-project-sheet-harness.cjs`)
const pbKit: Loose = requireFromTest(`${PLUGIN}/__tests__/support/stock-preparation-pull-batch-kit.cjs`)
const { withFakeHostWriteFence }: Loose = requireFromTest(`${PLUGIN}/__tests__/support/stock-preparation-project-write-lock-kit.cjs`)

const ACTION_FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
const EVENT_FLAG = 'INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED'
const PULL_BATCH_FLAG = 'STOCK_PREP_PULL_BATCH_ENABLED'

const TENANT = 'tenant-syn-i6c'
const PROJECT = 'SYN-I6C-01'
const ROUTE = '/api/integration/stock-preparation/projects/:projectNo/target/pull-batch'
const ADMIN = Object.freeze({ id: 'u_i6c_admin', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
/** The binding's principal: the puller ladder in the SAME tenant (the codes the governed dry run checks). */
const PRINCIPAL = Object.freeze({ id: 'u_i6c_pull', permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL], roles: [] as string[], role: 'user', tenantId: TENANT })
const BINDING = { principalId: PRINCIPAL.id, tenantId: TENANT }
/** Generous: the calibration run plans for real (the fake host, but every step of the dry run). */
const CONFIG = { job: { kind: 'stock_prep_pull', projectNos: [PROJECT], applyMode: 'dry_run_only' }, timeoutMs: 30_000, binding: BINDING }

// ── copied from automation-integration-run-finished.test.ts (tenant / principal / config are this file's) ─────

function harness(db: ReturnType<typeof createFakeJobDb>, port: IntegrationRunPort | null, extra: Partial<AutomationDeps> = {}) {
  const tracked: Promise<void>[] = []
  const exec = new AutomationExecutor({
    eventBus: new EventBus(),
    queryFn: db.query,
    transaction: db.transaction,
    integrationRunPort: () => port,
    shutdownSignal: new AbortController().signal,
    trackIntegrationJobTask: (task) => { tracked.push(task) },
    resolveIntegrationRunPrincipal: async () => ({ ok: true, user: { ...PRINCIPAL, permissions: [...PRINCIPAL.permissions], roles: [] } }),
    integrationJobRuntime: { leaseTtlMs: 30_000, settleGraceMs: 500, shutdownSettleGraceMs: 300 },
    ...extra,
  })
  const run = (executionId: string, config: Record<string, unknown> = CONFIG, root = executionId, triggerEvent: unknown = {}) => {
    const context: ExecutionContext = { executionId, ruleId: 'rule_i6c', sheetId: 'sheet_rule_i6c', recordId: '', recordData: {}, ruleCreatedBy: PRINCIPAL.id, triggerEvent, rootExecutionId: root }
    const identity: ClassAActionIdentity = { structuralPath: '0', rootExecutionId: root }
    return (exec as unknown as { executeSingleAction(a: unknown, c: ExecutionContext, i?: ClassAActionIdentity): Promise<AutomationStepResult> })
      .executeSingleAction({ type: 'run_integration_job', config }, context, identity)
  }
  return { exec, run, tracked }
}

function captureSink() {
  const events: Array<{ event: IntegrationRunFinishedEvent; route: IntegrationRunEventRoute }> = []
  registerIntegrationRunFinishedSink('test-capture-i6c', async (event, route) => { events.push({ event, route }) })
  return events
}

// ── copied from stock-preparation-pull-batch-install-routes.test.cjs (makeEnvelopeRecords / mount / seedSheet) ─

/** A records host whose envelopes carry createdAt / createdBy / locked / version (what the real host answers). */
function makeEnvelopeRecords() {
  const rows: Loose[] = []
  const calls: string[] = []
  const api: Loose = {
    rows,
    calls,
    async queryRecords({ sheetId, filters = {}, limit, offset = 0 }: Loose) {
      calls.push('queryRecords')
      const hit = rows.filter((row) => row.sheetId === sheetId && Object.entries(filters).every(([key, value]) => String(row.data[key]) === String(value)))
      return hit.slice(offset, offset + limit).map((row) => JSON.parse(JSON.stringify(row)))
    },
    async getRecord({ recordId }: Loose) {
      calls.push('getRecord')
      const row = rows.find((entry) => entry.id === recordId)
      return row ? JSON.parse(JSON.stringify(row)) : null
    },
    async patchRecord({ recordId, changes, expectedVersion }: Loose) {
      calls.push('patchRecord')
      const row = rows.find((entry) => entry.id === recordId)
      if (!row) throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' })
      if (expectedVersion !== undefined && expectedVersion !== row.version) throw Object.assign(new Error('version'), { code: 'VERSION_CONFLICT' })
      Object.assign(row.data, changes)
      row.version += 1
      return { id: row.id, version: row.version }
    },
    async createRecord({ sheetId, data }: Loose) {
      calls.push('createRecord')
      const row = { id: `rec_${rows.length + 1}`, sheetId, version: 1, createdAt: new Date().toISOString(), createdBy: null, locked: false, data: { ...data } }
      rows.push(row)
      return JSON.parse(JSON.stringify(row))
    },
  }
  return api
}

/**
 * The install-routes suite's mount, plus ONE addition: the governed entries the route registration RETURNED
 * (registerIntegrationRoutes' non-enumerable `governedEntries`, what index.cjs hands createIntegrationRunPort) —
 * captured by wrapping the export for the duration of the mount, so the port runs on the SAME handler set the HTTP
 * install runs on (no second createHandlers()).
 */
function mount() {
  const clock = pbKit.createClock('2026-11-08T01:00:00.000Z')
  const db = pbKit.createFakePullBatchDb({ clock, lockTable: true })
  const store = createStockPreparationPullBatchStore({ db, now: clock.now })
  const lock = lockLib.createStockPreparationProjectWriteLock({ db })
  const register = httpRoutes.registerIntegrationRoutes
  let registered: Loose = null
  httpRoutes.registerIntegrationRoutes = (input: Loose) => { registered = register(input); return registered }
  let h: Loose
  try {
    h = sheetHarness.mountProjectSheetRoutes({
      tenantId: TENANT,
      projectNo: PROJECT,
      switchOn: true,
      fieldReads: true,
      serviceExtras: { stockPreparationPullBatchStore: store, stockPreparationProjectWriteLock: lock },
    })
  } finally {
    httpRoutes.registerIntegrationRoutes = register
  }
  assert.ok(registered && registered.governedEntries && typeof registered.governedEntries.runGovernedStockPrepPull === 'function', 'the registration returned its governed entries')
  const records = makeEnvelopeRecords()
  // The host fence is checked against THIS ledger db's lock row (the one lock the routes hold).
  const fenceRowExists = (fence: Loose) => db.rows(pbKit.T.lock).some((row: Loose) => row.scope_key === fence.scopeKey && row.lease_id === fence.leaseId && Number(row.fencing_epoch) === fence.fencingEpoch && row.generation_token === fence.generationToken)
  h.context.api.multitable.records = withFakeHostWriteFence(records, { lockDb: { fenceRowExists } })
  const audits: Loose[] = []
  h.services.stockPreparationAuditStore.appendWithin = async (trx: Loose, entry: Loose) => {
    assert.ok(trx && typeof trx.insertOne === 'function', 'appendWithin is handed the ledger transaction')
    audits.push(entry)
    return { ok: true }
  }
  // The host primitives the install needs (BI-5's two, the repair transaction), over the harness's own objects.
  const p = h.provisioning
  const views = new Map<string, boolean>()
  p.findObjectView = async ({ viewId }: Loose) => { p.calls.push(['findObjectView', viewId]); return views.has(viewId) ? { id: `view_${viewId}`, hiddenFieldIds: [] } : null }
  p.ensureView = async ({ sheetId, descriptor }: Loose) => { p.calls.push(['ensureView', descriptor.id]); views.set(descriptor.id, true); return { id: `view_${descriptor.id}`, sheetId, name: descriptor.name, type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} } }
  p.describeObjectSheetLayout = async () => { p.calls.push(['describeObjectSheetLayout']); return { viewCount: 3, firstView: 'default', viewsWithFrozenColumns: 0, viewsLosingFrozen: 0, personalOrderOverrides: 0, trashedRecordCount: 0 } }
  p.promoteObjectViewToFirst = async () => { p.calls.push(['promoteObjectViewToFirst']); return { promoted: true, alreadyFirst: false, missing: false } }
  p.runObjectFieldsRepairTransaction = async (fn: Loose) => {
    p.calls.push(['runObjectFieldsRepairTransaction'])
    return fn({
      findObjectSheet: (input: Loose) => p.findObjectSheet(input),
      resolveExistingObjectFieldIds: (input: Loose) => p.resolveExistingObjectFieldIds(input),
      readObjectFieldsContent: (input: Loose) => p.readObjectFieldsContent(input),
      ensureMissingObjectFields: (input: Loose) => p.ensureMissingObjectFields(input),
      readObjectMaxFieldOrder: async ({ projectId, objectId }: Loose) => {
        p.calls.push(['readObjectMaxFieldOrder', objectId])
        const object = p.objects.get(`${projectId}/${objectId}`)
        const orders = object ? Array.from(object.fields.values()).map((field: Loose) => field.order) : []
        return orders.length > 0 ? Math.max(...orders) : null
      },
    })
  }
  // Two IO counters on the governed path's pre-read hops (this file's own): the credential load and the adapter build.
  const io = { credentialLoads: 0, adapterBuilds: 0 }
  const systems = h.services.externalSystemRegistry
  const forAdapter = systems.getExternalSystemForAdapter
  systems.getExternalSystemForAdapter = async (input: Loose) => { io.credentialLoads += 1; return forAdapter.call(systems, input) }
  const adapters = h.services.adapterRegistry
  const createAdapter = adapters.createAdapter
  adapters.createAdapter = (...args: Loose[]) => { io.adapterBuilds += 1; return createAdapter.apply(adapters, args) }
  return { ...h, db, store, lock, records, audits, views, io, governedEntries: registered.governedEntries }
}

// A registered project sheet with PLM-locked columns, the two plugin views and two pulled rows (batch 1 then batch 2).
function seedSheet(h: Loose) {
  const seeded = h.seedRegistryRow(PROJECT)
  const object = h.provisioning.objects.get(`${h.staging}/${seeded.objectId}`)
  for (const id of PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS) if (object.fields.has(id)) object.fields.get(id).property = { humanWriteLock: 'plm_system' }
  h.views.set('prep-fill', true)
  h.views.set('prep-todo', true)
  const physical = (fieldId: string) => h.provisioning.getFieldId(h.staging, seeded.objectId, fieldId)
  const row = (id: string, createdAt: string, part: string, plannedAt: string) => ({
    id, sheetId: seeded.sheetId, version: 1, createdAt, createdBy: null, locked: false,
    data: {
      [physical('projectNo')]: PROJECT,
      [physical('idempotencyKey')]: JSON.stringify({ projectNo: PROJECT, componentSourceId: part, parentSourceId: null, path: [part] }),
      [physical('componentSourceId')]: part,
      [physical('path')]: JSON.stringify([part]),
      [physical('active')]: true,
      [physical('lastPlmRefreshDecision')]: 'add',
      [physical('lastPlmRefreshAt')]: plannedAt,
    },
  })
  h.records.rows.push(row('rec_r1', '2026-11-01T01:00:01.000Z', 'S-01', '2026-11-01T01:00:00.000Z'))
  h.records.rows.push(row('rec_r2', '2026-11-03T01:00:01.000Z', 'P-07', '2026-11-03T01:00:00.000Z'))
  h.provisioning.calls.length = 0
  h.records.calls.length = 0
  h.db.log.length = 0
  return { ...seeded, physical }
}

const post = (h: Loose, body: Record<string, unknown>) => sheetHarness.call(h.routes, 'POST', ROUTE, { user: ADMIN, params: { projectNo: PROJECT }, body })

// ── this file's own helpers ────────────────────────────────────────────────────────────────────────────────

const WRITE_CALLS = new Set(['createRecord', 'patchRecord', 'deleteRecord'])
const writesOf = (h: Loose): number => h.records.calls.filter((name: string) => WRITE_CALLS.has(name)).length
/** The lock fields a takeover, a release or a generation bump would move (the heartbeat's expiry may move; these may not). */
const lockIdentityOf = (h: Loose) => h.db.rows(pbKit.T.lock).map((row: Loose) => ({
  scope_key: row.scope_key, lease_id: row.lease_id, fencing_epoch: row.fencing_epoch, generation: row.generation, generation_token: row.generation_token, generation_reason: row.generation_reason,
}))
const lastPullOf = (h: Loose) => h.registryRows().map((row: Loose) => ({ at: row.last_pull_at ?? null, outcome: row.last_pull_outcome ?? null, code: row.last_pull_code ?? null }))
const storageKeysOf = (h: Loose): string[] => Array.from((h.context.storage as Map<string, unknown>).keys()).sort()

/** Parks the FIRST fenced patch of the install (after the host fence admitted it, so the lease is live and fenced). */
function parkFirstPatch(h: Loose) {
  const raw = h.records.patchRecord
  let releaseGate: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  let markParked: () => void = () => undefined
  const parked = new Promise<void>((resolve) => { markParked = resolve })
  let hooked = 0
  h.records.patchRecord = async (input: Loose) => {
    hooked += 1
    if (hooked === 1) { markParked(); await gate }
    return raw.call(h.records, input)
  }
  return { parked, release: () => releaseGate(), hookedCalls: () => hooked, restore: () => { h.records.patchRecord = raw } }
}

async function settleWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T | string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<string>((resolve) => { timer = setTimeout(() => resolve(`timeout:${label}`), ms) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const ZERO_COUNTS = Object.fromEntries(INTEGRATION_RUN_FINISHED_COUNT_KEYS.map((key) => [key, 0]))

describe('R-69 1c / BI-2 — a REAL pull-batch install lease → the governed precheck → the real port → the executor → held(pull_batch_installing), end to end', () => {
  beforeEach(() => {
    vi.stubEnv(ACTION_FLAG, 'true')
    vi.stubEnv(EVENT_FLAG, 'true')
    vi.stubEnv(PULL_BATCH_FLAG, 'true')
    vi.stubEnv('MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED', 'true')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    clearIntegrationRunFinishedSinkForTest()
  })

  it('an install parked mid-write holds the real lease: the step is held(pull_batch_installing) with ONE values-free event, nothing read, nothing written; after the install resolves the same step reads and succeeds', async () => {
    const h = mount()
    try {
      const seeded = seedSheet(h)
      const dry = await post(h, { mode: 'dry_run', confirmProjectNo: PROJECT })
      expect(dry.statusCode, JSON.stringify(dry.body)).toBe(200)
      expect([dry.body.data.run, dry.body.data.plan.K]).toEqual(['first_install', 2])

      // 1. The REAL install, parked on its first fenced patch — it now holds the sheet's write lease.
      const park = parkFirstPatch(h)
      const installP = post(h, { mode: 'install', confirmProjectNo: PROJECT, approvalRef: 'R-65', planDigest: dry.body.data.planDigest, confirmHistoricalBatchCount: 2 })
      // An install that answers before its first patch (refused, or wrote nothing) is named here, not waited out.
      const answeredFirst = installP.then((res: Loose) => `answered before parking: ${res.statusCode} ${res.body && res.body.error ? res.body.error.code : ''}`)
      const reached = await settleWithin(Promise.race([park.parked.then(() => 'parked'), answeredFirst]), 5_000, 'install never parked')
      expect(reached, 'the install reached its first fenced patch and parked there').toBe('parked')
      const heldRows = h.db.rows(pbKit.T.lock).filter((row: Loose) => row.lease_id !== null && row.lease_id !== undefined)
      expect(heldRows, 'exactly one live lease, the install\'s').toHaveLength(1)
      expect(heldRows[0].lease_purpose).toBe(pullBatchInstall.PULL_BATCH_INSTALL_LEASE_PURPOSE)
      expect((h.db.rows(pbKit.T.sheet)[0] as Loose).history_status, 'the ledger says installing while parked').toBe('installing')

      // Snapshots at the park (everything below must be unchanged by the automation step).
      const before = {
        sourceCalls: h.source.calls.length,
        io: { ...h.io },
        writes: writesOf(h),
        hooked: park.hookedCalls(),
        lock: lockIdentityOf(h),
        lastPull: lastPullOf(h),
        audits: h.audits.length,
        auditAppends: h.auditAppends.length,
        storage: storageKeysOf(h),
      }

      // 2. The REAL executor → the REAL plugin port over the registration's governed entries.
      const events = captureSink()
      const port = createIntegrationRunPort({ governedEntries: h.governedEntries }) as IntegrationRunPort
      const db = createFakeJobDb({ projectTargets: { sheet_rule_i6c: { tenantId: TENANT, projectNo: PROJECT, status: 'active' } } })
      const { run } = harness(db, port)
      const step = await run('exec_i6c_held')

      // The step: success (held is a success outcome), one unit held / pull_batch_installing, the intent row sent.
      expect(step.status, JSON.stringify(step)).toBe('success')
      const units = (step.output as Loose).units
      expect(units).toHaveLength(1)
      expect([units[0].outcome, units[0].reason]).toEqual(['held', 'pull_batch_installing'])
      expect(db.intentRows().map(([, row]) => row.status)).toEqual(['sent'])

      // Nothing read: no PLM read, no B2a-gated adapter build, no credential load — the precheck refused first.
      expect(h.source.calls.length, 'the governed precheck refuses BEFORE any source read').toBe(before.sourceCalls)
      expect(h.io, 'no credential load and no adapter build').toEqual(before.io)

      // The event: exactly one, held / pull_batch_installing, canApply false, attempts 1, from automation, zero counts.
      expect(events).toHaveLength(1)
      const { event, route } = events[0]
      expect(route).toEqual({ tenantId: TENANT })
      expect(event).toMatchObject({ job: { kind: 'stock_prep_pull', projectNo: PROJECT }, status: 'held', reason: 'pull_batch_installing', canApply: false, attempts: 1, triggeredBy: 'automation' })
      expect(event).not.toHaveProperty('errorClass')
      // All nine counts 0 — also proves the REFUSAL path won (the installing stanza on a ready preview carries plan counts).
      expect(event.counts, 'all nine counts are zero').toEqual(ZERO_COUNTS)
      const serialized = JSON.stringify(event)
      for (const leak of ['holderPurpose', 'heldSince', 'leaseExpiresAt', 'retryAfterMs', 'retry after', seeded.sheetId, seeded.objectId, TENANT]) {
        expect(serialized.includes(leak), `the event leaks ${leak}`).toBe(false)
      }

      // Nothing written: no records write but the install's own parked call; the lock, the registry stamp, the audits
      // and the token storage are exactly as they were at the park.
      expect(writesOf(h), 'no records write while parked').toBe(before.writes)
      expect(park.hookedCalls(), 'only the install\'s parked patch reached the host').toBe(before.hooked)
      expect(lockIdentityOf(h), 'no takeover, no release, no generation bump').toEqual(before.lock)
      expect(lastPullOf(h), 'no last-pull stamp (WRITE_LOCKED describes another run)').toEqual(before.lastPull)
      expect([h.audits.length, h.auditAppends.length], 'no audit row').toEqual([before.audits, before.auditAppends])
      expect(storageKeysOf(h), 'no dry-run token minted').toEqual(before.storage)

      // The scope the install leases IS the one the governed precheck reads (the sheet's write scope).
      expect(heldRows[0].scope_key, 'the install leases the sheet write scope').toBe(lockLib.sheetWriteScopeKey(seeded.sheetId))

      // 3. Release the gate: the install was not damaged by the step — it finishes resolved.
      park.release()
      const installed: Loose = await settleWithin(installP, 10_000, 'install never answered')
      park.restore()
      expect(installed.statusCode, JSON.stringify(installed.body)).toBe(200)
      expect([installed.body.data.resolved, installed.body.data.historyStatus, installed.body.data.written.rows]).toEqual([true, 'backfilled', 2])
      expect(h.db.rows(pbKit.T.lock).every((row: Loose) => row.lease_id === null), 'the install released its lease').toBe(true)

      // 4. Calibration: the same step (a NEW execution) now runs the governed dry run for real and succeeds.
      const readsBefore = h.source.calls.length
      const ready = await run('exec_i6c_ready')
      expect(ready.status, JSON.stringify(ready)).toBe('success')
      const readyUnits = (ready.output as Loose).units
      expect([readyUnits[0].outcome, readyUnits[0].reason], JSON.stringify(readyUnits[0])).toEqual(['succeeded', 'ready'])
      expect(h.source.calls.length - readsBefore, 'calibration: the unblocked step reads the source').toBeGreaterThanOrEqual(1)
      expect(h.io.credentialLoads, 'calibration: the unblocked step loads the credentials').toBeGreaterThan(before.io.credentialLoads)
      expect(events).toHaveLength(2)
      expect(events[1].event).toMatchObject({ status: 'succeeded', reason: 'ready', attempts: 1, triggeredBy: 'automation' })
    } finally {
      h.restore()
    }
  }, 60_000)

  it('calibration: a lease held by small_apply (another WRITER, not the install) is failed(STOCK_PREP_PROJECT_WRITE_LOCKED), never held', async () => {
    const h = mount()
    try {
      const seeded = seedSheet(h)
      const events = captureSink()
      const port = createIntegrationRunPort({ governedEntries: h.governedEntries }) as IntegrationRunPort
      const { run } = harness(createFakeJobDb({ projectTargets: { sheet_rule_i6c: { tenantId: TENANT, projectNo: PROJECT, status: 'active' } } }), port)
      const step = await h.lock.withProjectWriteLease(
        lockLib.sheetWriteScopeKey(seeded.sheetId),
        { purpose: 'small_apply', runId: 'small-apply:i6c-calibration', tenantId: TENANT },
        async () => run('exec_i6c_small_apply'),
      )
      expect(step.status, JSON.stringify(step)).toBe('failed')
      const units = (step.output as Loose).units
      expect([units[0].outcome, units[0].reason]).toEqual(['failed', 'STOCK_PREP_PROJECT_WRITE_LOCKED'])
      expect(h.source.calls.length, 'refused before the source read as well').toBe(0)
      expect(events).toHaveLength(1)
      expect(events[0].event).toMatchObject({ status: 'failed', errorClass: 'STOCK_PREP_PROJECT_WRITE_LOCKED', canApply: false, attempts: 1, triggeredBy: 'automation' })
      expect(events[0].event).not.toHaveProperty('reason')
      const serialized = JSON.stringify(events[0].event)
      for (const leak of ['holderPurpose', 'small_apply', 'heldSince', seeded.sheetId, TENANT]) expect(serialized.includes(leak), `the event leaks ${leak}`).toBe(false)
    } finally {
      h.restore()
    }
  }, 60_000)
})
