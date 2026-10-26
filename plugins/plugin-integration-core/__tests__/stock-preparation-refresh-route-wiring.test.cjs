'use strict'

// Batch-refresh step 4, PR-3a — THE ROUTE WIRING of the refresh governance (lib/http-routes.cjs HR-2..HR-9;
// plan-final §3.2 RT rows), on the shared project-sheet substrate (support/stock-preparation-project-sheet-harness.cjs)
// with the REAL governance reader + continuation store (support/stock-preparation-refresh-governance-wiring.cjs; the
// reader asks the routes' own registry store for the pilot marker — the plan-final §7 risk-2 fallback).
//
//   RW-G2  an unwired governance service: dry-run (sync and job), apply, reconcile, mvp-persist and carry answer 501
//          `governance_service` by name, before any source read.
//   RW-G5  a steered tenant: (a) switch off + a step-4 state row of T on the env sheet => 409 TENANT_MISMATCH
//          (continuation / refresh_state); (b) switch off + a registry row of T naming the env sheet => 409
//          TENANT_MISMATCH (registry); (c) switch on => the overlay's PROJECT_ABSENT, no consult at all.
//   RW-G6  retarget before planning: (p) a PILOT registry row on the managed sheet, switch off => 409
//          project_registered_on_another_sheet; (r) step-4 rows on the managed sheet, switch off => 409 `sheet` —
//          both with zero source reads, no token, no store write.
//   RW-G7  GV-1: a registered project that is NOT pilot and has no step-4 row, switch off => today's behaviour —
//          the same answer as an unregistered project (status, counts, evidence), zero step-4 rows.
//   RW-V4  a suspended preview is stamped `previewed` + STOCK_PREP_PULL_SUSPENDED; its apply `refused` + the code.
//   RW-V6  the preview's straddle 409 (execution_finished_during_preview) keeps the just-finished apply's `applied`
//          stamp (design §23.8 F-18); RW-V6b the exemption names that one reason only.
//   RW-CR  the carry on a governed project: an ordinary open hold => allowed; unreadable => 503; a runbook-only
//          hold => 409 runbook_only_hold; an unfinished execution => 409 RECOVERY_PENDING — none of them patch.
//   RW-SB1 split source bindings on a governed project => 409 SOURCE_BINDING_SPLIT before any source read.
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const kit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const refreshKit = require('./support/stock-preparation-refresh-store-kit.cjs')
const wiring = require('./support/stock-preparation-refresh-governance-wiring.cjs')
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = tableActions
const { sheetWriteScopeKey, writeBindingFromGeneration } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-rw-a'
const OTHER_TENANT = 'tenant-rw-b'
const PROJECT = 'PRJ-SCC-1'
const ENV_SHEET = 'sheet_env_synthetic'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const JOBS_PATH = '/api/integration/table-actions/:actionId/dry-run-jobs'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'
const RECONCILE_PATH = '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile'
const MVP_PATH = '/api/integration/table-actions/:actionId/mvp-persist'
const CARRY_PATH = '/api/integration/stock-preparation/carry/confirm'
const MVP_ENV = 'MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED'
const PULLER = Object.freeze({ id: 'u_rw_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const ADMIN = Object.freeze({ id: 'u_rw_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const PLATFORM = Object.freeze({ id: 'u_rw_platform', roles: ['admin'], permissions: ['integration:admin'] })
const CODE_UNAVAILABLE = 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE'
const CODE_RETARGETED = 'STOCK_PREP_REFRESH_TARGET_RETARGETED'
const CONFIRMATION_LEASE = Object.freeze({ async acquire() { return { leaseId: 'lease_rw' } }, async release() { return true }, async renew() { return true } })

function errorOf(res) {
  return res.body && res.body.error ? res.body.error : {}
}

// `tenantEnv`: the deployment's env target is the sheet provisioning derives for THIS tenant's env object — the
// shape a sanctioned config has (scripts/ops/stock-preparation-derive-target-binding.mjs), and the only one the
// carry's tenant wall admits with the switch off. Without it the env sheet is a bare id no tenant owns.
const ENV_OBJECT = 'plm_stock_preparation_sandbox_synthetic_env'
const TENANT_ENV_SHEET = `sheet_${TENANT}:integration-core_${ENV_OBJECT}`.replace(/[^A-Za-z0-9_]/g, '_')
function mount({ switchOn = true, unwired = false, sourceBindingStore = null, tenantEnv = false, refreshOptions = null } = {}) {
  const lockEnv = kit.createInMemoryProjectWriteLock({ timers: 'real' })
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn,
    ...(refreshOptions ? { refreshOptions } : {}),
    ...(sourceBindingStore ? { sourceBindingStore } : {}),
    ...(tenantEnv ? {
      envObjectId: ENV_OBJECT,
      configExtras: {
        stockPreparationTableActions: [{
          actionId: PLM_STOCK_PREPARATION_ACTION_ID,
          source: { externalSystemId: 'plm_sql_source_synthetic', kind: 'data-source:sql-readonly' },
          target: { sheetId: TENANT_ENV_SHEET, objectId: ENV_OBJECT, fieldIdMap: {} },
        }],
      },
    } : {}),
    serviceExtras: {
      stockPreparationProjectWriteLock: lockEnv.lock,
      stockPreparationConfirmationDecisionLease: CONFIRMATION_LEASE,
      ...(unwired ? { stockPreparationRefreshGovernance: null } : {}),
    },
  })
  h.lockEnv = lockEnv
  h.envSheet = tenantEnv ? TENANT_ENV_SHEET : ENV_SHEET
  return h
}

