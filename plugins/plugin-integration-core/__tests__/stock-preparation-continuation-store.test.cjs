'use strict'

// Batch-refresh step 4, PR-2 — the CONTINUATION / REFRESH-STATE STORE (lib/stock-preparation-continuation-store.cjs)
// over migrations 102 / 103, against the faithful fake of the scoped db helper
// (support/stock-preparation-refresh-store-kit.cjs: unique indexes modelled exactly, NOT NULL / enum CHECKs parsed
// from the migration text, transactions that roll back). Every hold fed to the store is a REAL hold the pure core
// produced over the canonical S/P fixtures (a real expansion with the #6502 recorder on, the real planner).
//
//   ST-01 migrations 102 / 103 text: the five tables, every CHECK vocabulary SET-EQUAL to the pure core's
//         (hold kinds, shape tokens incl. `dropped_other_rule`, not-confirmable reasons, verdicts, status reasons),
//         every unique index of the kit present with its partial predicate, the claim_active mirror CHECK,
//         integration_ prefix, no DROP, no audit vocabulary re-listing (D9), the rollback / G10 and Q-B notes.
//   ST-02 scope validation is a 422 before any statement.
//   ST-03 A11: a read that fails (a fault, a missing table) is 503 STORE_FAILED with operation + SQLSTATE + partial:false
//         — never an empty list; a page past its ceiling is a failure too. The failing read is inside the consult
//         snapshot (BEGIN, the REPEATABLE READ pin, the read, ROLLBACK).
//   ST-04 confirm (design §8.2): statement order (state FOR UPDATE -> hold re-read -> bump on the TRANSACTION handle ->
//         header + members -> hold resolved -> decision_version + 1), the rows written, the read-back feeds the pure
//         core's normalizeContinuationInput + buildContinuationProjection, the digests agree with the hold's subject,
//         the audit hook runs inside the transaction with a values-free event.
//   ST-05 confirm refusals: no bumpWithin (501, no transaction), absent / resolved / other-scope hold (STALE / TENANT),
//         kind or confirmability (NOT_ALLOWED), echo mismatch (STALE), the lock refusing (passes through, rollback),
//         a malformed bump, an audit failure (rollback, E09), basis validation.
//   ST-06 A08 as a DB fact: two holds claiming one old record -> the second confirm is 409 CONFIRM_CONFLICT from the
//         partial unique index and nothing of it persists; two old sets claiming one new position likewise.
//         Mutation: the kit built WITHOUT that index lets the second confirm through (the probe script).
//   ST-07 hold reconciliation (design §8.4): the state row is UPSERTed then locked, the CAS on decision_version
//         (moved -> 409 STATE_MOVED, nothing persisted), open / keep / supersede by fingerprint, runbook-only holds
//         survive a clean computation, verdicts move active -> needs_reconfirmation (and never back by themselves),
//         settlement only for a clean computation, decision_version never moves, a mid-way fault rolls back.
//   ST-08 end (design §8.4): escalate keeps the hold open as runbook-only; release is decided INSIDE the transaction
//         from THE open relationship_reconfirm row's recorded facts (PR-4 review B1: verdict new_position_removed,
//         componentNewPositionCount 0 — facts_missing / new_position_present otherwise) and bound to the hold the
//         caller names (`facts`, STALE facts_moved when another row is open); superseded_by_new_confirmation only
//         inside a confirm; claims released by an end can be re-claimed; `supersedes` ends and replaces in one
//         transaction.
//   ST-09 re-confirm (design §8.3): UPDATE in place (same id, revision + 1, active, executed_execution_id cleared),
//         admissible reasons only.
//   ST-10 executions: begin -> running; finish succeeded stamps the bound continuations and the self-settling
//         columns; the governance read returns every unfinished execution beyond the newest five.
//   ST-11 values-free errors: no key, path, component id or drawing number in any error's details.
//   ST-12 the governance read is keyed by (tenant, project) AND by sheet: rows of this project on another sheet,
//         and rows of another project on this sheet, come back (the reader refuses on them).
//   ST-13 A08 per index: each of the five partial unique CLAIM indexes is the first to answer its own collision
//         (exact constraint name; the header row is inserted before the members, and indexes are checked in
//         creation order, as in PostgreSQL), so a fake without any ONE of them answers differently. The open-hold
//         unique is never reached through the store (two holds of one computation sharing a fingerprint are a
//         planner defect, refused 500 INPUT_INVALID before any statement — ST-07; reconciliations serialise on
//         the state row FOR UPDATE); its DB fact is the real-DB case S2-01.
//   ST-14 ONE CONSULT SNAPSHOT (review X-1): readGovernanceRows runs every read in ONE transaction whose FIRST
//         statement pins REPEATABLE READ (no autocommit read); `readFirst` runs on that handle after the pin and
//         before any step-4 read, its refusal passes through untouched and rolls back; a handle that cannot pin is
//         501 and a failed pin 503 `read_snapshot`, both before any read.
//   ST-15 END ADMISSIBILITY (review X-2, design §9.3 / §8.4): an ACTIVE continuation is never ended here (409
//         END_OUTCOME_NOT_ADMISSIBLE `status`, any outcome); `escalate_special_repair` needs an OPEN hold naming
//         the continuation (`no_open_hold` otherwise); both refused before the bump and before any write. An
//         admitted escalation keeps the hold open runbook-only: the project derives pending_confirmation, a clean
//         settling computation neither supersedes the hold nor settles, nothing derives complete / export-allowed.
//   ST-16 SUPERSEDE ADMISSIBILITY (review X-3 + round 2, design §8.4): a confirm `supersedes` only a continuation
//         it FULLY takes over — every old record id and every old key digest the continuation claims (root and
//         every member) is claimed by the replacement. A candidate sharing nothing is 409
//         END_OUTCOME_NOT_ADMISSIBLE `supersedes_unrelated` (and commits alone, without `supersedes` — the
//         control); a PARTIAL takeover is `supersedes_incomplete` with the uncovered counts — the reviewer's
//         real-planner shape (two of the four new positions, two other rows), another old set at the same new
//         positions, one shared child claim of each kind, every record with one old key re-keyed, every key with
//         one old record replaced (each half of the rule pinned on its own); all refused before the bump and any
//         write. Only the full takeover (every old row and key, another parent) supersedes.
//   ST-17 THE REVIEWER'S ANCESTOR COUNTEREXAMPLE (review round 2): an independent P-001 subtree inserted beside the
//         confirmed relationship; over the FULL sheet and the current projection the REAL planner emits a five-member
//         ancestor candidate — 0 old-row overlap, 4 new-position overlap. Superseding with it is
//         `supersedes_incomplete` { 4, 4 }, deliberately not `supersedes_unrelated` (related through the positions,
//         a takeover of none of the rows); the next plan, pilot on and off, leaves the four old rows alone.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const kit = require(path.join(__dirname, 'support', 'stock-preparation-refresh-store-kit.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const { readProjectRefreshState } = require(path.join(LIB, 'stock-preparation-refresh-state.cjs'))
const { sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { plannerSlice } = require(path.join(LIB, 'stock-preparation-refresh-governance.cjs'))

const {
  REFRESH_STORE_TABLES: T,
  REFRESH_STORE_ERROR_CODES: CODES,
  CONTINUATION_STATUS_REASONS,
  END_OUTCOMES,
  HOLD_RESOLUTIONS,
  COMPUTATION_LANES,
  EXECUTION_STATUSES,
  DEMAND_BASES,
  EVIDENCE_HISTORY_STATUSES,
  StockPreparationRefreshStoreError,
  createStockPreparationContinuationStore,
} = storeModule

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_scs_a'
const OTHER_TENANT = 'tenant_scs_b'
const SHEET = 'sheet_scs_a'
const OTHER_SHEET = 'sheet_scs_b'
const PULLER = 'u_scs_puller'
const FREE_LOCK = { state: { present: true, leaseHeld: false, leaseLive: false }, generation: { generationToken: 'g_free', fencingEpoch: 1, leaseId: null } }
// Values that must never appear in an error (the fixture's keys, component ids, drawing numbers, names).
const VALUE_SENTINELS = ['S-001', 'PART-A', 'PART-B', 'PART-C', 'P-001', 'D100-01', 'SubAssembly', 'M-STEEL', '"path":']

function setEqual(actual, expected, label) {
  assert.deepEqual(actual.slice().sort(), expected.slice().sort(), label)
}

async function expectError(promise, { status, code, reason }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a throw (${code})`)
  if (status !== undefined) assert.equal(caught.status, status, `status of ${caught.code}: ${caught.message}`)
  if (code !== undefined) assert.equal(caught.code, code, caught.message)
  if (reason !== undefined) assert.equal(caught.details && caught.details.reason, reason, JSON.stringify(caught.details))
  return caught
}

function assertValuesFree(error) {
  const text = JSON.stringify({ message: error.message, details: error.details })
  for (const sentinel of VALUE_SENTINELS) assert.ok(!text.includes(sentinel), `error carries a value (${sentinel}): ${text}`)
}

async function world({ withoutUniqueIndexes } = {}) {
  const fixture = await kit.candidateHoldFixture()
  const clock = kit.createClock()
  const db = kit.createFakeRefreshDb({ clock, withoutUniqueIndexes })
  let n = 0
  const store = createStockPreparationContinuationStore({ db, now: clock.now, idGenerator: (kind) => `${kind}_${String((n += 1)).padStart(4, '0')}` })
  const scope = { tenantId: TENANT, sheetId: SHEET, projectNo: fixture.projectNo }
  const bump = kit.createFakeBumpWithin()
  return { fixture, clock, db, store, scope, bump, hold: fixture.hold, sourceIdentity: fixture.sourceIdentity }
}

function computation(overrides = {}) {
  return { lane: 'small_preview', suspended: true, generationToken: 'g_prev', sourceContentDigest: 'src_1', ...overrides }
}

async function seedHolds(w, holds, extra = {}) {
  const { scope, store } = w
  const observed = extra.decisionVersionObserved === undefined ? (w.db.rows(T.state)[0] ? w.db.rows(T.state)[0].decision_version : 0) : extra.decisionVersionObserved
  const result = await store.reconcileHolds({ ...scope, decisionVersionObserved: observed, holds, computation: computation({ suspended: holds.length > 0 }), ...extra })
  const persisted = w.db.rows(T.hold).filter((row) => row.status === 'open')
  return { result, persisted, byFingerprint: new Map(persisted.map((row) => [row.fingerprint, row])) }
}

async function confirmHold(w, hold, options = {}) {
  const { scope, store, sourceIdentity, bump } = w
  // The open row with this fingerprint, else ANY row with it (so a resolved hold reaches the store's own STALE).
  const row = w.db.rows(T.hold).find((entry) => entry.fingerprint === hold.fingerprint && entry.status === 'open')
    || w.db.rows(T.hold).find((entry) => entry.fingerprint === hold.fingerprint)
  if (!row) throw new Error('test: the hold was never persisted')
  return store.confirmContinuation({
    ...scope,
    holdId: row.id,
    echo: kit.echoOf(hold),
    basis: { kind: 'puller_confirmed_same_demand', note: 'same demand' },
    confirmedBy: PULLER,
    sourceIdentity,
    ...(options.input || {}),
  }, { bumpWithin: bump.bumpWithin, ...(options.hooks || {}) })
}

// The kit's (shared with the real-DB cases): a relationship_reconfirm hold about one continuation.
const reconfirmHoldFor = kit.reconfirmHoldFor

// The fake db's statement log as `method:table` (the table prefix dropped), for statement-order pins.
function statementsOf(db, prefix = 'trx.') {
  return db.statements(prefix).map(([method, table]) => `${method}:${String(table).replace('integration_stock_prep_', '')}`)
}

// Every row of the five step-4 tables (the "nothing persisted" fingerprint of a refused decision).
function tablesSnapshot(db) {
  return JSON.stringify(Object.values(T).map((table) => db.rows(table)))
}

function derivedState(w, { pilot = { enabled: true }, lock = FREE_LOCK } = {}) {
  return readProjectRefreshState({
    ok: true,
    pilot,
    continuations: w.db.rows(T.continuation).map(storeModule.__internals.rowToContinuation),
    holds: w.db.rows(T.hold).map(storeModule.__internals.rowToHold),
    state: storeModule.__internals.rowToState(w.db.rows(T.state)[0] || null),
    executions: w.db.rows(T.execution).map(storeModule.__internals.rowToExecution),
    changePlans: [],
    lock,
  })
}

// ── ST-01 migrations ─────────────────────────────────────────────────────────────────────────────

test('ST-01 migrations 102 / 103: tables, vocabularies set-equal to the pure core, unique indexes, claim mirror, no DROP, no audit re-listing, the G10 / Q-B notes', () => {
  const sql102 = kit.readMigrationText(kit.MIGRATION_FILES.continuation)
  const sql103 = kit.readMigrationText(kit.MIGRATION_FILES.refreshState)
  const both = `${sql102}\n${sql103}`
  for (const table of Object.values(T)) assert.ok(both.includes(`CREATE TABLE IF NOT EXISTS ${table} (`), table)
  for (const sql of [sql102, sql103]) {
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')
    assert.match(sql, /up-only/, 'the header states the migration is up-only (no down())')
    assert.doesNotMatch(sql, /ADD CONSTRAINT integration_stock_prep_audit_action_check CHECK \(action IN \(/, 'D9: no audit vocabulary re-listing (the audit-migration test would elect this file)')
    for (const match of sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \S+\s+ON (\S+)/g)) assert.ok(match[1].startsWith('integration_'), match[1])
    for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\S+)/g)) assert.ok(match[1].startsWith('integration_'), match[1])
  }
  const schema = kit.loadSchema()
  const enumOf = (table, column) => {
    const entry = schema[table].enums.find((candidate) => candidate.column === column)
    assert.ok(entry, `${table}.${column} has an enum CHECK`)
    return entry.values
  }
  setEqual(enumOf(T.hold, 'kind'), pairing.HOLD_KINDS, 'hold.kind == HOLD_KINDS')
  setEqual(enumOf(T.hold, 'shape_token'), pairing.SHAPE_TOKENS, 'hold.shape_token == SHAPE_TOKENS (dropped_other_rule included, errata §23.3)')
  assert.ok(enumOf(T.hold, 'shape_token').includes('dropped_other_rule'))
  setEqual(enumOf(T.hold, 'not_confirmable_reason'), pairing.NOT_CONFIRMABLE_REASONS, 'hold.not_confirmable_reason == NOT_CONFIRMABLE_REASONS')
  setEqual(enumOf(T.hold, 'resolution'), HOLD_RESOLUTIONS)
  setEqual(enumOf(T.hold, 'status'), ['open', 'resolved', 'superseded'])
  setEqual(enumOf(T.hold, 'opened_lane'), COMPUTATION_LANES)
  setEqual(enumOf(T.continuation, 'last_verdict'), pairing.CONTINUATION_VERDICTS, 'continuation.last_verdict == CONTINUATION_VERDICTS')
  setEqual(enumOf(T.continuation, 'status_reason'), CONTINUATION_STATUS_REASONS, 'continuation.status_reason == verdicts minus valid / content_changed')
  assert.equal(CONTINUATION_STATUS_REASONS.length, 11)
  assert.ok(!CONTINUATION_STATUS_REASONS.includes('valid') && !CONTINUATION_STATUS_REASONS.includes('content_changed'))
  setEqual(enumOf(T.continuation, 'status'), ['active', 'needs_reconfirmation', 'ended'])
  setEqual(enumOf(T.continuation, 'ended_outcome'), END_OUTCOMES)
  setEqual(enumOf(T.continuation, 'demand_basis'), DEMAND_BASES)
  setEqual(enumOf(T.continuation, 'evidence_history_status'), EVIDENCE_HISTORY_STATUSES)
  setEqual(enumOf(T.state, 'last_computation_lane'), COMPUTATION_LANES)
  setEqual(enumOf(T.execution, 'status'), EXECUTION_STATUSES)
  setEqual(enumOf(T.execution, 'lane'), ['small_apply'])
  // Every unique index the kit models is in the SQL, with the partial predicate it models.
  for (const index of kit.UNIQUE_INDEXES) {
    const unique = schema[index.table].enums.find((entry) => entry.unique && entry.name === index.name)
    if (unique) {
      assert.deepEqual(unique.unique, index.columns, index.name)
      continue
    }
    const re = new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${index.name}\\s+ON ${index.table} \\(([^)]*)\\)( WHERE [^;]+)?;`)
    const match = both.match(re)
    assert.ok(match, `unique index ${index.name} present`)
    assert.deepEqual(match[1].split(',').map((column) => column.trim()), index.columns, index.name)
    if (index.where) assert.ok(match[2], `${index.name} is partial`)
    else assert.equal(match[2], undefined, `${index.name} is total`)
  }
  assert.match(sql102, /WHERE claim_active;/)
  assert.match(sql103, /WHERE status = 'open';/)
  assert.match(sql102, /CHECK \(claim_active = \(status <> 'ended'\)\)/, 'the claim mirror is a DB fact')
  assert.match(sql102, /REFERENCES integration_stock_prep_continuation \(id\)/)
  assert.ok(schema[T.state].columns.decision_version && schema[T.state].columns.decision_version.notNull)
  assert.ok(schema[T.hold].columns.runbook_only && schema[T.hold].columns.detail.notNull)
  assert.ok(schema[T.execution].columns.lease_id.notNull && schema[T.execution].columns.generation_token.notNull)
  // The rollback note is honest: tables stay; the plugin build may not be rolled back while claims exist (G10); Q-B.
  assert.match(sql102, /FORBIDDEN while any/)
  assert.match(sql102, /Tables and rows always stay/)
  // O-20 (review): a rolled-back build cannot db:migrate over recorded 102 / 103; the rollback is RunMigrations 0.
  assert.match(sql102, /CANNOT run `db:migrate` while 102 \/ 103 are recorded/)
  assert.match(sql102, /RunMigrations 0/)
  assert.match(sql102, /Q-B/)
  assert.match(sql103, /Q-B/)
  // INTEGER, never BIGINT (node-postgres returns int8 as strings) — judged on the statements, not the comments.
  const statementsOnly = both.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n')
  assert.doesNotMatch(statementsOnly, /\bBIGINT\b/)
})

