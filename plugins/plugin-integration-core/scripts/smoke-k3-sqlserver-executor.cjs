#!/usr/bin/env node
'use strict'

const { createK3WiseSqlServerChannel } = require('../lib/adapters/k3-wise-sqlserver-channel.cjs')
const { createK3WiseSqlServerReadOnlyExecutor } = require('../lib/adapters/k3-wise-sqlserver-executor.cjs')

const env = process.env

function printHelp() {
  console.log(`Usage: pnpm --filter plugin-integration-core smoke:k3-sqlserver-executor

Opt-in real-wire smoke for the K3 WISE SQL Server channel. With no
K3_MSSQL_SERVER/K3_MSSQL_HOST/MSSQL_SERVER/MSSQL_HOST it skips cleanly (exit 0).

Required when opted in:
  K3_MSSQL_SERVER or K3_MSSQL_HOST     (falls back to MSSQL_SERVER/MSSQL_HOST)
  K3_MSSQL_DATABASE                    (falls back to MSSQL_DATABASE)
  K3_MSSQL_USERNAME                    (falls back to MSSQL_USERNAME)
  K3_MSSQL_PASSWORD                    (falls back to MSSQL_PASSWORD)
  K3_MSSQL_TABLE                       operator-approved read-only table/object

Optional:
  K3_MSSQL_PORT                        (falls back to MSSQL_PORT)
  K3_MSSQL_COLUMNS                     comma-separated column list; omitted means SELECT *
  K3_MSSQL_LIMIT                       default 1
  K3_MSSQL_ORDER_BY                    optional configured order key
  K3_MSSQL_ENCRYPT                     (falls back to MSSQL_ENCRYPT)
  K3_MSSQL_TRUST_SERVER_CERTIFICATE    (falls back to MSSQL_TRUST_SERVER_CERTIFICATE)
  K3_MSSQL_LEGACY_TLS                  (falls back to MSSQL_LEGACY_TLS)
  K3_MSSQL_TLS_MIN_VERSION             (falls back to MSSQL_TLS_MIN_VERSION)
  K3_MSSQL_TLS_CIPHERS                 (falls back to MSSQL_TLS_CIPHERS)
  K3_MSSQL_CONNECTION_TIMEOUT_MS       (falls back to MSSQL_CONNECTION_TIMEOUT_MS)
  K3_MSSQL_REQUEST_TIMEOUT_MS          (falls back to MSSQL_REQUEST_TIMEOUT_MS)

Evidence is values-free: statuses, configured table/column names, counts, and
TLS knob names only. It never prints credentials, connection strings, raw SQL, or
row values.`)
}

