'use strict'

const SIMPLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/
const QUALIFIED_IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/
const VALID_TLS_MIN_VERSIONS = Object.freeze(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'])

class SqlServerReadonlyHelperError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SqlServerReadonlyHelperError'
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredString(value, field, code = 'SQLSERVER_CONFIG_REQUIRED') {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new SqlServerReadonlyHelperError(code, `${field} is required`, { field })
  }
  return normalized
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

function normalizeIdentifier(value, field = 'identifier') {
  const normalized = requiredString(value, field, 'SQLSERVER_IDENTIFIER_INVALID')
  if (!QUALIFIED_IDENTIFIER_PATTERN.test(normalized)) {
    throw new SqlServerReadonlyHelperError('SQLSERVER_IDENTIFIER_INVALID', `${field} must be a simple identifier`, {
      field,
    })
  }
  return normalized
}

function quoteSqlServerIdentifier(value, field = 'identifier') {
  return normalizeIdentifier(value, field)
    .split('.')
    .map((part) => {
      if (!SIMPLE_IDENTIFIER_PATTERN.test(part)) {
        throw new SqlServerReadonlyHelperError('SQLSERVER_IDENTIFIER_INVALID', `${field} must be a simple identifier`, {
          field,
        })
      }
      return `[${part}]`
    })
    .join('.')
}

function normalizePort(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) {
    throw new SqlServerReadonlyHelperError('SQLSERVER_PORT_INVALID', `${field} must be a TCP port`, { field })
  }
  return numeric
}

function parseSqlServerEndpoint(input = {}) {
  const host = optionalString(input.host)
  const serverRaw = optionalString(input.server)
  const explicitPort = normalizePort(input.port, 'port')

  if (host) {
    return { server: host, ...(explicitPort === undefined ? {} : { port: explicitPort }) }
  }

  const server = requiredString(serverRaw, 'server')
  const match = server.match(/^(.*?)([:,])(\d+)$/)
  if (!match) {
    return { server, ...(explicitPort === undefined ? {} : { port: explicitPort }) }
  }

  const parsedPort = normalizePort(match[3], 'server')
  if (explicitPort !== undefined && explicitPort !== parsedPort) {
    throw new SqlServerReadonlyHelperError(
      'SQLSERVER_PORT_INVALID',
      `Conflicting port: port=${explicitPort} but server specifies ${parsedPort}`,
      { field: 'server' },
    )
  }
  return { server: match[1], port: explicitPort === undefined ? parsedPort : explicitPort }
}

function normalizeTimeout(value, options = {}) {
  const field = options.field || 'timeout'
  if (value === undefined || value === null || value === '') return options.defaultValue
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 0 || (numeric === 0 && options.allowZero !== true)) {
    throw new SqlServerReadonlyHelperError('SQLSERVER_TIMEOUT_INVALID', `${field} must be a valid timeout`, { field })
  }
  return numeric
}

function normalizeLimit(value, options = {}) {
  const defaultLimit = Number.isInteger(options.defaultLimit) ? options.defaultLimit : 1000
  const maxLimit = Number.isInteger(options.maxLimit) ? options.maxLimit : 10000
  const overMax = options.overMax || 'throw'
  if (value === undefined || value === null || value === '') return defaultLimit
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new SqlServerReadonlyHelperError('SQLSERVER_LIMIT_INVALID', 'limit must be a positive integer', {
      field: 'limit',
    })
  }
  if (numeric > maxLimit) {
    if (overMax === 'clamp') return maxLimit
    throw new SqlServerReadonlyHelperError(
      'SQLSERVER_LIMIT_INVALID',
      `limit ${numeric} exceeds maximum ${maxLimit}`,
      { field: 'limit', maxLimit },
    )
  }
  return numeric
}

