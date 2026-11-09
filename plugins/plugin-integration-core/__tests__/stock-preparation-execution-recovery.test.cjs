'use strict'

// 备料 batch-refresh step 6a-2 (S6-2; register row R-91) — the RECOVERY verify-and-close, hermetic.
//
// Design: step-6 design §3.5-§3.11, §5.1 as amended by the 2026-11-09 rebaseline (S6-2 items (a)-(j), N-SWITCH,
// N-INSTALLING, B-22). The store runs over the refresh-store kit (support/stock-preparation-refresh-store-kit.cjs: the
// migrations' columns, enums and shape CHECKs, a rolling-back transaction, per-method fault injection); the recovery lib
// runs over the small-lane world (the REAL planner, writer, governance and lock over in-memory fakes). Row locks and
// interleavings are the real-DB cases' (tests/integration/stock-preparation-execution-recovery-realdb.cases.ts).
//
//   RC-01  the close's single-transaction order: lock_timeout -> state -> holder -> execution -> continuations -> plans ->
//          批次标识 -> execution close -> state advance -> audit; nothing else
//   RC-02  holderWithin refuses (LEASE_LOST) => full rollback
//   RC-03  the status UNDER THE LOCK decides: running -> aborted proceeds (pre_close_status aborted); succeeded / verified_closed
//          => 409 NOT_UNFINISHED; another scope => 404; an intent digest that moved => STATE_MOVED intent_moved
//   RC-04  every §3.7 cell P1-P11 (+ the unbound landed / mixed / nothing_landed columns, decision_version + 1)
//   RC-05  the audit row rides the close's transaction; its failure rolls everything back (E09)
//   RC-06  settlement only for a subject, re-decided under the lock; a transparent close writes no settled column
//   RC-07  a 55P03 at the lock row => WRITE_LOCKED holder_in_write; at every other step => RECOVERY_BUSY { step }
//   RC-08  the close's input is validated before any statement (modes, results, the hooks, the runbook handle)
//   RC-09  readExecutionForRecovery: one REPEATABLE READ snapshot; intent ok / missing / corrupt; another scope reads null
//   RC-10  listExecutions: newest first, paged by id, values-free
//   BI-IF  the 批次标识 hook gets the UNPREFIXED digest, the result and the sheet count; its outcome rides the audit and the
//          answer; its refusal rolls the close back; no hook => no 批次标识 step at all
//   RV-01..05, NS-01, NI-01, AU-01  the recovery lib (TA) over the small-lane world
// Every value is synthetic.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const kit = require(path.join(__dirname, 'support', 'stock-preparation-refresh-store-kit.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const recovery = require(path.join(LIB, 'stock-preparation-execution-recovery.cjs'))
const intentModule = require(path.join(LIB, 'stock-preparation-execution-intent.cjs'))
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const lanes = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const { readProjectRefreshState } = require(path.join(LIB, 'stock-preparation-refresh-state.cjs'))
const { PROJECT_WRITE_ERROR_CODES, PROJECT_WRITE_ROW_LOCK_WAIT_MS, StockPreparationProjectWriteLockError, sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { EXISTING_ROW_RECORD_REF } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const { EXISTING_ROW_PULL_BATCH } = require(path.join(LIB, 'stock-preparation-pull-batch.cjs'))
const { assertValuesFreeDetail } = require(path.join(LIB, 'stock-preparation-audit-store.cjs')).__internals || {}
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const F = require('./support/stock-preparation-continuation-fixtures.cjs')

const { REFRESH_STORE_TABLES: T, REFRESH_STORE_ERROR_CODES: CODES, createStockPreparationContinuationStore } = storeModule

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_rc_a'
const SHEET = 'sheet_rc_a'
const PROJECT = 'PRJ-RC-1'
const SCOPE = Object.freeze({ tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT })
const GUARD = Object.freeze({ leaseRunId: 'run_rc', leaseId: 'lease_rc', fencingEpoch: 1, generation: 1, generationToken: 'g_rc' })
const LEASE = Object.freeze({ leaseId: 'lease_rec', leaseRunId: 'run_rec', fencingEpoch: 2 })
const PLAN_DIGEST = 'a'.repeat(64)
const BI_DIGEST = 'b'.repeat(32)

async function expectCode(promise, { status, code, reason, step }) {
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
  if (step !== undefined) assert.equal(caught.details && caught.details.step, step, JSON.stringify(caught.details))
  return caught
}

// ── the store over the kit ─────────────────────────────────────────────────────────────────────────

function storeWorld() {
  const clock = kit.createClock('2026-11-09T00:00:00.000Z')
  const db = kit.createFakeRefreshDb({ clock })
  let n = 0
  const store = createStockPreparationContinuationStore({ db, now: clock.now, idGenerator: (kind) => `${kind}_rc_${String((n += 1)).padStart(4, '0')}` })
  return { db, clock, store }
}

const sequence = []
function trace(label) {
  sequence.push(label)
}

function hooks({ holder = async () => trace('holder'), batch = null, audit = async (trx, event) => { trace('audit'); audits.push(event) } } = {}) {
  return { holderWithin: holder, ...(batch ? { batchWithin: batch } : {}), auditWithin: audit }
}
const audits = []

// One governed state row + one execution, begun through the store (so every 106 column is the store's own).
async function seedExecution(w, { intent = kit.emptyIntentFor(PLAN_DIGEST), changePlanId = null, continuations = [], pullBatchSourceDigest = null } = {}) {
  await w.db.insertOne(T.state, { id: 'rst_rc', tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, write_scope_key: sheetWriteScopeKey(SHEET), governed_since: w.clock.now(), updated_at: w.clock.now() })
  const begun = await w.store.beginExecution({
    ...SCOPE,
    lane: 'small_apply',
    guard: GUARD,
    tokenRevision: 'rev_rc',
    planDigest: PLAN_DIGEST,
    plannedCounts: { add: 1 },
    refreshBinding: { continuations, changePlanId },
    startedBy: 'u_rc_puller',
    intent,
    ...(pullBatchSourceDigest ? { pullBatchSourceDigest } : {}),
  })
  return begun
}

async function setStatus(w, id, status) {
  await w.db.updateRow(T.execution, { status, finished_at: status === 'running' ? null : w.clock.now() }, { id })
}

function closeInput(executionId, { mode = 'puller_verified', result = 'landed', intentDigest, landedRecordIds = [], settlement, runbookRef } = {}) {
  return {
    ...SCOPE,
    executionId,
    mode,
    classification: { result, intentDigest, counts: { intended: 1, landed: result === 'landed' ? 1 : 0 }, landedRecordIds, landedAddCount: result === 'landed' ? 1 : 0, verifiedCreatedRows: 0 },
    lease: LEASE,
    closedBy: 'u_rc_puller',
    ...(settlement ? { settlement } : {}),
    ...(runbookRef ? { runbookRef } : {}),
  }
}

// A change plan row with every NOT NULL column (migration 104); `records` = [[recordId, key, { field: [before, after] }]].
function planRow(id, status, records, extra = {}) {
  const recordSet = records.map(([recordId, key, fields]) => ({
    recordId,
    key,
    root: false,
    inContinuation: null,
    fields: Object.fromEntries(Object.entries(fields).map(([fieldId, [before, after, reviewOnly]]) => [fieldId, { before, after, afterCanonical: after, ...(reviewOnly ? { reviewOnly: true } : {}) }])),
  }))
  return {
    id,
    tenant_id: TENANT,
    sheet_id: SHEET,
    project_no: PROJECT,
    write_scope_key: sheetWriteScopeKey(SHEET),
    status,
    plan_fingerprint: 'f'.repeat(64),
    source_content_digest: 'c'.repeat(32),
    planned_content_digest: pairing.plannedContentDigestOf(recordSet),
    record_count: recordSet.length,
    write_record_count: recordSet.length,
    record_set: recordSet,
    absorbed_change_plan_ids: [],
    hold_ids: ['hold_rc_1'],
    hold_set_fingerprint: 'h'.repeat(64),
    continuation_ids: [],
    review_baseline_digest: 'none',
    confirmed_by: 'u_rc_puller',
    confirmed_at: new Date('2026-11-08T00:00:00.000Z'),
    confirmed_generation: 1,
    confirmed_generation_token: 'g_rc_c',
    confirmed_fencing_epoch: 1,
    ...extra,
  }
}

const TWO_RECORDS = [['rec_1', 'k1', { rawQuantity: [1, 2] }], ['rec_2', 'k2', { rawQuantity: [3, 4] }]]

// A live relationship row (migration 102's NOT NULL columns; the ST-08 precedent).
async function seedContinuation(w, id) {
  await w.db.insertOne(T.continuation, {
    id, tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, write_scope_key: sheetWriteScopeKey(SHEET), status: 'active', revision: 1,
    old_root_record_id: `rec_${id}`, old_root_key: `{"k":"${id}"}`, old_root_component_source_id: 'c', new_parent_component_source_id: 'p', new_root_path_tokens: ['p', 'c'],
    new_root_key: `{"k":"${id}-new"}`, new_root_key_digest: `d_${id}`, external_system_id: 'x', source_scope_digest: 's', read_plan_digest: 'r',
    pairing_fingerprint: 'pf', comparison_fingerprint: 'cf', evidence_fingerprint: 'ef', evidence_snapshot: {}, demand_basis: 'puller_confirmed_same_demand',
    confirmed_by: 'u', confirmed_at: w.clock.now(), confirmed_generation: 1, confirmed_generation_token: 't', confirmed_fencing_epoch: 0,
  })
  assert.equal(w.db.rows(T.continuation).find((row) => row.id === id).claim_active, true, 'seeded claim_active')
}

test('RC-01 the close is ONE transaction in the design §3.6 order — lock_timeout -> state -> holder -> execution -> continuations -> plans -> 批次标识 -> execution close -> state advance -> audit', async () => {
  const w = storeWorld()
  await w.db.insertOne(T.changePlan, planRow('chp_rc_cp', 'confirmed', TWO_RECORDS))
  const begun = await seedExecution(w, { changePlanId: 'chp_rc_cp', pullBatchSourceDigest: BI_DIGEST, intent: kit.emptyIntentFor(PLAN_DIGEST) })
  await setStatus(w, begun.id, 'partial')
  sequence.length = 0
  w.db.log.length = 0
  const batchCalls = []
  const closed = await w.store.closeExecution(closeInput(begun.id, { result: 'landed', intentDigest: begun.intentDigest, landedRecordIds: ['rec_1', 'rec_2'] }), hooks({
    holder: async (trx) => { trace('holder'); assert.equal(trx, w.db.lastTransactionHandle, 'the holder runs on the close\'s own handle') },
    batch: async (trx, input) => { trace('batch'); batchCalls.push(input); return 'closed' },
  }))
  const statements = w.db.log.filter(([method]) => method.startsWith('trx.') || method === 'transaction' || method === 'commit').map(([method, args]) => `${method}:${args && args.table ? args.table.replace('integration_stock_prep_', '') : ''}`)
  assert.equal(statements[0], 'transaction:')
  assert.equal(statements[1], 'trx.setLocalLockTimeout:', 'the bound is the first statement')
  assert.equal(statements[2], 'trx.selectOneForUpdate:refresh_state')
  const executionLock = statements.indexOf('trx.selectOneForUpdate:refresh_execution')
  const planLock = statements.indexOf('trx.selectOneForUpdate:change_plan')
  const executionClose = statements.findIndex((s, i) => i > planLock && s === 'trx.updateRow:refresh_execution')
  const stateAdvance = statements.lastIndexOf('trx.updateRow:refresh_state')
  assert.ok(executionLock > 2 && planLock > executionLock && executionClose > planLock && stateAdvance > executionClose, statements.join(' '))
  assert.deepEqual(sequence, ['holder', 'batch', 'audit'])
  assert.equal(statements[statements.length - 1], 'commit:')
  assert.deepEqual(batchCalls, [{ scope: SCOPE, refreshExecutionId: begun.id, result: 'landed', verifiedCreatedRows: 0, sourceDigest: BI_DIGEST }], 'the UNPREFIXED digest as stored (rebaseline (a))')
  assert.equal(closed.preStatus, 'partial')
  assert.equal(closed.batchOutcome, 'closed')
  assert.equal(closed.changePlan.cell, 'P1')
  const row = w.db.rows(T.execution)[0]
  assert.deepEqual([row.status, row.verified_result, row.closed_mode, row.pre_close_status, row.verify_lease_run_id, row.verify_fencing_epoch, row.verified_by, row.settlement_subject], ['verified_closed', 'landed', 'puller_verified', 'partial', 'run_rec', 2, 'u_rc_puller', true])
  assert.equal(w.db.rows(T.state)[0].decision_version, 1, 'decision_version + 1 (a straddling reconcile is refused STATE_MOVED)')
})

test('RC-02 holderWithin refuses (the lease was taken over) => 409 LEASE_LOST and NOTHING persists', async () => {
  const w = storeWorld()
  const begun = await seedExecution(w)
  await setStatus(w, begun.id, 'failed')
  const before = JSON.stringify([w.db.rows(T.execution), w.db.rows(T.state)])
  const lost = new StockPreparationProjectWriteLockError(409, PROJECT_WRITE_ERROR_CODES.LEASE_LOST, 'lost', { reason: 'recovery_close', partial: false }, { fence: true })
  audits.length = 0
  await expectCode(w.store.closeExecution(closeInput(begun.id, { result: 'nothing_landed', intentDigest: begun.intentDigest }), hooks({ holder: async () => { throw lost } })), { status: 409, code: PROJECT_WRITE_ERROR_CODES.LEASE_LOST, reason: 'recovery_close' })
  assert.equal(JSON.stringify([w.db.rows(T.execution), w.db.rows(T.state)]), before)
  assert.equal(audits.length, 0)
})

test('RC-03 the status under the LOCK decides: a zombie\'s running -> aborted since the verify proceeds (pre_close_status aborted); succeeded / verified_closed => 409 NOT_UNFINISHED; another scope => 404; a moved intent digest => STATE_MOVED intent_moved', async () => {
  const w = storeWorld()
  const begun = await seedExecution(w)
  // The verify saw `running`; the zombie finished `aborted` before the close.
  await setStatus(w, begun.id, 'aborted')
  const closed = await w.store.closeExecution(closeInput(begun.id, { result: 'nothing_landed', intentDigest: begun.intentDigest }), hooks())
  assert.equal(closed.preStatus, 'aborted')
  assert.equal(w.db.rows(T.execution)[0].pre_close_status, 'aborted')
  assert.equal(closed.transparent, true, 'unbound nothing_landed is transparent')
  // Now it is verified_closed: a second close is NOT_UNFINISHED verified_closed.
  await expectCode(w.store.closeExecution(closeInput(begun.id, { result: 'nothing_landed', intentDigest: begun.intentDigest }), hooks()), { status: 409, code: CODES.EXECUTION_NOT_UNFINISHED, reason: 'verified_closed' })
  const w2 = storeWorld()
  const b2 = await seedExecution(w2)
  await setStatus(w2, b2.id, 'succeeded')
  await expectCode(w2.store.closeExecution(closeInput(b2.id, { result: 'landed', intentDigest: b2.intentDigest }), hooks()), { status: 409, code: CODES.EXECUTION_NOT_UNFINISHED, reason: 'execution_finished' })
  const w3 = storeWorld()
  const b3 = await seedExecution(w3)
  await setStatus(w3, b3.id, 'failed')
  await expectCode(w3.store.closeExecution({ ...closeInput(b3.id, { result: 'nothing_landed', intentDigest: b3.intentDigest }), projectNo: 'PRJ-RC-OTHER' }, hooks()), { code: 'STOCK_PREP_PULL_STATE_MOVED', reason: 'state_row_absent' })
  await expectCode(w3.store.closeExecution({ ...closeInput('exec_absent', { result: 'nothing_landed', intentDigest: b3.intentDigest }) }, hooks()), { status: 404, code: CODES.EXECUTION_NOT_FOUND })
  await expectCode(w3.store.closeExecution(closeInput(b3.id, { result: 'nothing_landed', intentDigest: 'e'.repeat(32) }), hooks()), { status: 409, code: 'STOCK_PREP_PULL_STATE_MOVED', reason: 'intent_moved' })
})

// The plan-bound cells. `cpStatus` the plan status seen under the lock; W0 = a pending written plan of the same project.
async function cellWorld({ cpStatus = 'confirmed', cpExtra = {}, withW0 = true, executionStatus = 'partial' } = {}) {
  const w = storeWorld()
  if (withW0) await w.db.insertOne(T.changePlan, planRow('chp_rc_w0', 'written', [['rec_9', 'k9', { rawQuantity: [7, 8] }]], { execution_id: 'exec_old', written_at: new Date('2026-11-07T00:00:00.000Z'), written_content_digest: 'w'.repeat(64) }))
  // The bound begin asserts the plan `confirmed` (PR-8): the plan is confirmed at the begin, then moved to the cell's status.
  await w.db.insertOne(T.changePlan, planRow('chp_rc_cp', 'confirmed', TWO_RECORDS))
  const begun = await seedExecution(w, { changePlanId: 'chp_rc_cp' })
  w.db.tables.get(T.changePlan).delete('chp_rc_cp')
  const extra = cpStatus === 'invalidated_failed'
    ? { status: 'invalidated', invalidated_reason: 'execution_failed', invalidated_at: new Date('2026-11-08T01:00:00.000Z'), execution_id: begun.id }
    : cpStatus === 'invalidated_source'
      ? { status: 'invalidated', invalidated_reason: 'source_changed', invalidated_at: new Date('2026-11-08T01:00:00.000Z') }
      : { status: cpStatus }
  if (cpStatus === 'written') Object.assign(extra, { execution_id: 'exec_other', written_at: new Date(), written_content_digest: 'x'.repeat(64) })
  if (cpStatus === 'written' && withW0) {
    // only one written plan per project: drop W0 for this cell
    w.db.tables.get(T.changePlan).delete('chp_rc_w0')
  }
  await w.db.insertOne(T.changePlan, planRow('chp_rc_cp', 'confirmed', TWO_RECORDS, { ...extra, ...cpExtra }))
  await setStatus(w, begun.id, executionStatus)
  return { w, begun }
}

function plans(w) {
  return Object.fromEntries(w.db.rows(T.changePlan).map((row) => [row.id, row]))
}

test('RC-04 every §3.7 cell: P1 / P2 / P3 / P5 on a CONFIRMED plan, P6 / P7 / P8 / P9 on one invalidated by THIS run, P10 / P11 refused — RW layout, W0 superseded first, settlement subject', async () => {
  // P1 confirmed + landed: CP -> written, absorbing W0.
  {
    const { w, begun } = await cellWorld()
    const closed = await w.store.closeExecution(closeInput(begun.id, { result: 'landed', intentDigest: begun.intentDigest, landedRecordIds: ['rec_1', 'rec_2'] }), hooks())
    const p = plans(w)
    assert.deepEqual([closed.changePlan.cell, p.chp_rc_cp.status, p.chp_rc_cp.execution_id, p.chp_rc_w0.status, p.chp_rc_w0.superseded_by], ['P1', 'written', begun.id, 'superseded', 'chp_rc_cp'])
    assert.ok(p.chp_rc_cp.record_set.some((record) => record.recordId === 'rec_9' && record.fields.rawQuantity.reviewOnly === true), 'W0 absorbed review-only')
    assert.equal(closed.settlementSubject, true)
  }
  // P2 confirmed + mixed: CP invalidated(execution_failed) + RW(landed write records) absorbing W0.
  {
    const { w, begun } = await cellWorld()
    const closed = await w.store.closeExecution(closeInput(begun.id, { result: 'mixed', intentDigest: begun.intentDigest, landedRecordIds: ['rec_1'] }), hooks())
    const p = plans(w)
    const rw = p[closed.changePlan.recoveredPlanId]
    assert.equal(closed.changePlan.cell, 'P2')
    assert.deepEqual([p.chp_rc_cp.status, p.chp_rc_cp.invalidated_reason, p.chp_rc_cp.execution_id], ['invalidated', 'execution_failed', begun.id])
    assert.deepEqual([rw.status, rw.recovered_from_change_plan_id, rw.execution_id, rw.write_record_count], ['written', 'chp_rc_cp', begun.id, 1])
    assert.deepEqual(rw.record_set.map((record) => record.recordId), ['rec_1', 'rec_9'], 'the landed record + W0 absorbed')
    assert.deepEqual([p.chp_rc_w0.status, p.chp_rc_w0.superseded_by], ['superseded', rw.id], 'W0 superseded first, by the RW')
    assert.equal(rw.planned_content_digest, p.chp_rc_cp.planned_content_digest, 'copied from CP')
    assert.notEqual(rw.plan_fingerprint, p.chp_rc_cp.plan_fingerprint, 'its own (recovered) fingerprint')
    assert.equal(rw.written_content_digest, pairing.plannedContentDigestOf(rw.record_set))
  }
  // P2 with ZERO landed write records: CP invalidated, no RW, W0 untouched (104: write_record_count >= 1).
  {
    const { w, begun } = await cellWorld()
    const closed = await w.store.closeExecution(closeInput(begun.id, { result: 'mixed', intentDigest: begun.intentDigest, landedRecordIds: [] }), hooks())
    const p = plans(w)
    assert.deepEqual([closed.changePlan.cell, closed.changePlan.recoveredPlanId, p.chp_rc_cp.status, p.chp_rc_w0.status], ['P2', null, 'invalidated', 'written'])
  }
  // P3 confirmed + nothing_landed: CP STAYS confirmed; a settlement subject (never transparent).
  {
    const { w, begun } = await cellWorld()
    const closed = await w.store.closeExecution(closeInput(begun.id, { result: 'nothing_landed', intentDigest: begun.intentDigest }), hooks())
    const p = plans(w)
    assert.deepEqual([closed.changePlan.cell, p.chp_rc_cp.status, p.chp_rc_w0.status, closed.transparent, w.db.rows(T.execution)[0].settlement_subject], ['P3', 'confirmed', 'written', false, true])
  }
  // P5 confirmed + unknown (runbook): CP invalidated FIRST, RW of EVERY write record.
  {
    const { w, begun } = await cellWorld()
    const closed = await w.store.closeExecution(closeInput(begun.id, { mode: 'runbook', result: 'unknown', intentDigest: begun.intentDigest, runbookRef: 'TICKET-1' }), hooks())
    const p = plans(w)
    const rw = p[closed.changePlan.recoveredPlanId]
    assert.deepEqual([closed.changePlan.cell, p.chp_rc_cp.status, rw.write_record_count, w.db.rows(T.execution)[0].runbook_ref, w.db.rows(T.execution)[0].closed_mode], ['P5', 'invalidated', 2, 'TICKET-1', 'runbook'])
  }
  // P6 / P7 / P8 / P9 — the plan already invalidated(execution_failed) by THIS execution's finish.
  for (const [result, mode, cell, rwCount] of [['landed', 'puller_verified', 'P6', 2], ['mixed', 'puller_verified', 'P7', 1], ['nothing_landed', 'puller_verified', 'P8', 0], ['unknown', 'runbook', 'P9', 2]]) {
    const { w, begun } = await cellWorld({ cpStatus: 'invalidated_failed' })
    const closed = await w.store.closeExecution(closeInput(begun.id, { mode, result, intentDigest: begun.intentDigest, landedRecordIds: result === 'mixed' ? ['rec_2'] : ['rec_1', 'rec_2'], ...(mode === 'runbook' ? { runbookRef: 'TICKET-2' } : {}) }), hooks())
    const p = plans(w)
    assert.equal(closed.changePlan.cell, cell)
    assert.equal(p.chp_rc_cp.status, 'invalidated', `${cell}: CP unchanged (terminal)`)
    assert.equal(closed.changePlan.recoveredRecordCount, rwCount, cell)
    assert.equal(p.chp_rc_w0.status, rwCount > 0 ? 'superseded' : 'written', `${cell}: W0`)
    assert.equal(closed.settlementSubject, true, `${cell}: a subject`)
  }
  // P10 invalidated(source_changed) / P11 written: 409 STATE_MOVED change_plan_moved, nothing persists.
  for (const cpStatus of ['invalidated_source', 'written', 'superseded']) {
    const { w, begun } = await cellWorld({ cpStatus, cpExtra: cpStatus === 'superseded' ? { superseded_at: new Date(), superseded_by: 'chp_x' } : {} })
    const before = JSON.stringify(w.db.rows(T.execution))
    await expectCode(w.store.closeExecution(closeInput(begun.id, { result: 'landed', intentDigest: begun.intentDigest, landedRecordIds: ['rec_1', 'rec_2'] }), hooks()), { code: 'STOCK_PREP_PULL_STATE_MOVED', reason: 'change_plan_moved' })
    assert.equal(JSON.stringify(w.db.rows(T.execution)), before, cpStatus)
  }
  // An invalidated(execution_failed) plan of ANOTHER execution is not this run's: refused too.
  {
    const { w, begun } = await cellWorld({ cpStatus: 'invalidated_failed', cpExtra: { execution_id: 'exec_someone_else' } })
    await expectCode(w.store.closeExecution(closeInput(begun.id, { result: 'landed', intentDigest: begun.intentDigest, landedRecordIds: ['rec_1'] }), hooks()), { reason: 'change_plan_moved' })
  }
})

test('RC-04b the unbound columns: landed stamps the bound continuations (as a succeeded finish); mixed / nothing_landed leave them; nothing_landed is TRANSPARENT; decision_version + 1 each time', async () => {
  for (const [result, stamped, transparent] of [['landed', true, false], ['mixed', false, false], ['nothing_landed', false, true]]) {
    const w = storeWorld()
    await seedContinuation(w, 'cont_rc_1')
    const seeded = true
    const begun = await seedExecution(w, { continuations: [{ id: 'cont_rc_1', revision: 1 }] })
    await setStatus(w, begun.id, 'partial')
    const closed = await w.store.closeExecution(closeInput(begun.id, { result, intentDigest: begun.intentDigest }), hooks())
    assert.equal(closed.transparent, transparent, result)
    assert.equal(w.db.rows(T.execution)[0].settlement_subject, !transparent, result)
    assert.equal(w.db.rows(T.state)[0].decision_version, 1, result)
    if (seeded) assert.equal(w.db.rows(T.continuation)[0].executed_execution_id === begun.id, stamped, result)
    assert.equal(closed.continuationsConsumed, stamped && seeded ? 1 : 0, result)
  }
})

test('RC-05 the audit row is appended INSIDE the close transaction (on its handle); an audit failure rolls the close back (E09); the hook is required', async () => {
  const w = storeWorld()
  const begun = await seedExecution(w)
  await setStatus(w, begun.id, 'failed')
  const before = JSON.stringify([w.db.rows(T.execution), w.db.rows(T.state)])
  await expectCode(w.store.closeExecution(closeInput(begun.id, { result: 'nothing_landed', intentDigest: begun.intentDigest }), hooks({ audit: async () => { throw Object.assign(new Error('audit down'), { code: '57P01' }) } })), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(JSON.stringify([w.db.rows(T.execution), w.db.rows(T.state)]), before)
  await expectCode(w.store.closeExecution(closeInput(begun.id, { result: 'nothing_landed', intentDigest: begun.intentDigest }), { holderWithin: async () => {} }), { status: 500, code: CODES.INPUT_INVALID })
  const seen = []
  await w.store.closeExecution(closeInput(begun.id, { result: 'nothing_landed', intentDigest: begun.intentDigest }), hooks({ audit: async (trx, event) => { seen.push([trx === w.db.lastTransactionHandle, event]) } }))
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], true, 'the close\'s own handle')
  assert.deepEqual(Object.keys(seen[0][1]).sort(), ['changePlanOutcome', 'continuationsConsumed', 'counts', 'executionId', 'operation', 'preStatus', 'recoveredRecordCount', 'result', 'settled', 'transparent'])
  assert.equal(seen[0][1].operation, 'execution_verified_closed')
})

