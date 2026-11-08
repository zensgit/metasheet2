'use strict'

// Test kit for the 批次标识 (pull batch) ledger — lib/stock-preparation-pull-batch-store.cjs over migration 105.
// Not a suite (lives under support/, so the chain-completeness walk does not see it).
//
// A FAITHFUL fake of the scoped db helper (lib/db.cjs) over the FOUR tables of migration 105 — and, opt-in, the sheet
// write lock's row (migration 100), so ONE fake serves the store AND the lock's in-transaction holder assert:
//   * equality WHERE with null meaning IS NULL, ORDER BY one column, LIMIT / OFFSET, SELECT *;
//   * NOT NULL / DEFAULT / enum CHECKs PARSED FROM THE MIGRATION TEXT itself (so the fake cannot drift from the SQL);
//   * the shape CHECKs that are not enum lists, and every UNIQUE index (partial predicates included), by hand — the
//     suite cross-checks every name against the SQL;
//   * a transaction whose throw ROLLS BACK (snapshot / restore); overlapping transactions are refused (use the real-DB
//     cases for interleavings); `selectOneForUpdate` is logged (row locks are not modelled);
//   * per-method fault injection (`faults[method] = error | (args) => error`) and a statement log.
// `withoutUniqueIndexes: [...]` builds the fake WITHOUT a named index — the in-memory mutation probe.
// Every value is synthetic.

const fs = require('node:fs')
const path = require('node:path')

const MIGRATIONS = path.join(__dirname, '..', '..', '..', '..', 'packages', 'core-backend', 'migrations')
const MIGRATION_FILES = Object.freeze({
  pullBatch: path.join(MIGRATIONS, '105_create_integration_stock_prep_pull_batch.sql'),
  lock: path.join(MIGRATIONS, '100_create_integration_stock_prep_project_write_lock.sql'),
})
const T = Object.freeze({
  settings: 'integration_stock_prep_pull_batch_settings',
  sheet: 'integration_stock_prep_pull_batch_sheet',
  batch: 'integration_stock_prep_pull_batch',
  execution: 'integration_stock_prep_pull_batch_execution',
  lock: 'integration_stock_prep_project_write_lock',
})

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function sqlError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

function readMigrationText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

function stripComments(sql) {
  return sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n')
}

function parseDefault(text) {
  if (text === undefined) return undefined
  const value = text.trim()
  if (/^now\(\)$/i.test(value)) return { kind: 'now' }
  if (value === 'true') return { kind: 'literal', value: true }
  if (value === 'false') return { kind: 'literal', value: false }
  if (/^-?\d+$/.test(value)) return { kind: 'literal', value: Number(value) }
  const quoted = value.match(/^'([^']*)'$/)
  if (quoted) return { kind: 'literal', value: quoted[1] }
  throw new Error(`pull-batch kit: unparsed DEFAULT "${value}"`)
}

function parseEnumList(text) {
  return Array.from(text.matchAll(/'([^']+)'/g)).map((match) => match[1])
}

/** `{ [table]: { columns: { name: { type, notNull, default, primaryKey } }, enums: [...] } }` from the SQL text. */
function parseSchema(sql) {
  const text = stripComments(sql)
  const out = {}
  const tableRe = /CREATE TABLE IF NOT EXISTS (integration_[a-z_]+) \(([\s\S]*?)\n\);/g
  for (const match of text.matchAll(tableRe)) {
    const [, table, body] = match
    const columns = {}
    const enums = []
    const parts = []
    let depth = 0
    let current = ''
    for (const ch of body) {
      if (ch === '(') depth += 1
      if (ch === ')') depth -= 1
      if (ch === ',' && depth === 0) {
        parts.push(current)
        current = ''
      } else {
        current += ch
      }
    }
    if (current.trim()) parts.push(current)
    for (const raw of parts) {
      const part = raw.replace(/\s+/g, ' ').trim()
      if (!part) continue
      const constraint = part.match(/^CONSTRAINT (\S+) (.*)$/)
      if (constraint) {
        const [, name, definition] = constraint
        const enumOnly = definition.match(/^CHECK \((\w+) IN \(([^)]*)\)\)$/)
        const enumNullable = definition.match(/^CHECK \((\w+) IS NULL OR \1 IN \(([^)]*)\)\)$/)
        if (enumOnly) enums.push({ name, column: enumOnly[1], values: parseEnumList(enumOnly[2]), nullable: false })
        else if (enumNullable) enums.push({ name, column: enumNullable[1], values: parseEnumList(enumNullable[2]), nullable: true })
        continue
      }
      const column = part.match(/^(\w+) (TEXT|INTEGER|BIGINT|BOOLEAN|NUMERIC|JSONB|TIMESTAMPTZ|DATE)(.*)$/)
      if (!column) throw new Error(`pull-batch kit: unparsed column "${part}" in ${table}`)
      const [, name, type, rest] = column
      const defaultMatch = rest.match(/DEFAULT ([^ ]+(?:\(\))?)/)
      columns[name] = {
        type,
        primaryKey: /PRIMARY KEY/.test(rest),
        notNull: /NOT NULL/.test(rest) || /PRIMARY KEY/.test(rest),
        default: parseDefault(defaultMatch ? defaultMatch[1] : undefined),
      }
    }
    out[table] = { columns, enums }
  }
  return out
}

