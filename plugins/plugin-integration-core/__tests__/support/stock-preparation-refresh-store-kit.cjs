'use strict'

// Test kit for the stock-preparation REFRESH STORE (lib/stock-preparation-continuation-store.cjs) and the
// governance reader (lib/stock-preparation-refresh-governance.cjs). Not a suite (lives under support/, so
// the chain-completeness walk does not see it).
//
// It holds:
//   1. a FAITHFUL fake of the scoped db helper (lib/db.cjs) over the FIVE step-4 tables of migrations 102 /
//      103 (plus the registry table of 087 / 101, columns only, so PR B's pilot reads can run on the consult's
//      snapshot handle — review X-1; `registryPilotColumns: false` is a database without migration 101):
//      equality WHERE with null meaning IS NULL, ORDER BY one column, LIMIT / OFFSET, SELECT *, PRIMARY
//      KEY and every UNIQUE index of the two migrations modelled EXACTLY (name, columns, partial predicate ->
//      23505 with the constraint name), NOT NULL / DEFAULT / enum CHECKs PARSED FROM THE MIGRATION TEXT
//      itself (so the fake cannot drift from the SQL), the shape CHECKs that are not enum lists modelled by
//      hand, `upsertOne`, `insertMany`, a transaction whose throw ROLLS BACK (snapshot / restore), per-method
//      fault injection and a statement log. Row locks are NOT modelled (`selectOneForUpdate` is logged; the
//      real-DB cases prove the serialisation) and overlapping transactions are refused by the fake, so a
//      hermetic suite can never accidentally pass on an interleaving PostgreSQL would not run.
//      `withoutUniqueIndexes: [...]` builds the fake WITHOUT a named index — the in-memory mutation probe
//      "drop a partial unique index" (design §19 PR-2).
//   2. a fake `bumpWithin` (the lock's in-transaction generation bump PR-4 adds) that records its calls and
//      can be told to refuse the way the lock refuses (409 WRITE_LOCKED).
//   3. a REAL `continuation_candidate` hold from the pure core over the canonical S/P fixtures (a real
//      expansion with the #6502 recorder on, the real planner): what the store is fed in production.
// Every value is synthetic.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', '..', 'lib')
const MIGRATIONS = path.join(__dirname, '..', '..', '..', '..', 'packages', 'core-backend', 'migrations')
const MIGRATION_FILES = Object.freeze({
  continuation: path.join(MIGRATIONS, '102_create_integration_stock_prep_continuation.sql'),
  refreshState: path.join(MIGRATIONS, '103_create_integration_stock_prep_refresh_state.sql'),
  // The registry (PR B's pilot reads run on the consult's snapshot handle, review X-1): 087's table plus the
  // three pilot columns migration 101 adds.
  registry: path.join(MIGRATIONS, '087_create_integration_stock_prep_project_target.sql'),
  registryPilot: path.join(MIGRATIONS, '101_add_stock_prep_project_target_pilot_columns_and_audit_pilot_enable.sql'),
  // PR-4: the sheet write lock's row (migration 100), so ONE fake db can serve the store AND the lock — the
  // decision transactions bump the generation on the store's transaction handle (`bumpGenerationWithin`).
  lock: path.join(MIGRATIONS, '100_create_integration_stock_prep_project_write_lock.sql'),
})
const REGISTRY_TABLE = 'integration_stock_prep_project_target'

const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const { REFRESH_STORE_TABLES: T } = storeModule

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function sqlError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

// ---------------------------------------------------------------------------------------------------
// 1a. The schema, read from the migration text (NOT NULL / DEFAULT / enum CHECK), plus the hand-modelled
//     shape CHECKs and the unique indexes.
// ---------------------------------------------------------------------------------------------------

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
  throw new Error(`refresh-store kit: unparsed DEFAULT "${value}"`)
}

function parseEnumList(text) {
  return Array.from(text.matchAll(/'([^']+)'/g)).map((match) => match[1])
}

/** `{ [table]: { columns: { name: { notNull, default } }, enums: [{ column, values, nullable }] } }` */
function parseSchema(sql) {
  const text = stripComments(sql)
  const out = {}
  const tableRe = /CREATE TABLE IF NOT EXISTS (integration_[a-z_]+) \(([\s\S]*?)\n\);/g
  for (const match of text.matchAll(tableRe)) {
    const [, table, body] = match
    const columns = {}
    const enums = []
    // Split the body at top-level commas.
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
        const unique = definition.match(/^UNIQUE \(([^)]*)\)$/)
        if (unique) enums.push({ name, unique: unique[1].split(',').map((column) => column.trim()) })
        continue
      }
      const column = part.match(/^(\w+) (TEXT|INTEGER|BOOLEAN|NUMERIC|JSONB|TIMESTAMPTZ|DATE)(.*)$/)
      if (!column) throw new Error(`refresh-store kit: unparsed column "${part}" in ${table}`)
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

/**
 * The five step-4 tables (102 / 103) and the registry table. The registry is 087's columns plus — unless
 * `registryPilotColumns: false` (a database where migration 101 has not run) — the columns 101 ADDs, parsed from
 * its `ADD COLUMN IF NOT EXISTS` lines. The registry's CHECKs and unique indexes are NOT modelled (later
 * migrations re-list its CHECKs; the suites only read it through PR B's pilot reads).
 */