// ── ST-02 / ST-03 scope + fail closed ────────────────────────────────────────────────────────────

test('ST-02 scope validation: a blank tenant / sheet / project is 422 before any statement', async () => {
  const w = await world()
  for (const bad of [{ ...w.scope, tenantId: ' ' }, { ...w.scope, sheetId: '' }, { ...w.scope, projectNo: null }]) {
    await expectError(w.store.readGovernanceRows(bad), { status: 422, code: CODES.INPUT_INVALID })
    await expectError(w.store.reconcileHolds({ ...bad, decisionVersionObserved: 0, holds: [], computation: computation() }), { status: 422, code: CODES.INPUT_INVALID })
  }
  assert.equal(w.db.log.length, 0, 'no statement ran')
})

test('ST-03 A11: a failing read is 503 STORE_FAILED (operation, SQLSTATE, partial:false) — never an empty list; a missing table likewise; a page past its ceiling likewise', async () => {
  const w = await world()
  w.db.faults.select = kit.sqlError('57P01', 'terminating connection')
  const failed = await expectError(w.store.readGovernanceRows(w.scope), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(failed.details.operation, 'read_continuations')
  assert.equal(failed.details.sqlState, '57P01')
  assert.equal(failed.details.partial, false)
  assertValuesFree(failed)
  // The failing read is the first step-4 read INSIDE the pinned consult snapshot (review X-1), which rolls back.
  assert.deepEqual(w.db.log.map(([method, args]) => [method, (args && (args.table || args.level)) || null]), [
    ['transaction', null],
    ['trx.setTransactionIsolationLevel', 'repeatable read'],
    ['trx.select', T.continuation],
    ['rollback', null],
  ])
  // A missing table (deploy without migrations 102 / 103): 42P01, same posture.
  w.db.faults.select = (args) => (args.table === T.hold ? kit.sqlError('42P01', 'relation does not exist') : null)
  const missing = await expectError(w.store.readGovernanceRows(w.scope), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(missing.details.sqlState, '42P01')
  assert.equal(missing.details.operation, 'read_holds')
  delete w.db.faults.select
  // readContinuation / readHold: the same translation.
  w.db.faults.selectOne = kit.sqlError('42P01', 'relation does not exist')
  await expectError(w.store.readContinuation({ ...w.scope, continuationId: 'cont_x' }), { status: 503, code: CODES.STORE_FAILED })
  delete w.db.faults.selectOne
  // A ceiling: 101 state rows for one (tenant, project) across sheets — the by-project read cannot be complete.
  for (let i = 0; i < 101; i += 1) {
    await w.db.insertOne(T.state, { id: `rst_cap_${i}`, tenant_id: TENANT, sheet_id: `sheet_cap_${i}`, project_no: w.scope.projectNo, write_scope_key: 'spw2:x', governed_since: w.clock.now() })
  }
  const capped = await expectError(w.store.readGovernanceRows(w.scope), { status: 503, code: CODES.STORE_FAILED, reason: 'row_cap' })
  assert.equal(capped.details.operation, 'read_state')
})

// ── ST-04 confirm ────────────────────────────────────────────────────────────────────────────────

test('ST-04 confirm: statement order, rows, the read-back feeds the pure core, digests agree with the hold subject, the audit hook runs inside the transaction', async () => {
  const w = await world()
  const { hold, scope, store, db, bump, sourceIdentity } = w
  const seeded = await seedHolds(w, [hold])
  assert.equal(seeded.result.holds.opened, 1)
  assert.equal(seeded.result.decisionVersion, 0)
  const holdRow = seeded.byFingerprint.get(hold.fingerprint)
  const events = []
  db.log.length = 0
  const confirmed = await store.confirmContinuation({
    ...scope, holdId: holdRow.id, echo: kit.echoOf(hold), basis: { kind: 'puller_confirmed_same_demand', note: '  same demand  ' }, confirmedBy: PULLER, sourceIdentity,
  }, {
    bumpWithin: bump.bumpWithin,
    auditWithin: async (trx, event) => { events.push({ trxIsHandle: typeof trx.selectOneForUpdate === 'function', event }) },
  })
  assert.equal(confirmed.revision, 1)
  assert.equal(confirmed.memberCount, 4)
  assert.equal(confirmed.decisionVersion, 1)
  assert.equal(confirmed.state, 'confirmed_pending_execution')
  assert.equal(confirmed.nextStep, 'preview_again')
  assert.equal(confirmed.generation.generationToken, bump.calls[0] && (await Promise.resolve(confirmed.generation.generationToken)))
  // The bump ran on the TRANSACTION handle, for this sheet's scope key, with the confirm reason and the tenant.
  assert.equal(bump.calls.length, 1)
  assert.equal(typeof bump.calls[0].trx.selectOneForUpdate, 'function')
  assert.equal(bump.calls[0].scopeKey, sheetWriteScopeKey(SHEET))
  assert.deepEqual(bump.calls[0].options, { reason: 'continuation_confirm', tenantId: TENANT })
  // Statement order inside the transaction.
  const order = db.statements('trx.').map(([method, table]) => `${method}:${String(table).replace('integration_stock_prep_', '')}`)
  assert.deepEqual(order, [
    'trx.selectOneForUpdate:refresh_state',
    'trx.selectOne:refresh_hold',
    // PR-4 review N2: the project's open holds re-read under the lock (S25), the last read before the bump.
    'trx.select:refresh_hold',
    // PR-4 review N3: the unfinished executions re-read AFTER the bump (one read per unfinished status).
    'trx.select:refresh_execution',
    'trx.select:refresh_execution',
    'trx.select:refresh_execution',
    'trx.select:refresh_execution',
    'trx.insertOne:continuation',
    'trx.insertMany:continuation_member',
    'trx.updateRow:refresh_hold',
    'trx.select:refresh_hold',
    'trx.updateRow:refresh_state',
  ])
  assert.ok(db.log.some(([method]) => method === 'commit'))
  // Rows.
  const header = db.rows(T.continuation)[0]
  assert.equal(header.status, 'active')
  assert.equal(header.claim_active, true)
  assert.equal(header.revision, 1)
  assert.equal(header.old_root_record_id, hold.subject.oldRootRecordId)
  assert.equal(header.new_root_key_digest, hold.subject.newRootKeyDigest, 'continuation.new_root_key_digest == hold.subject.newRootKeyDigest (one digest scheme)')
  assert.equal(header.old_root_component_source_id, hold.detail.componentSourceId)
  assert.equal(header.new_parent_component_source_id, JSON.parse(hold.detail.pairs[0].newKey).parentSourceId)
  assert.deepEqual(header.new_root_path_tokens, JSON.parse(hold.detail.pairs[0].newKey).path)
  assert.equal(header.parent_edge_usage, hold.detail.comparison.parentEdgeUsage)
  assert.equal(header.basis_note, 'same demand')
  assert.equal(header.evidence_history_status, 'history_unknown')
  assert.equal(header.evidence_snapshot.comparison.outcome, 'match')
  assert.equal(header.evidence_snapshot.holdFingerprint, hold.fingerprint)
  assert.equal(header.confirmed_generation_token, confirmed.generation.generationToken)
  assert.equal(header.executed_execution_id, null)
  assert.equal(header.external_system_id, sourceIdentity.externalSystemId)
  const members = db.rows(T.member).sort((a, b) => a.position - b.position)
  assert.equal(members.length, 4)
  assert.deepEqual(members[0].relative_path_tokens, [])
  assert.equal(members[0].old_record_id, hold.subject.oldRootRecordId)
  assert.ok(members.every((member) => member.claim_active === true && member.continuation_id === header.id))
  assert.ok(members.every((member) => member.new_key_digest === pairing.__internals.subjectDigest(member.new_key)))
  assert.equal(new Set(members.map((member) => member.old_row_content_digest)).size, 4, 'per-row content digests')
  const resolved = db.rows(T.hold)[0]
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.resolution, 'continuation_confirmed')
  assert.equal(resolved.resolved_by, PULLER)
  const state = db.rows(T.state)[0]
  assert.equal(state.decision_version, 1)
  assert.equal(state.version, 2)
  assert.equal(state.hold_set_fingerprint, null)
  // The audit hook: once, inside the transaction, values-free.
  assert.equal(events.length, 1)
  assert.equal(events[0].trxIsHandle, true)
  assert.equal(events[0].event.operation, 'continuation_confirmed')
  assert.equal(events[0].event.memberCount, 4)
  assert.equal(events[0].event.comparisonOutcome, 'match')
  const eventText = JSON.stringify(events[0].event)
  for (const sentinel of VALUE_SENTINELS) assert.ok(!eventText.includes(sentinel), `audit event carries ${sentinel}`)
  // The read-back is what the pure core accepts.
  const rows = await store.readGovernanceRows(scope)
  assert.equal(rows.ok, true)
  assert.equal(rows.continuations.length, 1)
  assert.equal(rows.members.length, 4)
  assert.equal(rows.holds.length, 0, 'open holds only')
  assert.equal(rows.states.length, 1)
  const headers = rows.continuations.map((entry) => ({ ...entry, memberCount: rows.members.filter((member) => member.continuationId === entry.id).length }))
  const input = pairing.normalizeContinuationInput({ storeState: 'ok', pilot: true, projectNo: scope.projectNo, continuations: headers, members: rows.members, demandEvidence: null, sourceIdentity, specSlotDeclared: false, persistedHolds: [] })
  const projection = pairing.buildContinuationProjection(input.continuations, input.members)
  assert.equal(projection.suppressAddKeys.size, 4)
  assert.equal(projection.protectInactiveKeys.size, 4)
  assert.equal(projection.byOldRecordId.size, 4)
  assert.ok(projection.suppressAddKeys.has(hold.detail.pairs[0].newKey))
  assert.ok(projection.protectInactiveKeys.has(hold.detail.pairs[0].oldKey))
  // The derived state: confirmed, waiting for its execution.
  assert.equal(derivedState(w).status, 'confirmed_pending_execution')
  // readContinuation returns the header with its members in position order.
  const detail = await store.readContinuation({ ...scope, continuationId: header.id })
  assert.equal(detail.members.length, 4)
  assert.deepEqual(detail.members.map((member) => member.position), [0, 1, 2, 3])
  // Confirming the same hold again: it is resolved -> STALE, nothing changes.
  await expectError(confirmHold(w, hold), { status: 409, code: CODES.CONFIRM_STALE, reason: 'hold_not_open' })
  assert.equal(db.rows(T.continuation).length, 1)
})

// ── ST-05 confirm refusals ───────────────────────────────────────────────────────────────────────

test('ST-05 confirm refusals: no bumpWithin, absent / resolved / foreign hold, kind, confirmability, echo, the lock refusing, a malformed bump, an audit failure, basis validation — each leaves nothing behind', async () => {
  const w = await world()
  const { hold, scope, store, db, sourceIdentity } = w
  const seeded = await seedHolds(w, [hold])
  const holdRow = seeded.byFingerprint.get(hold.fingerprint)
  const base = { ...scope, holdId: holdRow.id, echo: kit.echoOf(hold), basis: { kind: 'puller_confirmed_same_demand' }, confirmedBy: PULLER, sourceIdentity }
  const snapshot = () => JSON.stringify({ c: db.rows(T.continuation), m: db.rows(T.member), h: db.rows(T.hold), s: db.rows(T.state) })
  const before = snapshot()
  // No bumpWithin: 501 before any transaction.
  db.log.length = 0
  await expectError(store.confirmContinuation(base, {}), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'bump_within_missing' })
  assert.equal(db.log.length, 0)
  const bump = kit.createFakeBumpWithin()
  const hooks = { bumpWithin: bump.bumpWithin }
  // Absent hold -> STALE; another tenant's scope -> no state row -> STALE; a hold read under another tenant -> TENANT_MISMATCH.
  await expectError(store.confirmContinuation({ ...base, holdId: 'hold_nope' }, hooks), { status: 409, code: CODES.CONFIRM_STALE, reason: 'hold_absent' })
  await expectError(store.confirmContinuation({ ...base, tenantId: OTHER_TENANT }, hooks), { status: 409, code: CODES.TENANT_MISMATCH })
  await expectError(store.confirmContinuation({ ...base, sheetId: OTHER_SHEET }, hooks), { status: 409, code: CODES.CONFIRM_STALE, reason: 'state_row_absent' })
  // Echo mismatch -> STALE naming the fingerprint, values-free.
  const stale = await expectError(store.confirmContinuation({ ...base, echo: { ...base.echo, comparisonFingerprint: 'x'.repeat(64) } }, hooks), { status: 409, code: CODES.CONFIRM_STALE, reason: 'comparison_fingerprint' })
  assertValuesFree(stale)
  await expectError(store.confirmContinuation({ ...base, echo: { ...base.echo, holdFingerprint: 'y'.repeat(64) } }, hooks), { status: 409, code: CODES.CONFIRM_STALE, reason: 'hold_fingerprint' })
  // The lock refuses (a live writer): its own error passes through and the transaction rolled back.
  bump.refuseWith(kit.writeLockedError())
  const locked = await expectError(store.confirmContinuation(base, hooks), { status: 409, code: 'STOCK_PREP_PROJECT_WRITE_LOCKED' })
  assert.equal(locked.details.holderPurpose, 'small_apply')
  assert.equal(db.log[db.log.length - 1][0], 'rollback')
  // A malformed bump answer: 500, rolled back.
  bump.answerMalformed()
  await expectError(store.confirmContinuation(base, hooks), { status: 500, code: CODES.INPUT_INVALID })
  // An audit failure rolls the decision back (E09): no continuation, the hold still open, decision_version unchanged.
  await expectError(store.confirmContinuation(base, { ...hooks, auditWithin: async () => { throw kit.sqlError('23514', 'audit vocabulary') } }), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(snapshot(), before, 'nothing persisted by any refused confirm')
  assert.equal(db.rows(T.hold)[0].status, 'open')
  // Kind / confirmability: a non-candidate hold and a non-confirmable candidate.
  const ambiguous = { ...hold, kind: 'candidate_ambiguous', confirmable: false, notConfirmableReason: 'ambiguous_pairing' }
  ambiguous.fingerprint = pairing.holdFingerprint(ambiguous)
  const seeded2 = await seedHolds(w, [hold, ambiguous])
  const ambiguousRow = seeded2.byFingerprint.get(ambiguous.fingerprint)
  const notAllowed = await expectError(store.confirmContinuation({ ...base, holdId: ambiguousRow.id, echo: kit.echoOf(ambiguous) }, hooks), { status: 409, code: CODES.CONFIRM_NOT_ALLOWED, reason: 'kind' })
  assert.equal(notAllowed.details.kind, 'candidate_ambiguous')
  // Basis validation.
  await expectError(store.confirmContinuation({ ...base, basis: { kind: 'customer_rule' } }, hooks), { status: 422, code: CODES.INPUT_INVALID })
  await expectError(store.confirmContinuation({ ...base, basis: { kind: 'puller_confirmed_same_demand', note: `bad${String.fromCharCode(7)}` } }, hooks), { status: 400, code: CODES.INPUT_INVALID })
  await expectError(store.confirmContinuation({ ...base, basis: { kind: 'puller_confirmed_same_demand', note: 'n'.repeat(2001) } }, hooks), { status: 422, code: CODES.INPUT_INVALID })
  await expectError(store.confirmContinuation({ ...base, sourceIdentity: { externalSystemId: 'x' } }, hooks), { status: 500, code: CODES.INPUT_INVALID })
  // The real hold still confirms after all of that.
  const ok = await store.confirmContinuation(base, hooks)
  assert.equal(ok.revision, 1)
})

// ── ST-06 A08 ────────────────────────────────────────────────────────────────────────────────────

test('ST-06 A08: two holds claiming one old record -> exactly one confirm commits, the other is 409 CONFIRM_CONFLICT from the partial unique index and persists nothing; two old sets claiming one new position likewise', async () => {
  const w = await world()
  const { hold, store, db, scope } = w
  const competing = kit.competingCandidateHold(hold)
  assert.notEqual(competing.fingerprint, hold.fingerprint)
  assert.equal(competing.detail.pairs[0].oldRecordId, hold.detail.pairs[0].oldRecordId, 'same old root record')
  assert.notEqual(competing.detail.pairs[0].newKey, hold.detail.pairs[0].newKey, 'another new position')
  const sameNew = kit.sameNewPositionHold(hold)
  assert.equal(sameNew.detail.pairs[0].newKey, hold.detail.pairs[0].newKey, 'same new position')
  assert.notEqual(sameNew.detail.pairs[0].oldRecordId, hold.detail.pairs[0].oldRecordId)
  await seedHolds(w, [hold, competing, sameNew])
  assert.equal(db.rows(T.hold).filter((row) => row.status === 'open').length, 3)
  const first = await confirmHold(w, hold)
  assert.equal(first.revision, 1)
  const stateAfterFirst = db.rows(T.state)[0].decision_version
  // The loser: 23505 on the member old-record index (the header's old-root index would catch the same claim).
  const conflict = await expectError(confirmHold(w, competing), { status: 409, code: CODES.CONFIRM_CONFLICT, reason: 'claim_taken' })
  assert.equal(conflict.details.sqlState, '23505')
  assert.ok(['uniq_integration_stock_prep_continuation_old_root', 'uniq_integration_stock_prep_continuation_member_old_record'].includes(conflict.details.constraint), conflict.details.constraint)
  assertValuesFree(conflict)
  assert.equal(db.rows(T.continuation).length, 1, 'no second continuation')
  assert.equal(db.rows(T.member).length, 4, 'no members of the loser')
  assert.equal(db.rows(T.hold).find((row) => row.fingerprint === competing.fingerprint).status, 'open', 'the losing hold stays open')
  assert.equal(db.rows(T.state)[0].decision_version, stateAfterFirst, 'the loser moved no decision')
  assert.equal(db.log[db.log.length - 1][0], 'rollback')
  // Two old sets, one new position: the new-key claim.
  const conflict2 = await expectError(confirmHold(w, sameNew), { status: 409, code: CODES.CONFIRM_CONFLICT })
  assert.ok(['uniq_integration_stock_prep_continuation_new_root', 'uniq_integration_stock_prep_continuation_member_new_key'].includes(conflict2.details.constraint), conflict2.details.constraint)
  assert.equal(db.rows(T.continuation).length, 1)
  // The projection stays consistent: one continuation, four members.
  const rows = await store.readGovernanceRows(scope)
  assert.equal(rows.continuations.length, 1)
  assert.equal(rows.members.length, 4)
})

// ── ST-07 reconciliation ─────────────────────────────────────────────────────────────────────────

test('ST-07 reconciliation: upsert-then-lock, the decision_version CAS, open / keep / supersede by fingerprint, runbook-only survives, verdicts, settlement, decision_version never moves, a fault rolls back', async () => {
  const w = await world()
  const { hold, store, db, scope, clock } = w
  db.log.length = 0
  const first = await store.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [hold], computation: computation() })
  const order = db.statements('trx.').map(([method, table]) => `${method}:${String(table).replace('integration_stock_prep_', '')}`)
  assert.deepEqual(order.slice(0, 2), ['trx.upsertOne:refresh_state', 'trx.selectOneForUpdate:refresh_state'], 'the state row is created by UPSERT then locked FOR UPDATE')
  assert.equal(first.version, 1)
  assert.equal(first.decisionVersion, 0)
  assert.deepEqual(first.holds, { opened: 1, kept: 0, superseded: 0, open: 1 })
  assert.equal(first.settled, false)
  const state1 = db.rows(T.state)[0]
  assert.equal(state1.tenant_id, TENANT)
  assert.equal(state1.write_scope_key, sheetWriteScopeKey(SHEET))
  assert.equal(state1.last_computation_lane, 'small_preview')
  assert.equal(state1.last_computation_suspended, true)
  assert.equal(state1.hold_set_fingerprint, storeModule.holdSetFingerprintOf([hold.fingerprint]))
  const opened = db.rows(T.hold)[0]
  assert.equal(opened.opened_lane, 'small_preview')
  assert.equal(opened.opened_generation_token, 'g_prev')
  assert.equal(opened.kind, 'continuation_candidate')
  assert.equal(opened.confirmable, true)
  assert.equal(opened.not_confirmable_reason, null)
  // The same hold again: kept, last_seen_at advanced, no second row.
  clock.advance(60_000)
  const second = await store.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [hold], computation: computation({ lane: 'reconcile' }) })
  assert.deepEqual(second.holds, { opened: 0, kept: 1, superseded: 0, open: 1 })
  assert.equal(db.rows(T.hold).length, 1)
  assert.equal(db.rows(T.hold)[0].last_seen_at.toISOString(), clock.iso())
  assert.equal(db.rows(T.state)[0].version, 2)
  // The CAS: a decision landed in between -> 409 STATE_MOVED and nothing persisted.
  const snapshot = JSON.stringify({ h: db.rows(T.hold), s: db.rows(T.state) })
  const moved = await expectError(store.reconcileHolds({ ...scope, decisionVersionObserved: 7, holds: [], computation: computation({ suspended: false }) }), { status: 409, code: CODES.STATE_MOVED, reason: 'decision_version' })
  assertValuesFree(moved)
  assert.equal(JSON.stringify({ h: db.rows(T.hold), s: db.rows(T.state) }), snapshot)
  // A different hold set: the old one superseded, the new one opened.
  const other = kit.competingCandidateHold(hold)
  const third = await store.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [other], computation: computation() })
  assert.deepEqual(third.holds, { opened: 1, kept: 0, superseded: 1, open: 1 })
  const supersededRow = db.rows(T.hold).find((row) => row.fingerprint === hold.fingerprint)
  assert.equal(supersededRow.status, 'superseded')
  assert.equal(supersededRow.resolution, 'superseded_by_computation')
  assert.ok(supersededRow.resolved_at)
  // A settlement with holds is refused; a clean computation supersedes everything and settles.
  await expectError(store.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [other], computation: computation(), settlement: { sheetMachineDigest: 'm1' } }), { status: 500, code: CODES.INPUT_INVALID })
  const clean = await store.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [], computation: computation({ suspended: false, lane: 'small_apply', generationToken: 'g_apply' }), settlement: { executionId: null, generationToken: 'g_apply', sourceContentDigest: 'src_1', sheetMachineDigest: 'machine_1' } })
  assert.deepEqual(clean.holds, { opened: 0, kept: 0, superseded: 1, open: 0 })
  assert.equal(clean.settled, true)
  assert.equal(clean.holdSetFingerprint, null)
  const settledState = db.rows(T.state)[0]
  assert.equal(settledState.settled_sheet_machine_digest, 'machine_1')
  assert.equal(settledState.settled_generation_token, 'g_apply')
  assert.equal(settledState.decision_version, 0, 'reconciliations never move decision_version')
  assert.equal(derivedState(w).status, 'complete')
  // Verdicts: an active continuation moves to needs_reconfirmation with its reason; `valid` never moves it back; content_changed leaves the status.
  await seedHolds(w, [hold])
  await confirmHold(w, hold)
  const contId = db.rows(T.continuation)[0].id
  const dv = db.rows(T.state)[0].decision_version
  assert.equal(dv, 1)
  const verdictRun = await store.reconcileHolds({ ...scope, decisionVersionObserved: dv, holds: [reconfirmHoldFor(contId, { confirmable: true })], verdicts: { [contId]: 'source_scope_changed' }, computation: computation({ generationToken: 'g_v1' }) })
  assert.equal(verdictRun.reconfirmations, 1)
  let cont = db.rows(T.continuation)[0]
  assert.equal(cont.status, 'needs_reconfirmation')
  assert.equal(cont.status_reason, 'source_scope_changed')
  assert.equal(cont.last_verdict, 'source_scope_changed')
  assert.equal(cont.last_verified_generation_token, 'g_v1')
  assert.equal(cont.claim_active, true, 'protection stays applied')
  assert.equal(derivedState(w).status, 'pending_confirmation')
  await store.reconcileHolds({ ...scope, decisionVersionObserved: dv, holds: [reconfirmHoldFor(contId, { confirmable: true })], verdicts: { [contId]: 'valid' }, computation: computation({ generationToken: 'g_v2' }) })
  cont = db.rows(T.continuation)[0]
  assert.equal(cont.status, 'needs_reconfirmation', 'a verdict of valid does not silently return a stale relationship to active (§6.3)')
  assert.equal(cont.last_verdict, 'valid')
  await expectError(store.reconcileHolds({ ...scope, decisionVersionObserved: dv, holds: [], verdicts: { cont_unknown: 'valid' }, computation: computation({ suspended: false }) }), { status: 500, code: CODES.INPUT_INVALID })
  await expectError(store.reconcileHolds({ ...scope, decisionVersionObserved: dv, holds: [], verdicts: { [contId]: 'made_up' }, computation: computation({ suspended: false }) }), { status: 500, code: CODES.INPUT_INVALID })
  // A fault mid-way (the hold insert) rolls back: no half-written hold set, version unchanged.
  const versionBefore = db.rows(T.state)[0].version
  const holdsBefore = db.rows(T.hold).length
  db.faults.insertOne = kit.sqlError('53100', 'disk full')
  const faulted = await expectError(store.reconcileHolds({ ...scope, decisionVersionObserved: dv, holds: [reconfirmHoldFor(contId), kit.sameNewPositionHold(hold)], computation: computation() }), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(faulted.details.operation, 'hold_open')
  assert.equal(db.rows(T.state)[0].version, versionBefore)
  assert.equal(db.rows(T.hold).length, holdsBefore)
  delete db.faults.insertOne
  // A content_changed verdict on an ACTIVE continuation: status untouched (it raises a relationship_content_change hold).
  const w2 = await world()
  await seedHolds(w2, [w2.hold])
  await confirmHold(w2, w2.hold)
  const id2 = w2.db.rows(T.continuation)[0].id
  await w2.store.reconcileHolds({ ...w2.scope, decisionVersionObserved: 1, holds: [], verdicts: { [id2]: 'content_changed' }, computation: computation({ suspended: false }) })
  assert.equal(w2.db.rows(T.continuation)[0].status, 'active')
  assert.equal(w2.db.rows(T.continuation)[0].last_verdict, 'content_changed')
  // Two holds of one computation sharing a fingerprint: a planner defect, refused 500 before any statement.
  w2.db.log.length = 0
  await expectError(w2.store.reconcileHolds({ ...w2.scope, decisionVersionObserved: 1, holds: [w2.hold, w2.hold], computation: computation() }), { status: 500, code: CODES.INPUT_INVALID })
  assert.equal(w2.db.log.length, 0)
  // A hold whose `detail` is null (migration 103: NOT NULL; the pure core always emits an object): refused 500
  // INPUT_INVALID before any statement — never sent to the DB to come back 23502 -> 503.
  const nullDetail = await expectError(w2.store.reconcileHolds({ ...w2.scope, decisionVersionObserved: 1, holds: [{ ...w2.hold, detail: null }], computation: computation() }), { status: 500, code: CODES.INPUT_INVALID })
  assert.equal(nullDetail.details.field, 'holds[0].detail')
  assert.equal(w2.db.log.length, 0)
})

