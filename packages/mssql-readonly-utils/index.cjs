'use strict'

// ── SQL Server identifier safety (G52) ───────────────────────────────────────
//
// THE ONE RULE: an identifier NEVER reaches SQL text except through
// `quoteSqlServerIdentifierPart`, which brackets it and DOUBLES every `]`. Per the T-SQL grammar the
// closing bracket is the ONLY metacharacter inside `[...]`; doubling it is therefore a TOTAL escape —
// no quote, semicolon, comment starter, newline or keyword sitting inside a delimited identifier can
// end the identifier or start a new token. That is why this module can accept non-ASCII object names
// (中文表名 / a name with spaces — 国内 ERP 二开 everyday reality) without weakening injection defence:
// the defence was never the character set, it is the escape.
//
// Validation and quoting are HALVES OF ONE FUNCTION on purpose. There is no "validate here, quote
// over there" seam where a value could pass the check and then be emitted by a path that forgot to
// escape: `assertSqlServerIdentifierPart` is called BY the quoter, and the quoter re-parses its own
// output (`unquoteBracketToken`) and refuses unless it reads back byte-identical to the input. A
// missing/incorrect escape is then a THROW, not a crafted statement.
//
// WHAT IS ACCEPTED (per dot-separated segment)
//   • Unicode letters `\p{L}` and combining marks `\p{M}` — every script, so 物料表 / товары / नाम work.
//   • Unicode digits `\p{N}` and `_`. (Superset of the old `[A-Za-z0-9_]`: nothing that used to be
//     accepted is now refused on character grounds.)
//   • Space separators `\p{Zs}` (ordinary space, U+3000, …) anywhere EXCEPT the first/last position.
//   • A literal `]`. It is admitted because a real object name may contain one and the doubling above
//     expresses it EXACTLY — and because keeping it admitted is what keeps that escape a live, tested
//     path instead of dead decoration.
//
// WHAT IS REFUSED, AND WHY (all as SQLSERVER_IDENTIFIER_INVALID, `details.reason` says which)
//   • An empty segment (`a..b`, `dbo.`, ``) — nothing to name.
//   • > 128 UTF-16 CODE UNITS. SQL Server object names are `sysname` = `nvarchar(128)`, i.e. 128
//     UCS-2/UTF-16 units — NOT bytes and NOT code points: a supplementary character (𠮷, an emoji)
//     costs TWO. JavaScript's `String#length` counts exactly those units, so `part.length` is the
//     server's own unit, not an approximation of it.
//   • A leading/trailing space separator — invisible in every UI, so an operator cannot tell the name
//     apart from the trimmed one, and SQL Server's own trailing-blank handling for identifiers is not
//     uniform across contexts. Refusing says so instead of silently reading a different object.
//   • `[`. Its only realistic appearance in operator input is a name someone ALREADY bracketed in SSMS
//     (`[dbo].[订单]`). We cannot tell that apart from a name whose characters really are `[dbo]`, and
//     guessing would mean shipping a bracket parser — new attack surface for a formatting convenience.
//     Refusing catches 100% of pre-bracketed input (every such form contains `[`) with an actionable
//     error. `]` alone cannot be a pre-bracketing artefact, which is why the two differ.
//   • Everything else: control characters and newlines (`\p{Cc}`), format/bidi/zero-width characters
//     and BOM (`\p{Cf}`), lone surrogates (`\p{Cs}`), private-use and unassigned code points, line and
//     paragraph separators (U+2028/U+2029), and ASCII punctuation — `;` `'` `"` `-` `/` `*` `%` `(` `)`
//     `\` `,` `+` `=` … They are not refused because they could inject (they could not, see THE ONE
//     RULE) but because none of them is needed to NAME something, several are invisible or
//     script-spoofing, newlines break every log line and error message that carries the value, and a
//     narrow set keeps this adapter's rule consistent with the Postgres/MySQL adapters' own. Admitting
//     one later is a one-character edit to ALLOWED_PART_CHARACTERS plus a test — deliberately not done
//     speculatively here.
//   • `$` falls out of that list, and that is load-bearing rather than incidental: MSSQLAdapter.query
//     rewrites `$N` placeholders over FINISHED statement text, so a `$1` inside an identifier would be
//     silently rewritten into `@p0`. Refusing `$` removes the class instead of the instance.
//   • MORE THAN THREE dot-separated parts. Three (`db.schema.object`) is pre-existing behaviour and
//     stays: it is cross-DATABASE on the SAME server, bounded by the connection's own login. A FOUR
//     part name (`server.db.schema.object`) is a LINKED SERVER reference — it leaves the configured
//     server entirely, under the linked server's credentials, so this data source's read-only
//     guarantee simply does not reach it. That is a different boundary, and it is closed here.
//
// KNOWN, DELIBERATE LIMITATION: a segment whose literal name contains a dot is unrepresentable —
// `a.b` is read as two parts. Making it representable means accepting pre-bracketed input, see `[`.
const IDENTIFIER_MAX_CODE_UNITS = 128
const IDENTIFIER_MAX_PARTS = 3
const ALLOWED_PART_CHARACTERS = /^[\p{L}\p{M}\p{N}_\p{Zs}\]]+$/u
const EDGE_SPACE_SEPARATOR = /^\p{Zs}|\p{Zs}$/u
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

function identifierInvalid(field, reason) {
  return new SqlServerReadonlyHelperError(
    'SQLSERVER_IDENTIFIER_INVALID',
    `${field} is not a usable SQL Server identifier (${reason})`,
    { field, reason },
  )
}