function loadSchema({ registryPilotColumns = true, lockTable = false } = {}) {
  const registry = parseSchema(readMigrationText(MIGRATION_FILES.registry))
  if (!registry[REGISTRY_TABLE]) throw new Error('refresh-store kit: migration 087 no longer creates the registry table')
  registry[REGISTRY_TABLE].enums = []
  if (registryPilotColumns) {
    const text = stripComments(readMigrationText(MIGRATION_FILES.registryPilot))
    const added = Array.from(text.matchAll(/ADD COLUMN IF NOT EXISTS (\w+) (TEXT|INTEGER|TIMESTAMPTZ|BOOLEAN)\b/g))
    if (added.length !== 3) throw new Error(`refresh-store kit: migration 101 adds ${added.length} registry columns, expected 3`)
    for (const [, name, type] of added) registry[REGISTRY_TABLE].columns[name] = { type, primaryKey: false, notNull: false, default: undefined }
  }
  // PR-4: the lock row's table (migration 100), columns and defaults only (its lease-shape CHECK is not modelled;
  // the lock's own kit models none either) — so `bumpGenerationWithin` on the store's handle finds the row.
  const lock = lockTable ? parseSchema(readMigrationText(MIGRATION_FILES.lock)) : {}
  return {
    ...parseSchema(readMigrationText(MIGRATION_FILES.continuation)),
    ...parseSchema(readMigrationText(MIGRATION_FILES.refreshState)),
    ...registry,
    ...lock,
  }
}

const claimActive = (row) => row.claim_active === true

// The unique indexes migrations 102 / 103 install (the suite cross-checks every name against the SQL).
const UNIQUE_INDEXES = Object.freeze([
  { table: T.continuation, name: 'uniq_integration_stock_prep_continuation_new_root', columns: ['tenant_id', 'sheet_id', 'new_root_key_digest'], where: claimActive },
  { table: T.continuation, name: 'uniq_integration_stock_prep_continuation_old_root', columns: ['tenant_id', 'sheet_id', 'old_root_record_id'], where: claimActive },
  { table: T.member, name: 'uniq_integration_stock_prep_continuation_member_position', columns: ['continuation_id', 'position'] },
  { table: T.member, name: 'uniq_integration_stock_prep_continuation_member_old_record', columns: ['sheet_id', 'old_record_id'], where: claimActive },
  { table: T.member, name: 'uniq_integration_stock_prep_continuation_member_old_key', columns: ['sheet_id', 'old_key_digest'], where: claimActive },
  { table: T.member, name: 'uniq_integration_stock_prep_continuation_member_new_key', columns: ['sheet_id', 'new_key_digest'], where: claimActive },
  { table: T.state, name: 'uniq_integration_stock_prep_refresh_state_sheet_project', columns: ['sheet_id', 'project_no'] },
  { table: T.hold, name: 'uniq_integration_stock_prep_refresh_hold_open', columns: ['sheet_id', 'project_no', 'fingerprint'], where: (row) => row.status === 'open' },
])

const isNull = (value) => value === null || value === undefined

// The shape CHECKs that are not plain enum lists (the enum lists are parsed from the SQL).
const SHAPE_CHECKS = Object.freeze([
  { table: T.continuation, name: 'integration_stock_prep_continuation_status_reason_shape_check', test: (r) => (r.status !== 'active' || isNull(r.status_reason)) && (r.status !== 'needs_reconfirmation' || !isNull(r.status_reason)) },
  { table: T.continuation, name: 'integration_stock_prep_continuation_revision_check', test: (r) => Number.isInteger(r.revision) && r.revision >= 1 },
  { table: T.continuation, name: 'integration_stock_prep_continuation_generation_check', test: (r) => r.confirmed_generation >= 0 && r.confirmed_fencing_epoch >= 0 },
  { table: T.continuation, name: 'integration_stock_prep_continuation_basis_note_check', test: (r) => isNull(r.basis_note) || r.basis_note.length <= 2000 },
  { table: T.continuation, name: 'integration_stock_prep_continuation_ended_shape_check', test: (r) => ((r.status === 'ended') === !isNull(r.ended_at)) && ((r.status === 'ended') === !isNull(r.ended_outcome)) && ((r.status === 'ended') === !isNull(r.ended_by)) },
  { table: T.continuation, name: 'integration_stock_prep_continuation_claim_active_check', test: (r) => r.claim_active === (r.status !== 'ended') },
  { table: T.member, name: 'integration_stock_prep_continuation_member_position_check', test: (r) => Number.isInteger(r.position) && r.position >= 0 },
  { table: T.state, name: 'integration_stock_prep_refresh_state_version_check', test: (r) => r.version >= 0 && r.decision_version >= 0 },
  { table: T.hold, name: 'integration_stock_prep_refresh_hold_confirmable_shape_check', test: (r) => r.confirmable === isNull(r.not_confirmable_reason) },
  { table: T.hold, name: 'integration_stock_prep_refresh_hold_resolution_shape_check', test: (r) => ((r.status === 'open') === isNull(r.resolution)) && ((r.status === 'open') === isNull(r.resolved_at)) },
  { table: T.hold, name: 'integration_stock_prep_refresh_hold_runbook_only_check', test: (r) => r.runbook_only === false || r.confirmable === false },
  { table: T.execution, name: 'integration_stock_prep_refresh_execution_generation_check', test: (r) => r.fencing_epoch >= 0 && r.generation >= 0 },
  { table: T.execution, name: 'integration_stock_prep_refresh_execution_counts_check', test: (r) => (isNull(r.written) || r.written >= 0) && (isNull(r.attempted_writes) || r.attempted_writes >= 0) },
  { table: T.execution, name: 'integration_stock_prep_refresh_execution_finished_shape_check', test: (r) => (r.status === 'running') === isNull(r.finished_at) },
  { table: T.execution, name: 'integration_stock_prep_refresh_execution_verified_shape_check', test: (r) => (r.status === 'verified_closed') === !isNull(r.verified_at) },
])

