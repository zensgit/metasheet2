'use strict'

// 一个项目一张备料表 — the REGISTRY store (S1 of ADR adr-stock-prep-project-sheets-20261008) and its
// migration 087, against the in-memory db fake the handoff suite established.
//
//   S-01 THE UNIQUE INDEX IS THE ARBITER: a second create for the same (tenant, project) — the
//        23505 a real database raises on `uniq_integration_stock_prep_project_target_scope` — is a
//        typed 409 STOCK_PREPARATION_PROJECT_TARGET_EXISTS, never a second row and never a raw error.
//        Mutation: drop the `isUniqueViolation` branch in `create` and this reds (the raw error
//        escapes with no `.status`).
//   S-02 the sheet-uniqueness index gets the same 409; any OTHER error propagates untouched.
//   S-03 the public projection is handles, enums, counts and clocks ONLY — the three O2(a) free-text
//        columns never leave the store through S1's reads.
//   S-04 scope validation: a blank tenant or project number is a 422, before any db call.
//   S-05 get / list / count read what create wrote; count includes an archived row.
//   S-06 migration 087 text: both unique indexes, the status / archived / outcome CHECKs, the
//        integration_ prefix, no value-bearing column, no DROP.
//   S-07 (E1) `create` is ONE transaction: the per-tenant advisory lock is taken FIRST, then the
//        count, then the insert — every statement on the transaction handle — and the cap is enforced
//        under the lock. Mutation: drop the `advisoryXactLock` call, or move the count / insert onto
//        the autocommit db, and the recorded call sequence reds.
//   S-08 (S4) `archive` is ONE transaction under the SAME tenant lock: lock → row FOR UPDATE →
//        compare-and-set update whose `where` repeats `status: 'active'`; it stamps status, the
//        archive outcome columns and `updated_at` and NOTHING else (sheet id, object id, creator,
//        counts untouched); 087's CHECK pairing holds after it.
//   S-09 (S4) `restore` mirrors it: archived → active, `archived_at` cleared in the same statement,
//        `restored_at` / `restored_by` stamped, `archived_by` kept as a fact.
//   S-10 (S4) the preconditions: archive of an archived row → 409 ALREADY_ARCHIVED, restore of an
//        active row → 409 NOT_ARCHIVED, a missing row → 409 ABSENT — each WITHOUT an update
//        statement, and another tenant's row with the same project number is never read or moved.
//   S-11 (S4) the compare-and-set backstop: a row whose status moved between the read and the write
//        (an update matching nothing) is the same typed 409, never a silent success.
//   S-12 (S4 fix round 1) `withActiveRowLocked` — the create replay's guard: lock → row FOR UPDATE →
//        active check → the callback, all inside ONE transaction; an archived row is 409 ARCHIVED
//        and a missing one 409 ABSENT, the callback never called; a callback's throw propagates.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  PROJECT_TARGET_TABLE,
  PROJECT_TARGET_CREATE_LOCK_PREFIX,
  SCOPE_CONSTRAINT,
  SHEET_CONSTRAINT,
  StockPreparationProjectTargetStoreError,
  createStockPreparationProjectTargetStore,
  lockRegistryAndCountCaseFoldedProjectGroups,
} = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))

const TENANT = 'tenant-s1-store'
const OTHER_TENANT = 'tenant-s1-other'

function makeMemoryDb({ failInsertWith } = {}) {
  const rows = []
  const calls = []
  function matches(row, where) {
    return Object.entries(where).every(([column, value]) => {
      const actual = row[column] === undefined ? null : row[column]
      return actual === (value === undefined ? null : value)
    })
  }
  // The statements, untagged; `api` (autocommit) and the transaction handle each log their own tag
  // before delegating here, so a suite can tell a statement that ran INSIDE the transaction from one
  // that ran in autocommit (E1: a lock in autocommit would guard nothing).
  const impl = {
    async selectOne(table, where) {
      assert.equal(table, PROJECT_TARGET_TABLE)
      return rows.find((row) => matches(row, where)) || null
    },
    async select(table, { where } = {}) {
      assert.equal(table, PROJECT_TARGET_TABLE)
      return rows.filter((row) => matches(row, where || {}))
    },
    async countRows(table, where) {
      assert.equal(table, PROJECT_TARGET_TABLE)
      return rows.filter((row) => matches(row, where || {})).length
    },
    async selectOneForUpdate(table, where) {
      assert.equal(table, PROJECT_TARGET_TABLE)
      return rows.find((row) => matches(row, where)) || null
    },
    async updateRow(table, set, where) {
      assert.equal(table, PROJECT_TARGET_TABLE)
      const hit = rows.filter((row) => matches(row, where))
      for (const row of hit) Object.assign(row, set)
      return hit.map((row) => ({ ...row }))
    },
    async insertOne(table, row) {
      assert.equal(table, PROJECT_TARGET_TABLE)
      if (failInsertWith) throw failInsertWith
      // The REAL unique indexes, modelled: a real database raises 23505 with the constraint name.
      if (rows.some((existing) => existing.tenant_id === row.tenant_id && existing.project_no === row.project_no)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint: SCOPE_CONSTRAINT })
      }
      if (rows.some((existing) => existing.sheet_id === row.sheet_id)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint: SHEET_CONSTRAINT })
      }
      const stored = {
        archived_by: null, archived_at: null, restored_by: null, restored_at: null,
        responsible_label: null, note: null, planned_finish_on: null,
        last_pull_at: null, last_pull_outcome: null, last_pull_code: null,
        row_count: null, active_row_count: null, counts_bounded: null, counts_at: null,
        created_at: new Date('2026-10-09T00:00:00Z'), updated_at: new Date('2026-10-09T00:00:00Z'),
        ...row,
      }
      rows.push(stored)
      return [stored]
    },
  }
  const tagged = (prefix) => ({
    async selectOne(table, where) { calls.push([`${prefix}selectOne`, table]); return impl.selectOne(table, where) },
    async select(table, options) { calls.push([`${prefix}select`, table]); return impl.select(table, options) },
    async countRows(table, where) { calls.push([`${prefix}countRows`, table]); return impl.countRows(table, where) },
    async insertOne(table, row) { calls.push([`${prefix}insertOne`, table]); return impl.insertOne(table, row) },
    async selectOneForUpdate(table, where) { calls.push([`${prefix}selectOneForUpdate`, table, { ...where }]); return impl.selectOneForUpdate(table, where) },
    async updateRow(table, set, where) { calls.push([`${prefix}updateRow`, table, { ...where }, Object.keys(set).sort()]); return impl.updateRow(table, set, where) },
  })
  const api = {
    rows,
    calls,
    ...tagged(''),
    async transaction(fn) {
      calls.push(['transaction'])
      return fn({
        ...tagged('trx.'),
        async setTransactionIsolationLevel(level) { calls.push(['trx.setTransactionIsolationLevel', level]) },
        async tryAdvisoryXactLock(key) { calls.push(['trx.tryAdvisoryXactLock', key]); return true },
        async advisoryXactLock(key) { calls.push(['trx.advisoryXactLock', key]) },
      })
    },
  }
  return api
}

