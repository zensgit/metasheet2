'use strict'

// Test kit for the stock-preparation COMPONENT RULING STORE (lib/stock-preparation-component-ruling-store.cjs, migration
// 107). Not a suite (lives under support/, so the chain-completeness walk does not see it).
//
// A FAITHFUL fake of the scoped db helper (lib/db.cjs) over the ONE table of migration 107:
//   * the enum CHECKs (kind / basis / status) are PARSED FROM THE MIGRATION TEXT, so the fake cannot drift from the SQL;
//   * the shape CHECKs (digest / runbook / kind shape / revoked shape) are hand-modelled and cross-checked BY NAME
//     against the SQL by the store suite (CR-07);
//   * the partial UNIQUE index (sheet_id, project_no, component_digest, kind) WHERE status = 'active' -> 23505 with its name;
//   * NOT NULL columns refuse null (23502); `DEFAULT 'active'` / `now()` fill an omitted column;
//   * a transaction whose callback throws ROLLS BACK (snapshot / restore); overlapping transactions are refused;
//   * per-method fault injection (`failNext(method, error)`) and a statement log.
// Every value is synthetic.

const fs = require('node:fs')
const path = require('node:path')

const MIGRATION_107 = path.join(__dirname, '..', '..', '..', '..', 'packages', 'core-backend', 'migrations', '107_create_integration_stock_prep_component_ruling.sql')
const TABLE = 'integration_stock_prep_component_ruling'
const UNIQUE_INDEX = 'uniq_integration_stock_prep_component_ruling_active'

function migrationText() {
  return fs.readFileSync(MIGRATION_107, 'utf8').replace(/\r\n/g, '\n')
}

function sqlCode(sql) {
  return sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n')
}

/** The enum lists of 107, read from the SQL: `{ kind: [...], basis: [...], status: [...] }`. */
function parsedEnums() {
  const code = sqlCode(migrationText())
  const listOf = (constraint, column) => {
    const match = code.match(new RegExp(`CONSTRAINT ${constraint}\\s+CHECK \\((?:${column} IS NULL OR )?${column} IN \\(([^)]*)\\)\\)`))
    if (!match) throw new Error(`component ruling kit: enum CHECK ${constraint} not found in 107`)
    return Array.from(match[1].matchAll(/'([^']+)'/g)).map((entry) => entry[1])
  }
  return {
    kind: listOf(`${TABLE}_kind_check`, 'kind'),
    basis: listOf(`${TABLE}_basis_check`, 'basis'),
    status: listOf(`${TABLE}_status_check`, 'status'),
  }
}

