'use strict'

// Batch-refresh step 6a-1 (S6-1; register row R-91) — the EXECUTION INTENT JOURNAL, the SELF-VERIFYING FINISH and the
// SETTLEMENT SUBJECT, hermetic. Step-6 design §3.2-§3.4 / §10 S6-1 as amended by the 2026-11-09 rebaseline (S6-1, C-3).
//   XI-01  one entry per ADD / UPDATE / INACTIVE / controlled update, none for SKIP / MANUAL_CONFIRM; field sets dedupe per
//          chunk; chunks split at 2000; the store admission (shape + digest) refuses every malformed journal.
//   XI-02  values-free (sentinels); the digest is stable (key order); RUN ids and 批次标识's band ids — logical and
//          physical — never reach a field set, even when the caller's band or the decision carries them.
//   XI-03  every row of the §3.5.1 classifier table and the aggregation (landed / nothing_landed / mixed / unprovable).
//   KIT-01 the refresh-store kit models migration 106 (columns, the NOT NULL DEFAULT true, the enum CHECKs parsed from the
//          SQL, every hand-modelled shape CHECK named in the SQL and enforced); a database without 106 fails the consult 503.
//   XS-01  the begin is ONE transaction (execution row, then one insert per chunk, in order); a failing chunk insert leaves
//          no execution row and no chunk; a missing / malformed journal or a malformed 批次标识 digest is 500 before any
//          statement; the digest is stored only when given.
//   XS-02  (a) an unbound failed / aborted 0/0 run closes verified_closed / nothing_landed / self_verified, TRANSPARENT,
//          with its audit event inside the finish transaction (the hook optional; its failure rolls the finish back);
//          (c) a legacy row without a journal finishes as before. (b) / (P12): CP-S09 in the change-plan store suite.
//   XS-03  NOT self-verified: attempted 1; attempted null / absent; written 1; partial 0/0; and at the apply lib, a throw
//          without `writerPhase === 'pre_io'` — a mid-run error carrying `details.partial === false` included.
//   XA-01  the governed apply journals THIS in-lease recompute: the source order (after computeDryRun, before the begin,
//          never the token), and the begin's journal re-admits against the begin's own plan digest.
//   XD-01  a verified_closed landed subject behind six transparent closes is still in the consult and derives
//          executed_pending_settlement (and a succeeded subject too); the settling computation names the subject.
//   XD-02  a plan-bound nothing_landed close is never transparent (the derivation refuses the shape; the store stores true).
//   XD-03  a transparent close never writes the settled columns; the previous subject's settlement still holds (complete).
//   XD-04  `settlementSubject === false` on any other shape is unreadable (fail closed).
//   AUD-01 the route's system-event map: change_plan_invalidated byte-identical to PR-8's row; execution_self_verified;
//          an unknown event is 500.
// Synthetic values only.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const kit = require(path.join(__dirname, 'support', 'stock-preparation-refresh-store-kit.cjs'))
const intentModule = require(path.join(LIB, 'stock-preparation-execution-intent.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const refreshState = require(path.join(LIB, 'stock-preparation-refresh-state.cjs'))
const lanes = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))
const decisions = require(path.join(LIB, 'stock-preparation-refresh-decisions.cjs'))
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { DECISIONS, EXISTING_ROW_RECORD_REF, RUN_FIELD_IDS } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const { STOCK_PREPARATION_PULL_BATCH_FIELD_IDS } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const { buildExecutionIntent, assertExecutionIntent, classifyExecutionIntent, intentKeyDigest, bandDigest, INTENT_CHUNK_SIZE } = intentModule
const { REFRESH_STORE_TABLES: T, REFRESH_STORE_ERROR_CODES: CODES, createStockPreparationContinuationStore } = storeModule
const { readProjectRefreshState } = refreshState

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_xi_a'
const SHEET = 'sheet_xi_a'
const PROJECT = 'PRJ-XI-1'
const PULLER = 'u_xi_puller'
const SCOPE = Object.freeze({ tenantId: TENANT, sheetId: SHEET, projectNo: PROJECT })
const GUARD = Object.freeze({ leaseRunId: 'run_xi', leaseId: 'lease_xi', fencingEpoch: 1, generation: 1, generationToken: 'g_xi' })
const FREE_LOCK = { state: { present: true, leaseHeld: false, leaseLive: false }, generation: { generationToken: 'g_free', fencingEpoch: 1, leaseId: null } }
const PLAN_DIGEST = 'a'.repeat(64)
const SENTINELS = ['SENTINEL-KEY-XI', 'SENTINEL-NAME-XI', 'SENTINEL-MAT-XI', 'SENTINEL-REC-NOT']
const PHYSICAL_BAND_ID = 'fld_0123456789abcdef01234567'

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

function key(n) {
  return `{"k":"SENTINEL-KEY-XI-${n}"}`
}

function addDecision(n, extra = {}) {
  return { decision: DECISIONS.ADD, idempotencyKey: key(n), record: { idempotencyKey: key(n), componentName: `SENTINEL-NAME-XI-${n}`, material: 'SENTINEL-MAT-XI', rawQuantity: n, lastPlmRefreshRunId: 'run', lastPlmRefreshAt: '2026-11-09T00:00:00.000Z', lastPlmRefreshDecision: 'add', ...extra } }
}

function updateDecision(n, patch) {
  return { decision: DECISIONS.UPDATE, idempotencyKey: key(n), patch: { ...patch, lastPlmRefreshRunId: 'run', lastPlmRefreshDecision: 'update' }, changedFields: Object.keys(patch) }
}

function inactiveDecision(n) {
  return { decision: DECISIONS.INACTIVE, idempotencyKey: key(n), patch: { active: false, lastPlmRefreshRunId: 'run', lastPlmRefreshDecision: 'inactive' } }
}

function existingRow(n, fields, { id = `rec_${n}`, version = 3 } = {}) {
  const row = { idempotencyKey: key(n), ...fields }
  row[EXISTING_ROW_RECORD_REF] = Object.freeze({ id, version })
  return row
}

function mixedPlan() {
  return {
    decisions: [
      addDecision(1),
      { decision: DECISIONS.SKIP, idempotencyKey: key(2) },
      updateDecision(3, { rawQuantity: 7, material: 'SENTINEL-MAT-XI' }),
      { decision: DECISIONS.MANUAL_CONFIRM, idempotencyKey: key(4) },
      inactiveDecision(5),
      // A controlled update (PR-8): exactly the plan's fields + the RUN stamps.
      updateDecision(6, { componentName: 'SENTINEL-NAME-XI-6b' }),
      // An UPDATE with no expected-record entry (the writer patches it unfenced): pre null.
      updateDecision(7, { rawQuantity: 9 }),
    ],
  }
}