const call = (h, method, routePath, { body, user = PULLER, query = { tenantId: TENANT } } = {}) =>
  harness.call(h.routes, method, routePath, { user, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, body, query })
const dryRun = (h, options = {}) => call(h, 'POST', DRY_RUN_PATH, { body: { parameters: { projectNo: PROJECT } }, ...options })
const startJob = (h) => call(h, 'POST', JOBS_PATH, { body: { parameters: { projectNo: PROJECT } } })
const apply = (h, token) => call(h, 'POST', APPLY_PATH, { body: { parameters: { projectNo: PROJECT }, confirm: { dryRunToken: token } } })
const reconcile = (h) => call(h, 'POST', RECONCILE_PATH, { body: { parameters: { projectNo: PROJECT } }, user: ADMIN, query: {} })
async function mvpPersist(h) {
  const previous = process.env[MVP_ENV]
  process.env[MVP_ENV] = 'true'
  try {
    return await call(h, 'POST', MVP_PATH, { body: { parameters: { projectNo: PROJECT } }, user: ADMIN, query: {} })
  } finally {
    if (previous === undefined) delete process.env[MVP_ENV]
    else process.env[MVP_ENV] = previous
  }
}

// A token the apply route will consume and bind (the lock's current generation), whatever the plan: every refusal
// below happens at the in-lease consult, before the revision compare.
async function mintToken(h, sheetId, revision = 'rev_rw_forged') {
  const scope = sheetWriteScopeKey(sheetId)
  const generation = await h.lockEnv.lock.bumpGeneration(scope, { reason: 'small_preview', tenantId: TENANT })
  return tableActions.__internals.createDryRunToken(h.context.storage, {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    parametersHash: tableActions.__internals.hashJson(tableActions.normalizeActionParameters({ projectNo: PROJECT })),
    revision,
    conflictPolicyReview: null,
    ...writeBindingFromGeneration(generation),
  })
}

function markPilot(h) {
  for (const row of h.registryRows()) {
    if (row.project_no !== PROJECT) continue
    row.pilot_enabled_at = new Date('2026-10-24T00:00:00Z')
    row.pilot_enabled_by = 'u_rw_admin'
    row.pilot_readiness_version = 1
  }
}