function buildLegacyTlsOptions(connection = {}) {
  const legacyTls = coerceBoolean(connection.legacyTls, false)
  let minVersion = optionalString(connection.tlsMinVersion)
  let ciphers = optionalString(connection.tlsCiphers)

  if (legacyTls) {
    minVersion = minVersion || 'TLSv1'
    ciphers = ciphers || 'DEFAULT@SECLEVEL=0'
  }

  if (minVersion === undefined && ciphers === undefined) return undefined

  if (coerceBoolean(connection.encrypt, true) === false) {
    throw new SqlServerReadonlyHelperError(
      'SQLSERVER_TLS_CONFLICT',
      'connection.encrypt=false cannot be combined with legacy TLS options',
      { field: 'connection.encrypt' },
    )
  }

  if (minVersion !== undefined && !VALID_TLS_MIN_VERSIONS.includes(minVersion)) {
    throw new SqlServerReadonlyHelperError(
      'SQLSERVER_TLS_MIN_VERSION_INVALID',
      `Invalid TLS minVersion "${minVersion}"`,
      { field: 'tlsMinVersion' },
    )
  }

  return {
    ...(minVersion === undefined ? {} : { minVersion }),
    ...(ciphers === undefined ? {} : { ciphers }),
  }
}

function normalizeScalar(value, field) {
  if (value === undefined) return { skip: true }
  if (value === null) return { value: null }
  if (value instanceof Date || ['string', 'number', 'boolean'].includes(typeof value)) {
    return { value }
  }
  throw new SqlServerReadonlyHelperError('SQLSERVER_FILTER_INVALID', `${field} must be a scalar value`, { field })
}

function defaultParameter(index) {
  return `$${index}`
}

function buildGenericWhereClause(where, options = {}) {
  if (!isPlainObject(where)) {
    throw new SqlServerReadonlyHelperError('SQLSERVER_WHERE_INVALID', 'where must be an object', { field: 'where' })
  }
  const quoteIdentifier = options.quoteIdentifier || ((field) => quoteSqlServerIdentifier(field))
  const parameter = options.parameter || defaultParameter
  const result = buildGenericWhereConditions(where, 1, quoteIdentifier, parameter)
  return {
    sql: result.conditions.length > 0 ? `WHERE ${result.conditions.join(' AND ')}` : '',
    params: result.params,
  }
}

function buildGenericWhereConditions(where, startParamIndex, quoteIdentifier, parameter) {
  const conditions = []
  const params = []
  let paramIndex = startParamIndex

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue
    if (key === '$or' || key === '$and') {
      if (!Array.isArray(value) || value.length === 0) {
        throw new SqlServerReadonlyHelperError('SQLSERVER_WHERE_INVALID', `${key} must be a non-empty array`, {
          field: key,
        })
      }
      const nestedParts = []
      for (const clause of value) {
        if (!isPlainObject(clause)) {
          throw new SqlServerReadonlyHelperError('SQLSERVER_WHERE_INVALID', `${key} entries must be objects`, {
            field: key,
          })
        }
        const nested = buildGenericWhereConditions(clause, paramIndex, quoteIdentifier, parameter)
        paramIndex = nested.nextParamIndex
        params.push(...nested.params)
        if (nested.conditions.length === 0) {
          throw new SqlServerReadonlyHelperError('SQLSERVER_WHERE_INVALID', `${key} entries must not be empty`, {
            field: key,
          })
        }
        nestedParts.push(`(${nested.conditions.join(' AND ')})`)
      }
      conditions.push(`(${nestedParts.join(key === '$or' ? ' OR ' : ' AND ')})`)
      continue
    }

    if (value === null) {
      conditions.push(`${quoteIdentifier(key)} IS NULL`)
      continue
    }

    if (Array.isArray(value)) {
      const placeholders = value.map(() => parameter(paramIndex++)).join(', ')
      conditions.push(`${quoteIdentifier(key)} IN (${placeholders})`)
      params.push(...value)
      continue
    }

    if (isWhereOperator(value)) {
      for (const [op, operand] of Object.entries(value)) {
        if (operand === undefined) continue
        const operator = operatorSql(op)
        if (op === '$in' || op === '$nin') {
          if (!Array.isArray(operand) || operand.length === 0) {
            throw new SqlServerReadonlyHelperError('SQLSERVER_WHERE_INVALID', `${op} must be a non-empty array`, {
              field: op,
            })
          }
          const placeholders = operand.map(() => parameter(paramIndex++)).join(', ')
          conditions.push(`${quoteIdentifier(key)} ${operator} (${placeholders})`)
          params.push(...operand)
        } else if (op === '$between') {
          if (!Array.isArray(operand) || operand.length !== 2) {
            throw new SqlServerReadonlyHelperError('SQLSERVER_WHERE_INVALID', '$between must be a two-value array', {
              field: op,
            })
          }
          conditions.push(`${quoteIdentifier(key)} BETWEEN ${parameter(paramIndex++)} AND ${parameter(paramIndex++)}`)
          params.push(...operand)
        } else {
          conditions.push(`${quoteIdentifier(key)} ${operator} ${parameter(paramIndex++)}`)
          params.push(operand)
        }
      }
      continue
    }

    if (typeof value === 'object' && value !== null) {
      conditions.push(`${quoteIdentifier(key)} = ${parameter(paramIndex++)}`)
      params.push(value)
      continue
    }

    conditions.push(`${quoteIdentifier(key)} = ${parameter(paramIndex++)}`)
    params.push(value)
  }

  return { conditions, params, nextParamIndex: paramIndex }
}

