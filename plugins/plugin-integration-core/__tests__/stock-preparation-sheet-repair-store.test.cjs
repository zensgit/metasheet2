'use strict'

// 备料 batch-refresh step 6d-2a (S6-6; step-6 design §6.6 / §7.3; register row R-91) — THE SHEET-REPAIR LEDGER STORE
// (lib/stock-preparation-sheet-repair-store.cjs) over a faithful fake of migration 108
// (support/stock-preparation-sheet-repair-kit.cjs), and the migration text itself.
//
//   ST-01  migration 108: the vocabularies ARE the library's; every CHECK / UNIQUE the kit models exists in the SQL; the
//          table bodies close with `\n);`; nothing is dropped, no down()
//   ST-02  the begin is ONE transaction in the stated order — holder assert, open-run sweep, sequence, run row, claim,
//          audit — and both hooks are required; a holder refusal or an audit failure rolls everything back
//   ST-03  the claim: a second begin of the same approved plan is 409 ALREADY_CONSUMED after a READ-BACK on a fresh
//          handle; any other insert failure and a failed read-back are 503; never a run without its claim
//   ST-04  an OPEN run of the sheet begun under ANOTHER lease is closed `stopped / abandoned` (with its audit row) in
//          the same transaction; one begun under THIS lease is 409 RUN_OPEN; the database allows one open run per sheet
//   ST-05  the sequence: a moved sequence is 409 PLAN_CHANGED; each run stores its own number
//   ST-06  the finish: holder first; the run must be open and of THIS lease; counts and reasons are checked; the audit
//          row rides the transaction; a finished run cannot be finished again
//   ST-07  the reads: sequence / retire run ids / open run, the values-free run list, a run by id in scope only, the
//          claim; every failure is 503 with its SQLSTATE — never "nothing there"
//   ST-08  audit details pass the audit store's own values-free gate and never carry the project number
// Every value is synthetic.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const R = require(path.join(LIB, 'stock-preparation-sheet-repair.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-sheet-repair-store.cjs'))
const { __internals: auditInternals } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const kit = require('./support/stock-preparation-sheet-repair-kit.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const CODES = R.SHEET_REPAIR_ERROR_CODES
const RETIRE = R.SHEET_REPAIR_RECIPES[0]
const RESTORE = R.SHEET_REPAIR_RECIPES[1]
const SCOPE = Object.freeze({ tenantId: kit.TENANT_ID, sheetId: kit.SHEET_ID, projectNo: kit.PROJECT_NO })
const HANDLE = kit.handleOf()
const LEASE_A = Object.freeze({ leaseId: 'lease_syn_a', fencingEpoch: 3 })
const LEASE_B = Object.freeze({ leaseId: 'lease_syn_b', fencingEpoch: 4 })
const newRunId = () => `${R.SHEET_REPAIR_RUN_ID_PREFIX}${crypto.randomUUID()}`
const digestOf = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex')
const BACKUP = Object.freeze([['rec_old_2', 4, true, kit.PULL_RUN_ID, 'add', ''], ['rec_old_1', 3, true, kit.PULL_RUN_ID, 'add', '']])

async function rejects(promise, { status, code, reason, field, operation }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a refusal ${code}`)
  if (status !== undefined) assert.equal(caught.status, status, `${caught.code}: ${caught.message}`)
  if (code !== undefined) assert.equal(caught.code, code, caught.message)
  if (reason !== undefined) assert.equal(caught.details.reason, reason, JSON.stringify(caught.details))
  if (field !== undefined) assert.equal(caught.details.field, field, JSON.stringify(caught.details))
  if (operation !== undefined) assert.equal(caught.details.operation, operation, JSON.stringify(caught.details))
  return caught
}

function mount(options = {}) {
  const clock = kit.createClock()
  const db = kit.createFakeRepairDb({ clock, ...options })
  const store = storeModule.createStockPreparationSheetRepairStore({ db, now: clock.now })
  const audits = []
  const holders = []
  const hooks = {
    holderWithin: async (trx) => { holders.push(typeof trx.setLocalLockTimeout === 'function') },
    auditWithin: async (trx, entry) => {
      assert.equal(typeof trx.insertOne, 'function', 'the audit hook is handed the transaction handle')
      auditInternals.assertValuesFreeDetail(entry.detail)
      audits.push({ mode: entry.mode, subjectId: entry.subjectId, detail: { ...entry.detail } })
    },
  }
  const beginInput = (extra = {}) => ({
    ...SCOPE,
    runId: newRunId(),
    writeScopeKey: 'spw2:syn-scope',
    recipe: RETIRE,
    planDigest: digestOf('plan-1'),
    approvalRef: 'R-91:syn-1',
    componentHandle: HANDLE,
    backup: BACKUP.map((entry) => entry.slice()),
    plannedCount: 2,
    expectSequence: 0,
    lease: LEASE_A,
    startedBy: 'u_syn_admin',
    ...hooks,
    ...extra,
  })
  const finishInput = (runId, extra = {}) => ({ ...SCOPE, runId, status: 'completed', writtenCount: 2, lease: LEASE_A, ...hooks, ...extra })
  return { clock, db, store, audits, holders, hooks, beginInput, finishInput }
}

// ── ST-01 ────────────────────────────────────────────────────────────────────────────────────────────────

test('ST-01 migration 108: the closed lists are the library\'s; the kit\'s CHECKs and UNIQUE indexes are the SQL\'s; additive and up-only', () => {
  const sql = fs.readFileSync(kit.MIGRATION_FILES.repair, 'utf8').replace(/\r\n/g, '\n')
  const code = sql.split('\n').filter((line) => !line.startsWith('--')).join('\n')
  const db = kit.createFakeRepairDb()
  assert.deepEqual(Object.keys(db.schema).filter((name) => name.includes('sheet_repair')).sort(), [storeModule.SHEET_REPAIR_TABLES.claim, storeModule.SHEET_REPAIR_TABLES.run].sort())
  const enumsOf = (table) => Object.fromEntries(db.schema[table].enums.map((entry) => [entry.column, entry.values]))
  const run = enumsOf(kit.T.run)
  assert.deepEqual(run.recipe, R.SHEET_REPAIR_RECIPES, 'the recipes')
  assert.deepEqual(run.status, R.SHEET_REPAIR_RUN_STATUSES, 'the run statuses')
  assert.deepEqual(run.stop_reason, R.SHEET_REPAIR_STOP_REASONS, 'the stop reasons')
  assert.deepEqual(enumsOf(kit.T.claim).recipe, R.SHEET_REPAIR_RECIPES)
  for (const check of kit.SHAPE_CHECKS) assert.ok(code.includes(`CONSTRAINT ${check.name}\n`), `${check.name} is in the migration`)
  for (const index of kit.UNIQUE_INDEXES) assert.ok(code.includes(`CREATE UNIQUE INDEX IF NOT EXISTS ${index.name}\n`), `${index.name} is in the migration`)
  const constraintNames = Array.from(code.matchAll(/CONSTRAINT (\S+)\n/g)).map((match) => match[1])
  const modelled = new Set(kit.SHAPE_CHECKS.map((check) => check.name).concat(db.schema[kit.T.run].enums.map((entry) => entry.name), db.schema[kit.T.claim].enums.map((entry) => entry.name)))
  assert.deepEqual(constraintNames.filter((name) => !modelled.has(name)), [], 'every CHECK of the migration is modelled by the kit')
  assert.equal(new Set(constraintNames).size, constraintNames.length)
  assert.deepEqual(Array.from(code.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS (\S+)\n/g)).map((match) => match[1]).sort(), kit.UNIQUE_INDEXES.map((index) => index.name).sort())
  // The claim key is the table's PRIMARY KEY (the one-shot guarantee); a run's id is its own.
  assert.match(code, /claim_key {5}TEXT PRIMARY KEY,/)
  assert.match(code, /CREATE TABLE IF NOT EXISTS integration_stock_prep_sheet_repair_run \(\n {2}id {16}TEXT PRIMARY KEY,/)
  // Convention (design §12.3): every table body closes with `\n);`, CREATE … IF NOT EXISTS only, nothing destructive.
  assert.equal((code.match(/CREATE TABLE IF NOT EXISTS /g) || []).length, 2)
  assert.equal((code.match(/\n\);/g) || []).length, 2)
  assert.equal(/\b(DROP|DELETE|TRUNCATE|ALTER)\b/.test(code), false, 'nothing is dropped or altered')
  for (const phrase of ['R-91', 'OWNER GATE ②', 'up-only', 'RunMigrations 0', 'MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED', 'SELECT, INSERT and UPDATE on integration_stock_prep_sheet_repair_run']) {
    assert.ok(sql.includes(phrase), `the header states: ${phrase}`)
  }
  // The claim key is a digest of the scope, the recipe and the plan digest — a different plan, another key.
  const key = R.claimKeyOf({ ...SCOPE, recipe: RETIRE, planDigest: digestOf('a') })
  assert.match(key, /^[0-9a-f]{64}$/)
  for (const other of [{ ...SCOPE, recipe: RESTORE, planDigest: digestOf('a') }, { ...SCOPE, recipe: RETIRE, planDigest: digestOf('b') }, { ...SCOPE, sheetId: 'sheet_other', recipe: RETIRE, planDigest: digestOf('a') }, { ...SCOPE, projectNo: 'SYN-OTHER', recipe: RETIRE, planDigest: digestOf('a') }, { ...SCOPE, tenantId: 'tenant-other', recipe: RETIRE, planDigest: digestOf('a') }]) {
    assert.notEqual(R.claimKeyOf(other), key)
  }
})

// ── ST-02 ────────────────────────────────────────────────────────────────────────────────────────────────

test('ST-02 the begin is ONE transaction in the stated order; the holder assert and the audit hook are required; a holder refusal or an audit failure rolls everything back', async () => {
  const m = mount()
  const input = m.beginInput()
  const answer = await m.store.beginRun(input)
  assert.deepEqual({ ...answer }, { runId: input.runId, sequence: 0, abandonedRuns: 0 })
  assert.deepEqual(m.db.statements(), [
    ['transaction', undefined],
    ['trx.select', kit.T.run],
    ['trx.countRows', kit.T.run],
    ['trx.insertOne', kit.T.run],
    ['trx.insertOne', kit.T.claim],
    ['commit', undefined],
  ], 'the open-run read, the sequence, the run row and the claim, in one transaction')
  assert.deepEqual(m.holders, [true], 'the holder assert ran once, on the transaction handle, before any statement')
  const row = m.db.rows(kit.T.run)[0]
  assert.deepEqual(
    [row.id, row.tenant_id, row.sheet_id, row.project_no, row.write_scope_key, row.recipe, row.sequence_no, row.plan_digest, row.approval_ref, row.component_handle, row.source_run_id, row.planned_count, row.written_count, row.status, row.stop_reason, row.lease_id, row.fencing_epoch, row.started_by, row.finished_at],
    [input.runId, SCOPE.tenantId, SCOPE.sheetId, SCOPE.projectNo, 'spw2:syn-scope', RETIRE, 0, input.planDigest, 'R-91:syn-1', HANDLE, null, 2, null, 'running', null, LEASE_A.leaseId, LEASE_A.fencingEpoch, 'u_syn_admin', null],
  )
  assert.deepEqual(row.backup, BACKUP)
  const claim = m.db.rows(kit.T.claim)[0]
  assert.deepEqual([claim.claim_key, claim.run_id, claim.recipe, claim.plan_digest, claim.approval_ref, claim.claimed_by], [R.claimKeyOf({ ...SCOPE, recipe: RETIRE, planDigest: input.planDigest }), input.runId, RETIRE, input.planDigest, 'R-91:syn-1', 'u_syn_admin'])
  assert.deepEqual(m.audits, [{ mode: 'sheet_repair_started', subjectId: input.runId, detail: { operation: 'sheet_repair_begin', recipe: RETIRE, planned: 2, sequence: 0, planDigest: input.planDigest, approvalRef: 'R-91:syn-1', componentHandle: HANDLE, abandonedRuns: 0 } }])
  // Both hooks are required, and every malformed input is refused before the transaction.
  for (const [extra, field] of [
    [{ holderWithin: undefined }, 'holderWithin'],
    [{ auditWithin: null }, 'auditWithin'],
    [{ runId: 'run-1' }, 'runId'],
    [{ writeScopeKey: '' }, 'writeScopeKey'],
    [{ recipe: 'delete_rows' }, 'recipe'],
    [{ planDigest: 'abc' }, 'planDigest'],
    [{ approvalRef: 'has space' }, 'approvalRef'],
    [{ componentHandle: null }, 'componentHandle'],
    [{ recipe: RESTORE, componentHandle: null, sourceRunId: null }, 'sourceRunId'],
    [{ backup: [] }, 'backup'],
    [{ backup: [['rec', 1, true, 'r', 'add']] }, 'backup'],
    [{ backup: [['rec', 1, 'true', 'r', 'add', '']] }, 'backup'],
    [{ backup: [['rec', 1, true, 'r', 'add', ''], ['rec', 2, true, 'r', 'add', '']] }, 'backup'],
    [{ plannedCount: 3 }, 'plannedCount'],
    [{ expectSequence: -1 }, 'expectSequence'],
    [{ lease: { leaseId: '', fencingEpoch: 1 } }, 'lease'],
    [{ lease: { leaseId: 'l', fencingEpoch: 1.5 } }, 'lease'],
    [{ startedBy: ' ' }, 'startedBy'],
    [{ tenantId: '' }, 'scope'],
  ]) {
    const fresh = mount()
    await rejects(fresh.store.beginRun(fresh.beginInput(extra)), { status: 500, code: CODES.UNAVAILABLE, field })
    assert.deepEqual(fresh.db.log, [], `${field}: refused before any statement`)
  }
  // A holder refusal (the sheet lease was taken over): the lock's own typed error, nothing persisted.
  const lost = mount()
  const leaseLost = Object.assign(new Error('this run no longer holds the sheet write lease'), { status: 409, code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', details: { reason: 'sheet_repair', partial: false } })
  await rejects(lost.store.beginRun(lost.beginInput({ holderWithin: async () => { throw leaseLost } })), { status: 409, code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST' })
  assert.deepEqual([lost.db.rows(kit.T.run), lost.db.rows(kit.T.claim), lost.db.statements().filter(([method]) => method.startsWith('trx.'))], [[], [], []], 'the holder assert is FIRST: no statement ran')
  // An untyped holder failure is the ledger's 503, never a begin.
  const broken = mount()
  await rejects(broken.store.beginRun(broken.beginInput({ holderWithin: async () => { throw new Error('boom') } })), { status: 503, code: CODES.STORE_FAILED, operation: 'holder' })
  // An audit failure rolls the run AND the claim back.
  const unaudited = mount()
  await rejects(unaudited.store.beginRun(unaudited.beginInput({ auditWithin: async () => { throw Object.assign(new Error('audit refused'), { status: 422, code: 'AUDIT_DETAIL_INVALID' }) } })), { status: 422, code: 'AUDIT_DETAIL_INVALID' })
  assert.deepEqual([unaudited.db.rows(kit.T.run), unaudited.db.rows(kit.T.claim)], [[], []], 'no run and no spent claim without the audit row')
  await rejects(unaudited.store.beginRun(unaudited.beginInput({ auditWithin: async () => { throw new Error('driver error') } })), { status: 503, code: CODES.STORE_FAILED, operation: 'begin' })
  // The store itself needs the scoped helper.
  assert.throws(() => storeModule.createStockPreparationSheetRepairStore({ db: {} }), /scoped db helper/)
})

// ── ST-03 ────────────────────────────────────────────────────────────────────────────────────────────────

test('ST-03 the one-shot claim: the second begin of an approved plan is ALREADY_CONSUMED after a read-back on a fresh handle; any other failure fails closed', async () => {
  const m = mount()
  const first = m.beginInput()
  await m.store.beginRun(first)
  await m.store.finishRun(m.finishInput(first.runId))
  m.db.log.length = 0
  // The same approved plan again (the same scope, recipe and digest), by another run under another lease.
  const second = m.beginInput({ expectSequence: 1, lease: LEASE_B })
  await rejects(m.store.beginRun(second), { status: 409, code: CODES.ALREADY_CONSUMED, reason: 'claim_consumed' })
  const log = m.db.statements()
  assert.deepEqual(log.slice(-3), [['trx.insertOne', kit.T.claim], ['rollback', undefined], ['selectOne', kit.T.claim]], 'the failed INSERT rolled the transaction back; the claim was then read on a FRESH handle')
  assert.deepEqual([m.db.rows(kit.T.run).length, m.db.rows(kit.T.claim).length], [1, 1], 'the second run row did not survive')
  assert.equal(m.db.rows(kit.T.claim)[0].run_id, first.runId, 'the claim still names the run that spent it')
  // A different plan (another digest) of the same scope is its own claim.
  const other = m.beginInput({ planDigest: digestOf('plan-2'), expectSequence: 1, lease: LEASE_B })
  await m.store.beginRun(other)
  assert.equal(m.db.rows(kit.T.claim).length, 2)
  // An insert failure that is NOT a spent claim: nothing is there to read back => 503, never "proceed".
  const failing = mount()
  failing.db.faults.insertOne = (args) => (args.table === kit.T.claim ? kit.sqlError('53300', 'too many connections') : null)
  const failure = await rejects(failing.store.beginRun(failing.beginInput()), { status: 503, code: CODES.STORE_FAILED, operation: 'claim' })
  assert.deepEqual([failure.details.sqlState, failure.details.partial], ['53300', false])
  assert.deepEqual([failing.db.rows(kit.T.run), failing.db.rows(kit.T.claim)], [[], []])
  // The read-back itself fails: still 503.
  const blind = mount()
  blind.db.faults.insertOne = (args) => (args.table === kit.T.claim ? kit.sqlError('23505', 'duplicate key value violates unique constraint') : null)
  blind.db.faults.selectOne = (args) => (args.table === kit.T.claim ? kit.sqlError('57014', 'canceling statement') : null)
  await rejects(blind.store.beginRun(blind.beginInput()), { status: 503, code: CODES.STORE_FAILED, operation: 'claim_read_back' })
  // A run-row insert failure is the ledger's 503 as well (and spends nothing).
  const noTable = mount()
  noTable.db.faults.insertOne = (args) => (args.table === kit.T.run ? kit.sqlError('42P01', 'relation does not exist') : null)
  await rejects(noTable.store.beginRun(noTable.beginInput()), { status: 503, code: CODES.STORE_FAILED, operation: 'begin_run' })
  assert.deepEqual(noTable.db.rows(kit.T.claim), [])
})

// ── ST-04 ────────────────────────────────────────────────────────────────────────────────────────────────

test('ST-04 an open run of the sheet begun under ANOTHER lease is closed `stopped / abandoned` in the begin transaction; one begun under THIS lease is 409 RUN_OPEN; the database allows one open run per sheet', async () => {
  const m = mount()
  const crashed = m.beginInput()
  await m.store.beginRun(crashed)
  m.audits.length = 0
  const next = m.beginInput({ planDigest: digestOf('plan-2'), expectSequence: 1, lease: LEASE_B })
  const answer = await m.store.beginRun(next)
  assert.deepEqual({ ...answer }, { runId: next.runId, sequence: 1, abandonedRuns: 1 })
  const rows = m.db.rows(kit.T.run).sort((left, right) => left.sequence_no - right.sequence_no)
  assert.deepEqual(rows.map((row) => [row.id, row.status, row.stop_reason, row.written_count, row.finished_at !== null]), [[crashed.runId, 'stopped', 'abandoned', null, true], [next.runId, 'running', null, null, false]])
  assert.deepEqual(m.audits.map((entry) => [entry.mode, entry.subjectId]), [['sheet_repair_abandoned', crashed.runId], ['sheet_repair_started', next.runId]])
  assert.deepEqual(m.audits[0].detail, { operation: 'sheet_repair_abandon', recipe: RETIRE, planned: 2, closedByRun: next.runId, sameProject: true })
  assert.equal(m.audits[1].detail.abandonedRuns, 1)
  // The abandoned run's own claim stays spent (a claim is permanent).
  assert.equal(m.db.rows(kit.T.claim).length, 2)
  // An open run begun under THIS very lease: one lease, one run.
  const same = mount()
  await same.store.beginRun(same.beginInput())
  await rejects(same.store.beginRun(same.beginInput({ planDigest: digestOf('plan-2'), expectSequence: 1 })), { status: 409, code: CODES.RUN_OPEN, reason: 'run_open' })
  assert.equal(same.db.rows(kit.T.run).length, 1)
  // The unique index is the database's own statement of "one open run per sheet" (and of the sequence).
  const direct = mount()
  const seed = (id, extra = {}) => direct.db.seed(kit.T.run, {
    id, tenant_id: SCOPE.tenantId, sheet_id: SCOPE.sheetId, project_no: SCOPE.projectNo, write_scope_key: 'spw2:syn', recipe: RETIRE, sequence_no: 0,
    plan_digest: digestOf(id), approval_ref: 'R-91', component_handle: HANDLE, source_run_id: null, backup: BACKUP, planned_count: 2, written_count: null,
    status: 'running', stop_reason: null, lease_id: 'l', fencing_epoch: 1, started_by: 'u', finished_at: null, ...extra,
  })
  seed('run_a')
  assert.throws(() => seed('run_b', { sequence_no: 1 }), (error) => error.code === '23505' && error.constraint === 'uniq_integration_stock_prep_sheet_repair_run_open')
  assert.throws(() => seed('run_c', { status: 'completed', written_count: 2, finished_at: '2026-11-10T00:00:00.000Z' }), (error) => error.code === '23505' && error.constraint === 'uniq_integration_stock_prep_sheet_repair_run_sequence')
  // The shape CHECKs refuse the rows the store never writes.
  for (const [extra, constraint] of [
    [{ status: 'completed', written_count: 1, finished_at: '2026-11-10T00:00:00.000Z' }, 'integration_stock_prep_sheet_repair_run_written_check'],
    [{ status: 'stopped', stop_reason: null, written_count: 1, finished_at: '2026-11-10T00:00:00.000Z' }, 'integration_stock_prep_sheet_repair_run_stop_check'],
    [{ status: 'stopped', stop_reason: 'version_conflict', written_count: null, finished_at: '2026-11-10T00:00:00.000Z' }, 'integration_stock_prep_sheet_repair_run_written_check'],
    [{ status: 'completed', written_count: 2, finished_at: null }, 'integration_stock_prep_sheet_repair_run_open_check'],
    [{ component_handle: null }, 'integration_stock_prep_sheet_repair_run_subject_check'],
    [{ recipe: RESTORE }, 'integration_stock_prep_sheet_repair_run_subject_check'],
    [{ plan_digest: 'abc' }, 'integration_stock_prep_sheet_repair_run_digest_check'],
    [{ planned_count: 0 }, 'integration_stock_prep_sheet_repair_run_counts_check'],
    [{ stop_reason: 'because' }, 'integration_stock_prep_sheet_repair_run_stop_reason_check'],
    [{ status: 'paused' }, 'integration_stock_prep_sheet_repair_run_status_check'],
    [{ recipe: 'delete_rows' }, 'integration_stock_prep_sheet_repair_run_recipe_check'],
  ]) {
    const fresh = mount()
    assert.throws(() => fresh.db.seed(kit.T.run, {
      id: 'run_x', tenant_id: SCOPE.tenantId, sheet_id: SCOPE.sheetId, project_no: SCOPE.projectNo, write_scope_key: 'spw2:syn', recipe: RETIRE, sequence_no: 0,
      plan_digest: digestOf('x'), approval_ref: 'R-91', component_handle: HANDLE, source_run_id: null, backup: BACKUP, planned_count: 2, written_count: null,
      status: 'running', stop_reason: null, lease_id: 'l', fencing_epoch: 1, started_by: 'u', finished_at: null, ...extra,
    }), (error) => error.code === '23514' && error.constraint === constraint, constraint)
  }
})

// ── ST-05 ────────────────────────────────────────────────────────────────────────────────────────────────

test('ST-05 the sequence is re-read under the holder assert: a moved sequence is 409 PLAN_CHANGED and nothing is begun', async () => {
  const m = mount()
  const first = m.beginInput()
  await m.store.beginRun(first)
  await m.store.finishRun(m.finishInput(first.runId))
  // A plan digested at sequence 0 arrives after a run began: its expectation is stale.
  await rejects(m.store.beginRun(m.beginInput({ planDigest: digestOf('plan-2'), expectSequence: 0, lease: LEASE_B })), { status: 409, code: CODES.PLAN_CHANGED, reason: 'sequence_moved' })
  assert.deepEqual([m.db.rows(kit.T.run).length, m.db.rows(kit.T.claim).length], [1, 1])
  // The sequence counts THIS sheet's project only.
  await m.store.beginRun(m.beginInput({ projectNo: 'SYN-OTHER', sheetId: 'sheet_syn_other', planDigest: digestOf('plan-3'), expectSequence: 0, lease: LEASE_B }))
  const again = m.beginInput({ planDigest: digestOf('plan-4'), expectSequence: 1, lease: LEASE_B })
  assert.equal((await m.store.beginRun(again)).sequence, 1)
})

// ── ST-06 ────────────────────────────────────────────────────────────────────────────────────────────────

test('ST-06 the finish: holder first; the run must be open and of THIS lease; counts and reasons are checked; the audit rides the transaction', async () => {
  const m = mount()
  const input = m.beginInput()
  await m.store.beginRun(input)
  m.audits.length = 0
  m.holders.length = 0
  m.db.log.length = 0
  const done = await m.store.finishRun(m.finishInput(input.runId))
  assert.deepEqual({ ...done }, { runId: input.runId, status: 'completed', stopReason: null, planned: 2, written: 2 })
  assert.deepEqual(m.db.statements(), [['transaction', undefined], ['trx.selectOne', kit.T.run], ['trx.updateRow', kit.T.run], ['commit', undefined]])
  assert.deepEqual(m.holders, [true])
  const row = m.db.rows(kit.T.run)[0]
  assert.deepEqual([row.status, row.stop_reason, row.written_count, row.finished_at !== null], ['completed', null, 2, true])
  assert.deepEqual(m.audits, [{ mode: 'sheet_repair_completed', subjectId: input.runId, detail: { operation: 'sheet_repair_finish', recipe: RETIRE, planned: 2, written: 2 } }])
  // A finished run cannot be finished again; a run of another scope or another lease is the same refusal.
  await rejects(m.store.finishRun(m.finishInput(input.runId)), { status: 409, code: CODES.RUN_NOT_OPEN, reason: 'run_not_open' })
  const other = mount()
  const open = other.beginInput()
  await other.store.beginRun(open)
  await rejects(other.store.finishRun(other.finishInput(open.runId, { lease: LEASE_B })), { status: 409, code: CODES.RUN_NOT_OPEN })
  await rejects(other.store.finishRun(other.finishInput(open.runId, { projectNo: 'SYN-OTHER' })), { status: 409, code: CODES.RUN_NOT_OPEN })
  await rejects(other.store.finishRun(other.finishInput(newRunId())), { status: 409, code: CODES.RUN_NOT_OPEN })
  // Counts and reasons.
  await rejects(other.store.finishRun(other.finishInput(open.runId, { writtenCount: 1 })), { status: 500, code: CODES.UNAVAILABLE, field: 'writtenCount' })
  await rejects(other.store.finishRun(other.finishInput(open.runId, { writtenCount: 3, status: 'stopped', stopReason: 'version_conflict' })), { status: 500, code: CODES.UNAVAILABLE, field: 'writtenCount' })
  for (const [extra, field] of [[{ status: 'running' }, 'status'], [{ status: 'stopped' }, 'stopReason'], [{ status: 'stopped', stopReason: 'abandoned' }, 'stopReason'], [{ status: 'stopped', stopReason: 'because' }, 'stopReason'], [{ stopReason: 'version_conflict' }, 'stopReason'], [{ writtenCount: -1 }, 'writtenCount'], [{ holderWithin: null }, 'holderWithin'], [{ auditWithin: undefined }, 'auditWithin'], [{ lease: null }, 'lease']]) {
    await rejects(other.store.finishRun(other.finishInput(open.runId, extra)), { status: 500, code: CODES.UNAVAILABLE, field })
  }
  assert.equal(other.db.rows(kit.T.run)[0].status, 'running', 'no refusal moved the run')
  // A stop: the reason and the partial count; then the audit failure case rolls the finish back.
  other.audits.length = 0
  const stopped = await other.store.finishRun(other.finishInput(open.runId, { status: 'stopped', stopReason: 'version_conflict', writtenCount: 1 }))
  assert.deepEqual([stopped.status, stopped.stopReason, stopped.written], ['stopped', 'version_conflict', 1])
  assert.deepEqual(other.audits.map((entry) => [entry.mode, entry.detail.stopReason, entry.detail.written]), [['sheet_repair_stopped', 'version_conflict', 1]])
  const unaudited = mount()
  const pending = unaudited.beginInput()
  await unaudited.store.beginRun(pending)
  await rejects(unaudited.store.finishRun(unaudited.finishInput(pending.runId, { auditWithin: async () => { throw new Error('driver error') } })), { status: 503, code: CODES.STORE_FAILED, operation: 'finish' })
  assert.equal(unaudited.db.rows(kit.T.run)[0].status, 'running', 'the finish rolled back with its audit row')
  // A holder refusal at the finish (the lease was taken over after the last write): nothing is recorded.
  const lost = mount()
  const run = lost.beginInput()
  await lost.store.beginRun(run)
  await rejects(lost.store.finishRun(lost.finishInput(run.runId, { holderWithin: async () => { throw Object.assign(new Error('lost'), { status: 409, code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', details: {} }) } })), { status: 409, code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST' })
  assert.equal(lost.db.rows(kit.T.run)[0].status, 'running')
})

// ── ST-07 ────────────────────────────────────────────────────────────────────────────────────────────────

test('ST-07 the reads: sequence / retire run ids / open run; the values-free run list; a run by id in scope only; the claim; a failure is 503 with its SQLSTATE', async () => {
  const m = mount()
  assert.deepEqual({ ...(await m.store.listRunsOf(SCOPE)) }, { sequence: 0, retireRunIds: [], openRun: false })
  assert.deepEqual(await m.store.readClaim({ ...SCOPE, recipe: RETIRE, planDigest: digestOf('plan-1') }), null)
  const retire = m.beginInput()
  await m.store.beginRun(retire)
  assert.deepEqual({ ...(await m.store.listRunsOf(SCOPE)) }, { sequence: 1, retireRunIds: [retire.runId], openRun: true })
  await m.store.finishRun(m.finishInput(retire.runId))
  const restore = m.beginInput({ recipe: RESTORE, componentHandle: undefined, sourceRunId: retire.runId, planDigest: digestOf('plan-restore'), expectSequence: 1, backup: [['rec_old_1', 4, false, retire.runId, 'inactive', kit.RETIRE_SUMMARY]], plannedCount: 1 })
  await m.store.beginRun(restore)
  await m.store.finishRun(m.finishInput(restore.runId, { status: 'stopped', stopReason: 'record_locked', writtenCount: 0 }))
  const ledger = await m.store.listRunsOf(SCOPE)
  assert.deepEqual({ ...ledger }, { sequence: 2, retireRunIds: [retire.runId], openRun: false }, 'a restore run is not a retire run')
  // The public list: newest first, no backup, no principal, no project number, no lease.
  const listed = await m.store.listRuns(SCOPE)
  assert.equal(listed.truncated, false)
  assert.deepEqual(listed.runs.map((run) => [run.runId, run.recipe, run.sequence, run.status, run.stopReason, run.planned, run.written, run.componentHandle, run.sourceRunId]), [
    [restore.runId, RESTORE, 1, 'stopped', 'record_locked', 1, 0, null, retire.runId],
    [retire.runId, RETIRE, 0, 'completed', null, 2, 2, HANDLE, null],
  ])
  assert.deepEqual(Object.keys(listed.runs[0]).sort(), ['approvalRef', 'componentHandle', 'finishedAt', 'planDigest', 'planned', 'recipe', 'runId', 'sequence', 'sourceRunId', 'startedAt', 'status', 'stopReason', 'written'])
  for (const planted of [SCOPE.projectNo, SCOPE.tenantId, SCOPE.sheetId, 'u_syn_admin', 'rec_old', LEASE_A.leaseId, kit.PULL_RUN_ID]) assert.equal(JSON.stringify(listed).includes(planted), false, `${planted} leaked`)
  // A run by id: with its backup, in THIS scope only.
  const read = await m.store.readRun({ ...SCOPE, runId: retire.runId })
  assert.deepEqual([read.id, read.recipe, read.status, read.sequence, read.leaseId, read.fencingEpoch], [retire.runId, RETIRE, 'completed', 0, LEASE_A.leaseId, LEASE_A.fencingEpoch])
  assert.deepEqual(read.backup, BACKUP)
  for (const scope of [{ ...SCOPE, projectNo: 'SYN-OTHER' }, { ...SCOPE, sheetId: 'sheet_other' }, { ...SCOPE, tenantId: 'tenant-other' }]) assert.equal(await m.store.readRun({ ...scope, runId: retire.runId }), null)
  assert.equal(await m.store.readRun({ ...SCOPE, runId: 'not-a-run-id' }), null)
  assert.equal(await m.store.readRun({ ...SCOPE, runId: newRunId() }), null)
  const claim = await m.store.readClaim({ ...SCOPE, recipe: RETIRE, planDigest: retire.planDigest })
  assert.equal(claim.runId, retire.runId)
  assert.equal(await m.store.readClaim({ ...SCOPE, recipe: RESTORE, planDigest: retire.planDigest }), null, 'the recipe is part of the claim')
  await rejects(m.store.readClaim({ ...SCOPE, recipe: RETIRE, planDigest: 'abc' }), { status: 500, code: CODES.UNAVAILABLE, field: 'planDigest' })
  // Failures: 503 with the SQLSTATE — a missing table (a deploy without 108) included; never "nothing there".
  for (const [method, call, operation] of [
    ['select', () => m.store.listRunsOf(SCOPE), 'list_runs'],
    ['select', () => m.store.listRuns(SCOPE), 'list_runs'],
    ['selectOne', () => m.store.readRun({ ...SCOPE, runId: retire.runId }), 'read_run'],
    ['selectOne', () => m.store.readClaim({ ...SCOPE, recipe: RETIRE, planDigest: retire.planDigest }), 'read_claim'],
    ['select', () => m.store.probeReadable(), 'probe'],
  ]) {
    m.db.faults[method] = kit.sqlError('42P01', 'relation does not exist')
    const failure = await rejects(call(), { status: 503, code: CODES.STORE_FAILED, operation })
    assert.deepEqual([failure.details.sqlState, failure.details.partial], ['42P01', false])
  }
  assert.deepEqual({ ...(await m.store.probeReadable()) }, { readable: true })
  // A row of another tenant under this sheet and project is a store fault, never silently counted.
  m.db.seed(kit.T.run, {
    id: 'run_foreign', tenant_id: 'tenant-other', sheet_id: SCOPE.sheetId, project_no: SCOPE.projectNo, write_scope_key: 'spw2:syn', recipe: RETIRE, sequence_no: 7,
    plan_digest: digestOf('foreign'), approval_ref: 'R-91', component_handle: HANDLE, source_run_id: null, backup: BACKUP, planned_count: 2, written_count: 2,
    status: 'completed', stop_reason: null, lease_id: 'l', fencing_epoch: 1, started_by: 'u', finished_at: '2026-11-10T00:00:00.000Z',
  })
  assert.equal((await rejects(m.store.listRunsOf(SCOPE), { status: 503, code: CODES.STORE_FAILED })).details.reason, 'scope_mismatch')
})

// ── ST-08 ────────────────────────────────────────────────────────────────────────────────────────────────

test('ST-08 every audit entry the store hands over passes the audit store\'s values-free gate, is frozen, and never carries the project number or a principal', async () => {
  const m = mount()
  const seen = []
  const auditWithin = async (_trx, entry) => {
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.detail))
    auditInternals.assertValuesFreeDetail(entry.detail)
    auditInternals.assertValuesFreeColumn(entry.mode, 'mode')
    auditInternals.assertValuesFreeColumn(entry.subjectId, 'subjectId')
    seen.push(entry)
  }
  const crashed = m.beginInput({ auditWithin })
  await m.store.beginRun(crashed)
  const next = m.beginInput({ auditWithin, planDigest: digestOf('plan-2'), expectSequence: 1, lease: LEASE_B })
  await m.store.beginRun(next)
  await m.store.finishRun(m.finishInput(next.runId, { auditWithin, lease: LEASE_B, status: 'stopped', stopReason: 'host_write_failed', writtenCount: 1 }))
  assert.deepEqual(seen.map((entry) => entry.mode), ['sheet_repair_started', 'sheet_repair_abandoned', 'sheet_repair_started', 'sheet_repair_stopped'])
  for (const mode of seen.map((entry) => entry.mode)) assert.ok(Object.values(R.SHEET_REPAIR_AUDIT.modes).includes(mode))
  const text = JSON.stringify(seen)
  for (const planted of [SCOPE.projectNo, SCOPE.tenantId, SCOPE.sheetId, 'u_syn_admin', 'rec_old', LEASE_A.leaseId]) assert.equal(text.includes(planted), false, `${planted} leaked`)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-sheet-repair-store.test.cjs', tests)
