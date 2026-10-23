'use strict'

// Test kit for the stock-preparation REFRESH STORE (lib/stock-preparation-continuation-store.cjs) and the
// governance reader (lib/stock-preparation-refresh-governance.cjs). Not a suite (lives under support/, so
// the chain-completeness walk does not see it).
//
// It holds:
//   1. a FAITHFUL fake of the scoped db helper (lib/db.cjs) over the FIVE step-4 tables of migrations 102 /
//      103: equality WHERE with null meaning IS NULL, ORDER BY one column, LIMIT / OFFSET, SELECT *, PRIMARY
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
})

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
      const column = part.match(/^(\w+) (TEXT|INTEGER|BOOLEAN|NUMERIC|JSONB|TIMESTAMPTZ)(.*)$/)
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

function loadSchema() {
  return {
    ...parseSchema(readMigrationText(MIGRATION_FILES.continuation)),
    ...parseSchema(readMigrationText(MIGRATION_FILES.refreshState)),
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

function createFakeRefreshDb({ withoutUniqueIndexes = [], clock } = {}) {
  const schema = loadSchema()
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
      try {
        const result = await callback(handle)
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

function echoOf(hold) {
  return { holdFingerprint: hold.fingerprint, comparisonFingerprint: hold.comparisonFingerprint, evidenceFingerprint: hold.evidenceFingerprint }
}

module.exports = {
  MIGRATION_FILES,
  SHAPE_CHECKS,
  UNIQUE_INDEXES,
  candidateHoldFixture,
  clone,
  competingCandidateHold,
  createClock,
  createFakeBumpWithin,
  createFakeRefreshDb,
  echoOf,
  loadSchema,
  parseSchema,
  readMigrationText,
  sameNewPositionHold,
  sqlError,
  writeLockedError,
}
