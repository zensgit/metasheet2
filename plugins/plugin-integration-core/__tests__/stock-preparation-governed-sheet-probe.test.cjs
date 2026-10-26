'use strict'

// Batch-refresh step 4, PR-6 — THE GOVERNED-SHEET PROBE (lib/stock-preparation-governed-sheet-probe.cjs) and the
// continuation store's sheet-keyed read it stands on (`readSheetGovernanceMarks`), over the REAL continuation store
// and PR B's REAL registry store on the refresh-store kit's faithful fake db (one plugin database, as index.cjs wires
// them). No stub reader: every verdict below comes from rows the real stores wrote or read.
//
//   P-01 nothing on the sheet: not governed, registry absent; `assertSheetWritable` returns; the reads are ONE
//        registry selectOne by sheet + FOUR counts, all autocommit (no transaction), nothing written.
//   P-02 the registry: a pilot-stamped row on the sheet governs (`pilot`); the same row without the stamp does not
//        (registered is not governed, GV-1); a row on another sheet does not.
//   P-03 one table at a time, through the real store flows: an open hold (`hold`), a RESOLVED hold only (NOT
//        governed), a state row (`state`), an active continuation (`continuation`), an ENDED continuation only
//        (still `continuation`, D3), a running execution and a succeeded one (`execution`); rows on another sheet
//        never govern this one; the verdict order pilot -> continuation -> hold -> state -> execution.
//   P-04 a step-4 count fails (42P01 on each of the four tables in turn): 503 STORE_FAILED { store: continuation,
//        operation, sqlState, partial: false } — never `governed: false`; a malformed count is 503 too.
//   P-05 the registry read fails: 503 { store: registry, operation: pilot_state_by_sheet }, and no step-4 table was
//        read (statement log).
//   P-06 not wired: no continuation store / a store without the sheet read / a registry without the by-sheet pilot
//        read: 501 STORE_UNAVAILABLE by name; the store's own 501 when its binding cannot count.
//   P-07 a blank / non-string sheet id: 422 INPUT_INVALID before any read (probe and store).
//   P-08 the tenant: a registry row of tenant A probed by tenant B — not governed => answered, `tenantMatches: false`,
//        no refusal; governed => 409 with `details.tenantMismatch: true`; no tenant given => `tenantMatches: null`.
//   P-09 the refusal: 409 METASHEET_MULTITABLE_STOCK_PREP_GOVERNED_SHEET with status / code / surface / reason /
//        object / partial:false; the message names the code and the object key; neither the message nor the details
//        carry the sheet id, the project number, the tenant or a hold value (byte scan for planted sentinels); an
//        unknown surface is a 500 programming error.
//   P-10 a thrown read is not remembered: fault, then clear => the next probe answers from the store.
//   P-11 the seam helpers: `assertProbeWiredFor` (no probe + namespace object => 501 PROBE_UNWIRED for
//        `plm_stock_preparation_main`, a per-project `_p_` sheet and an MVP satellite; no probe + any other object =>
//        false; a malformed probe => 501 probe_surface) and `refuseIfGoverned`.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const refreshKit = require(path.join(__dirname, 'support', 'stock-preparation-refresh-store-kit.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const registryModule = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const probeModule = require(path.join(LIB, 'stock-preparation-governed-sheet-probe.cjs'))
const ownBase = require(path.join(LIB, 'stock-preparation-own-base.cjs'))

const { REFRESH_STORE_TABLES: T } = storeModule
const {
  GOVERNED_SHEET_WRITE_CODES: CODES,
  GOVERNED_SHEET_WRITE_SURFACES,
  GOVERNED_SHEET_REASONS,
  StockPreparationGovernedSheetWriteError,
  createStockPreparationGovernedSheetProbe,
  assertProbeWiredFor,
  refuseIfGoverned,
} = probeModule

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_gsp_sentinel_a'
const OTHER_TENANT = 'tenant_gsp_sentinel_b'
const SHEET = 'sheet_gsp_sentinel_a'
const OTHER_SHEET = 'sheet_gsp_sentinel_b'
const PULLER = 'u_gsp_puller'
const RT = refreshKit.REGISTRY_TABLE

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

