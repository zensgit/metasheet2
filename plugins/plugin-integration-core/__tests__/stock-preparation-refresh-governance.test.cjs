'use strict'

// Batch-refresh step 4, PR-2 — the GOVERNANCE READER (lib/stock-preparation-refresh-governance.cjs): the one
// consult every lane will make (design §5.1), over the REAL continuation store on the faithful fake db, the REAL
// lock module on its fake db, and a fake of PR B's registry pilot reads.
//
//   GR-01 not wired (no store / a registry without PR B's pilot reads / no lock): 501 at CONSULT time, by name;
//         constructing with nothing does not throw (a build without PR B activates).
//   GR-02 scope validation: 422 before any read.
//   GR-03 not governed: every store answered, zero rows, no marker -> governed:false, the derived state not_governed.
//         ONE SNAPSHOT (review X-1): the statement order is BEGIN, SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,
//         the registry reads handed THAT transaction handle, every step-4 read on it (no autocommit read), COMMIT;
//         the lock after, on its own handle.
//   GR-04 pilot: the marker alone governs; a non-pilot registry row does not; a failed registry read is 503
//         (unreadable), never "not pilot".
//   GR-05 the tenant assertion (A-M6): a row of another tenant on this sheet — through the store or the registry
//         — is 409 TENANT_MISMATCH; a header-steered tenant that owns no rows is REFUSED, never "not governed";
//         readRefreshState rethrows it (a refusal is not a state). A registry refusal reads no step-4 row.
//   GR-06 retarget (B-B3 / E-2(b)): a PILOT project's registry row naming another sheet, or another project
//         registered on this sheet, is 409 RETARGETED BEFORE any step-4 row read (the snapshot rolls back); a
//         NON-pilot registered project with no step-4 row is not governed (PR-3a GV-1, GV1-a) and one with rows is
//         refused by them (GV1-c); this project's rows on another sheet, and another project's continuation on
//         this sheet (found by the SHEET-keyed read), are RETARGETED too.
//   GR-07 unreadable: a store failure, a lock read failure, a malformed store answer, a snapshot that cannot be
//         pinned, a store that answered without running the registry reads in its snapshot -> 503 with the store
//         token; readRefreshState answers the `unreadable` state carrying that token — never not_governed.
//   GR-08 governed by rows: a real confirm -> headers with memberCount, members, state, decisionVersionObserved;
//         readProjectRefreshState derives confirmed_pending_execution; plannerSlice feeds the pure core; a
//         RELATED supersede (review X-3) ends it: the ended row stays in the consult (it governs) and leaves the
//         slice; the answer is frozen.
//   GR-09 the lock shapes are the real module's: a live lease derives executing, an abandoned one
//         failed_pending_recovery.
//   GR-10 PR B's pilot reads REUSED (#6510): the reader over the PRODUCTION registry store (its getPilotState /
//         getPilotStateBySheetId -> rowToPilotState) — a row without the migration-101 columns is not pilot, a
//         marked row governs, a failed read is 503 naming the registry, a sheet registered to another project
//         retargets before any step-4 row read. No second pilot reader. The registry reads are `trx.selectOne`s
//         on the consult's snapshot handle, AFTER the REPEATABLE READ pin and BEFORE any step-4 read (review X-1):
//         the registry row and the step-4 rows are one snapshot.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const refreshKit = require(path.join(__dirname, 'support', 'stock-preparation-refresh-store-kit.cjs'))
const lockKit = require(path.join(__dirname, 'support', 'stock-preparation-project-write-lock-kit.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const governanceModule = require(path.join(LIB, 'stock-preparation-refresh-governance.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const { readProjectRefreshState } = require(path.join(LIB, 'stock-preparation-refresh-state.cjs'))
const { PROJECT_WRITE_LEASE_TTL_MS, PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS, sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))

const { REFRESH_STORE_TABLES: T } = storeModule
const { REFRESH_GOVERNANCE_ERROR_CODES: CODES, StockPreparationRefreshGovernanceError, createStockPreparationRefreshGovernance, plannerSlice } = governanceModule

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_gr_a'
const OTHER_TENANT = 'tenant_gr_b'
const SHEET = 'sheet_gr_a'
const OTHER_SHEET = 'sheet_gr_b'
const PULLER = 'u_gr_puller'

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

// PR B's registry pilot reads, faked: rows keyed by (tenant, project) and by sheet, the `rowToPilotState` shape.
// Each call records the `executor` it was handed and how many statements the step-4 fake db had logged by then
// (the snapshot proof of GR-03: the handle is the consult's transaction, pinned, with no step-4 read yet).
function createFakeRegistry(rows = [], { db = null } = {}) {
  const calls = []
  let fault = null
  const record = (name, args, options) => {
    const call = [name, ...args]
    call.executor = options && options.executor ? options.executor : null
    call.logLength = db ? db.log.length : null
    calls.push(call)
  }
  return {
    calls,
    rows,
    fail(error) { fault = error },
    async getPilotState({ tenantId, projectNo }, options) {
      record('getPilotState', [tenantId, projectNo], options)
      if (fault) throw fault
      return rows.find((row) => row.tenantId === tenantId && row.projectNo === projectNo) || null
    },
    async getPilotStateBySheetId({ sheetId }, options) {
      record('getPilotStateBySheetId', [sheetId], options)
      if (fault) throw fault
      return rows.find((row) => row.sheetId === sheetId) || null
    },
  }
}

// The step-4 reads in a fake db's statement log (autocommit or transaction): a registry refusal must leave none.
const STEP4_TABLES = new Set(Object.values(T))
function stepFourReads(db) {
  return db.log.filter(([method, args]) => /(^|\.)(select|selectOne|selectOneForUpdate)$/.test(method) && args && STEP4_TABLES.has(args.table))
}

function registryRow({ tenantId = TENANT, projectNo, sheetId = SHEET, pilot = false } = {}) {
  return {
    tenantId, projectNo, sheetId, objectId: `obj_${sheetId}`, status: 'active',
    pilot,
    pilotEnabledAt: pilot ? '2026-10-23T00:00:00.000Z' : null,
    pilotEnabledBy: pilot ? 'u_admin' : null,
    pilotReadinessVersion: pilot ? 1 : null,
  }
}

async function world({ registryRows, registryPilotColumns = true } = {}) {
  const fixture = await refreshKit.candidateHoldFixture()
  const clock = refreshKit.createClock()
  const db = refreshKit.createFakeRefreshDb({ clock, registryPilotColumns })
  let n = 0
  const continuationStore = storeModule.createStockPreparationContinuationStore({ db, now: clock.now, idGenerator: (kind) => `${kind}_${String((n += 1)).padStart(4, '0')}` })
  const lockEnv = lockKit.createInMemoryProjectWriteLock({ clock: lockKit.createClock(clock.iso()) })
  const registry = createFakeRegistry(registryRows === undefined ? [] : registryRows, { db })
  const governance = createStockPreparationRefreshGovernance({ continuationStore, projectTargetStore: registry, projectWriteLock: lockEnv.lock })
  const scope = { tenantId: TENANT, projectNo: fixture.projectNo, sheetId: SHEET }
  const bump = refreshKit.createFakeBumpWithin()
  return { fixture, hold: fixture.hold, clock, db, continuationStore, lockEnv, registry, governance, scope, bump, sourceIdentity: fixture.sourceIdentity }
}

function computation(overrides = {}) {
  return { lane: 'small_preview', suspended: true, generationToken: 'g_prev', sourceContentDigest: 'src_1', ...overrides }
}

async function seedAndConfirm(w, scopeOverride = {}) {
  const scope = { ...w.scope, ...scopeOverride }
  await w.continuationStore.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [w.hold], computation: computation() })
  const holdRow = w.db.rows(T.hold).find((row) => row.status === 'open' && row.sheet_id === scope.sheetId)
  return w.continuationStore.confirmContinuation({
    ...scope, holdId: holdRow.id, echo: refreshKit.echoOf(w.hold), basis: { kind: 'puller_confirmed_same_demand' }, confirmedBy: PULLER, sourceIdentity: w.sourceIdentity,
  }, { bumpWithin: w.bump.bumpWithin, pilotWithin: refreshKit.seedPilotWithin })
}