function firstEnv(...names) {
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function optionalEnv(...names) {
  const value = firstEnv(...names)
  return value || undefined
}

function requiredEnv(label, ...names) {
  const value = firstEnv(...names)
  if (!value) {
    throw smokeConfigError(`${label} is required when K3 SQL Server smoke is opted in`)
  }
  return value
}

function smokeConfigError(message) {
  const error = new Error(message)
  error.code = 'K3_SQLSERVER_SMOKE_CONFIG_INVALID'
  return error
}

function parseColumns(value) {
  if (!value || !value.trim()) return undefined
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseLimit(value) {
  if (!value || !value.trim()) return 1
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw smokeConfigError('K3_MSSQL_LIMIT must be a positive integer')
  }
  return numeric
}

function configured(value) {
  return value === undefined || value === '' ? false : true
}

function buildSystem() {
  const server = requiredEnv('K3_MSSQL_SERVER/K3_MSSQL_HOST', 'K3_MSSQL_SERVER', 'K3_MSSQL_HOST', 'MSSQL_SERVER', 'MSSQL_HOST')
  const database = requiredEnv('K3_MSSQL_DATABASE', 'K3_MSSQL_DATABASE', 'MSSQL_DATABASE')
  const username = requiredEnv('K3_MSSQL_USERNAME', 'K3_MSSQL_USERNAME', 'MSSQL_USERNAME')
  const password = requiredEnv('K3_MSSQL_PASSWORD', 'K3_MSSQL_PASSWORD', 'MSSQL_PASSWORD')
  const table = requiredEnv('K3_MSSQL_TABLE', 'K3_MSSQL_TABLE')
  const columns = parseColumns(optionalEnv('K3_MSSQL_COLUMNS'))
  const orderBy = optionalEnv('K3_MSSQL_ORDER_BY')

  return {
    system: {
      id: 'k3_sqlserver_smoke',
      name: 'K3 SQL Server Smoke',
      kind: 'erp:k3-wise-sqlserver',
      role: 'source',
      config: {
        server,
        port: optionalEnv('K3_MSSQL_PORT', 'MSSQL_PORT'),
        database,
        encrypt: optionalEnv('K3_MSSQL_ENCRYPT', 'MSSQL_ENCRYPT'),
        trustServerCertificate: optionalEnv('K3_MSSQL_TRUST_SERVER_CERTIFICATE', 'MSSQL_TRUST_SERVER_CERTIFICATE'),
        legacyTls: optionalEnv('K3_MSSQL_LEGACY_TLS', 'MSSQL_LEGACY_TLS'),
        tlsMinVersion: optionalEnv('K3_MSSQL_TLS_MIN_VERSION', 'MSSQL_TLS_MIN_VERSION'),
        tlsCiphers: optionalEnv('K3_MSSQL_TLS_CIPHERS', 'MSSQL_TLS_CIPHERS'),
        connectionTimeoutMs: optionalEnv('K3_MSSQL_CONNECTION_TIMEOUT_MS', 'MSSQL_CONNECTION_TIMEOUT_MS'),
        requestTimeoutMs: optionalEnv('K3_MSSQL_REQUEST_TIMEOUT_MS', 'MSSQL_REQUEST_TIMEOUT_MS'),
        allowedTables: [table],
        objects: {
          smoke: {
            label: 'K3 SQL Server smoke object',
            table,
            operations: ['read'],
            ...(columns ? { columns } : {}),
            ...(orderBy ? { keyField: orderBy } : {}),
          },
        },
      },
      credentials: {
        username,
        password,
      },
    },
    table,
    columns,
    orderBy,
    limit: parseLimit(optionalEnv('K3_MSSQL_LIMIT')),
  }
}

async function runSmoke({ executorFactory = createK3WiseSqlServerReadOnlyExecutor, log = console.log } = {}) {
  const smoke = buildSystem()
  log('[k3-sqlserver-smoke] target', {
    serverConfigured: true,
    portPresent: configured(smoke.system.config.port),
    databaseConfigured: true,
    table: smoke.table,
    columns: smoke.columns ? smoke.columns.length : null,
    orderBy: smoke.orderBy || null,
    limit: smoke.limit,
    encryptConfigured: configured(smoke.system.config.encrypt),
    trustServerCertificateConfigured: configured(smoke.system.config.trustServerCertificate),
    legacyTls: smoke.system.config.legacyTls || null,
    tlsMinVersion: smoke.system.config.tlsMinVersion || null,
    tlsCiphersConfigured: configured(smoke.system.config.tlsCiphers),
  })

  const executor = executorFactory()
  const adapter = createK3WiseSqlServerChannel({
    system: smoke.system,
    queryExecutor: executor,
  })

  const connection = await adapter.testConnection()
  if (!connection || connection.ok !== true) {
    const error = new Error('K3 SQL Server testConnection failed')
    error.code = connection && connection.code ? connection.code : 'K3_SQLSERVER_TEST_FAILED'
    throw error
  }
  log('[ok] k3 testConnection', {
    code: connection.code || 'SQLSERVER_CONNECTED',
  })

  const read = await adapter.read({
    object: 'smoke',
    limit: smoke.limit,
  })
  log('[ok] k3 read', {
    object: 'smoke',
    table: read.metadata && read.metadata.table ? read.metadata.table : smoke.table,
    rows: Array.isArray(read.records) ? read.records.length : 0,
    done: read.done === undefined ? null : Boolean(read.done),
  })
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    printHelp()
    return
  }

  if (!firstEnv('K3_MSSQL_SERVER', 'K3_MSSQL_HOST', 'MSSQL_SERVER', 'MSSQL_HOST')) {
    console.log('[skip] K3 SQL Server smoke skipped — no K3_MSSQL_SERVER/K3_MSSQL_HOST/MSSQL_SERVER/MSSQL_HOST set.')
    return
  }

  await runSmoke()
}

function formatPublicSmokeError(error) {
  if (!error) return 'K3_SQLSERVER_SMOKE_FAILED'
  const code = typeof error.code === 'string' && error.code.trim()
    ? error.code.trim()
    : typeof error.name === 'string' && error.name !== 'Error'
      ? error.name
      : 'K3_SQLSERVER_SMOKE_FAILED'
  if (code === 'K3_SQLSERVER_SMOKE_CONFIG_INVALID' && error.message) {
    return `${code}: ${error.message}`
  }
  return code
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[failed] K3 SQL Server smoke failed')
    console.error(formatPublicSmokeError(error))
    process.exitCode = 1
  })
}

module.exports = {
  buildSystem,
  formatPublicSmokeError,
  main,
  parseColumns,
  runSmoke,
}