function mixedExpected() {
  return new Map([
    [key(3), { id: 'rec_3', version: 4, row: existingRow(3, { rawQuantity: 6, material: 'M-OLD-NOT' }, { id: 'rec_3', version: 4 }) }],
    [key(5), { id: 'rec_5', version: 2, row: existingRow(5, { active: true }, { id: 'rec_5', version: 2 }) }],
    [key(6), { id: 'rec_6', version: 9, row: existingRow(6, { componentName: 'SENTINEL-REC-NOT' }, { id: 'rec_6', version: 9 }) }],
  ])
}

async function world({ migration106 = true } = {}) {
  const clock = kit.createClock('2026-11-09T00:00:00.000Z')
  const db = kit.createFakeRefreshDb({ clock, migration106 })
  let n = 0
  const store = createStockPreparationContinuationStore({ db, now: clock.now, idGenerator: (kind) => `${kind}_${String((n += 1)).padStart(4, '0')}` })
  const audits = []
  const auditWithin = async (trx, event) => { audits.push({ trx, event: JSON.parse(JSON.stringify(event)) }) }
  return { clock, db, store, audits, auditWithin }
}

function beginInput(extra = {}) {
  return { ...SCOPE, lane: 'small_apply', guard: GUARD, tokenRevision: 'rev_xi', planDigest: PLAN_DIGEST, plannedCounts: {}, refreshBinding: { continuations: [] }, startedBy: PULLER, intent: kit.emptyIntentFor(PLAN_DIGEST), ...extra }
}

