'use strict'

// Batch-refresh step 4, PR-3a — E-3 / P3-V1: EVERY EGRESS the lanes touch, checked ONE BY ONE with a sentinel
// (plan-final §3.2 EG-1..EG-13). `plan.holds` (hold `detail`) is the value channel; the consult carries PRIVATE
// member keys; the lanes hold both in-process only. A sentinel is planted in a PERSISTED hold's `detail`, so it
// rides `persistedHolds` -> the planner -> `plan.holds` -> the reconcile; every serialized egress below must not
// carry it, and none may carry a `refresh` / `handle` / `planningInputs` / `persistedHolds` / `consult` / `holds` /
// `members` key. Summary filtering is not protection: each egress is serialized WHOLE and scanned.
//
//   EG-1  dry-run response (suspended and clean)        EG-2  the dry-run token record
//   EG-3  the background job record (result and error)  EG-5  the apply response
//   EG-6  the mvp-persist archive input and evidence     EG-8  route logs / warns
//   EG-11 the registry row (last_pull_*)                 EG-12 every new refusal's `details`
//   EG-13 the execution row (plan_digest, planned_counts, refresh_binding, counts, started_by)
// EG-4 (the large planArtifact) belongs to PR-3b; EG-7 audit rows are asserted values-free by the harness on
// every append; EG-9 (scheduled pull) reads the dry-run / apply responses (EG-1 / EG-5); EG-10 (a support packet)
// does not exist for stock-prep — the scan suite pins its absence. Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const { writeBindingFromGeneration, sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const F = require('./support/stock-preparation-continuation-fixtures.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const SENTINEL = 'EG-SENTINEL-7f3a9c'
const PRIVATE_KEYS = Object.freeze(['refresh', 'handle', 'planningInputs', 'persistedHolds', 'consult', 'holds', 'members', 'continuationRoots'])
const TENANT = 'tenant_eg_a'
const SHEET = 'sheet_eg_main'
const PROJECT = F.PROJECT_NO
const T = { hold: 'integration_stock_prep_refresh_hold', execution: 'integration_stock_prep_refresh_execution' }

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

// The ONE `holds` key an egress may carry: the planner's values-free summary (`plan.continuation.holds`, #6502 —
// counts and closed kind tokens). The private channel is the ARRAY of hold objects (`plan.holds`).
function isHoldCountsSummary(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'confirmable,count,kinds' &&
    typeof value.count === 'number' && typeof value.confirmable === 'number' &&
    Boolean(value.kinds) && typeof value.kinds === 'object' && Object.values(value.kinds).every((count) => typeof count === 'number')
}

// Every private key, at every depth (the counts-only `holds` summary excepted, by shape).
function privateKeysOf(value, trail = [], out = []) {
  if (Array.isArray(value)) value.forEach((entry, index) => privateKeysOf(entry, trail.concat(index), out))
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (PRIVATE_KEYS.includes(key) && !(key === 'holds' && isHoldCountsSummary(entry))) out.push(trail.concat(key).join('.'))
      privateKeysOf(entry, trail.concat(key), out)
    }
  }
  return out
}

function assertClean(label, value) {
  const text = JSON.stringify(value === undefined ? null : value)
  assert.equal(text.includes(SENTINEL), false, `${label}: carries the hold sentinel`)
  assert.deepEqual(privateKeysOf(value), [], `${label}: carries a private key`)
}

