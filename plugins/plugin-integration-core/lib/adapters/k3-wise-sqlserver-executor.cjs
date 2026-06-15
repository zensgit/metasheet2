'use strict'

// ---------------------------------------------------------------------------
// K3 WISE SQL Server read-only executor
//
// Deployment-safe default query executor for the `erp:k3-wise-sqlserver`
// channel. It uses the `mssql` package lazily, builds only structured SELECT
// statements for adapter-validated identifiers, and keeps middle-table writes
// disabled unless a deployment explicitly injects a different executor.
// ---------------------------------------------------------------------------

const {
  buildLegacyTlsOptions,
  buildSimpleSelectQuery: buildSharedSimpleSelectQuery,
  normalizeLimit: normalizeSharedLimit,
  normalizeTimeout: normalizeSharedTimeout,
  parseSqlServerEndpoint,
  quoteSqlServerIdentifier,
} = require('@metasheet/mssql-readonly-utils')

const SIMPLE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const QUALIFIED_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_LIMIT = 1000
const MAX_LIMIT = 10_000
const SECRET_TEXT_PATTERN = /(?:password|passwd|pwd|token|secret|api[_-]?key|authorization)=([^;,\s]+)/ig

class SqlServerExecutorError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`)
    this.name = 'SqlServerExecutorError'
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field, code = 'SQLSERVER_CONFIG_REQUIRED') {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new SqlServerExecutorError(code, `${field} is required`, { field })
  }
  return normalized
}

function normalizeIdentifier(value, field) {
  const normalized = requiredString(value, field, 'SQLSERVER_IDENTIFIER_INVALID')
  if (!QUALIFIED_IDENTIFIER_PATTERN.test(normalized)) {
    throw new SqlServerExecutorError('SQLSERVER_IDENTIFIER_INVALID', `${field} must be a simple identifier`, { field })
  }
  return normalized
}

function quoteIdentifier(value, field = 'identifier') {
  const normalized = normalizeIdentifier(value, field)
  try {
    return quoteSqlServerIdentifier(normalized, field)
  } catch (error) {
    throw wrapHelperError(error, 'SQLSERVER_IDENTIFIER_INVALID', `${field} must be a simple identifier`)
  }
}

function normalizeLimit(value) {
  try {
    return normalizeSharedLimit(value, {
      defaultLimit: DEFAULT_MAX_LIMIT,
      maxLimit: MAX_LIMIT,
      overMax: 'clamp',
    })
  } catch (error) {
    throw wrapHelperError(error, 'SQLSERVER_LIMIT_INVALID', 'limit must be a positive integer')
  }
}

function coerceBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : fallback
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on', '是', '启用', '开启'].includes(normalized)) return true
    if (['false', '0', 'no', 'n', 'off', '否', '禁用', '关闭'].includes(normalized)) return false
  }
  return fallback
}

function parseServerAndPort(serverValue, portValue) {
  try {
    const endpoint = parseSqlServerEndpoint({
      server: requiredString(serverValue, 'system.config.server'),
      port: portValue,
    })
    return { server: endpoint.server, port: endpoint.port === undefined ? null : endpoint.port }
  } catch (error) {
    if (error && error.code === 'SQLSERVER_PORT_INVALID') {
      const message = String(error.message || '')
      if (message.includes('Conflicting port')) {
        throw new SqlServerExecutorError(
          'SQLSERVER_PORT_INVALID',
          'system.config.server port must match system.config.port when both are provided',
          { field: 'system.config.server' },
        )
      }
      throw new SqlServerExecutorError(
        'SQLSERVER_PORT_INVALID',
        error.details && error.details.field === 'server'
          ? 'system.config.server contains an invalid port'
          : 'system.config.port must be a TCP port',
        { field: error.details && error.details.field === 'server' ? 'system.config.server' : 'system.config.port' },
      )
    }
    throw wrapHelperError(error, 'SQLSERVER_CONFIG_REQUIRED', 'system.config.server is required')
  }
}

function resolveConnectionConfig(system = {}) {
  const config = isPlainObject(system.config) ? system.config : {}
  const credentials = isPlainObject(system.credentials) ? system.credentials : {}
  const { server, port } = parseServerAndPort(config.server, config.port)
  const database = requiredString(config.database, 'system.config.database')
  const user = requiredString(credentials.username || credentials.user || config.username || config.user, 'system.credentials.username', 'SQLSERVER_CREDENTIALS_REQUIRED')
  const password = requiredString(credentials.password, 'system.credentials.password', 'SQLSERVER_CREDENTIALS_REQUIRED')
  const legacyTls = buildK3LegacyTlsOptions(config)
  const encrypt = coerceBoolean(config.encrypt, legacyTls ? true : false)

  return {
    server,
    ...(port === null ? {} : { port }),
    database,
    user,
    password,
    options: {
      encrypt,
      trustServerCertificate: coerceBoolean(config.trustServerCertificate, true),
      ...(legacyTls ? { cryptoCredentialsDetails: legacyTls } : {}),
    },
    connectionTimeout: normalizeTimeout(config.connectionTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'system.config.connectionTimeoutMs'),
    requestTimeout: normalizeTimeout(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'system.config.requestTimeoutMs'),
  }
}

function hasLegacyTlsKnob(config) {
  return config.legacyTls !== undefined ||
    config.tlsMinVersion !== undefined ||
    config.tlsCiphers !== undefined
}

function buildK3LegacyTlsOptions(config) {
  if (!hasLegacyTlsKnob(config)) return undefined
  try {
    return buildLegacyTlsOptions({
      legacyTls: coerceBoolean(config.legacyTls, false),
      tlsMinVersion: config.tlsMinVersion,
      tlsCiphers: config.tlsCiphers,
      encrypt: coerceBoolean(config.encrypt, true),
    })
  } catch (error) {
    throw wrapHelperError(
      error,
      error && error.code ? error.code : 'SQLSERVER_TLS_INVALID',
      'invalid SQL Server TLS options',
    )
  }
}

function normalizeTimeout(value, fallback, field) {
  try {
    return normalizeSharedTimeout(value, { defaultValue: fallback, field, allowZero: false })
  } catch (error) {
    throw new SqlServerExecutorError('SQLSERVER_TIMEOUT_INVALID', `${field} must be a positive integer`, { field })
  }
}

function loadMssqlDriver(requireImpl = require) {
  try {
    return requireImpl('mssql')
  } catch (error) {
    const wrapped = new SqlServerExecutorError(
      'SQLSERVER_DRIVER_MISSING',
      'mssql dependency is not available; run pnpm install from the deploy root',
      { dependency: 'mssql' },
    )
    wrapped.cause = error
    throw wrapped
  }
}

async function withPool({ driver, system, fn }) {
  const pool = new driver.ConnectionPool(resolveConnectionConfig(system))
  let connected = null
  try {
    connected = await pool.connect()
    return await fn(connected || pool)
  } finally {
    if (connected && typeof connected.close === 'function') {
      await connected.close()
    } else if (pool && typeof pool.close === 'function') {
      await pool.close()
    }
  }
}

function assertK3PredicateIdentifiers(values, prefix) {
  if (!isPlainObject(values)) return
  for (const field of Object.keys(values)) {
    normalizeIdentifier(field, `${prefix}.${field}`)
  }
}

function buildSelectQuery({ request, table, columns, limit, filters, watermark, orderBy }) {
  const k3Table = normalizeIdentifier(table, 'table')
  const k3Columns = Array.isArray(columns) && columns.length > 0
    ? columns.map((column, index) => normalizeIdentifier(column, `columns[${index}]`))
    : columns
  const k3OrderBy = orderBy ? normalizeIdentifier(orderBy, 'orderBy') : orderBy
  assertK3PredicateIdentifiers(filters, 'filter')
  assertK3PredicateIdentifiers(watermark, 'watermark')

  try {
    return buildSharedSimpleSelectQuery({
      request,
      table: k3Table,
      columns: k3Columns,
      limit,
      filters,
      watermark,
      orderBy: k3OrderBy,
      limitPolicy: {
        defaultLimit: DEFAULT_MAX_LIMIT,
        maxLimit: MAX_LIMIT,
        overMax: 'clamp',
      },
    })
  } catch (error) {
    throw wrapHelperError(error, error && error.code ? error.code : 'SQLSERVER_QUERY_INVALID', 'invalid SQL Server query')
  }
}

function wrapHelperError(error, fallbackCode, fallbackMessage) {
  if (error instanceof SqlServerExecutorError) return error
  return new SqlServerExecutorError(
    error && typeof error.code === 'string' ? error.code : fallbackCode,
    error && error.message ? error.message : fallbackMessage,
    error && isPlainObject(error.details) ? error.details : {},
  )
}

function normalizeQueryResult(result) {
  return {
    records: Array.isArray(result && result.recordset) ? result.recordset : [],
    nextCursor: null,
    done: true,
    raw: {
      rowsAffected: Array.isArray(result && result.rowsAffected) ? result.rowsAffected : [],
    },
  }
}

function publicErrorResult(error) {
  const message = redactSecretText(error && error.message ? error.message : String(error))
  if (error instanceof SqlServerExecutorError) {
    return {
      ok: false,
      code: error.code,
      message,
    }
  }
  return {
    ok: false,
    code: 'SQLSERVER_TEST_FAILED',
    message,
  }
}

function redactSecretText(value) {
  return String(value || '').replace(SECRET_TEXT_PATTERN, (match) => {
    const key = match.split('=')[0]
    return `${key}=<redacted>`
  })
}

function createK3WiseSqlServerReadOnlyExecutor({ driver, requireImpl, logger } = {}) {
  function resolveDriver() {
    return driver || loadMssqlDriver(requireImpl)
  }

  async function testConnection({ system, input } = {}) {
    void input
    try {
      await withPool({
        driver: resolveDriver(),
        system,
        fn: async (pool) => {
          const request = pool.request()
          await request.query('SELECT 1 AS ok')
        },
      })
      return { ok: true, code: 'SQLSERVER_CONNECTED', message: 'SQL Server connection test passed' }
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[plugin-integration-core] K3 WISE SQL Server read-only executor test failed')
      }
      return publicErrorResult(error)
    }
  }

  async function select(input = {}) {
    return withPool({
      driver: resolveDriver(),
      system: input.system,
      fn: async (pool) => {
        const request = pool.request()
        const query = buildSelectQuery({
          request,
          table: input.table,
          columns: input.columns,
          limit: input.limit,
          filters: input.filters,
          watermark: input.watermark,
          orderBy: input.orderBy,
        })
        return normalizeQueryResult(await request.query(query))
      },
    })
  }

  async function insertMany() {
    throw new SqlServerExecutorError(
      'SQLSERVER_WRITE_EXECUTOR_DISABLED',
      'built-in SQL Server executor is read-only; inject a deployment-owned middle-table executor for writes',
    )
  }

  return {
    testConnection,
    select,
    insertMany,
  }
}

module.exports = {
  SqlServerExecutorError,
  createK3WiseSqlServerReadOnlyExecutor,
  __internals: {
    SIMPLE_IDENTIFIER_PATTERN,
    QUALIFIED_IDENTIFIER_PATTERN,
    buildSelectQuery,
    loadMssqlDriver,
    normalizeLimit,
    quoteIdentifier,
    redactSecretText,
    resolveConnectionConfig,
  },
}