function isWhereOperator(value) {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  return keys.length > 0 && keys.some((key) => key.startsWith('$'))
}

function operatorSql(op) {
  const operators = {
    $gt: '>',
    $gte: '>=',
    $lt: '<',
    $lte: '<=',
    $ne: '!=',
    $like: 'LIKE',
    $ilike: 'ILIKE',
    $in: 'IN',
    $nin: 'NOT IN',
    $between: 'BETWEEN',
  }
  const operator = operators[op]
  if (!operator) {
    throw new SqlServerReadonlyHelperError('SQLSERVER_WHERE_OPERATOR_UNSUPPORTED', `Unsupported where operator: ${op}`, {
      operator: op,
    })
  }
  return operator
}

function bindInput(request, name, value) {
  if (!request || typeof request.input !== 'function') {
    throw new SqlServerReadonlyHelperError('SQLSERVER_REQUEST_INVALID', 'request.input is required', {
      field: 'request',
    })
  }
  request.input(name, value)
  return `@${name}`
}

function appendSimplePredicates({ request, values, operator, parts, prefix }) {
  if (!isPlainObject(values)) return
  let index = 0
  for (const [field, value] of Object.entries(values)) {
    const quotedField = quoteSqlServerIdentifier(field, `${prefix}.${field}`)
    if (Array.isArray(value)) {
      if (value.length === 0) {
        parts.push('1 = 0')
        continue
      }
      const placeholders = value.map((item, itemIndex) => {
        const scalar = normalizeScalar(item, `${prefix}.${field}[${itemIndex}]`)
        if (scalar.skip) {
          throw new SqlServerReadonlyHelperError('SQLSERVER_FILTER_INVALID', `${prefix}.${field}[${itemIndex}] is invalid`, {
            field: `${prefix}.${field}[${itemIndex}]`,
          })
        }
        return bindInput(request, `${prefix}_${index}_${itemIndex}`.replace(/[^A-Za-z0-9_]/g, '_'), scalar.value)
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
    parts.push(`${quotedField} ${operator} ${bindInput(request, `${prefix}_${index}`, scalar.value)}`)
    index += 1
  }
}

function buildSimpleSelectQuery(input = {}) {
  const safeLimit = normalizeLimit(input.limit, input.limitPolicy || { defaultLimit: 1000, maxLimit: 10000, overMax: 'clamp' })
  const tableSql = quoteSqlServerIdentifier(input.table, 'table')
  const columnSql = Array.isArray(input.columns) && input.columns.length > 0
    ? input.columns.map((column, index) => quoteSqlServerIdentifier(column, `columns[${index}]`)).join(', ')
    : '*'
  const parts = []
  appendSimplePredicates({ request: input.request, values: input.filters, operator: '=', parts, prefix: 'filter' })
  appendSimplePredicates({ request: input.request, values: input.watermark, operator: '>', parts, prefix: 'watermark' })
  const whereSql = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : ''
  const orderSql = input.orderBy ? ` ORDER BY ${quoteSqlServerIdentifier(input.orderBy, 'orderBy')}` : ''
  return `SELECT TOP ${safeLimit} ${columnSql} FROM ${tableSql}${whereSql}${orderSql}`
}

module.exports = {
  SqlServerReadonlyHelperError,
  VALID_TLS_MIN_VERSIONS,
  buildGenericWhereClause,
  buildLegacyTlsOptions,
  buildSimpleSelectQuery,
  coerceBoolean,
  normalizeIdentifier,
  normalizeLimit,
  normalizeScalar,
  normalizeTimeout,
  optionalString,
  parseSqlServerEndpoint,
  quoteSqlServerIdentifier,
  requiredString,
}