test('RC-06 settlement: only a settlement SUBJECT settles, and only when admissible UNDER the lock (no open hold, no other unfinished execution, no newer settlement); a transparent close never writes a settled column', async () => {
  const settlement = { generationToken: 'g_rc_s', sourceContentDigest: 'd'.repeat(32), sheetMachineDigest: 'm'.repeat(64) }
  // landed + clean => settles, naming this execution.
  {
    const w = storeWorld()
    const begun = await seedExecution(w)
    await setStatus(w, begun.id, 'partial')
    const closed = await w.store.closeExecution(closeInput(begun.id, { result: 'landed', intentDigest: begun.intentDigest, settlement }), hooks())
    const state = w.db.rows(T.state)[0]
    assert.deepEqual([closed.settled, state.settled_execution_id, state.settled_sheet_machine_digest], [true, begun.id, 'm'.repeat(64)])
  }
  // transparent (unbound nothing_landed) => never settles, even when handed one.
  {
    const w = storeWorld()
    const begun = await seedExecution(w)
    await setStatus(w, begun.id, 'failed')
    const closed = await w.store.closeExecution(closeInput(begun.id, { result: 'nothing_landed', intentDigest: begun.intentDigest, settlement }), hooks())
    const state = w.db.rows(T.state)[0]
    assert.deepEqual([closed.settled, state.settled_execution_id, state.settled_at], [false, null, null])
  }
  // another unfinished execution => no settlement (the close itself proceeds).
  {
    const w = storeWorld()
    const begun = await seedExecution(w)
    await setStatus(w, begun.id, 'partial')
    const other = await w.store.beginExecution({ ...SCOPE, lane: 'small_apply', guard: GUARD, tokenRevision: 'rev_rc2', planDigest: PLAN_DIGEST, plannedCounts: {}, refreshBinding: { continuations: [] }, startedBy: 'u_rc', intent: kit.emptyIntentFor(PLAN_DIGEST) })
    await setStatus(w, other.id, 'failed')
    const closed = await w.store.closeExecution(closeInput(begun.id, { result: 'landed', intentDigest: begun.intentDigest, settlement }), hooks())
    assert.equal(closed.settled, false)
    assert.equal(w.db.rows(T.state)[0].settled_execution_id, null)
  }
  // a runbook close never settles (refused at the input).
  {
    const w = storeWorld()
    const begun = await seedExecution(w)
    await setStatus(w, begun.id, 'failed')
    await expectCode(w.store.closeExecution(closeInput(begun.id, { mode: 'runbook', result: 'unknown', intentDigest: begun.intentDigest, runbookRef: 'T-1', settlement }), hooks()), { status: 500, code: CODES.INPUT_INVALID })
  }
})