async function world() {
  const fixture = await refreshKit.candidateHoldFixture()
  const clock = refreshKit.createClock()
  const db = refreshKit.createFakeRefreshDb({ clock })
  let n = 0
  const continuationStore = storeModule.createStockPreparationContinuationStore({ db, now: clock.now, idGenerator: (kind) => `${kind}_${String((n += 1)).padStart(4, '0')}` })
  const projectTargetStore = registryModule.createStockPreparationProjectTargetStore({ db })
  const probe = createStockPreparationGovernedSheetProbe({ continuationStore, projectTargetStore })
  const scope = { tenantId: TENANT, projectNo: fixture.projectNo, sheetId: SHEET }
  const bump = refreshKit.createFakeBumpWithin()
  return { fixture, hold: fixture.hold, clock, db, continuationStore, projectTargetStore, probe, scope, bump }
}

function computation(overrides = {}) {
  return { lane: 'small_preview', suspended: true, generationToken: 'g_gsp', sourceContentDigest: 'src_gsp', ...overrides }
}

async function openHold(w, scope = w.scope) {
  await w.continuationStore.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [w.hold], computation: computation() })
}

async function confirm(w, scope = w.scope) {
  await openHold(w, scope)
  const holdRow = w.db.rows(T.hold).find((row) => row.status === 'open' && row.sheet_id === scope.sheetId)
  return w.continuationStore.confirmContinuation({
    ...scope, holdId: holdRow.id, echo: refreshKit.echoOf(w.hold), basis: { kind: 'puller_confirmed_same_demand' }, confirmedBy: PULLER, sourceIdentity: w.fixture.sourceIdentity,
  }, { bumpWithin: w.bump.bumpWithin })
}

async function beginExecution(w, scope = w.scope) {
  return w.continuationStore.beginExecution({
    ...scope,
    lane: 'small_apply',
    guard: { leaseRunId: 'run_gsp', leaseId: 'lease_gsp', fencingEpoch: 1, generation: 4, generationToken: 'tok_gsp' },
    tokenRevision: 'rev_gsp',
    planDigest: 'digest_gsp',
    plannedCounts: { add: 1 },
    refreshBinding: { continuations: [] },
    startedBy: PULLER,
  })
}

async function deleteOn(w, table, sheetId = SHEET) {
  await w.db.deleteRows(table, { sheet_id: sheetId })
}

async function registerOn(w, { tenantId = TENANT, sheetId = SHEET, pilot = false } = {}) {
  await w.db.insertOne(RT, refreshKit.registryRow({ tenantId, projectNo: w.scope.projectNo, sheetId, objectId: `obj_${sheetId}`, pilot }))
}

const countStatements = (db) => db.log.filter(([method]) => method === 'countRows')
const stepFourCounts = (db) => countStatements(db).filter(([, args]) => args && Object.values(T).includes(args.table))

// ── P-01 / P-02 ──────────────────────────────────────────────────────────────────────────────────

