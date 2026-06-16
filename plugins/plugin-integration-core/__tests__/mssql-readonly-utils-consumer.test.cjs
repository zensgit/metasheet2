'use strict'

const assert = require('node:assert/strict')
const {
  buildSimpleSelectQuery,
  normalizeLimit,
  normalizeTimeout,
} = require('@metasheet/mssql-readonly-utils')

const inputs = []
const request = {
  input(name, value) {
    inputs.push([name, value])
    return request
  },
}

const sql = buildSimpleSelectQuery({
  request,
  table: 'dbo.t_ICItem',
  columns: ['FItemID', 'FNumber'],
  limit: 10001,
  limitPolicy: { defaultLimit: 1000, maxLimit: 10000, overMax: 'clamp' },
  filters: { FNumber: 'MAT-001' },
  orderBy: 'FNumber',
})

assert.equal(
  sql,
  'SELECT TOP 10000 [FItemID], [FNumber] FROM [dbo].[t_ICItem] WHERE [FNumber] = @filter_0 ORDER BY [FNumber]',
)
assert.deepEqual(inputs, [['filter_0', 'MAT-001']])
assert.equal(normalizeLimit(undefined, { defaultLimit: 1000, maxLimit: 10000, overMax: 'clamp' }), 1000)
assert.throws(
  () => normalizeTimeout(0, { field: 'k3-timeout', allowZero: false }),
  /k3-timeout must be a valid timeout/,
)

console.log('[plugin-integration-core] mssql-readonly-utils CJS consumer smoke passed')