// ── ST-08 end ────────────────────────────────────────────────────────────────────────────────────

test('ST-08 end: escalate keeps the hold open runbook-only (a clean computation does not supersede it); release only after new_position_removed with no new position; superseded only inside a confirm; released claims can be re-claimed; supersedes ends and replaces in one transaction', async () => {
  const w = await world()
  const { hold, store, db, scope, bump } = w
  await seedHolds(w, [hold])
  await confirmHold(w, hold)
  const cont = db.rows(T.continuation)[0]
  // A reconfirm hold about it (structure_changed: not reconfirmable).
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 1, holds: [reconfirmHoldFor(cont.id, { confirmable: false, verdict: 'structure_changed' })], verdicts: { [cont.id]: 'structure_changed' }, computation: computation() })
  const endBase = { ...scope, continuationId: cont.id, revision: 1, endedBy: PULLER }
  const hooks = { bumpWithin: bump.bumpWithin }
  // superseded_by_new_confirmation is confirm-only; release is not admissible here (last verdict structure_changed).
  db.log.length = 0
  await expectError(store.endContinuation({ ...endBase, outcome: 'superseded_by_new_confirmation' }, hooks), { status: 409, code: CODES.END_OUTCOME_NOT_ADMISSIBLE, reason: 'outcome_confirm_only' })
  assert.equal(db.log.length, 0, 'refused before any statement')
  const structureHold = db.rows(T.hold).find((row) => row.continuation_id === cont.id && row.status === 'open')
  const notAdmissible = await expectError(store.endContinuation({ ...endBase, outcome: 'release_to_normal_refresh', facts: { holdId: structureHold.id, holdFingerprint: structureHold.fingerprint } }, hooks), { status: 409, code: CODES.END_OUTCOME_NOT_ADMISSIBLE, reason: 'last_verdict' })
  assert.equal(notAdmissible.details.lastVerdict, 'structure_changed')
  assert.equal(notAdmissible.details.recordedVerdict, 'structure_changed')
  // A release names the hold it decides from (PR-4 review B1): without `facts` it is 400 before any statement.
  db.log.length = 0
  await expectError(store.endContinuation({ ...endBase, outcome: 'release_to_normal_refresh' }, hooks), { status: 400, code: CODES.INPUT_INVALID })
  await expectError(store.endContinuation({ ...endBase, outcome: 'escalate_special_repair', facts: { holdId: structureHold.id, holdFingerprint: structureHold.fingerprint } }, hooks), { status: 400, code: CODES.INPUT_INVALID })
  assert.equal(db.log.length, 0, 'the facts shape is refused before any statement')
  await expectError(store.endContinuation({ ...endBase, outcome: 'made_up' }, hooks), { status: 400, code: CODES.INPUT_INVALID })
  await expectError(store.endContinuation({ ...endBase, revision: 2, outcome: 'escalate_special_repair' }, hooks), { status: 409, code: CODES.CONFIRM_STALE, reason: 'continuation_revision' })
  assert.equal(db.rows(T.continuation)[0].status, 'needs_reconfirmation', 'nothing ended')
  // Escalate.
  const bumpsBefore = bump.calls.length
  const escalated = await store.endContinuation({ ...endBase, outcome: 'escalate_special_repair', note: 'specialist' }, hooks)
  assert.equal(escalated.status, 'ended')
  assert.equal(escalated.holdsEscalated, 1)
  assert.equal(escalated.holdsResolved, 0)
  assert.equal(escalated.decisionVersion, 2)
  assert.deepEqual(bump.calls[bumpsBefore].options, { reason: 'continuation_end', tenantId: TENANT })
  const ended = db.rows(T.continuation)[0]
  assert.equal(ended.status, 'ended')
  assert.equal(ended.claim_active, false)
  assert.equal(ended.ended_outcome, 'escalate_special_repair')
  assert.equal(ended.ended_by, PULLER)
  assert.equal(ended.ended_note, 'specialist')
  assert.ok(ended.ended_at)
  assert.ok(db.rows(T.member).every((member) => member.claim_active === false), 'members mirror the header')
  const escalatedHold = db.rows(T.hold).find((row) => row.continuation_id === cont.id && row.status === 'open')
  assert.ok(escalatedHold, 'the reconfirm hold stays OPEN')
  assert.equal(escalatedHold.runbook_only, true)
  assert.equal(escalatedHold.confirmable, false)
  assert.equal(escalatedHold.not_confirmable_reason, 'specialist_repair')
  // A clean computation does NOT supersede a runbook-only hold: the project stays suspended.
  const clean = await store.reconcileHolds({ ...scope, decisionVersionObserved: 2, holds: [], computation: computation({ suspended: false }) })
  assert.deepEqual(clean.holds, { opened: 0, kept: 0, superseded: 0, open: 1 })
  assert.equal(derivedState(w).status, 'pending_confirmation')
  // Ending again: STALE. The governance read still returns the ended row (it governs) and no members.
  await expectError(store.endContinuation({ ...endBase, outcome: 'escalate_special_repair' }, hooks), { status: 409, code: CODES.CONFIRM_STALE, reason: 'continuation_ended' })
  const rows = await store.readGovernanceRows(scope)
  assert.equal(rows.continuations.length, 1)
  assert.equal(rows.continuations[0].status, 'ended')
  assert.equal(rows.members.length, 0)
  // S25 inside the store (PR-4 review N2): while the runbook-only hold is OPEN, a confirm is refused under the
  // lock — 409 CONFIRM_NOT_ALLOWED runbook_only_hold_open, nothing persisted, no bump.
  await seedHolds(w, [hold], { decisionVersionObserved: 2 })
  {
    const before = tablesSnapshot(db)
    const bumpsBefore = bump.calls.length
    const refused = await expectError(confirmHold(w, hold), { status: 409, code: CODES.CONFIRM_NOT_ALLOWED, reason: 'runbook_only_hold_open' })
    assert.deepEqual(refused.details, { reason: 'runbook_only_hold_open', holdCount: 1, partial: false })
    assert.equal(bump.calls.length, bumpsBefore, 'refused before the bump')
    assert.equal(tablesSnapshot(db), before, 'nothing persisted')
  }
  // The owner-approved runbook closes the escalated hold (the one path out of S25; no store method writes it).
  for (const row of db.tables.get(T.hold).values()) {
    if (row.id === escalatedHold.id) { row.status = 'resolved'; row.resolution = 'runbook_closed' }
  }
  // Released claims can be re-claimed: the same hold confirms again after the end.
  const again = await confirmHold(w, hold)
  assert.equal(again.revision, 1)
  assert.equal(db.rows(T.continuation).filter((row) => row.claim_active).length, 1)
  assert.equal(db.rows(T.continuation).length, 2)
  // release_to_normal_refresh (PR-4 review B1): decided INSIDE the transaction from THE open relationship_reconfirm
  // row's recorded facts — never from the caller. A hold without the count: facts_missing; count 1:
  // new_position_present; the hold named by `facts` no longer the open one (superseded by a later computation
  // that still admits): STALE facts_moved; count 0 named by the caller: released.
  const live = db.rows(T.continuation).find((row) => row.claim_active)
  const reconfirmWithCount = (count, extra = {}) => {
    const h = reconfirmHoldFor(live.id, { confirmable: false, verdict: 'new_position_removed' })
    h.detail = { ...h.detail, ...(count === undefined ? {} : { componentNewPositionCount: count }), ...extra }
    h.fingerprint = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs')).holdFingerprint(h)
    return h
  }
  const openReconfirm = () => db.rows(T.hold).find((row) => row.continuation_id === live.id && row.status === 'open')
  const factsOf = (row) => ({ holdId: row.id, holdFingerprint: row.fingerprint })
  const releaseBase = { ...scope, continuationId: live.id, revision: 1, endedBy: PULLER, outcome: 'release_to_normal_refresh' }
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 3, holds: [reconfirmWithCount(undefined)], verdicts: { [live.id]: 'new_position_removed' }, computation: computation() })
  await expectError(store.endContinuation({ ...releaseBase, facts: factsOf(openReconfirm()) }, hooks), { status: 409, code: CODES.END_OUTCOME_NOT_ADMISSIBLE, reason: 'facts_missing' })
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 3, holds: [reconfirmWithCount(1)], verdicts: { [live.id]: 'new_position_removed' }, computation: computation() })
  const present = await expectError(store.endContinuation({ ...releaseBase, facts: factsOf(openReconfirm()) }, hooks), { status: 409, code: CODES.END_OUTCOME_NOT_ADMISSIBLE, reason: 'new_position_present' })
  assert.equal(present.details.componentNewPositionCount, 1)
  const shown = openReconfirm()
  // The next computation keeps count 0 but recomputes the hold (another fingerprint): the caller's facts are stale.
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 3, holds: [reconfirmWithCount(0)], verdicts: { [live.id]: 'new_position_removed' }, computation: computation() })
  await expectError(store.endContinuation({ ...releaseBase, facts: factsOf(shown) }, hooks), { status: 409, code: CODES.CONFIRM_STALE, reason: 'facts_moved' })
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 3, holds: [reconfirmWithCount(0, { recomputed: true })], verdicts: { [live.id]: 'new_position_removed' }, computation: computation() })
  await expectError(store.endContinuation({ ...releaseBase, facts: factsOf(shown) }, hooks), { status: 409, code: CODES.CONFIRM_STALE, reason: 'facts_moved' })
  assert.equal(db.rows(T.continuation).find((row) => row.id === live.id).status, 'needs_reconfirmation', 'nothing released on stale facts')
  const decidedFrom = openReconfirm()
  const released = await store.endContinuation({ ...releaseBase, facts: factsOf(decidedFrom) }, hooks)
  assert.equal(released.holdsResolved, 1)
  const releasedHold = db.rows(T.hold).find((row) => row.id === decidedFrom.id)
  assert.equal(releasedHold.status, 'resolved')
  assert.equal(releasedHold.resolution, 'continuation_ended')
  assert.equal(db.rows(T.hold).filter((row) => row.continuation_id === live.id && row.status === 'open').length, 0, 'the superseded recomputations stay superseded; the decided-from row is resolved')
  // `supersedes`: a new confirmation replaces a live continuation in ONE transaction (claims move with it).
  const w3 = await world()
  await seedHolds(w3, [w3.hold])
  const firstId = (await confirmHold(w3, w3.hold)).continuationId
  const competing = kit.competingCandidateHold(w3.hold)
  await seedHolds(w3, [competing], { decisionVersionObserved: 1 })
  await expectError(confirmHold(w3, competing), { status: 409, code: CODES.CONFIRM_CONFLICT })
  const replaced = await confirmHold(w3, competing, { input: { supersedes: { continuationId: firstId, revision: 1 } } })
  assert.equal(replaced.supersededContinuationId, firstId)
  const old = w3.db.rows(T.continuation).find((row) => row.id === firstId)
  assert.equal(old.status, 'ended')
  assert.equal(old.ended_outcome, 'superseded_by_new_confirmation')
  assert.equal(old.claim_active, false)
  assert.equal(w3.db.rows(T.continuation).filter((row) => row.claim_active).length, 1)
  assert.equal(w3.db.rows(T.member).filter((row) => row.claim_active).length, 4)
  await expectError(confirmHold(w3, w3.hold, { input: { supersedes: { continuationId: firstId, revision: 1 } } }), { status: 409, code: CODES.CONFIRM_STALE })
})