async function expectError(promise, { status, code, reason, field }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a throw (${code})`)
  if (status !== undefined) assert.equal(caught.status, status, `${caught.code}: ${caught.message}`)
  if (code !== undefined) assert.equal(caught.code, code, `${caught.code}: ${caught.message} ${JSON.stringify(caught.details)}`)
  if (reason !== undefined) assert.equal(caught.details && caught.details.reason, reason, JSON.stringify(caught.details))
  if (field !== undefined) assert.equal(caught.details && caught.details.field, field, JSON.stringify(caught.details))
  return caught
}

function consultOf(w, { lock = FREE_LOCK, pilot = { enabled: true } } = {}) {
  return w.store.readGovernanceRows(SCOPE).then((rows) => ({
    ok: true,
    pilot,
    continuations: rows.continuations,
    holds: rows.holds,
    state: rows.states.find((row) => row.sheetId === SHEET && row.projectNo === PROJECT) || null,
    executions: rows.executions,
    changePlans: rows.changePlans,
    lock,
  }))
}

async function selfVerifiedClose(w, status = 'aborted') {
  const execution = await w.store.beginExecution(beginInput())
  w.clock.advance(1000)
  await w.store.finishExecution({ ...SCOPE, executionId: execution.id, status, written: 0, attemptedWrites: 0 })
  return execution
}

// A `verified_closed / landed` subject (step 6a-2's puller close shape), seeded directly (S6-2 writes it).
function seedLandedSubject(w, id, startedAt) {
  const at = new Date(startedAt)
  w.db.tables.get(T.execution).set(id, {
    id, tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, write_scope_key: `sheet:${SHEET}`, lane: 'small_apply',
    lease_run_id: 'run_seed', lease_id: 'lease_seed', fencing_epoch: 1, generation: 1, generation_token: 'g_seed', token_revision: 'rev', plan_digest: PLAN_DIGEST,
    planned_counts: {}, refresh_binding: { continuations: [], changePlanId: null, holdSetFingerprint: null }, status: 'verified_closed', started_by: PULLER, started_at: at,
    finished_at: at, written: null, attempted_writes: null, counts: null, abort_code: null, error_codes: null, verified_by: PULLER, verified_at: at, verified_result: 'landed',
    created_at: at, updated_at: at, intent_version: 1, intent_digest: 'b'.repeat(32), intent_entry_count: 1, pull_batch_source_digest: null, pre_close_status: 'running',
    closed_mode: 'puller_verified', verify_summary: null, verify_lease_run_id: 'run_r', verify_fencing_epoch: 2, runbook_ref: null, settlement_subject: true,
  })
}

// ── XI-01 ────────────────────────────────────────────────────────────────────────────────────────

test('XI-01 one entry per ADD / UPDATE / INACTIVE / controlled update (none for SKIP / MANUAL_CONFIRM); per-chunk field sets dedupe; chunks split at 2000; the admission refuses every malformed journal', () => {
  const intent = buildExecutionIntent({ plan: mixedPlan(), planDigest: PLAN_DIGEST, expectedRecords: mixedExpected() })
  assert.equal(intent.version, 1)
  assert.equal(intent.entryCount, 5)
  assert.equal(intent.chunks.length, 1)
  const [chunk] = intent.chunks
  assert.deepEqual(chunk.entries.map((entry) => [entry.i, entry.d]), [[0, 'a'], [2, 'u'], [4, 'x'], [5, 'u'], [6, 'u']])
  const [add, update, inactive, controlled, unfenced] = chunk.entries
  assert.deepEqual([add.r, add.v, add.pre], [null, null, null], 'ADD: no expected record, no pre')
  assert.deepEqual([update.r, update.v], ['rec_3', 4])
  assert.deepEqual([inactive.r, inactive.v], ['rec_5', 2])
  assert.deepEqual([controlled.r, controlled.v], ['rec_6', 9])
  assert.deepEqual([unfenced.r, unfenced.v, unfenced.pre], [null, null, null], 'an UPDATE without an expected-record entry has no pre')
  assert.deepEqual(chunk.fieldsets[add.f], ['componentName', 'idempotencyKey', 'material', 'rawQuantity'])
  assert.deepEqual(chunk.fieldsets[update.f], ['material', 'rawQuantity'])
  assert.deepEqual(chunk.fieldsets[inactive.f], ['active'])
  assert.deepEqual(chunk.fieldsets[controlled.f], ['componentName'])
  assert.deepEqual(chunk.fieldsets[unfenced.f], ['rawQuantity'])
  assert.equal(chunk.fieldsets.length, 5)
  // Dedupe: two UPDATEs with the same compared band share one field set.
  const twin = buildExecutionIntent({ plan: { decisions: [updateDecision(1, { rawQuantity: 2 }), updateDecision(2, { rawQuantity: 3 })] }, planDigest: PLAN_DIGEST })
  assert.equal(twin.chunks[0].fieldsets.length, 1)
  assert.deepEqual(twin.chunks[0].entries.map((entry) => entry.f), [0, 0])
  // 2000 per chunk: 4501 ADDs => 2000 + 2000 + 501, in decision order, each chunk with its own field sets.
  const big = buildExecutionIntent({ plan: { decisions: Array.from({ length: 4501 }, (_, index) => addDecision(index)) }, planDigest: PLAN_DIGEST })
  assert.equal(INTENT_CHUNK_SIZE, 2000)
  assert.deepEqual(big.chunks.map((entry) => [entry.chunkIndex, entry.entryCount]), [[0, 2000], [1, 2000], [2, 501]])
  assert.equal(big.chunks[2].entries[0].i, 4000)
  assert.equal(big.entryCount, 4501)
  assert.doesNotThrow(() => assertExecutionIntent(big, { planDigest: PLAN_DIGEST }))
  // Zero decisions: zero chunks, a digest all the same.
  const empty = buildExecutionIntent({ plan: { decisions: [] }, planDigest: PLAN_DIGEST })
  assert.deepEqual([empty.entryCount, empty.chunks.length], [0, 0])
  assert.match(empty.digest, /^[0-9a-f]{32}$/)
  // The admission: the digest is bound to the plan digest; every malformed shape is refused by field.
  const ok = JSON.parse(JSON.stringify(intent))
  assert.doesNotThrow(() => assertExecutionIntent(ok, { planDigest: PLAN_DIGEST }))
  const refusals = [
    [undefined, 'intent'],
    [{ ...ok, version: 2 }, 'intent.version'],
    [{ ...ok, digest: 'nothex' }, 'intent.digest'],
    [{ ...ok, entryCount: 4 }, 'intent.entryCount'],
    [{ ...ok, chunks: [{ ...ok.chunks[0], chunkIndex: 1 }] }, 'intent.chunks'],
    [{ ...ok, chunks: [{ ...ok.chunks[0], entryCount: 9 }] }, 'intent.chunks.entryCount'],
    [{ ...ok, chunks: [{ ...ok.chunks[0], fieldsets: [...ok.chunks[0].fieldsets.slice(0, 4), ['pullBatch']] }] }, 'intent.chunks.fieldsets'],
    [{ ...ok, chunks: [{ ...ok.chunks[0], entries: [{ ...ok.chunks[0].entries[0], value: 'x' }, ...ok.chunks[0].entries.slice(1)] }] }, 'intent.chunks.entries'],
    [{ ...ok, chunks: [{ ...ok.chunks[0], entries: [{ ...ok.chunks[0].entries[0], r: 'rec_x', v: 1 }, ...ok.chunks[0].entries.slice(1)] }] }, 'intent.chunks.entries'],
  ]
  for (const [bad, field] of refusals) {
    assert.throws(() => assertExecutionIntent(bad, { planDigest: PLAN_DIGEST }), (error) => error.status === 500 && error.code === CODES.INPUT_INVALID && error.details.field === field, field)
  }
  assert.throws(() => assertExecutionIntent(ok, { planDigest: 'b'.repeat(64) }), (error) => error.details.field === 'intent.digest', 'a journal of another plan')
  assert.throws(() => buildExecutionIntent({ plan: {}, planDigest: PLAN_DIGEST }), (error) => error.details.field === 'plan')
  assert.throws(() => buildExecutionIntent({ plan: { decisions: [] }, planDigest: PLAN_DIGEST, expectedRecords: {} }), (error) => error.details.field === 'expectedRecords')
})

// ── XI-02 ────────────────────────────────────────────────────────────────────────────────────────

test('XI-02 values-free (sentinels in keys and cells never appear); the digest is stable; RUN ids and the 批次标识 band ids (logical and physical) never reach a field set', () => {
  const intent = buildExecutionIntent({ plan: mixedPlan(), planDigest: PLAN_DIGEST, expectedRecords: mixedExpected() })
  const text = JSON.stringify(intent)
  for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `the journal carries a value (${sentinel})`)
  for (const entry of intent.chunks[0].entries) {
    assert.match(entry.k, /^[0-9a-f]{32}$/)
    assert.match(entry.post, /^[0-9a-f]{32}$/)
  }
  assert.equal(intent.chunks[0].entries[0].k, intentKeyDigest(key(1)))
  // Stable: the same plan with its record keys in another order digests the same.
  const reordered = mixedPlan()
  reordered.decisions[0] = { ...reordered.decisions[0], record: Object.fromEntries(Object.entries(reordered.decisions[0].record).reverse()) }
  assert.equal(buildExecutionIntent({ plan: reordered, planDigest: PLAN_DIGEST, expectedRecords: mixedExpected() }).digest, intent.digest)
  // A changed value moves the digest (the post band), a changed plan digest moves it too.
  const moved = mixedPlan()
  moved.decisions[0].record.rawQuantity = 99
  assert.notEqual(buildExecutionIntent({ plan: moved, planDigest: PLAN_DIGEST, expectedRecords: mixedExpected() }).digest, intent.digest)
  assert.notEqual(buildExecutionIntent({ plan: mixedPlan(), planDigest: 'b'.repeat(64), expectedRecords: mixedExpected() }).digest, intent.digest)
  // Band ids in the decision (logical AND physical) and a pack declaration naming them: never compared.
  const hostile = { decisions: [addDecision(1, { pullBatch: '第1批', firstPullBatch: '第1批', [PHYSICAL_BAND_ID]: '第1批' }), updateDecision(2, { pullBatch: '第2批', rawQuantity: 3 })] }
  const installedFieldProperties = [{ fieldId: 'pullBatch', ownership: 'plm_system' }, { fieldId: PHYSICAL_BAND_ID, ownership: 'plm_system' }, { fieldId: 'ext_xi_spec', ownership: 'plm_system' }]
  const band = intentModule.intentBandOf({ installedFieldProperties })
  for (const id of [...STOCK_PREPARATION_PULL_BATCH_FIELD_IDS, PHYSICAL_BAND_ID, ...RUN_FIELD_IDS]) assert.ok(!band.has(id) || STOCK_PREPARATION_PULL_BATCH_FIELD_IDS.includes(id) === false, `${id} is not in the writer's band`)
  const hostileIntent = buildExecutionIntent({ plan: hostile, planDigest: PLAN_DIGEST, installedFieldProperties })
  const allFields = hostileIntent.chunks.flatMap((chunk) => chunk.fieldsets).flat()
  for (const id of [...STOCK_PREPARATION_PULL_BATCH_FIELD_IDS, PHYSICAL_BAND_ID, ...RUN_FIELD_IDS]) assert.ok(!allFields.includes(id), `${id} never in a field set`)
  // Even a band handed straight to the compared-set filter (the mutant's "admit" path) keeps them out.
  const permissive = new Set([...STOCK_PREPARATION_PULL_BATCH_FIELD_IDS, ...RUN_FIELD_IDS, 'rawQuantity'])
  assert.deepEqual(intentModule.__internals.comparedFieldsOf({ pullBatch: 'x', firstPullBatch: 'y', lastPlmRefreshRunId: 'r', rawQuantity: 1 }, permissive), ['rawQuantity'])
})