function loadSchema({ lockTable = false } = {}) {
  return {
    ...parseSchema(readMigrationText(MIGRATION_FILES.pullBatch)),
    ...(lockTable ? parseSchema(readMigrationText(MIGRATION_FILES.lock)) : {}),
  }
}

const isNull = (value) => value === null || value === undefined

// The unique indexes migration 105 installs (the store suite cross-checks every name against the SQL).
const UNIQUE_INDEXES = Object.freeze([
  { table: T.sheet, name: 'uniq_integration_stock_prep_pull_batch_sheet', columns: ['sheet_id', 'project_no'] },
  { table: T.batch, name: 'uniq_integration_stock_prep_pull_batch_no', columns: ['sheet_id', 'project_no', 'batch_no'], where: (row) => row.status !== 'void' },
  { table: T.batch, name: 'uniq_integration_stock_prep_pull_batch_open', columns: ['sheet_id', 'project_no'], where: (row) => row.status === 'open' },
  { table: T.execution, name: 'uniq_integration_stock_prep_pull_batch_execution_ref', columns: ['execution_ref'] },
])

// The CHECKs that are not plain enum lists (the enum lists are parsed from the SQL).
const SHAPE_CHECKS = Object.freeze([
  { table: T.settings, name: 'integration_stock_prep_pull_batch_settings_version_check', test: (r) => Number.isInteger(r.version) && r.version >= 0 },
  { table: T.sheet, name: 'integration_stock_prep_pull_batch_sheet_version_check', test: (r) => Number.isInteger(r.version) && r.version >= 0 },
  {
    table: T.sheet,
    name: 'integration_stock_prep_pull_batch_sheet_lock_check',
    test: (r) => !['installing', 'backfilled'].includes(r.history_status) || !isNull(r.settings_locked_at),
  },
  { table: T.sheet, name: 'integration_stock_prep_pull_batch_sheet_count_check', test: (r) => isNull(r.history_batch_count) || r.history_batch_count >= 0 },
  {
    table: T.sheet,
    name: 'integration_stock_prep_pull_batch_sheet_resolved_check',
    test: (r) => (r.history_status === 'pending' && isNull(r.resolved_at))
      || (['born_empty', 'backfilled'].includes(r.history_status) && !isNull(r.resolved_at) && !isNull(r.history_batch_count) && !isNull(r.history_mode))
      || r.history_status === 'installing',
  },
  { table: T.batch, name: 'integration_stock_prep_pull_batch_batch_no_check', test: (r) => Number.isInteger(r.batch_no) && r.batch_no >= 1 },
  { table: T.batch, name: 'integration_stock_prep_pull_batch_closed_check', test: (r) => (r.status === 'open') === isNull(r.closed_at) },
  { table: T.batch, name: 'integration_stock_prep_pull_batch_inferred_check', test: (r) => r.origin === 'live' || r.status === 'closed' },
  { table: T.batch, name: 'integration_stock_prep_pull_batch_digest_check', test: (r) => (r.origin === 'live') === !isNull(r.source_digest) },
  { table: T.batch, name: 'integration_stock_prep_pull_batch_evidence_check', test: (r) => ((r.origin === 'backfill_inferred') === !isNull(r.evidence)) && (isNull(r.evidence) || ['plan_time', 'created_at'].includes(r.evidence)) },
  { table: T.execution, name: 'integration_stock_prep_pull_batch_execution_count_check', test: (r) => isNull(r.created_row_count) || r.created_row_count >= 0 },
])

function matches(row, where) {
  return Object.entries(where || {}).every(([column, expected]) => {
    if (isNull(expected)) return isNull(row[column])
    return row[column] === expected
  })
}

function compareValues(left, right) {
  if (isNull(left) && isNull(right)) return 0
  if (isNull(left)) return 1
  if (isNull(right)) return -1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left) < String(right) ? -1 : (String(left) > String(right) ? 1 : 0)
}

