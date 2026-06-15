'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const helper = require('..')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const helperRuntime = path.join(__dirname, '..', 'index.cjs')

function assertThrowsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error && error.code, code)
    return true
  })
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim()
}

function listFiles(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, predicate, out)
    else if (predicate(full)) out.push(full)
  }
  return out
}

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function collectModuleSpecifiers(source) {
  const specs = []
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specs.push(match[1])
    }
  }
  return specs
}

function testExportGuard() {
  const forbidden = /(?:^|\.)(?:insert|update|delete|upsert|transaction|rawQuery|execute)(?:$|\.)/i
  for (const name of Object.keys(helper)) {
    assert.equal(forbidden.test(name), false, `helper export must stay read-only: ${name}`)
  }
}

function testNeutralRuntimeBoundary() {
  const source = read(helperRuntime)
  assert.equal(source.includes('packages/core-backend'), false, 'helper runtime must not import core-backend internals')
  assert.equal(source.includes('plugins/plugin-integration-core'), false, 'helper runtime must not import plugin internals')
  const specs = collectModuleSpecifiers(source)
  for (const spec of specs) {
    assert.equal(/(?:core-backend|plugin-integration-core|MSSQLAdapter|DataSourceManager)/.test(spec), false)
  }
}

function testRepoImportBoundaries() {
  const coreFiles = listFiles(path.join(repoRoot, 'packages', 'core-backend', 'src'), (file) => /\.(ts|js|cjs|mjs)$/.test(file))
  for (const file of coreFiles) {
    const source = read(file)
    const specs = collectModuleSpecifiers(source)
    for (const spec of specs) {
      assert.equal(
        /(?:^|\/|@metasheet\/)plugin-integration-core(?:$|\/)/.test(spec),
        false,
        `${file} must not import plugin internals`,
      )
    }
  }

  const pluginFiles = listFiles(path.join(repoRoot, 'plugins', 'plugin-integration-core'), (file) => /\.(cjs|mjs|js|ts)$/.test(file))
  for (const file of pluginFiles) {
    const source = read(file)
    const specs = collectModuleSpecifiers(source)
    for (const spec of specs) {
      assert.equal(/(?:DataSourceManager|MSSQLAdapter)/.test(spec), false, `${file} must not import host MSSQL internals`)
    }
  }
}

function testEndpointAndTls() {
  assert.deepEqual(helper.parseSqlServerEndpoint({ host: 'db', server: 'ignored,1444', port: 1433 }), {
    server: 'db',
    port: 1433,
  })
  assert.deepEqual(helper.parseSqlServerEndpoint({ server: 'db,1444' }), { server: 'db', port: 1444 })
  assert.deepEqual(helper.parseSqlServerEndpoint({ server: 'db\\inst,1444' }), { server: 'db\\inst', port: 1444 })
  assertThrowsCode(() => helper.parseSqlServerEndpoint({ server: 'db,1444', port: 1433 }), 'SQLSERVER_PORT_INVALID')
  assertThrowsCode(() => helper.parseSqlServerEndpoint({ server: 'db\\inst,1444', port: 1433 }), 'SQLSERVER_PORT_INVALID')

  assert.deepEqual(helper.buildLegacyTlsOptions({ legacyTls: true }), {
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=0',
  })
  assertThrowsCode(
    () => helper.buildLegacyTlsOptions({ legacyTls: true, encrypt: false }),
    'SQLSERVER_TLS_CONFLICT',
  )
  assertThrowsCode(
    () => helper.buildLegacyTlsOptions({ tlsMinVersion: 'SSLv3' }),
    'SQLSERVER_TLS_MIN_VERSION_INVALID',
  )
}