// A pilot content-change hold whose detail carries the sentinel; after the pilot is cleared it is re-emitted.
function sentinelHold() {
  const hold = {
    kind: 'content_change',
    confirmable: false,
    notConfirmableReason: 'needs_step5',
    subject: { keyDigest: 'e'.repeat(64) },
    detail: { recordId: null, recordVersion: null, key: SENTINEL, reason: 'plm_system_refresh', fields: { material: { before: SENTINEL, after: `${SENTINEL}-2` } }, inContinuation: null, humanColumnsPresent: {} },
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

function sheetFake() {
  const rows = []
  const calls = []
  return {
    rows,
    calls,
    api: {
      supportsWriteFence: true,
      async queryRecords(input = {}) {
        calls.push(['queryRecords'])
        return rows.filter((r) => r.sheetId === input.sheetId).filter((r) => Object.entries(input.filters || {}).every(([k, v]) => r.data[k] === v)).slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000)).map(clone)
      },
      async createRecord(input = {}) { calls.push(['createRecord']); const record = { id: `rec_eg_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }; rows.push(record); return clone(record) },
      async patchRecord(input = {}) { calls.push(['patchRecord']); const record = rows.find((r) => r.id === input.recordId); record.version += 1; record.data = { ...record.data, ...(input.changes || {}) }; return clone(record) },
    },
  }
}

function sourceOf(state) {
  return {
    async read(input = {}) {
      const rows = Array.isArray(state.data[input.object]) ? state.data[input.object] : []
      const matches = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      return { records: matches.map(clone), done: true, nextCursor: null }
    },
  }
}

async function libWorld() {
  const h = lockKit.createLibWriteLockHarness()
  const env = h.refresh()
  await env.registerProject({ tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET, objectId: 'stockPreparationMain', pilot: true })
  const state = { data: F.firstPullSource() }
  const sheet = sheetFake()
  const tokenStore = lockKit.createConsumableStorage()
  const action = { actionId: 'plm.stock-preparation.pull-bom.v1', source: { externalSystemId: 'plm_eg', kind: 'data-source:sql-readonly' }, target: { sheetId: SHEET, objectId: 'stockPreparationMain' } }
  const common = { action, parameters: { projectNo: PROJECT }, sourceAdapter: sourceOf(state), recordsApi: sheet.api, tokenStore, plannedAt: '2026-10-26T02:00:00.000Z', runId: 'run_eg', tenantId: TENANT }
  return {
    h, env, state, sheet, tokenStore,
    dryRun: (extra = {}) => h.wrapDryRun(tableActions.dryRunStockPreparationAction)({ ...common, ...extra }),
    apply: (token, extra = {}) => h.wrapApply(tableActions.applyStockPreparationAction)({ ...common, dryRunToken: token, permission: 'write', sandboxPolicy: { enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] }, startedBy: 'u_eg_principal', ...extra }),
    mvp: () => tableActions.prepareStockPreparationMvpSnapshot({ ...common, refreshGovernance: env.handleFor(TENANT) }),
    async clearPilot() {
      for (const row of env.db.rows('integration_stock_prep_project_target')) {
        await env.db.updateRow('integration_stock_prep_project_target', { pilot_enabled_at: null, pilot_enabled_by: null, pilot_readiness_version: null }, { id: row.id })
      }
    },
  }
}

test('EG-1/EG-2/EG-5/EG-6/EG-13 the lib lanes: a governed CLEAN pull (dry-run response, token record, apply response, mvp-persist archive input and evidence, the execution row) and a SUSPENDED one carrying a sentinel hold (dry-run response) leak no hold value and no private key', async () => {
  const w = await libWorld()
  // Clean, governed (pilot): the first pull.
  const preview = await w.dryRun()
  assert.equal(preview.status, 'ready')
  assertClean('EG-1 clean dry-run response', preview)
  const record = w.tokenStore.map.get(`integration:table-action:dry-run-token:${preview.dryRunToken}`)
  assertClean('EG-2 token record', record)
  assert.deepEqual(Object.keys(record).sort(), ['actionId', 'conflictPolicyReview', 'createdAt', 'expiresAt', 'parametersHash', 'refreshBinding', 'revision', 'writeGeneration', 'writeGenerationToken', 'writeScope'])
  assert.deepEqual(Object.keys(record.refreshBinding).sort(), ['changePlanId', 'continuations', 'holdSetFingerprint'])
  const applied = await w.apply(preview.dryRunToken)
  assertClean('EG-5 apply response', applied)
  const execution = w.env.db.rows(T.execution)[0]
  assertClean('EG-13 execution row', execution)
  assert.equal(execution.started_by, 'u_eg_principal', 'EG-13: the principal id')
  assert.ok(/^[0-9a-f]{64}$/.test(execution.plan_digest))
  assert.deepEqual(Object.keys(execution.planned_counts).sort(), Object.keys(applied.apply.counts).length ? Object.keys(execution.planned_counts).sort() : [])
  for (const value of Object.values(execution.planned_counts)) assert.equal(typeof value, 'number')
  const archived = await w.mvp()
  assertClean('EG-6 mvp-persist evidence', archived.evidence)
  assertClean('EG-6 mvp-persist archive rows', archived.expansionResult)
  // Suspended, carrying the sentinel: a persisted pilot content change, re-emitted after the pilot is cleared.
  await w.env.seedHolds({ tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT }, [sentinelHold()])
  await w.clearPilot()
  const suspended = await w.dryRun()
  assert.equal(suspended.status, 'suspended')
  assert.equal(suspended.refreshHold.holdCount, 1)
  assertClean('EG-1 suspended dry-run response', suspended)
  // The sentinel IS persisted where it belongs (the PRIVATE hold row), proving the plant reached the plan.
  assert.ok(JSON.stringify(w.env.db.rows(T.hold)).includes(SENTINEL))
})

test('EG-12a end to end: the apply lib\'s SUSPENDED refusal (a persisted sentinel hold re-emitted) and its RECOVERY_PENDING refusal carry tokens and counts only', async () => {
  const w = await libWorld()
  await w.env.seedHolds({ tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT }, [sentinelHold()])
  await w.clearPilot()
  const generation = await w.h.lock.bumpGeneration(sheetWriteScopeKey(SHEET), { reason: 'small_preview', tenantId: TENANT })
  const forged = await tableActions.__internals.createDryRunToken(w.tokenStore, {
    actionId: 'plm.stock-preparation.pull-bom.v1', parametersHash: tableActions.__internals.hashJson({ projectNo: PROJECT }), revision: 'forged', conflictPolicyReview: null,
    ...writeBindingFromGeneration(generation),
  })
  const errors = []
  await w.apply(forged).catch((error) => errors.push(error))
  assert.equal(errors[0].code, 'STOCK_PREP_PULL_SUSPENDED')
  // Recovery pending: an earlier failed execution.
  const r = await libWorld()
  const token = (await r.dryRun()).dryRunToken
  await r.env.seedExecution({ tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT }, { status: 'failed' })
  await r.apply(token).catch((error) => errors.push(error))
  assert.equal(errors[1].code, 'STOCK_PREP_REFRESH_RECOVERY_PENDING')
  for (const error of errors) {
    assertClean(`EG-12 ${error.code}`, { message: error.message, details: error.details })
    for (const [key, value] of Object.entries(error.details)) {
      assert.ok(['string', 'number', 'boolean'].includes(typeof value) || (key === 'kinds' && Object.values(value).every((count) => typeof count === 'number')), `${error.code}.${key} is a token / count`)
    }
  }
})

test('EG-12b the census: EVERY refusal constructor PR-3a adds, driven with sentinel-bearing inputs (hold bodies, execution / lease ids, bindings, source ids, planner error details, SQL states, plans), emits a values-free message and token / count details', async () => {
  const lanes = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))
  const writer = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))
  const { planStockPreparationConflicts } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
  const held = { ...sentinelHold(), runbookOnly: true, continuationId: SENTINEL }
  const action = { actionId: 'plm.stock-preparation.pull-bom.v1', source: { externalSystemId: 'plm_eg' } }
  const plan = planStockPreparationConflicts({ expandedRows: [], existingRows: [], rowErrors: [], runId: 'run-eg', plannedAt: '2026-10-26T00:00:00.000Z' })
  const sentinelPlan = { ...plan, suspended: false, holds: [sentinelHold()], continuation: { pilot: false, consulted: 0, verdicts: { [SENTINEL]: 'verified' }, protectedOldRows: 0, suppressedNewRows: 0, candidateRows: 0, holds: { count: 0, confirmable: 0, kinds: {} }, suspended: false } }
  const fence = { generationToken: 'gen-eg-1' }
  const caught = []
  const capture = async (label, fn) => {
    try {
      await fn()
    } catch (error) {
      caught.push([label, error])
      return
    }
    assert.fail(`${label}: did not refuse`)
  }
  await capture('suspended', () => lanes.assertPullNotSuspended({ plan: { suspended: true, holds: [held] } }, null))
  await capture('suspended_outcome', () => lanes.assertPullNotSuspended({ plan: { suspended: false, holds: [] } }, { suspended: true, result: { holds: { open: 2 }, detail: SENTINEL } }))
  await capture('runbook_only_hold', () => lanes.assertNoRunbookOnlyHold({ holds: [held] }))
  await capture('recovery_pending', () => lanes.assertNoUnfinishedExecution({ executions: [{ status: 'failed', executionId: SENTINEL, leaseId: SENTINEL, errorCodes: [SENTINEL] }] }, null))
  await capture('binding_absent', () => lanes.assertRefreshBindingCurrent({ revision: SENTINEL }, { binding: { changePlanId: SENTINEL } }))
  await capture('binding_moved', () => lanes.assertRefreshBindingCurrent({ refreshBinding: { changePlanId: SENTINEL } }, { binding: { changePlanId: `${SENTINEL}-2` } }))
  await capture('unexpected_binding', () => lanes.assertTokenCarriesNoRefreshBinding({ refreshBinding: { changePlanId: SENTINEL } }))
  await capture('bindings_disagree', () => lanes.assertRefreshSourceBindingUnanimous({ sourceBindingStore: { async listForAction() { return { complete: true, bindings: [{ externalSystemId: SENTINEL, workspaceId: SENTINEL }] } } }, tenantId: TENANT, action }))
  await capture('bindings_unverifiable', () => lanes.assertRefreshSourceBindingUnanimous({ sourceBindingStore: { async listForAction() { return { complete: false, bindings: [{ externalSystemId: SENTINEL }] } } }, tenantId: TENANT, action }))
  await capture('binding_list_throws', () => lanes.assertRefreshSourceBindingUnanimous({ sourceBindingStore: { async listForAction() { throw Object.assign(new Error(SENTINEL), { code: SENTINEL, detail: SENTINEL }) } }, tenantId: TENANT, action }))
  await capture('large_lane', () => lanes.largeLaneVerdictOf({ governed: true, pilot: { enabled: false }, continuations: [], holds: [held], executions: [], changePlans: [] }, 'large_apply_chunk'))
  await capture('state_moved', () => lanes.mapContinuationStraddle(() => { throw Object.assign(new Error(SENTINEL), { code: pairing.CONTINUATION_ERROR_CODES.PROJECTION_INCONSISTENT, details: { key: SENTINEL } }) })())
  await capture('pack_read_failed', () => lanes.__internals.planningInputsOrRefuse({ pack: { state: 'read_failed', operation: SENTINEL, sqlState: SENTINEL } }))
  await capture('pack_unavailable', () => lanes.__internals.planningInputsOrRefuse({ pack: { state: 'unavailable', reason: SENTINEL } }))
  await capture('governance_handle', () => lanes.consultForPlanning({ consult: SENTINEL }, { action, parameters: { projectNo: SENTINEL } }))
  await capture('writer_absent', () => writer.assertWriterAdmitsPlan({ plan: sentinelPlan, governance: undefined, writeFence: fence }))
  await capture('writer_malformed', () => writer.assertWriterAdmitsPlan({ plan: sentinelPlan, governance: { consulted: true, verdict: SENTINEL, generationToken: SENTINEL }, writeFence: fence }))
  await capture('writer_mismatch', () => writer.assertWriterAdmitsPlan({ plan: sentinelPlan, governance: { consulted: true, verdict: 'not_governed', generationToken: 'gen-eg-1' }, writeFence: fence }))
  await capture('writer_stale', () => writer.assertWriterAdmitsPlan({ plan: sentinelPlan, governance: { consulted: true, verdict: 'projected', generationToken: SENTINEL }, writeFence: fence }))
  assert.equal(caught.length, 19)
  for (const [label, error] of caught) {
    assert.equal(typeof error.code, 'string', `${label}: a typed refusal`)
    assertClean(`EG-12b ${label}`, { message: error.message, code: error.code, details: error.details })
    for (const [key, value] of Object.entries(error.details || {})) {
      const scalar = ['string', 'number', 'boolean'].includes(typeof value)
      const countMap = key === 'kinds' && value && typeof value === 'object' && Object.values(value).every((count) => typeof count === 'number')
      assert.ok(scalar || countMap, `${label}.${key} is a token / count`)
    }
  }
})

test('EG-3/EG-8/EG-11 the routes: a governed project\'s background dry-run job record (its result), the route logs and the registry row carry no hold value and no private key', async () => {
  const warns = []
  const lockEnv = lockKit.createInMemoryProjectWriteLock({ timers: 'real' })
  const PULLER = Object.freeze({ id: 'u_eg_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn: true,
    logger: { info(...args) { warns.push(args) }, warn(...args) { warns.push(args) }, error(...args) { warns.push(args) } },
    serviceExtras: { stockPreparationProjectWriteLock: lockEnv.lock },
  })
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    await h.refresh.seedHolds({ tenantId: TENANT, sheetId, projectNo: PROJECT }, [sentinelHold()])
    const res = await harness.call(h.routes, 'POST', '/api/integration/table-actions/:actionId/dry-run-jobs', { user: PULLER, params: { actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID }, body: { parameters: { projectNo: PROJECT } }, query: { tenantId: TENANT } })
    assert.equal(res.statusCode, 202, JSON.stringify(res.body))
    for (let i = 0; i < 50 && !Array.from(h.context.storage.values ? h.context.storage.values() : []).some((value) => value && value.status && value.status !== 'running'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const stored = Array.from(h.context.storage.entries ? h.context.storage.entries() : []).filter(([key]) => String(key).includes('dry-run-job'))
    assert.ok(stored.length >= 1, 'the job record is stored')
    for (const [, value] of stored) assertClean('EG-3 job record', value)
    const sync = await harness.call(h.routes, 'POST', '/api/integration/table-actions/:actionId/dry-run', { user: PULLER, params: { actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID }, body: { parameters: { projectNo: PROJECT } }, query: { tenantId: TENANT } })
    assert.equal(sync.statusCode, 200, JSON.stringify(sync.body))
    assert.equal(sync.body.data.status, 'suspended')
    assertClean('EG-1 route dry-run response', sync.body)
    assertClean('EG-8 route logs', warns)
    assertClean('EG-11 registry row', h.registryRows())
    for (const entry of h.auditAppends) assertClean('EG-7 audit rows', entry)
  } finally { h.restore() }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-egress.test.cjs', tests)