// ── ST-09 re-confirm ─────────────────────────────────────────────────────────────────────────────

test('ST-09 re-confirm: UPDATE in place (same id, revision + 1, active, reason cleared, executed_execution_id cleared, new fingerprints and source identity), admissible reasons only', async () => {
  const w = await world()
  const { hold, store, db, scope, bump, sourceIdentity } = w
  await seedHolds(w, [hold])
  await confirmHold(w, hold)
  const cont = db.rows(T.continuation)[0]
  const reconfirmHold = reconfirmHoldFor(cont.id, { confirmable: true, verdict: 'source_scope_changed' })
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 1, holds: [reconfirmHold], verdicts: { [cont.id]: 'source_scope_changed' }, computation: computation() })
  const holdRow = db.rows(T.hold).find((row) => row.fingerprint === reconfirmHold.fingerprint)
  const newIdentity = { ...sourceIdentity, readPlanDigest: 'c'.repeat(64) }
  const base = { ...scope, continuationId: cont.id, revision: 1, holdId: holdRow.id, echo: kit.echoOf(reconfirmHold), confirmedBy: PULLER, sourceIdentity: newIdentity }
  const hooks = { bumpWithin: bump.bumpWithin }
  await expectError(store.reconfirmContinuation({ ...base, revision: 3 }, hooks), { status: 409, code: CODES.CONFIRM_STALE, reason: 'continuation_revision' })
  await expectError(store.reconfirmContinuation({ ...base, echo: { ...base.echo, evidenceFingerprint: 'z'.repeat(64) } }, hooks), { status: 409, code: CODES.CONFIRM_STALE, reason: 'evidence_fingerprint' })
  await expectError(store.reconfirmContinuation(base, {}), { status: 501, code: CODES.STORE_UNAVAILABLE })
  const done = await store.reconfirmContinuation(base, hooks)
  assert.equal(done.continuationId, cont.id)
  assert.equal(done.revision, 2)
  assert.equal(done.decisionVersion, 2)
  const after = db.rows(T.continuation)
  assert.equal(after.length, 1, 'no INSERT: the partial unique claims of the stale row still hold')
  assert.equal(after[0].status, 'active')
  assert.equal(after[0].status_reason, null)
  assert.equal(after[0].revision, 2)
  assert.equal(after[0].executed_execution_id, null)
  assert.equal(after[0].read_plan_digest, 'c'.repeat(64))
  assert.equal(after[0].evidence_fingerprint, reconfirmHold.evidenceFingerprint)
  assert.equal(after[0].confirmed_generation_token, done.generation.generationToken)
  assert.equal(db.rows(T.hold).find((row) => row.id === holdRow.id).status, 'resolved')
  assert.equal(derivedState(w).status, 'confirmed_pending_execution')
  // A non-reconfirmable reason (structure_changed) -> NOT_ALLOWED even with a confirmable hold shape.
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 2, holds: [reconfirmHoldFor(cont.id, { confirmable: false, verdict: 'structure_changed' })], verdicts: { [cont.id]: 'structure_changed' }, computation: computation() })
  const structHold = db.rows(T.hold).find((row) => row.status === 'open')
  const refused = await expectError(store.reconfirmContinuation({ ...base, revision: 2, holdId: structHold.id, echo: { holdFingerprint: structHold.fingerprint, comparisonFingerprint: structHold.comparison_fingerprint, evidenceFingerprint: structHold.evidence_fingerprint } }, hooks), { status: 409, code: CODES.CONFIRM_NOT_ALLOWED, reason: 'reason' })
  assert.equal(refused.details.statusReason, 'structure_changed')
})

