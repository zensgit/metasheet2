'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const scriptPath = path.join(__dirname, '..', 'scripts', 'smoke-k3-sqlserver-executor.cjs')
const {
  buildSystem,
  formatPublicSmokeError,
  parseColumns,
  runSmoke,
} = require(scriptPath)

const SQL_ENV_KEYS = [
  'K3_MSSQL_SERVER',
  'K3_MSSQL_HOST',
  'K3_MSSQL_PORT',
  'K3_MSSQL_DATABASE',
  'K3_MSSQL_USERNAME',
  'K3_MSSQL_PASSWORD',
  'K3_MSSQL_TABLE',
  'K3_MSSQL_COLUMNS',
  'K3_MSSQL_LIMIT',
  'K3_MSSQL_ORDER_BY',
  'K3_MSSQL_ENCRYPT',
  'K3_MSSQL_TRUST_SERVER_CERTIFICATE',
  'K3_MSSQL_LEGACY_TLS',
  'K3_MSSQL_TLS_MIN_VERSION',
  'K3_MSSQL_TLS_CIPHERS',
  'K3_MSSQL_CONNECTION_TIMEOUT_MS',
  'K3_MSSQL_REQUEST_TIMEOUT_MS',
  'MSSQL_SERVER',
  'MSSQL_HOST',
  'MSSQL_PORT',
  'MSSQL_DATABASE',
  'MSSQL_USERNAME',
  'MSSQL_PASSWORD',
  'MSSQL_ENCRYPT',
  'MSSQL_TRUST_SERVER_CERTIFICATE',
  'MSSQL_LEGACY_TLS',
  'MSSQL_TLS_MIN_VERSION',
  'MSSQL_TLS_CIPHERS',
  'MSSQL_CONNECTION_TIMEOUT_MS',
  'MSSQL_REQUEST_TIMEOUT_MS',
]

function envWithoutSql() {
  const next = { ...process.env }
  for (const key of SQL_ENV_KEYS) delete next[key]
  return next
}

async function withEnv(values, fn) {
  const previous = {}
  for (const key of SQL_ENV_KEYS) {
    previous[key] = process.env[key]
    delete process.env[key]
  }
  Object.assign(process.env, values)
  try {
    return await fn()
  } finally {
    for (const key of SQL_ENV_KEYS) {
      delete process.env[key]
      if (previous[key] !== undefined) process.env[key] = previous[key]
    }
  }
}

function testNoEnvSkips() {
  const result = spawnSync(process.execPath, [scriptPath], {
    env: envWithoutSql(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /K3 SQL Server smoke skipped/)
}

function testBuildSystem() {
  return withEnv({
    K3_MSSQL_SERVER: 'sql.local,1433',
    K3_MSSQL_DATABASE: 'AIS_TEST',
    K3_MSSQL_USERNAME: 'readonly_user',
    K3_MSSQL_PASSWORD: 'secret-password',
    K3_MSSQL_TABLE: 'dbo.t_ICItem',
    K3_MSSQL_COLUMNS: 'FItemID, FNumber',
    K3_MSSQL_ORDER_BY: 'FNumber',
    K3_MSSQL_LIMIT: '2',
    K3_MSSQL_LEGACY_TLS: 'true',
  }, async () => {
    assert.deepEqual(parseColumns('A, B,,C'), ['A', 'B', 'C'])
    const smoke = buildSystem()
    assert.equal(smoke.table, 'dbo.t_ICItem')
    assert.deepEqual(smoke.columns, ['FItemID', 'FNumber'])
    assert.equal(smoke.limit, 2)
    assert.equal(smoke.system.credentials.password, 'secret-password')
    assert.equal(smoke.system.config.legacyTls, 'true')
  })
}

function testPublicErrorFormattingIsValuesFree() {
  const raw = new Error('login failed for user readonly_user password=secret-password server=sql.local')
  assert.equal(formatPublicSmokeError(raw), 'K3_SQLSERVER_SMOKE_FAILED')
  raw.code = 'EREQUEST'
  assert.equal(formatPublicSmokeError(raw), 'EREQUEST')

  const config = new Error('K3_MSSQL_TABLE is required when K3 SQL Server smoke is opted in')
  config.code = 'K3_SQLSERVER_SMOKE_CONFIG_INVALID'
  assert.equal(
    formatPublicSmokeError(config),
    'K3_SQLSERVER_SMOKE_CONFIG_INVALID: K3_MSSQL_TABLE is required when K3 SQL Server smoke is opted in',
  )
}

async function testRunSmokeUsesChannelAndKeepsEvidenceValuesFree() {
  await withEnv({
    K3_MSSQL_SERVER: 'sql.local,1433',
    K3_MSSQL_DATABASE: 'AIS_TEST',
    K3_MSSQL_USERNAME: 'readonly_user',
    K3_MSSQL_PASSWORD: 'secret-password',
    K3_MSSQL_TABLE: 'dbo.t_ICItem',
    K3_MSSQL_COLUMNS: 'FItemID,FNumber',
    K3_MSSQL_ORDER_BY: 'FNumber',
    K3_MSSQL_LIMIT: '2',
    K3_MSSQL_TLS_MIN_VERSION: 'TLSv1',
    K3_MSSQL_TLS_CIPHERS: 'DEFAULT@SECLEVEL=0',
  }, async () => {
    const calls = []
    const logs = []
    await runSmoke({
      log(...args) {
        logs.push(args)
      },
      executorFactory() {
        return {
          async testConnection({ system }) {
            calls.push(['testConnection', system.kind, system.config.table, system.credentials.password])
            return { ok: true, code: 'SQLSERVER_CONNECTED' }
          },
          async select(input) {
            calls.push(['select', input.table, input.columns, input.limit, input.orderBy])
            return {
              records: [
                { FItemID: 1, FNumber: 'MAT-001' },
                { FItemID: 2, FNumber: 'MAT-002' },
              ],
              done: true,
              nextCursor: null,
            }
          },
        }
      },
    })

    assert.deepEqual(calls[0], ['testConnection', 'erp:k3-wise-sqlserver', undefined, 'secret-password'])
    assert.deepEqual(calls[1], ['select', 'dbo.t_ICItem', ['FItemID', 'FNumber'], 2, 'FNumber'])
    const evidence = JSON.stringify(logs)
    assert.equal(evidence.includes('secret-password'), false, 'smoke evidence must not contain credentials')
    assert.equal(evidence.includes('MAT-001'), false, 'smoke evidence must not contain row values')
    assert.equal(evidence.includes('SELECT'), false, 'smoke evidence must not contain raw SQL')
    assert.equal(evidence.includes('DEFAULT@SECLEVEL=0'), false, 'smoke evidence must not contain raw cipher strings')
    assert.ok(evidence.includes('TLSv1'), 'TLS posture minVersion is values-free smoke evidence')
    assert.ok(evidence.includes('rows'), 'smoke evidence reports counts')
  })
}

async function main() {
  testNoEnvSkips()
  await testBuildSystem()
  testPublicErrorFormattingIsValuesFree()
  await testRunSmokeUsesChannelAndKeepsEvidenceValuesFree()
  console.log('k3-sqlserver-smoke-script.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