// ---------------------------------------------------------------------------------------------------
// 1b. The fake scoped db
// ---------------------------------------------------------------------------------------------------

function matches(row, where) {
  return Object.entries(where || {}).every(([column, expected]) => {
    if (isNull(expected)) return isNull(row[column])
    const actual = row[column]
    if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime()
    return actual === expected
  })
}

function compareValues(left, right) {
  const a = left instanceof Date ? left.getTime() : left
  const b = right instanceof Date ? right.getTime() : right
  if (isNull(a) && isNull(b)) return 0
  if (isNull(a)) return 1
  if (isNull(b)) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0)
}

function createFakeRefreshDb({ withoutUniqueIndexes = [], clock, registryPilotColumns = true, lockTable = false } = {}) {
  const schema = loadSchema({ registryPilotColumns, lockTable })
  const nowFn = clock && typeof clock.now === 'function' ? clock.now : () => new Date()
  const uniques = UNIQUE_INDEXES.filter((index) => !withoutUniqueIndexes.includes(index.name))
  for (const name of withoutUniqueIndexes) {
    if (!UNIQUE_INDEXES.some((index) => index.name === name)) throw new Error(`refresh-store kit: unknown unique index ${name}`)
  }
  const tables = new Map(Object.keys(schema).map((table) => [table, new Map()]))
  const faults = {}
  const pauses = {}
  const log = []
  let inTransaction = false

  function table(name) {
    if (!tables.has(name)) throw sqlError('42P01', `relation "${name}" does not exist`)
    return tables.get(name)
  }

  async function enter(method, args, prefix) {
    log.push([`${prefix}${method}`, clone(args)])
    if (typeof pauses[method] === 'function') await pauses[method](args)
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
    const columns = schema[name].columns
    const out = { ...row }
    for (const [column, meta] of Object.entries(columns)) {
      if (out[column] === undefined) {
        if (meta.default && meta.default.kind === 'now') out[column] = nowFn()
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
      if (meta.notNull && isNull(row[column])) throw sqlError('23502', `null value in column "${column}" of relation "${name}" violates not-null constraint`, { column })
    }
    for (const entry of enums) {
      if (entry.unique) continue
      const value = row[entry.column]
      if (isNull(value)) {
        if (!entry.nullable) throw sqlError('23514', `check constraint "${entry.name}"`, { constraint: entry.name })
        continue
      }
      if (!entry.values.includes(value)) throw sqlError('23514', `check constraint "${entry.name}"`, { constraint: entry.name })
    }
    for (const check of SHAPE_CHECKS) {
      if (check.table !== name) continue
      if (!check.test(row)) throw sqlError('23514', `check constraint "${check.name}"`, { constraint: check.name })
    }
    const rows = table(name)
    for (const index of uniques) {
      if (index.table !== name) continue
      if (index.where && !index.where(row)) continue
      for (const [key, other] of rows.entries()) {
        if (key === excludeKey) continue
        if (index.where && !index.where(other)) continue
        if (index.columns.every((column) => !isNull(row[column]) && other[column] === row[column])) {
          throw sqlError('23505', `duplicate key value violates unique constraint "${index.name}"`, { constraint: index.name })
        }
      }
    }
    for (const entry of enums) {
      if (!entry.unique) continue
      for (const [key, other] of rows.entries()) {
        if (key === excludeKey) continue
        if (entry.unique.every((column) => !isNull(row[column]) && other[column] === row[column])) {
          throw sqlError('23505', `duplicate key value violates unique constraint "${entry.name}"`, { constraint: entry.name })
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
    const api = {
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
      async insertMany(name, rows) {
        await enter('insertMany', { table: name, rows }, prefix)
        // All-or-nothing like one multi-row INSERT: validate every row before storing any.
        const staged = rows.map((row) => applyDefaults(name, clone(row)))
        const out = []
        const seen = new Map()
        for (const stored of staged) {
          validate(name, stored)
          for (const index of uniques) {
            if (index.table !== name || (index.where && !index.where(stored))) continue
            const tuple = JSON.stringify(index.columns.map((column) => stored[column]))
            const seenKey = `${index.name}:${tuple}`
            if (seen.has(seenKey)) throw sqlError('23505', `duplicate key value violates unique constraint "${index.name}"`, { constraint: index.name })
            seen.set(seenKey, true)
          }
        }
        for (const stored of staged) out.push(insertRow(name, stored))
        return out
      },
      async upsertOne(name, row, { conflictColumns, updateColumns } = {}) {
        await enter('upsertOne', { table: name, row, conflictColumns, updateColumns }, prefix)
        if (!Array.isArray(conflictColumns) || conflictColumns.length === 0) throw new Error('upsertOne: conflictColumns required')
        const existing = Array.from(table(name).entries()).find(([, other]) => conflictColumns.every((column) => other[column] === row[column]))
        if (!existing) return [insertRow(name, row)]
        const [key, current] = existing
        const columns = Array.isArray(updateColumns) ? updateColumns : Object.keys(row).filter((column) => !conflictColumns.includes(column))
        const next = { ...current }
        for (const column of columns) if (!conflictColumns.includes(column)) next[column] = clone(row[column])
        validate(name, next, { excludeKey: key })
        table(name).set(key, next)
        return [clone(next)]
      },
      async updateRow(name, set, where) {
        await enter('updateRow', { table: name, set, where }, prefix)
        if (!where || Object.keys(where).length === 0) throw new Error('updateRow: where must be non-empty')
        const out = []
        for (const [key, row] of table(name).entries()) {
          if (!matches(row, where)) continue
          const next = { ...row, ...clone(set) }
          for (const column of Object.keys(set)) {
            if (!schema[name].columns[column]) throw sqlError('42703', `column "${column}" of relation "${name}" does not exist`)
          }
          validate(name, next, { excludeKey: key })
          table(name).set(key, next)
          out.push(clone(next))
        }
        return out
      },
      async deleteRows(name, where) {
        await enter('deleteRows', { table: name, where }, prefix)
        const out = []
        for (const [key, row] of Array.from(table(name).entries())) {
          if (!matches(row, where)) continue
          table(name).delete(key)
          out.push(clone(row))
        }
        return out
      },
      async countRows(name, where) {
        await enter('countRows', { table: name, where }, prefix)
        return selectRows(name, { where, limit: 10000 }).length
      },
    }
    return api
  }

  const autocommit = makeApi('')
  const db = {
    tables,
    faults,
    pauses,
    log,
    schema,
    uniqueIndexes: uniques,
    rows(name) {
      return Array.from(table(name).values()).map(clone)
    },
    statements(prefix = '') {
      return log.filter(([method]) => method.startsWith(prefix)).map(([method, args]) => [method, args && args.table])
    },
    ...autocommit,
    // The scoped helper's `transaction` (lib/db.cjs): the handle carries the same CRUD methods plus the
    // handle-only statements. A throw from the callback restores the snapshot taken at BEGIN (ROLLBACK).
    async transaction(callback) {
      await enter('transaction', {}, '')
      if (inTransaction) throw new Error('refresh-store kit: overlapping transactions are not modelled (use the real-DB cases for interleavings)')
      inTransaction = true
      const snapshot = new Map(Array.from(tables.entries()).map(([name, rows]) => [name, new Map(Array.from(rows.entries()).map(([key, row]) => [key, clone(row)]))]))
      const handle = {
        ...makeApi('trx.'),
        async setLocalLockTimeout(ms) {
          await enter('setLocalLockTimeout', { ms }, 'trx.')
          if (!Number.isInteger(ms) || ms <= 0 || ms > 30000) throw new Error('setLocalLockTimeout: integer 1..30000 required')
        },
        async advisoryXactLock(key) {
          await enter('advisoryXactLock', { key }, 'trx.')
        },
        async tryAdvisoryXactLock(key) {
          await enter('tryAdvisoryXactLock', { key }, 'trx.')
          return true
        },
        async setTransactionIsolationLevel(level) {
          await enter('setTransactionIsolationLevel', { level }, 'trx.')
        },
      }
      // The handle of the transaction in progress (or last run): a suite can assert a callee was handed THIS one.
      db.lastTransactionHandle = handle
      try {
        const result = await callback(handle)
        // PR-4: a COMMIT-time fault (`faults.commit`, one shot) — PostgreSQL's deferred-constraint / lost-connection
        // commit failure: the callback completed, nothing persists, the untyped error surfaces to the caller.
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

// ---------------------------------------------------------------------------------------------------
// 2. A controllable clock and the fake lock bump
// ---------------------------------------------------------------------------------------------------

function createClock(startIso = '2026-10-24T00:00:00.000Z') {
  let ms = Date.parse(startIso)
  return {
    now: () => new Date(ms),
    advance(deltaMs) { ms += deltaMs },
    set(iso) { ms = Date.parse(iso) },
    ms: () => ms,
    iso: () => new Date(ms).toISOString(),
  }
}

/**
 * The lock's in-transaction bump as PR-4 will provide it: `bumpWithin(trx, scopeKey, { reason, tenantId })`
 * -> `{ generation, generationToken, fencingEpoch }`. Records every call (with the handle it was given, so a
 * suite can assert it ran on the TRANSACTION handle); `refuseWith(error)` makes the next call throw it
 * (the lock's 409 WRITE_LOCKED shape), `answerMalformed()` makes it answer garbage.
 */
function createFakeBumpWithin({ startGeneration = 3, fencingEpoch = 2 } = {}) {
  let generation = startGeneration
  const calls = []
  let refusal = null
  let malformed = false
  async function bumpWithin(trx, scopeKey, options) {
    calls.push({ trx, scopeKey, options: clone(options) })
    if (refusal) {
      const error = refusal
      refusal = null
      throw error
    }
    if (malformed) {
      malformed = false
      return { generation: 'x' }
    }
    generation += 1
    return { generation, generationToken: `tok_${generation}_${crypto.randomBytes(4).toString('hex')}`, fencingEpoch }
  }
  return {
    bumpWithin,
    calls,
    refuseWith(error) { refusal = error },
    answerMalformed() { malformed = true },
    current: () => generation,
  }
}

function writeLockedError() {
  return Object.assign(new Error('another run is writing this stock-prep sheet; retry after it finishes'), {
    name: 'StockPreparationProjectWriteLockError',
    status: 409,
    code: 'STOCK_PREP_PROJECT_WRITE_LOCKED',
    details: { holderPurpose: 'small_apply', interrupted: false },
  })
}

// ---------------------------------------------------------------------------------------------------
// 3. A REAL continuation_candidate hold from the pure core (canonical S/P fixtures)
// ---------------------------------------------------------------------------------------------------

let candidateCache = null

/**
 * The second pull of the canonical story (first pull: S-001 on its own; second: P-001 with S-001 nested,
 * plus N-001) planned by the REAL planner with the REAL recorder output: ONE `continuation_candidate` hold
 * (confirmable) with four pairs. Cached per process (the expansion is deterministic).
 */
async function candidateHoldFixture() {
  if (candidateCache) return candidateCache
  const fixtures = require(path.join(__dirname, 'stock-preparation-continuation-fixtures.cjs'))
  const sheet = await fixtures.firstPullSheet()
  const expansion = await fixtures.expand(fixtures.secondPullSource())
  const planned = fixtures.plan(expansion, sheet, { continuation: fixtures.continuationInput({ pilot: true, demandEvidence: expansion.demandEvidence }) })
  const hold = (planned.holds || []).find((entry) => entry.kind === 'continuation_candidate')
  if (!hold) throw new Error('refresh-store kit: the canonical second pull did not yield a continuation_candidate hold')
  candidateCache = Object.freeze({
    hold,
    planned,
    sheet,
    expansion,
    projectNo: fixtures.PROJECT_NO,
    sourceIdentity: fixtures.SOURCE_IDENTITY,
    fixtures,
  })
  return candidateCache
}

/**
 * A second, DISTINCT candidate hold that claims the SAME old record ids at a DIFFERENT new position (the A08
 * shape: two independent demands competing for one old S): the same pairs re-rooted under another parent.
 * Built from the real hold's detail so every field the store reads is present; its fingerprints differ.
 */
function competingCandidateHold(base, { parentId = 'Q-001', projectNo } = {}) {
  const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
  const { makeIdempotencyKey } = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs')).__internals
  const project = projectNo || JSON.parse(base.detail.pairs[0].newKey).projectNo
  const rootTokens = [parentId, base.detail.componentSourceId]
  const pairs = base.detail.pairs.map((pair) => {
    const tokens = rootTokens.concat(pair.relativePath)
    const parent = tokens.length > 1 ? tokens[tokens.length - 2] : null
    return { ...pair, newKey: makeIdempotencyKey(project, pair.componentSourceId, parent, tokens) }
  })
  const detail = { ...base.detail, pairs, newPositionKeys: [pairs[0].newKey] }
  const subject = { ...base.subject, newRootKeyDigest: pairing.__internals.subjectDigest(pairs[0].newKey) }
  const pairingFingerprint = pairing.pairingFingerprintOf({ projectNo: project, oldRootKey: pairs[0].oldKey, newRootKey: pairs[0].newKey, pairs: pairs.map((pair) => ({ relativePath: pair.relativePath, componentSourceId: pair.componentSourceId, oldKey: pair.oldKey, newKey: pair.newKey, oldRecordId: pair.oldRecordId })) })
  const hold = {
    kind: 'continuation_candidate',
    confirmable: true,
    subject,
    evidenceFingerprint: crypto.createHash('sha256').update(`competing-evidence:${base.evidenceFingerprint}`).digest('hex'),
    comparisonFingerprint: base.comparisonFingerprint,
    pairingFingerprint,
    detail,
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

/**
 * A candidate hold whose OLD side is a different, disjoint set of records but whose new root position is
 * the same as `base` (two old sets competing for one new position).
 */
function sameNewPositionHold(base, { recordSuffix = '_other' } = {}) {
  const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
  const pairs = base.detail.pairs.map((pair) => ({
    ...pair,
    oldRecordId: `${pair.oldRecordId}${recordSuffix}`,
    oldKey: JSON.stringify({ ...JSON.parse(pair.oldKey), path: JSON.parse(pair.oldKey).path.map((token, index, all) => (index === 0 ? `${token}${recordSuffix}` : token)) }),
  }))
  const detail = { ...base.detail, pairs, oldRootKeys: [pairs[0].oldKey], oldRootRecordIds: [pairs[0].oldRecordId] }
  const subject = { ...base.subject, oldRootRecordId: pairs[0].oldRecordId }
  const hold = {
    kind: 'continuation_candidate',
    confirmable: true,
    subject,
    evidenceFingerprint: crypto.createHash('sha256').update(`other-old-evidence:${base.evidenceFingerprint}`).digest('hex'),
    comparisonFingerprint: base.comparisonFingerprint,
    pairingFingerprint: crypto.createHash('sha256').update(`other-old-pairing:${base.pairingFingerprint}`).digest('hex'),
    detail,
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

/**
 * A candidate hold whose HEADER claims collide with nothing in `base` (another old root record and key; the new
 * root re-rooted under another parent, so every new key differs) while ONE child member — `base`'s first child
 * in the store's member order — collides with `base` on exactly ONE member claim:
 *   'old_record'  the same old record id, another old key;
 *   'old_key'     another old record id, the same old key (a duplicate key on the sheet);
 *   'new_key'     another old record and key, the same new key (a nested new position).
 * Each shape is answered FIRST by its own member index (the header indexes see no collision), so dropping that
 * one index changes the answer — the per-index A08 evidence the pair-wise probes cannot give.
 */
function memberCollisionHold(base, which, { parentId = 'R-001', suffix = '_mc' } = {}) {
  if (!['old_record', 'old_key', 'new_key'].includes(which)) throw new Error(`refresh-store kit: unknown member collision ${which}`)
  const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
  const moved = competingCandidateHold(base, { parentId })
  const freshKey = (key) => {
    const parsed = JSON.parse(key)
    return JSON.stringify({ ...parsed, path: parsed.path.map((token, index) => (index === 0 ? `${token}${suffix}` : token)) })
  }
  const pathKeyOf = (pair) => JSON.stringify(pair.relativePath)
  const children = base.detail.pairs.filter((pair) => pair.relativePath.length > 0).map(pathKeyOf).sort()
  if (children.length === 0) throw new Error('refresh-store kit: the base hold has no child pair')
  const target = children[0]
  const original = base.detail.pairs.find((pair) => pathKeyOf(pair) === target)
  const pairs = moved.detail.pairs.map((pair) => {
    const fresh = { ...pair, oldRecordId: `${pair.oldRecordId}${suffix}`, oldKey: freshKey(pair.oldKey) }
    if (pathKeyOf(pair) !== target) return fresh
    if (which === 'old_record') return { ...fresh, oldRecordId: original.oldRecordId }
    if (which === 'old_key') return { ...fresh, oldKey: original.oldKey }
    return { ...fresh, newKey: original.newKey }
  })
  const root = pairs.find((pair) => pair.relativePath.length === 0)
  const detail = { ...moved.detail, pairs, oldRootKeys: [root.oldKey], oldRootRecordIds: [root.oldRecordId], newPositionKeys: [root.newKey] }
  const subject = { ...moved.subject, oldRootRecordId: root.oldRecordId }
  const hold = {
    kind: 'continuation_candidate',
    confirmable: true,
    subject,
    evidenceFingerprint: crypto.createHash('sha256').update(`member-collision-evidence:${which}:${base.evidenceFingerprint}`).digest('hex'),
    comparisonFingerprint: base.comparisonFingerprint,
    pairingFingerprint: crypto.createHash('sha256').update(`member-collision-pairing:${which}:${base.pairingFingerprint}`).digest('hex'),
    detail,
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

/**
 * A candidate hold whose claims share NOTHING with `base` (review X-3 control): every old record id and old key
 * is fresh and the subtree is re-rooted under another parent, so no old record, old key or new position (root
 * or member) overlaps. On a sheet where `base` is confirmed it commits on its own — so a supersede naming
 * `base` that is refused is refused by the relatedness rule alone.
 */
function disjointCandidateHold(base, { parentId = 'Z-001', suffix = '_dj' } = {}) {
  const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
  const moved = competingCandidateHold(base, { parentId })
  const freshKey = (key) => {
    const parsed = JSON.parse(key)
    return JSON.stringify({ ...parsed, path: parsed.path.map((token, index) => (index === 0 ? `${token}${suffix}` : token)) })
  }
  const pairs = moved.detail.pairs.map((pair) => ({ ...pair, oldRecordId: `${pair.oldRecordId}${suffix}`, oldKey: freshKey(pair.oldKey) }))
  const root = pairs.find((pair) => pair.relativePath.length === 0)
  const detail = { ...moved.detail, pairs, oldRootKeys: [root.oldKey], oldRootRecordIds: [root.oldRecordId], newPositionKeys: [root.newKey] }
  const subject = { ...moved.subject, oldRootRecordId: root.oldRecordId }
  const hold = {
    kind: 'continuation_candidate',
    confirmable: true,
    subject,
    evidenceFingerprint: crypto.createHash('sha256').update(`disjoint-evidence:${suffix}:${base.evidenceFingerprint}`).digest('hex'),
    comparisonFingerprint: base.comparisonFingerprint,
    pairingFingerprint: crypto.createHash('sha256').update(`disjoint-pairing:${suffix}:${base.pairingFingerprint}`).digest('hex'),
    detail,
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

/**
 * Review round 2 (P1 on X-3): the reviewer's PARTIAL-TAKEOVER shape, emitted by the REAL planner. An independent
 * PART-A order (PART-A > PART-C, two rows) was pulled on its own; planning the canonical second pull against ONLY
 * those rows detects a `continuation_candidate` that pairs them with the PART-A position inside P-001 / S-001 —
 * two of the four NEW positions the canonical candidate claims, and NONE of its four old rows. Superseding the
 * canonical relationship with it would end all four old claims and keep two other rows. Returns the hold and the
 * independent rows (with record refs under `idPrefix`).
 */
async function partialTakeoverCandidate({ idPrefix = 'rec_independent_a' } = {}) {
  const base = await candidateHoldFixture()
  const F = base.fixtures
  const independent = await F.expand(F.project({ orders: [{ part: 'PART-A', qty: 20 }], parts: F.PARTS.slice(), boms: { 'PART-A': [{ part: 'PART-C', usage: 4 }] } }))
  const sheetRows = F.applyToSheet(F.plan(independent, []), [], { idPrefix })
  const planned = F.plan(base.expansion, sheetRows, { continuation: F.continuationInput({ pilot: true, demandEvidence: base.expansion.demandEvidence }) })
  const hold = (planned.holds || []).find((entry) => entry.kind === 'continuation_candidate')
  if (!hold || hold.detail.pairs.length !== 2) throw new Error('refresh-store kit: the independent PART-A subtree did not yield the two-pair partial candidate')
  return Object.freeze({ hold, sheetRows })
}

/**
 * Review round 2: the reviewer's ANCESTOR counterexample, as REAL-planner inputs. The source orders Q-001 > P-001 >
 * S-001 > {PART-A > PART-C, PART-B}, so the canonical first-pull sheet's four rows pair with the S-001 subtree NESTED
 * under Q-001 > P-001 (the relationship). An independent P-001 order (P-001 > S-001 > …, five rows) is then written
 * beside them — the synthetic step: inserted after the confirm, not produced by a pull. Planned over the FULL nine-row
 * sheet and the current projection, the planner emits a five-member ANCESTOR candidate rooted at P-001: zero of the
 * relationship's old rows, four of its new positions. Returns the expansion, the independent rows (record refs under
 * `idPrefix`) and the fixtures module.
 */
async function ancestorScenario({ idPrefix = 'rec_independent_p' } = {}) {
  const base = await candidateHoldFixture()
  const F = base.fixtures
  const outer = F.part('Q-001', 'Q800', 'Synthetic outer parent')
  const expansion = await F.expand(F.project({ orders: [{ part: 'Q-001', qty: 5 }], parts: [...F.PARTS, outer], boms: { 'Q-001': [{ part: 'P-001', usage: 1 }], 'P-001': [{ part: 'S-001', usage: 2 }], ...F.S_BOMS } }))
  const independent = await F.expand(F.project({ orders: [{ part: 'P-001', qty: 5 }], parts: F.PARTS.slice(), boms: { 'P-001': [{ part: 'S-001', usage: 2 }], ...F.S_BOMS } }))
  const independentRows = F.applyToSheet(F.plan(independent, []), [], { idPrefix })
  return Object.freeze({ expansion, independentRows, fixtures: F })
}

/**
 * A FULL-RECORD takeover with one old key re-keyed: every old record id of `base` (same rows, re-rooted under another
 * parent like `competingCandidateHold`) but ONE child's old key replaced by a fresh one — a covered record whose key
 * the replacement would not protect. Review round 2: a takeover must cover the old keys too (the planner's sweep
 * protection is keyed on them), so this is `supersedes_incomplete` with one uncovered old key.
 */
function rekeyedTakeoverHold(base, { parentId = 'K-001', suffix = '_rk' } = {}) {
  const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
  const moved = competingCandidateHold(base, { parentId })
  const pathKeyOf = (pair) => JSON.stringify(pair.relativePath)
  const target = moved.detail.pairs.filter((pair) => pair.relativePath.length > 0).map(pathKeyOf).sort()[0]
  const pairs = moved.detail.pairs.map((pair) => {
    if (pathKeyOf(pair) !== target) return pair
    const parsed = JSON.parse(pair.oldKey)
    return { ...pair, oldKey: JSON.stringify({ ...parsed, path: parsed.path.map((token, index) => (index === 0 ? `${token}${suffix}` : token)) }) }
  })
  const hold = {
    kind: 'continuation_candidate',
    confirmable: true,
    subject: moved.subject,
    evidenceFingerprint: crypto.createHash('sha256').update(`rekeyed-evidence:${suffix}:${base.evidenceFingerprint}`).digest('hex'),
    comparisonFingerprint: base.comparisonFingerprint,
    pairingFingerprint: crypto.createHash('sha256').update(`rekeyed-pairing:${suffix}:${base.pairingFingerprint}`).digest('hex'),
    detail: { ...moved.detail, pairs },
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

/**
 * The mirror of `rekeyedTakeoverHold`: every old KEY of `base` (re-rooted under another parent) but ONE child's old
 * record id replaced by another record — a covered key whose record the replacement would not claim (A08). Review
 * round 2: a takeover must cover the old record ids too, so this is `supersedes_incomplete` with one uncovered record.
 */
function rerecordedTakeoverHold(base, { parentId = 'J-001', suffix = '_rr' } = {}) {
  const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
  const moved = competingCandidateHold(base, { parentId })
  const pathKeyOf = (pair) => JSON.stringify(pair.relativePath)
  const target = moved.detail.pairs.filter((pair) => pair.relativePath.length > 0).map(pathKeyOf).sort()[0]
  const pairs = moved.detail.pairs.map((pair) => (pathKeyOf(pair) === target ? { ...pair, oldRecordId: `${pair.oldRecordId}${suffix}` } : pair))
  const hold = {
    kind: 'continuation_candidate',
    confirmable: true,
    subject: moved.subject,
    evidenceFingerprint: crypto.createHash('sha256').update(`rerecorded-evidence:${suffix}:${base.evidenceFingerprint}`).digest('hex'),
    comparisonFingerprint: base.comparisonFingerprint,
    pairingFingerprint: crypto.createHash('sha256').update(`rerecorded-pairing:${suffix}:${base.pairingFingerprint}`).digest('hex'),
    detail: { ...moved.detail, pairs },
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

/**
 * A `relationship_reconfirm` hold about `continuationId`, as the pure core's verification emits it (pairing.cjs
 * verificationHold): confirmable for the re-confirmable verdicts, else not confirmable with its reason token.
 */
function reconfirmHoldFor(continuationId, { confirmable = true, reason = 'reconfirm_not_admissible', verdict = 'source_scope_changed' } = {}) {
  const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
  const hold = {
    kind: 'relationship_reconfirm',
    confirmable,
    ...(confirmable ? {} : { notConfirmableReason: reason }),
    continuationId,
    subject: { continuationId, newRootKeyDigest: 'f'.repeat(64) },
    evidenceFingerprint: `${verdict}-evidence-${'1'.repeat(40)}`,
    comparisonFingerprint: `${verdict}-comparison-${'2'.repeat(40)}`,
    pairingFingerprint: `${verdict}-pairing-${'3'.repeat(40)}`,
    detail: { verdict, steps: {}, pairs: null, comparison: null, demand: null },
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

/**
 * A `relationship_content_change` hold about `continuationId`, as the pure core emits it for an ACTIVE continuation
 * whose verdict is `content_changed` (pairing.cjs verificationHold): not confirmable (`needs_step5`), and the
 * continuation stays ACTIVE — the one shape where an open hold names a relationship that does not need
 * reconfirmation (review X-2: an end must still refuse it by its status).
 */
function contentChangeHoldFor(continuationId) {
  const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
  const hold = {
    kind: 'relationship_content_change',
    confirmable: false,
    notConfirmableReason: 'needs_step5',
    continuationId,
    subject: { continuationId, newRootKeyDigest: 'e'.repeat(64) },
    evidenceFingerprint: `content-evidence-${'4'.repeat(40)}`,
    comparisonFingerprint: `content-comparison-${'5'.repeat(40)}`,
    pairingFingerprint: `content-pairing-${'6'.repeat(40)}`,
    detail: { verdict: 'content_changed', steps: {}, pairs: null, comparison: null, demand: null },
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

/** A registry row (087 + 101 columns) as PR B's store writes it; `pilot` stamps the three 101 columns. */
function registryRow({ id, tenantId, projectNo, sheetId, objectId, status = 'active', pilot = false, at = new Date('2026-10-24T00:00:00.000Z') }) {
  return {
    id: id || `pt_${sheetId}`,
    tenant_id: tenantId,
    project_no: projectNo,
    sheet_id: sheetId,
    object_id: objectId || `obj_${sheetId}`,
    status,
    ...(pilot ? { pilot_enabled_at: at, pilot_enabled_by: 'u_admin', pilot_readiness_version: 1 } : {}),
  }
}

function echoOf(hold) {
  return { holdFingerprint: hold.fingerprint, comparisonFingerprint: hold.comparisonFingerprint, evidenceFingerprint: hold.evidenceFingerprint }
}

module.exports = {
  MIGRATION_FILES,
  REGISTRY_TABLE,
  SHAPE_CHECKS,
  UNIQUE_INDEXES,
  ancestorScenario,
  candidateHoldFixture,
  clone,
  competingCandidateHold,
  contentChangeHoldFor,
  createClock,
  createFakeBumpWithin,
  createFakeRefreshDb,
  disjointCandidateHold,
  echoOf,
  loadSchema,
  memberCollisionHold,
  parseSchema,
  partialTakeoverCandidate,
  readMigrationText,
  reconfirmHoldFor,
  rekeyedTakeoverHold,
  rerecordedTakeoverHold,
  registryRow,
  sameNewPositionHold,
  sqlError,
  writeLockedError,
}