// ── ST-10 executions ─────────────────────────────────────────────────────────────────────────────

test('ST-10 executions: begin -> running; finish succeeded stamps the bound continuation and the self-settling columns; the governance read returns every unfinished execution beyond the newest five; refusals', async () => {
  const w = await world()
  const { hold, store, db, scope } = w
  await seedHolds(w, [hold])
  const confirmed = await confirmHold(w, hold)
  const guard = { leaseRunId: 'run_1', leaseId: 'lease_1', fencingEpoch: 3, generation: 9, generationToken: 'tok_9' }
  const begin = { ...scope, lane: 'small_apply', guard, tokenRevision: 'rev_1', planDigest: 'plan_1', plannedCounts: { add: 2, update: 0, inactive: 0 }, refreshBinding: { continuations: [{ id: confirmed.continuationId, revision: 1 }], holdSetFingerprint: null }, startedBy: PULLER }
  await expectError(store.beginExecution({ ...begin, lane: 'large_apply_chunk' }), { status: 500, code: CODES.INPUT_INVALID })
  await expectError(store.beginExecution({ ...begin, guard: { ...guard, leaseId: '' } }), { status: 500, code: CODES.INPUT_INVALID })
  const execution = await store.beginExecution(begin)
  assert.equal(execution.status, 'running')
  assert.equal(execution.leaseId, 'lease_1')
  assert.equal(execution.generationToken, 'tok_9')
  assert.deepEqual(execution.refreshBinding, { continuations: [{ id: confirmed.continuationId, revision: 1 }], changePlanId: null, holdSetFingerprint: null })
  assert.ok(execution.id.startsWith('execution_'))
  // Derived: running with its live lease -> executing; with the lease gone -> failed_pending_recovery.
  const liveLock = { state: { present: true, leaseHeld: true, leaseLive: true }, generation: { generationToken: 'tok_9', fencingEpoch: 3, leaseId: 'lease_1' } }
  assert.equal(derivedState(w, { lock: liveLock }).status, 'executing')
  assert.equal(derivedState(w).status, 'failed_pending_recovery')
  // Refusals.
  await expectError(store.finishExecution({ ...scope, executionId: execution.id, status: 'running' }), { status: 500, code: CODES.INPUT_INVALID })
  await expectError(store.finishExecution({ ...scope, executionId: execution.id, status: 'partial', settlement: { sheetMachineDigest: 'm' } }), { status: 500, code: CODES.INPUT_INVALID })
  await expectError(store.finishExecution({ ...scope, tenantId: OTHER_TENANT, executionId: execution.id, status: 'succeeded' }), { status: 409, code: CODES.TENANT_MISMATCH })
  // A bound continuation whose revision is not the live one: refused, rolled back, the execution still running
  // (its own world, so the stale row does not colour the derived state below).
  {
    const w2 = await world()
    await seedHolds(w2, [w2.hold])
    const c2 = await confirmHold(w2, w2.hold)
    const stale = await w2.store.beginExecution({ ...begin, ...w2.scope, refreshBinding: { continuations: [{ id: c2.continuationId, revision: 2 }] } })
    await expectError(w2.store.finishExecution({ ...w2.scope, executionId: stale.id, status: 'succeeded' }), { status: 409, code: CODES.STATE_MOVED, reason: 'bound_continuation_moved' })
    assert.equal(w2.db.rows(T.execution)[0].status, 'running', 'rolled back')
    assert.equal(w2.db.rows(T.continuation)[0].executed_execution_id, null)
  }
  // Finish succeeded with the self-settling columns.
  const finished = await store.finishExecution({ ...scope, executionId: execution.id, status: 'succeeded', written: 0, attemptedWrites: 0, counts: { add: 0, update: 0, inactive: 0, failed: 0 }, settlement: { executionId: execution.id, generationToken: 'tok_9', sourceContentDigest: 'src_1', sheetMachineDigest: 'machine_1' } })
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.continuationsConsumed, 1)
  assert.equal(finished.settled, true)
  assert.ok(finished.finishedAt)
  assert.equal(db.rows(T.continuation)[0].executed_execution_id, execution.id)
  const state = db.rows(T.state)[0]
  assert.equal(state.settled_execution_id, execution.id)
  assert.equal(state.settled_sheet_machine_digest, 'machine_1')
  assert.equal(derivedState(w).status, 'complete')
  await expectError(store.finishExecution({ ...scope, executionId: execution.id, status: 'succeeded' }), { status: 409, code: CODES.STATE_MOVED, reason: 'execution_not_running' })
  // Every unfinished execution is in the governance read, however old: six newer succeeded rows + one old failed.
  w.clock.advance(1000)
  const failedOld = await store.beginExecution({ ...begin, refreshBinding: { continuations: [] } })
  await store.finishExecution({ ...scope, executionId: failedOld.id, status: 'failed', written: 1, attemptedWrites: 2, errorCodes: ['E1'] })
  for (let i = 0; i < 6; i += 1) {
    w.clock.advance(1000)
    const run = await store.beginExecution({ ...begin, refreshBinding: { continuations: [] } })
    await store.finishExecution({ ...scope, executionId: run.id, status: 'succeeded' })
  }
  const rows = await store.readGovernanceRows(scope)
  assert.ok(rows.executions.some((entry) => entry.id === failedOld.id), 'the failed execution beyond the newest five is still answered')
  assert.equal(derivedState(w).status, 'failed_pending_recovery')
})