test('RC-07 a 55P03 is classified by the step that raised it: the lock row => 409 WRITE_LOCKED holder_in_write; the state row, the execution, the continuations, the plans, 批次标识, the execution close, the state advance, the audit => 409 RECOVERY_BUSY { step }; nothing persists', async () => {
  const lockTimeout = () => kit.sqlError('55P03', 'canceling statement due to lock timeout')
  const cases = [
    ['lock_row', (w) => hooks({ holder: async () => { throw lockTimeout() } }), null, { status: 409, code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, reason: 'holder_in_write' }],
    ['state_row', () => hooks(), (args, method) => method === 'selectOneForUpdate' && args.table === T.state, { code: CODES.RECOVERY_BUSY, step: 'state_row' }],
    ['execution', () => hooks(), (args, method) => method === 'selectOneForUpdate' && args.table === T.execution, { code: CODES.RECOVERY_BUSY, step: 'execution' }],
    ['continuations', () => hooks(), (args, method) => method === 'updateRow' && args.table === T.continuation, { code: CODES.RECOVERY_BUSY, step: 'continuations' }],
    ['plans', () => hooks(), (args, method) => method === 'selectOneForUpdate' && args.table === T.changePlan, { code: CODES.RECOVERY_BUSY, step: 'plans' }],
    ['pull_batch', () => hooks({ batch: async () => { throw Object.assign(new Error('x'), { status: 503, code: 'STOCK_PREP_PULL_BATCH_STORE_FAILED', details: { operation: 'batch_within', sqlState: '55P03', partial: false } }) } }), null, { code: CODES.RECOVERY_BUSY, step: 'pull_batch' }],
    ['execution_close', () => hooks(), (args, method) => method === 'updateRow' && args.table === T.execution, { code: CODES.RECOVERY_BUSY, step: 'execution_close' }],
    ['state_advance', () => hooks(), (args, method) => method === 'updateRow' && args.table === T.state, { code: CODES.RECOVERY_BUSY, step: 'state_advance' }],
    ['audit', () => hooks({ audit: async () => { throw lockTimeout() } }), null, { code: CODES.RECOVERY_BUSY, step: 'audit' }],
  ]
  for (const [label, hookOf, faultOn, expected] of cases) {
    const w = storeWorld()
    await seedContinuation(w, 'cont_rc_7')
    const bound = true
    await w.db.insertOne(T.changePlan, planRow('chp_rc_cp', 'confirmed', TWO_RECORDS))
    const begun = await seedExecution(w, { changePlanId: 'chp_rc_cp', continuations: bound ? [{ id: 'cont_rc_7', revision: 1 }] : [] })
    await setStatus(w, begun.id, 'partial')
    if (label === 'continuations' && !bound) continue
    const before = JSON.stringify([w.db.rows(T.execution), w.db.rows(T.state), w.db.rows(T.changePlan)])
    for (const method of ['selectOneForUpdate', 'updateRow']) {
      if (faultOn) w.db.faults[method] = (args) => (faultOn(args, method) ? lockTimeout() : null)
    }
    const caught = await expectCode(w.store.closeExecution(closeInput(begun.id, { result: 'landed', intentDigest: begun.intentDigest, landedRecordIds: ['rec_1', 'rec_2'] }), hookOf(w)), expected)
    if (expected.code === CODES.RECOVERY_BUSY) assert.equal(caught.details.retryAfterMs, PROJECT_WRITE_ROW_LOCK_WAIT_MS, label)
    delete w.db.faults.selectOneForUpdate
    delete w.db.faults.updateRow
    assert.equal(JSON.stringify([w.db.rows(T.execution), w.db.rows(T.state), w.db.rows(T.changePlan)]), before, `${label}: rolled back`)
  }
})