const CLOCK = new Date('2026-10-09T08:00:00Z')

function makeStore(db) {
  let n = 0
  return createStockPreparationProjectTargetStore({ db, idGenerator: () => `pt-${(n += 1)}`, now: () => CLOCK })
}

/** 087's CHECK, asserted over every row the fake holds: archived ⇔ archived_at set. */
function assertArchivedCheckHolds(db) {
  for (const row of db.rows) {
    assert.equal(row.status === 'archived', row.archived_at !== null && row.archived_at !== undefined, `087 CHECK: status ${row.status} with archived_at ${row.archived_at}`)
    assert.ok(['active', 'archived'].includes(row.status), `087 CHECK: status ${row.status}`)
  }
}

async function expectStoreError(promise, status, code) {
  let caught = null
  try { await promise } catch (error) { caught = error }
  assert.ok(caught, `expected ${code}`)
  assert.ok(caught instanceof StockPreparationProjectTargetStoreError, `typed error, got ${caught && caught.name}`)
  assert.equal(caught.status, status)
  assert.equal(caught.code, code)
  return caught
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('S-01 a second create for the same (tenant, project) is 409 EXISTS — the unique index arbitrates', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  const first = await store.create({ tenantId: TENANT, projectNo: 'PRJ-S1-A', sheetId: 'sheet_a', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000001', createdBy: 'u_pull' })
  assert.equal(first.status, 'active')
  assert.equal(first.createdBy, 'u_pull')
  const error = await expectStoreError(
    store.create({ tenantId: TENANT, projectNo: 'PRJ-S1-A', sheetId: 'sheet_a2', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000002' }),
    409,
    'STOCK_PREPARATION_PROJECT_TARGET_EXISTS',
  )
  assert.deepEqual(error.details, { field: 'projectNo' })
  assert.equal(db.rows.length, 1, 'no second row')
  // The SAME project number for ANOTHER tenant is a different scope and lands.
  const other = await store.create({ tenantId: OTHER_TENANT, projectNo: 'PRJ-S1-A', sheetId: 'sheet_b', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000003' })
  assert.equal(other.tenantId, OTHER_TENANT)
  assert.equal(db.rows.length, 2)
})

test('S-02 the sheet index gets the same 409; a non-unique error propagates untouched', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  await store.create({ tenantId: TENANT, projectNo: 'PRJ-S1-A', sheetId: 'sheet_shared', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000001' })
  await expectStoreError(
    store.create({ tenantId: TENANT, projectNo: 'PRJ-S1-B', sheetId: 'sheet_shared', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000002' }),
    409,
    'STOCK_PREPARATION_PROJECT_TARGET_EXISTS',
  )
  const boom = Object.assign(new Error('relation does not exist'), { code: '42P01' })
  const failing = makeStore(makeMemoryDb({ failInsertWith: boom }))
  let caught = null
  try {
    await failing.create({ tenantId: TENANT, projectNo: 'PRJ-S1-C', sheetId: 'sheet_c', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000004' })
  } catch (error) { caught = error }
  assert.equal(caught, boom, 'a non-23505 error is not re-typed')
  // A 23505 on an UNRELATED constraint is not this store's refusal either.
  const foreign = Object.assign(new Error('dup'), { code: '23505', constraint: 'some_other_index' })
  const failingForeign = makeStore(makeMemoryDb({ failInsertWith: foreign }))
  caught = null
  try {
    await failingForeign.create({ tenantId: TENANT, projectNo: 'PRJ-S1-C', sheetId: 'sheet_c', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000004' })
  } catch (error) { caught = error }
  assert.equal(caught, foreign)
})

test('S-03 the public projection carries handles, enums, counts and clocks — never the three free-text columns', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  await store.create({ tenantId: TENANT, projectNo: 'PRJ-S1-A', sheetId: 'sheet_a', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000001' })
  // Simulate S3 having written the O2(a) columns and the counts.
  Object.assign(db.rows[0], { responsible_label: '某负责人', note: '自由文本备注', planned_finish_on: '2026-12-31', row_count: 12, active_row_count: 10, counts_bounded: false, last_pull_outcome: 'applied' })
  const row = await store.get({ tenantId: TENANT, projectNo: 'PRJ-S1-A' })
  assert.deepEqual(Object.keys(row).sort(), [
    'activeRowCount', 'archivedAt', 'countsAt', 'countsBounded', 'createdAt', 'createdBy', 'lastPullAt', 'lastPullCode',
    'lastPullOutcome', 'missingComponentsCount', 'objectId', 'procurementOpenCount', 'projectNo', 'restoredAt', 'rowCount',
    'sheetId', 'status', 'tenantId', 'updatedAt', 'warehouseOpenCount',
  ])
  const serialized = JSON.stringify(row)
  for (const forbidden of ['某负责人', '自由文本备注', '2026-12-31', 'responsible', 'note', 'planned']) {
    assert.ok(!serialized.includes(forbidden), `projection must not carry ${forbidden}`)
  }
  assert.equal(row.rowCount, 12)
  assert.equal(row.activeRowCount, 10)
  assert.equal(row.countsBounded, false)
  assert.equal(row.lastPullOutcome, 'applied')
  assert.equal(row.createdAt, '2026-10-09T00:00:00.000Z')
})

test('S-04 a blank tenant or project number is refused 422 before any db call', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  for (const input of [{ tenantId: '', projectNo: 'P' }, { tenantId: TENANT, projectNo: '   ' }, { projectNo: 'P' }, {}]) {
    await expectStoreError(store.get(input), 422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID')
    await expectStoreError(store.create({ ...input, sheetId: 's', objectId: 'o' }), 422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID')
  }
  await expectStoreError(store.create({ tenantId: TENANT, projectNo: 'P', sheetId: '', objectId: 'o' }), 422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID')
  await expectStoreError(store.list({}), 422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID')
  await expectStoreError(store.count({ tenantId: ' ' }), 422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID')
  assert.deepEqual(db.calls, [], 'no db call for a refused scope')
  // Trimmed exactly as the pull parameter is: the key cannot differ by whitespace.
  await store.create({ tenantId: TENANT, projectNo: '  PRJ-S1-T  ', sheetId: 'sheet_t', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000001' })
  assert.equal((await store.get({ tenantId: TENANT, projectNo: 'PRJ-S1-T' })).projectNo, 'PRJ-S1-T')
})

test('S-05 get / list / count read what create wrote; count includes an archived row; absent is null', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  assert.equal(await store.get({ tenantId: TENANT, projectNo: 'PRJ-S1-A' }), null)
  assert.equal(await store.count({ tenantId: TENANT }), 0)
  await store.create({ tenantId: TENANT, projectNo: 'PRJ-S1-A', sheetId: 'sheet_a', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000001' })
  await store.create({ tenantId: TENANT, projectNo: 'PRJ-S1-B', sheetId: 'sheet_b', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000002' })
  await store.create({ tenantId: OTHER_TENANT, projectNo: 'PRJ-S1-C', sheetId: 'sheet_c', objectId: 'plm_stock_preparation_sandbox_p_000000000000000000000003' })
  // S4 will archive; the store's reads must already treat an archived row as a registered one.
  Object.assign(db.rows[1], { status: 'archived', archived_at: new Date('2026-10-10T00:00:00Z'), archived_by: 'u_pull' })
  assert.equal(await store.count({ tenantId: TENANT }), 2, 'archived rows count toward the cap')
  const listed = await store.list({ tenantId: TENANT })
  assert.deepEqual(listed.map((row) => [row.projectNo, row.status]), [['PRJ-S1-A', 'active'], ['PRJ-S1-B', 'archived']])
  assert.equal(listed[1].archivedAt, '2026-10-10T00:00:00.000Z')
  assert.ok(listed.every((row) => row.tenantId === TENANT), 'list is tenant-scoped')
})

test('S-07 (E1) create serializes count + insert per tenant: ONE transaction, the advisory lock first, then the count, then the insert — and the cap is enforced under the lock', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  const base = { tenantId: 'tenant-s1-lock', objectId: 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567' }
  await store.create({ ...base, projectNo: 'P-1', sheetId: 'sheet_lock_1', maxPerTenant: 2 })
  assert.deepEqual(db.calls, [
    ['transaction'],
    ['trx.advisoryXactLock', `${PROJECT_TARGET_CREATE_LOCK_PREFIX}tenant-s1-lock`],
    ['trx.countRows', PROJECT_TARGET_TABLE],
    ['trx.insertOne', PROJECT_TARGET_TABLE],
  ], 'lock → count → insert, every statement on the transaction handle')
  db.calls.length = 0
  await store.create({ ...base, projectNo: 'P-2', sheetId: 'sheet_lock_2', maxPerTenant: 2 })
  // At the cap: refused UNDER THE LOCK, after the count, with nothing inserted.
  const limited = await expectStoreError(store.create({ ...base, projectNo: 'P-3', sheetId: 'sheet_lock_3', maxPerTenant: 2 }), 409, 'STOCK_PREPARATION_PROJECT_TARGET_LIMIT')
  assert.deepEqual(limited.details, { limit: 2 })
  assert.deepEqual(db.calls.slice(-3), [['transaction'], ['trx.advisoryXactLock', `${PROJECT_TARGET_CREATE_LOCK_PREFIX}tenant-s1-lock`], ['trx.countRows', PROJECT_TARGET_TABLE]])
  assert.equal(db.rows.filter((row) => row.tenant_id === 'tenant-s1-lock').length, 2)
  // Another tenant is not counted against this one.
  await store.create({ ...base, tenantId: 'tenant-s1-other', projectNo: 'P-1', sheetId: 'sheet_lock_4', maxPerTenant: 2 })
  // No cap given: no count, still locked, still transactional.
  db.calls.length = 0
  await store.create({ ...base, tenantId: 'tenant-s1-uncapped', projectNo: 'P-1', sheetId: 'sheet_lock_5' })
  assert.deepEqual(db.calls, [['transaction'], ['trx.advisoryXactLock', `${PROJECT_TARGET_CREATE_LOCK_PREFIX}tenant-s1-uncapped`], ['trx.insertOne', PROJECT_TARGET_TABLE]])
  // A malformed cap is refused before any db call.
  db.calls.length = 0
  for (const bad of [0, -1, 1.5, '200', NaN]) {
    await expectStoreError(store.create({ ...base, projectNo: 'P-9', sheetId: 'sheet_lock_9', maxPerTenant: bad }), 422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID')
  }
  assert.deepEqual(db.calls, [])
  // A db without `transaction` cannot build the store at all (a lock in autocommit would guard nothing).
  const { transaction: _omitted, ...autocommitOnly } = makeMemoryDb()
  assert.throws(() => createStockPreparationProjectTargetStore({ db: autocommitOnly }), /transaction/)
})

const LIFECYCLE_BASE = Object.freeze({ tenantId: 'tenant-s4-store', objectId: 'plm_stock_preparation_sandbox_p_abcdefabcdefabcdefabcdef' })

test('S-08 (S4) archive: ONE transaction, the tenant lock, the row FOR UPDATE, a compare-and-set update that stamps the archive columns and nothing else', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  await store.create({ ...LIFECYCLE_BASE, projectNo: 'P-ARC', sheetId: 'sheet_s4_arc', createdBy: 'u_creator', maxPerTenant: 200 })
  const before = { ...db.rows[0] }
  db.calls.length = 0
  const archived = await store.archive({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: ' P-ARC ', actorId: 'u_puller' })
  const key = { tenant_id: LIFECYCLE_BASE.tenantId, project_no: 'P-ARC' }
  assert.deepEqual(db.calls, [
    ['transaction'],
    ['trx.advisoryXactLock', `${PROJECT_TARGET_CREATE_LOCK_PREFIX}${LIFECYCLE_BASE.tenantId}`],
    ['trx.selectOneForUpdate', PROJECT_TARGET_TABLE, key],
    ['trx.updateRow', PROJECT_TARGET_TABLE, { ...key, status: 'active' }, ['archived_at', 'archived_by', 'status', 'updated_at']],
  ], 'lock → FOR UPDATE → compare-and-set, every statement on the transaction handle; the SAME lock key as create')
  assert.equal(archived.status, 'archived')
  assert.equal(archived.archivedAt, CLOCK.toISOString())
  assert.equal(archived.sheetId, 'sheet_s4_arc')
  const after = db.rows[0]
  assert.equal(after.status, 'archived')
  assert.equal(after.archived_by, 'u_puller')
  assert.equal(after.archived_at, CLOCK)
  assert.equal(after.updated_at, CLOCK)
  // Nothing else on the row moved: the sheet is not re-pointed, the creator is not rewritten.
  for (const column of Object.keys(before)) {
    if (['status', 'archived_at', 'archived_by', 'updated_at'].includes(column)) continue
    assert.deepEqual(after[column], before[column], `archive leaves ${column} untouched`)
  }
  assertArchivedCheckHolds(db)
  // The cap still counts it: an archived sheet is a live sheet.
  assert.equal(await store.count({ tenantId: LIFECYCLE_BASE.tenantId }), 1)
})

test('S-09 (S4) restore: archived → active, archived_at cleared in the same statement, restored_* stamped, archived_by kept', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  await store.create({ ...LIFECYCLE_BASE, projectNo: 'P-RES', sheetId: 'sheet_s4_res' })
  await store.archive({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: 'P-RES', actorId: 'u_archiver' })
  db.calls.length = 0
  const restored = await store.restore({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: 'P-RES', actorId: 'u_restorer' })
  const key = { tenant_id: LIFECYCLE_BASE.tenantId, project_no: 'P-RES' }
  assert.deepEqual(db.calls, [
    ['transaction'],
    ['trx.advisoryXactLock', `${PROJECT_TARGET_CREATE_LOCK_PREFIX}${LIFECYCLE_BASE.tenantId}`],
    ['trx.selectOneForUpdate', PROJECT_TARGET_TABLE, key],
    ['trx.updateRow', PROJECT_TARGET_TABLE, { ...key, status: 'archived' }, ['archived_at', 'restored_at', 'restored_by', 'status', 'updated_at']],
  ], 'no count: the cap is NOT re-checked on restore (the row was counted while archived)')
  assert.equal(restored.status, 'active')
  assert.equal(restored.archivedAt, null)
  assert.equal(restored.restoredAt, CLOCK.toISOString())
  const row = db.rows[0]
  assert.equal(row.archived_at, null)
  assert.equal(row.restored_by, 'u_restorer')
  assert.equal(row.archived_by, 'u_archiver', 'the last archiver stays as a fact')
  assertArchivedCheckHolds(db)
  // ...and the row can be archived again: the lifecycle is a cycle, not a one-way door.
  assert.equal((await store.archive({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: 'P-RES', actorId: 'u_archiver' })).status, 'archived')
  assertArchivedCheckHolds(db)
})

test('S-10 (S4) preconditions: ALREADY_ARCHIVED / NOT_ARCHIVED / ABSENT are typed 409s with no update statement; another tenant is never touched', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  await store.create({ ...LIFECYCLE_BASE, projectNo: 'P-PRE', sheetId: 'sheet_s4_pre' })
  await store.create({ ...LIFECYCLE_BASE, tenantId: 'tenant-s4-foreign', projectNo: 'P-FOREIGN', sheetId: 'sheet_s4_foreign' })
  const scope = { tenantId: LIFECYCLE_BASE.tenantId, actorId: 'u_puller' }

  db.calls.length = 0
  await expectStoreError(store.restore({ ...scope, projectNo: 'P-PRE' }), 409, 'STOCK_PREPARATION_PROJECT_NOT_ARCHIVED')
  assert.ok(!db.calls.some((call) => call[0] === 'trx.updateRow'), 'restoring an ACTIVE row issues no update')
  assert.equal(db.rows[0].status, 'active')

  await store.archive({ ...scope, projectNo: 'P-PRE' })
  db.calls.length = 0
  await expectStoreError(store.archive({ ...scope, projectNo: 'P-PRE' }), 409, 'STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED')
  assert.ok(!db.calls.some((call) => call[0] === 'trx.updateRow'), 'archiving an ARCHIVED row issues no update')
  assert.equal(db.rows[0].archived_at, CLOCK, 'the first archive stamp is not rewritten')

  for (const transition of ['archive', 'restore']) {
    db.calls.length = 0
    const absent = await expectStoreError(store[transition]({ ...scope, projectNo: 'P-NOPE' }), 409, 'STOCK_PREPARATION_PROJECT_ABSENT')
    assert.deepEqual(absent.details, { field: 'projectNo' }, 'values-free: the field, never the number')
    assert.ok(!db.calls.some((call) => call[0] === 'trx.updateRow'), `${transition} of a missing row issues no update`)
    // Another tenant's project number is ABSENT for this tenant — never found, never moved.
    await expectStoreError(store[transition]({ ...scope, projectNo: 'P-FOREIGN' }), 409, 'STOCK_PREPARATION_PROJECT_ABSENT')
  }
  assert.equal(db.rows.find((row) => row.tenant_id === 'tenant-s4-foreign').status, 'active', 'the foreign row is untouched')
  // Scope validation precedes any db call.
  db.calls.length = 0
  for (const transition of ['archive', 'restore']) {
    await expectStoreError(store[transition]({ tenantId: '', projectNo: 'P-PRE' }), 422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID')
    await expectStoreError(store[transition]({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: '  ' }), 422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID')
  }
  assert.deepEqual(db.calls, [])
  assertArchivedCheckHolds(db)
})

test('S-11 (S4) the compare-and-set backstop: an update that matches nothing is the typed 409, never a silent success', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  await store.create({ ...LIFECYCLE_BASE, projectNo: 'P-CAS', sheetId: 'sheet_s4_cas' })
  // A read that answers "active" while the row has already moved (what a missing lock would allow):
  // the update's own `status: 'active'` predicate matches nothing.
  const stale = { ...db.rows[0] }
  db.rows[0].status = 'archived'
  db.rows[0].archived_at = CLOCK
  const original = db.transaction
  db.transaction = async (fn) => original.call(db, (trx) => fn({ ...trx, selectOneForUpdate: async () => stale }))
  await expectStoreError(store.archive({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: 'P-CAS', actorId: 'u_late' }), 409, 'STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED')
  assert.equal(db.rows[0].archived_by, null, 'the row was not re-stamped by the late transition')
})

test('S-12 (S4 fix round 1) withActiveRowLocked: lock → FOR UPDATE → active check → callback; archived / absent refuse without calling it', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  await store.create({ ...LIFECYCLE_BASE, projectNo: 'P-LOCK', sheetId: 'sheet_s4_lock' })
  db.calls.length = 0
  const seen = []
  const out = await store.withActiveRowLocked({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: 'P-LOCK' }, async (row) => {
    seen.push([...db.calls.map((call) => call[0])])
    return { status: row.status, sheetId: row.sheetId }
  })
  assert.deepEqual(out, { status: 'active', sheetId: 'sheet_s4_lock' })
  assert.deepEqual(seen, [['transaction', 'trx.advisoryXactLock', 'trx.selectOneForUpdate']], 'the callback runs AFTER the lock and the FOR UPDATE read, inside the transaction')
  assert.equal(db.calls[1][1], `${PROJECT_TARGET_CREATE_LOCK_PREFIX}${LIFECYCLE_BASE.tenantId}`, 'the SAME lock key create / archive / restore take')

  await store.archive({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: 'P-LOCK', actorId: 'u_archiver' })
  let called = 0
  const archived = await expectStoreError(store.withActiveRowLocked({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: 'P-LOCK' }, async () => { called += 1 }), 409, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
  assert.deepEqual(archived.details, { field: 'projectNo' })
  await expectStoreError(store.withActiveRowLocked({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: 'P-NONE' }, async () => { called += 1 }), 409, 'STOCK_PREPARATION_PROJECT_ABSENT')
  assert.equal(called, 0, 'the callback never runs for an archived or missing row')

  await store.restore({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: 'P-LOCK', actorId: 'u_restorer' })
  await assert.rejects(store.withActiveRowLocked({ tenantId: LIFECYCLE_BASE.tenantId, projectNo: 'P-LOCK' }, async () => { throw new Error('heal failed') }), /heal failed/)
})

test('P2-S01 deferred create resolves comparison and scans inside the tenant lock before any preparation', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  let prepared = 0
  const created = await store.create({
    tenantId: TENANT, projectNo: 'Abc', maxPerTenant: 200,
    resolveSourceProjectComparison: async () => {
      db.calls.push(['resolveComparison'])
      assert.deepEqual(db.calls.slice(0, 3), [
        ['transaction'], ['trx.setTransactionIsolationLevel', 'read committed'],
        ['trx.tryAdvisoryXactLock', `${PROJECT_TARGET_CREATE_LOCK_PREFIX}${TENANT}`],
      ], 'read committed is the first transaction statement, before the nonblocking tenant lock')
      return 'case-insensitive'
    },
  }, async () => {
    prepared += 1
    db.calls.push(['prepareTarget'])
    const names = db.calls.map((call) => call[0])
    assert.ok(names.indexOf('resolveComparison') > names.indexOf('trx.tryAdvisoryXactLock'))
    assert.ok(names.indexOf('trx.select') > names.indexOf('resolveComparison'), 'registry scan is on the transaction handle after effective mode')
    assert.ok(names.indexOf('trx.countRows') > names.indexOf('resolveComparison'), 'registry completeness count is on the transaction handle')
    assert.ok(!names.includes('select') && !names.includes('countRows'), 'no autocommit guard')
    assert.ok(!names.includes('trx.insertOne'), 'preparation precedes insert')
    return { sheetId: 'synthetic-prepared-sheet', objectId: 'synthetic-prepared-object' }
  })
  assert.equal(prepared, 1)
  assert.equal(created.projectNo, 'Abc')
  assert.equal(created.sheetId, 'synthetic-prepared-sheet')
  assert.equal(db.calls.at(-1)[0], 'trx.insertOne', 'insert stays in the same transaction')
})

test('P2-S02 active and archived variants refuse before deferred provision, packs or grants', async () => {
  for (const status of ['active', 'archived']) {
    const db = makeMemoryDb()
    const store = makeStore(db)
    await store.create({ tenantId: TENANT, projectNo: 'Abc', sheetId: `synthetic-${status}`, objectId: 'synthetic-object' })
    Object.assign(db.rows[0], { status, archived_at: status === 'archived' ? CLOCK : null })
    db.calls.length = 0
    const host = { provision: 0, pack: 0, grant: 0 }
    const error = await expectStoreError(store.create({
      tenantId: TENANT, projectNo: 'abc', maxPerTenant: 200,
      resolveSourceProjectComparison: async () => 'case-insensitive',
    }, async () => {
      host.provision += 1; host.pack += 1; host.grant += 1
      return { sheetId: 'synthetic-second-sheet', objectId: 'synthetic-second-object' }
    }), 409, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
    assert.deepEqual(error.details, { field: 'projectNo' })
    assert.doesNotMatch(error.message, /Abc|abc/)
    assert.deepEqual(host, { provision: 0, pack: 0, grant: 0 }, 'guard precedes the entire preparation callback')
    assert.equal(db.rows.length, 1)
    assert.equal(db.calls[0][0], 'transaction')
    assert.deepEqual(db.calls.slice(0, 3).map((call) => call[0]), ['transaction', 'trx.setTransactionIsolationLevel', 'trx.tryAdvisoryXactLock'])
    assert.ok(!db.calls.some((call) => call[0] === 'trx.insertOne'))
  }
})

test('P2-S03 deferred create requires the resolver and refuses exact duplicates or cap before preparation', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  let prepared = 0
  const prepare = async () => { prepared += 1; return { sheetId: 'synthetic-next', objectId: 'synthetic-next-object' } }
  // Explicit handles prevent an old implementation's required-handle validation from making
  // this missing-resolver control pass for the wrong reason.
  await assert.rejects(store.create({ tenantId: TENANT, projectNo: 'Abc', sheetId: 'ignored-sheet', objectId: 'ignored-object' }, prepare))
  assert.equal(prepared, 0)
  assert.equal(db.rows.length, 0)
  await store.create({ tenantId: TENANT, projectNo: 'Abc', sheetId: 'synthetic-first', objectId: 'synthetic-object' })
  await expectStoreError(store.create({ tenantId: TENANT, projectNo: 'Abc', resolveSourceProjectComparison: async () => 'case-insensitive' }, prepare), 409, 'STOCK_PREPARATION_PROJECT_TARGET_EXISTS')
  await expectStoreError(store.create({ tenantId: TENANT, projectNo: 'Other', maxPerTenant: 1, resolveSourceProjectComparison: async () => 'case-insensitive' }, prepare), 409, 'STOCK_PREPARATION_PROJECT_TARGET_LIMIT')
  assert.equal(prepared, 0)
  assert.equal(db.rows.length, 1)
})

test('P2-S04 default and case-sensitive deferred create preserve variants and tenant isolation', async () => {
  for (const comparison of [undefined, 'case-sensitive', 'case-insensitive']) {
    const db = makeMemoryDb()
    const store = makeStore(db)
    const firstTenant = comparison === 'case-insensitive' ? OTHER_TENANT : TENANT
    await store.create({ tenantId: firstTenant, projectNo: 'Abc', sheetId: 'synthetic-first', objectId: 'synthetic-object' })
    let called = 0
    const result = await store.create({ tenantId: TENANT, projectNo: 'abc', resolveSourceProjectComparison: async () => comparison }, async () => {
      called += 1
      return { sheetId: 'synthetic-variant', objectId: 'synthetic-variant-object' }
    })
    assert.equal(result.projectNo, 'abc')
    assert.equal(result.tenantId, TENANT)
    assert.equal(called, 1)
    assert.equal(db.rows.length, 2)
  }
})

test('P2-S05 malformed or truncated registry, invalid comparison and resolver failure refuse before preparation', async () => {
  for (const alter of [
    (trx) => ({ ...trx, async select() { return [] } }),
    (trx) => ({ ...trx, async select() { return [{ tenant_id: OTHER_TENANT, project_no: 'Other', sheet_id: 's', object_id: 'o', status: 'active' }] } }),
    (trx) => ({ ...trx, async select() { return [{ tenant_id: TENANT, project_no: 1, sheet_id: 's', object_id: 'o', status: 'active' }] } }),
    (trx) => ({ ...trx, async select() { throw new Error('synthetic-private-registry') } }),
    (trx) => ({ ...trx, async countRows() { return '1' } }),
    (trx) => ({ ...trx, async countRows() { return 0 }, async select() { return {} } }),
    (trx) => ({ ...trx, async select() { return [{ project_no: 'Other', sheet_id: 's', object_id: 'o', status: 'active' }] } }),
    (trx) => ({ ...trx, async select() { return [{ tenant_id: TENANT, project_no: ' Other ', sheet_id: 's', object_id: 'o', status: 'active' }] } }),
  ]) {
    const db = makeMemoryDb()
    const store = makeStore(db)
    await store.create({ tenantId: TENANT, projectNo: 'Other', sheetId: 'synthetic-first', objectId: 'synthetic-object' })
    const transaction = db.transaction
    db.transaction = (fn) => transaction((trx) => fn(alter(trx)))
    let prepared = 0
    await assert.rejects(store.create({ tenantId: TENANT, projectNo: 'abc', resolveSourceProjectComparison: async () => 'case-insensitive' }, async () => {
      prepared += 1; return { sheetId: 'synthetic-second', objectId: 'synthetic-second-object' }
    }), (error) => error.status === 503 && error.code === 'STOCK_PREPARATION_PROJECT_IDENTITY_UNAVAILABLE' && !/synthetic-private/.test(error.message))
    assert.equal(prepared, 0)
    assert.equal(db.rows.length, 1)
  }
  for (const resolveSourceProjectComparison of [async () => 'Case-Insensitive', async () => { throw new Error('synthetic resolver unavailable') }]) {
    const db = makeMemoryDb()
    const store = makeStore(db)
    let prepared = 0
    await assert.rejects(store.create({ tenantId: TENANT, projectNo: 'abc', resolveSourceProjectComparison }, async () => {
      prepared += 1; return { sheetId: 'synthetic-second', objectId: 'synthetic-second-object' }
    }))
    assert.equal(prepared, 0)
    assert.equal(db.rows.length, 0)
  }
})

test('P2-S06 exact replay rejects legacy ambiguity under the tenant lock before heal callback', async () => {
  const db = makeMemoryDb()
  const store = makeStore(db)
  await store.create({ tenantId: TENANT, projectNo: 'Abc', sheetId: 'synthetic-first', objectId: 'synthetic-first-object' })
  await store.create({ tenantId: TENANT, projectNo: 'abc', sheetId: 'synthetic-second', objectId: 'synthetic-second-object' })
  db.calls.length = 0
  let healed = 0
  let resolved = 0
  await expectStoreError(store.withActiveRowLocked({ tenantId: TENANT, projectNo: 'Abc', resolveSourceProjectComparison: async () => {
    resolved += 1
    assert.deepEqual(db.calls.slice(0, 3).map((call) => call[0]), ['transaction', 'trx.setTransactionIsolationLevel', 'trx.tryAdvisoryXactLock'])
    return 'case-insensitive'
  } }, async () => { healed += 1 }), 409, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
  assert.equal(resolved, 1)
  assert.equal(healed, 0)
  assert.equal(db.rows.length, 2, 'legacy direct create retains its original exact-key behavior')
})

test('P2-S07 busy or unavailable nonblocking lock protocols refuse create and replay before resolver or host work', async () => {
  const cases = [
    ...[false, undefined, null, 1, 'true'].map((acquired) => ({
      alter: (trx) => ({ ...trx, async tryAdvisoryXactLock() { return acquired } }),
      status: 409, code: 'STOCK_PREPARATION_PROJECT_TARGET_BUSY',
    })),
    { alter: (trx) => ({ ...trx, tryAdvisoryXactLock: undefined }), status: 503, code: 'STOCK_PREPARATION_PROJECT_TARGET_LOCK_UNAVAILABLE' },
    { alter: (trx) => ({ ...trx, setTransactionIsolationLevel: undefined }), status: 503, code: 'STOCK_PREPARATION_PROJECT_TARGET_LOCK_UNAVAILABLE' },
  ]
  for (const operation of ['create', 'replay']) {
    for (const entry of cases) {
      const db = makeMemoryDb()
      const store = makeStore(db)
      if (operation === 'replay') await store.create({ tenantId: TENANT, projectNo: 'Abc', sheetId: 'synthetic-first', objectId: 'synthetic-object' })
      db.calls.length = 0
      const transaction = db.transaction
      db.transaction = (fn) => transaction((trx) => fn(entry.alter(trx)))
      let resolved = 0
      let hostCalls = 0
      const input = { tenantId: TENANT, projectNo: 'Abc', resolveSourceProjectComparison: async () => { resolved += 1; return 'case-insensitive' } }
      const callback = async () => { hostCalls += 1; return { sheetId: 'synthetic-prepared', objectId: 'synthetic-prepared-object' } }
      await expectStoreError(operation === 'create' ? store.create(input, callback) : store.withActiveRowLocked(input, callback), entry.status, entry.code)
      assert.equal(resolved, 0, `${operation}: no effective-plan connection borrowed while busy or protocol unavailable`)
      assert.equal(hostCalls, 0, `${operation}: no provision, pack or grant work`)
      assert.ok(!db.calls.some((call) => call[0] === 'trx.advisoryXactLock'), 'opt-in path never queues a blocking advisory lock')
      assert.equal(db.rows.length, operation === 'replay' ? 1 : 0)
    }
  }
})

test('P2-S08 a busy contender frees a finite pool connection so the lock holder can resolve its plan', async () => {
  // A deterministic two-connection model: holder needs another connection in its resolver;
  // contender occupies the second transaction connection. A blocking advisory wait would
  // deadlock them. This checks local scheduling only, not physical PostgreSQL isolation.
  const db = makeMemoryDb()
  const store = makeStore(db)
  const transaction = db.transaction
  const poolWaiters = []
  const lockWaiters = []
  let inUse = 0
  let transactionCount = 0
  let held = false
  let aborted = false
  let signalHolder
  let signalContender
  const holderReady = new Promise((resolve) => { signalHolder = resolve })
  const contenderEntered = new Promise((resolve) => { signalContender = resolve })
  const withConnection = async (fn) => {
    if (inUse >= 2 && !aborted) await new Promise((resolve) => poolWaiters.push(resolve))
    inUse += 1
    try { return await fn() } finally {
      inUse -= 1
      const release = poolWaiters.shift()
      if (release) release()
    }
  }
  db.transaction = (fn) => withConnection(async () => {
    const index = ++transactionCount
    if (index === 2) signalContender()
    let ownsLock = false
    try {
      return await transaction((trx) => fn({
        ...trx,
        async tryAdvisoryXactLock(key) {
          db.calls.push(['trx.tryAdvisoryXactLock', key])
          if (held) return false
          held = true; ownsLock = true; return true
        },
        async advisoryXactLock(key) {
          db.calls.push(['trx.advisoryXactLock', key])
          if (held && !aborted) await new Promise((resolve) => lockWaiters.push(resolve))
          held = true; ownsLock = true
        },
      }))
    } finally {
      if (ownsLock) {
        held = false
        const release = lockWaiters.shift()
        if (release) release()
      }
    }
  })
  let borrowed = 0
  let holderPrepared = 0
  let contenderResolved = 0
  let contenderPrepared = 0
  const holder = store.create({ tenantId: TENANT, projectNo: 'Abc', resolveSourceProjectComparison: async () => {
    signalHolder()
    await contenderEntered
    await withConnection(async () => { borrowed += 1 })
    return 'case-insensitive'
  } }, async () => {
    holderPrepared += 1
    return { sheetId: 'synthetic-holder', objectId: 'synthetic-holder-object' }
  })
  await holderReady
  const contender = store.create({ tenantId: TENANT, projectNo: 'abc', resolveSourceProjectComparison: async () => {
    contenderResolved += 1; return 'case-insensitive'
  } }, async () => {
    contenderPrepared += 1
    return { sheetId: 'synthetic-contender', objectId: 'synthetic-contender-object' }
  })
  let timer
  try {
    const outcomes = await Promise.race([
      Promise.allSettled([holder, contender]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('finite pool progress stalled behind a blocking tenant lock')), 500) }),
    ])
    assert.equal(outcomes[0].status, 'fulfilled')
    assert.equal(outcomes[1].status, 'rejected')
    assert.equal(outcomes[1].reason.status, 409)
    assert.equal(outcomes[1].reason.code, 'STOCK_PREPARATION_PROJECT_TARGET_BUSY')
    assert.equal(borrowed, 1, 'holder acquired the connection released by the busy contender')
    assert.equal(holderPrepared, 1)
    assert.equal(contenderResolved, 0)
    assert.equal(contenderPrepared, 0)
    assert.equal(db.rows.length, 1)
    assert.ok(!db.calls.some((call) => call[0] === 'trx.advisoryXactLock'))
  } finally {
    clearTimeout(timer)
    aborted = true
    for (const release of [...poolWaiters.splice(0), ...lockWaiters.splice(0)]) release()
    await Promise.allSettled([holder, contender])
  }
})

test('P2-S09 a direct-handle create WITH a resolver (the default / case-sensitive route leg) pins READ COMMITTED, takes the BLOCKING lock and re-resolves before the insert', async () => {
  for (const [mode, expectConflict] of [['case-insensitive', true], ['case-sensitive', false], [undefined, false]]) {
    const db = makeMemoryDb()
    const store = makeStore(db)
    await store.create({ tenantId: TENANT, projectNo: 'Abc', sheetId: 'synthetic-first', objectId: 'synthetic-first-object' })
    db.calls.length = 0
    let resolved = 0
    const attempt = store.create({
      tenantId: TENANT, projectNo: 'abc', sheetId: 'synthetic-variant', objectId: 'synthetic-variant-object', maxPerTenant: 200,
      resolveSourceProjectComparison: async () => {
        resolved += 1
        assert.deepEqual(db.calls.slice(0, 3), [
          ['transaction'], ['trx.setTransactionIsolationLevel', 'read committed'],
          ['trx.advisoryXactLock', `${PROJECT_TARGET_CREATE_LOCK_PREFIX}${TENANT}`],
        ], 'pinned READ COMMITTED, then the BLOCKING tenant lock, before the comparison is re-resolved')
        return mode
      },
    })
    if (expectConflict) {
      await expectStoreError(attempt, 409, 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT')
      assert.equal(db.rows.length, 1)
      assert.ok(!db.calls.some((call) => call[0] === 'trx.insertOne'))
    } else {
      const created = await attempt
      assert.equal(created.projectNo, 'abc', `${mode}: the variant registers`)
      assert.equal(db.rows.length, 2)
    }
    assert.equal(resolved, 1)
    assert.ok(!db.calls.some((call) => call[0] === 'trx.tryAdvisoryXactLock'), `${mode}: never the non-blocking lock (no BUSY)`)
  }
  // Without a resolver the old contract is unchanged: the blocking lock is the first statement, no pin.
  const db = makeMemoryDb()
  const store = makeStore(db)
  await store.create({ tenantId: TENANT, projectNo: 'Abc', sheetId: 'synthetic-plain', objectId: 'synthetic-plain-object' })
  assert.deepEqual(db.calls.slice(0, 2), [['transaction'], ['trx.advisoryXactLock', `${PROJECT_TARGET_CREATE_LOCK_PREFIX}${TENANT}`]])
})

test('P2-S10 the activation helper locks the tenant registry, then counts case-folded groups (archived included, other tenants excluded)', async () => {
  const seed = (db, entries) => {
    for (const [projectNo, status = 'active', tenantId = TENANT] of entries) {
      db.rows.push({ id: `seed-${tenantId}-${projectNo}-${status}`, tenant_id: tenantId, project_no: projectNo,
        sheet_id: `sheet-${tenantId}-${projectNo}-${status}`, object_id: `object-${tenantId}-${projectNo}-${status}`, status })
    }
  }
  for (const [entries, expected] of [
    [[], 0],
    [[['Abc'], ['Other']], 0],
    [[['Abc'], ['abc', 'archived']], 1],
    [[['Abc'], ['abc'], ['ABC', 'archived']], 1],
    [[['Abc'], ['abc'], ['Xy'], ['XY']], 2],
    [[['Abc'], ['abc', 'active', OTHER_TENANT]], 0],
    [[['10'], ['0010']], 0],
  ]) {
    const db = makeMemoryDb()
    seed(db, entries)
    const groups = await db.transaction((trx) => lockRegistryAndCountCaseFoldedProjectGroups(trx, TENANT))
    assert.equal(groups, expected, JSON.stringify(entries))
    assert.deepEqual(db.calls.slice(0, 3).map((call) => call[0]), ['transaction', 'trx.advisoryXactLock', 'trx.countRows'],
      'the registry lock, then the scan, on the transaction handle')
    assert.equal(db.calls[1][1], `${PROJECT_TARGET_CREATE_LOCK_PREFIX}${TENANT}`, 'the SAME key every registration takes')
  }
  for (const [label, alter] of [
    ['no lock capability', (trx) => ({ ...trx, advisoryXactLock: undefined })],
    ['malformed row', (trx) => ({ ...trx, async select() { return [{ tenant_id: TENANT, project_no: 7, sheet_id: 's', object_id: 'o', status: 'active' }] }, async countRows() { return 1 } })],
    ['throwing count', (trx) => ({ ...trx, async countRows() { throw new Error('synthetic-private-registry') } })],
  ]) {
    const db = makeMemoryDb()
    const error = await expectStoreError(db.transaction((trx) => lockRegistryAndCountCaseFoldedProjectGroups(alter(trx), TENANT)), 503, 'STOCK_PREPARATION_PROJECT_IDENTITY_UNAVAILABLE')
    assert.doesNotMatch(error.message, /synthetic-private/, label)
  }
})

// F2: the three registry paths that run the identity guard with a resolver. 'create-try' is the deferred (strict)
// create, 'create-pinned' the direct-handle create of the default / case-sensitive leg, 'replay-try' the replay's
// locked re-check. `f2Attempt` drives one of them for 'Abc'.
const F2_LEGS = ['create-try', 'create-pinned', 'replay-try']
async function f2Attempt(store, leg, resolveSourceProjectComparison) {
  const input = { tenantId: TENANT, projectNo: 'Abc', resolveSourceProjectComparison }
  if (leg === 'create-try') return store.create(input, async () => ({ sheetId: 'synthetic-prepared', objectId: 'synthetic-prepared-object' }))
  if (leg === 'create-pinned') return store.create({ ...input, sheetId: 'synthetic-direct', objectId: 'synthetic-direct-object' })
  return store.withActiveRowLocked(input, async (row) => ({ healed: row.projectNo }))
}

test('P2-S11 (F2) the comparison resolver is handed exactly { executor: trx } — the transaction that holds the tenant lock — on all three paths, and its reads on it are transaction reads', async () => {
  for (const leg of F2_LEGS) {
    const db = makeMemoryDb()
    const store = makeStore(db)
    if (leg === 'replay-try') await store.create({ tenantId: TENANT, projectNo: 'Abc', sheetId: 'synthetic-first', objectId: 'synthetic-first-object' })
    db.calls.length = 0
    const handed = []
    await f2Attempt(store, leg, async (...args) => {
      handed.push(args)
      const [{ executor } = {}] = args
      await executor.select(PROJECT_TARGET_TABLE, { where: { tenant_id: TENANT } })
      await executor.selectOne(PROJECT_TARGET_TABLE, { tenant_id: TENANT, project_no: 'Abc' })
      return 'case-sensitive'
    })
    assert.equal(handed.length, 1, `${leg}: resolved once, under the lock`)
    assert.equal(handed[0].length, 1, `${leg}: one argument`)
    assert.deepEqual(Object.keys(handed[0][0]), ['executor'], `${leg}: the argument is exactly { executor }`)
    assert.equal(typeof handed[0][0].executor.advisoryXactLock, 'function', `${leg}: the executor is the transaction handle`)
    const lock = leg === 'create-pinned' ? 'trx.advisoryXactLock' : 'trx.tryAdvisoryXactLock'
    assert.deepEqual(db.calls.slice(0, 5).map((call) => call[0]), ['transaction', 'trx.setTransactionIsolationLevel', lock, 'trx.select', 'trx.selectOne'],
      `${leg}: the resolver's reads run on the transaction, right after the lock`)
    assert.ok(!db.calls.some((call) => call[0] === 'select' || call[0] === 'selectOne' || call[0] === 'countRows'), `${leg}: no autocommit read`)
  }
})

/**
 * F2: a connection-starved pool, modelled. While a registry transaction holds the tenant lock, an AUTOCOMMIT read
 * finds no free connection and fails — the host pool's connect timeout, without its 10 s wait (blocking takers of the
 * same lock each hold a pooled connection while they wait). The transaction handle has its own connection and keeps
 * reading.
 */
function starvedPoolDb() {
  const db = makeMemoryDb()
  let held = false
  const transaction = db.transaction
  db.transaction = (fn) => transaction(async (trx) => {
    try {
      return await fn({
        ...trx,
        async tryAdvisoryXactLock(key) { const acquired = await trx.tryAdvisoryXactLock(key); held = acquired === true; return acquired },
        async advisoryXactLock(key) { await trx.advisoryXactLock(key); held = true },
      })
    } finally { held = false }
  })
  for (const name of ['select', 'selectOne', 'countRows']) {
    const read = db[name]
    db[name] = async (...args) => {
      if (held) throw new Error('synthetic-private-pool-exhausted')
      return read(...args)
    }
  }
  return db
}

test('P2-S12 (F2) the pool is exhausted while the tenant lock is held: a resolver that reads through its handed executor still registers (deferred, direct-handle, replay); one that reads the pool is refused', async () => {
  for (const leg of F2_LEGS) {
    for (const reader of ['executor', 'pool']) {
      const db = starvedPoolDb()
      const store = makeStore(db)
      if (leg === 'replay-try') await store.create({ tenantId: TENANT, projectNo: 'Abc', sheetId: 'synthetic-first', objectId: 'synthetic-first-object' })
      const rowsBefore = db.rows.length
      // Reads on whatever handle it is handed, and on the pool only when handed none (the route resolver's shape).
      const attempt = f2Attempt(store, leg, async ({ executor } = {}) => {
        await (reader === 'executor' ? (executor || db) : db).select(PROJECT_TARGET_TABLE, { where: { tenant_id: TENANT } })
        return 'case-sensitive'
      })
      if (reader === 'executor') {
        const out = await attempt
        if (leg === 'replay-try') assert.deepEqual(out, { healed: 'Abc' }, `${leg}: the heal ran`)
        else assert.equal(out.projectNo, 'Abc', `${leg}: registered`)
        assert.equal(db.rows.length, leg === 'replay-try' ? rowsBefore : rowsBefore + 1, `${leg}: the registration completed`)
      } else {
        // Control: the starvation is live — a read on the pool while the lock is held fails and nothing lands.
        await assert.rejects(attempt, /synthetic-private-pool-exhausted/, `${leg}: a pool read under the lock is starved`)
        assert.equal(db.rows.length, rowsBefore, `${leg}: nothing registered`)
      }
    }
  }
})

test('S-06 migration 087: two unique indexes, the CHECKs, the integration_ prefix, no value column, no DROP', () => {
  const migrationPath = path.join(__dirname, '..', '..', '..', 'packages', 'core-backend', 'migrations', '087_create_integration_stock_prep_project_target.sql')
  const raw = fs.readFileSync(migrationPath, 'utf8')
  const sql = raw.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
  assert.ok(PROJECT_TARGET_TABLE.startsWith('integration_'))
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${PROJECT_TARGET_TABLE} \\(`))
  assert.match(sql, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${SCOPE_CONSTRAINT}\\s+ON ${PROJECT_TARGET_TABLE} \\(tenant_id, project_no\\)`))
  assert.match(sql, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${SHEET_CONSTRAINT}\\s+ON ${PROJECT_TARGET_TABLE} \\(sheet_id\\)`))
  assert.match(sql, /CHECK \(status IN \('active', 'archived'\)\)/)
  assert.match(sql, /CHECK \(\(status = 'archived'\) = \(archived_at IS NOT NULL\)\)/)
  assert.match(sql, /last_pull_outcome IN \('applied', 'previewed', 'refused'\)/)
  assert.match(sql, /tenant_id\s+TEXT NOT NULL/)
  assert.match(sql, /project_no\s+TEXT NOT NULL/)
  assert.match(sql, /sheet_id\s+TEXT NOT NULL/)
  assert.match(sql, /object_id\s+TEXT NOT NULL/)
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i)
  assert.doesNotMatch(sql, /\borigin\b/, 'no origin column — the old mixed sheet is never registered (Q3)')
  assert.doesNotMatch(sql, /workspace_id/, 'no workspace dimension (084 reasoning)')
  for (const forbidden of ['drawing', 'quantity', 'qty', 'unit_symbol', 'material', 'credential', 'token', 'password', 'host', 'base_url']) {
    assert.ok(!sql.includes(forbidden), `087 must not declare a ${forbidden} column`)
  }
})

// S3 follow-ups 2 (item 5): the fail-closed runner (support/fail-closed-suite-runner.cjs) — the same per-test loop
// and output lines, plus the exit sentinel and the per-test timeout: a hung test can never end this suite with exit 0.
require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-project-target-store.test.cjs', tests, { passLine: '✓ stock-preparation-project-target-store' })
