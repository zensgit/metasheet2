'use strict'

// ---------------------------------------------------------------------------
// DB helper — plugin-integration-core
//
// Security model (revised after PR #0 review):
//
//   This module does NOT accept raw SQL. A previous draft scanned user SQL
//   with regex to enforce an `integration_*` table prefix; that approach was
//   trivially bypassed by quoted identifiers (`FROM "users"`) and other
//   well-known SQL syntax variants, so it was removed.
//
//   The surface is now a narrow, structured CRUD builder: table and column
//   names pass through a strict identifier whitelist before any SQL is
//   constructed, and every generated statement is parameterized. There is no
//   escape hatch. If a future feature needs raw SQL, it must either (a) live
//   in the kernel with its own access control, or (b) be added here as a
//   new validated method.
//
//   Defence in depth: this is in addition to the `database.read` /
//   `database.write` plugin permissions; those gate the capability, this
//   narrows the scope inside that capability.
// ---------------------------------------------------------------------------

const ALLOWED_PREFIX = 'integration_'
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

class ScopeViolationError extends Error {
  constructor(message, { table, column } = {}) {
    super(message)
    this.name = 'ScopeViolationError'
    this.table = table
    this.column = column
  }
}

function isAllowedTable(name) {
  return (
    typeof name === 'string' &&
    name.startsWith(ALLOWED_PREFIX) &&
    name.length > ALLOWED_PREFIX.length &&
    IDENT_RE.test(name)
  )
}

function assertTable(name) {
  if (!isAllowedTable(name)) {
    throw new ScopeViolationError(
      `plugin-integration-core: table "${name}" is outside the "${ALLOWED_PREFIX}" scope`,
      { table: name },
    )
  }
  return name
}

function assertColumn(name) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new ScopeViolationError(
      `plugin-integration-core: invalid column identifier "${name}"`,
      { column: name },
    )
  }
  return name
}

function quoteIdent(name) {
  // Identifier has already passed the whitelist; surround with double quotes
  // so Postgres treats it as a plain identifier (also defends against any
  // future reserved-word collision).
  return `"${name}"`
}

function buildWhereClause(where, startParamIndex) {
  if (!where || typeof where !== 'object' || Array.isArray(where)) {
    return { sql: '', params: [], nextIndex: startParamIndex }
  }
  const parts = []
  const params = []
  let idx = startParamIndex
  for (const rawCol of Object.keys(where)) {
    const col = assertColumn(rawCol)
    const val = where[rawCol]
    if (val === null || val === undefined) {
      parts.push(`${quoteIdent(col)} IS NULL`)
      continue
    }
    parts.push(`${quoteIdent(col)} = $${idx}`)
    params.push(val)
    idx += 1
  }
  return {
    sql: parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '',
    params,
    nextIndex: idx,
  }
}

/**
 * Build a scoped DB helper on top of `context.api.database`.
 * The returned object never exposes `rawQuery`. Every method validates table
 * and column identifiers before building SQL.
 */