test('RC-08 the close input is refused 500 before any statement: an unknown mode / a result the mode may not record / a puller close without the intent digest / no holder assert / a runbook close without a values-free ticket / a handle without setLocalLockTimeout is 501', async () => {
  const w = storeWorld()
  const begun = await seedExecution(w)
  await setStatus(w, begun.id, 'failed')
  w.db.log.length = 0
  for (const [label, input, options] of [
    ['mode', { ...closeInput(begun.id, { intentDigest: begun.intentDigest }), mode: 'self_verified' }, hooks()],
    ['puller unknown', closeInput(begun.id, { result: 'unknown', intentDigest: begun.intentDigest }), hooks()],
    ['runbook landed', closeInput(begun.id, { mode: 'runbook', result: 'landed', intentDigest: begun.intentDigest, runbookRef: 'T-1' }), hooks()],
    ['no digest', closeInput(begun.id, { result: 'landed', intentDigest: null }), hooks()],
    ['no holder', closeInput(begun.id, { result: 'landed', intentDigest: begun.intentDigest }), { auditWithin: async () => {} }],
    ['ticket', closeInput(begun.id, { mode: 'runbook', result: 'unknown', intentDigest: begun.intentDigest, runbookRef: 'a ticket with spaces' }), hooks()],
    ['counts', { ...closeInput(begun.id, { result: 'landed', intentDigest: begun.intentDigest }), classification: { result: 'landed', intentDigest: begun.intentDigest, counts: { landed: 'many' }, landedAddCount: 0, verifiedCreatedRows: 0 } }, hooks()],
  ]) {
    await expectCode(w.store.closeExecution(input, options), { status: 500, code: CODES.INPUT_INVALID })
    assert.equal(w.db.log.filter(([method]) => method === 'transaction').length, 0, label)
  }
  const noBound = { ...w.db, transaction: (callback) => w.db.transaction((trx) => { const { setLocalLockTimeout: _s, ...rest } = trx; return callback(rest) }) }
  const store = createStockPreparationContinuationStore({ db: noBound, now: w.clock.now })
  await expectCode(store.closeExecution(closeInput(begun.id, { result: 'nothing_landed', intentDigest: begun.intentDigest }), hooks()), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'transaction_handle' })
})