test('P-01 nothing on the sheet: not governed, registry absent; assertSheetWritable returns; ONE registry selectOne by sheet + FOUR autocommit counts, nothing written', async () => {
  const w = await world()
  w.db.log.length = 0
  const answer = await w.probe.probe({ sheetId: SHEET, tenantId: TENANT })
  assert.deepEqual(JSON.parse(JSON.stringify(answer)), {
    ok: true, governed: false, reason: null, registry: { present: false }, marks: { continuation: 0, openHold: 0, state: 0, execution: 0 },
  })
  assert.ok(Object.isFrozen(answer) && Object.isFrozen(answer.marks) && Object.isFrozen(answer.registry))
  const methods = w.db.log.map(([method, args]) => `${method}:${args && args.table}`)
  assert.deepEqual(methods, [
    `selectOne:${RT}`,
    `countRows:${T.continuation}`,
    `countRows:${T.hold}`,
    `countRows:${T.state}`,
    `countRows:${T.execution}`,
  ], 'registry first, then the four step-4 counts, every one autocommit')
  assert.deepEqual(w.db.log[0][1].where, { sheet_id: SHEET }, 'the registry is read BY SHEET (no project number is available to a generic writer)')
  assert.deepEqual(w.db.log[2][1].where, { sheet_id: SHEET, status: 'open' }, 'holds: open only')
  for (const [, args] of stepFourCounts(w.db)) assert.equal(args.where.sheet_id, SHEET)
  const ok = await w.probe.assertSheetWritable({ sheetId: SHEET, tenantId: TENANT, surface: 'pipeline_upsert', objectId: 'main' })
  assert.equal(ok.governed, false)
  assert.equal(w.db.log.some(([method]) => /insert|update|upsert|delete|transaction/i.test(method)), false, 'the probe never writes and never opens a transaction')
})

test('P-02 the registry: a pilot-stamped row on THIS sheet governs (`pilot`); the same row without the stamp does not (GV-1); a pilot row on ANOTHER sheet does not', async () => {
  const unstamped = await world()
  await registerOn(unstamped, { pilot: false })
  const plain = await unstamped.probe.probe({ sheetId: SHEET, tenantId: TENANT })
  assert.equal(plain.governed, false)
  assert.deepEqual(JSON.parse(JSON.stringify(plain.registry)), { present: true, pilot: false, tenantMatches: true })

  const stamped = await world()
  await registerOn(stamped, { pilot: true })
  const pilot = await stamped.probe.probe({ sheetId: SHEET, tenantId: TENANT })
  assert.equal(pilot.governed, true)
  assert.equal(pilot.reason, 'pilot')
  assert.deepEqual(JSON.parse(JSON.stringify(pilot.registry)), { present: true, pilot: true, tenantMatches: true })
  assert.deepEqual(JSON.parse(JSON.stringify(pilot.marks)), { continuation: 0, openHold: 0, state: 0, execution: 0 }, 'the stamp alone governs')

  const elsewhere = await world()
  await registerOn(elsewhere, { sheetId: OTHER_SHEET, pilot: true })
  const mine = await elsewhere.probe.probe({ sheetId: SHEET, tenantId: TENANT })
  assert.equal(mine.governed, false)
  assert.equal(mine.registry.present, false)
  assert.equal((await elsewhere.probe.probe({ sheetId: OTHER_SHEET, tenantId: TENANT })).reason, 'pilot')
})

// ── P-03 ─────────────────────────────────────────────────────────────────────────────────────────