function createFakePullBatchDb({ withoutUniqueIndexes = [], clock, lockTable = false } = {}) {
  const schema = loadSchema({ lockTable })
  const nowIso = () => (clock && typeof clock.now === 'function' ? clock.now() : new Date()).toISOString()
  for (const name of withoutUniqueIndexes) {
    if (!UNIQUE_INDEXES.some((index) => index.name === name)) throw new Error(`pull-batch kit: unknown unique index ${name}`)
  }
  const uniques = UNIQUE_INDEXES.filter((index) => !withoutUniqueIndexes.includes(index.name))
  const tables = new Map(Object.keys(schema).map((name) => [name, new Map()]))
  const faults = {}
  const log = []
  let inTransaction = false

  function table(name) {
    if (!tables.has(name)) throw sqlError('42P01', `relation "${name}" does not exist`)
    return tables.get(name)
  }

  async function enter(method, args, prefix) {
    log.push([`${prefix}${method}`, clone(args)])
    const fault = faults[method]
    if (fault instanceof Error) {
      delete faults[method]
      throw fault
    }
    if (typeof fault === 'function') {
      const error = fault(args)
      if (error) throw error
    }
  }

  function applyDefaults(name, row) {
    const { columns } = schema[name]
    const out = { ...row }
    for (const [column, meta] of Object.entries(columns)) {
      if (out[column] === undefined) {
        if (meta.default && meta.default.kind === 'now') out[column] = nowIso()
        else if (meta.default && meta.default.kind === 'literal') out[column] = meta.default.value
        else out[column] = null
      }
    }
    for (const column of Object.keys(row)) {
      if (!columns[column]) throw sqlError('42703', `column "${column}" of relation "${name}" does not exist`)
    }
    return out
  }

  function validate(name, row, { excludeKey } = {}) {
    const { columns, enums } = schema[name]
    for (const [column, meta] of Object.entries(columns)) {
      if (meta.notNull && isNull(row[column])) throw sqlError('23502', `null value in column "${column}" violates not-null constraint`, { column })
    }
    for (const entry of enums) {
      const value = row[entry.column]
      if (isNull(value)) {
        if (!entry.nullable) throw sqlError('23514', `check constraint "${entry.name}"`, { constraint: entry.name })
        continue
      }
      if (!entry.values.includes(value)) throw sqlError('23514', `check constraint "${entry.name}"`, { constraint: entry.name })
    }
    for (const check of SHAPE_CHECKS) {
      if (check.table === name && !check.test(row)) throw sqlError('23514', `check constraint "${check.name}"`, { constraint: check.name })
    }
    for (const index of uniques) {
      if (index.table !== name) continue
      if (index.where && !index.where(row)) continue
      for (const [key, other] of table(name).entries()) {
        if (key === excludeKey) continue
        if (index.where && !index.where(other)) continue
        if (index.columns.every((column) => !isNull(row[column]) && other[column] === row[column])) {
          throw sqlError('23505', `duplicate key value violates unique constraint "${index.name}"`, { constraint: index.name })
        }
      }
    }
  }

  function primaryKeyOf(name) {
    const entry = Object.entries(schema[name].columns).find(([, meta]) => meta.primaryKey)
    return entry ? entry[0] : 'id'
  }

  function selectRows(name, { where, orderBy, limit = 1000, offset = 0 } = {}) {
    let rows = Array.from(table(name).values()).filter((row) => matches(row, where))
    if (orderBy) {
      const [column, direction] = Array.isArray(orderBy) ? orderBy : [orderBy, 'ASC']
      const sign = direction === 'DESC' ? -1 : 1
      rows = rows.slice().sort((left, right) => sign * compareValues(left[column], right[column]))
    }
    const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 1000
    const off = Number.isInteger(offset) && offset >= 0 ? offset : 0
    return rows.slice(off, off + lim).map(clone)
  }

  function insertRow(name, row) {
    const stored = applyDefaults(name, clone(row))
    validate(name, stored)
    const key = stored[primaryKeyOf(name)]
    if (table(name).has(key)) throw sqlError('23505', `duplicate key value violates unique constraint "${name}_pkey"`, { constraint: `${name}_pkey` })
    table(name).set(key, stored)
    return clone(stored)
  }

  function makeApi(prefix) {
    return {
      async select(name, options = {}) {
        await enter('select', { table: name, ...options }, prefix)
        return selectRows(name, options)
      },
      async selectOne(name, where) {
        await enter('selectOne', { table: name, where }, prefix)
        return selectRows(name, { where, limit: 1 })[0] || null
      },
      async selectOneForUpdate(name, where) {
        await enter('selectOneForUpdate', { table: name, where }, prefix)
        return selectRows(name, { where, limit: 1 })[0] || null
      },
      async insertOne(name, row) {
        await enter('insertOne', { table: name, row }, prefix)
        return [insertRow(name, row)]
      },
      async updateRow(name, set, where) {
        await enter('updateRow', { table: name, set, where }, prefix)
        if (!where || Object.keys(where).length === 0) throw new Error('updateRow: where must be non-empty')
        const out = []
        for (const [key, row] of table(name).entries()) {
          if (!matches(row, where)) continue
          for (const column of Object.keys(set)) {
            if (!schema[name].columns[column]) throw sqlError('42703', `column "${column}" of relation "${name}" does not exist`)
          }
          const next = { ...row, ...clone(set) }
          validate(name, next, { excludeKey: key })
          table(name).set(key, next)
          out.push(clone(next))
        }
        return out
      },
      async countRows(name, where) {
        await enter('countRows', { table: name, where }, prefix)
        return selectRows(name, { where, limit: 10000 }).length
      },
    }
  }

  const autocommit = makeApi('')
  const db = {
    tables,
    faults,
    log,
    schema,
    uniqueIndexes: uniques,
    rows(name) {
      return Array.from(table(name).values()).map(clone)
    },
    statements(prefix = '') {
      return log.filter(([method]) => method.startsWith(prefix)).map(([method, args]) => [method, args && args.table])
    },
    /** Put a row straight into a table (a test fixture: what BI-2's install / birth will write). Validated. */
    seed(name, row) {
      return insertRow(name, row)
    },
    ...autocommit,
    async transaction(callback) {
      await enter('transaction', {}, '')
      if (inTransaction) throw new Error('pull-batch kit: overlapping transactions are not modelled (use the real-DB cases for interleavings)')
      inTransaction = true
      const snapshot = new Map(Array.from(tables.entries()).map(([name, rows]) => [name, new Map(Array.from(rows.entries()).map(([key, row]) => [key, clone(row)]))]))
      const handle = {
        ...makeApi('trx.'),
        async setLocalLockTimeout(ms) {
          await enter('setLocalLockTimeout', { ms }, 'trx.')
          if (!Number.isInteger(ms) || ms <= 0 || ms > 30000) throw new Error('setLocalLockTimeout: integer 1..30000 required')
        },
      }
      db.lastTransactionHandle = handle
      try {
        const result = await callback(handle)
        const commitFault = faults.commit
        if (commitFault instanceof Error) {
          delete faults.commit
          throw commitFault
        }
        log.push(['commit', {}])
        return result
      } catch (error) {
        for (const [name, rows] of snapshot.entries()) tables.set(name, rows)
        log.push(['rollback', {}])
        throw error
      } finally {
        inTransaction = false
      }
    },
  }
  return db
}