// ── XI-03 ────────────────────────────────────────────────────────────────────────────────────────

test('XI-03 the classifier: every row of the §3.5.1 table, and the aggregation (landed / nothing_landed / mixed / unprovable with its reasons)', () => {
  const fields = ['rawQuantity']
  const post = bandDigest({ rawQuantity: 7 }, fields)
  const pre = bandDigest({ rawQuantity: 6 }, fields)
  const chunk = (entries) => [{ chunkIndex: 0, entryCount: entries.length, entries, fieldsets: [fields] }]
  const add = (n) => ({ i: n, d: 'a', k: intentKeyDigest(key(n)), r: null, v: null, f: 0, pre: null, post })
  const upd = (n, { r = `rec_${n}`, preDigest = pre } = {}) => ({ i: n, d: 'u', k: intentKeyDigest(key(n)), r, v: r ? 3 : null, f: 0, pre: r ? preDigest : null, post })
  const row = (n, quantity, id = `rec_${n}`) => existingRow(n, { rawQuantity: quantity }, { id })
  const classOf = (entry, rows) => classifyExecutionIntent({ chunks: chunk([entry]), rows }).classes[0].cls
  assert.equal(classOf(add(1), []), 'not_landed', 'ADD, 0 rows')
  assert.equal(classOf(add(1), [row(1, 7)]), 'landed', 'ADD, 1 row, band = post')
  assert.equal(classOf(add(1), [row(1, 8)]), 'diverged', 'ADD, 1 row, otherwise')
  assert.equal(classOf(add(1), [row(1, 7), row(1, 7, 'rec_dup')]), 'duplicate', 'any, >= 2 rows')
  assert.equal(classOf(upd(2), [row(2, 7), row(2, 7, 'rec_dup')]), 'duplicate')
  assert.equal(classOf(upd(2), []), 'vanished', 'UPDATE, 0 rows')
  assert.equal(classOf(upd(2), [row(2, 7, 'rec_other')]), 'replaced', 'UPDATE, another record id')
  assert.equal(classOf(upd(2), [row(2, 7)]), 'landed', 'UPDATE, band = post')
  assert.equal(classOf(upd(2), [row(2, 6)]), 'not_landed', 'UPDATE, band = pre')
  assert.equal(classOf(upd(2), [row(2, 5)]), 'diverged', 'UPDATE, otherwise')
  assert.equal(classOf(upd(2, { r: null }), [row(2, 6)]), 'diverged', 'UPDATE, pre null and != post')
  assert.equal(classOf(upd(2, { r: null }), [row(2, 7)]), 'landed', 'UPDATE, pre null, = post')
  // landed by CONTENT, never by key or record id alone (E08): the right key and id with another value is not landed.
  assert.notEqual(classOf(upd(2), [row(2, 99)]), 'landed')
  const aggregate = (entries, rows) => classifyExecutionIntent({ chunks: chunk(entries), rows })
  assert.equal(aggregate([add(1), upd(2)], [row(1, 7), row(2, 7)]).result, 'landed')
  assert.equal(aggregate([add(1), upd(2)], [row(2, 6)]).result, 'nothing_landed')
  assert.equal(aggregate([], []).result, 'nothing_landed', 'zero entries')
  assert.equal(aggregate([add(1), upd(2)], [row(1, 7), row(2, 6)]).result, 'mixed')
  const unprovable = aggregate([add(1), upd(2), upd(3), add(4)], [row(1, 7), row(1, 7, 'rec_dup'), row(4, 1)])
  assert.equal(unprovable.result, 'unprovable')
  assert.deepEqual(unprovable.reasons, ['duplicate_rows', 'record_vanished', 'diverged'])
  assert.deepEqual(unprovable.counts, { intended: 4, landed: 0, notLanded: 0, diverged: 1, duplicate: 1, vanished: 2, replaced: 0 })
  // The classifier reads the same canonical form the writer sends (a number and its string compare equal on a number field).
  const real = buildExecutionIntent({ plan: { decisions: [updateDecision(5, { rawQuantity: 7 })] }, planDigest: PLAN_DIGEST, expectedRecords: new Map([[key(5), { id: 'rec_5', version: 3, row: existingRow(5, { rawQuantity: 6 }, { id: 'rec_5' }) }]]) })
  assert.equal(classifyExecutionIntent({ chunks: real.chunks, rows: [existingRow(5, { rawQuantity: '7' }, { id: 'rec_5' })] }).result, 'landed')
  assert.equal(classifyExecutionIntent({ chunks: real.chunks, rows: [existingRow(5, { rawQuantity: 6 }, { id: 'rec_5' })] }).result, 'nothing_landed')
})

// ── KIT-01 ───────────────────────────────────────────────────────────────────────────────────────