// ── ST1-a lock order (PR-3a ST-1 / TD-23) ────────────────────────────────────────────────────────

test('ST1-a lock order (TD-23, PR-3a ST-1): a SETTLING finish locks the refresh-state row FIRST, then its execution, then its bound continuations, and the state exactly once; a settling finish without a state row refuses before touching the execution; a non-settling finish never touches the state row', async () => {
  const w = await world()
  const { store, db, scope } = w
  await seedHolds(w, [w.hold])
  const confirmed = await confirmHold(w, w.hold)
  const guard = { leaseRunId: 'run_1', leaseId: 'lease_1', fencingEpoch: 3, generation: 9, generationToken: 'tok_9' }
  const begin = { ...scope, lane: 'small_apply', guard, tokenRevision: 'rev_1', planDigest: 'plan_1', plannedCounts: { add: 0, update: 0, inactive: 0 }, refreshBinding: { continuations: [{ id: confirmed.continuationId, revision: 1 }], holdSetFingerprint: null }, startedBy: PULLER }
  const settling = await store.beginExecution(begin)
  db.log.length = 0
  await store.finishExecution({ ...scope, executionId: settling.id, status: 'succeeded', written: 0, attemptedWrites: 0, counts: { add: 0, update: 0, inactive: 0, failed: 0 }, settlement: { executionId: settling.id, generationToken: 'tok_9', sourceContentDigest: 'src_1', sheetMachineDigest: 'machine_1' } })
  const locking = statementsOf(db).filter((entry) => /^trx\.(selectOneForUpdate|updateRow):/.test(entry))
  assert.deepEqual(locking, [
    'trx.selectOneForUpdate:refresh_state',
    'trx.selectOneForUpdate:refresh_execution',
    'trx.updateRow:refresh_execution',
    'trx.updateRow:continuation',
    'trx.updateRow:refresh_state',
  ])
  assert.equal(locking.filter((entry) => entry === 'trx.selectOneForUpdate:refresh_state').length, 1, 'exactly one state lock per finish')
  // A non-settling finish never touches the state row.
  const plain = await store.beginExecution({ ...begin, refreshBinding: { continuations: [] } })
  db.log.length = 0
  await store.finishExecution({ ...scope, executionId: plain.id, status: 'failed', written: 0, attemptedWrites: 0, errorCodes: ['E1'] })
  assert.equal(statementsOf(db).some((entry) => entry.endsWith(':refresh_state')), false)
  // A settling finish on a project with no state row: refused 409 state_row_absent BEFORE the execution row is
  // locked or written (the run stays `running`; nothing moved).
  const bare = await world()
  const orphan = await bare.store.beginExecution({ ...begin, ...bare.scope, refreshBinding: { continuations: [] } })
  bare.db.log.length = 0
  await expectError(bare.store.finishExecution({ ...bare.scope, executionId: orphan.id, status: 'succeeded', settlement: { sheetMachineDigest: 'machine_1' } }), { status: 409, code: CODES.STATE_MOVED, reason: 'state_row_absent' })
  assert.deepEqual(statementsOf(bare.db).filter((entry) => /^trx\.(selectOneForUpdate|updateRow):/.test(entry)), ['trx.selectOneForUpdate:refresh_state'])
  assert.equal(bare.db.rows(T.execution)[0].status, 'running')
})

// ── ST-11 values-free errors, ST-12 keyed reads ──────────────────────────────────────────────────

test('ST-11 every refusal is values-free: no key, path, component id or drawing number in details or message', async () => {
  const w = await world()
  const { hold, store, scope, bump } = w
  await seedHolds(w, [hold])
  const competing = kit.competingCandidateHold(hold)
  await seedHolds(w, [hold, competing])
  await confirmHold(w, hold)
  const errors = []
  const collect = async (promise) => { try { await promise } catch (error) { errors.push(error) } }
  await collect(confirmHold(w, competing))
  await collect(store.reconcileHolds({ ...scope, decisionVersionObserved: 9, holds: [], computation: computation({ suspended: false }) }))
  await collect(store.endContinuation({ ...scope, continuationId: 'cont_0001', revision: 5, endedBy: PULLER, outcome: 'escalate_special_repair' }, { bumpWithin: bump.bumpWithin }))
  await collect(store.readContinuation({ ...scope, tenantId: OTHER_TENANT, continuationId: w.db.rows(T.continuation)[0].id }))
  assert.ok(errors.length >= 4)
  for (const error of errors) {
    assert.ok(error instanceof StockPreparationRefreshStoreError, error.message)
    assertValuesFree(error)
  }
})

test('ST-12 the governance read is keyed by (tenant, project) AND by sheet: this project\'s rows on another sheet and another project\'s rows on this sheet both come back for the reader to refuse', async () => {
  const w = await world()
  const { hold, store, db, scope } = w
  // Rows of THIS project on ANOTHER sheet (a re-targeted project).
  await store.reconcileHolds({ ...scope, sheetId: OTHER_SHEET, decisionVersionObserved: 0, holds: [hold], computation: computation() })
  const read = await store.readGovernanceRows(scope)
  assert.equal(read.states.length, 1)
  assert.equal(read.states[0].sheetId, OTHER_SHEET)
  assert.equal(read.holds.length, 1)
  assert.equal(read.holds[0].sheetId, OTHER_SHEET)
  // Rows of ANOTHER project on THIS sheet.
  const other = { tenantId: TENANT, sheetId: SHEET, projectNo: 'PRJ-OTHER' }
  await store.reconcileHolds({ ...other, decisionVersionObserved: 0, holds: [], computation: computation({ suspended: false }) })
  const read2 = await store.readGovernanceRows(scope)
  assert.equal(read2.states.length, 1, 'the (sheet, project) read does not match another project; the (tenant, project) read found the other-sheet row')
  const read3 = await store.readGovernanceRows({ ...scope, projectNo: 'PRJ-OTHER' })
  assert.equal(read3.states.length, 1)
  // Another TENANT's continuation on this sheet comes back through the sheet-keyed read (the reader refuses it).
  await db.insertOne(T.continuation, {
    id: 'cont_foreign', tenant_id: OTHER_TENANT, sheet_id: SHEET, project_no: scope.projectNo, write_scope_key: 'spw2:f', status: 'active', revision: 1,
    old_root_record_id: 'rec_f', old_root_key: '{"k":1}', old_root_component_source_id: 'c', new_parent_component_source_id: 'p', new_root_path_tokens: ['p', 'c'],
    new_root_key: '{"k":2}', new_root_key_digest: 'd1', external_system_id: 'x', source_scope_digest: 's', read_plan_digest: 'r',
    pairing_fingerprint: 'pf', comparison_fingerprint: 'cf', evidence_fingerprint: 'ef', evidence_snapshot: {}, demand_basis: 'puller_confirmed_same_demand',
    confirmed_by: 'u', confirmed_at: w.clock.now(), confirmed_generation: 1, confirmed_generation_token: 't', confirmed_fencing_epoch: 0,
  })
  const read4 = await store.readGovernanceRows(scope)
  assert.ok(read4.continuations.some((entry) => entry.tenantId === OTHER_TENANT), 'the sheet-keyed read surfaces the foreign row')
  // readContinuation / readHold refuse a foreign row by tenant, by sheet and by project.
  await expectError(store.readContinuation({ ...scope, continuationId: 'cont_foreign' }), { status: 409, code: CODES.TENANT_MISMATCH })
  const holdRow = db.rows(T.hold)[0]
  await expectError(store.readHold({ ...scope, holdId: holdRow.id }), { status: 409, code: CODES.CONFIRM_STALE, reason: 'hold_scope' })
  assert.equal((await store.readHold({ ...scope, sheetId: OTHER_SHEET, holdId: holdRow.id })).id, holdRow.id)
})

// ── ST-13 A08 per index ──────────────────────────────────────────────────────────────────────────

test('ST-13 A08 per index: each partial unique claim index is the FIRST to answer its own collision (exact constraint) — the header new root, the header old root, a child\'s old record, a duplicate old key, a nested new position — so a fake without any ONE of them answers differently; each member-only rival commits on its own', async () => {
  const shapes = [
    { label: 'header new root', constraint: 'uniq_integration_stock_prep_continuation_new_root', build: (base) => kit.sameNewPositionHold(base) },
    { label: 'header old root', constraint: 'uniq_integration_stock_prep_continuation_old_root', build: (base) => kit.competingCandidateHold(base) },
    { label: 'child old record', constraint: 'uniq_integration_stock_prep_continuation_member_old_record', build: (base) => kit.memberCollisionHold(base, 'old_record'), memberOnly: true },
    { label: 'duplicate old key', constraint: 'uniq_integration_stock_prep_continuation_member_old_key', build: (base) => kit.memberCollisionHold(base, 'old_key'), memberOnly: true },
    { label: 'nested new position', constraint: 'uniq_integration_stock_prep_continuation_member_new_key', build: (base) => kit.memberCollisionHold(base, 'new_key'), memberOnly: true },
  ]
  for (const shape of shapes) {
    const w = await world()
    const rival = shape.build(w.hold)
    assert.notEqual(rival.fingerprint, w.hold.fingerprint, shape.label)
    await seedHolds(w, [w.hold, rival])
    await confirmHold(w, w.hold)
    const membersBefore = w.db.rows(T.member).length
    const decisionBefore = w.db.rows(T.state)[0].decision_version
    const conflict = await expectError(confirmHold(w, rival), { status: 409, code: CODES.CONFIRM_CONFLICT, reason: 'claim_taken' })
    assert.equal(conflict.details.constraint, shape.constraint, `${shape.label}: answered first by its own index`)
    assert.equal(conflict.details.sqlState, '23505', shape.label)
    assertValuesFree(conflict)
    assert.equal(w.db.rows(T.continuation).length, 1, `${shape.label}: no second continuation`)
    assert.equal(w.db.rows(T.member).length, membersBefore, `${shape.label}: no member of the loser`)
    assert.equal(w.db.rows(T.state)[0].decision_version, decisionBefore, `${shape.label}: the loser moved no decision`)
    assert.equal(w.db.rows(T.hold).find((row) => row.fingerprint === rival.fingerprint).status, 'open', `${shape.label}: the losing hold stays open`)
    if (shape.memberOnly) {
      // Control: the rival is a well-formed hold whose header claims are disjoint from the base's — on a sheet where
      // the base was never confirmed it commits, so the conflict above is the member claim and nothing else.
      const alone = await world()
      const own = shape.build(alone.hold)
      await seedHolds(alone, [own])
      const committed = await confirmHold(alone, own)
      assert.equal(committed.revision, 1, `${shape.label}: the rival alone commits`)
      assert.equal(alone.db.rows(T.member).length, own.detail.pairs.length, shape.label)
    }
  }
})

