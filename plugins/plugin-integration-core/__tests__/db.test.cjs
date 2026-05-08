'use strict'

// ---------------------------------------------------------------------------
// db.cjs — committed tests for the strict CRUD builder
//
// Verifies:
//   1. Identifier whitelist — isAllowedTable, IDENT_RE
//   2. assertTable / assertColumn throw ScopeViolationError for bad input
//   3. Table prefix boundary: non-`integration_*` tables rejected
//   4. Quoted-identifier bypass (the regression the review flagged) is
//      no longer possible because the API accepts only raw identifiers
//      — there is no path to inject quotes.
//   5. select/insertOne/insertMany/updateRow/deleteRows/countRows build
//      parameterized SQL with whitelisted identifiers and never concatenate
//      user values into the statement.
//   6. updateRow / deleteRows refuse empty where clauses (no unbounded ops).
//   7. transaction() exposes the same scoped surface, no rawQuery.
//   8. No rawQuery export at all.
//
// Run: node __tests__/db.test.cjs
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')
const { createDb, ScopeViolationError, ALLOWED_PREFIX, __internals } = require(
  path.join(__dirname, '..', 'lib', 'db.cjs'),
)

// Host-contract mock: query() returns an array (Record<string,unknown>[])
// directly, matching packages/core-backend/src/types/plugin.ts:685 and the
// concrete runtime at packages/core-backend/src/index.ts:324
// (`return (await pool.query(...)).rows`).
function mockDatabase({ nextRows } = {}) {
  const calls = []
  const rowsQueue = Array.isArray(nextRows) ? nextRows.slice() : []
  function takeRows() {
    return rowsQueue.length > 0 ? rowsQueue.shift() : []
  }
  const db = {
    calls,
    async query(sql, params) {
      calls.push({ sql, params: params ? params.slice() : undefined })
      return takeRows()
    },
    async transaction(cb) {
      return cb({
        async query(sql, params) {
          calls.push({ sql, params: params ? params.slice() : undefined, tx: true })
          return takeRows()
        },
        async commit() { calls.push({ commit: true }) },
        async rollback() { calls.push({ rollback: true }) },
      })
    },
  }
  return db
}