test('KIT-01 the kit models migration 106: the added columns (an exact count), the NOT NULL DEFAULT true, the enum CHECKs parsed from the SQL, every hand-modelled CHECK named in the SQL and enforced; without 106 the consult is 503', async () => {
  const sql = kit.readMigrationText(kit.MIGRATION_FILES.recovery)
  const schema = kit.loadSchema()
  const execution = schema[T.execution]
  for (const column of ['intent_version', 'intent_digest', 'intent_entry_count', 'pull_batch_source_digest', 'pre_close_status', 'closed_mode', 'verify_summary', 'verify_lease_run_id', 'verify_fencing_epoch', 'runbook_ref', 'settlement_subject']) {
    assert.ok(execution.columns[column], column)
  }
  assert.deepEqual(execution.columns.settlement_subject, { type: 'BOOLEAN', primaryKey: false, notNull: true, default: { kind: 'literal', value: true } })
  assert.ok(schema[T.changePlan].columns.recovered_from_change_plan_id)
  assert.ok(schema[T.intent].columns.entries.notNull && schema[T.intent].columns.fieldsets.notNull)
  assert.deepEqual(execution.enums.find((entry) => entry.column === 'closed_mode').values, storeModule.CLOSED_MODES.slice())
  assert.deepEqual(execution.enums.find((entry) => entry.column === 'pre_close_status').values, storeModule.PRE_CLOSE_STATUSES.slice())
  assert.ok(schema[T.intent].enums.some((entry) => entry.unique && entry.unique.join(',') === 'execution_id,chunk_index'))
  const modelled = kit.SHAPE_CHECKS.filter((check) => check.migration106)
  assert.equal(modelled.length, 7)
  for (const check of modelled) assert.ok(sql.includes(`ADD CONSTRAINT ${check.name}\n`) || sql.includes(`CONSTRAINT ${check.name}\n`), `${check.name} is in the SQL`)
  for (const match of sql.matchAll(/ADD CONSTRAINT (\S+)\n/g)) {
    const enumModelled = execution.enums.some((entry) => entry.name === match[1])
    assert.ok(enumModelled || modelled.some((check) => check.name === match[1]), `${match[1]} is modelled by the kit`)
  }
  // PostgreSQL truncates identifiers to 63 bytes (NAMEDATALEN - 1): a longer constraint / index name would be stored under
  // a name no `DROP CONSTRAINT IF EXISTS` of this file — and no code or test naming it — ever matches (caught on real PG).
  for (const match of sql.matchAll(/\b(?:CONSTRAINT|INDEX IF NOT EXISTS|TABLE IF NOT EXISTS)\s+([a-z_0-9]+)/g)) {
    assert.ok(Buffer.byteLength(match[1]) <= 63, `${match[1]} is ${Buffer.byteLength(match[1])} bytes (PostgreSQL keeps 63)`)
  }
  // The conventions: DROP IF EXISTS before every ADD CONSTRAINT; the CREATE TABLE body closes with "\n);"; up-only; no BIGINT.
  assert.equal((sql.match(/DROP CONSTRAINT IF EXISTS/g) || []).length, (sql.match(/ADD CONSTRAINT/g) || []).length)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS integration_stock_prep_refresh_execution_intent \([\s\S]*?\n\);/)
  assert.match(sql, /up-only/)
  assert.doesNotMatch(sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n'), /\bBIGINT\b|\bDROP\s+TABLE\b/i)
  assert.match(sql, /RunMigrations 0/)
  // Each hand-modelled CHECK is enforced (23514 under its own name) on a row of the wrong shape.
  const w = await world()
  const execution0 = await w.store.beginExecution(beginInput())
  const rowNow = () => w.db.rows(T.execution).find((row) => row.id === execution0.id)
  const bad = [
    ['integration_stock_prep_refresh_execution_intent_shape_check', { intent_digest: null }],
    ['integration_stock_prep_refresh_execution_batch_digest_check', { pull_batch_source_digest: 'small:' + 'a'.repeat(32) }],
    ['integration_stock_prep_refresh_execution_close_shape_check', { status: 'verified_closed', verified_at: new Date(), finished_at: new Date(), verified_result: 'landed' }],
    ['integration_stock_prep_refresh_execution_runbook_shape_check', { status: 'verified_closed', verified_at: new Date(), finished_at: new Date(), verified_result: 'landed', closed_mode: 'runbook', pre_close_status: 'running' }],
    ['integration_stock_prep_refresh_execution_self_verified_check', { status: 'verified_closed', verified_at: new Date(), finished_at: new Date(), verified_result: 'nothing_landed', closed_mode: 'self_verified', pre_close_status: 'aborted', written: 1, attempted_writes: 1 }],
    ['integration_stock_prep_refresh_execution_subject_check', { settlement_subject: false }],
  ]
  for (const [name, set] of bad) {
    await expectError(w.db.updateRow(T.execution, set, { id: execution0.id }), {}).then((error) => assert.equal(error.constraint, name, name))
    assert.equal(rowNow().status, 'running')
  }
  await expectError(w.db.insertOne(T.intent, { id: 'x:0', execution_id: 'x', chunk_index: 0, tenant_id: TENANT, sheet_id: SHEET, project_no: PROJECT, write_scope_key: 'k', entry_count: 2001, entries: [], fieldsets: [] }), {})
    .then((error) => assert.equal(error.constraint, 'integration_stock_prep_refresh_execution_intent_chunk_check'))
  // A database WITHOUT 106: the consult's settlement-subject read is 42703 => 503 read_executions (the 104 posture).
  const old = await world({ migration106: false })
  await expectError(old.store.readGovernanceRows(SCOPE), { status: 503, code: CODES.STORE_FAILED })
})

// ── XS-01 ────────────────────────────────────────────────────────────────────────────────────────

