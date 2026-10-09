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

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  PROJECT_TARGET_TABLE,
  SCOPE_CONSTRAINT,
  SHEET_CONSTRAINT,
  StockPreparationProjectTargetStoreError,
  createStockPreparationProjectTargetStore,
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
  return {
    rows,
    calls,
    async selectOne(table, where) {
      calls.push(['selectOne', table])
      assert.equal(table, PROJECT_TARGET_TABLE)
      return rows.find((row) => matches(row, where)) || null
    },
    async select(table, { where } = {}) {
      calls.push(['select', table])
      assert.equal(table, PROJECT_TARGET_TABLE)
      return rows.filter((row) => matches(row, where || {}))
    },
    async insertOne(table, row) {
      calls.push(['insertOne', table])
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
    async countRows(table, where) {
      calls.push(['countRows', table])
      assert.equal(table, PROJECT_TARGET_TABLE)
      return rows.filter((row) => matches(row, where || {})).length
    },
  }
}

function makeStore(db) {
  let n = 0
  return createStockPreparationProjectTargetStore({ db, idGenerator: () => `pt-${(n += 1)}` })
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
    'lastPullOutcome', 'objectId', 'projectNo', 'restoredAt', 'rowCount', 'sheetId', 'status', 'tenantId', 'updatedAt',
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

;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log(`  ${name} OK`)
    } catch (error) {
      failed += 1
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    }
  }
  if (failed) {
    console.error(`stock-preparation-project-target-store.test.cjs FAILED (${failed})`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-project-target-store')
})()