// A persisted pilot content-change hold: after the pilot marker is cleared it is RE-EMITTED (AMB-1), so every
// later preview of the project is suspended.
function contentChangeHold() {
  const hold = {
    kind: 'content_change',
    confirmable: false,
    notConfirmableReason: 'needs_step5',
    subject: { keyDigest: 'c'.repeat(64) },
    detail: { recordId: null, recordVersion: null, key: 'k_rw', reason: 'plm_system_refresh', fields: {}, inContinuation: null, humanColumnsPresent: {} },
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

const consultCount = (h) => h.refresh.db.log.filter(([method]) => method === 'trx.setTransactionIsolationLevel').length

// ── RW-G2 ────────────────────────────────────────────────────────────────────────────────────────

test('RW-G2 an UNWIRED governance service answers 501 STOCK_PREP_REFRESH_STORE_UNAVAILABLE governance_service on dry-run (sync and job), apply, reconcile, mvp-persist and carry — before any source read, with no token', async () => {
  const h = mount({ unwired: true })
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    for (const [lane, run] of [
      ['dry-run', () => dryRun(h)],
      ['reconcile', () => reconcile(h)],
      ['mvp-persist', () => mvpPersist(h)],
      ['apply', async () => apply(h, await mintToken(h, sheetId))],
      ['carry', () => call(h, 'POST', CARRY_PATH, { body: { decision: { decision: 'carry_via_confirm', idempotencyKey: JSON.stringify({ projectNo: PROJECT, componentSourceId: 'C', parentSourceId: null, path: ['N', 'C'] }), sourceIdempotencyKey: JSON.stringify({ projectNo: PROJECT, componentSourceId: 'C', parentSourceId: null, path: ['O', 'C'] }), componentSourceId: 'C', carryKey: 'component_source_id', manualRowReattach: 'propose_confirm', carryFields: ['notes'], writeVia: 'k2_confirm', requiresConfirm: true, carry: true } }, user: ADMIN })],
    ]) {
      const sourceReads = h.source.calls.length
      const res = await run()
      assert.equal(res.statusCode, 501, `${lane}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, CODE_UNAVAILABLE, lane)
      assert.equal(errorOf(res).details.reason, 'governance_service', lane)
      assert.equal(h.source.calls.length, sourceReads, `${lane}: zero source reads`)
    }
    // The background job: the enqueue answers 202, then the detached run reaches the same consult and STORES the
    // synchronous route's own refusal — wait for that record (not a fixed sleep), then assert it and zero reads.
    const job = await startJob(h)
    assert.equal(job.statusCode, 202, JSON.stringify(job.body))
    const jobRecord = () => Array.from(h.context.storage.entries())
      .filter(([key]) => String(key).startsWith('stock-preparation:dry-run-job:'))
      .map(([, value]) => value)
      .find((value) => value && value.status && value.status !== 'running')
    for (let i = 0; i < 200 && !jobRecord(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const stored = jobRecord()
    assert.ok(stored, 'the background run finished and stored its outcome')
    assert.equal(stored.status, 'failed')
    const storedText = JSON.stringify(stored)
    assert.ok(storedText.includes(CODE_UNAVAILABLE) && storedText.includes('governance_service'), `the stored failure is the consult's refusal: ${storedText}`)
    assert.equal(h.source.calls.length, 0, 'job: zero source reads')
  } finally { h.restore() }
})

// ── RW-G5 ────────────────────────────────────────────────────────────────────────────────────────

test('RW-G5 a steered tenant is refused by the consult: (a) a state row of T on the env sheet => TENANT_MISMATCH refresh_state, (b) a registry row of T naming the env sheet => TENANT_MISMATCH registry — zero source reads, zero step-4 writes; (c) switch on => the overlay\'s PROJECT_ABSENT with no consult at all', async () => {
  const a = mount({ switchOn: false })
  try {
    await a.refresh.seedHolds({ tenantId: TENANT, sheetId: ENV_SHEET, projectNo: PROJECT }, [])
    const rows = a.refresh.stepFourRowCount()
    const res = await dryRun(a, { user: PLATFORM, query: { tenantId: OTHER_TENANT } })
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_REFRESH_TENANT_MISMATCH')
    assert.deepEqual({ ...errorOf(res).details }, { store: 'continuation', table: 'refresh_state' })
    assert.equal(a.source.calls.length, 0)
    assert.equal(a.refresh.stepFourRowCount(), rows)
  } finally { a.restore() }
  const b = mount({ switchOn: false })
  try {
    b.db.rowsOf(harness.PROJECT_TARGET_TABLE).push({
      id: 'pt-rw-env', tenant_id: TENANT, project_no: 'PRJ-RW-OTHER', sheet_id: ENV_SHEET, object_id: 'obj_rw_env', status: 'active',
      created_by: 'seed', created_at: new Date('2026-10-08T00:00:00Z'), archived_at: null, updated_at: new Date('2026-10-08T00:00:00Z'),
    })
    const res = await dryRun(b, { user: PLATFORM, query: { tenantId: OTHER_TENANT } })
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_REFRESH_TENANT_MISMATCH')
    assert.equal(errorOf(res).details.store, 'registry')
    assert.equal(b.source.calls.length, 0)
    assert.equal(b.refresh.stepFourRowCount(), 0)
  } finally { b.restore() }
  const c = mount({ switchOn: true })
  try {
    c.seedRegistryRow(PROJECT)
    const before = consultCount(c)
    const res = await dryRun(c, { user: PLATFORM, query: { tenantId: OTHER_TENANT } })
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    assert.equal(consultCount(c), before, 'the overlay refused before any consult')
    assert.equal(c.source.calls.length, 0)
  } finally { c.restore() }
})

// ── RW-G6 / RW-G7 ────────────────────────────────────────────────────────────────────────────────

// Every planning / write lane of the route module against the RESOLVED sheet: dry-run, reconcile, mvp-persist,
// carry (a well-formed decision naming PROJECT) and apply (a token bound to the resolved sheet's generation), each
// with the records IO it made on that sheet. The chunk leg lives with the job seeding in
// stock-preparation-project-target-routes.test.cjs (R6g).
async function everyLane(h, resolvedSheetId) {
  const out = []
  const run = async (lane, fn) => {
    const before = h.records.calls.length
    const res = await fn()
    out.push({ lane, res, io: h.records.calls.slice(before).filter((entry) => Array.isArray(entry) && entry[1] === resolvedSheetId) })
  }
  await run('dry-run', () => dryRun(h))
  await run('reconcile', () => reconcile(h))
  await run('mvp-persist', () => mvpPersist(h))
  await run('carry', () => call(h, 'POST', CARRY_PATH, { body: { decision: carryDecision() }, user: ADMIN }))
  const token = await mintToken(h, resolvedSheetId)
  await run('apply', () => apply(h, token))
  return out
}

// Zero records IO on the resolved sheet before the refusal — except the apply lane's ONE pre-existing read: the
// #5860 foreign-rows probe (TA applyStockPreparationAction, before the token consume) runs ahead of the in-lease
// consult by design (a refusal must not burn the token). A read, never a write; the consult then refuses.
function assertNoRecordsIoBeforeRefusal(results, resolvedSheetId) {
  for (const { lane, io } of results) {
    if (lane === 'apply') assert.deepEqual(io, [['queryRecords', resolvedSheetId]], 'apply: only the #5860 foreign-rows probe')
    else assert.deepEqual(io, [], `${lane}: zero records IO on the resolved sheet`)
  }
}

test('RW-G6p a PILOT project registered on its managed sheet, switch off (the action resolves the env sheet): dry-run, reconcile, mvp-persist, carry and apply all answer 409 project_registered_on_another_sheet — zero source reads, no records IO on the env sheet before the refusal (apply: only the #5860 probe read), no record write, no token, no bump but the test\'s own, no step-4 write', async () => {
  const h = mount({ switchOn: false, tenantEnv: true })
  try {
    h.seedRegistryRow(PROJECT)
    markPilot(h)
    const scope = sheetWriteScopeKey(h.envSheet)
    const generation = await h.lockEnv.lock.readGeneration(scope)
    const results = await everyLane(h, h.envSheet)
    for (const { lane, res } of results) {
      assert.equal(res.statusCode, 409, `${lane}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, CODE_RETARGETED, lane)
      assert.equal(errorOf(res).details.reason, 'project_registered_on_another_sheet', lane)
    }
    assertNoRecordsIoBeforeRefusal(results, h.envSheet)
    assert.equal(h.source.calls.length, 0, 'zero source reads')
    assert.equal(h.records.calls.filter(([op]) => op === 'createRecord' || op === 'patchRecord').length, 0)
    const tokens = Array.from(h.context.storage.keys()).filter((key) => String(key).includes('dry-run-token'))
    assert.equal(tokens.length, 0, 'no lane minted a token (the one this test minted was consumed by the apply leg)')
    const after = await h.lockEnv.lock.readGeneration(scope)
    assert.equal(Number(after.generation), Number(generation ? generation.generation : 0) + 1, 'the only bump is the minted token\'s')
    assert.equal(h.refresh.stepFourRowCount(), 0)
  } finally { h.restore() }
})

test('RW-G6r (R-13) a project governed by step-4 ROWS on sheet A, the registry re-pointed to sheet B, switch ON: dry-run, reconcile, mvp-persist, carry and apply all answer 409 RETARGETED `sheet` — zero source reads, no records IO on B before the refusal (apply: only the #5860 probe read), no store write; VARIANT: unregistered, switch off, rows on A, the env sheet resolved => the same 409', async () => {
  const h = mount({ switchOn: true })
  try {
    const { sheetId: sheetB } = h.seedRegistryRow(PROJECT)
    await h.refresh.seedHolds({ tenantId: TENANT, sheetId: 'sheet_rw_previous_a', projectNo: PROJECT }, [contentChangeHold()])
    const before = h.refresh.snapshot()
    const results = await everyLane(h, sheetB)
    for (const { lane, res } of results) {
      assert.equal(res.statusCode, 409, `${lane}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, CODE_RETARGETED, lane)
      assert.equal(errorOf(res).details.reason, 'sheet', lane)
    }
    assertNoRecordsIoBeforeRefusal(results, sheetB)
    assert.equal(h.source.calls.length, 0)
    assert.equal(h.records.calls.filter(([op]) => op === 'createRecord' || op === 'patchRecord').length, 0)
    assert.equal(h.refresh.snapshot(), before, 'no store write')
  } finally { h.restore() }
  const v = mount({ switchOn: false, tenantEnv: true })
  try {
    await v.refresh.seedHolds({ tenantId: TENANT, sheetId: 'sheet_rw_previous_a', projectNo: PROJECT }, [contentChangeHold()])
    const before = v.refresh.snapshot()
    const results = await everyLane(v, v.envSheet)
    for (const { lane, res } of results) {
      assert.equal(res.statusCode, 409, `variant ${lane}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, CODE_RETARGETED, `variant ${lane}`)
      assert.equal(errorOf(res).details.reason, 'sheet', `variant ${lane}`)
    }
    assertNoRecordsIoBeforeRefusal(results, v.envSheet)
    assert.equal(v.source.calls.length, 0)
    assert.equal(v.refresh.snapshot(), before)
  } finally { v.restore() }
})

test('RW-G7 (GV-1) a registered project that is NOT pilot and has no step-4 row, switch off: today\'s behaviour — the same status, counts and evidence as an unregistered project on the env sheet, a token, zero step-4 rows', async () => {
  const run = async (registered) => {
    const h = mount({ switchOn: false })
    try {
      if (registered) h.seedRegistryRow(PROJECT)
      const res = await dryRun(h)
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.equal(h.refresh.stepFourRowCount(), 0)
      return res.body.data
    } finally { h.restore() }
  }
  const registered = await run(true)
  const unregistered = await run(false)
  assert.ok(registered.dryRunToken)
  assert.equal(registered.status, unregistered.status)
  assert.deepEqual(registered.counts, unregistered.counts)
  assert.deepEqual(registered.evidence, unregistered.evidence)
  assert.equal(Object.prototype.hasOwnProperty.call(registered, 'refreshHold'), false)
})

// ── RW-V4 ────────────────────────────────────────────────────────────────────────────────────────

test('RW-V4 a SUSPENDED preview is stamped `previewed` + STOCK_PREP_PULL_SUSPENDED (no token); its apply is refused 409 and stamped `refused` + the same code', async () => {
  const h = mount({ switchOn: true })
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    await h.refresh.seedHolds({ tenantId: TENANT, sheetId, projectNo: PROJECT }, [contentChangeHold()])
    const dry = await dryRun(h)
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.equal(dry.body.data.status, 'suspended')
    assert.equal(dry.body.data.dryRunToken, null)
    assert.equal(dry.body.data.refreshHold.held, true)
    const row = h.registryRows().find((entry) => entry.project_no === PROJECT)
    assert.equal(row.last_pull_outcome, 'previewed')
    assert.equal(row.last_pull_code, 'STOCK_PREP_PULL_SUSPENDED')
    const applied = await apply(h, await mintToken(h, sheetId))
    assert.equal(applied.statusCode, 409, JSON.stringify(applied.body))
    assert.equal(errorOf(applied).code, 'STOCK_PREP_PULL_SUSPENDED')
    const after = h.registryRows().find((entry) => entry.project_no === PROJECT)
    assert.equal(after.last_pull_outcome, 'refused')
    assert.equal(after.last_pull_code, 'STOCK_PREP_PULL_SUSPENDED')
    assert.equal(h.records.calls.filter(([op]) => op === 'createRecord' || op === 'patchRecord').length, 0)
  } finally { h.restore() }
})

test('RW-V5 (review round 1) a governed project whose earlier execution FAILED previews `recovery_pending` through the route — 200, canApply false, no token, no bump — and is stamped `previewed` + STOCK_PREP_REFRESH_RECOVERY_PENDING', async () => {
  const h = mount({ switchOn: true })
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    await h.refresh.seedExecution({ tenantId: TENANT, sheetId, projectNo: PROJECT }, { status: 'failed' })
    const generation = await h.lockEnv.lock.readGeneration(sheetWriteScopeKey(sheetId))
    const dry = await dryRun(h)
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.equal(dry.body.data.status, 'recovery_pending')
    assert.equal(dry.body.data.canApply, false)
    assert.equal(dry.body.data.dryRunToken, null)
    assert.deepEqual(dry.body.data.refreshRecovery, { pending: true, openExecutions: 1 })
    assert.deepEqual(await h.lockEnv.lock.readGeneration(sheetWriteScopeKey(sheetId)), generation, 'no bump')
    const row = h.registryRows().find((entry) => entry.project_no === PROJECT)
    assert.equal(row.last_pull_outcome, 'previewed')
    assert.equal(row.last_pull_code, 'STOCK_PREP_REFRESH_RECOVERY_PENDING')
  } finally { h.restore() }
})

// Step-4 review follow-ups (item 10, design §23.8 F-18): the straddle 409 (`execution_finished_during_preview`) is
// not stamped `refused` — like WRITE_LOCKED, it describes ANOTHER run (the apply that just finished and stamped its
// own `applied`), so a `refused` stamp from this preview would overwrite the holder's outcome.
test('RW-V6 a preview refused 409 STATE_MOVED execution_finished_during_preview leaves the just-finished apply\'s `applied` stamp untouched', async () => {
  let finish = null
  const h = mount({ switchOn: true, refreshOptions: { consultHook: async (n) => { if (n === 1 && finish) await finish() } } })
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    const scope = { tenantId: TENANT, sheetId, projectNo: PROJECT }
    const execution = await h.refresh.seedExecution(scope, { status: 'running' })
    // The apply that holds that execution stamps its outcome as it finishes.
    await h.projectTargetStore.recordPullOutcome({ tenantId: TENANT, projectNo: PROJECT, outcome: 'applied', code: null })
    const stamped = { ...h.registryRows().find((entry) => entry.project_no === PROJECT) }
    assert.equal(stamped.last_pull_outcome, 'applied')
    finish = () => h.refresh.store.finishExecution({ ...scope, executionId: execution.id, status: 'succeeded', written: 0, attemptedWrites: 0 })
    const dry = await dryRun(h)
    assert.equal(dry.statusCode, 409, JSON.stringify(dry.body))
    assert.equal(errorOf(dry).code, 'STOCK_PREP_PULL_STATE_MOVED')
    assert.equal(errorOf(dry).details.reason, 'execution_finished_during_preview')
    const row = h.registryRows().find((entry) => entry.project_no === PROJECT)
    assert.equal(row.last_pull_outcome, 'applied', 'the straddle refusal never overwrites the apply\'s stamp')
    assert.equal(row.last_pull_code, stamped.last_pull_code)
  } finally { h.restore() }
})

// ...while another STATE_MOVED refusal is still stamped `refused` (the exemption is that one reason only).
test('RW-V6b the exemption is narrow: the predicate names only execution_finished_during_preview', () => {
  const lanes = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))
  const { REFRESH_LANE_ERROR_CODES, StockPreparationRefreshLaneError, isExecutionFinishedDuringPreview } = lanes
  assert.equal(typeof isExecutionFinishedDuringPreview, 'function')
  assert.equal(isExecutionFinishedDuringPreview(new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.STATE_MOVED, 'x', { reason: 'execution_finished_during_preview', partial: false })), true)
  assert.equal(isExecutionFinishedDuringPreview(new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.STATE_MOVED, 'x', { reason: 'decision_version_moved', partial: false })), false)
  assert.equal(isExecutionFinishedDuringPreview(Object.assign(new Error('x'), { code: 'STOCK_PREP_PROJECT_WRITE_LOCKED', details: { reason: 'execution_finished_during_preview' } })), false)
  assert.equal(isExecutionFinishedDuringPreview(null), false)
})

// ── RW-CR (TD-25 / TD-26) ────────────────────────────────────────────────────────────────────────

const CARRY_COMPONENT = 'PART-RW-CARRY'
const OLD_KEY = JSON.stringify({ projectNo: PROJECT, componentSourceId: CARRY_COMPONENT, parentSourceId: null, path: ['OLD', CARRY_COMPONENT] })
const NEW_KEY = JSON.stringify({ projectNo: PROJECT, componentSourceId: CARRY_COMPONENT, parentSourceId: null, path: ['NEW', CARRY_COMPONENT] })
function carryDecision(newKey = NEW_KEY) {
  return { decision: 'carry_via_confirm', idempotencyKey: newKey, sourceIdempotencyKey: OLD_KEY, componentSourceId: CARRY_COMPONENT, carryKey: 'component_source_id', manualRowReattach: 'propose_confirm', carryFields: ['notes'], writeVia: 'k2_confirm', requiresConfirm: true, carry: true }
}

// A records fake the carry runs against (rows per sheet, equality filters, expectedVersion), installed over the
// harness's records surface (its fake host fence still wraps it).
function carryRecordsFake() {
  const rows = []
  const calls = []
  const matches = (record, filters) => Object.entries(filters || {}).every(([key, value]) => record.data[key] === value)
  return {
    rows,
    calls,
    async queryRecords(input = {}) {
      calls.push(['queryRecords'])
      const found = rows.filter((record) => record.sheetId === input.sheetId && matches(record, input.filters))
      const offset = input.offset || 0
      return JSON.parse(JSON.stringify(found.slice(offset, offset + (input.limit || 1000))))
    },
    async createRecord(input = {}) {
      calls.push(['createRecord'])
      const record = { id: `rec_rw_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(record)
      return JSON.parse(JSON.stringify(record))
    },
    async patchRecord(input = {}) {
      calls.push(['patchRecord'])
      const record = rows.find((entry) => entry.sheetId === input.sheetId && entry.id === input.recordId)
      if (!record) throw new Error('record not found')
      if (input.expectedVersion !== undefined && record.version !== input.expectedVersion) throw Object.assign(new Error('Record version conflict'), { name: 'MultitableRecordVersionConflictError', code: 'VERSION_CONFLICT' })
      Object.assign(record.data, input.changes || {})
      record.version += 1
      return JSON.parse(JSON.stringify(record))
    },
  }
}

// The carry pair. Default: switch ON, the project registered (its own sheet). `switchOn: false`: the project is
// NOT registered and the pair lives on the tenant's env sheet (`tenantEnv`, the only env shape the carry's tenant
// wall admits). `newKey`: the key the successor row carries (a duplicate-resolved one, V50B-16).
function carryMount({ switchOn = true, newKey = NEW_KEY } = {}) {
  const h = mount(switchOn ? { switchOn: true } : { switchOn: false, tenantEnv: true })
  const fake = carryRecordsFake()
  Object.assign(h.records, { queryRecords: fake.queryRecords, createRecord: fake.createRecord, patchRecord: fake.patchRecord })
  const { sheetId, objectId } = switchOn ? h.seedRegistryRow(PROJECT) : { sheetId: h.envSheet, objectId: ENV_OBJECT }
  // The env target is configured with an EMPTY fieldIdMap, so its physical ids are the logical ones; a project
  // sheet's come from provisioning.
  const physical = switchOn ? (fieldId) => h.provisioning.getFieldId(h.staging, objectId, fieldId) : (fieldId) => fieldId
  const seedRow = (logical, id) => fake.rows.push({ id, sheetId, version: 1, data: Object.fromEntries(Object.entries(logical).map(([key, value]) => [physical(key), value])) })
  seedRow({ projectNo: PROJECT, idempotencyKey: OLD_KEY, componentSourceId: CARRY_COMPONENT, path: JSON.stringify(['OLD', CARRY_COMPONENT]), totalQuantity: 2, active: false, notes: 'synthetic carried note' }, 'rec_rw_old')
  seedRow({ projectNo: PROJECT, idempotencyKey: newKey, componentSourceId: CARRY_COMPONENT, path: JSON.stringify(['NEW', CARRY_COMPONENT]), totalQuantity: 2, active: true }, 'rec_rw_new')
  fake.calls.length = 0
  return Object.assign(h, {
    sheetId,
    scope: { tenantId: TENANT, sheetId, projectNo: PROJECT },
    patches: () => fake.calls.filter(([op]) => op === 'patchRecord').length,
    carriedNote: () => fake.rows.find((row) => row.id === 'rec_rw_new').data[physical('notes')],
  })
}

// The conflict planner's duplicate-resolved key shape (`duplicateResolvedKey`): `<base>::duplicate:<kind>:<hash>`.
const duplicateResolved = (key) => `${key}::duplicate:sortLine:${'7'.repeat(16)}`

const carry = (h, decision = carryDecision()) => call(h, 'POST', CARRY_PATH, { body: { decision }, user: ADMIN })

test('RW-CR1..CR5 the carry on a GOVERNED project consults inside its lease: an ordinary open hold => allowed (the human column patched); the store unreadable => 503; a runbook-only hold => 409 runbook_only_hold; an unfinished execution => 409 RECOVERY_PENDING — none of the refusals patch; a decision without a project never reaches the consult', async () => {
  // CR1: an ORDINARY open hold (the pull is suspended): a person's carry of a human column still goes through.
  const ordinary = carryMount()
  try {
    await ordinary.refresh.seedHolds(ordinary.scope, [contentChangeHold()])
    const res = await carry(ordinary)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.mode, 'carried')
    assert.equal(ordinary.patches(), 1)
  } finally { ordinary.restore() }
  // CR2: unreadable.
  const unreadable = carryMount()
  try {
    unreadable.refresh.db.faults.select = (args) => (args && /integration_stock_prep_(continuation|refresh)/.test(args.table) ? refreshKit.sqlError('42P01', 'relation does not exist') : null)
    const res = await carry(unreadable)
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_REFRESH_STORE_FAILED')
    assert.equal(unreadable.patches(), 0)
  } finally { unreadable.restore() }
  // CR3: a runbook-only hold (an escalated relationship, seeded through the store: confirm -> reconcile -> escalate).
  const runbook = carryMount()
  try {
    const candidate = await refreshKit.candidateHoldFixture()
    await runbook.refresh.seedEscalatedContinuation(runbook.scope, candidate.hold, { sourceIdentity: candidate.sourceIdentity })
    const res = await carry(runbook)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_PULL_SUSPENDED')
    assert.deepEqual({ ...errorOf(res).details }, { reason: 'runbook_only_hold', holdCount: 1, partial: false })
    assert.equal(runbook.patches(), 0)
  } finally { runbook.restore() }
  // CR4: an earlier failed execution (O-22 for the carry lane).
  const recovering = carryMount()
  try {
    await recovering.refresh.seedExecution(recovering.scope, { status: 'failed' })
    const res = await carry(recovering)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_REFRESH_RECOVERY_PENDING')
    assert.equal(recovering.patches(), 0)
  } finally { recovering.restore() }
  // CR5 (TD-26): a decision whose key names no project. Switch on, the overlay refuses before the lease (no consult);
  // switch off, the env sheet resolves and the CONSULT answers 422 projectNo inside the lease — before the ledger
  // pre-flight (zero records IO of any kind), nothing patched.
  const keyless = carryMount()
  try {
    const before = consultCount(keyless)
    const res = await carry(keyless, carryDecision('not-a-json-key'))
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, JSON.stringify(res.body))
    assert.equal(consultCount(keyless), before)
    assert.equal(keyless.patches(), 0)
  } finally { keyless.restore() }
  const off = mount({ switchOn: false, tenantEnv: true })
  try {
    const res = await carry(off, carryDecision('not-a-json-key'))
    assert.equal(res.statusCode, 422, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_REFRESH_INPUT_INVALID')
    assert.equal(errorOf(res).details.field, 'projectNo')
    assert.equal(off.records.calls.length, 0, 'zero records IO: no ledger read, no patch')
  } finally { off.restore() }
})

// ── RW-CR6..CR8: a DUPLICATE-RESOLVED decision key (review round 1, lens B V50B-16) ─────────────────

test('RW-CR6 (V50B-16) a NOT-governed project\'s carry whose key is duplicate-resolved (`<json>::duplicate:<kind>:<hash>`) carries as before this PR: switch off (unregistered, env sheet) => 200 carried; switch on (registered, not governed) => 200 carried on its own sheet', async () => {
  const key = duplicateResolved(NEW_KEY)
  for (const switchOn of [false, true]) {
    const h = carryMount({ switchOn, newKey: key })
    try {
      const res = await carry(h, carryDecision(key))
      assert.equal(res.statusCode, 200, `switch ${switchOn ? 'on' : 'off'}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.data.mode, 'carried')
      assert.equal(h.patches(), 1)
      assert.equal(h.carriedNote(), 'synthetic carried note')
      assert.equal(h.refresh.stepFourRowCount(), 0, 'a not-governed carry writes no step-4 row')
    } finally { h.restore() }
  }
})

test('RW-CR7 (V50B-16) a GOVERNED project with a duplicate-resolved key consults THAT project: an earlier failed execution of it refuses 409 RECOVERY_PENDING (a key parsed to no project would answer 422 / 400 instead), nothing patched', async () => {
  const key = duplicateResolved(NEW_KEY)
  const h = carryMount({ newKey: key })
  try {
    await h.refresh.seedExecution(h.scope, { status: 'failed' })
    const res = await carry(h, carryDecision(key))
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_REFRESH_RECOVERY_PENDING')
    assert.equal(h.patches(), 0)
  } finally { h.restore() }
})

test('RW-CR8 (V50B-16, the executor half) a duplicate-resolved key whose embedded project is NOT the rows\' project is refused 409 CONFIRM_CARRY_PROJECT_MISMATCH (idempotencyKey) — the executor checks the BASE of a suffixed key now, where it used to skip it — nothing patched', async () => {
  const otherProjectKey = duplicateResolved(JSON.stringify({ projectNo: 'PRJ-RW-OTHER', componentSourceId: CARRY_COMPONENT, parentSourceId: null, path: ['NEW', CARRY_COMPONENT] }))
  const h = carryMount({ switchOn: false, newKey: otherProjectKey })
  try {
    const res = await carry(h, carryDecision(otherProjectKey))
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'CONFIRM_CARRY_PROJECT_MISMATCH')
    assert.equal(errorOf(res).details.field, 'idempotencyKey')
    assert.equal(h.patches(), 0)
  } finally { h.restore() }
})

// ── RW-SB1 (R-1) ─────────────────────────────────────────────────────────────────────────────────

test('RW-SB1 (R-1) a governed project whose (tenant, action) bindings disagree: the dry-run route answers 409 SOURCE_BINDING_SPLIT bindings_disagree before any source read; a not-governed project with the same split is unaffected', async () => {
  const bindings = wiring.createSourceBindingStoreFake()
  bindings.seed({ tenantId: TENANT, actionId: PLM_STOCK_PREPARATION_ACTION_ID, workspaceId: null, externalSystemId: 'plm_sql_source_synthetic' })
  bindings.seed({ tenantId: TENANT, actionId: PLM_STOCK_PREPARATION_ACTION_ID, workspaceId: 'ws_rw_1', externalSystemId: 'plm_rw_other' })
  const h = mount({ switchOn: true, sourceBindingStore: bindings })
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    const free = await dryRun(h)
    assert.equal(free.statusCode, 200, `not governed: ${JSON.stringify(free.body)}`)
    assert.equal(bindings.calls.filter(([op]) => op === 'listForAction').length, 0, 'a not-governed project is never listed')
    await h.refresh.seedHolds({ tenantId: TENANT, sheetId, projectNo: PROJECT }, [contentChangeHold()])
    const reads = h.source.calls.length
    const res = await dryRun(h)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_REFRESH_SOURCE_BINDING_SPLIT')
    assert.equal(errorOf(res).details.reason, 'bindings_disagree')
    assert.equal(h.source.calls.length, reads)
  } finally { h.restore() }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-route-wiring.test.cjs', tests)