test('XS-01 the begin is ONE transaction — the execution row, then one insert per chunk in order; a failing chunk insert leaves nothing; a missing / malformed journal or 批次标识 digest is 500 before any statement', async () => {
  const plan = { decisions: Array.from({ length: 4100 }, (_, index) => addDecision(index)) }
  const intent = buildExecutionIntent({ plan, planDigest: PLAN_DIGEST })
  {
    const w = await world()
    w.db.log.length = 0
    const execution = await w.store.beginExecution(beginInput({ intent, pullBatchSourceDigest: 'c'.repeat(32) }))
    assert.deepEqual(w.db.log.map(([method, args]) => `${method}:${args && args.table ? String(args.table).replace('integration_stock_prep_', '') : ''}`), [
      'transaction:', 'trx.insertOne:refresh_execution', 'trx.insertOne:refresh_execution_intent', 'trx.insertOne:refresh_execution_intent', 'trx.insertOne:refresh_execution_intent', 'commit:',
    ])
    const row = w.db.rows(T.execution)[0]
    assert.deepEqual([row.intent_version, row.intent_digest, row.intent_entry_count, row.pull_batch_source_digest, row.settlement_subject], [1, intent.digest, 4100, 'c'.repeat(32), true])
    const chunks = w.db.rows(T.intent).sort((a, b) => a.chunk_index - b.chunk_index)
    assert.deepEqual(chunks.map((chunk) => [chunk.id, chunk.execution_id, chunk.chunk_index, chunk.entry_count, chunk.write_scope_key]), [
      [`${execution.id}:0`, execution.id, 0, 2000, row.write_scope_key], [`${execution.id}:1`, execution.id, 1, 2000, row.write_scope_key], [`${execution.id}:2`, execution.id, 2, 100, row.write_scope_key],
    ])
    // The stored chunks re-admit against the row's own digest (step 6a-2 reads them back).
    assert.doesNotThrow(() => assertExecutionIntent({ version: row.intent_version, digest: row.intent_digest, entryCount: row.intent_entry_count, chunks: chunks.map((chunk) => ({ chunkIndex: chunk.chunk_index, entryCount: chunk.entry_count, entries: chunk.entries, fieldsets: chunk.fieldsets })) }, { planDigest: row.plan_digest }))
    // The consult answer never carries the 批次标识 digest (an off feature stays invisible; S6-2 reads the row itself).
    assert.ok(!JSON.stringify(await w.store.readGovernanceRows(SCOPE)).includes('c'.repeat(32)))
  }
  {
    // Chunk 1 of 3 fails: rolled back — no execution row, no chunk; 503 intent_insert.
    const w = await world()
    let chunkInserts = 0
    w.db.faults.insertOne = (args) => (args.table === T.intent && (chunkInserts += 1) === 2 ? Object.assign(new Error('synthetic chunk failure'), { code: '57014' }) : null)
    await expectError(w.store.beginExecution(beginInput({ intent })), { status: 503, code: CODES.STORE_FAILED })
    w.db.faults.insertOne = undefined
    assert.equal(w.db.rows(T.execution).length, 0)
    assert.equal(w.db.rows(T.intent).length, 0)
  }
  {
    // The switch off / not stamping: no digest key => NULL.
    const w = await world()
    await w.store.beginExecution(beginInput())
    assert.equal(w.db.rows(T.execution)[0].pull_batch_source_digest, null)
  }
  for (const [extra, field] of [
    [{ intent: undefined }, 'intent'],
    [{ intent: { ...intent, digest: 'd'.repeat(32) } }, 'intent.digest'],
    [{ planDigest: 'b'.repeat(64), intent }, 'intent.digest'],
    [{ pullBatchSourceDigest: 'small:' + 'c'.repeat(32) }, 'pullBatchSourceDigest'],
    [{ pullBatchSourceDigest: 'C'.repeat(32) }, 'pullBatchSourceDigest'],
  ]) {
    const w = await world()
    w.db.log.length = 0
    await expectError(w.store.beginExecution(beginInput(extra)), { status: 500, code: CODES.INPUT_INVALID, field })
    assert.deepEqual(w.db.log, [], `${field}: refused before any statement`)
  }
})

// ── XS-02 / XS-03 ────────────────────────────────────────────────────────────────────────────────

test('XS-02 an unbound failed / aborted 0/0 run closes verified_closed / nothing_landed / self_verified, TRANSPARENT, its audit event inside the finish transaction (the hook optional; its failure rolls the finish back); a legacy row without a journal finishes as before', async () => {
  for (const status of ['failed', 'aborted']) {
    const w = await world()
    const execution = await w.store.beginExecution(beginInput({ intent: buildExecutionIntent({ plan: mixedPlan(), planDigest: PLAN_DIGEST, expectedRecords: mixedExpected() }) }))
    w.db.log.length = 0
    const done = await w.store.finishExecution({ ...SCOPE, executionId: execution.id, status, written: 0, attemptedWrites: 0, abortCode: status === 'aborted' ? 'STOCK_PREP_CHANGE_PLAN_STALE' : undefined, errorCodes: ['X'] }, { auditWithin: w.auditWithin })
    assert.equal(done.selfVerified, true)
    const row = w.db.rows(T.execution)[0]
    assert.deepEqual(
      [row.status, row.verified_result, row.closed_mode, row.pre_close_status, row.settlement_subject, row.verified_by, row.written, row.attempted_writes],
      ['verified_closed', 'nothing_landed', 'self_verified', status, false, null, 0, 0], status,
    )
    assert.ok(row.verified_at && row.finished_at)
    assert.deepEqual(row.verify_summary, { selfVerified: true, finishStatus: status, intendedEntries: 5 })
    assert.deepEqual(row.error_codes, ['X'])
    assert.deepEqual(w.audits.map((entry) => entry.event), [{ operation: 'execution_self_verified', executionId: execution.id, finishStatus: status, changePlanBound: false, intendedEntries: 5 }])
    assert.equal(w.audits[0].trx, w.db.lastTransactionHandle, 'appended on the finish transaction')
    assert.ok(!w.db.statements('trx.').some(([method, table]) => table === T.state), 'a non-settling finish never touches the state row')
    // The derived state: not 失败待恢复; a project with nothing else is complete (not settled — no clean computation yet).
    assert.equal(readProjectRefreshState(await consultOf(w)).status, 'complete')
  }
  {
    // No hook: still closed (provable bookkeeping, never refused for want of it).
    const w = await world()
    await selfVerifiedClose(w)
    assert.equal(w.db.rows(T.execution)[0].status, 'verified_closed')
  }
  {
    // A failing hook rolls the finish back: the row stays running (E09).
    const w = await world()
    const execution = await w.store.beginExecution(beginInput())
    await expectError(w.store.finishExecution({ ...SCOPE, executionId: execution.id, status: 'aborted', written: 0, attemptedWrites: 0 }, { auditWithin: async () => { throw new Error('audit down') } }), { status: 503, code: CODES.STORE_FAILED })
    assert.equal(w.db.rows(T.execution)[0].status, 'running')
  }
  {
    // A legacy row begun before 106 (no journal): finishes `aborted` as before — never self-verified.
    const w = await world()
    const execution = await w.store.beginExecution(beginInput())
    const row = w.db.tables.get(T.execution).get(execution.id)
    w.db.tables.get(T.execution).set(execution.id, { ...row, intent_version: null, intent_digest: null, intent_entry_count: null })
    const done = await w.store.finishExecution({ ...SCOPE, executionId: execution.id, status: 'aborted', written: 0, attemptedWrites: 0 })
    assert.equal(done.selfVerified, false)
    assert.equal(w.db.rows(T.execution)[0].status, 'aborted')
  }
})