/** The NOT NULL columns and the DEFAULTs of 107, read from the SQL. */
function parsedColumns() {
  const code = sqlCode(migrationText())
  const body = code.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${TABLE} \\(([\\s\\S]*?)\\n\\);`))
  if (!body) throw new Error('component ruling kit: the CREATE TABLE of 107 was not found')
  const columns = {}
  for (const raw of body[1].split('\n')) {
    const line = raw.trim()
    const match = line.match(/^([a-z_]+)\s+(TEXT|JSONB|TIMESTAMPTZ)\b(.*?),?$/)
    if (!match || line.startsWith('CONSTRAINT')) continue
    const [, name, , rest] = match
    const def = rest.match(/DEFAULT\s+('([^']*)'|now\(\))/)
    columns[name] = { notNull: /NOT NULL|PRIMARY KEY/.test(rest), default: def ? (def[1] === 'now()' ? { now: true } : { value: def[2] }) : undefined }
  }
  return columns
}

// The shape CHECKs that are not enum lists (cross-checked by name against 107 by the store suite).
const SHAPE_CHECKS = Object.freeze({
  [`${TABLE}_digest_shape_check`]: (row) => /^[0-9a-f]{24}$/.test(String(row.component_digest)),
  [`${TABLE}_runbook_ref_shape_check`]: (row) => /^[A-Za-z0-9._:-]{1,64}$/.test(String(row.runbook_ref)),
  [`${TABLE}_kind_shape_check`]: (row) => (
    (row.kind === 'remnant_acknowledged' && row.basis === 'head_not_ordered' && row.rules === null && row.position_fingerprint === null)
    || (row.kind === 'dropped_head_included' && row.basis === null && Array.isArray(row.rules) && typeof row.position_fingerprint === 'string' && /^[0-9a-f]{64}$/.test(row.position_fingerprint))),
  [`${TABLE}_revoked_shape_check`]: (row) => (
    (row.status === 'active' && row.revoked_by === null && row.revoked_at === null && row.revoked_runbook_ref === null)
    || (row.status === 'revoked' && row.revoked_by !== null && row.revoked_at !== null && typeof row.revoked_runbook_ref === 'string'
      && /^[A-Za-z0-9._:-]{1,64}$/.test(row.revoked_runbook_ref))),
})

function sqlError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function createComponentRulingFakeDb({ now = () => new Date('2026-11-10T00:00:00Z'), withoutUniqueIndex = false, tableMissing = false } = {}) {
  const enums = parsedEnums()
  const columns = parsedColumns()
  let rows = []
  const log = []
  const faults = new Map()
  let inTransaction = false

  function fault(method) {
    const queued = faults.get(method)
    if (queued && queued.length) {
      const error = queued.shift()
      throw error
    }
    if (tableMissing) throw sqlError('42P01', `relation "${TABLE}" does not exist`)
  }

  function assertTable(table) {
    if (table !== TABLE) throw new Error(`component ruling kit: unexpected table ${table}`)
  }

  const matches = (row, where = {}) => Object.entries(where).every(([column, value]) => (row[column] === undefined ? null : row[column]) === (value === undefined ? null : value))

  function validate(row) {
    for (const [name, spec] of Object.entries(columns)) {
      if (row[name] === undefined) row[name] = spec.default ? (spec.default.now ? now() : spec.default.value) : null
      if (spec.notNull && (row[name] === null || row[name] === undefined)) throw sqlError('23502', `null value in column "${name}"`, { column: name })
    }
    for (const name of Object.keys(row)) if (!(name in columns)) throw sqlError('42703', `column "${name}" does not exist`)
    if (!enums.kind.includes(row.kind)) throw sqlError('23514', 'kind check', { constraint: `${TABLE}_kind_check` })
    if (row.basis !== null && !enums.basis.includes(row.basis)) throw sqlError('23514', 'basis check', { constraint: `${TABLE}_basis_check` })
    if (!enums.status.includes(row.status)) throw sqlError('23514', 'status check', { constraint: `${TABLE}_status_check` })
    for (const [constraint, ok] of Object.entries(SHAPE_CHECKS)) if (!ok(row)) throw sqlError('23514', constraint, { constraint })
    return row
  }

  function assertUnique(candidate, ignoreId = null) {
    if (withoutUniqueIndex || candidate.status !== 'active') return
    const clash = rows.find((row) => row.id !== ignoreId && row.status === 'active' && row.sheet_id === candidate.sheet_id
      && row.project_no === candidate.project_no && row.component_digest === candidate.component_digest && row.kind === candidate.kind)
    if (clash) throw sqlError('23505', 'duplicate key value violates unique constraint', { constraint: UNIQUE_INDEX })
  }

  const api = {
    async select(table, { where, orderBy, limit = 1000 } = {}) {
      log.push(['select', table, clone(where)])
      fault('select')
      assertTable(table)
      let found = rows.filter((row) => matches(row, where))
      if (orderBy) {
        const [column, dir] = Array.isArray(orderBy) ? orderBy : [orderBy, 'ASC']
        found = found.slice().sort((a, b) => {
          const left = a[column] instanceof Date ? a[column].getTime() : a[column]
          const right = b[column] instanceof Date ? b[column].getTime() : b[column]
          return (left < right ? -1 : left > right ? 1 : 0) * (dir === 'DESC' ? -1 : 1)
        })
      }
      return found.slice(0, limit).map(clone)
    },
    async insertOne(table, row) {
      log.push(['insertOne', table])
      fault('insertOne')
      assertTable(table)
      const candidate = validate(clone(row))
      if (rows.some((existing) => existing.id === candidate.id)) throw sqlError('23505', 'pk', { constraint: `${TABLE}_pkey` })
      assertUnique(candidate)
      rows.push(candidate)
      return [clone(candidate)]
    },
    async selectOneForUpdate(table, where) {
      log.push(['selectOneForUpdate', table, clone(where)])
      fault('selectOneForUpdate')
      assertTable(table)
      if (!inTransaction) throw new Error('component ruling kit: FOR UPDATE outside a transaction')
      const found = rows.find((row) => matches(row, where))
      return found ? clone(found) : null
    },
    async updateRow(table, set, where) {
      log.push(['updateRow', table, clone(where)])
      fault('updateRow')
      assertTable(table)
      const hit = rows.filter((row) => matches(row, where))
      const out = []
      for (const row of hit) {
        const next = validate({ ...clone(row), ...clone(set) })
        assertUnique(next, row.id)
        Object.assign(row, next)
        out.push(clone(row))
      }
      return out
    },
    async transaction(fn) {
      log.push(['transaction'])
      fault('transaction')
      if (inTransaction) throw new Error('component ruling kit: overlapping transactions are not modelled')
      inTransaction = true
      const snapshot = clone(rows)
      try {
        return await fn({ ...api, advisoryXactLock: async () => {}, isTransaction: true })
      } catch (error) {
        rows = snapshot
        throw error
      } finally {
        inTransaction = false
      }
    },
  }
  return {
    db: api,
    log,
    rows: () => rows.map(clone),
    seed(row) { rows.push(validate(clone(row))) },
    failNext(method, error) { if (!faults.has(method)) faults.set(method, []); faults.get(method).push(error) },
  }
}

module.exports = {
  MIGRATION_107,
  TABLE,
  UNIQUE_INDEX,
  SHAPE_CHECKS,
  migrationText,
  sqlCode,
  parsedEnums,
  parsedColumns,
  createComponentRulingFakeDb,
}