// ── ST-14 one consult snapshot (review X-1) ──────────────────────────────────────────────────────

test('ST-14 one consult snapshot (review X-1): every read in ONE transaction pinned to REPEATABLE READ by its first statement; readFirst on that handle after the pin and before any step-4 read; its refusal passes through and rolls back; a handle that cannot pin is 501 and a failed pin 503, before any read', async () => {
  const w = await world()
  const { store, db, scope, hold } = w
  await seedHolds(w, [hold])
  await confirmHold(w, hold)
  db.log.length = 0
  const seen = []
  const rows = await store.readGovernanceRows(scope, { readFirst: async (snapshot) => { seen.push({ handle: snapshot, logLength: db.log.length }) } })
  assert.equal(rows.ok, true)
  assert.equal(rows.continuations.length, 1)
  assert.equal(rows.members.length, 4)
  assert.equal(rows.states[0].decisionVersion, 1)
  const log = db.log.map(([method, args]) => [method, (args && (args.table || args.level)) || null])
  assert.deepEqual(log[0], ['transaction', null])
  assert.deepEqual(log[1], ['trx.setTransactionIsolationLevel', 'repeatable read'], 'the pin is the transaction\'s FIRST statement')
  assert.deepEqual(log[log.length - 1], ['commit', null])
  const reads = log.slice(2, -1)
  assert.equal(reads.length, 18, 'continuations x2, members x2, holds x2, states x2, executions (2 newest + 8 unfinished)')
  assert.ok(reads.every(([method]) => method === 'trx.select'), `every read on the transaction handle, none in autocommit: ${JSON.stringify(reads)}`)
  // readFirst: once, on THE transaction handle, after BEGIN + the pin, before any step-4 read.
  assert.equal(seen.length, 1)
  assert.equal(seen[0].handle, db.lastTransactionHandle)
  assert.equal(seen[0].logLength, 2)
  // Without readFirst: the same pinned snapshot.
  db.log.length = 0
  await store.readGovernanceRows(scope)
  assert.deepEqual(db.log.slice(0, 2).map(([method]) => method), ['transaction', 'trx.setTransactionIsolationLevel'])
  assert.equal(db.statements('').filter(([method]) => method === 'select').length, 0, 'no autocommit read')
  // readFirst's refusal (the reader's typed 409) passes through UNCHANGED and the snapshot rolls back before any step-4 read.
  const refusal = Object.assign(new Error('retargeted'), { status: 409, code: 'STOCK_PREP_REFRESH_TARGET_RETARGETED', details: { reason: 'sheet' } })
  db.log.length = 0
  let caught = null
  try {
    await store.readGovernanceRows(scope, { readFirst: async () => { throw refusal } })
  } catch (error) {
    caught = error
  }
  assert.equal(caught, refusal, 'the same error object, untranslated')
  assert.deepEqual(db.log.map(([method]) => method), ['transaction', 'trx.setTransactionIsolationLevel', 'rollback'])
  // readFirst that is not a function: 500 before any statement.
  db.log.length = 0
  await expectError(store.readGovernanceRows(scope, { readFirst: 'registry' }), { status: 500, code: CODES.INPUT_INVALID })
  assert.equal(db.log.length, 0)
  // A transaction handle that cannot pin its isolation level: 501 before any read (never an unpinned consult).
  const unpinnable = { ...db, transaction: (callback) => db.transaction((handle) => callback({ ...handle, setTransactionIsolationLevel: undefined })) }
  const unpinnableStore = createStockPreparationContinuationStore({ db: unpinnable, now: w.clock.now })
  db.log.length = 0
  await expectError(unpinnableStore.readGovernanceRows(scope), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'snapshot_handle' })
  assert.deepEqual(db.log.map(([method]) => method), ['transaction', 'rollback'])
  // The pin itself fails (SQLSTATE 25001: a query already ran in the transaction): 503 read_snapshot, nothing read.
  db.log.length = 0
  db.faults.setTransactionIsolationLevel = kit.sqlError('25001', 'SET TRANSACTION ISOLATION LEVEL must be called before any query')
  const pinFailed = await expectError(store.readGovernanceRows(scope), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(pinFailed.details.operation, 'read_snapshot')
  assert.equal(pinFailed.details.sqlState, '25001')
  assert.deepEqual(db.log.map(([method]) => method), ['transaction', 'trx.setTransactionIsolationLevel', 'rollback'])
})

// ── ST-15 end admissibility (review X-2) ──────────────────────────────────────────────────────────

test('ST-15 end admissibility (review X-2, design §9.3 / §8.4): an ACTIVE continuation is never ended here; escalate needs an OPEN hold naming it; both refused before the bump and before any write; an admitted escalation keeps the project pending (never complete, never export-allowed)', async () => {
  const w = await world()
  const { hold, store, db, scope, bump } = w
  await seedHolds(w, [hold])
  const confirmed = await confirmHold(w, hold)
  const id = confirmed.continuationId
  const hooks = { bumpWithin: bump.bumpWithin }
  const endBase = { ...scope, continuationId: id, revision: 1, endedBy: PULLER }
  // (a) ACTIVE with an OPEN hold naming it: a content_changed verdict keeps the relationship active and raises a
  //     relationship_content_change hold. Only the status check stands between an escalation and ending an ACTIVE
  //     relationship here (the hold is present, so `no_open_hold` would not refuse it) — checked first.
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 1, holds: [kit.contentChangeHoldFor(id)], verdicts: { [id]: 'content_changed' }, computation: computation() })
  assert.equal(db.rows(T.continuation)[0].status, 'active')
  assert.ok(db.rows(T.hold).some((row) => row.continuation_id === id && row.status === 'open'), 'an open hold names the active relationship')
  {
    const before = tablesSnapshot(db)
    const bumpsBefore = bump.calls.length
    const refused = await expectError(store.endContinuation({ ...endBase, outcome: 'escalate_special_repair' }, hooks), { status: 409, code: CODES.END_OUTCOME_NOT_ADMISSIBLE, reason: 'status' })
    assert.equal(refused.details.status, 'active')
    assert.equal(bump.calls.length, bumpsBefore, 'no bump')
    assert.equal(tablesSnapshot(db), before, 'nothing persisted: the active relationship keeps its claims')
  }
  // (a') ACTIVE with no hold (the next computation verifies it valid and supersedes the content hold): refused for
  //      both outcomes the end transaction takes (supersede is confirm-only, ST-08), right after the continuation lock.
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 1, holds: [], verdicts: { [id]: 'valid' }, computation: computation({ suspended: false }) })
  assert.equal(db.rows(T.hold).filter((row) => row.status === 'open').length, 0)
  for (const extra of [{ outcome: 'escalate_special_repair' }, { outcome: 'release_to_normal_refresh', facts: { holdId: 'hold_named', holdFingerprint: 'f'.repeat(64) } }]) {
    const before = tablesSnapshot(db)
    const bumpsBefore = bump.calls.length
    db.log.length = 0
    const refused = await expectError(store.endContinuation({ ...endBase, ...extra }, hooks), { status: 409, code: CODES.END_OUTCOME_NOT_ADMISSIBLE, reason: 'status' })
    assert.equal(refused.details.status, 'active')
    assert.equal(refused.details.outcome, extra.outcome)
    assertValuesFree(refused)
    assert.deepEqual(statementsOf(db), ['trx.selectOneForUpdate:refresh_state', 'trx.selectOneForUpdate:continuation'], `${extra.outcome}: refused right after the continuation lock`)
    assert.equal(db.log[db.log.length - 1][0], 'rollback')
    assert.equal(bump.calls.length, bumpsBefore, `${extra.outcome}: no bump`)
    assert.equal(tablesSnapshot(db), before, `${extra.outcome}: nothing persisted`)
  }
  assert.equal(derivedState(w).status, 'confirmed_pending_execution', 'the active relationship still protects its subtree')
  // (b) needs_reconfirmation but NO open hold names it (a computation recorded the verdict without raising the
  //     hold): escalating would release the claims and leave nothing suspending the project -> refused.
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 1, holds: [], verdicts: { [id]: 'structure_changed' }, computation: computation({ suspended: false }) })
  assert.equal(db.rows(T.continuation)[0].status, 'needs_reconfirmation')
  {
    const before = tablesSnapshot(db)
    const bumpsBefore = bump.calls.length
    db.log.length = 0
    const refused = await expectError(store.endContinuation({ ...endBase, outcome: 'escalate_special_repair' }, hooks), { status: 409, code: CODES.END_OUTCOME_NOT_ADMISSIBLE, reason: 'no_open_hold' })
    assert.equal(refused.details.outcome, 'escalate_special_repair')
    assertValuesFree(refused)
    assert.deepEqual(statementsOf(db), ['trx.selectOneForUpdate:refresh_state', 'trx.selectOneForUpdate:continuation', 'trx.select:refresh_hold'])
    assert.equal(db.log[db.log.length - 1][0], 'rollback')
    assert.equal(bump.calls.length, bumpsBefore, 'no bump')
    assert.equal(tablesSnapshot(db), before, 'nothing persisted')
  }
  // (c) the next computation raises the relationship_reconfirm hold: the escalation is admitted. The admissibility
  //     reads all come BEFORE the bump, the writes after it.
  await store.reconcileHolds({ ...scope, decisionVersionObserved: 1, holds: [reconfirmHoldFor(id, { confirmable: false, verdict: 'structure_changed' })], verdicts: { [id]: 'structure_changed' }, computation: computation() })
  const bumpsBefore = bump.calls.length
  db.log.length = 0
  let statementsAtBump = null
  const escalated = await store.endContinuation({ ...endBase, outcome: 'escalate_special_repair' }, {
    bumpWithin: async (trx, scopeKey, options) => {
      statementsAtBump = statementsOf(db)
      return bump.bumpWithin(trx, scopeKey, options)
    },
  })
  assert.deepEqual(statementsAtBump, ['trx.selectOneForUpdate:refresh_state', 'trx.selectOneForUpdate:continuation', 'trx.select:refresh_hold'], 'the bump follows every admissibility read and precedes every write')
  assert.deepEqual(statementsOf(db), [
    'trx.selectOneForUpdate:refresh_state',
    'trx.selectOneForUpdate:continuation',
    'trx.select:refresh_hold',
    // PR-4 review N3: the unfinished executions re-read right after the bump, before any write.
    'trx.select:refresh_execution',
    'trx.select:refresh_execution',
    'trx.select:refresh_execution',
    'trx.select:refresh_execution',
    'trx.updateRow:continuation',
    'trx.updateRow:continuation_member',
    'trx.updateRow:refresh_hold',
    'trx.select:refresh_hold',
    'trx.updateRow:refresh_state',
  ])
  assert.equal(bump.calls.length, bumpsBefore + 1)
  assert.equal(escalated.holdsEscalated, 1)
  assert.equal(escalated.decisionVersion, 2)
  const kept = db.rows(T.hold).find((row) => row.continuation_id === id && row.status === 'open')
  assert.ok(kept, 'the hold naming the continuation stays OPEN')
  assert.equal(kept.runbook_only, true)
  assert.equal(kept.confirmable, false)
  // Nothing derives complete while it is open: pending_confirmation; a clean SETTLING computation neither
  // supersedes the runbook-only hold nor settles.
  let state = derivedState(w)
  assert.equal(state.status, 'pending_confirmation')
  assert.equal(state.exportAllowed, false)
  const clean = await store.reconcileHolds({ ...scope, decisionVersionObserved: 2, holds: [], computation: computation({ suspended: false, lane: 'small_apply' }), settlement: { executionId: null, generationToken: 'g_s', sourceContentDigest: 'src_1', sheetMachineDigest: 'm_1' } })
  assert.equal(clean.settled, false)
  assert.deepEqual(clean.holds, { opened: 0, kept: 0, superseded: 0, open: 1 })
  assert.equal(db.rows(T.state)[0].settled_at, null)
  state = derivedState(w)
  assert.equal(state.status, 'pending_confirmation')
  assert.equal(state.exportAllowed, false)
})

