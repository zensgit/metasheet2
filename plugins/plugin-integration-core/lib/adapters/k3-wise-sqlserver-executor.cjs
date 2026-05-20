'use strict'

// ---------------------------------------------------------------------------
// K3 WISE SQL Server read-only executor
//
// Deployment-safe default query executor for the `erp:k3-wise-sqlserver`
// channel. It uses the `mssql` package lazily, builds only structured SELECT
// statements for adapter-validated identifiers, and keeps middle-table writes
// disabled unless a deployment explicitly injects a different executor.
// ---------------------------------------------------------------------------

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
  return normalized.split('.').map((part) => {
    if (!SIMPLE_IDENTIFIER_PATTERN.test(part)) {
      throw new SqlServerExecutorError('SQLSERVER_IDENTIFIER_INVALID', `${field} must be a simple identifier`, { field })
    }
    return `[${part}]`
  }).join('.')
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_LIMIT
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new SqlServerExecutorError('SQLSERVER_LIMIT_INVALID', 'limit must be a positive integer', { field: 'limit' })
  }
  return Math.min(numeric, MAX_LIMIT)
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
  const server = requiredString(serverValue, 'system.config.server')
  const configuredPort = portValue === undefined || portValue === null || portValue === ''
    ? null
    : Number(portValue)
  if (configuredPort !== null && (!Number.isInteger(configuredPort) || configuredPort <= 0 || configuredPort > 65535)) {
    throw new SqlServerExecutorError('SQLSERVER_PORT_INVALID', 'system.config.port must be a TCP port', {
      field: 'system.config.port',
    })
  }

  const hostPortMatch = server.match(/^([^,:\\]+)([:,])(\d+)$/)
  if (hostPortMatch) {
    const parsedPort = Number(hostPortMatch[3])
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      throw new SqlServerExecutorError('SQLSERVER_PORT_INVALID', 'system.config.server contains an invalid port', {
        field: 'system.config.server',
      })
    }
    if (configuredPort !== null && configuredPort !== parsedPort) {
      throw new SqlServerExecutorError(
        'SQLSERVER_PORT_INVALID',
        'system.config.server port must match system.config.port when both are provided',
        { field: 'system.config.server' },
      )
    }
    return { server: hostPortMatch[1], port: configuredPort === null ? parsedPort : configuredPort }
  }
  return { server, port: configuredPort }
}

function resolveConnectionConfig(system = {}) {
  const config = isPlainObject(system.config) ? system.config : {}
  const credentials = isPlainObject(system.credentials) ? system.credentials : {}
  const { server, port } = parseServerAndPort(config.server, config.port)
  const database = requiredString(config.database, 'system.config.database')
  const user = requiredString(credentials.username || credentials.user || config.username || config.user, 'system.credentials.username', 'SQLSERVER_CREDENTIALS_REQUIRED')
  const password = requiredString(credentials.password, 'system.credentials.password', 'SQLSERVER_CREDENTIALS_REQUIRED')

  return {
    server,
    ...(port === null ? {} : { port }),
    database,
    user,
    password,
    options: {
      encrypt: coerceBoolean(config.encrypt, false),
      trustServerCertificate: coerceBoolean(config.trustServerCertificate, true),
    },
    connectionTimeout: normalizeTimeout(config.connectionTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'system.config.connectionTimeoutMs'),
    requestTimeout: normalizeTimeout(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'system.config.requestTimeoutMs'),
  }
}

function normalizeTimeout(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new SqlServerExecutorError('SQLSERVER_TIMEOUT_INVALID', `${field} must be a positive integer`, { field })
  }
  return numeric
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

function normalizeScalar(value, field) {
  if (value === undefined) return { skip: true }
  if (value === null) return { value: null }
  if (value instanceof Date) return { value }
  if (['string', 'number', 'boolean'].includes(typeof value)) return { value }
  throw new SqlServerExecutorError('SQLSERVER_FILTER_INVALID', `${field} must be a scalar value`, { field })
}

function addInput(request, name, value) {
  request.input(name, value)
  return `@${name}`
}

function appendStructuredPredicates({ request, values, operator, parts, prefix }) {
  if (!isPlainObject(values)) return
  let index = 0
  for (const [field, value] of Object.entries(values)) {
    const quotedField = quoteIdentifier(field, `${prefix}.${field}`)
    if (Array.isArray(value)) {
      if (value.length === 0) {
        parts.push('1 = 0')
        continue
      }
      const placeholders = value.map((item, itemIndex) => {
        const scalar = normalizeScalar(item, `${prefix}.${field}[${itemIndex}]`)
        if (scalar.skip) {
          throw new SqlServerExecutorError('SQLSERVER_FILTER_INVALID', `${prefix}.${field}[${itemIndex}] must be a scalar value`, {
            field: `${prefix}.${field}[${itemIndex}]`,
          })
        }
        const paramName = `${prefix}_${index}_${itemIndex}`.replace(/[^A-Za-z0-9_]/g, '_')
        return addInput(request, paramName, scalar.value)
      })
      parts.push(`${quotedField} IN (${placeholders.join(', ')})`)
      index += 1
      continue
    }
    const scalar = normalizeScalar(value, `${prefix}.${field}`)
    if (scalar.skip) continue
    if (scalar.value === null) {
      parts.push(`${quotedField} IS NULL`)
      index += 1
      continue
    }
    const paramName = `${prefix}_${index}`.replace(/[^A-Za-z0-9_]/g, '_')
    parts.push(`${quotedField} ${operator} ${addInput(request, paramName, scalar.value)}`)
    index += 1
  }
}

function buildSelectQuery({ request, table, columns, limit, filters, watermark, orderBy }) {
  const safeLimit = normalizeLimit(limit)
  const tableSql = quoteIdentifier(table, 'table')
  const columnSql = Array.isArray(columns) && columns.length > 0
    ? columns.map((column, index) => quoteIdentifier(column, `columns[${index}]`)).join(', ')
    : '*'
  const parts = []
  appendStructuredPredicates({ request, values: filters, operator: '=', parts, prefix: 'filter' })
  appendStructuredPredicates({ request, values: watermark, operator: '>', parts, prefix: 'watermark' })
  const whereSql = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : ''
  const orderSql = orderBy ? ` ORDER BY ${quoteIdentifier(orderBy, 'orderBy')}` : ''
  return `SELECT TOP ${safeLimit} ${columnSql} FROM ${tableSql}${whereSql}${orderSql}`
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