test('P-03 one table at a time, through the real store flows: open hold / resolved hold only (NOT governed) / state / active and ENDED continuation / running and succeeded execution; another sheet never governs this one; the verdict order', async () => {
  // An open hold alone (the reconciliation also writes the state row; removed to isolate the hold).
  const hold = await world()
  await openHold(hold)
  await deleteOn(hold, T.state)
  let answer = await hold.probe.probe({ sheetId: SHEET })
  assert.deepEqual([answer.governed, answer.reason, answer.marks.openHold, answer.marks.state], [true, 'hold', 1, 0])
  assert.equal(answer.registry.present, false)

  // The same hold RESOLVED: a resolved hold does not govern.
  const holdRow = hold.db.rows(T.hold)[0]
  await hold.db.updateRow(T.hold, { status: 'resolved', resolution: 'superseded_by_computation', resolved_at: hold.clock.now() }, { id: holdRow.id })
  answer = await hold.probe.probe({ sheetId: SHEET })
  assert.deepEqual([answer.governed, answer.reason], [false, null], 'resolved hold only => not governed')
  assert.equal(hold.db.rows(T.hold).length, 1, 'the row is still there — only its status changed')

  // A state row alone (a clean reconciliation with no hold still records the state row).
  const state = await world()
  await state.continuationStore.reconcileHolds({ ...state.scope, decisionVersionObserved: 0, holds: [], computation: computation({ suspended: false }) })
  assert.equal(state.db.rows(T.hold).length, 0)
  answer = await state.probe.probe({ sheetId: SHEET })
  assert.deepEqual([answer.governed, answer.reason, answer.marks.state], [true, 'state', 1])

  // An active continuation (state removed; its hold is resolved by the confirm).
  const active = await world()
  await confirm(active)
  await deleteOn(active, T.state)
  assert.ok(active.db.rows(T.hold).every((row) => row.status !== 'open'), 'the confirm resolved the hold')
  answer = await active.probe.probe({ sheetId: SHEET })
  assert.deepEqual([answer.governed, answer.reason, answer.marks.continuation, answer.marks.openHold], [true, 'continuation', 1, 0])

  // The relationship ENDED (every claim released): an ended row still governs (D3 — the consult's `anyRows`).
  const header = active.db.rows(T.continuation)[0]
  await active.db.updateRow(T.member, { claim_active: false }, { continuation_id: header.id })
  await active.db.updateRow(T.continuation, { status: 'ended', claim_active: false, ended_at: active.clock.now(), ended_outcome: 'release_to_normal_refresh', ended_by: PULLER, status_reason: 'source_scope_changed' }, { id: header.id })
  assert.equal(active.db.rows(T.continuation)[0].status, 'ended')
  answer = await active.probe.probe({ sheetId: SHEET })
  assert.deepEqual([answer.governed, answer.reason], [true, 'continuation'], 'an ENDED continuation still governs')

  // An execution row: running, then succeeded.
  const exec = await world()
  const execution = await beginExecution(exec)
  answer = await exec.probe.probe({ sheetId: SHEET })
  assert.deepEqual([answer.governed, answer.reason, answer.marks.execution], [true, 'execution', 1])
  await exec.db.updateRow(T.execution, { status: 'succeeded', finished_at: exec.clock.now() }, { id: execution.id })
  answer = await exec.probe.probe({ sheetId: SHEET })
  assert.deepEqual([answer.governed, answer.reason], [true, 'execution'], 'a finished execution still governs')

  // Rows on ANOTHER sheet never govern this one.
  const other = await world()
  const otherScope = { ...other.scope, sheetId: OTHER_SHEET }
  await confirm(other, otherScope)
  await beginExecution(other, otherScope)
  answer = await other.probe.probe({ sheetId: SHEET })
  assert.deepEqual([answer.governed, JSON.parse(JSON.stringify(answer.marks))], [false, { continuation: 0, openHold: 0, state: 0, execution: 0 }])
  assert.equal((await other.probe.probe({ sheetId: OTHER_SHEET })).reason, 'continuation')

  // The verdict order: pilot -> continuation -> hold -> state -> execution.
  const all = await world()
  await confirm(all)
  await all.continuationStore.reconcileHolds({ ...all.scope, decisionVersionObserved: all.db.rows(T.state)[0].decision_version, holds: [refreshKit.contentChangeHoldFor(all.db.rows(T.continuation)[0].id)], computation: computation() })
  await beginExecution(all)
  answer = await all.probe.probe({ sheetId: SHEET })
  assert.deepEqual(JSON.parse(JSON.stringify(answer.marks)), { continuation: 1, openHold: 1, state: 1, execution: 1 })
  assert.equal(answer.reason, 'continuation')
  await registerOn(all, { pilot: true })
  assert.equal((await all.probe.probe({ sheetId: SHEET })).reason, 'pilot')
  const { verdictOf } = probeModule.__internals
  assert.equal(verdictOf(null, { continuation: 0, openHold: 1, state: 1, execution: 1 }), 'hold')
  assert.equal(verdictOf(null, { continuation: 0, openHold: 0, state: 1, execution: 1 }), 'state')
  assert.equal(verdictOf({ pilot: false }, { continuation: 0, openHold: 0, state: 0, execution: 1 }), 'execution')
  assert.equal(verdictOf({ pilot: false }, { continuation: 0, openHold: 0, state: 0, execution: 0 }), null)
  assert.deepEqual(GOVERNED_SHEET_REASONS, ['pilot', 'continuation', 'hold', 'state', 'execution'])
})

