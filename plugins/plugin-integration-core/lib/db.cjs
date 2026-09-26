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

// Transaction isolation levels a caller may PIN on a transaction handle
// (`setTransactionIsolationLevel`), each mapped to the ONE fixed statement it renders. The level
// is a lookup key, never interpolated: anything outside this table is refused before any SQL is
// built. READ UNCOMMITTED is deliberately absent (PostgreSQL runs it as READ COMMITTED, so naming
// it would only mislead a reader).
const TRANSACTION_ISOLATION_STATEMENTS = Object.freeze({
  'read committed': 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
  'repeatable read': 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
  serializable: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
})

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

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
  )
}

function prepareParamValue(value) {
  // node-postgres treats JavaScript arrays as PostgreSQL array literals. That
  // breaks JSONB columns such as integration_pipelines.idempotency_key_fields
  // with 22P02 "invalid input syntax for type json". The integration_* schema
  // stores structured values as JSONB, so send arrays/plain objects as JSON
  // text and let PostgreSQL cast them to JSONB.
  if (Array.isArray(value) || isPlainObject(value)) return JSON.stringify(value)
  return value
}

function transactionIsolationStatement(level) {
  const statement = typeof level === 'string' && Object.prototype.hasOwnProperty.call(TRANSACTION_ISOLATION_STATEMENTS, level)
    ? TRANSACTION_ISOLATION_STATEMENTS[level]
    : null
  if (!statement) {
    throw new ScopeViolationError(
      'plugin-integration-core: transaction isolation level is not one of the whitelisted levels',
      {},
    )
  }
  return statement
}

function buildWhereClause(where, startParamIndex) {
  if (where === undefined || where === null) {
    return { sql: '', params: [], nextIndex: startParamIndex }
  }
  if (typeof where !== 'object' || Array.isArray(where)) {
    throw new ScopeViolationError('plugin-integration-core: where clause must be an object', {})
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
    params.push(prepareParamValue(val))
    idx += 1
  }
  return {
    sql: parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '',
    params,
    nextIndex: idx,
  }
}