test('XS-03 NOT self-verified: attempted 1; attempted null / absent; written 1; partial 0/0 — and at the apply lib a throw without writerPhase === pre_io (a mid-run error carrying details.partial === false included) reports no counts', async () => {
  const cases = [
    ['failed', { written: 0, attemptedWrites: 1 }, 'failed'],
    ['failed', { written: 0, attemptedWrites: null }, 'failed'],
    ['aborted', { written: 0 }, 'aborted'],
    ['aborted', {}, 'aborted'],
    ['failed', { written: 1, attemptedWrites: 1 }, 'failed'],
    ['partial', { written: 0, attemptedWrites: 0 }, 'partial'],
  ]
  for (const [status, counts, expected] of cases) {
    const w = await world()
    const execution = await w.store.beginExecution(beginInput())
    const done = await w.store.finishExecution({ ...SCOPE, executionId: execution.id, status, ...counts })
    assert.equal(done.selfVerified, false, JSON.stringify(counts))
    const row = w.db.rows(T.execution)[0]
    assert.deepEqual([row.status, row.closed_mode, row.settlement_subject], [expected, null, true], `${status} ${JSON.stringify(counts)}`)
    assert.equal(readProjectRefreshState(await consultOf(w)).status, 'failed_pending_recovery')
  }
  // The apply lib's best-effort failed finish: the marker, never `partial: false`, decides whether 0 / 0 is reported.
  const finishOf = async (error) => {
    const calls = []
    await tableActions.__internals.finishExecutionFailedBestEffort({ store: { finishExecution: async (input) => { calls.push(input) } } }, { ...SCOPE, executionId: 'exec_x' }, error, null)
    return calls[0]
  }
  const midRun = Object.assign(new Error('a row this plan was computed against changed'), { code: 'STOCK_PREP_CHANGE_PLAN_STALE', details: { reason: 'machine_columns_moved', partial: false } })
  assert.deepEqual(await finishOf(midRun), { ...SCOPE, executionId: 'exec_x', status: 'failed', errorCodes: ['STOCK_PREP_CHANGE_PLAN_STALE'] })
  assert.deepEqual(await finishOf(new Error('anything')), { ...SCOPE, executionId: 'exec_x', status: 'failed', errorCodes: ['apply_threw'] })
  const preIo = Object.assign(new Error('governance'), { code: 'STOCK_PREP_REFRESH_GOVERNANCE_UNCONSULTED', writerPhase: 'pre_io', details: { reason: 'governance_stale', partial: false } })
  assert.deepEqual(await finishOf(preIo), { ...SCOPE, executionId: 'exec_x', status: 'failed', errorCodes: ['STOCK_PREP_REFRESH_GOVERNANCE_UNCONSULTED'], written: 0, attemptedWrites: 0 })
  assert.equal((await finishOf(Object.assign(new Error('x'), { writerPhase: 'pre-io' }))).attemptedWrites, undefined, 'only the exact literal')
})

// ── XA-01 ────────────────────────────────────────────────────────────────────────────────────────