function createClock(startIso = '2026-10-27T01:00:00.000Z') {
  let ms = Date.parse(startIso)
  return {
    now: () => new Date(ms),
    advance(deltaMs) { ms += deltaMs },
    set(iso) { ms = Date.parse(iso) },
    iso: () => new Date(ms).toISOString(),
  }
}

/** A `_sheet` row as BI-2's birth / install will write it (resolved unless told otherwise). */
function sheetRow({
  id = 'pbs_syn_1', tenantId, sheetId, projectNo, status = 'born_empty', locale = 'zh-CN', historyBatchCount = 0, historyMode = 'inferred',
  rule = 'material', labelFormat = 'ordinal_date', placement = 'left', landing = null, lockedAt, resolvedAt, historyPlan = null,
  version = 0, at = '2026-10-27T00:00:00.000Z',
} = {}) {
  const resolved = status === 'born_empty' || status === 'backfilled'
  const locked = lockedAt !== undefined ? lockedAt : ((status === 'installing' || status === 'backfilled') ? at : null)
  return {
    id,
    tenant_id: tenantId,
    sheet_id: sheetId,
    project_no: projectNo,
    history_status: status,
    label_locale: locale,
    first_pull_batch_rule: rule,
    label_format: labelFormat,
    band_placement: placement,
    landing_mode: landing,
    settings_locked_at: locked,
    history_mode: resolved ? historyMode : null,
    history_batch_count: resolved ? historyBatchCount : null,
    history_plan: historyPlan,
    history_plan_digest: null,
    approval_ref: null,
    installed_at: null,
    installed_by: null,
    resolved_at: resolvedAt !== undefined ? resolvedAt : (resolved ? at : null),
    resolved_by: resolved ? 'syn_seed' : null,
    version,
    created_at: at,
    updated_at: at,
  }
}

module.exports = {
  MIGRATION_FILES,
  SHAPE_CHECKS,
  T,
  UNIQUE_INDEXES,
  clone,
  createClock,
  createFakePullBatchDb,
  loadSchema,
  parseSchema,
  readMigrationText,
  sheetRow,
  sqlError,
}
