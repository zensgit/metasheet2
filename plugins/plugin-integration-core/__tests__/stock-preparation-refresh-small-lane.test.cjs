'use strict'

// Batch-refresh step 4, PR-3a — THE SMALL LANE, DIRECT LIB CALLS (plan-final §3.2 DL rows). The table-action
// lib (`dryRunStockPreparationAction`, `applyStockPreparationAction`, `prepareStockPreparationConfirmationDecisions`,
// `prepareStockPreparationMvpSnapshot`) driven the way the routes drive it — the dry-run through the generation
// binder, the apply inside the REAL project write lease (in-memory lock kit) — with the REAL governance reader,
// the REAL continuation store over the faithful step-4 fake db, and the REAL handle builder
// (support/stock-preparation-refresh-governance-wiring.cjs; no stub reader, P3-C3). Expansions are REAL
// `expandPlmProjectBom` walks over the canonical S/P fixtures with the #6502 recorder.
//
// Covers (case names below): SL-G1 / G2 / G3 / G4 / G8 / G9, SL-S1 / S2 (E-1 layer (a)) / S7 / S8 (O-22) / S9,
// SL-AP1 (R-4), SL-AMB2 (TD-24), SL-H8 (AMB-1, E-2(a)), SL-X1..X6 / T1 (the execution ledger), SL-SB1..SB4
// (R-1), SL-PK1..PK5 (R-2), SL-M1 (M-1). Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

// ── spies installed BEFORE the table-action module loads (it destructures these at load time) ─────────────
const plannerModule = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const expansionModule = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const plannerInputs = []
const expanderInputs = []
const originalPlan = plannerModule.planStockPreparationConflicts
const originalExpand = expansionModule.expandPlmProjectBom
plannerModule.planStockPreparationConflicts = function plannerSpy(input) {
  plannerInputs.push(input)
  return originalPlan.apply(this, arguments)
}
expansionModule.expandPlmProjectBom = function expanderSpy(input) {
  expanderInputs.push(input)
  return originalExpand.apply(this, arguments)
}

const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const lanes = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const { readProjectRefreshState } = require(path.join(LIB, 'stock-preparation-refresh-state.cjs'))
const { sheetWriteScopeKey, writeBindingFromGeneration } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { PLM_STOCK_PREPARATION_BOM_READ_PLAN } = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const wiring = require('./support/stock-preparation-refresh-governance-wiring.cjs')
const refreshKit = require('./support/stock-preparation-refresh-store-kit.cjs')
const F = require('./support/stock-preparation-continuation-fixtures.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_sl_a'
const SHEET = 'sheet_sl_main'
const PROJECT = F.PROJECT_NO
const PLANNED_AT = '2026-10-26T01:00:00.000Z'
const RUN_ID = 'run_sl'
const SANDBOX_POLICY = Object.freeze({ enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] })
const SCOPE = Object.freeze({ tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT })
const T = { continuation: 'integration_stock_prep_continuation', member: 'integration_stock_prep_continuation_member', state: 'integration_stock_prep_refresh_state', hold: 'integration_stock_prep_refresh_hold', execution: 'integration_stock_prep_refresh_execution' }

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function baseAction(overrides = {}) {
  return {
    actionId: 'plm.stock-preparation.pull-bom.v1',
    source: { externalSystemId: 'plm_sl_fixture', kind: 'data-source:sql-readonly', ...(overrides.source || {}) },
    target: { sheetId: SHEET, objectId: 'stockPreparationMain' },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'source')),
  }
}

// The canonical synthetic source, with the recorder's read plan; `fail` names objects whose read throws.
function createSource(initial) {
  const state = { data: initial, fail: [], calls: [] }
  const adapter = {
    async read(input = {}) {
      state.calls.push(input.object)
      if (state.fail.includes(input.object)) throw Object.assign(new Error('synthetic source read failure'), { code: 'SYN_READ_FAILURE' })
      const rows = Array.isArray(state.data[input.object]) ? state.data[input.object] : []
      const matches = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit || 1000
      const records = matches.slice(offset, offset + limit).map(clone)
      return { records, done: offset + records.length >= matches.length, nextCursor: offset + records.length < matches.length ? String(offset + records.length) : null }
    },
  }
  return { state, adapter }
}