test('XA-01 the governed apply journals THIS in-lease recompute: built after computeDryRun and the refusals, before the begin, from dryRun (never the token); bound to the begin\'s plan digest; the 批次标识 digest only from a ready stamping run', () => {
  const source = fs.readFileSync(path.join(LIB, 'stock-preparation-table-actions.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const body = source.slice(source.indexOf('async function applyStockPreparationAction('), source.indexOf('\nmodule.exports = {'))
  const at = (needle) => {
    const index = body.indexOf(needle)
    assert.ok(index >= 0, needle)
    return index
  }
  const build = at('buildExecutionIntent({')
  assert.ok(at('const dryRun = await computeDryRun(') < build)
  assert.ok(at('assertProductionCleanRowsWithinBound(applyGate, cleanRowCount)') < build)
  assert.ok(at('createTargetScopedRecordsApi(') < build, 'after the scoped API (a throw there leaves no row)')
  assert.ok(build < at('beginExecution({'))
  const call = body.slice(build, body.indexOf('})', build))
  assert.match(call, /plan: dryRun\.plan/)
  assert.match(call, /expectedRecords: intentExpectedRecords/)
  assert.match(body, /const intentExpectedRecords = governedApply \? expectedRecordsOf\(dryRun\) : null/)
  assert.match(call, /installedFieldProperties: dryRun\.refresh\.installedFieldProperties/)
  assert.doesNotMatch(call, /token/i)
  assert.match(body, /governedApply\s*\?\s*buildExecutionIntent\(/, 'governed only (C09: a not-governed apply journals nothing)')
  const begin = body.slice(at('beginExecution({'), body.indexOf('    : null', at('beginExecution({')))
  assert.match(begin, /planDigest: executionPlanDigest/)
  assert.match(begin, /intent: executionIntent/)
  assert.match(begin, /pullBatchRun && pullBatchRun\.evaluation\.ready && typeof pullBatchRun\.sourceDigest === 'string' \? \{ pullBatchSourceDigest: pullBatchRun\.sourceDigest \} : \{\}/)
  assert.match(body, /const executionPlanDigest = governedApply \? planDigestOf\(dryRun\.plan\) : null/)
})

// ── XD-01 … XD-04 ────────────────────────────────────────────────────────────────────────────────

test('XD-01 a verified_closed / landed subject behind six transparent closes is still in the consult and derives executed_pending_settlement (a succeeded subject too); the settling computation names the subject, never a transparent close', async () => {
  for (const kind of ['verified_closed', 'succeeded']) {
    const w = await world()
    let subjectId
    if (kind === 'verified_closed') {
      subjectId = 'exec_subject'
      seedLandedSubject(w, subjectId, '2026-11-08T00:00:00.000Z')
    } else {
      const execution = await w.store.beginExecution(beginInput())
      await w.store.finishExecution({ ...SCOPE, executionId: execution.id, status: 'succeeded', written: 1, attemptedWrites: 1 })
      subjectId = execution.id
    }
    for (let index = 0; index < 6; index += 1) await selfVerifiedClose(w, index % 2 ? 'failed' : 'aborted')
    const consult = await consultOf(w)
    assert.ok(consult.executions.some((entry) => entry.id === subjectId), `${kind}: the subject is in the consult behind six transparent closes`)
    assert.equal(refreshState.newestSettlementSubject(consult.executions).id, subjectId)
    assert.notEqual(refreshState.newestExecution(consult.executions).id, subjectId, 'the raw newest is a transparent close')
    assert.equal(readProjectRefreshState(consult).status, 'executed_pending_settlement', kind)
    const settlement = lanes.settlementForComputation({ consult, dryRun: { plan: { counts: {}, holds: [] }, sourceContentRevision: { rows: [] }, existingRows: [], refresh: { installedFieldProperties: undefined } }, template: undefined })
    assert.equal(settlement.executionId, subjectId, 'the settlement names the subject')
    // Settled naming it => complete.
    assert.equal(readProjectRefreshState({ ...consult, state: { settledAt: '2026-11-09T01:00:00.000Z', settledExecutionId: subjectId, settledSheetMachineDigest: 'd' } }).status, 'complete')
  }
})

test('XD-02 a plan-bound nothing_landed close is never transparent: the derivation refuses the shape (unreadable) and the store stores a subject (CP-S09); a bound close derives 已确认待执行 while its plan stays confirmed', () => {
  const bound = { id: 'e1', status: 'verified_closed', verifiedResult: 'nothing_landed', settlementSubject: false, changePlanBound: true, startedAt: '2026-11-09T00:00:00.000Z' }
  const base = { ok: true, pilot: { enabled: true }, continuations: [], holds: [], state: null, changePlans: [], lock: FREE_LOCK }
  assert.equal(readProjectRefreshState({ ...base, executions: [bound] }).status, 'unreadable')
  const subject = { ...bound, settlementSubject: true }
  assert.equal(readProjectRefreshState({ ...base, executions: [subject], changePlans: [{ id: 'cp', status: 'confirmed' }] }).status, 'confirmed_pending_execution')
  assert.equal(readProjectRefreshState({ ...base, executions: [subject] }).status, 'executed_pending_settlement', 'P8: a subject — the next computation reopens the content hold')
})

test('XD-03 a transparent close never writes the settled columns; the previous subject\'s settlement still holds (complete, settled)', async () => {
  const w = await world()
  const subject = await w.store.beginExecution(beginInput())
  await w.store.finishExecution({ ...SCOPE, executionId: subject.id, status: 'succeeded', written: 1, attemptedWrites: 1 })
  // A clean computation settles naming the subject (the reconcile's settlement).
  await w.store.reconcileHolds({ ...SCOPE, decisionVersionObserved: 0, holds: [], computation: { lane: 'small_preview', suspended: false, generationToken: 'g', sourceContentDigest: 's' }, settlement: { executionId: subject.id, generationToken: 'g', sourceContentDigest: 's', sheetMachineDigest: 'm' } })
  const before = JSON.stringify(w.db.rows(T.state))
  w.clock.advance(1000)
  await selfVerifiedClose(w)
  const statements = w.db.statements('trx.')
  assert.deepEqual(JSON.parse(JSON.stringify(w.db.rows(T.state))), JSON.parse(before), 'the state row is untouched')
  assert.ok(statements.length > 0)
  const consult = await consultOf(w)
  const derived = readProjectRefreshState(consult)
  assert.deepEqual([derived.status, derived.settled], ['complete', true])
  assert.equal(consult.state.settledExecutionId, subject.id)
})

test('XD-04 settlementSubject === false on any other shape is unreadable (fail closed); the store projects the flag, its result and the binding', async () => {
  const base = { ok: true, pilot: { enabled: true }, continuations: [], holds: [], state: null, changePlans: [], lock: FREE_LOCK }
  for (const entry of [
    { id: 'e', status: 'succeeded', settlementSubject: false },
    { id: 'e', status: 'verified_closed', verifiedResult: 'landed', settlementSubject: false },
    { id: 'e', status: 'verified_closed', verifiedResult: 'mixed', settlementSubject: false },
    { id: 'e', status: 'aborted', settlementSubject: false },
    { id: 'e', status: 'verified_closed', verifiedResult: 'nothing_landed', settlementSubject: false, changePlanBound: true },
  ]) {
    const answer = readProjectRefreshState({ ...base, executions: [entry] })
    assert.deepEqual([answer.status, answer.unreadable && answer.unreadable.reason], ['unreadable', 'malformed_executions'], JSON.stringify(entry))
  }
  assert.equal(refreshState.isTransparentExecution({ settlementSubject: false }), true)
  assert.equal(refreshState.isTransparentExecution({ settlementSubject: undefined }), false, 'absent is a subject')
  const w = await world()
  await selfVerifiedClose(w)
  const [projected] = (await w.store.readGovernanceRows(SCOPE)).executions
  assert.deepEqual([projected.settlementSubject, projected.verifiedResult, projected.closedMode, projected.preCloseStatus, projected.changePlanBound, projected.intentVersion], [false, 'nothing_landed', 'self_verified', 'aborted', false, 1])
  assert.equal(Object.prototype.hasOwnProperty.call(projected, 'pullBatchSourceDigest'), false, 'never projected (N-SWITCH)')
})

// ── AUD-01 ───────────────────────────────────────────────────────────────────────────────────────

test('AUD-01 the route\'s system-event map: change_plan_invalidated byte-identical to the PR-8 row; execution_self_verified flat and values-free; an unknown event is 500', () => {
  const invalidated = decisions.refreshSystemAuditEntryOf({ operation: 'change_plan_invalidated', changePlanId: 'chp_1', reason: 'source_changed', lane: 'small_preview', recordCount: 2, generationToken: 'g' })
  assert.deepEqual(invalidated, { action: 'exception_resolve', subjectId: 'chp_1', mode: 'change_plan_invalidated', detail: { operation: 'change_plan_invalidated', reason: 'source_changed', lane: 'small_preview', recordCount: 2 } })
  const selfVerified = decisions.refreshSystemAuditEntryOf({ operation: 'execution_self_verified', executionId: 'exec_1', finishStatus: 'aborted', changePlanBound: true, intendedEntries: 3 })
  assert.deepEqual(selfVerified, { action: 'exception_resolve', subjectId: 'exec_1', mode: 'execution_self_verified', detail: { operation: 'execution_self_verified', finishStatus: 'aborted', changePlanBound: true, intendedEntries: 3 } })
  assert.throws(() => decisions.refreshSystemAuditEntryOf({ operation: 'execution_verified_closed' }), (error) => error.status === 500 && error.details.reason === 'audit_event_unknown')
  assert.throws(() => decisions.refreshSystemAuditEntryOf({ operation: 'toString' }), (error) => error.status === 500)
  const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
  assert.match(source, /\.\.\.stockPreparationRefreshDecisions\.refreshSystemAuditEntryOf\(event\),/)
})

test('AUD-02 the route-side handle hands its audit hook to every finish (the self-verification row rides the reconcile\'s hook); no hook wired => the finish is called without one, never refused', async () => {
  const seen = []
  const services = { store: { finishExecution: async (input, options) => { seen.push(options); return { ok: true } } }, governance: {} }
  const hook = async () => {}
  const wired = lanes.createRefreshGovernanceHandle({ tenantId: TENANT, resolveServices: () => services, auditWithin: hook })
  await wired.store.finishExecution({ ...SCOPE, executionId: 'exec_a', status: 'aborted', written: 0, attemptedWrites: 0 })
  const bare = lanes.createRefreshGovernanceHandle({ tenantId: TENANT, resolveServices: () => services })
  await bare.store.finishExecution({ ...SCOPE, executionId: 'exec_b', status: 'aborted', written: 0, attemptedWrites: 0 })
  assert.equal(seen[0].auditWithin, hook)
  assert.deepEqual(seen[1], {})
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-execution-intent.test.cjs', tests)