// ── GR-01 / GR-02 ────────────────────────────────────────────────────────────────────────────────

test('GR-01 not wired: constructing with nothing is fine (activation on a build without PR B); the consult is 501 by name for a missing store, a registry without the pilot reads, a missing lock', async () => {
  const w = await world()
  const none = createStockPreparationRefreshGovernance({})
  await expectError(none.consult(w.scope), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'continuation_store' })
  // main's registry store today: `get` but no PR B pilot reads -> a wiring defect by name, never "not pilot".
  const legacyRegistry = { get: async () => null }
  const noPilot = createStockPreparationRefreshGovernance({ continuationStore: w.continuationStore, projectTargetStore: legacyRegistry, projectWriteLock: w.lockEnv.lock })
  await expectError(noPilot.consult(w.scope), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'registry_pilot_reads' })
  const noLock = createStockPreparationRefreshGovernance({ continuationStore: w.continuationStore, projectTargetStore: w.registry, projectWriteLock: null })
  await expectError(noLock.consult(w.scope), { status: 501, code: CODES.STORE_UNAVAILABLE, reason: 'project_write_lock' })
  // readRefreshState on an unwired reader: the unreadable state (a 501 is not a refusal of THIS caller), never not_governed.
  const read = await none.readRefreshState(w.scope)
  assert.equal(read.state.status, 'unreadable')
  assert.equal(read.consult, null)
  assert.equal(read.error.code, CODES.STORE_UNAVAILABLE)
  assert.equal(w.db.log.length, 0, 'no statement ran')
})