function testConsumerPolicies() {
  assert.equal(helper.normalizeTimeout(0, { field: 'generic', allowZero: true }), 0)
  assertThrowsCode(() => helper.normalizeTimeout(0, { field: 'k3', allowZero: false }), 'SQLSERVER_TIMEOUT_INVALID')
  assert.equal(helper.normalizeLimit(undefined, { defaultLimit: 10000, maxLimit: 10000, overMax: 'throw' }), 10000)
  assertThrowsCode(() => helper.normalizeLimit(10001, { maxLimit: 10000, overMax: 'throw' }), 'SQLSERVER_LIMIT_INVALID')
  assert.equal(helper.normalizeLimit(10001, { defaultLimit: 1000, maxLimit: 10000, overMax: 'clamp' }), 10000)
}

function testSqlServerIdentifierCompatibility() {
  assert.equal(helper.quoteSqlServerIdentifier('orders'), '[orders]')
  assert.equal(helper.quoteSqlServerIdentifier('2024_orders'), '[2024_orders]')
  assert.equal(helper.quoteSqlServerIdentifier('dbo.2024_orders'), '[dbo].[2024_orders]')
  assert.equal(helper.quoteSqlServerIdentifier('tenant.dbo.orders'), '[tenant].[dbo].[orders]')
  assertThrowsCode(() => helper.quoteSqlServerIdentifier('tenant..orders'), 'SQLSERVER_IDENTIFIER_INVALID')
  assertThrowsCode(() => helper.quoteSqlServerIdentifier('bad-name'), 'SQLSERVER_IDENTIFIER_INVALID')
}

function testGenericWhereClause() {
  const result = helper.buildGenericWhereClause({
    status: 'open',
    metadata: { source: 'fixture' },
    type: ['material', 'part'],
    $or: [
      { updated_at: { $gt: '2026-06-01T00:00:00.000Z' } },
      {
        updated_at: '2026-06-01T00:00:00.000Z',
        id: { $gt: 42 },
      },
    ],
  }, {
    quoteIdentifier: (field) => field,
    parameter: (index) => `@p${index - 1}`,
  })
  assert.equal(
    normalizeSql(result.sql),
    'WHERE status = @p0 AND metadata = @p1 AND type IN (@p2, @p3) AND ((updated_at > @p4) OR (updated_at = @p5 AND id > @p6))',
  )
  assert.deepEqual(result.params, [
    'open',
    { source: 'fixture' },
    'material',
    'part',
    '2026-06-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
    42,
  ])
  assertThrowsCode(() => helper.buildGenericWhereClause({ $or: [] }), 'SQLSERVER_WHERE_INVALID')
  assertThrowsCode(() => helper.buildGenericWhereClause({ id: { $after: 1 } }), 'SQLSERVER_WHERE_OPERATOR_UNSUPPORTED')
}

function testSimpleSelectQuery() {
  const inputs = []
  const request = {
    input(name, value) {
      inputs.push([name, value])
      return request
    },
  }
  const sql = helper.buildSimpleSelectQuery({
    request,
    table: 'dbo.t_ICItem',
    columns: ['FItemID', 'FNumber'],
    limit: 5,
    filters: { FNumber: 'MAT-001', FItemID: [1, 2] },
    watermark: { FItemID: 0 },
    orderBy: 'FNumber',
  })
  assert.equal(
    normalizeSql(sql),
    'SELECT TOP 5 [FItemID], [FNumber] FROM [dbo].[t_ICItem] WHERE [FNumber] = @filter_0 AND [FItemID] IN (@filter_1_0, @filter_1_1) AND [FItemID] > @watermark_0 ORDER BY [FNumber]',
  )
  assert.deepEqual(inputs, [
    ['filter_0', 'MAT-001'],
    ['filter_1_0', 1],
    ['filter_1_1', 2],
    ['watermark_0', 0],
  ])
  assertThrowsCode(
    () => helper.buildSimpleSelectQuery({ request, table: 'dbo.t', filters: { FNumber: { $like: 'MAT%' } } }),
    'SQLSERVER_FILTER_INVALID',
  )
}

testExportGuard()
testNeutralRuntimeBoundary()
testRepoImportBoundaries()
testEndpointAndTls()
testConsumerPolicies()
testSqlServerIdentifierCompatibility()
testGenericWhereClause()
testSimpleSelectQuery()

console.log('[mssql-readonly-utils] helper contract tests passed')