function createDb({ database, logger } = {}) {
  if (!database || typeof database.query !== 'function') {
    throw new Error('createDb: context.api.database is required')
  }

  async function select(table, { where, orderBy, limit = 1000, offset = 0 } = {}) {
    const tableIdent = quoteIdent(assertTable(table))
    const whereClause = buildWhereClause(where, 1)
    let orderSql = ''
    if (orderBy) {
      const [col, dir] = Array.isArray(orderBy) ? orderBy : [orderBy, 'ASC']
      orderSql = ` ORDER BY ${quoteIdent(assertColumn(col))} ${dir === 'DESC' ? 'DESC' : 'ASC'}`
    }
    const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 1000
    const off = Number.isInteger(offset) && offset >= 0 ? offset : 0
    const sql = `SELECT * FROM ${tableIdent}${whereClause.sql}${orderSql} LIMIT ${lim} OFFSET ${off}`
    return database.query(sql, whereClause.params)
  }

  async function selectOne(table, where) {
    if (!where || typeof where !== 'object') {
      throw new Error('selectOne: where clause is required')
    }
    const result = await select(table, { where, limit: 1 })
    // Host runtime returns rows as an array directly
    // (types/plugin.ts:685 DatabaseQueryResult = Record<string, unknown>[];
    // src/index.ts:324 `return (await pool.query(...)).rows`).
    // We defensively also accept the `{ rows: [...] }` shape in case the
    // caller supplies a different database binding.
    const rows = Array.isArray(result)
      ? result
      : (result && Array.isArray(result.rows) ? result.rows : [])
    return rows[0] || null
  }

  async function insertOne(table, row) {
    const tableIdent = quoteIdent(assertTable(table))
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('insertOne: row must be a plain object')
    }
    const cols = Object.keys(row)
    if (cols.length === 0) throw new Error('insertOne: row must have at least one column')
    const colIdents = cols.map((c) => quoteIdent(assertColumn(c))).join(', ')
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    const values = cols.map((c) => row[c])
    const sql = `INSERT INTO ${tableIdent} (${colIdents}) VALUES (${placeholders}) RETURNING *`
    return database.query(sql, values)
  }

  async function insertMany(table, rows) {
    if (!Array.isArray(rows)) throw new Error('insertMany: rows must be an array')
    if (rows.length === 0) return []
    const tableIdent = quoteIdent(assertTable(table))
    // Deterministic column order from the first row; subsequent rows must
    // have the same keyset. This keeps the query plan stable and surfaces
    // schema-drift callers immediately.
    const cols = Object.keys(rows[0])
    if (cols.length === 0) throw new Error('insertMany: rows[0] must have at least one column')
    for (const col of cols) assertColumn(col)
    const colIdents = cols.map((c) => quoteIdent(c)).join(', ')
    const params = []
    const valueTuples = rows.map((row, rowIdx) => {
      if (!row || typeof row !== 'object') {
        throw new Error(`insertMany: rows[${rowIdx}] is not an object`)
      }
      const rowCols = Object.keys(row)
      if (rowCols.length !== cols.length || !cols.every((c) => Object.prototype.hasOwnProperty.call(row, c))) {
        throw new Error(`insertMany: rows[${rowIdx}] has inconsistent keys`)
      }
      const placeholders = cols.map((c) => {
        params.push(row[c])
        return `$${params.length}`
      })
      return `(${placeholders.join(', ')})`
    })
    const sql = `INSERT INTO ${tableIdent} (${colIdents}) VALUES ${valueTuples.join(', ')} RETURNING *`
    return database.query(sql, params)
  }

  async function updateRow(table, set, where) {
    const tableIdent = quoteIdent(assertTable(table))
    if (!set || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length === 0) {
      throw new Error('updateRow: set must be a non-empty object')
    }
    if (!where || typeof where !== 'object' || Array.isArray(where) || Object.keys(where).length === 0) {
      throw new Error('updateRow: where must be a non-empty object (refusing unbounded UPDATE)')
    }
    const setCols = Object.keys(set)
    const params = []
    const setPairs = setCols.map((col) => {
      params.push(set[col])
      return `${quoteIdent(assertColumn(col))} = $${params.length}`
    })
    const whereClause = buildWhereClause(where, params.length + 1)
    params.push(...whereClause.params)
    const sql = `UPDATE ${tableIdent} SET ${setPairs.join(', ')}${whereClause.sql} RETURNING *`
    return database.query(sql, params)
  }

  async function deleteRows(table, where) {
    const tableIdent = quoteIdent(assertTable(table))
    if (!where || typeof where !== 'object' || Array.isArray(where) || Object.keys(where).length === 0) {
      throw new Error('deleteRows: where must be a non-empty object (refusing unbounded DELETE)')
    }
    const whereClause = buildWhereClause(where, 1)
    const sql = `DELETE FROM ${tableIdent}${whereClause.sql} RETURNING *`
    return database.query(sql, whereClause.params)
  }

  async function countRows(table, where) {
    const tableIdent = quoteIdent(assertTable(table))
    const whereClause = buildWhereClause(where, 1)
    const sql = `SELECT COUNT(*)::int AS count FROM ${tableIdent}${whereClause.sql}`
    const result = await database.query(sql, whereClause.params)
    // Host runtime returns rows directly as an array (see selectOne note).
    const rows = Array.isArray(result)
      ? result
      : (result && Array.isArray(result.rows) ? result.rows : [])
    return rows[0] ? Number(rows[0].count) || 0 : 0
  }

  async function transaction(callback) {
    if (typeof database.transaction !== 'function') {
      throw new Error('transaction: underlying database.transaction is not available')
    }
    return database.transaction(async (trx) => {
      // Wrap the transaction object with the same structured API so callers
      // inside a transaction still cannot use raw SQL.
      const scoped = createDb({
        database: {
          query: (...args) => trx.query(...args),
          transaction: database.transaction.bind(database),
        },
      })
      return callback({
        select: scoped.select,
        selectOne: scoped.selectOne,
        insertOne: scoped.insertOne,
        insertMany: scoped.insertMany,
        updateRow: scoped.updateRow,
        deleteRows: scoped.deleteRows,
        countRows: scoped.countRows,
        commit: () => trx.commit(),
        rollback: () => trx.rollback(),
      })
    })
  }

  return {
    ALLOWED_PREFIX,
    select,
    selectOne,
    insertOne,
    insertMany,
    updateRow,
    deleteRows,
    countRows,
    transaction,
  }
}

module.exports = {
  createDb,
  ScopeViolationError,
  ALLOWED_PREFIX,
  // Exposed for tests only.
  __internals: {
    isAllowedTable,
    assertTable,
    assertColumn,
    buildWhereClause,
    quoteIdent,
    IDENT_RE,
  },
}