test('GR-02 scope validation: 422 before any read', async () => {
  const w = await world()
  for (const bad of [{ ...w.scope, tenantId: '' }, { ...w.scope, projectNo: ' ' }, { ...w.scope, sheetId: undefined }]) {
    await expectError(w.governance.consult(bad), { status: 422, code: CODES.INPUT_INVALID })
    await expectError(w.governance.readRefreshState(bad), { status: 422, code: CODES.INPUT_INVALID })
  }
  assert.equal(w.registry.calls.length, 0)
  assert.equal(w.db.log.length, 0)
})

// ── GR-03 / GR-04 ────────────────────────────────────────────────────────────────────────────────

test('GR-03 not governed: every store answered, zero rows, no marker', async () => {
  const w = await world()
  const answer = await w.governance.consult(w.scope)
  assert.equal(answer.ok, true)
  assert.equal(answer.governed, false)
  assert.equal(answer.pilot, null)
  assert.equal(answer.registry, null)
  assert.deepEqual(answer.continuations, [])
  assert.deepEqual(answer.members, [])
  assert.deepEqual(answer.holds, [])
  assert.equal(answer.state, null)
  assert.deepEqual(answer.executions, [])
  assert.deepEqual(answer.changePlans, [])
  assert.equal(answer.decisionVersionObserved, 0)
  assert.equal(answer.scope.writeScopeKey, sheetWriteScopeKey(SHEET))
  assert.equal(answer.lock.state.present, false)
  assert.equal(answer.lock.generation.leaseId, null)
  assert.ok(Object.isFrozen(answer))
  const derived = readProjectRefreshState(answer)
  assert.equal(derived.status, 'not_governed')
  assert.equal(derived.governed, 'none')
  const read = await w.governance.readRefreshState(w.scope)
  assert.equal(read.state.status, 'not_governed')
  assert.equal(read.error, null)
  // Both registry reads happened, in the design's order: registry first, then the store, then the lock.
  assert.deepEqual(w.registry.calls.slice(0, 2).map((call) => call[0]), ['getPilotState', 'getPilotStateBySheetId'])
  // ONE SNAPSHOT (review X-1), per consult: BEGIN; the FIRST statement pins REPEATABLE READ; the registry reads are
  // handed THAT transaction handle before any step-4 read; every step-4 read runs on it (none in autocommit);
  // COMMIT. (Two consults ran above: consult + readRefreshState.)
  const log = w.db.log.map(([method, args]) => [method, args && args.table ? args.table : (args && args.level) || null])
  const firstConsult = log.slice(0, log.findIndex(([method]) => method === 'commit') + 1)
  assert.deepEqual(firstConsult[0], ['transaction', null])
  assert.deepEqual(firstConsult[1], ['trx.setTransactionIsolationLevel', 'repeatable read'], 'the snapshot is pinned by the transaction\'s first statement')
  assert.ok(firstConsult.slice(2, -1).length >= 18, `every step-4 read in the snapshot (${firstConsult.length - 3})`)
  assert.ok(firstConsult.slice(2, -1).every(([method, table]) => method === 'trx.select' && STEP4_TABLES.has(table)), JSON.stringify(firstConsult))
  assert.deepEqual(firstConsult[firstConsult.length - 1], ['commit', null])
  assert.equal(log.filter(([method]) => method === 'select' || method === 'selectOne').length, 0, 'no autocommit read of a step-4 table')
  assert.equal(w.registry.calls.length, 4, 'two registry reads per consult')
  for (const [index, call] of w.registry.calls.entries()) {
    assert.ok(call.executor && typeof call.executor.setTransactionIsolationLevel === 'function', `${call[0]} ran on the consult's transaction handle`)
    assert.equal(call.logLength, index < 2 ? 2 : firstConsult.length + 2, `${call[0]} ran right after BEGIN + SET, before any step-4 read`)
  }
  assert.equal(w.registry.calls[2].executor, w.db.lastTransactionHandle, 'the second consult\'s registry reads ran on ITS snapshot handle')
  assert.equal(w.registry.calls[3].executor, w.db.lastTransactionHandle)
  assert.notEqual(w.registry.calls[0].executor, w.registry.calls[2].executor, 'each consult opens its own snapshot')
})