/**
 * Read ONE bracket-quoted token starting at `start`, exactly the way SQL Server's parser does: the
 * token ends at the first `]` that is NOT followed by another `]`. Returns `{ value, end }` (the
 * unescaped name and the index just past the closing bracket) or `null` when the text does not open
 * with `[` or never closes. This is the mirror image of the quoter, and it is deliberately the SAME
 * rule the outbound SQL write gate's `scanSqlNoise` applies when it strips bracketed identifiers —
 * quoter, parser and classifier agree on where an identifier ends, so none of them can be shown a
 * different statement than the other two.
 */
function scanBracketToken(text, start) {
  if (typeof text !== 'string' || text[start] !== '[') return null
  let value = ''
  let i = start + 1
  while (i < text.length) {
    if (text[i] === ']') {
      if (text[i + 1] === ']') {
        value += ']'
        i += 2
        continue
      }
      return { value, end: i + 1 }
    }
    value += text[i]
    i += 1
  }
  return null
}

/**
 * The character/length/shape rule for ONE segment. See the block comment at the top of this file for
 * what it accepts and refuses and why. Throws SQLSERVER_IDENTIFIER_INVALID; returns the segment.
 */
function assertSqlServerIdentifierPart(part, field = 'identifier') {
  if (typeof part !== 'string' || part.length === 0) {
    throw identifierInvalid(field, 'empty segment')
  }
  // UTF-16 code units — `sysname` is `nvarchar(128)`, see the block comment.
  if (part.length > IDENTIFIER_MAX_CODE_UNITS) {
    throw identifierInvalid(field, `segment exceeds ${IDENTIFIER_MAX_CODE_UNITS} characters`)
  }
  // A MESSAGE guard, not a safety guard, and labelled as such so nobody mistakes it for one: `[` is
  // already outside ALLOWED_PART_CHARACTERS below, so deleting these three lines still refuses the
  // input — just with "contains a character outside …", which sends an operator hunting for an
  // invisible character instead of telling them to drop the brackets they pasted from SSMS.
  if (part.includes('[')) {
    throw identifierInvalid(field, 'segment contains "[" — pass the plain object name, not a pre-bracketed one')
  }
  if (!ALLOWED_PART_CHARACTERS.test(part)) {
    throw identifierInvalid(field, 'segment contains a character outside letters/marks/digits/underscore/space')
  }
  if (EDGE_SPACE_SEPARATOR.test(part)) {
    throw identifierInvalid(field, 'segment starts or ends with a space')
  }
  return part
}

/**
 * Validate AND bracket-quote ONE segment — the single place an identifier becomes SQL text.
 *
 * The `]`-doubling is the injection defence (see THE ONE RULE above); the round-trip check below is
 * its PROOF, evaluated per call on the actual value: if re-reading the produced token with SQL
 * Server's own end-of-token rule does not give back exactly what went in, the token would mean
 * something else to the server than it means here, so we refuse instead of emitting it.
 */
function quoteSqlServerIdentifierPart(part, field = 'identifier') {
  const safe = assertSqlServerIdentifierPart(part, field)
  const quoted = `[${safe.replace(/]/g, ']]')}]`
  const parsed = scanBracketToken(quoted, 0)
  if (!parsed || parsed.end !== quoted.length || parsed.value !== safe) {
    throw identifierInvalid(field, 'segment could not be bracket-quoted losslessly')
  }
  return quoted
}

function splitIdentifierParts(value, field) {
  // Missing/blank lands on the identifier vocabulary too (`details.reason`), so every refusal from this
  // module answers the same question — a caller rendering the reason never has to special-case one.
  if (typeof value !== 'string' || value.trim() === '') {
    throw identifierInvalid(field, 'missing or empty identifier')
  }
  const normalized = requiredString(value, field, 'SQLSERVER_IDENTIFIER_INVALID')
  const parts = normalized.split('.')
  if (parts.length > IDENTIFIER_MAX_PARTS) {
    throw identifierInvalid(field, 'more than three parts — a four-part name targets a LINKED SERVER')
  }
  for (const part of parts) assertSqlServerIdentifierPart(part, field)
  return { normalized, parts }
}

/** Validate a (possibly dot-qualified) identifier and return it unchanged — no quoting. */
function normalizeIdentifier(value, field = 'identifier') {
  return splitIdentifierParts(value, field).normalized
}

/** Validate + bracket-quote per segment: `dbo.销 售` -> `[dbo].[销 售]`, `a]b` -> `[a]]b]`. */
function quoteSqlServerIdentifier(value, field = 'identifier') {
  return splitIdentifierParts(value, field)
    .parts.map((part) => quoteSqlServerIdentifierPart(part, field))
    .join('.')
}

/**
 * Inverse of `quoteSqlServerIdentifier` for a WELL-FORMED bracketed name: `[a]]b].[c]` -> `a]b.c`.
 * Strict — anything that is not a dot-joined sequence of closed bracket tokens throws. Used by the
 * quoter's own round-trip proof and by tests; it does not widen anything, since it never produces SQL.
 */
function unquoteSqlServerIdentifier(quoted, field = 'identifier') {
  const text = typeof quoted === 'string' ? quoted : ''
  const parts = []
  let i = 0
  while (i < text.length) {
    const token = scanBracketToken(text, i)
    if (!token) throw identifierInvalid(field, 'expected a closed bracket-quoted segment')
    parts.push(token.value)
    i = token.end
    if (i === text.length) break
    if (text[i] !== '.') throw identifierInvalid(field, 'unexpected text after a bracket-quoted segment')
    i += 1
    if (i >= text.length) throw identifierInvalid(field, 'empty segment')
  }
  if (parts.length === 0) throw identifierInvalid(field, 'empty identifier')
  return parts.join('.')
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
  assertSqlServerIdentifierPart,
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
  quoteSqlServerIdentifierPart,
  requiredString,
  unquoteSqlServerIdentifier,
}