function buildRangeClause(range, startParamIndex) {
  if (range === undefined || range === null) {
    return { sql: '', params: [], nextIndex: startParamIndex }
  }
  if (typeof range !== 'object' || Array.isArray(range)) {
    throw new ScopeViolationError('plugin-integration-core: range clause must be an object', {})
  }
  const parts = []
  const params = []
  let idx = startParamIndex
  for (const rawCol of Object.keys(range)) {
    const col = assertColumn(rawCol)
    const spec = range[rawCol]
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new ScopeViolationError('plugin-integration-core: range bound must be an object', { column: rawCol })
    }
    for (const key of Object.keys(spec)) {
      if (key !== 'gte' && key !== 'lte') {
        throw new ScopeViolationError('plugin-integration-core: range only supports gte/lte bounds', { column: rawCol })
      }
    }
    if (spec.gte !== undefined && spec.gte !== null) {
      parts.push(`${quoteIdent(col)} >= $${idx}`)
      params.push(prepareParamValue(spec.gte))
      idx += 1
    }
    if (spec.lte !== undefined && spec.lte !== null) {
      parts.push(`${quoteIdent(col)} <= $${idx}`)
      params.push(prepareParamValue(spec.lte))
      idx += 1
    }
  }
  return {
    sql: parts.join(' AND '),
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

  async function select(table, { where, range, orderBy, limit = 1000, offset = 0 } = {}) {
    const tableIdent = quoteIdent(assertTable(table))
    const whereClause = buildWhereClause(where, 1)
    const rangeClause = buildRangeClause(range, whereClause.nextIndex)
    const filters = []
    if (whereClause.sql) filters.push(whereClause.sql.slice(' WHERE '.length))
    if (rangeClause.sql) filters.push(rangeClause.sql)
    const filterSql = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : ''
    let orderSql = ''
    if (orderBy) {
      const [col, dir] = Array.isArray(orderBy) ? orderBy : [orderBy, 'ASC']
      orderSql = ` ORDER BY ${quoteIdent(assertColumn(col))} ${dir === 'DESC' ? 'DESC' : 'ASC'}`
    }
    const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 1000
    const off = Number.isInteger(offset) && offset >= 0 ? offset : 0
    const sql = `SELECT * FROM ${tableIdent}${filterSql}${orderSql} LIMIT ${lim} OFFSET ${off}`
    return database.query(sql, whereClause.params.concat(rangeClause.params))
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

  async function selectOneForUpdate(table, where) {
    const tableIdent = quoteIdent(assertTable(table))
    if (!where || typeof where !== 'object' || Array.isArray(where)) {
      throw new Error('selectOneForUpdate: where clause is required')
    }
    const whereClause = buildWhereClause(where, 1)
    const result = await database.query(
      `SELECT * FROM ${tableIdent}${whereClause.sql} LIMIT 1 FOR UPDATE`,
      whereClause.params,
    )
    const rows = Array.isArray(result)
      ? result
      : (result && Array.isArray(result.rows) ? result.rows : [])
    return rows[0] || null
  }

  /**
   * `SELECT ... LIMIT 1 FOR KEY SHARE` — the WRITER'S half of a row-existence lock protocol.
   *
   * Added under the module header's own extension clause ("added here as a new validated method"),
   * not as a raw-SQL escape hatch: the table and every where column pass the same identifier
   * whitelist as selectOneForUpdate, and every value is parameterized.
   *
   * WHY KEY SHARE and not FOR SHARE. A caller that is about to persist a POINTER at this row (a
   * stock-prep source binding, a read-source config version, a pipeline endpoint) needs exactly one
   * thing: that the row is not DELETED (nor has its key changed) between this read and the caller's
   * own COMMIT. FOR KEY SHARE conflicts with FOR UPDATE — which is what a delete-side guard takes and
   * what DELETE itself takes — and with nothing weaker: an ordinary UPDATE of a non-key column takes
   * FOR NO KEY UPDATE, which KEY SHARE does NOT block. So a binding being written never stalls an
   * admin renaming the same system, and vice versa. FOR SHARE would conflict with FOR NO KEY UPDATE
   * too, serializing pointer writes against every config edit for no protection gained. This is the
   * same lock PostgreSQL's own referential-integrity check takes on a referenced row, which is what
   * makes an application-level participant exactly as strong as a foreign key for THIS purpose,
   * on a table that deliberately carries none.
   *
   * Only meaningful INSIDE `transaction`: a lock taken in autocommit is released at statement end.
   * PostgreSQL requires UPDATE privilege on at least one column for any locking clause (same rule
   * that made migration 075 necessary for the sealed-export runtime role's FOR UPDATE).
   */
  async function selectOneForKeyShare(table, where) {
    const tableIdent = quoteIdent(assertTable(table))
    if (!where || typeof where !== 'object' || Array.isArray(where)) {
      throw new Error('selectOneForKeyShare: where clause is required')
    }
    const whereClause = buildWhereClause(where, 1)
    const result = await database.query(
      `SELECT * FROM ${tableIdent}${whereClause.sql} LIMIT 1 FOR KEY SHARE`,
      whereClause.params,
    )
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
    const values = cols.map((c) => prepareParamValue(row[c]))
    const sql = `INSERT INTO ${tableIdent} (${colIdents}) VALUES (${placeholders}) RETURNING *`
    return database.query(sql, values)
  }

  /**
   * Single-statement UPSERT on a UNIQUE key: INSERT … ON CONFLICT (cols) DO UPDATE.
   *
   * Added under the module header's own extension clause ("added here as a new validated method"),
   * not as a raw-SQL escape hatch: the table, every row column and every conflict column pass the
   * same identifier whitelist as insertOne/updateRow, and every value is parameterized.
   *
   * Why a real UPSERT rather than selectOne-then-insert/update: the select-then-write shape has a
   * race window in which two concurrent writers both see "absent" and the second INSERT dies on the
   * unique index. Ledgers that are keyed by a natural identity (see
   * integration_stock_prep_pack_installs) need the atomic form so a re-install is idempotent under
   * concurrency, which is exactly the discipline the after-sales install ledger uses.
   *
   * `conflictColumns` names the UNIQUE index columns. `updateColumns` defaults to every row column
   * that is not a conflict column; passing it narrows what a conflict may overwrite (an
   * insert-only-immutable column such as `created_at` stays out).
   */
  async function upsertOne(table, row, { conflictColumns, updateColumns } = {}) {
    const tableIdent = quoteIdent(assertTable(table))
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('upsertOne: row must be a plain object')
    }
    if (!Array.isArray(conflictColumns) || conflictColumns.length === 0) {
      throw new Error('upsertOne: conflictColumns must be a non-empty array (refusing an unkeyed UPSERT)')
    }
    const cols = Object.keys(row)
    if (cols.length === 0) throw new Error('upsertOne: row must have at least one column')
    const conflictIdents = conflictColumns.map((c) => quoteIdent(assertColumn(c)))
    const colIdents = cols.map((c) => quoteIdent(assertColumn(c))).join(', ')
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    const values = cols.map((c) => prepareParamValue(row[c]))
    const conflictSet = new Set(conflictColumns)
    const updatable = Array.isArray(updateColumns)
      ? updateColumns.filter((c) => !conflictSet.has(c))
      : cols.filter((c) => !conflictSet.has(c))
    if (updatable.length === 0) {
      throw new Error('upsertOne: no updatable column remains (use insertOne for insert-only writes)')
    }
    const setPairs = updatable
      .map((c) => `${quoteIdent(assertColumn(c))} = EXCLUDED.${quoteIdent(c)}`)
      .join(', ')
    const sql = `INSERT INTO ${tableIdent} (${colIdents}) VALUES (${placeholders})`
      + ` ON CONFLICT (${conflictIdents.join(', ')}) DO UPDATE SET ${setPairs} RETURNING *`
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
        params.push(prepareParamValue(row[c]))
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
      params.push(prepareParamValue(set[col]))
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
      /**
       * `SET TRANSACTION ISOLATION LEVEL <whitelisted level>` on THIS transaction.
       *
       * Added under the module header's extension clause ("added here as a new validated method"):
       * the level is a key into TRANSACTION_ISOLATION_STATEMENTS and the statement is a fixed
       * literal from that table — no caller text reaches the SQL, and nothing is parameterized
       * because nothing varies.
       *
       * It exists so a caller whose correctness DEPENDS on an isolation level can pin it instead of
       * inheriting whatever the server / database / role default is (a bare BEGIN inherits
       * `default_transaction_isolation`; `ALTER DATABASE ... SET default_transaction_isolation =
       * 'repeatable read'` silently changes every such transaction). The external-system delete
       * lock protocol is the first such caller (`external-system-pointer-lock.cjs`
       * pinLockProtocolIsolation).
       *
       * MUST be the transaction's FIRST statement. PostgreSQL enforces that itself: issued after any
       * query it fails with SQLSTATE 25001 and aborts the transaction — so a caller that gets the
       * order wrong fails closed, it never runs at the wrong level. Offered ONLY on the transaction
       * handle, never on the root helper: outside a transaction block PostgreSQL merely WARNS and
       * ignores it, which is exactly the silent no-op this method must never be.
       */
      async function setTransactionIsolationLevel(level) {
        const statement = transactionIsolationStatement(level)
        await trx.query(statement, [])
      }
      return callback({
        setTransactionIsolationLevel,
        select: scoped.select,
        selectOne: scoped.selectOne,
        selectOneForUpdate: scoped.selectOneForUpdate,
        selectOneForKeyShare: scoped.selectOneForKeyShare,
        insertOne: scoped.insertOne,
        upsertOne: scoped.upsertOne,
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
    selectOneForUpdate,
    selectOneForKeyShare,
    insertOne,
    upsertOne,
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
    buildRangeClause,
    quoteIdent,
    prepareParamValue,
    transactionIsolationStatement,
    TRANSACTION_ISOLATION_STATEMENTS,
    IDENT_RE,
  },
}