async function main() {
  // --- 1-3. Identifier whitelist & table prefix ------------------------
  assert.equal(ALLOWED_PREFIX, 'integration_')
  assert.equal(__internals.isAllowedTable('integration_pipelines'), true)
  assert.equal(__internals.isAllowedTable('integration_'), false)
  assert.equal(__internals.isAllowedTable('multitable_records'), false)
  assert.equal(__internals.isAllowedTable('integration_; DROP TABLE users; --'), false)
  assert.equal(__internals.isAllowedTable('integration_pipelines_1'), true)

  // assertTable
  let e1 = null
  try { __internals.assertTable('users') } catch (e) { e1 = e }
  assert.ok(e1 instanceof ScopeViolationError)

  // assertColumn: reject anything not matching IDENT_RE
  for (const bad of ['', '1col', 'col-name', 'col name', 'col"', 'col;', 'col--', null, undefined]) {
    let err = null
    try { __internals.assertColumn(bad) } catch (e) { err = e }
    assert.ok(err instanceof ScopeViolationError, `assertColumn rejects ${JSON.stringify(bad)}`)
  }
  assert.equal(__internals.assertColumn('valid_col_1'), 'valid_col_1')

  // --- 4. There is no path to raw SQL / quoted identifiers ------------
  // The exported surface exposes these methods only:
  const db = createDb({ database: mockDatabase() })
  const publicKeys = Object.keys(db).sort()
  const expected = [
    'ALLOWED_PREFIX', 'countRows', 'deleteRows', 'insertMany', 'insertOne',
    'select', 'selectOne', 'transaction', 'updateRow',
  ]
  assert.deepEqual(publicKeys, expected, 'no rawQuery / execute / any raw SQL hook')

  // --- 5. select builds parameterized SQL ------------------------------
  const mockDb5 = mockDatabase()
  const db5 = createDb({ database: mockDb5 })
  await db5.select('integration_pipelines', { where: { status: 'active', tenant_id: 't1' }, orderBy: 'created_at', limit: 50, offset: 10 })
  assert.equal(mockDb5.calls.length, 1)
  const q5 = mockDb5.calls[0]
  assert.match(q5.sql, /^SELECT \* FROM "integration_pipelines"/)
  assert.match(q5.sql, / WHERE "status" = \$1 AND "tenant_id" = \$2/)
  assert.match(q5.sql, / ORDER BY "created_at" ASC/)
  assert.match(q5.sql, / LIMIT 50 OFFSET 10/)
  assert.deepEqual(q5.params, ['active', 't1'])

  // select with no WHERE
  await db5.select('integration_runs', { limit: 1 })
  const q5b = mockDb5.calls[1]
  assert.match(q5b.sql, /^SELECT \* FROM "integration_runs" LIMIT 1 OFFSET 0$/)
  assert.deepEqual(q5b.params, [])

  for (const invalidWhere of ['status=active', ['status'], 42]) {
    let whereErr = null
    try {
      await db5.select('integration_pipelines', { where: invalidWhere })
    } catch (error) {
      whereErr = error
    }
    assert.ok(whereErr instanceof ScopeViolationError,
      `select rejects invalid where shape ${JSON.stringify(invalidWhere)}`)
  }

  // select rejects forbidden table
  let selErr = null
  try { await db5.select('users') } catch (e) { selErr = e }
  assert.ok(selErr instanceof ScopeViolationError)

  // insertOne
  const mockDb6 = mockDatabase()
  const db6 = createDb({ database: mockDb6 })
  await db6.insertOne('integration_pipelines', { id: 'p1', name: 'X', status: 'draft' })
  const q6 = mockDb6.calls[0]
  assert.match(q6.sql, /^INSERT INTO "integration_pipelines" \("id", "name", "status"\) VALUES \(\$1, \$2, \$3\) RETURNING \*$/)
  assert.deepEqual(q6.params, ['p1', 'X', 'draft'])

  // insertMany with consistent keys
  const mockDb7 = mockDatabase()
  const db7 = createDb({ database: mockDb7 })
  await db7.insertMany('integration_runs', [
    { id: 'r1', pipeline_id: 'p1', status: 'running' },
    { id: 'r2', pipeline_id: 'p1', status: 'succeeded' },
  ])
  const q7 = mockDb7.calls[0]
  assert.match(q7.sql, /^INSERT INTO "integration_runs" \("id", "pipeline_id", "status"\) VALUES \(\$1, \$2, \$3\), \(\$4, \$5, \$6\) RETURNING \*$/)
  assert.deepEqual(q7.params, ['r1', 'p1', 'running', 'r2', 'p1', 'succeeded'])

  const emptyInsert = await db7.insertMany('integration_runs', [])
  assert.deepEqual(emptyInsert, [], 'insertMany empty batch keeps host array-return shape')

  // insertMany with inconsistent keys → throws
  let imErr = null
  try {
    await db7.insertMany('integration_runs', [
      { id: 'r3', pipeline_id: 'p1' },
      { id: 'r4', pipeline_id: 'p1', status: 'failed' },
    ])
  } catch (e) { imErr = e }
  assert.ok(imErr && /inconsistent keys/.test(imErr.message))

  // updateRow
  const mockDb8 = mockDatabase()
  const db8 = createDb({ database: mockDb8 })
  await db8.updateRow('integration_dead_letters', { status: 'replayed', retry_count: 1 }, { id: 'dl1' })
  const q8 = mockDb8.calls[0]
  assert.match(q8.sql, /^UPDATE "integration_dead_letters" SET "status" = \$1, "retry_count" = \$2 WHERE "id" = \$3 RETURNING \*$/)
  assert.deepEqual(q8.params, ['replayed', 1, 'dl1'])

  // --- 6. updateRow / deleteRows refuse empty where --------------------
  let upErr = null
  try { await db8.updateRow('integration_pipelines', { status: 'paused' }, {}) } catch (e) { upErr = e }
  assert.ok(upErr && /non-empty/.test(upErr.message), 'updateRow refuses empty where')

  let delErr = null
  try { await db8.deleteRows('integration_pipelines', {}) } catch (e) { delErr = e }
  assert.ok(delErr && /non-empty/.test(delErr.message), 'deleteRows refuses empty where')

  // deleteRows with where
  await db8.deleteRows('integration_dead_letters', { status: 'discarded' })
  const q8b = mockDb8.calls[1]
  assert.match(q8b.sql, /^DELETE FROM "integration_dead_letters" WHERE "status" = \$1 RETURNING \*$/)
  assert.deepEqual(q8b.params, ['discarded'])

  // countRows
  await db8.countRows('integration_runs', { pipeline_id: 'p1' })
  const q8c = mockDb8.calls[2]
  assert.match(q8c.sql, /^SELECT COUNT\(\*\)::int AS count FROM "integration_runs" WHERE "pipeline_id" = \$1$/)

  // --- 6b. Return-shape contract: host returns array directly ----------
  // Regression: PR #0 v1 assumed { rows: [...] } wrapper; real runtime
  // (types/plugin.ts:685, src/index.ts:324) returns Record<string,unknown>[]
  // directly, which made selectOne/countRows silently return null/0.
  const mockDb6b_one = mockDatabase({ nextRows: [
    [{ id: 'p1', name: 'x', status: 'draft' }],  // selectOne → select() uses limit:1
  ] })
  const db6b_one = createDb({ database: mockDb6b_one })
  const row = await db6b_one.selectOne('integration_pipelines', { id: 'p1' })
  assert.ok(row && row.id === 'p1', 'selectOne unwraps array-return shape')

  const mockDb6b_count = mockDatabase({ nextRows: [
    [{ count: 42 }],
  ] })
  const db6b_count = createDb({ database: mockDb6b_count })
  const n = await db6b_count.countRows('integration_runs', { pipeline_id: 'p1' })
  assert.equal(n, 42, 'countRows unwraps array-return shape')

  // And when host returns empty array, these degrade gracefully
  const mockDb6b_empty = mockDatabase({ nextRows: [[], []] })
  const db6b_empty = createDb({ database: mockDb6b_empty })
  assert.equal(await db6b_empty.selectOne('integration_pipelines', { id: 'x' }), null, 'selectOne empty → null')
  assert.equal(await db6b_empty.countRows('integration_runs', { pipeline_id: 'x' }), 0, 'countRows empty → 0')

  // Defence: if a custom binding returns { rows: [...] }, we still work.
  const legacyShapeDb = {
    async query() { return { rows: [{ id: 'legacy' }] } },
    async transaction() { throw new Error('not used') },
  }
  const dbLegacy = createDb({ database: legacyShapeDb })
  const legacyRow = await dbLegacy.selectOne('integration_pipelines', { id: 'legacy' })
  assert.ok(legacyRow && legacyRow.id === 'legacy', 'defensive: {rows:[]} shape still works')

  // --- 7. transaction() exposes scoped surface, no rawQuery -----------
  const mockDb9 = mockDatabase()
  const db9 = createDb({ database: mockDb9 })
  await db9.transaction(async (trx) => {
    const trxKeys = Object.keys(trx).sort()
    assert.deepEqual(
      trxKeys,
      ['commit', 'countRows', 'deleteRows', 'insertMany', 'insertOne', 'rollback', 'select', 'selectOne', 'updateRow'],
      'transaction exposes scoped surface only, no rawQuery',
    )
    await trx.insertOne('integration_runs', { id: 'rtx', status: 'running' })
  })
  assert.ok(mockDb9.calls.some((c) => c.tx && /INSERT INTO "integration_runs"/.test(c.sql)))

  // --- 8. No rawQuery export ------------------------------------------
  assert.equal(typeof db.rawQuery, 'undefined', 'db has no rawQuery')

  // --- 9. Injection attempt through values is harmless (parameterized) ---
  const mockDb10 = mockDatabase()
  const db10 = createDb({ database: mockDb10 })
  await db10.insertOne('integration_pipelines', {
    id: 'p_inj',
    name: "'; DROP TABLE users; --",  // value, not identifier — safe
  })
  const q10 = mockDb10.calls[0]
  // SQL must NOT contain the injection payload; it must be in params.
  assert.doesNotMatch(q10.sql, /DROP/, 'injection payload not in SQL')
  assert.ok(q10.params.includes("'; DROP TABLE users; --"), 'injection payload parameterized')

  // --- 10. Injection attempt through identifier is rejected -----------
  let idErr = null
  try {
    await db10.insertOne('integration_pipelines', { ['name"; DROP TABLE users; --']: 'x' })
  } catch (e) { idErr = e }
  assert.ok(idErr instanceof ScopeViolationError, 'identifier injection rejected')

  console.log('✓ db.cjs: all CRUD + boundary + injection tests passed')
}

main().catch((err) => {
  console.error('✗ db.cjs FAILED')
  console.error(err)
  process.exit(1)
})