// ── ST-16 supersede admissibility (review X-3 + round 2) ─────────────────────────────────────────

test('ST-16 supersede admissibility (review X-3 + round 2, design §8.4): a candidate sharing no claim is 409 supersedes_unrelated (and commits alone — control); a PARTIAL takeover — the reviewer\'s real-planner shape, another old set at the same new positions, one shared child claim, every record but one re-keyed old key — is 409 supersedes_incomplete with the uncovered counts; all refused before the bump and any write; only a FULL takeover of the old side (every old record id and old key digest) supersedes', async () => {
  const w = await world()
  const { hold, store, db, bump } = w
  await seedHolds(w, [hold])
  const first = await confirmHold(w, hold)
  const supersedesFirst = { input: { supersedes: { continuationId: first.continuationId, revision: 1 } } }
  const refusedBeforeAnyWrite = async (candidate, expected, label) => {
    const before = tablesSnapshot(db)
    const bumpsBefore = bump.calls.length
    db.log.length = 0
    const refused = await expectError(confirmHold(w, candidate, supersedesFirst), { status: 409, code: CODES.END_OUTCOME_NOT_ADMISSIBLE, reason: expected.reason })
    assert.deepEqual(refused.details, { outcome: 'superseded_by_new_confirmation', ...expected }, label)
    assertValuesFree(refused)
    assert.deepEqual(statementsOf(db), ['trx.selectOneForUpdate:refresh_state', 'trx.selectOne:refresh_hold', 'trx.selectOneForUpdate:continuation', 'trx.select:continuation_member'], `${label}: decided on the named relationship's claims, before any write`)
    assert.equal(db.log[db.log.length - 1][0], 'rollback', label)
    assert.equal(bump.calls.length, bumpsBefore, `${label}: no bump`)
    assert.equal(tablesSnapshot(db), before, `${label}: nothing persisted — the relationship keeps every claim, the hold stays open`)
  }
  // (a) UNRELATED: shares no old record, no old key and no new position with the relationship it names.
  const disjoint = kit.disjointCandidateHold(hold)
  const baseOld = new Set(hold.detail.pairs.map((pair) => pair.oldRecordId))
  const baseOldKeys = new Set(hold.detail.pairs.map((pair) => pair.oldKey))
  const baseNewKeys = new Set(hold.detail.pairs.map((pair) => pair.newKey))
  assert.ok(disjoint.detail.pairs.every((pair) => !baseOld.has(pair.oldRecordId) && !baseOldKeys.has(pair.oldKey) && !baseNewKeys.has(pair.newKey)))
  // (b) PARTIAL takeovers: related, but at least one old record id or old key of the relationship left uncovered.
  const reviewerPartial = (await kit.partialTakeoverCandidate()).hold
  assert.equal(reviewerPartial.detail.pairs.length, 2, 'the reviewer\'s shape: two pairs')
  assert.ok(reviewerPartial.detail.pairs.every((pair) => baseNewKeys.has(pair.newKey) && !baseOld.has(pair.oldRecordId)), 'two of the old relationship\'s new positions, none of its old rows')
  const partials = [
    ['the reviewer\'s real-planner partial (2 of 4 new positions, 2 other rows)', reviewerPartial, { uncoveredOldRecords: 4, uncoveredOldKeys: 4 }],
    ['another old set at the same new positions', kit.sameNewPositionHold(hold), { uncoveredOldRecords: 4, uncoveredOldKeys: 4 }],
    ['one shared child old record', kit.memberCollisionHold(hold, 'old_record'), { uncoveredOldRecords: 3, uncoveredOldKeys: 4 }],
    ['one shared child old key', kit.memberCollisionHold(hold, 'old_key'), { uncoveredOldRecords: 4, uncoveredOldKeys: 3 }],
    ['one shared nested new position', kit.memberCollisionHold(hold, 'new_key'), { uncoveredOldRecords: 4, uncoveredOldKeys: 4 }],
    ['every old record, one old key re-keyed', kit.rekeyedTakeoverHold(hold), { uncoveredOldRecords: 0, uncoveredOldKeys: 1 }],
    ['every old key, one old record replaced', kit.rerecordedTakeoverHold(hold), { uncoveredOldRecords: 1, uncoveredOldKeys: 0 }],
  ]
  await seedHolds(w, [disjoint, ...partials.map(([, candidate]) => candidate)], { decisionVersionObserved: 1 })
  await refusedBeforeAnyWrite(disjoint, { reason: 'supersedes_unrelated' }, 'unrelated')
  for (const [label, candidate, counts] of partials) {
    await refusedBeforeAnyWrite(candidate, { reason: 'supersedes_incomplete', ...counts }, label)
    // Nor can it commit beside the relationship: it collides with a claim of it (A08).
    await expectError(confirmHold(w, candidate), { status: 409, code: CODES.CONFIRM_CONFLICT })
  }
  assert.equal(db.rows(T.continuation).find((row) => row.id === first.continuationId).claim_active, true, 'the relationship still claims every row')
  // Control: the unrelated candidate commits on its own — its refusal above was the relatedness rule alone.
  const alone = await confirmHold(w, disjoint)
  assert.equal(alone.supersededContinuationId, null)
  assert.equal(db.rows(T.continuation).filter((row) => row.claim_active).length, 2)
  // (c) FULL takeover: every old record id AND old key of the relationship (re-rooted under another parent). Without
  //     `supersedes` the claims collide; with it the old relationship ends and the new one claims every old row.
  const v = await world()
  await seedHolds(v, [v.hold])
  const base = await confirmHold(v, v.hold)
  const full = kit.competingCandidateHold(v.hold)
  await seedHolds(v, [full], { decisionVersionObserved: 1 })
  await expectError(confirmHold(v, full), { status: 409, code: CODES.CONFIRM_CONFLICT })
  const replaced = await confirmHold(v, full, { input: { supersedes: { continuationId: base.continuationId, revision: 1 } } })
  assert.equal(replaced.supersededContinuationId, base.continuationId)
  const old = v.db.rows(T.continuation).find((row) => row.id === base.continuationId)
  assert.equal(old.status, 'ended')
  assert.equal(old.ended_outcome, 'superseded_by_new_confirmation')
  const liveMembers = v.db.rows(T.member).filter((row) => row.claim_active)
  assert.equal(v.db.rows(T.continuation).filter((row) => row.claim_active).length, 1)
  assert.deepEqual(liveMembers.map((row) => row.old_record_id).sort(), v.hold.detail.pairs.map((pair) => pair.oldRecordId).sort(), 'every old row is still claimed — by the replacing relationship')
  assert.deepEqual(liveMembers.map((row) => row.old_key_digest).sort(), v.hold.detail.pairs.map((pair) => storeModule.keyDigest(pair.oldKey)).sort(), 'and still protected by its old key')
})

// ── ST-17 the reviewer's ANCESTOR counterexample (review round 2) ────────────────────────────────

test('ST-17 the reviewer\'s ANCESTOR counterexample (review round 2): over the FULL sheet and the current projection the REAL planner emits a five-member ancestor candidate — 0 of the relationship\'s old rows, 4 of its new positions; superseding with it is 409 supersedes_incomplete { uncoveredOldRecords: 4, uncoveredOldKeys: 4 }, deliberately NOT supersedes_unrelated (it shares the relationship\'s positions, so it is related, but takes over none of its rows); refused before the bump and any write; the next plan, pilot on and off, leaves the four old rows alone', async () => {
  const w = await world()
  const { store, db, bump, scope } = w
  const scenario = await kit.ancestorScenario()
  const F = scenario.fixtures
  const sheet = w.fixture.sheet
  const demandEvidence = scenario.expansion.demandEvidence
  // The relationship: the four first-pull rows paired with S-001 nested under Q-001 > P-001 (the real planner).
  const original = F.plan(scenario.expansion, sheet, { continuation: F.continuationInput({ demandEvidence }) }).holds.find((entry) => entry.kind === 'continuation_candidate')
  assert.ok(original, 'the real planner pairs the old subtree with its nested position')
  assert.equal(original.detail.pairs.length, 4)
  await seedHolds(w, [original])
  const first = await confirmHold(w, original)
  // The FULL current sheet (the four old rows + the five inserted independent rows) and the CURRENT projection.
  const rows = await store.readGovernanceRows(scope)
  const slice = plannerSlice({ ok: true, continuations: rows.continuations.map((entry) => ({ ...entry, memberCount: rows.members.filter((member) => member.continuationId === entry.id).length })), members: rows.members })
  const complete = sheet.concat(scenario.independentRows)
  const replacement = F.plan(scenario.expansion, complete, { continuation: F.continuationInput({ pilot: true, demandEvidence, ...slice }) })
  const candidate = replacement.holds.find((entry) => entry.kind === 'continuation_candidate')
  assert.ok(candidate, 'the real planner emits the ancestor candidate over the full sheet and current projection')
  assert.equal(candidate.detail.pairs.length, 5)
  const oldRecordIds = new Set(original.detail.pairs.map((pair) => pair.oldRecordId))
  const oldNewKeys = new Set(original.detail.pairs.map((pair) => pair.newKey))
  assert.equal(candidate.detail.pairs.filter((pair) => oldRecordIds.has(pair.oldRecordId)).length, 0, '0 old-row overlap')
  assert.equal(candidate.detail.pairs.filter((pair) => oldNewKeys.has(pair.newKey)).length, 4, '4 new-position overlap')
  // The reason is DELIBERATE: related (it shares the relationship's new positions) but not a takeover (none of its rows).
  const header = db.rows(T.continuation).find((row) => row.id === first.continuationId)
  const members = db.rows(T.member).filter((row) => row.continuation_id === first.continuationId)
  const candidateMembers = candidate.detail.pairs.map((pair) => ({ oldRecordId: pair.oldRecordId, oldKey: pair.oldKey, newKey: pair.newKey }))
  assert.equal(storeModule.__internals.claimsOverlap(header, members, candidateMembers), true, 'related: it shares the relationship\'s new positions')
  assert.deepEqual(storeModule.__internals.takeoverGaps(header, members, candidateMembers), { uncoveredOldRecords: 4, uncoveredOldKeys: 4 }, 'but takes over none of its rows')
  await seedHolds(w, [candidate], { decisionVersionObserved: 1 })
  const before = tablesSnapshot(db)
  const bumpsBefore = bump.calls.length
  db.log.length = 0
  const refused = await expectError(confirmHold(w, candidate, { input: { supersedes: { continuationId: first.continuationId, revision: 1 } } }), { status: 409, code: CODES.END_OUTCOME_NOT_ADMISSIBLE, reason: 'supersedes_incomplete' })
  assert.deepEqual(refused.details, { reason: 'supersedes_incomplete', outcome: 'superseded_by_new_confirmation', uncoveredOldRecords: 4, uncoveredOldKeys: 4 })
  assertValuesFree(refused)
  assert.deepEqual(statementsOf(db), ['trx.selectOneForUpdate:refresh_state', 'trx.selectOne:refresh_hold', 'trx.selectOneForUpdate:continuation', 'trx.select:continuation_member'])
  assert.equal(db.log[db.log.length - 1][0], 'rollback')
  assert.equal(bump.calls.length, bumpsBefore, 'no bump')
  assert.equal(tablesSnapshot(db), before, 'nothing persisted: the relationship keeps all four claims')
  // The relationship still protects its rows: the next plan over the full sheet, pilot ON and OFF, writes none of them.
  const oldKeys = new Set(sheet.map((row) => row.idempotencyKey))
  for (const pilot of [true, false]) {
    const next = F.plan(scenario.expansion, complete, { continuation: F.continuationInput({ pilot, demandEvidence, ...slice }) })
    const touched = next.decisions.filter((decision) => oldKeys.has(decision.idempotencyKey) && ['add', 'update', 'inactive'].includes(decision.decision))
    assert.deepEqual(touched.map((decision) => decision.decision), [], `pilot ${pilot}: no write to the four old rows`)
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-continuation-store.test.cjs', tests)