test('RC-09 readExecutionForRecovery: one REPEATABLE READ snapshot; intent ok (re-admitted), missing (legacy), corrupt (a chunk tampered / missing); the bound plan (private) and the written plans; another scope reads null', async () => {
  const w = storeWorld()
  const intent = intentModule.buildExecutionIntent({
    plan: { decisions: [{ decision: 'add', idempotencyKey: 'k-add-1', record: { rawQuantity: 2 } }, { decision: 'add', idempotencyKey: 'k-add-2', record: { rawQuantity: 3 } }] },
    planDigest: PLAN_DIGEST,
  })
  await w.db.insertOne(T.changePlan, planRow('chp_rc_cp', 'confirmed', TWO_RECORDS))
  const begun = await seedExecution(w, { intent, changePlanId: 'chp_rc_cp', pullBatchSourceDigest: BI_DIGEST })
  w.db.log.length = 0
  const read = await w.store.readExecutionForRecovery({ ...SCOPE, executionId: begun.id })
  assert.equal(w.db.log.find(([method]) => method === 'trx.setTransactionIsolationLevel')[1].level, 'repeatable read')
  assert.deepEqual([read.intentState, read.intent.entryCount, read.execution.pullBatchSourceDigest, read.changePlanBound, read.changePlan.id, read.writtenPlans.length], ['ok', 2, BI_DIGEST, true, 'chp_rc_cp', 0])
  assert.equal(await w.store.readExecutionForRecovery({ ...SCOPE, projectNo: 'PRJ-RC-OTHER', executionId: begun.id }), null, 'another scope reads as absent')
  assert.equal(await w.store.readExecutionForRecovery({ ...SCOPE, tenantId: 'tenant_rc_b', executionId: begun.id }), null)
  const head = await w.store.readExecutionForRecovery({ ...SCOPE, executionId: begun.id, includeIntent: false })
  assert.deepEqual([head.intent, head.intentState], [null, null])
  // corrupt: a tampered entry => the digest no longer re-admits.
  const chunkId = `${begun.id}:0`
  const chunk = w.db.rows(T.intent).find((row) => row.id === chunkId)
  await w.db.updateRow(T.intent, { entries: chunk.entries.map((entry, i) => (i === 0 ? { ...entry, post: 'f'.repeat(32) } : entry)) }, { id: chunkId })
  assert.equal((await w.store.readExecutionForRecovery({ ...SCOPE, executionId: begun.id })).intentState, 'corrupt')
  // missing: a legacy row (no journal).
  await w.db.updateRow(T.execution, { intent_version: null, intent_digest: null, intent_entry_count: null, pull_batch_source_digest: null }, { id: begun.id })
  assert.equal((await w.store.readExecutionForRecovery({ ...SCOPE, executionId: begun.id })).intentState, 'missing')
})

test('RC-10 listExecutions: newest first (started_at DESC, id DESC), paged by the last id, limit 1..20, an unknown cursor 400, values-free projection', async () => {
  const w = storeWorld()
  const ids = []
  await w.db.insertOne(T.state, { id: 'rst_rc', tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, write_scope_key: sheetWriteScopeKey(SHEET), governed_since: w.clock.now(), updated_at: w.clock.now() })
  for (let i = 0; i < 3; i += 1) {
    w.clock.advance(1000)
    const begun = await w.store.beginExecution({ ...SCOPE, lane: 'small_apply', guard: GUARD, tokenRevision: `rev_${i}`, planDigest: PLAN_DIGEST, plannedCounts: {}, refreshBinding: { continuations: [] }, startedBy: 'u_rc', intent: kit.emptyIntentFor(PLAN_DIGEST) })
    ids.push(begun.id)
  }
  const first = await w.store.listExecutions({ ...SCOPE, limit: 2 })
  assert.deepEqual(first.items.map((item) => item.id), [ids[2], ids[1]])
  assert.equal(first.nextCursor, ids[1])
  assert.equal(first.total, 3)
  const second = await w.store.listExecutions({ ...SCOPE, limit: 2, cursor: first.nextCursor })
  assert.deepEqual([second.items.map((item) => item.id), second.nextCursor], [[ids[0]], null])
  await expectCode(w.store.listExecutions({ ...SCOPE, cursor: 'exec_unknown' }), { status: 400 })
  await expectCode(w.store.listExecutions({ ...SCOPE, limit: 21 }), { status: 400 })
  await expectCode(w.store.listExecutions({ ...SCOPE, limit: 0 }), { status: 400 })
})