// The stock-prep main sheet: declares the host write fence itself (the writer hands it the fence on every write).
function createSheet() {
  const rows = []
  const calls = []
  const api = {
    supportsWriteFence: true,
    async queryRecords(input = {}) {
      calls.push(['queryRecords'])
      return rows
        .filter((record) => record.sheetId === input.sheetId)
        .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
        .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
        .map(clone)
    },
    async createRecord(input = {}) {
      calls.push(['createRecord'])
      if (sheet.failCreates > 0) {
        sheet.failCreates -= 1
        throw Object.assign(new Error('synthetic create failure'), { code: 'SYN_CREATE_FAILED' })
      }
      const record = { id: `rec_sl_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(record)
      return clone(record)
    },
    async patchRecord(input = {}) {
      calls.push(['patchRecord'])
      const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
      if (!record) throw new Error('sheet fake: record not found')
      record.version += 1
      record.data = { ...record.data, ...(input.changes || {}) }
      return clone(record)
    },
  }
  const sheet = { rows, calls, api, failCreates: 0, writes: () => calls.filter(([op]) => op === 'createRecord' || op === 'patchRecord').length }
  return sheet
}

async function world({ pilot = true, registered = true, sourceBindingStore, packInstallStore, provisioning } = {}) {
  const harness = lockKit.createLibWriteLockHarness({
    refresh: {
      ...(sourceBindingStore !== undefined ? { sourceBindingStore } : {}),
      ...(packInstallStore !== undefined ? { packInstallStore } : {}),
      ...(provisioning !== undefined ? { provisioning } : {}),
    },
  })
  const env = harness.refresh()
  if (registered) await env.registerProject({ tenantId: TENANT, projectNo: PROJECT, sheetId: SHEET, objectId: 'stockPreparationMain', pilot })
  const source = createSource(F.firstPullSource())
  const sheet = createSheet()
  const tokenStore = lockKit.createConsumableStorage()
  const scopeKey = sheetWriteScopeKey(SHEET)
  const w = {
    harness, env, source, sheet, tokenStore, scopeKey,
    action: baseAction(),
    handle: (overrides) => env.handleFor(TENANT, overrides),
    async dryRun(extra = {}) {
      return harness.wrapDryRun(tableActions.dryRunStockPreparationAction)({
        action: w.action, parameters: { projectNo: PROJECT }, sourceAdapter: source.adapter, recordsApi: sheet.api, tokenStore, plannedAt: PLANNED_AT, runId: RUN_ID, tenantId: TENANT, ...extra,
      })
    },
    async apply(dryRunToken, extra = {}) {
      return harness.wrapApply(tableActions.applyStockPreparationAction)({
        sandboxPolicy: SANDBOX_POLICY, action: w.action, parameters: { projectNo: PROJECT }, dryRunToken, sourceAdapter: source.adapter, recordsApi: sheet.api, tokenStore, permission: 'write', plannedAt: PLANNED_AT, runId: RUN_ID, tenantId: TENANT, ...extra,
      })
    },
    async reconcile(extra = {}) {
      return tableActions.prepareStockPreparationConfirmationDecisions({
        action: w.action, parameters: { projectNo: PROJECT }, sourceAdapter: source.adapter, recordsApi: sheet.api, plannedAt: PLANNED_AT, runId: RUN_ID, refreshGovernance: w.handle(), ...extra,
      })
    },
    async mvp(extra = {}) {
      return tableActions.prepareStockPreparationMvpSnapshot({
        action: w.action, parameters: { projectNo: PROJECT }, sourceAdapter: source.adapter, recordsApi: sheet.api, plannedAt: PLANNED_AT, runId: RUN_ID, refreshGovernance: w.handle(), ...extra,
      })
    },
    async consult() {
      return env.governance.consult(SCOPE)
    },
    async derived() {
      return readProjectRefreshState(await w.consult())
    },
    async generation() {
      return harness.lock.readGeneration(scopeKey)
    },
    rows(table) {
      return env.db.rows(T[table])
    },
    async tokenRecord(token) {
      return tokenStore.map.get(`integration:table-action:dry-run-token:${token}`) || null
    },
    // The first pull, applied (governed when the project is: a clean pilot pull begins and finishes an execution).
    async firstPullApplied() {
      source.state.data = F.firstPullSource()
      const preview = await w.dryRun()
      assert.equal(preview.status, 'ready', `first pull preview: ${preview.status}`)
      const applied = await w.apply(preview.dryRunToken)
      assert.equal(applied.status, 'succeeded')
      return { preview, applied }
    },
    // The open continuation_candidate the second pull persisted, confirmed through the store (PR-4's transaction).
    async confirmOpenCandidate() {
      const row = env.db.rows(T.hold).find((entry) => entry.kind === 'continuation_candidate' && entry.status === 'open')
      assert.ok(row, 'an open continuation_candidate hold')
      return env.store.confirmContinuation({
        ...SCOPE,
        holdId: row.id,
        echo: { holdFingerprint: row.fingerprint, comparisonFingerprint: row.comparison_fingerprint, evidenceFingerprint: row.evidence_fingerprint },
        basis: { kind: 'puller_confirmed_same_demand' },
        confirmedBy: 'u_sl_puller',
        sourceIdentity: lanes.refreshSourceIdentity({ action: tableActions.assertStockPreparationTargetReady(w.action), tenantId: TENANT }),
      }, { bumpWithin: env.bump.bumpWithin })
    },
    async clearPilot() {
      // The registry row's pilot columns cleared (the admin's exit); the rows of step 4 stay (C10).
      const db = env.db
      const registry = db.rows(refreshKit.REGISTRY_TABLE)
      for (const entry of registry) {
        await db.updateRow(refreshKit.REGISTRY_TABLE, { pilot_enabled_at: null, pilot_enabled_by: null, pilot_readiness_version: null }, { id: entry.id })
      }
    },
  }
  return w
}

async function expectCode(promise, { status, code, reason }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a refusal ${code}`)
  if (status !== undefined) assert.equal(caught.status, status, `${caught.code}: ${caught.message}`)
  if (code !== undefined) assert.equal(caught.code, code, `${caught.code}: ${caught.message}`)
  if (reason !== undefined) assert.equal(caught.details && caught.details.reason, reason, JSON.stringify(caught.details))
  return caught
}

function stateVersion(w) {
  const state = w.rows('state')[0]
  return state ? state.version : null
}

// ── SL-G4 / C09: a NOT governed project ──────────────────────────────────────────────────────────

test('SL-G4 a NOT-governed project: dry-run, apply, reconcile and mvp-persist write no step-4 row, the next consult still answers governed:false, the token carries no refreshBinding, the response no refreshHold, and the writer accepted the not_governed verdict', async () => {
  const w = await world({ pilot: false, registered: false })
  const preview = await w.dryRun()
  assert.equal(preview.status, 'ready')
  assert.ok(preview.dryRunToken)
  assert.equal(Object.prototype.hasOwnProperty.call(preview, 'refreshHold'), false)
  const record = await w.tokenRecord(preview.dryRunToken)
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'refreshBinding'), false)
  const applied = await w.apply(preview.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  assert.equal(w.sheet.writes(), 4, 'the four first-pull rows were written through the writer (verdict not_governed accepted)')
  await w.reconcile()
  w.source.state.data = F.firstPullSource()
  await w.mvp()
  assert.equal(w.env.stepFourRowCount(), 0, 'no step-4 row was written for a not-governed project (TD-4)')
  assert.equal((await w.consult()).governed, false)
  // A registered project that is NOT pilot behaves the same (GV-1: not governed without rows).
  const registered = await world({ pilot: false, registered: true })
  const previewRegistered = await registered.dryRun()
  await registered.apply(previewRegistered.dryRunToken)
  assert.equal(registered.env.stepFourRowCount(), 0)
})

// ── SL-S1 / A01: the suspended preview ────────────────────────────────────────────────────────────

test('SL-S1 a pilot project\'s second pull (S-001 now nested in P-001) previews SUSPENDED: no token, no bump, canApply false, a values-free refreshHold stanza, the candidate hold persisted open; an earlier token is not superseded (and its apply is refused SUSPENDED, never TOKEN_MISMATCH)', async () => {
  const w = await world()
  await w.firstPullApplied()
  // A clean settling preview of the unchanged source mints a token (the "earlier" one).
  const earlier = await w.dryRun()
  assert.equal(earlier.status, 'ready')
  assert.ok(earlier.dryRunToken)
  const generationBefore = await w.generation()
  w.source.state.data = F.secondPullSource()
  const suspended = await w.dryRun()
  assert.equal(suspended.status, 'suspended')
  assert.equal(suspended.canApply, false)
  assert.equal(suspended.dryRunToken, null)
  assert.equal(suspended.evidence.canApply, false)
  assert.deepEqual(await w.generation(), generationBefore, 'no small_preview bump')
  assert.equal(suspended.refreshHold.held, true)
  assert.equal(suspended.refreshHold.holdCount, 1)
  assert.equal(suspended.refreshHold.confirmableCount, 1)
  assert.deepEqual(suspended.refreshHold.kinds, { continuation_candidate: 1 })
  assert.ok(/^[0-9a-f]{64}$/.test(suspended.refreshHold.holdSetFingerprint))
  assert.equal(JSON.stringify(suspended).includes('P-001'), false, 'the response carries no hold value')
  const open = w.rows('hold').filter((row) => row.status === 'open')
  assert.deepEqual(open.map((row) => row.kind), ['continuation_candidate'])
  // The earlier token: still bound to the current generation (not superseded) — and refused SUSPENDED.
  const writesBefore = w.sheet.writes()
  await expectCode(w.apply(earlier.dryRunToken), { status: 409, code: 'STOCK_PREP_PULL_SUSPENDED' })
  assert.equal(w.sheet.writes(), writesBefore)
})

// ── SL-S2: E-1 LAYER (a) — the apply lib refuses a suspended recompute itself ─────────────────────

test('SL-S2 (E-1 layer a) a suspended in-lease recompute is refused 409 STOCK_PREP_PULL_SUSPENDED by the APPLY LIB — with a forged token (suspended revision, current binding), a stale one, and acceptManualConfirmHold:true — before any writer call or execution row', async () => {
  const w = await world()
  await w.firstPullApplied()
  const stale = (await w.dryRun()).dryRunToken
  w.source.state.data = F.secondPullSource()
  const suspended = await w.dryRun()
  assert.equal(suspended.status, 'suspended')
  const forge = async () => tableActions.__internals.createDryRunToken(w.tokenStore, {
    actionId: 'plm.stock-preparation.pull-bom.v1',
    parametersHash: tableActions.__internals.hashJson({ projectNo: PROJECT }),
    revision: suspended.revision,
    conflictPolicyReview: null,
    ...writeBindingFromGeneration(await w.generation()),
  })
  const executionsBefore = w.rows('execution').length
  for (const [label, token, extra] of [
    ['forged', await forge(), {}],
    ['forged + acceptManualConfirmHold', await forge(), { acceptManualConfirmHold: true }],
    ['stale', stale, {}],
  ]) {
    const writes = w.sheet.writes()
    const refused = await expectCode(w.apply(token, extra), { status: 409, code: 'STOCK_PREP_PULL_SUSPENDED' })
    assert.equal(refused.details.partial, false, label)
    assert.ok(refused.details.holdCount >= 1, label)
    assert.deepEqual(Object.keys(refused.details.kinds), ['continuation_candidate'], label)
    assert.equal(w.sheet.writes(), writes, `${label}: zero main-sheet writes`)
    assert.equal(w.rows('execution').length, executionsBefore, `${label}: no execution row`)
    assert.equal(await w.tokenRecord(token), null, `${label}: the token is burned (I4)`)
  }
})

// A confirmed relationship, executed (A02): first pull applied, the candidate confirmed, the re-preview applied.
async function confirmedAndExecuted(w) {
  await w.firstPullApplied()
  w.source.state.data = F.secondPullSource()
  const candidate = await w.dryRun()
  assert.equal(candidate.status, 'suspended')
  const confirmed = await w.confirmOpenCandidate()
  const replan = await w.dryRun()
  assert.equal(replan.status, 'ready', `A02 re-preview: ${replan.status}`)
  const applied = await w.apply(replan.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  return { confirmed, replan, applied }
}

// The incomplete reads of AMB-2: each a source / action change on top of the second pull.
const INCOMPLETE_READS = Object.freeze([
  ['soft row error (a missing component)', (w) => { w.source.state.data = F.secondPullSource({ extraOrders: [{ part: 'GHOST-9', qty: 1 }] }) }, 'failed'],
  ['hard row error (missing_child_bom)', (w) => { w.source.state.data = F.secondPullSource({ boms: { 'PART-B': [] } }) }, 'failed'],
  ['global error (a source read that fails)', (w) => { w.source.state.data = F.secondPullSource(); w.source.state.fail = ['DN_PDM_BomDetailsInfo'] }, 'failed'],
  ['truncated row errors (rowErrorLimit)', (w) => { w.source.state.data = F.secondPullSource({ extraOrders: [{ part: 'GHOST-8', qty: 1 }, { part: 'GHOST-9', qty: 1 }] }); w.action = baseAction({ rowErrorLimit: 1 }) }, 'failed'],
  ['bounded (max rows)', (w) => { w.source.state.data = F.secondPullSource(); w.action = baseAction({ maxRows: 3 }) }, 'large_bom_bounded'],
  ['not found', (w) => { w.source.state.data = F.project({ projectNo: 'PRJ-SCC-OTHER', orders: [{ part: 'N-001', qty: 1 }], parts: F.PARTS.slice() }) }, 'not_found'],
])

function resetSource(w) {
  w.source.state.fail = []
  w.action = baseAction()
}

// ── SL-AP1 (R-4): a governed token over an INCOMPLETE recompute ───────────────────────────────────

test('SL-AP1 (R-4) a governed token whose in-lease recompute is incomplete (soft / hard row error, global error, truncated, bounded, not found) is refused 409 TABLE_ACTION_DRY_RUN_NOT_APPLYABLE `refresh_incomplete_computation` — never a TypeError / 500 — with no reconcile, no execution, no write, the token burned', async () => {
  for (const [label, makeIncomplete] of INCOMPLETE_READS) {
    const w = await world()
    await w.firstPullApplied()
    const token = (await w.dryRun()).dryRunToken
    assert.ok(token, `${label}: a governed token was minted`)
    const version = stateVersion(w)
    const executions = w.rows('execution').length
    const writes = w.sheet.writes()
    makeIncomplete(w)
    const refused = await expectCode(w.apply(token), { status: 409, code: 'TABLE_ACTION_DRY_RUN_NOT_APPLYABLE', reason: 'refresh_incomplete_computation' })
    assert.equal(refused.details.partial, false, label)
    assert.equal(stateVersion(w), version, `${label}: no reconcile`)
    assert.equal(w.rows('execution').length, executions, `${label}: no execution begun`)
    assert.equal(w.sheet.writes(), writes, `${label}: no write`)
    assert.equal(await w.tokenRecord(token), null, `${label}: burned`)
  }
})

// ── SL-AMB2 (TD-24): only a COMPLETE computation reconciles ──────────────────────────────────────

test('SL-AMB2 (TD-24) on a governed project with a relationship, an incomplete read reconciles NOTHING (no hold, verdict, settlement or last_computation write), answers failed / large_bom_bounded / not_found with no token and no refreshHold, leaves the relationship active; the next complete read verifies valid', async () => {
  for (const [label, makeIncomplete, expectedStatus] of INCOMPLETE_READS) {
    const w = await world()
    await confirmedAndExecuted(w)
    const before = w.env.snapshot()
    const generation = await w.generation()
    makeIncomplete(w)
    const preview = await w.dryRun()
    assert.equal(preview.status, expectedStatus, label)
    assert.equal(preview.canApply, false, label)
    assert.equal(preview.dryRunToken, null, label)
    assert.equal(Object.prototype.hasOwnProperty.call(preview, 'refreshHold'), false, `${label}: no stanza`)
    assert.equal(w.env.snapshot(), before, `${label}: the five step-4 tables are byte-unchanged`)
    assert.deepEqual(await w.generation(), generation, `${label}: no bump`)
    await w.reconcile().catch(() => null)
    assert.equal(w.env.snapshot(), before, `${label}: the reconcile lane reconciles nothing either`)
    assert.equal(w.rows('continuation')[0].status, 'active', label)
    resetSource(w)
    w.source.state.data = F.secondPullSource()
    const complete = await w.dryRun()
    assert.equal(complete.status, 'ready', `${label}: the next complete read`)
    assert.equal(w.rows('continuation')[0].last_verdict, 'valid', label)
  }
  // A PILOT candidate shape over a soft-row-error read: `failed`, never `suspended` (no outcome), no stanza.
  const w = await world()
  await w.firstPullApplied()
  w.source.state.data = F.secondPullSource({ extraOrders: [{ part: 'GHOST-9', qty: 1 }] })
  const before = w.env.snapshot()
  const preview = await w.dryRun()
  assert.equal(preview.status, 'failed')
  assert.equal(Object.prototype.hasOwnProperty.call(preview, 'refreshHold'), false)
  assert.equal(w.env.snapshot(), before)
})

// ── SL-H8 (AMB-1, E-2(a)): pilot exit keeps the protection and the holds ──────────────────────────

test('SL-H8 (AMB-1, E-2(a)) pilot exit with an OPEN candidate hold: every later preview re-emits it (the SAME open row — opened 0, kept 1, superseded 0), the pull stays suspended with no token, and the apply is refused 409 with no write', async () => {
  const w = await world()
  await w.firstPullApplied()
  w.source.state.data = F.secondPullSource()
  assert.equal((await w.dryRun()).status, 'suspended')
  const opened = w.rows('hold').filter((row) => row.status === 'open')
  assert.equal(opened.length, 1)
  await w.clearPilot()
  const consult = await w.consult()
  assert.equal(consult.pilot.enabled, false)
  assert.equal(consult.governed, true, 'the rows still govern (C10)')
  for (let round = 1; round <= 2; round += 1) {
    const holdRowsBefore = w.rows('hold').length
    const preview = await w.dryRun()
    assert.equal(preview.status, 'suspended', `round ${round}`)
    assert.equal(preview.dryRunToken, null)
    const open = w.rows('hold').filter((row) => row.status === 'open')
    assert.deepEqual(open.map((row) => row.id), opened.map((row) => row.id), `round ${round}: the same open row (kept)`)
    assert.equal(open[0].fingerprint, opened[0].fingerprint)
    assert.equal(w.rows('hold').length, holdRowsBefore, `round ${round}: opened 0`)
    assert.equal(w.rows('hold').filter((row) => row.status === 'superseded').length, 0, `round ${round}: superseded 0`)
  }
  const forged = await tableActions.__internals.createDryRunToken(w.tokenStore, {
    actionId: 'plm.stock-preparation.pull-bom.v1', parametersHash: tableActions.__internals.hashJson({ projectNo: PROJECT }), revision: 'forged', conflictPolicyReview: null, ...writeBindingFromGeneration(await w.generation()),
  })
  const writes = w.sheet.writes()
  await expectCode(w.apply(forged), { status: 409, code: 'STOCK_PREP_PULL_SUSPENDED' })
  assert.equal(w.sheet.writes(), writes)
})

// ── SL-S7 (O-15, R-6): an escalated relationship ─────────────────────────────────────────────────

test('SL-S7 (O-15, R-6) an ESCALATED relationship (confirm -> reconcile a reconfirm hold with a verdict -> end escalate_special_repair), pilot cleared: two previews are suspended with no token, exactly one open runbook-only hold row with its STORED fingerprint (opened 0 / kept 1), and the apply is refused 409 with no write', async () => {
  const w = await world()
  await confirmedAndExecuted(w)
  const continuationId = w.rows('continuation')[0].id
  const reconfirm = refreshKit.reconfirmHoldFor(continuationId)
  await w.env.seedHolds(SCOPE, [reconfirm], { verdicts: { [continuationId]: 'source_scope_changed' } })
  await w.env.store.endContinuation({ ...SCOPE, continuationId, revision: 1, outcome: 'escalate_special_repair', endedBy: 'u_sl_puller' }, { bumpWithin: w.env.bump.bumpWithin })
  await w.clearPilot()
  const runbook = w.rows('hold').filter((row) => row.status === 'open')
  assert.equal(runbook.length, 1)
  assert.equal(runbook[0].runbook_only, true)
  assert.equal(runbook[0].fingerprint, reconfirm.fingerprint, 'the escalate kept the fingerprint')
  for (let round = 1; round <= 2; round += 1) {
    const holdRows = w.rows('hold').length
    const preview = await w.dryRun()
    assert.equal(preview.status, 'suspended', `round ${round}`)
    assert.equal(preview.dryRunToken, null)
    const open = w.rows('hold').filter((row) => row.status === 'open')
    assert.equal(open.length, 1, `round ${round}: exactly one open hold row`)
    assert.equal(open[0].id, runbook[0].id)
    assert.equal(open[0].fingerprint, reconfirm.fingerprint, `round ${round}: the stored fingerprint, unchanged`)
    assert.equal(w.rows('hold').length, holdRows, `round ${round}: opened 0`)
  }
  const forged = await tableActions.__internals.createDryRunToken(w.tokenStore, {
    actionId: 'plm.stock-preparation.pull-bom.v1', parametersHash: tableActions.__internals.hashJson({ projectNo: PROJECT }), revision: 'forged', conflictPolicyReview: null, ...writeBindingFromGeneration(await w.generation()),
  })
  const writes = w.sheet.writes()
  await expectCode(w.apply(forged), { status: 409, code: 'STOCK_PREP_PULL_SUSPENDED' })
  assert.equal(w.sheet.writes(), writes)
})

// ── SL-S8 (O-22): a lane holding its own lease checks earlier failed executions itself ───────────

test('SL-S8 (O-22) an earlier FAILED execution, or a RUNNING one of another lease, refuses the apply 409 STOCK_PREP_REFRESH_RECOVERY_PENDING from the consult\'s ROWS — although the in-lease consult derives `executing` (its own live lease) — before any execution is begun or row written', async () => {
  for (const status of ['failed', 'partial', 'aborted', 'running']) {
    const w = await world()
    await w.firstPullApplied()
    const token = (await w.dryRun()).dryRunToken
    assert.ok(token, `${status}: TD-8 the preview still mints`)
    await w.env.seedExecution(SCOPE, { status })
    const consults = []
    const spying = w.handle({
      resolveServices: () => ({
        governance: { consult: async (input) => { const answer = await w.env.governance.consult(input); consults.push(answer); return answer } },
        store: w.env.store,
      }),
    })
    const executions = w.rows('execution').length
    const writes = w.sheet.writes()
    const refused = await expectCode(w.apply(token, { refreshGovernance: spying }), { status: 409, code: 'STOCK_PREP_REFRESH_RECOVERY_PENDING' })
    assert.deepEqual(refused.details, { state: 'failed_pending_recovery', openExecutions: 1, partial: false }, status)
    assert.equal(w.rows('execution').length, executions, `${status}: no execution begun`)
    assert.equal(w.sheet.writes(), writes)
    assert.equal(consults.length, 1)
    assert.equal(readProjectRefreshState(consults[0]).status, 'executing', `${status}: the derived state is masked by the own lease — hence the rows`)
  }
})

// ── SL-S9: the refresh binding ───────────────────────────────────────────────────────────────────

test('SL-S9 the token\'s refreshBinding: a moved continuation revision => 409 BINDING_STALE binding_moved; a governed apply with a binding-less token => binding_absent; a not-governed token carries none, and a not-governed apply refuses one that does (unexpected_binding)', async () => {
  const w = await world()
  await confirmedAndExecuted(w)
  const preview = await w.dryRun()
  assert.equal(preview.status, 'ready')
  const key = `integration:table-action:dry-run-token:${preview.dryRunToken}`
  const record = w.tokenStore.map.get(key)
  assert.deepEqual(record.refreshBinding.continuations, [{ id: w.rows('continuation')[0].id, revision: 1 }])
  assert.equal(record.refreshBinding.changePlanId, null)
  w.tokenStore.map.set(key, { ...record, refreshBinding: { ...record.refreshBinding, continuations: [{ id: w.rows('continuation')[0].id, revision: 2 }] } })
  await expectCode(w.apply(preview.dryRunToken), { status: 409, code: 'STOCK_PREP_REFRESH_BINDING_STALE', reason: 'binding_moved' })
  const second = await w.dryRun()
  const secondKey = `integration:table-action:dry-run-token:${second.dryRunToken}`
  const { refreshBinding: dropped, ...withoutBinding } = w.tokenStore.map.get(secondKey)
  assert.ok(dropped)
  w.tokenStore.map.set(secondKey, withoutBinding)
  await expectCode(w.apply(second.dryRunToken), { status: 409, code: 'STOCK_PREP_REFRESH_BINDING_STALE', reason: 'binding_absent' })
  // Not governed.
  const plain = await world({ pilot: false, registered: false })
  const plainPreview = await plain.dryRun()
  const plainKey = `integration:table-action:dry-run-token:${plainPreview.dryRunToken}`
  assert.equal(Object.prototype.hasOwnProperty.call(plain.tokenStore.map.get(plainKey), 'refreshBinding'), false)
  plain.tokenStore.map.set(plainKey, { ...plain.tokenStore.map.get(plainKey), refreshBinding: { continuations: [], changePlanId: null, holdSetFingerprint: null } })
  await expectCode(plain.apply(plainPreview.dryRunToken), { status: 409, code: 'STOCK_PREP_REFRESH_BINDING_STALE', reason: 'unexpected_binding' })
  assert.equal(plain.env.stepFourRowCount(), 0)
})

// ── the execution ledger (P3-X1..X6, T1; TD-9, TD-30) ───────────────────────────────────────────

// A handle whose store and consult calls are recorded in one ordered log (the sheet's writes join it).
function recordingHandle(w, log, { consultTransform, finishFault } = {}) {
  return w.handle({
    resolveServices: () => ({
      governance: {
        consult: async (input) => {
          log.push(['consult'])
          const answer = await w.env.governance.consult(input)
          return consultTransform ? consultTransform(answer) : answer
        },
      },
      store: {
        reconcileHolds: async (input) => { log.push(['reconcileHolds', { tenantId: input.tenantId, sheetId: input.sheetId, projectNo: input.projectNo }]); return w.env.store.reconcileHolds(input) },
        beginExecution: async (input) => { log.push(['beginExecution', input]); return w.env.store.beginExecution(input) },
        finishExecution: async (input) => {
          log.push(['finishExecution', input])
          if (finishFault) throw finishFault
          return w.env.store.finishExecution(input)
        },
      },
    }),
  })
}

test('SL-X1/X2/H1/G3 the governed apply\'s ORDER: consult -> reconcileHolds -> beginExecution -> the writes -> finishExecution; begin carries the lease grant (lease id via the host fence, epoch, generation, token), the run id and the principal; every store write\'s scope is the consult\'s', async () => {
  const w = await world()
  const preview = await w.dryRun()
  const log = []
  const create = w.sheet.api.createRecord
  const fences = []
  w.sheet.api.createRecord = async (input) => { log.push(['write']); fences.push(input.writeFence); return create(input) }
  const generation = await w.generation()
  await w.apply(preview.dryRunToken, { refreshGovernance: recordingHandle(w, log), startedBy: 'u_sl_starter', projectWriteRunId: 'run_sl_apply' })
  const order = log.map(([op]) => op).filter((op, index, list) => op !== 'write' || list[index - 1] !== 'write')
  assert.deepEqual(order, ['consult', 'reconcileHolds', 'beginExecution', 'write', 'finishExecution'])
  const begin = log.find(([op]) => op === 'beginExecution')[1]
  assert.equal(begin.guard.leaseRunId, 'run_sl_apply')
  assert.equal(begin.guard.leaseId, fences[0].leaseId, 'the lease id reaches the ledger only through the host fence')
  assert.equal(begin.guard.fencingEpoch, fences[0].fencingEpoch)
  assert.equal(begin.guard.generationToken, generation.generationToken)
  assert.equal(begin.guard.generation, generation.generation)
  assert.equal(begin.startedBy, 'u_sl_starter')
  assert.equal(begin.lane, 'small_apply')
  assert.ok(/^[0-9a-f]{64}$/.test(begin.planDigest))
  for (const [op, input] of log.filter(([op]) => ['reconcileHolds', 'beginExecution', 'finishExecution'].includes(op))) {
    assert.deepEqual({ tenantId: input.tenantId, sheetId: input.sheetId, projectNo: input.projectNo }, SCOPE, `${op}: the consult's scope`)
  }
  const execution = w.rows('execution')[0]
  assert.equal(execution.status, 'succeeded')
  assert.equal(execution.lease_id, fences[0].leaseId)
})

test('SL-X5/X6/T1 a written execution derives executed_pending_settlement; the next clean preview settles NAMING it (complete); a zero-write apply settles itself in its finish (complete), and the loop stays complete; a pilot project without a state row settles without state_row_absent', async () => {
  const w = await world()
  await w.firstPullApplied()
  const written = w.rows('execution')[0]
  assert.equal(written.status, 'succeeded')
  assert.equal(written.written, 4)
  assert.equal((await w.derived()).status, 'executed_pending_settlement')
  const settling = await w.dryRun()
  assert.equal(settling.status, 'ready')
  assert.equal(w.rows('state')[0].settled_execution_id, written.id, 'T1: the settlement names the newest succeeded execution')
  // T2 (review round 1, M-18): the stored machine digest is the one an INDEPENDENT recompute gives over the rows
  // as the project-scoped reader returns them (record refs attached) and the machine band of the template.
  const normalized = tableActions.assertStockPreparationTargetReady(w.action)
  const asRead = await tableActions.__internals.readExistingStockPreparationRows(w.sheet.api, normalized.target, PROJECT)
  const independent = pairing.sheetMachineDigest(asRead, { machineFieldIds: pairing.machineBandFieldIds({ template: normalized.template, installedFieldProperties: undefined }) })
  assert.equal(w.rows('state')[0].settled_sheet_machine_digest, independent, 'T2: the settled digest equals an independent recompute')
  assert.equal((await w.derived()).status, 'complete')
  for (let round = 1; round <= 2; round += 1) {
    const preview = await w.dryRun()
    const applied = await w.apply(preview.dryRunToken)
    assert.equal(applied.apply.written, 0)
    const newest = w.rows('execution').sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0]
    assert.equal(w.rows('state')[0].settled_execution_id, newest.id, `round ${round}: self-settled by its own id`)
    assert.equal((await w.derived()).status, 'complete', `round ${round}`)
  }
  // X6: the very first apply of a pilot project (no state row before its reconcile) settles cleanly when zero-write.
  const fresh = await world()
  fresh.sheet.rows.push(...w.sheet.rows.map((row) => clone(row)))
  assert.equal(fresh.rows('state').length, 0)
  const freshPreview = await fresh.dryRun()
  const freshApplied = await fresh.apply(freshPreview.dryRunToken)
  assert.equal(freshApplied.apply.written, 0)
  assert.equal((await fresh.derived()).status, 'complete')
})

test('SL-X3 every outcome finishes the execution (TD-9): held-only / partial-with-held => succeeded (executed_pending_settlement, no settlement while manual_confirm > 0), partial with failures => partial, all failed => failed, a fenced stop => aborted + abortCode (and the abort error), a writer throw after begin => failed (h), a scoped-API construction throw => NO execution row (g)', async () => {
  // held: a duplicate group the operator acknowledges (manual_confirm held), the other rows written.
  const held = await world()
  held.source.state.data = F.project({ orders: [{ part: 'S-001', qty: 10 }], parts: F.PARTS.slice(), boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }, { part: 'PART-B', usage: 9 }], 'PART-A': [{ part: 'PART-C', usage: 4 }] } })
  const heldPreview = await held.dryRun()
  assert.equal(heldPreview.status, 'manual_confirm_required')
  const heldApplied = await held.apply(heldPreview.dryRunToken, { acceptManualConfirmHold: true })
  assert.ok(['partial', 'held'].includes(heldApplied.status), heldApplied.status)
  assert.ok(heldApplied.apply.counts.held > 0)
  assert.equal(held.rows('execution')[0].status, 'succeeded', 'held rows are not a failure (TD-9)')
  assert.equal(held.rows('state')[0].settled_execution_id, null, 'no settlement while manual_confirm > 0')
  assert.equal((await held.derived()).status, 'executed_pending_settlement')
  // partial (one create fails) / failed (every create fails).
  for (const [failCreates, expected] of [[1, 'partial'], [4, 'failed']]) {
    const w = await world()
    const preview = await w.dryRun()
    w.sheet.failCreates = failCreates
    const applied = await w.apply(preview.dryRunToken)
    assert.equal(applied.status, expected)
    const execution = w.rows('execution')[0]
    assert.equal(execution.status, expected)
    assert.ok(Array.isArray(execution.error_codes) && execution.error_codes.length > 0)
    assert.equal((await w.derived()).status, 'failed_pending_recovery')
  }
  // aborted: the holder CAS before the second write fails (the lease is lost mid-run).
  const aborted = await world()
  const abortedPreview = await aborted.dryRun()
  let holderCas = 0
  aborted.harness.db.faults.updateRow = (args) => {
    if (args.set && Object.prototype.hasOwnProperty.call(args.set, 'lease_seq') && !Object.prototype.hasOwnProperty.call(args.set, 'lease_id')) {
      holderCas += 1
      if (holderCas === 2) return new Error('connection lost')
    }
    return null
  }
  const abortError = await expectCode(aborted.apply(abortedPreview.dryRunToken), {})
  aborted.harness.db.faults.updateRow = undefined
  assert.equal(abortError.details.partial, true)
  const abortedRow = aborted.rows('execution')[0]
  assert.equal(abortedRow.status, 'aborted')
  assert.ok(typeof abortedRow.abort_code === 'string' && abortedRow.abort_code.length > 0)
  // (h) a fault after begin, before the first write: the writer refuses (a stale verdict) => the row is failed, 0 writes.
  const stale = await world()
  const stalePreview = await stale.dryRun()
  const log = []
  const forgedVerdict = recordingHandle(stale, log, {
    consultTransform: (answer) => Object.freeze({ ...answer, lock: Object.freeze({ ...answer.lock, generation: Object.freeze({ ...answer.lock.generation, generationToken: 'tok-sl-forged' }) }) }),
  })
  await expectCode(stale.apply(stalePreview.dryRunToken, { refreshGovernance: forgedVerdict }), { status: 501, code: 'STOCK_PREP_REFRESH_GOVERNANCE_UNCONSULTED', reason: 'governance_stale' })
  assert.equal(stale.sheet.writes(), 0)
  const staleRow = stale.rows('execution')[0]
  assert.equal(staleRow.status, 'failed', 'the try region starts right after begin')
  assert.deepEqual(staleRow.error_codes, ['STOCK_PREP_REFRESH_GOVERNANCE_UNCONSULTED'])
  // (g) the scoped records API cannot be built: no execution row at all (TD-30: built before begin).
  const unbuildable = await world()
  const unbuildablePreview = await unbuildable.dryRun()
  const trap = new Proxy(unbuildable.sheet.api, {
    get(target, key, receiver) {
      if (key === 'createRecord') throw Object.assign(new Error('synthetic records surface failure'), { code: 'SYN_SCOPED_API' })
      return Reflect.get(target, key, receiver)
    },
  })
  await expectCode(unbuildable.apply(unbuildablePreview.dryRunToken, { recordsApi: trap }), { code: 'SYN_SCOPED_API' })
  assert.equal(unbuildable.rows('execution').length, 0, 'no running row was begun')
})