test('GR-04 pilot: the marker alone governs; a non-pilot row does not; a failed registry read is unreadable, never "not pilot"', async () => {
  const pilot = await world({ registryRows: [registryRow({ projectNo: 'PRJ-SCC-1', pilot: true })] })
  const answer = await pilot.governance.consult(pilot.scope)
  assert.equal(answer.governed, true)
  assert.deepEqual(answer.pilot, { enabled: true, enabledAt: '2026-10-23T00:00:00.000Z', enabledBy: 'u_admin', readinessVersion: 1 })
  assert.deepEqual(answer.registry, { sheetId: SHEET, objectId: `obj_${SHEET}`, status: 'active' })
  assert.equal(readProjectRefreshState(answer).status, 'complete', 'pilot, nothing pending, lock free')
  assert.equal(readProjectRefreshState(answer).governed, 'pilot')
  const notPilot = await world({ registryRows: [registryRow({ projectNo: 'PRJ-SCC-1', pilot: false })] })
  const answer2 = await notPilot.governance.consult(notPilot.scope)
  assert.equal(answer2.governed, false)
  assert.deepEqual(answer2.pilot, { enabled: false, enabledAt: null, enabledBy: null, readinessVersion: null })
  assert.equal(readProjectRefreshState(answer2).status, 'not_governed')
  // The registry read fails: 503 naming the registry; the derived state is unreadable with that token.
  notPilot.registry.fail(refreshKit.sqlError('42703', 'column does not exist'))
  const failed = await expectError(notPilot.governance.consult(notPilot.scope), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(failed.details.store, 'registry')
  assert.equal(failed.details.operation, 'pilot_state_by_project')
  assert.equal(failed.details.sqlState, '42703')
  assert.equal(failed.details.partial, false)
  notPilot.registry.fail(refreshKit.sqlError('42703', 'column does not exist'))
  const read = await notPilot.governance.readRefreshState(notPilot.scope)
  assert.equal(read.state.status, 'unreadable')
  assert.equal(read.state.unreadable.store, 'registry')
  assert.equal(read.state.exportAllowed, false)
  assert.equal(read.consult, null)
})

// ── GR-05 tenant assertion ───────────────────────────────────────────────────────────────────────

test('GR-05 tenant assertion: a row of another tenant on this sheet is 409 TENANT_MISMATCH through the store and through the registry; a header-steered tenant owning nothing is refused, never "not governed"; readRefreshState rethrows', async () => {
  const w = await world()
  // Tenant A owns a continuation on sheet S for project P (a real confirm).
  await seedAndConfirm(w)
  // The same project consulted under tenant B (what a header-steered `user.tenantId` would derive): the
  // (tenant B, project) reads own nothing — the SHEET-keyed read finds A's rows -> refused.
  const steered = { ...w.scope, tenantId: OTHER_TENANT }
  const refused = await expectError(w.governance.consult(steered), { status: 409, code: CODES.TENANT_MISMATCH })
  assert.equal(refused.details.store, 'continuation')
  assert.equal(refused.details.table, 'continuation')
  assert.ok(!JSON.stringify(refused.details).includes(TENANT), 'values-free: the other tenant is not named')
  // readRefreshState: a refusal is RETHROWN, never shown as a state.
  await expectError(w.governance.readRefreshState(steered), { status: 409, code: CODES.TENANT_MISMATCH })
  // Through the registry: the sheet is registered to tenant A's project; tenant B consults it.
  const w2 = await world({ registryRows: [registryRow({ tenantId: TENANT, projectNo: 'PRJ-SCC-1', sheetId: SHEET })] })
  const viaRegistry = await expectError(w2.governance.consult({ ...w2.scope, tenantId: OTHER_TENANT }), { status: 409, code: CODES.TENANT_MISMATCH })
  assert.equal(viaRegistry.details.store, 'registry')
  assert.equal(stepFourReads(w2.db).length, 0, 'refused before any step-4 row was read')
  assert.equal(w2.db.log[w2.db.log.length - 1][0], 'rollback', 'the snapshot rolled back with the refusal (typed 409 passed through the store untouched)')
  // A tenant-B state row planted on the sheet (a defect or a cross-tenant derivation): refused by table name.
  const w3 = await world()
  await w3.continuationStore.reconcileHolds({ ...w3.scope, tenantId: OTHER_TENANT, decisionVersionObserved: 0, holds: [], computation: computation({ suspended: false }) })
  const planted = await expectError(w3.governance.consult(w3.scope), { status: 409, code: CODES.TENANT_MISMATCH })
  assert.equal(planted.details.table, 'refresh_state')
})

// ── GR-06 retarget ───────────────────────────────────────────────────────────────────────────────

test('GR-06 retarget: a PILOT registry row naming another sheet / another project on this sheet refuses BEFORE any row read; a non-pilot registered project is governed only by its rows (GV-1: none => not governed, rows elsewhere => RETARGETED sheet); this project\'s rows on another sheet, and another project\'s continuation on this sheet, are RETARGETED through the sheet-keyed read', async () => {
  // GV1-a (PR-3a GV-1, owner ruling 2026-10-24): the project is registered — NOT pilot — on its managed sheet;
  // the action resolved to the env sheet (switch off); no step-4 row anywhere -> NOT governed (today's
  // behaviour for that project), never refused.
  const w = await world({ registryRows: [registryRow({ projectNo: 'PRJ-SCC-1', sheetId: 'sheet_managed' })] })
  const notGoverned = await w.governance.consult(w.scope)
  assert.equal(notGoverned.ok, true)
  assert.equal(notGoverned.governed, false)
  assert.equal(notGoverned.registry.sheetId, 'sheet_managed')
  assert.equal(stepFourReads(w.db).length > 0, true, 'the step-4 reads ran (and found nothing)')
  assert.equal((await w.governance.readRefreshState(w.scope)).state.status, 'not_governed')
  // GV1-b: the same registry row of a PILOT project -> RETARGETED before any step-4 row read; the snapshot rolls back.
  const wp = await world({ registryRows: [registryRow({ projectNo: 'PRJ-SCC-1', sheetId: 'sheet_managed', pilot: true })] })
  const refused = await expectError(wp.governance.consult(wp.scope), { status: 409, code: CODES.TARGET_RETARGETED, reason: 'project_registered_on_another_sheet' })
  assert.equal(refused.details.store, 'registry')
  assert.equal(stepFourReads(wp.db).length, 0, 'refused before any step-4 row read')
  assert.equal(wp.db.log[wp.db.log.length - 1][0], 'rollback')
  assert.ok(!JSON.stringify(refused.details).includes('sheet_managed'), 'values-free')
  await expectError(wp.governance.readRefreshState(wp.scope), { status: 409, code: CODES.TARGET_RETARGETED })
  // GV1-c: the registry row is NOT pilot, but the project's step-4 rows live on the managed sheet -> RETARGETED
  // `sheet` by the (tenant, project) read (assertRows): a project governed by rows is refused without the pilot marker.
  const wr = await world({ registryRows: [registryRow({ projectNo: 'PRJ-SCC-1', sheetId: 'sheet_managed' })] })
  await seedAndConfirm(wr, { sheetId: 'sheet_managed' })
  const byRows = await expectError(wr.governance.consult(wr.scope), { status: 409, code: CODES.TARGET_RETARGETED, reason: 'sheet' })
  assert.equal(byRows.details.store, 'continuation')
  assert.equal(byRows.details.table, 'continuation')
  // ... and a state row alone governs the same way (table refresh_state).
  const ws = await world({ registryRows: [registryRow({ projectNo: 'PRJ-SCC-1', sheetId: 'sheet_managed' })] })
  await ws.continuationStore.reconcileHolds({ ...ws.scope, sheetId: 'sheet_managed', decisionVersionObserved: 0, holds: [], computation: computation({ suspended: false }) })
  const byState = await expectError(ws.governance.consult(ws.scope), { status: 409, code: CODES.TARGET_RETARGETED, reason: 'sheet' })
  assert.equal(byState.details.table, 'refresh_state')
  // GV1-d (unchanged below): this sheet registered to ANOTHER project, and the (d) leg of GR-10, still refuse.
  // This sheet is registered to ANOTHER project.
  const w2 = await world({ registryRows: [registryRow({ projectNo: 'PRJ-OTHER', sheetId: SHEET })] })
  await expectError(w2.governance.consult(w2.scope), { status: 409, code: CODES.TARGET_RETARGETED, reason: 'sheet_registered_to_another_project' })
  assert.equal(stepFourReads(w2.db).length, 0)
  // No registry row at all (legacy env sheet), but this project's protection lives on another sheet.
  const w3 = await world()
  await seedAndConfirm(w3, { sheetId: OTHER_SHEET })
  const rows = await expectError(w3.governance.consult(w3.scope), { status: 409, code: CODES.TARGET_RETARGETED, reason: 'sheet' })
  assert.equal(rows.details.store, 'continuation')
  assert.equal(rows.details.table, 'continuation')
  // Another project's continuation on THIS sheet: only the SHEET-keyed read can see it (the (tenant, project)
  // reads name PRJ-SCC-1) -> RETARGETED by project. Removing the sheet-keyed read answers "not governed" here.
  const w4 = await world()
  await w4.db.insertOne(T.continuation, {
    id: 'cont_other_project', tenant_id: TENANT, sheet_id: SHEET, project_no: 'PRJ-OTHER', write_scope_key: sheetWriteScopeKey(SHEET), status: 'active', revision: 1,
    old_root_record_id: 'rec_o', old_root_key: '{"k":1}', old_root_component_source_id: 'c', new_parent_component_source_id: 'p', new_root_path_tokens: ['p', 'c'],
    new_root_key: '{"k":2}', new_root_key_digest: 'd_other', external_system_id: 'x', source_scope_digest: 's', read_plan_digest: 'r',
    pairing_fingerprint: 'pf', comparison_fingerprint: 'cf', evidence_fingerprint: 'ef', evidence_snapshot: {}, demand_basis: 'puller_confirmed_same_demand',
    confirmed_by: 'u', confirmed_at: w4.clock.now(), confirmed_generation: 1, confirmed_generation_token: 't', confirmed_fencing_epoch: 0,
  })
  const byProject = await expectError(w4.governance.consult(w4.scope), { status: 409, code: CODES.TARGET_RETARGETED, reason: 'project' })
  assert.equal(byProject.details.table, 'continuation')
  // The same sheet consulted under the project that owns it: governed.
  const owner = await w4.governance.consult({ ...w4.scope, projectNo: 'PRJ-OTHER' })
  assert.equal(owner.governed, true)
  assert.equal(owner.continuations.length, 1)
})

// ── GR-07 unreadable ─────────────────────────────────────────────────────────────────────────────

test('GR-07 unreadable: a store failure, a lock read failure or a malformed store answer is 503 with the store token; readRefreshState answers unreadable carrying it — never not_governed', async () => {
  const w = await world()
  w.db.faults.select = refreshKit.sqlError('42P01', 'relation does not exist')
  const store = await expectError(w.governance.consult(w.scope), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(store.details.store, 'continuation')
  assert.equal(store.details.operation, 'read_continuations')
  assert.equal(store.details.sqlState, '42P01')
  assert.equal(store.details.partial, false)
  w.db.faults.select = refreshKit.sqlError('42P01', 'relation does not exist')
  const read = await w.governance.readRefreshState(w.scope)
  assert.equal(read.state.status, 'unreadable')
  assert.equal(read.state.unreadable.store, 'continuation')
  assert.equal(read.state.unreadable.operation, 'read_continuations')
  assert.equal(read.state.governed, 'unknown')
  assert.equal(read.state.exportAllowed, false)
  delete w.db.faults.select
  // The lock row cannot be read: the lock's own 503 becomes a governance 503 naming the lock, never "no live lease".
  w.lockEnv.db.faults.selectOne = refreshKit.sqlError('57P01', 'terminating connection')
  const lock = await expectError(w.governance.consult(w.scope), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(lock.details.store, 'lock')
  assert.equal(lock.details.operation, 'read_state')
  w.lockEnv.db.faults.selectOne = refreshKit.sqlError('57P01', 'terminating connection')
  const lockRead = await w.governance.readRefreshState(w.scope)
  assert.equal(lockRead.state.status, 'unreadable')
  assert.equal(lockRead.state.unreadable.store, 'lock')
  // A store answering something other than `{ ok: true }`: 503, not a guess.
  const odd = createStockPreparationRefreshGovernance({ continuationStore: { readGovernanceRows: async () => ({ rows: [] }) }, projectTargetStore: w.registry, projectWriteLock: w.lockEnv.lock })
  await expectError(odd.consult(w.scope), { status: 503, code: CODES.STORE_FAILED })
  // A store throwing a plain error: 503 with the operation, no message leak.
  const thrower = createStockPreparationRefreshGovernance({ continuationStore: { readGovernanceRows: async () => { throw new Error('PRJ-SCC-1 secret value') } }, projectTargetStore: w.registry, projectWriteLock: w.lockEnv.lock })
  const plain = await expectError(thrower.consult(w.scope), { status: 503, code: CODES.STORE_FAILED })
  assert.ok(!JSON.stringify({ m: plain.message, d: plain.details }).includes('secret'))
  // The snapshot cannot be pinned (the SET fails): 503 naming the snapshot, nothing read, the derived state unreadable.
  w.db.log.length = 0
  w.db.faults.setTransactionIsolationLevel = refreshKit.sqlError('25001', 'SET TRANSACTION ISOLATION LEVEL must be called before any query')
  const unpinned = await expectError(w.governance.consult(w.scope), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(unpinned.details.store, 'continuation')
  assert.equal(unpinned.details.operation, 'read_snapshot')
  assert.equal(unpinned.details.sqlState, '25001')
  assert.equal(stepFourReads(w.db).length, 0, 'nothing read outside a pinned snapshot')
  w.db.faults.setTransactionIsolationLevel = refreshKit.sqlError('25001', 'SET TRANSACTION ISOLATION LEVEL must be called before any query')
  const unpinnedRead = await w.governance.readRefreshState(w.scope)
  assert.equal(unpinnedRead.state.status, 'unreadable')
  assert.equal(unpinnedRead.state.unreadable.operation, 'read_snapshot')
  // A store that answers `ok` without running the registry reads in its snapshot: the registry was never read —
  // 503 naming the registry, never "not pilot".
  const skipper = createStockPreparationRefreshGovernance({
    continuationStore: { readGovernanceRows: async () => ({ ok: true, scope: w.scope, continuations: [], members: [], holds: [], states: [], executions: [] }) },
    projectTargetStore: w.registry,
    projectWriteLock: w.lockEnv.lock,
  })
  const skipped = await expectError(skipper.consult(w.scope), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(skipped.details.store, 'registry')
  assert.equal(skipped.details.operation, 'read_snapshot')
})

// ── GR-08 governed by rows ───────────────────────────────────────────────────────────────────────

test('GR-08 governed by rows: headers with memberCount, members, state, decisionVersionObserved; the derived state; plannerSlice feeds the pure core; ended rows govern but leave the slice', async () => {
  const w = await world()
  const confirmed = await seedAndConfirm(w)
  const answer = await w.governance.consult(w.scope)
  assert.equal(answer.governed, true)
  assert.equal(answer.pilot, null)
  assert.equal(answer.continuations.length, 1)
  assert.equal(answer.continuations[0].id, confirmed.continuationId)
  assert.equal(answer.continuations[0].memberCount, 4)
  assert.equal(answer.continuations[0].executedExecutionId, null)
  assert.ok(answer.continuations[0].confirmedAt)
  assert.equal(answer.members.length, 4)
  assert.equal(answer.holds.length, 0)
  assert.equal(answer.state.decisionVersion, 1)
  assert.equal(answer.decisionVersionObserved, 1)
  assert.equal(answer.lock.state.present, false, 'the fake bump never touched the lock row')
  const derived = readProjectRefreshState(answer)
  assert.equal(derived.status, 'confirmed_pending_execution')
  assert.equal(derived.governed, 'protected')
  assert.deepEqual(derived.counts, { pendingConfirm: 0, confirmable: 0, openExecutions: 0, pendingReviews: 0, continuations: 1 })
  const slice = plannerSlice(answer)
  const input = pairing.normalizeContinuationInput({ storeState: 'ok', pilot: false, projectNo: w.scope.projectNo, continuations: slice.continuations, members: slice.members, demandEvidence: null, sourceIdentity: w.sourceIdentity, specSlotDeclared: false, persistedHolds: [] })
  const projection = pairing.buildContinuationProjection(input.continuations, input.members)
  assert.equal(projection.suppressAddKeys.size, 4)
  assert.equal(projection.protectInactiveKeys.size, 4)
  assert.ok(Object.isFrozen(answer) && Object.isFrozen(answer.continuations) && Object.isFrozen(slice))
  // End it the only way an ACTIVE relationship ends (design §9.3; review X-2 / X-3): a confirmation of a RELATED
  // candidate (the same old rows under another parent) that supersedes it. The ended row still governs (D3) and
  // leaves the planner slice; its claims and members leave with it; the replacing one is the slice.
  const rival = refreshKit.competingCandidateHold(w.hold)
  await w.continuationStore.reconcileHolds({ ...w.scope, decisionVersionObserved: answer.decisionVersionObserved, holds: [rival], computation: computation() })
  const rivalRow = w.db.rows(T.hold).find((row) => row.fingerprint === rival.fingerprint && row.status === 'open')
  const replaced = await w.continuationStore.confirmContinuation({
    ...w.scope, holdId: rivalRow.id, echo: refreshKit.echoOf(rival), basis: { kind: 'puller_confirmed_same_demand' }, confirmedBy: PULLER, sourceIdentity: w.sourceIdentity,
    supersedes: { continuationId: confirmed.continuationId, revision: 1 },
  }, { bumpWithin: w.bump.bumpWithin, pilotWithin: refreshKit.seedPilotWithin })
  assert.equal(replaced.supersededContinuationId, confirmed.continuationId)
  const after = await w.governance.consult(w.scope)
  assert.equal(after.governed, true)
  assert.equal(after.decisionVersionObserved, 2)
  const ended = after.continuations.find((entry) => entry.id === confirmed.continuationId)
  assert.equal(ended.status, 'ended')
  assert.equal(ended.endedOutcome, 'superseded_by_new_confirmation')
  assert.equal(ended.memberCount, 0)
  assert.equal(after.members.length, 4)
  assert.ok(after.members.every((member) => member.continuationId === replaced.continuationId), 'only the replacing relationship\'s members are claimed')
  assert.deepEqual(plannerSlice(after).continuations.map((entry) => entry.id), [replaced.continuationId], 'the ended row leaves the planner slice')
  assert.equal(readProjectRefreshState(after).governed, 'protected')
  assert.equal(readProjectRefreshState(after).status, 'confirmed_pending_execution')
  await expectError(Promise.resolve().then(() => plannerSlice({ ok: false })), { status: 503, code: CODES.STORE_FAILED })
})

// ── GR-09 the lock shapes ────────────────────────────────────────────────────────────────────────

test('GR-09 the lock shapes are the real module\'s: a live lease derives executing; an abandoned lease derives failed_pending_recovery', async () => {
  const w = await world({ registryRows: [registryRow({ projectNo: 'PRJ-SCC-1', pilot: true })] })
  const scopeKey = sheetWriteScopeKey(SHEET)
  const grant = await w.lockEnv.lock.acquire(scopeKey, { purpose: 'small_apply', runId: 'run_gr', tenantId: TENANT })
  const live = await w.governance.consult(w.scope)
  assert.equal(live.lock.state.leaseLive, true)
  assert.equal(live.lock.generation.leaseId, grant.leaseId)
  assert.equal(readProjectRefreshState(live).status, 'executing')
  w.lockEnv.clock.advance(PROJECT_WRITE_LEASE_TTL_MS + PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS + 1)
  const abandoned = await w.governance.consult(w.scope)
  assert.equal(abandoned.lock.state.leaseHeld, true)
  assert.equal(abandoned.lock.state.leaseLive, false)
  assert.equal(readProjectRefreshState(abandoned).status, 'failed_pending_recovery')
  await w.lockEnv.lock.createGuard(grant).release().catch(() => {})
})

// ── GR-10 PR B's pilot reads, REUSED ─────────────────────────────────────────────────────────────

test('GR-10 the reader REUSES PR B\'s registry pilot reads (the production store\'s getPilotState / getPilotStateBySheetId, migration 101) ON the consult\'s snapshot handle: a row without the pilot columns is not pilot, a marked row governs, a failed read is unreadable, a sheet registered to another project retargets before any step-4 row read', async () => {
  const registryModule = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
  assert.equal(typeof registryModule.rowToPilotState, 'function', 'PR B (#6510) is on the tree')
  const RT = refreshKit.REGISTRY_TABLE
  // The PRODUCTION registry store over the SAME fake scoped db the step-4 store uses (one plugin database, as wired
  // in index.cjs): its pilot reads are handed the consult's transaction handle as `executor`.
  const readerOver = (w) => createStockPreparationRefreshGovernance({
    continuationStore: w.continuationStore,
    projectTargetStore: registryModule.createStockPreparationProjectTargetStore({ db: w.db }),
    projectWriteLock: w.lockEnv.lock,
  })
  const entries = (db) => db.log.map(([method, args]) => `${method}:${args && args.table ? args.table : (args && args.level) || ''}`)
  // (a) a database where migration 101 has NOT run: the row carries no pilot column at all -> not pilot (never 501 / unreadable).
  const pre = await world({ registryPilotColumns: false })
  const PRJ = pre.scope.projectNo
  await pre.db.insertOne(RT, refreshKit.registryRow({ tenantId: TENANT, projectNo: PRJ, sheetId: SHEET, objectId: 'obj_a' }))
  assert.ok(!Object.prototype.hasOwnProperty.call(pre.db.rows(RT)[0], 'pilot_enabled_at'), 'no migration-101 column on this database')
  pre.db.log.length = 0
  const pre101 = await readerOver(pre).consult(pre.scope)
  assert.deepEqual(pre101.pilot, { enabled: false, enabledAt: null, enabledBy: null, readinessVersion: null })
  assert.equal(pre101.governed, false)
  assert.deepEqual(pre101.registry, { sheetId: SHEET, objectId: 'obj_a', status: 'active' })
  assert.equal(readProjectRefreshState(pre101).status, 'not_governed')
  // ONE SNAPSHOT (review X-1): the two registry reads are `trx.selectOne`s ON the consult's transaction, right after
  // the REPEATABLE READ pin and before every step-4 read — never an autocommit read beside the snapshot.
  const log = entries(pre.db)
  assert.deepEqual(log.slice(0, 4), ['transaction:', 'trx.setTransactionIsolationLevel:repeatable read', `trx.selectOne:${RT}`, `trx.selectOne:${RT}`])
  assert.equal(log.filter((entry) => entry.endsWith(`:${RT}`)).length, 2, 'the registry is read twice (by project, by sheet), both in the snapshot')
  assert.ok(log.slice(4, -1).every((entry) => entry.startsWith('trx.select:') && STEP4_TABLES.has(entry.slice('trx.select:'.length))), 'then only step-4 reads, on the same transaction')
  assert.equal(log[log.length - 1], 'commit:')
  // (b) the marker set (migration 101 applied, the admin enabled the pilot): the marker alone governs.
  const w = await world()
  await w.db.insertOne(RT, refreshKit.registryRow({ tenantId: TENANT, projectNo: PRJ, sheetId: SHEET, objectId: 'obj_a', pilot: true, at: new Date('2026-10-24T00:00:00.000Z') }))
  const reader = readerOver(w)
  const marked = await reader.consult(w.scope)
  assert.deepEqual(marked.pilot, { enabled: true, enabledAt: '2026-10-24T00:00:00.000Z', enabledBy: 'u_admin', readinessVersion: 1 })
  assert.equal(marked.governed, true)
  assert.equal(readProjectRefreshState(marked).governed, 'pilot')
  // (c) the registry read fails: 503 naming the registry — never "not pilot"; the snapshot rolls back, no step-4 read.
  w.db.log.length = 0
  w.db.faults.selectOne = refreshKit.sqlError('42703', 'column does not exist')
  const failed = await expectError(reader.consult(w.scope), { status: 503, code: CODES.STORE_FAILED })
  assert.equal(failed.details.store, 'registry')
  assert.equal(failed.details.operation, 'pilot_state_by_project')
  assert.equal(failed.details.sqlState, '42703')
  assert.equal(stepFourReads(w.db).length, 0)
  assert.equal(w.db.log[w.db.log.length - 1][0], 'rollback')
  // (d) through the real by-sheet read: this sheet is registered to ANOTHER project -> RETARGETED before any step-4 row read.
  const foreign = await world()
  await foreign.db.insertOne(RT, refreshKit.registryRow({ tenantId: TENANT, projectNo: 'PRJ-OTHER', sheetId: SHEET, objectId: 'obj_b' }))
  foreign.db.log.length = 0
  await expectError(readerOver(foreign).consult(foreign.scope), { status: 409, code: CODES.TARGET_RETARGETED, reason: 'sheet_registered_to_another_project' })
  assert.equal(stepFourReads(foreign.db).length, 0, 'refused before any step-4 row read')
  assert.deepEqual(entries(foreign.db).slice(0, 2), ['transaction:', 'trx.setTransactionIsolationLevel:repeatable read'])
  assert.equal(foreign.db.log[foreign.db.log.length - 1][0], 'rollback')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-governance.test.cjs', tests)