// ── the recovery lib over the small-lane world (the real planner, writer, governance and lock) ───────────────────────

const RW_TENANT = 'tenant_rv_a'
const RW_SHEET = 'sheet_rv_main'
const RW_PROJECT = F.PROJECT_NO
const PLANNED_AT = '2026-11-09T01:00:00.000Z'
const SANDBOX_POLICY = Object.freeze({ enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] })

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function createSource(initial) {
  const state = { data: initial }
  return {
    state,
    adapter: {
      async read(input = {}) {
        const rows = Array.isArray(state.data[input.object]) ? state.data[input.object] : []
        const matches = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
        const offset = input.cursor ? Number(input.cursor) : 0
        const limit = input.limit || 1000
        const records = matches.slice(offset, offset + limit).map(clone)
        return { records, done: offset + records.length >= matches.length, nextCursor: offset + records.length < matches.length ? String(offset + records.length) : null }
      },
    },
  }
}

function createSheet() {
  const rows = []
  const calls = []
  const sheet = { rows, calls, failCreates: 0 }
  sheet.api = {
    supportsWriteFence: true,
    async queryRecords(input = {}) {
      calls.push('queryRecords')
      return rows.filter((record) => record.sheetId === input.sheetId)
        .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
        .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
        .map(clone)
    },
    async createRecord(input = {}) {
      calls.push('createRecord')
      if (sheet.failCreates > 0) {
        sheet.failCreates -= 1
        throw Object.assign(new Error('synthetic create failure'), { code: 'SYN_CREATE_FAILED' })
      }
      const record = { id: `rec_rv_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(record)
      return clone(record)
    },
    async patchRecord(input = {}) {
      calls.push('patchRecord')
      const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
      record.version += 1
      record.data = { ...record.data, ...(input.changes || {}) }
      return clone(record)
    },
  }
  sheet.writes = () => calls.filter((op) => op === 'createRecord' || op === 'patchRecord').length
  return sheet
}

async function recoveryWorld() {
  const harness = lockKit.createLibWriteLockHarness()
  const env = harness.refresh()
  await env.registerProject({ tenantId: RW_TENANT, projectNo: RW_PROJECT, sheetId: RW_SHEET, objectId: 'stockPreparationMain', pilot: true })
  const source = createSource(F.firstPullSource())
  const sheet = createSheet()
  const tokenStore = lockKit.createConsumableStorage()
  const action = { actionId: 'plm.stock-preparation.pull-bom.v1', source: { externalSystemId: 'plm_rv_fixture', kind: 'data-source:sql-readonly' }, target: { sheetId: RW_SHEET, objectId: 'stockPreparationMain' } }
  const scopeKey = sheetWriteScopeKey(RW_SHEET)
  const verifyAudits = []
  const closeAudits = []
  const w = {
    harness, env, source, sheet, tokenStore, action, scopeKey, verifyAudits, closeAudits,
    async dryRun() {
      return harness.wrapDryRun(tableActions.dryRunStockPreparationAction)({ action, parameters: { projectNo: RW_PROJECT }, sourceAdapter: source.adapter, recordsApi: sheet.api, tokenStore, plannedAt: PLANNED_AT, runId: 'run_rv', tenantId: RW_TENANT })
    },
    async apply(dryRunToken) {
      return harness.wrapApply(tableActions.applyStockPreparationAction)({ sandboxPolicy: SANDBOX_POLICY, action, parameters: { projectNo: RW_PROJECT }, dryRunToken, sourceAdapter: source.adapter, recordsApi: sheet.api, tokenStore, permission: 'write', plannedAt: PLANNED_AT, runId: 'run_rv', tenantId: RW_TENANT })
    },
    executions() {
      return env.db.rows(T.execution)
    },
    async recover(operation, extra = {}) {
      const handle = env.handleFor(RW_TENANT)
      return harness.lock.withProjectWriteLease(scopeKey, { purpose: 'recovery_verify', runId: 'rec-rv-run', tenantId: RW_TENANT }, (guard) => tableActions.recoverStockPreparationExecution({
        operation,
        action,
        parameters: { projectNo: RW_PROJECT },
        tenantId: RW_TENANT,
        executionId: extra.executionId || w.executions()[0].id,
        sourceAdapter: source.adapter,
        recordsApi: lockKit.withFakeHostWriteFence ? lockKit.withFakeHostWriteFence(sheet.api) : sheet.api,
        plannedAt: PLANNED_AT,
        runId: 'run_rv',
        refreshGovernance: handle,
        projectWriteGuard: guard,
        projectWriteRunId: 'rec-rv-run',
        closedBy: 'u_rv_puller',
        holderWithin: async () => {},
        auditVerifyRead: async (detail) => { verifyAudits.push(detail) },
        auditCloseWithin: async (trx, event) => { closeAudits.push(recovery.recoveryCloseAuditEntryOf(event)) },
        readSheetRows: () => tableActions.__internals.readExistingStockPreparationRows(sheet.api, action.target, RW_PROJECT),
        ...extra,
      }))
    },
    async derived() {
      return readProjectRefreshState(await env.governance.consult({ tenantId: RW_TENANT, sheetId: RW_SHEET, projectNo: RW_PROJECT }))
    },
  }
  return w
}

// A partial first pull: `failCreates` of the creates fail (the run ends partial, the rest landed).
async function partialWorld(failCreates = 2) {
  const w = await recoveryWorld()
  const preview = await w.dryRun()
  assert.equal(preview.status, 'ready', preview.status)
  w.sheet.failCreates = failCreates
  const applied = await w.apply(preview.dryRunToken)
  assert.equal(applied.status, 'partial')
  assert.equal(w.executions()[0].status, 'partial')
  assert.equal((await w.derived()).status, 'failed_pending_recovery')
  return w
}

test('RV-01 verify then close a PARTIAL run: mixed (n-k landed, k not), the order lease -> read -> recompute -> classify -> close, ZERO record writes by the recovery; the project derives out of 失败待恢复; the retry writes only what is missing', async () => {
  const w = await partialWorld(2)
  const landed = w.sheet.rows.length
  const writesBefore = w.sheet.writes()
  const verified = await w.recover('verify')
  assert.equal(verified.report.result, 'mixed')
  assert.equal(verified.report.counts.landed, landed)
  assert.equal(verified.report.counts.notLanded, 2)
  assert.equal(verified.report.closeAdmissible, true)
  assert.match(verified.report.verifyDigest, /^[0-9a-f]{64}$/)
  assert.equal(verified.pending.entries.length, 2)
  assert.ok(verified.pending.entries.every((entry) => entry.class === 'not_landed' && entry.kind === 'add' && entry.sourceGone === false && typeof entry.componentCode === 'string'))
  assert.equal(Object.prototype.hasOwnProperty.call(verified.report, 'batch'), false, 'N-SWITCH: no pull-batch lane => no batch key at all')
  assert.equal(w.verifyAudits.length, 1)
  const closed = await w.recover('close', { verifyDigest: verified.report.verifyDigest })
  assert.equal(closed.closed.result, 'mixed')
  assert.equal(closed.closed.preStatus, 'partial')
  assert.equal(w.sheet.writes(), writesBefore, 'the recovery wrote no record (never a replay)')
  const row = w.executions()[0]
  assert.deepEqual([row.status, row.verified_result, row.closed_mode, row.settlement_subject], ['verified_closed', 'mixed', 'puller_verified', true])
  assert.notEqual((await w.derived()).status, 'failed_pending_recovery')
  assert.equal(w.closeAudits.length, 1)
  assert.doesNotThrow(() => (assertValuesFreeDetail ? assertValuesFreeDetail(w.closeAudits[0].detail) : null))
  // The retry: a fresh preview plans exactly the missing rows; its apply succeeds.
  const retry = await w.dryRun()
  assert.equal(retry.status, 'ready')
  const applied = await w.apply(retry.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  assert.equal(w.sheet.writes() - writesBefore, 2, 'only the two missing rows')
})

test('RV-02 the refusals, each before any close: 404 (absent / another scope, one code), NOT_UNFINISHED, UNPROVABLE (a landed row a person changed; a duplicate under an intended key), STALE (the sheet moved after the verify; a wrong / missing digest)', async () => {
  const w = await partialWorld(1)
  await expectCode(w.recover('verify', { executionId: 'exec_absent' }), { status: 404, code: CODES.EXECUTION_NOT_FOUND })
  await expectCode(w.recover('verify', { tenantId: 'tenant_rv_other' }), { status: 404, code: CODES.EXECUTION_NOT_FOUND })
  const verified = await w.recover('verify')
  // A person changes a landed row's machine cell between the verify and the close: it no longer equals the intent =>
  // diverged => UNPROVABLE (content equality decides, never the key, E08).
  const landedRow = w.sheet.rows[0]
  const original = { ...landedRow.data }
  landedRow.data = { ...landedRow.data, rawQuantity: 999 }
  const diverged = await expectCode(w.recover('close', { verifyDigest: verified.report.verifyDigest }), { status: 409, code: CODES.RECOVERY_UNPROVABLE })
  assert.deepEqual(diverged.details.reasons, ['diverged'])
  // A person deletes a landed row after the verify: the classification moved (one more not landed) => STALE.
  landedRow.data = original
  const removed = w.sheet.rows.splice(0, 1)
  await expectCode(w.recover('close', { verifyDigest: verified.report.verifyDigest }), { status: 409, code: CODES.RECOVERY_STALE })
  w.sheet.rows.unshift(...removed)
  assert.equal(w.executions()[0].status, 'partial', 'nothing closed by any refusal')
  const w2 = await partialWorld(1)
  const v2 = await w2.recover('verify')
  await expectCode(w2.recover('close', { verifyDigest: 'f'.repeat(64) }), { status: 409, code: CODES.RECOVERY_STALE })
  await expectCode(w2.recover('close', {}), { status: 409, code: CODES.RECOVERY_STALE })
  // A duplicate row under an intended key => UNPROVABLE duplicate_rows; the execution stays unfinished.
  const copy = { ...w2.sheet.rows[0], id: `${w2.sheet.rows[0].id}_dup`, data: { ...w2.sheet.rows[0].data } }
  w2.sheet.rows.push(copy)
  const refused = await expectCode(w2.recover('close', { verifyDigest: v2.report.verifyDigest }), { status: 409, code: CODES.RECOVERY_UNPROVABLE })
  assert.deepEqual(refused.details.reasons, ['duplicate_rows'])
  assert.equal(w2.executions()[0].status, 'partial')
  // Closed => NOT_UNFINISHED.
  const w3 = await partialWorld(1)
  const v3 = await w3.recover('verify')
  await w3.recover('close', { verifyDigest: v3.report.verifyDigest })
  await expectCode(w3.recover('verify'), { status: 409, code: CODES.EXECUTION_NOT_UNFINISHED, reason: 'verified_closed' })
})

test('RV-03 the report is VALUES-FREE (no component code / name / key / project number); the pending page is served only by verify and only AFTER its audit row — a refusing audit serves nothing', async () => {
  const w = await partialWorld(2)
  const verified = await w.recover('verify')
  const reportText = JSON.stringify(verified.report)
  for (const sentinel of ['D100-01', 'C200-1', 'C200-2', 'C200-3', 'Bracket', 'Plate', 'Pin', 'SubAssembly', RW_PROJECT]) assert.ok(!reportText.includes(sentinel), `report carries ${sentinel}`)
  assert.ok(JSON.stringify(verified.pending).includes('C200') || JSON.stringify(verified.pending).includes('D100'), 'the private page does carry the names')
  const auditDetail = w.verifyAudits[0]
  assert.deepEqual(Object.keys(auditDetail).sort(), ['entryCount', 'intended', 'operation', 'pageIndex', 'pendingTotal'])
  await expectCode(w.recover('verify', { auditVerifyRead: async () => { throw Object.assign(new Error('audit down'), { status: 503, code: 'AUDIT_STORE_FAILED' }) } }), { code: 'AUDIT_STORE_FAILED' })
  // close answers no page.
  const closed = await w.recover('close', { verifyDigest: verified.report.verifyDigest })
  assert.equal(Object.prototype.hasOwnProperty.call(closed, 'pending'), false)
})

test('RV-04 the pending list pages by decision index, 200 per page; verifyDigest binds the FULL classification (any page)', () => {
  const classes = Array.from({ length: 450 }, (_, i) => Object.freeze({ i: i * 2, d: 'a', k: intentModule.intentKeyDigest(`k${i}`), r: null, cls: i % 3 === 0 ? 'landed' : 'not_landed' }))
  const assessment = { classes, pendingTotal: classes.filter((item) => item.cls !== 'landed').length }
  assert.equal(assessment.pendingTotal, 300)
  const first = recovery.pendingPageOf({ assessment })
  assert.equal(first.entries.length, 200)
  assert.equal(first.pageIndex, 0)
  const second = recovery.pendingPageOf({ assessment, cursor: first.nextCursor })
  assert.equal(second.pageIndex, 1)
  assert.ok(second.entries[0].decisionIndex > first.entries[199].decisionIndex)
  assert.equal(first.entries.length + second.entries.length, assessment.pendingTotal)
  assert.equal(second.nextCursor, null)
  assert.deepEqual(recovery.pendingPageOf({ assessment, cursor: first.entries[199].decisionIndex }).entries.map((entry) => entry.decisionIndex), second.entries.map((entry) => entry.decisionIndex), 'the cursor is the last decision index of the previous page')
  assert.throws(() => recovery.pendingPageOf({ assessment, cursor: -1 }), /pageCursor/)
  const base = { executionId: 'exec_x', intentDigest: 'a'.repeat(32), assessment: { result: 'mixed', counts: { landed: 1 }, landedRecordIds: [], possiblyLandedRecordIds: [], landedAddCount: 1, verifiedCreatedRows: 0, rowsDigest: 'r' } }
  assert.notEqual(recovery.verifyDigestOf(base), recovery.verifyDigestOf({ ...base, assessment: { ...base.assessment, rowsDigest: 's' } }))
  assert.notEqual(recovery.verifyDigestOf(base), recovery.verifyDigestOf({ ...base, assessment: { ...base.assessment, verifiedCreatedRows: 1 } }))
})

test('RV-05 the close answers what was decided UNDER THE LOCKS: a zombie finished the run partial -> aborted after the verify => preStatus aborted (never the verify\'s partial)', async () => {
  const w = await partialWorld(1)
  const verified = await w.recover('verify')
  assert.equal(verified.report.preStatus, 'partial')
  await w.env.db.updateRow(T.execution, { status: 'aborted' }, { id: w.executions()[0].id })
  const closed = await w.recover('close', { verifyDigest: verified.report.verifyDigest })
  assert.equal(closed.closed.preStatus, 'aborted')
  assert.equal(w.executions()[0].pre_close_status, 'aborted')
})

test('NS-01 (N-SWITCH, rebaseline (a)(b)) the pull-batch lane ON with a ledger: readBatchLink read, the report carries `batch`, the close hands batchWithin the UNPREFIXED digest; OFF: zero ledger IO and no `batch` key', async () => {
  const w = await partialWorld(1)
  const ledgerCalls = []
  const label = 'L-1'
  const execution = w.executions()[0]
  const ledger = {
    async readBatchLink(input) { ledgerCalls.push(['readBatchLink', input.refreshExecutionId]); return { linked: true, batchId: 'pbat_1', batchNo: 1, label, status: 'open', linkFinished: true, linkCreatedRowCount: 0, sourceDigest: execution.pull_batch_source_digest } },
    async batchWithin(trx, input) { ledgerCalls.push(['batchWithin', input]); return 'kept_open' },
    async readSheetState() { throw new Error('the recovery never touches the _sheet row (N-INSTALLING)') },
    async allocate() { throw new Error('never') },
    async finish() { throw new Error('never') },
  }
  const lane = { enabled: true, store: ledger, band: null, tenantId: RW_TENANT }
  const verified = await w.recover('verify', { pullBatch: lane })
  assert.deepEqual(verified.report.batch, { linked: true, batchNo: 1, statusSeen: 'open', verifiedCreatedRows: 0 })
  const closed = await w.recover('close', { pullBatch: lane, verifyDigest: verified.report.verifyDigest })
  assert.equal(closed.closed.batchOutcome, 'kept_open')
  const within = ledgerCalls.find(([name]) => name === 'batchWithin')[1]
  assert.equal(within.sourceDigest, execution.pull_batch_source_digest, 'unprefixed, as stored (null when the run did not stamp)')
  assert.equal(within.result, 'mixed')
  // OFF: no link read, no hook, no key.
  const off = await partialWorld(1)
  const offCalls = []
  const offLane = { enabled: false, store: { async readBatchLink() { offCalls.push('read') }, async batchWithin() { offCalls.push('within') } }, band: null, tenantId: RW_TENANT }
  const v = await off.recover('verify', { pullBatch: offLane })
  assert.equal(Object.prototype.hasOwnProperty.call(v.report, 'batch'), false)
  const c = await off.recover('close', { pullBatch: offLane, verifyDigest: v.report.verifyDigest })
  assert.equal(Object.prototype.hasOwnProperty.call(c.closed, 'batchOutcome'), false)
  assert.deepEqual(offCalls, [])
  // A link whose batch digest is not the execution's own => refused (pull_batch_moved), never closed by a puller.
  const moved = await partialWorld(1)
  const movedLane = { ...lane, store: { ...ledger, async readBatchLink() { return { linked: true, batchNo: 1, label, status: 'open', sourceDigest: 'c'.repeat(32) } } } }
  const mv = await moved.recover('verify', { pullBatch: movedLane })
  assert.ok(mv.report.refusalReasons.includes('pull_batch_moved'))
})

test('NI-01 (N-INSTALLING) the classification is band-blind: the same rows with 批次标识 band cells stripped onto the Symbol (an install ran between the failed run and its recovery) classify and digest identically when no link exists', async () => {
  const w = await partialWorld(1)
  const read = await w.env.store.readExecutionForRecovery({ tenantId: RW_TENANT, sheetId: RW_SHEET, projectNo: RW_PROJECT, executionId: w.executions()[0].id })
  const rows = await tableActions.__internals.readExistingStockPreparationRows(w.sheet.api, w.action.target, RW_PROJECT)
  const banded = rows.map((row) => Object.assign({ ...row, [EXISTING_ROW_RECORD_REF]: row[EXISTING_ROW_RECORD_REF] }, { [EXISTING_ROW_PULL_BATCH]: Object.freeze({ pullBatch: '第1批', firstPullBatch: '第1批', createdAt: null, locked: true }) }))
  const plain = recovery.assessExecutionRecovery({ read, rows, template: undefined })
  const installed = recovery.assessExecutionRecovery({ read, rows: banded, template: undefined })
  assert.equal(installed.rowsDigest, plain.rowsDigest)
  assert.deepEqual(installed.counts, plain.counts)
  assert.equal(installed.verifiedCreatedRows, 0)
})

test('CU-01 close-unverified: inspect reads the SHEET only (no source read) and answers an inspectDigest; close needs the echo, the acknowledgement and a ticket handle; it closes unknown / runbook, never settles', async () => {
  const w = await partialWorld(1)
  let sourceReads = 0
  const counting = { async read(input) { sourceReads += 1; return w.source.adapter.read(input) } }
  const inspected = await w.recover('inspect', { sourceAdapter: counting })
  assert.equal(sourceReads, 0, 'no source read')
  assert.match(inspected.report.inspectDigest, /^[0-9a-f]{64}$/)
  assert.equal(inspected.report.remaining, null)
  await expectCode(w.recover('close_unverified', { inspectDigest: 'f'.repeat(64), acknowledge: { resultUnknown: true }, runbookRef: 'TICKET-9' }), { status: 409, code: CODES.RECOVERY_STALE })
  const closed = await w.recover('close_unverified', { inspectDigest: inspected.report.inspectDigest, acknowledge: { resultUnknown: true }, runbookRef: 'TICKET-9', sourceAdapter: counting })
  assert.equal(sourceReads, 0)
  assert.deepEqual([closed.closed.result, closed.closed.closedMode, closed.closed.settled], ['unknown', 'runbook', false])
  const row = w.executions()[0]
  assert.deepEqual([row.verified_result, row.closed_mode, row.runbook_ref], ['unknown', 'runbook', 'TICKET-9'])
  assert.equal(w.closeAudits[0].mode, 'execution_closed_unverified')
})

test('RB-01 the request bodies: recover verify / close (digest required for close, cursor only on verify); close-unverified inspect / close (echo, ticket handle, the exact acknowledgement)', () => {
  assert.deepEqual(recovery.normalizeRecoverBody({ mode: 'verify', pageCursor: 4 }), { mode: 'verify', verifyDigest: null, pageCursor: 4 })
  assert.throws(() => recovery.normalizeRecoverBody({ mode: 'close' }), /verifyDigest/)
  assert.throws(() => recovery.normalizeRecoverBody({ mode: 'close', verifyDigest: 'a'.repeat(64), pageCursor: 1 }), /pageCursor/)
  assert.throws(() => recovery.normalizeRecoverBody({ mode: 'replay' }), /mode/)
  assert.throws(() => recovery.normalizeCloseUnverifiedBody({ mode: 'close', inspectDigest: 'a'.repeat(64), runbookRef: 'T 1', acknowledge: { resultUnknown: true } }), /runbookRef/)
  assert.throws(() => recovery.normalizeCloseUnverifiedBody({ mode: 'close', inspectDigest: 'a'.repeat(64), runbookRef: 'T-1', acknowledge: { resultUnknown: true, other: 1 } }), /acknowledge/)
  assert.throws(() => recovery.normalizeCloseUnverifiedBody({ mode: 'inspect', runbookRef: 'T-1' }), /runbookRef/)
  assert.deepEqual(recovery.normalizeCloseUnverifiedBody({ mode: 'close', inspectDigest: 'a'.repeat(64), runbookRef: 'T-1', acknowledge: { resultUnknown: true } }), { mode: 'close', inspectDigest: 'a'.repeat(64), runbookRef: 'T-1' })
})

test('AU-01 the close audit entry (rebaseline (i)): exception_resolve, subject = the execution, detail = depth-1 tokens / booleans / integers and ONE numeric count map; an event outside the closed map is 500', () => {
  const entry = recovery.recoveryCloseAuditEntryOf({ operation: 'execution_verified_closed', executionId: 'exec_x', result: 'mixed', preStatus: 'partial', counts: { intended: 3, landed: 2, notLanded: 1 }, changePlanOutcome: 'none', recoveredRecordCount: 0, batchOutcome: 'kept_open', transparent: false, settled: false, continuationsConsumed: 0 })
  assert.equal(entry.action, 'exception_resolve')
  assert.equal(entry.mode, 'execution_verified_closed')
  assert.equal(entry.subjectId, 'exec_x')
  for (const [key, value] of Object.entries(entry.detail)) {
    if (value && typeof value === 'object') assert.ok(Object.values(value).every((n) => typeof n === 'number'), key)
    else assert.ok(['string', 'number', 'boolean'].includes(typeof value), key)
  }
  if (assertValuesFreeDetail) assert.doesNotThrow(() => assertValuesFreeDetail(entry.detail))
  assert.throws(() => recovery.recoveryCloseAuditEntryOf({ operation: 'execution_replayed' }), /closed map/)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-execution-recovery.test.cjs', tests)