test('SL-X4 a finish that FAILS after the writes is never a success: a typed error (the store\'s 503) whose details say partial:true with the write counts; the row stays running (derives failed_pending_recovery after release)', async () => {
  const w = await world()
  const preview = await w.dryRun()
  const fault = Object.assign(new Error('synthetic finish failure'), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED', details: { operation: 'execution_finish', partial: false } })
  const refused = await expectCode(w.apply(preview.dryRunToken, { refreshGovernance: recordingHandle(w, [], { finishFault: fault }) }), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
  assert.equal(refused.details.partial, true)
  assert.equal(refused.details.written, 4)
  assert.equal(refused.details.attemptedWrites, 4)
  assert.equal(w.rows('execution')[0].status, 'running')
  assert.equal((await w.derived()).status, 'failed_pending_recovery')
})

// ── the consult before any source read (P3-G1 / G2), the planner input (G8 / G9) ──────────────────

test('SL-G1 an unreadable step-4 store or lock is 503 on dry-run, reconcile, mvp-persist and apply BEFORE any source read (and, for the planning lanes, any records read): no token, no bump, the apply token burned; a not-governed project too', async () => {
  for (const governed of [true, false]) {
    const w = await world({ pilot: governed, registered: governed })
    const preview = await w.dryRun()
    const token = preview.dryRunToken
    const generation = await w.generation()
    const faultStepFour = () => { w.env.db.faults.select = (args) => (args && Object.values(T).includes(args.table) ? refreshKit.sqlError('42P01', 'relation does not exist') : null) }
    faultStepFour()
    for (const [lane, call] of [['dry-run', () => w.dryRun()], ['reconcile', () => w.reconcile()], ['mvp-persist', () => w.mvp()], ['apply', () => w.apply(token)]]) {
      const sourceReads = w.source.state.calls.length
      const recordsReads = w.sheet.calls.length
      const refused = await expectCode(call(), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
      assert.equal(refused.details.partial, false, lane)
      assert.equal(w.source.state.calls.length, sourceReads, `${lane}: zero source reads (governed=${governed})`)
      if (lane !== 'apply') assert.equal(w.sheet.calls.length, recordsReads, `${lane}: zero records reads`)
    }
    w.env.db.faults.select = undefined
    const after = await w.generation()
    assert.deepEqual([after.generation, after.generationToken], [generation.generation, generation.generationToken], 'no bump (the apply\'s own acquire moves only the epoch)')
    assert.equal(await w.tokenRecord(token), null, 'the apply token is burned (I4)')
    // The lock's own read failing is unreadable too.
    w.harness.db.faults.selectOne = refreshKit.sqlError('08006', 'connection failure')
    const lockRefused = await expectCode(w.dryRun(), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
    assert.equal(lockRefused.details.store, 'lock')
  }
})

test('SL-G2 an unwired service or a malformed handle refuses 501 by name at consult time, before any source read', async () => {
  const w = await world()
  const unwired = w.handle({ resolveServices: () => { throw Object.assign(new Error('not wired'), { status: 501, code: 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE', details: { reason: 'governance_service' } }) } })
  await expectCode(w.dryRun({ refreshGovernance: unwired }), { status: 501, code: 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE', reason: 'governance_service' })
  const { planningInputs, ...withoutPlanningInputs } = w.handle()
  assert.equal(typeof planningInputs, 'function')
  await expectCode(w.dryRun({ refreshGovernance: Object.freeze(withoutPlanningInputs) }), { status: 501, code: 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE', reason: 'governance_handle' })
  await expectCode(w.dryRun({ refreshGovernance: { ...w.handle() } }), { status: 501, reason: 'governance_handle' })
  await expectCode(w.dryRun({ refreshGovernance: null }), { status: 501, reason: 'governance_handle' })
  assert.equal(w.source.state.calls.length, 0)
})

test('SL-G8 the planner input: a governed project hands BOTH planner calls exactly the 9 keys (O-16 + persistedHolds, no changePlan) and the expander the recorder options; a not-governed project hands neither key', async () => {
  const w = await world()
  await w.firstPullApplied()
  w.source.state.data = F.secondPullSource()
  plannerInputs.length = 0
  expanderInputs.length = 0
  await w.dryRun()
  assert.ok(plannerInputs.length >= 1)
  for (const input of plannerInputs) {
    assert.deepEqual(Object.keys(input.continuation).sort(), ['continuations', 'demandEvidence', 'members', 'persistedHolds', 'pilot', 'projectNo', 'sourceIdentity', 'specSlotDeclared', 'storeState'])
    assert.equal(input.continuation.pilot, true)
    assert.equal(input.continuation.storeState, 'ok')
    assert.ok(Array.isArray(input.continuation.persistedHolds))
  }
  assert.equal(expanderInputs[expanderInputs.length - 1].demandEvidence, true, 'the recorder options (never its output)')
  assert.notEqual(plannerInputs[0].continuation.demandEvidence, true, 'the planner gets the recorder OUTPUT')
  const plain = await world({ pilot: false, registered: false })
  plannerInputs.length = 0
  expanderInputs.length = 0
  await plain.dryRun()
  assert.ok(plannerInputs.every((input) => !Object.prototype.hasOwnProperty.call(input, 'continuation')))
  assert.ok(expanderInputs.every((input) => !Object.prototype.hasOwnProperty.call(input, 'demandEvidence')))
})

test('SL-G9 a straddling consult (a header whose members disagree, memberCount 0) maps to a retryable 409 STOCK_PREP_PULL_STATE_MOVED projection_inconsistent with no write and no token; any other planner input defect stays a 500', async () => {
  const w = await world()
  await confirmedAndExecuted(w)
  const tamper = (mutate) => recordingHandle(w, [], {
    consultTransform: (answer) => Object.freeze({ ...answer, continuations: Object.freeze(answer.continuations.map((entry) => Object.freeze(mutate({ ...entry })))) }),
  })
  const before = w.env.snapshot()
  for (const mutate of [(entry) => ({ ...entry, memberCount: entry.memberCount + 1 }), (entry) => ({ ...entry, memberCount: 0 })]) {
    const refused = await expectCode(w.dryRun({ refreshGovernance: tamper(mutate) }), { status: 409, code: 'STOCK_PREP_PULL_STATE_MOVED', reason: 'projection_inconsistent' })
    assert.equal(refused.details.partial, false)
  }
  const defect = await expectCode(w.dryRun({ refreshGovernance: tamper((entry) => ({ ...entry, comparisonFingerprint: '' })) }), { status: 500, code: 'STOCK_PREP_CONTINUATION_INPUT_INVALID' })
  assert.equal(defect.details.field, 'continuation.continuations.comparisonFingerprint')
  assert.equal(w.env.snapshot(), before, 'nothing reconciled')
})

// ── R-1 (TD-21): a governed project needs ONE agreeing source binding ─────────────────────────────

test('SL-SB1..SB4 (R-1) a governed project whose (tenant, action) bindings DISAGREE is refused 409 SOURCE_BINDING_SPLIT on dry-run, apply, reconcile and mvp-persist before any source read (no reconcile, the relationship stays active); an incomplete listing is bindings_unverifiable; a listing that throws is 503 source_binding; a not-governed project is never listed', async () => {
  const bindings = wiring.createSourceBindingStoreFake()
  const w = await world({ sourceBindingStore: bindings })
  await confirmedAndExecuted(w)
  const token = (await w.dryRun()).dryRunToken
  bindings.seed({ tenantId: TENANT, actionId: 'plm.stock-preparation.pull-bom.v1', workspaceId: null, externalSystemId: 'plm_sl_other' })
  bindings.seed({ tenantId: TENANT, actionId: 'plm.stock-preparation.pull-bom.v1', workspaceId: 'ws_sl_1', externalSystemId: 'plm_sl_fixture' })
  const before = w.env.snapshot()
  for (const [lane, call] of [['dry-run', () => w.dryRun()], ['reconcile', () => w.reconcile()], ['mvp-persist', () => w.mvp()], ['apply', () => w.apply(token)]]) {
    const reads = w.source.state.calls.length
    const refused = await expectCode(call(), { status: 409, code: 'STOCK_PREP_REFRESH_SOURCE_BINDING_SPLIT', reason: 'bindings_disagree' })
    assert.equal(refused.details.partial, false)
    assert.equal(w.source.state.calls.length, reads, `${lane}: no source read`)
  }
  assert.equal(w.env.snapshot(), before, 'no reconcile')
  assert.equal(w.rows('continuation')[0].status, 'active')
  bindings.rows.length = 0
  bindings.setIncomplete(true)
  await expectCode(w.dryRun(), { status: 409, code: 'STOCK_PREP_REFRESH_SOURCE_BINDING_SPLIT', reason: 'bindings_unverifiable' })
  bindings.setIncomplete(false)
  bindings.fail(Object.assign(new Error('synthetic listing failure'), { code: '57P01' }))
  const failed = await expectCode(w.dryRun(), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
  assert.deepEqual(failed.details, { store: 'source_binding', operation: 'list_for_action', sqlState: '57P01', partial: false })
  bindings.clearFault()
  // Unanimous again: the lanes proceed.
  bindings.seed({ tenantId: TENANT, actionId: 'plm.stock-preparation.pull-bom.v1', workspaceId: null, externalSystemId: 'plm_sl_fixture' })
  assert.equal((await w.dryRun()).status, 'ready')
  // SB4: a not-governed project with the same split is never listed (no extra IO).
  const plainBindings = wiring.createSourceBindingStoreFake()
  plainBindings.seed({ tenantId: TENANT, actionId: 'plm.stock-preparation.pull-bom.v1', workspaceId: null, externalSystemId: 'plm_sl_other' })
  const plain = await world({ pilot: false, registered: false, sourceBindingStore: plainBindings })
  assert.equal((await plain.dryRun()).status, 'ready')
  assert.equal(plainBindings.calls.filter(([op]) => op === 'listForAction').length, 0)
})

// ── R-2 (TD-22): a governed computation plans with the STRICT pack band ─────────────────────────

function packProvisioning(fields, { fail = null } = {}) {
  return {
    calls: [],
    async readObjectFieldsContent({ fieldIds }) {
      this.calls.push(fieldIds.slice())
      if (fail) throw fail
      const out = {}
      for (const fieldId of fieldIds) if (fields[fieldId]) out[fieldId] = fields[fieldId]
      return out
    },
  }
}

const PACK_FIELDS = Object.freeze({ ext_legacyRowId: { name: 'ext_legacyRowId', type: 'string', property: { stockPreparation: { ownership: 'plm_system' } }, order: 0 } })

test('SL-PK1..PK5 (R-2) a governed computation reads the pack band STRICTLY: a ledger fault is 503 ledger_read, a field fault 503 field_read, an unreadable host 501 pack_field_read — each before any source read, nothing reconciled; a not-governed project never asks; the governed plan uses the strict band, never the eager one the caller passed', async () => {
  const ledger = wiring.createPackInstallStoreFake()
  const projectScope = { tenantId: TENANT, projectId: `${TENANT}:integration-core`, objectId: 'stockPreparationMain' }
  ledger.setFieldIds(projectScope, ['ext_legacyRowId'])
  const provisioning = packProvisioning(PACK_FIELDS)
  const w = await world({ packInstallStore: ledger, provisioning })
  await w.firstPullApplied()
  const before = w.env.snapshot()
  ledger.fail(Object.assign(new Error('synthetic ledger failure'), { code: '42501' }))
  const reads = w.source.state.calls.length
  const ledgerRefused = await expectCode(w.dryRun(), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
  assert.deepEqual(ledgerRefused.details, { store: 'pack_installed_fields', operation: 'ledger_read', sqlState: '42501', partial: false })
  ledger.clearFault()
  const fieldFault = packProvisioning(PACK_FIELDS, { fail: Object.assign(new Error('synthetic field failure'), { code: '08006' }) })
  const fieldRefused = await expectCode(w.dryRun({ refreshGovernance: w.handle({ provisioning: fieldFault }) }), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
  assert.equal(fieldRefused.details.operation, 'field_read')
  await expectCode(w.dryRun({ refreshGovernance: w.handle({ provisioning: null }) }), { status: 501, code: 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE', reason: 'pack_field_read' })
  assert.equal(w.source.state.calls.length, reads, 'no source read on any refusal')
  assert.equal(w.env.snapshot(), before, 'nothing reconciled')
  // PK5: the governed plan, its settlement and the writer use the STRICT band — the eager value is ignored.
  plannerInputs.length = 0
  const eager = [{ fieldId: 'ext_eagerOnly', property: { stockPreparation: { ownership: 'plm_system' } } }]
  await w.dryRun({ installedFieldProperties: eager })
  assert.ok(plannerInputs.length > 0)
  for (const input of plannerInputs) assert.deepEqual(input.installedFieldProperties, [{ fieldId: 'ext_legacyRowId', property: PACK_FIELDS.ext_legacyRowId.property }])
  // PK4: not governed — the strict reader is never asked, whatever the ledger does.
  const plainLedger = wiring.createPackInstallStoreFake()
  plainLedger.fail(new Error('synthetic ledger failure'))
  const plain = await world({ pilot: false, registered: false, packInstallStore: plainLedger, provisioning })
  assert.equal((await plain.dryRun()).status, 'ready')
  assert.equal(plainLedger.calls.length, 0)
})

// ── M-1 / S6(2): mvp-persist ─────────────────────────────────────────────────────────────────────

test('SL-M1 governed mvp-persist plans with the SAME strict band, mapping and continuation input as the dry-run (its relationship verifies the same way), and refuses a suspended pull 409 NOT_READY refresh_suspended with nothing archived', async () => {
  const ledger = wiring.createPackInstallStoreFake()
  ledger.setFieldIds({ tenantId: TENANT, projectId: `${TENANT}:integration-core`, objectId: 'stockPreparationMain' }, ['ext_legacyRowId'])
  const w = await world({ packInstallStore: ledger, provisioning: packProvisioning(PACK_FIELDS) })
  await confirmedAndExecuted(w)
  plannerInputs.length = 0
  await w.dryRun()
  const dryRunInputs = plannerInputs.slice()
  plannerInputs.length = 0
  const archived = await w.mvp()
  assert.ok(archived.archiveRevision)
  const mvpInputs = plannerInputs.slice()
  assert.deepEqual(mvpInputs[0].installedFieldProperties, dryRunInputs[0].installedFieldProperties)
  assert.deepEqual(JSON.parse(JSON.stringify(mvpInputs[0].continuation)), JSON.parse(JSON.stringify(dryRunInputs[0].continuation)))
  assert.equal(w.rows('continuation')[0].last_verdict, 'valid')
  // A suspended governed pull is never archived.
  const suspended = await world()
  await suspended.firstPullApplied()
  suspended.source.state.data = F.secondPullSource()
  await suspended.dryRun()
  await expectCode(suspended.mvp(), { status: 409, code: 'STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY', reason: 'refresh_suspended' })
})

// ── SL-RF: the hold reconciliation FAILS (review round 1, lens B V50B-08 / M-11; H6, E09) ──────────────

test('SL-RF1 the preview\'s hold reconciliation FAILS (the hold insert answers 42501): 503 STORE_FAILED hold_open — no token, no bump, every step-4 row byte-identical (the transaction rolled back); the apply over the same plan is refused 503 the same way before any execution is begun or row written — a reconcile error is never swallowed into a clean answer', async () => {
  const w = await world()
  await w.firstPullApplied()
  w.source.state.data = F.secondPullSource()
  const before = w.env.snapshot()
  const generation = await w.generation()
  const tokens = w.tokenStore.map.size
  const executions = w.rows('execution').length
  const writes = w.sheet.writes()
  w.env.db.faults.insertOne = (args) => (args && args.table === T.hold ? refreshKit.sqlError('42501', 'permission denied for the synthetic hold table') : null)
  try {
    const refused = await expectCode(w.dryRun(), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
    assert.equal(refused.details.operation, 'hold_open')
    assert.equal(refused.details.sqlState, '42501')
    assert.equal(w.tokenStore.map.size, tokens, 'no token')
    const after = await w.generation()
    assert.deepEqual([after.generation, after.generationToken], [generation.generation, generation.generationToken], 'no bump')
    assert.equal(w.env.snapshot(), before, 'the reconcile transaction left nothing behind')
    const forged = await tableActions.__internals.createDryRunToken(w.tokenStore, {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      parametersHash: tableActions.__internals.hashJson({ projectNo: PROJECT }),
      revision: 'rev_sl_rf1_forged',
      conflictPolicyReview: null,
      ...writeBindingFromGeneration(after),
    })
    const applyRefused = await expectCode(w.apply(forged), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
    assert.equal(applyRefused.details.operation, 'hold_open')
    assert.equal(w.rows('execution').length, executions, 'no execution begun')
    assert.equal(w.sheet.writes(), writes, 'no row written')
    assert.equal(w.env.snapshot(), before)
  } finally {
    delete w.env.db.faults.insertOne
  }
})

test('SL-RF2 (H4) the store answers the preview\'s reconcile 409 STATE_MOVED hold_race (a concurrent computation opened the same hold first — a unique violation on the hold insert): the preview PROPAGATES the retryable 409 — never translated to 503, never swallowed — no token, no bump, nothing persisted', async () => {
  const w = await world()
  await w.firstPullApplied()
  w.source.state.data = F.secondPullSource()
  const before = w.env.snapshot()
  const generation = await w.generation()
  const tokens = w.tokenStore.map.size
  w.env.db.faults.insertOne = (args) => (args && args.table === T.hold ? refreshKit.sqlError('23505', 'duplicate key value violates the synthetic open-hold unique index') : null)
  try {
    const refused = await expectCode(w.dryRun(), { status: 409, code: 'STOCK_PREP_PULL_STATE_MOVED', reason: 'hold_race' })
    assert.equal(refused.details.partial === undefined || refused.details.partial === false, true)
    assert.equal(w.tokenStore.map.size, tokens)
    const after = await w.generation()
    assert.deepEqual([after.generation, after.generationToken], [generation.generation, generation.generationToken])
    assert.equal(w.env.snapshot(), before)
  } finally {
    delete w.env.db.faults.insertOne
  }
})

// ── SL-A12: a person's fill never revokes a confirmed relationship (E-4) ─────────────────────────────

test('SL-A12 (E-4 / A12) a PERSON\'s fill of a human column on an old row of a CONFIRMED relationship never revokes it: the re-preview stays ready, the continuation stays active with a valid verdict, the apply writes no human column and the filled value survives', async () => {
  const w = await world()
  await w.firstPullApplied()
  w.source.state.data = F.secondPullSource()
  assert.equal((await w.dryRun()).status, 'suspended')
  const confirmed = await w.confirmOpenCandidate()
  assert.equal((await w.dryRun()).status, 'ready', 'calibration: the confirmed relationship verifies')
  const root = w.sheet.rows.find((row) => row.data.componentSourceId === 'S-001' && JSON.parse(row.data.path).length === 1)
  assert.ok(root, 'the old S-001 root row')
  // The fill, as a host write would land it: the human cell set, the record version bumped.
  root.data.notes = 'synthetic human fill'
  root.version += 1
  const again = await w.dryRun()
  assert.equal(again.status, 'ready', 'the human fill does not revoke the relationship')
  const continuation = w.rows('continuation').find((row) => row.id === confirmed.continuationId)
  assert.equal(continuation.status, 'active')
  assert.equal(continuation.last_verdict, 'valid')
  const applied = await w.apply(again.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  assert.equal(w.sheet.rows.find((row) => row.id === root.id).data.notes, 'synthetic human fill', 'the apply writes no human column')
})

// ── SL-R: the preview of a project awaiting RECOVERY (review round 1, lens A note 2) ─────────────────

test('SL-R1 a governed project with an earlier FAILED / PARTIAL / ABORTED execution, or a RUNNING one whose lease is not live, PREVIEWS `recovery_pending` — canApply false, no token minted, no bump, the values-free stanza { pending, openExecutions } — read off the same rows the apply refuses on: an apply with a token forged at the current generation is 409 RECOVERY_PENDING', async () => {
  for (const status of ['failed', 'partial', 'aborted', 'running']) {
    const w = await world()
    await w.firstPullApplied()
    await w.env.seedExecution(SCOPE, { status })
    const generation = await w.generation()
    const tokensBefore = w.tokenStore.map.size
    const preview = await w.dryRun()
    assert.equal(preview.status, 'recovery_pending', status)
    assert.equal(preview.canApply, false, status)
    assert.equal(preview.dryRunToken, null, status)
    assert.equal(preview.evidence.canApply, false, `${status}: the evidence agrees`)
    assert.deepEqual({ ...preview.refreshRecovery }, { pending: true, openExecutions: 1 }, status)
    assert.equal(w.tokenStore.map.size, tokensBefore, `${status}: no token minted`)
    const after = await w.generation()
    assert.deepEqual([after.generation, after.generationToken], [generation.generation, generation.generationToken], `${status}: no bump`)
    const forged = await tableActions.__internals.createDryRunToken(w.tokenStore, {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      parametersHash: tableActions.__internals.hashJson({ projectNo: PROJECT }),
      revision: preview.revision,
      conflictPolicyReview: null,
      ...writeBindingFromGeneration(after),
    })
    await expectCode(w.apply(forged), { status: 409, code: 'STOCK_PREP_REFRESH_RECOVERY_PENDING' })
  }
})

test('SL-R2 the LIVE lease is exempt, exactly as the apply exempts its own: an execution `running` under the lease the consult sees live (an apply in flight) is not a failure — the preview proceeds as before and meets the bump\'s 409 WRITE_LOCKED (no token), never `recovery_pending`', async () => {
  const w = await world()
  await w.firstPullApplied()
  const grant = await w.harness.lock.acquire(w.scopeKey, { purpose: 'small_apply', runId: 'sl-r2-in-flight' })
  try {
    await w.env.seedExecution(SCOPE, { status: 'running', leaseId: grant.leaseId, leaseRunId: 'sl-r2-in-flight' })
    const consult = await w.consult()
    assert.equal(lanes.__internals.liveLeaseIdOf(consult), grant.leaseId, 'calibration: the consult sees the lease live')
    const refused = await expectCode(w.dryRun(), { status: 409 })
    assert.equal(refused.code, 'STOCK_PREP_PROJECT_WRITE_LOCKED', `the in-flight run's preview is refused by the bump, not recovery: ${refused.code}`)
    assert.equal(w.tokenStore.map.size, 0)
  } finally {
    await w.harness.lock.createGuard(grant).release()
  }
})

test('SL-R3 a preview awaiting recovery NEVER settles: an OLDER failed execution beside a NEWER succeeded one (the newest-execution rule alone would settle) — the clean preview answers `recovery_pending` and the state row keeps no settlement; the derived state reads failed_pending_recovery', async () => {
  const w = await world()
  await w.firstPullApplied()
  const newest = w.rows('execution').find((row) => row.status === 'succeeded')
  assert.ok(newest, 'calibration: the first pull recorded a succeeded execution')
  // An OLDER failed run (its started_at before the succeeded one's), seeded through the store's own clock.
  const now = w.env.clock.iso()
  w.env.clock.set(new Date(Date.parse(now) - 60 * 60 * 1000).toISOString())
  await w.env.seedExecution(SCOPE, { status: 'failed' })
  w.env.clock.set(now)
  const preview = await w.dryRun()
  assert.equal(preview.status, 'recovery_pending')
  assert.equal(preview.dryRunToken, null)
  const state = w.rows('state')[0]
  assert.ok(state, 'calibration: the state row exists')
  assert.equal(state.settled_execution_id, null, 'no settlement while an execution awaits recovery')
  assert.equal(state.settled_at, null)
  assert.equal((await w.derived()).status, 'failed_pending_recovery')
})

// ── SL-R4..R6: the preview's ONE re-consult (PR-3a follow-up, delta verification 2026-10-26) ─────────────────
// The consult reads the executions inside its snapshot and the lock AFTER it (refresh-governance.cjs header): a run
// that finished between the two looks like a dead `running` row. The preview re-consults once before it answers
// `recovery_pending` on such rows only.

// A handle whose consults and reconciliations are counted; `afterFirstConsult` runs once the FIRST consult has
// answered — what a run that finishes between the consult's snapshot and its lock read leaves behind.
// Step-4 review follow-ups (item 9): `secondConsult` scripts the RE-consult — `{ throws: error }` or `{ answer: value }`.
function recheckHandle(w, { afterFirstConsult, secondConsult } = {}) {
  const calls = { consult: 0, reconcileHolds: 0 }
  const handle = w.handle({
    resolveServices: () => ({
      governance: {
        consult: async (input) => {
          if (secondConsult && calls.consult === 1) {
            calls.consult += 1
            if (secondConsult.throws) throw secondConsult.throws
            return secondConsult.answer
          }
          const answer = await w.env.governance.consult(input)
          calls.consult += 1
          if (calls.consult === 1 && afterFirstConsult) await afterFirstConsult()
          return answer
        },
      },
      store: {
        reconcileHolds: async (input) => { calls.reconcileHolds += 1; return w.env.store.reconcileHolds(input) },
        beginExecution: (input) => w.env.store.beginExecution(input),
        finishExecution: (input) => w.env.store.finishExecution(input),
      },
    }),
  })
  return { handle, calls }
}

test('SL-R4 (follow-up) the answer rests ONLY on a lease-less `running` row and that run finishes cleanly before the preview consults again (the snapshot / lock-read straddle): ONE re-consult, then 409 STOCK_PREP_PULL_STATE_MOVED execution_finished_during_preview — nothing reconciled, no token, no bump, no write; the next preview is ready', async () => {
  const w = await world()
  await w.firstPullApplied()
  const execution = await w.env.seedExecution(SCOPE, { status: 'running' })
  const { handle, calls } = recheckHandle(w, {
    afterFirstConsult: () => w.env.store.finishExecution({ ...SCOPE, executionId: execution.id, status: 'succeeded', written: 0, attemptedWrites: 0 }),
  })
  const generation = await w.generation()
  const tokens = w.tokenStore.map.size
  const writes = w.sheet.writes()
  const refused = await expectCode(w.dryRun({ refreshGovernance: handle }), { status: 409, code: 'STOCK_PREP_PULL_STATE_MOVED', reason: 'execution_finished_during_preview' })
  assert.equal(refused.details.partial, false)
  assert.equal(calls.consult, 2, 'the planning consult and ONE re-consult')
  assert.equal(calls.reconcileHolds, 0, 'refused before the reconciliation')
  assert.equal(w.tokenStore.map.size, tokens, 'no token')
  const after = await w.generation()
  assert.deepEqual([after.generation, after.generationToken], [generation.generation, generation.generationToken], 'no bump')
  assert.equal(w.sheet.writes(), writes, 'no write')
  const next = await w.dryRun()
  assert.equal(next.status, 'ready', 'the next preview reads the finished run')
  assert.ok(next.dryRunToken)
})

test('SL-R5 (follow-up) the straddled run ends FAILED before the re-consult: the preview answers recovery_pending from the FRESH rows (one re-consult) — canApply false, no token, the counts-only stanza', async () => {
  const w = await world()
  await w.firstPullApplied()
  const execution = await w.env.seedExecution(SCOPE, { status: 'running' })
  const { handle, calls } = recheckHandle(w, {
    afterFirstConsult: () => w.env.store.finishExecution({ ...SCOPE, executionId: execution.id, status: 'failed', written: 0, attemptedWrites: 1 }),
  })
  const tokens = w.tokenStore.map.size
  const preview = await w.dryRun({ refreshGovernance: handle })
  assert.equal(preview.status, 'recovery_pending')
  assert.equal(preview.canApply, false)
  assert.equal(preview.dryRunToken, null)
  assert.deepEqual({ ...preview.refreshRecovery }, { pending: true, openExecutions: 1 })
  assert.equal(calls.consult, 2)
  assert.equal(w.tokenStore.map.size, tokens)
})

test('SL-R6 (follow-up) the re-consult happens ONLY when the answer rests on lease-less running rows: a FAILED row, alone or beside a running one => recovery_pending after ONE consult; a dead running row that stays running => recovery_pending after TWO', async () => {
  for (const [label, statuses, expectedConsults] of [['failed', ['failed'], 1], ['failed_and_running', ['failed', 'running'], 1], ['dead_running', ['running'], 2]]) {
    const w = await world()
    await w.firstPullApplied()
    for (const status of statuses) await w.env.seedExecution(SCOPE, { status, leaseId: `lease_sl_r6_${status}`, leaseRunId: `run_sl_r6_${status}` })
    const { handle, calls } = recheckHandle(w)
    const preview = await w.dryRun({ refreshGovernance: handle })
    assert.equal(preview.status, 'recovery_pending', label)
    assert.equal(preview.dryRunToken, null, label)
    assert.deepEqual({ ...preview.refreshRecovery }, { pending: true, openExecutions: statuses.length }, label)
    assert.equal(calls.consult, expectedConsults, `${label}: consults`)
  }
})

// Step-4 review follow-ups (item 9, design §23.8 F-17): THE RE-CONSULT FAILS CLOSED. A re-consult that throws, answers
// not-ok or answers nothing never reads as "no recovery": the preview refuses 503 before the reconciliation — no
// token, no bump, no write. And the recovery answer counts the FRESH rows, never the stale ones.
test('SL-R7 (follow-up) the preview\'s re-consult fails closed: (a) it throws 503 => that 503; (b) it answers not-ok / (c) nothing => 503 STORE_FAILED governance.consult — ONE re-consult, nothing reconciled, no token, no bump, no write; (d) the recovery counts the FRESH rows', async () => {
  const legs = [
    ['throws', { throws: new lanes.StockPreparationRefreshLaneError(503, 'STOCK_PREP_REFRESH_STORE_FAILED', 'store failed', { store: 'continuation', operation: 'read_holds', partial: false }) }, { store: 'continuation', operation: 'read_holds' }],
    ['not_ok', { answer: { ok: false, failure: { store: 'continuation', operation: 'read_holds' } } }, { store: 'governance', operation: 'consult' }],
    ['null', { answer: null }, { store: 'governance', operation: 'consult' }],
  ]
  for (const [label, secondConsult, where] of legs) {
    const w = await world()
    await w.firstPullApplied()
    await w.env.seedExecution(SCOPE, { status: 'running' })
    const { handle, calls } = recheckHandle(w, { secondConsult })
    const generation = await w.generation()
    const tokens = w.tokenStore.map.size
    const writes = w.sheet.writes()
    const refused = await expectCode(w.dryRun({ refreshGovernance: handle }), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
    assert.equal(refused.details.store, where.store, label)
    assert.equal(refused.details.operation, where.operation, label)
    assert.equal(calls.consult, 2, `${label}: the planning consult and ONE re-consult`)
    assert.equal(calls.reconcileHolds, 0, `${label}: refused before the reconciliation`)
    assert.equal(w.tokenStore.map.size, tokens, `${label}: no token`)
    const after = await w.generation()
    assert.deepEqual([after.generation, after.generationToken], [generation.generation, generation.generationToken], `${label}: no bump`)
    assert.equal(w.sheet.writes(), writes, `${label}: no write`)
  }
  // (d) the straddled run ends FAILED and a second failed row appears before the re-consult: the count is the fresh one.
  const w = await world()
  await w.firstPullApplied()
  const execution = await w.env.seedExecution(SCOPE, { status: 'running' })
  const { handle, calls } = recheckHandle(w, {
    afterFirstConsult: async () => {
      await w.env.store.finishExecution({ ...SCOPE, executionId: execution.id, status: 'failed', written: 0, attemptedWrites: 1 })
      await w.env.seedExecution(SCOPE, { status: 'failed', leaseId: 'lease_sl_r7_second', leaseRunId: 'run_sl_r7_second' })
    },
  })
  const preview = await w.dryRun({ refreshGovernance: handle })
  assert.equal(preview.status, 'recovery_pending')
  assert.deepEqual({ ...preview.refreshRecovery }, { pending: true, openExecutions: 2 }, '(d) the fresh rows, never the stale count')
  assert.equal(calls.consult, 2)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-small-lane.test.cjs', tests)