// ── P-04 / P-05 / P-06 / P-07 ────────────────────────────────────────────────────────────────────

test('P-04 a step-4 count fails (42P01 on each table in turn) => 503 STORE_FAILED { store: continuation, operation, sqlState, partial:false } — never governed:false; a malformed count => 503', async () => {
  for (const table of [T.continuation, T.hold, T.state, T.execution]) {
    const w = await world()
    w.db.faults.countRows = (args) => (args.table === table ? refreshKit.sqlError('42P01', `relation "${table}" does not exist`) : null)
    const error = await expectError(w.probe.probe({ sheetId: SHEET, tenantId: TENANT }), { status: 503, code: CODES.STORE_FAILED })
    assert.ok(error instanceof StockPreparationGovernedSheetWriteError)
    assert.deepEqual(error.details, { store: 'continuation', operation: 'read_sheet_governance_marks', sqlState: '42P01', partial: false }, table)
    // Step-4 review follow-ups (item 6, #6567 N1): the message itself names the code, the store, the operation and
    // the SQLSTATE (the pipeline runner keeps only the message), never the driver's own text.
    assert.ok(error.message.startsWith(`${CODES.STORE_FAILED} (store continuation, operation read_sheet_governance_marks, SQLSTATE 42P01): `), error.message)
    assert.equal(error.message.includes(table), false, `${table}: the driver message never reaches the refusal`)
    await expectError(w.probe.assertSheetWritable({ sheetId: SHEET, tenantId: TENANT, surface: 'pipeline_upsert', objectId: 'main' }), { status: 503, code: CODES.STORE_FAILED })
  }
  // The store's own answer for a binding that returns garbage: 503, not zero.
  const w = await world()
  const garbage = storeModule.createStockPreparationContinuationStore({ db: { ...w.db, countRows: async () => 'many' } })
  const storeError = await expectError(garbage.readSheetGovernanceMarks({ sheetId: SHEET }), { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
  assert.equal(storeError.details.reason, 'count_malformed')
  // A store that answers without four integer counts: unreadable by name.
  const lying = createStockPreparationGovernedSheetProbe({ continuationStore: { readSheetGovernanceMarks: async () => ({ ok: true, continuation: 0, openHold: 0, state: 0 }) }, projectTargetStore: w.projectTargetStore })
  const lie = await expectError(lying.probe({ sheetId: SHEET }), { status: 503, code: CODES.STORE_FAILED })
  assert.deepEqual(lie.details, { store: 'continuation', operation: 'read_sheet_governance_marks', partial: false })
  assert.ok(lie.message.startsWith(`${CODES.STORE_FAILED} (store continuation, operation read_sheet_governance_marks): `), `no SQLSTATE => none named: ${lie.message}`)
  const notOk = createStockPreparationGovernedSheetProbe({ continuationStore: { readSheetGovernanceMarks: async () => ({ ok: false }) }, projectTargetStore: w.projectTargetStore })
  await expectError(notOk.probe({ sheetId: SHEET }), { status: 503, code: CODES.STORE_FAILED })
})

test('P-05 the registry read fails => 503 { store: registry, operation: pilot_state_by_sheet, sqlState }, and NO step-4 table is read', async () => {
  const w = await world()
  await openHold(w)
  w.db.log.length = 0
  w.db.faults.selectOne = refreshKit.sqlError('42703', 'column "pilot_enabled_at" does not exist')
  const error = await expectError(w.probe.probe({ sheetId: SHEET, tenantId: TENANT }), { status: 503, code: CODES.STORE_FAILED })
  assert.deepEqual(error.details, { store: 'registry', operation: 'pilot_state_by_sheet', sqlState: '42703', partial: false })
  assert.ok(error.message.startsWith(`${CODES.STORE_FAILED} (store registry, operation pilot_state_by_sheet, SQLSTATE 42703): `), error.message)
  assert.equal(error.message.includes('pilot_enabled_at'), false, 'the driver message never reaches the refusal')
  assert.equal(stepFourCounts(w.db).length, 0, 'refused before any step-4 count')
  // A registry answer that is not a row is unreadable too.
  const odd = createStockPreparationGovernedSheetProbe({ continuationStore: w.continuationStore, projectTargetStore: { getPilotStateBySheetId: async () => 'pilot' } })
  const oddError = await expectError(odd.probe({ sheetId: SHEET }), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(oddError.details.store, 'registry')
})

test('P-06 not wired => 501 STORE_UNAVAILABLE by name (never "not governed"); the store answers 501 when its binding cannot count', async () => {
  const w = await world()
  const none = createStockPreparationGovernedSheetProbe({})
  const unwired = await expectError(none.probe({ sheetId: SHEET }), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'continuation_store' })
  // Step-4 review follow-ups (item 6): the 501 message names its code and reason too.
  assert.ok(unwired.message.startsWith(`${CODES.STORE_UNAVAILABLE} (reason continuation_store): `), unwired.message)
  const oldStore = createStockPreparationGovernedSheetProbe({ continuationStore: { readGovernanceRows: async () => ({}) }, projectTargetStore: w.projectTargetStore })
  await expectError(oldStore.probe({ sheetId: SHEET }), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'continuation_store' })
  const legacyRegistry = createStockPreparationGovernedSheetProbe({ continuationStore: w.continuationStore, projectTargetStore: { get: async () => null, getPilotState: async () => null } })
  await expectError(legacyRegistry.probe({ sheetId: SHEET }), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'registry_pilot_reads' })
  await expectError(legacyRegistry.assertSheetWritable({ sheetId: SHEET, surface: 'erp_feedback', objectId: 'x' }), { status: 501, code: CODES.STORE_UNAVAILABLE })
  const countless = { ...w.db }
  delete countless.countRows
  const store = storeModule.createStockPreparationContinuationStore({ db: countless })
  await expectError(store.readSheetGovernanceMarks({ sheetId: SHEET }), { status: 501, code: 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE', reason: 'count_rows' })
  // Met through a wired probe: still the 501 wiring defect by name (never 503, never not-governed).
  const viaProbe = createStockPreparationGovernedSheetProbe({ continuationStore: store, projectTargetStore: w.projectTargetStore })
  await expectError(viaProbe.probe({ sheetId: SHEET }), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'count_rows' })
})

test('P-07 a blank / non-string sheet id => 422 INPUT_INVALID before any read (probe and store)', async () => {
  const w = await world()
  w.db.log.length = 0
  for (const bad of [{}, { sheetId: '' }, { sheetId: '   ' }, { sheetId: 42 }, null, 'sheet']) {
    await expectError(w.probe.probe(bad), { status: 422, code: CODES.INPUT_INVALID })
    await expectError(w.continuationStore.readSheetGovernanceMarks(bad), { status: 422, code: 'STOCK_PREP_REFRESH_INPUT_INVALID' })
  }
  assert.equal(w.db.log.length, 0, 'no statement ran')
  // A trimmed sheet id is the sheet.
  assert.equal((await w.continuationStore.readSheetGovernanceMarks({ sheetId: `  ${SHEET}  ` })).sheetId, SHEET)
})

// ── P-08 / P-09 / P-10 ───────────────────────────────────────────────────────────────────────────

test('P-08 the tenant: registry of tenant A probed by tenant B — not governed => answered with tenantMatches:false, NO refusal; governed => 409 with details.tenantMismatch:true; no tenant => tenantMatches:null', async () => {
  const w = await world()
  await registerOn(w, { tenantId: TENANT, pilot: false })
  const foreign = await w.probe.probe({ sheetId: SHEET, tenantId: OTHER_TENANT })
  assert.equal(foreign.governed, false)
  assert.equal(foreign.registry.tenantMatches, false)
  await w.probe.assertSheetWritable({ sheetId: SHEET, tenantId: OTHER_TENANT, surface: 'pipeline_upsert', objectId: 'main' })
  assert.equal((await w.probe.probe({ sheetId: SHEET })).registry.tenantMatches, null)
  assert.equal((await w.probe.probe({ sheetId: SHEET, tenantId: TENANT })).registry.tenantMatches, true)
  await openHold(w)
  const refused = await expectError(w.probe.assertSheetWritable({ sheetId: SHEET, tenantId: OTHER_TENANT, surface: 'pipeline_upsert', objectId: 'main' }), { status: 409, code: CODES.REFUSED })
  assert.equal(refused.details.tenantMismatch, true)
  assert.equal(refused.details.reason, 'hold')
  const same = await expectError(w.probe.assertSheetWritable({ sheetId: SHEET, tenantId: TENANT, surface: 'pipeline_upsert', objectId: 'main' }), { status: 409, code: CODES.REFUSED })
  assert.equal(Object.prototype.hasOwnProperty.call(same.details, 'tenantMismatch'), false)
})

test('P-09 the refusal: 409 with code / status / surface / reason / object / partial:false; the message names the code and the object key; no sheet id, project number, tenant or hold value anywhere in it; an unknown surface is a 500', async () => {
  const w = await world()
  await registerOn(w, { pilot: true })
  // A hold whose private detail carries a planted value: it must never surface.
  const planted = { ...w.hold, detail: { ...w.hold.detail, plantedValue: 'SENTINEL_HOLD_VALUE_9137' } }
  await w.continuationStore.reconcileHolds({ ...w.scope, decisionVersionObserved: 0, holds: [planted], computation: computation() })
  for (const surface of GOVERNED_SHEET_WRITE_SURFACES) {
    const error = await expectError(w.probe.assertSheetWritable({ sheetId: SHEET, tenantId: TENANT, surface, objectId: 'main' }), { status: 409, code: CODES.REFUSED })
    assert.ok(error instanceof StockPreparationGovernedSheetWriteError)
    assert.equal(error.name, 'StockPreparationGovernedSheetWriteError')
    assert.deepEqual(error.details, { surface, reason: 'pilot', object: 'main', partial: false })
    assert.ok(error.message.startsWith(`${CODES.REFUSED}: object "main"`), error.message)
    const serialized = JSON.stringify({ message: error.message, details: error.details, code: error.code })
    for (const secret of [SHEET, w.scope.projectNo, TENANT, 'SENTINEL_HOLD_VALUE_9137', 'sentinel']) {
      assert.equal(serialized.toLowerCase().includes(secret.toLowerCase()), false, `${secret} leaked: ${serialized}`)
    }
  }
  const noObject = await expectError(w.probe.assertSheetWritable({ sheetId: SHEET, surface: 'erp_feedback' }), { status: 409, code: CODES.REFUSED })
  assert.equal(Object.prototype.hasOwnProperty.call(noObject.details, 'object'), false)
  await expectError(w.probe.assertSheetWritable({ sheetId: SHEET, surface: 'made_up' }), { status: 500, code: CODES.INPUT_INVALID })
  await expectError(w.probe.assertSheetWritable({ sheetId: SHEET }), { status: 500, code: CODES.INPUT_INVALID })
  assert.deepEqual(GOVERNED_SHEET_WRITE_SURFACES, ['pipeline_upsert', 'c6_target_test', 'c6_insert_rows', 'c6_update_rows', 'erp_feedback'])
  assert.equal(CODES.REFUSED, 'METASHEET_MULTITABLE_STOCK_PREP_GOVERNED_SHEET', 'design §14')
})

test('P-10 a thrown read is not remembered: fault, then clear => the next probe answers from the store', async () => {
  const w = await world()
  await openHold(w)
  w.db.faults.countRows = refreshKit.sqlError('08006', 'connection failure')
  await expectError(w.probe.probe({ sheetId: SHEET }), { status: 503, code: CODES.STORE_FAILED })
  const after = await w.probe.probe({ sheetId: SHEET })
  assert.deepEqual([after.governed, after.reason], [true, 'hold'])
  w.db.faults.selectOne = refreshKit.sqlError('08006', 'connection failure')
  await expectError(w.probe.probe({ sheetId: SHEET }), { status: 503, code: CODES.STORE_FAILED })
  assert.equal((await w.probe.probe({ sheetId: SHEET })).reason, 'hold')
})

// ── P-11 ─────────────────────────────────────────────────────────────────────────────────────────

test('P-11 the seam helpers: the not-wired rule over the stock-prep namespace; a malformed probe is 501 probe_surface; refuseIfGoverned', async () => {
  const projectSheet = ownBase.deriveStockPreparationProjectSheetObjectId('tenant_gsp', 'PRJ-GSP')
  assert.ok(ownBase.isStockPreparationProjectSheetObjectId(projectSheet))
  for (const objectId of ['plm_stock_preparation_main', projectSheet, 'plm_stock_preparation_sandbox_hand_named', 'plm_stock_preparation_line', 'plm_stock_preparation_project_overview']) {
    assert.equal(ownBase.isStockPreparationNamespaceObjectId(objectId), true, objectId)
    const error = await expectError((async () => assertProbeWiredFor({ governedSheetProbe: null, surface: 'pipeline_upsert', objectId }))(), { status: 501, code: CODES.PROBE_UNWIRED, reason: 'probe_absent' })
    assert.deepEqual(error.details, { surface: 'pipeline_upsert', reason: 'probe_absent', object: objectId, partial: false })
    assert.ok(error.message.startsWith(`${CODES.PROBE_UNWIRED}: object "${objectId}"`))
  }
  for (const objectId of ['main', 'approved_materials', 'standard_materials', 'stock_preparation_main', 'PLM_STOCK_PREPARATION_MAIN', '', undefined, 7]) {
    assert.equal(ownBase.isStockPreparationNamespaceObjectId(objectId), false, String(objectId))
    assert.equal(assertProbeWiredFor({ governedSheetProbe: undefined, surface: 'erp_feedback', objectId }), false)
  }
  const w = await world()
  assert.equal(assertProbeWiredFor({ governedSheetProbe: w.probe, surface: 'c6_target_test', objectId: 'plm_stock_preparation_main' }), true)
  await expectError((async () => assertProbeWiredFor({ governedSheetProbe: { probe: async () => ({}) }, surface: 'c6_target_test', objectId: 'main' }))(), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'probe_surface' })
  await expectError((async () => assertProbeWiredFor({ governedSheetProbe: {}, surface: 'c6_target_test', objectId: 'plm_stock_preparation_main' }))(), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'probe_surface' })
  await expectError((async () => assertProbeWiredFor({ governedSheetProbe: null, surface: 'nope', objectId: 'main' }))(), { status: 500, code: CODES.INPUT_INVALID })
  // refuseIfGoverned: a not-governed answer passes, a governed one is the 409 (tenant mismatch carried).
  refuseIfGoverned({ answer: { governed: false }, surface: 'c6_insert_rows', objectId: 'main' })
  const thrown = await expectError((async () => refuseIfGoverned({ answer: { governed: true, reason: 'state', registry: { present: true, pilot: false, tenantMatches: false } }, surface: 'c6_update_rows', objectId: 'main' }))(), { status: 409, code: CODES.REFUSED })
  assert.deepEqual(thrown.details, { surface: 'c6_update_rows', reason: 'state', object: 'main', tenantMismatch: true, partial: false })
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-governed-sheet-probe.test.cjs', tests)
