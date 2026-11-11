'use strict'

// Test kit for the doubled-sheet repair (batch-refresh step 6d-2a, S6-6; register R-91) — lib/stock-preparation-sheet-
// repair.cjs and its ledger store over migration 108. Not a suite (lives under support/, so the chain-completeness walk
// does not see it).
//
//   createFakeRepairDb   A FAITHFUL fake of the scoped db helper (lib/db.cjs) over migration 108's two tables and the
//                        sheet write lock's row (migration 100) — and, opt-in, the batch identifier's four tables
//                        (migration 105) — so ONE fake serves the repair ledger, the REAL lock module's in-transaction
//                        holder assert and the REAL batch ledger store. The engine is the pull-batch kit's (equality
//                        WHERE with null = IS NULL, ORDER BY one column, LIMIT; NOT NULL / DEFAULT / enum CHECKs PARSED
//                        FROM THE MIGRATION TEXT; a transaction whose throw ROLLS BACK; per-method fault injection; a
//                        statement log); 108's shape CHECKs and UNIQUE indexes are modelled by hand and the store
//                        suite cross-checks every name against the SQL. `withoutUniqueIndexes: [...]` builds the fake
//                        WITHOUT a named index — the in-memory mutation probe.
//   doubledSheet         A synthetic project sheet in design §6.1's shape D1: the component S as its own root subtree
//                        (S, S/C1, S/C2, S/C1/G1) AND as a copy nested under P (P/S, P/S/C1, …), every row keyed the
//                        way the expander keys it, with its record ref on the planner's Symbol.
//   makeHost             A records host over such rows whose patch is version-conditional and bumps the version by
//                        one, like the real host's.
// Every value is synthetic.

const path = require('node:path')

const LIB = path.join(__dirname, '..', '..', 'lib')
const MIGRATIONS = path.join(__dirname, '..', '..', '..', '..', 'packages', 'core-backend', 'migrations')
const pbKit = require('./stock-preparation-pull-batch-kit.cjs')
const { EXISTING_ROW_RECORD_REF } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const { __internals: { expectedKeyForTokens } } = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const { __internals: { componentHandle } } = require(path.join(LIB, 'stock-preparation-sheet-census.cjs'))
const { SHEET_REPAIR_RETIRE_SUMMARY } = require(path.join(LIB, 'stock-preparation-sheet-repair.cjs'))

const { clone, sqlError } = pbKit

const MIGRATION_FILES = Object.freeze({
  repair: path.join(MIGRATIONS, '108_create_integration_stock_prep_sheet_repair.sql'),
  lock: path.join(MIGRATIONS, '100_create_integration_stock_prep_project_write_lock.sql'),
  pullBatch: pbKit.MIGRATION_FILES.pullBatch,
})
const T = Object.freeze({
  run: 'integration_stock_prep_sheet_repair_run',
  claim: 'integration_stock_prep_sheet_repair_claim',
  lock: 'integration_stock_prep_project_write_lock',
  pullBatchSheet: pbKit.T.sheet,
})

const isNull = (value) => value === null || value === undefined
const DIGEST = /^[0-9a-f]{64}$/

// The unique indexes migration 108 installs (the store suite cross-checks every name against the SQL).
const UNIQUE_INDEXES = Object.freeze([
  { table: T.run, name: 'uniq_integration_stock_prep_sheet_repair_run_open', columns: ['sheet_id'], where: (row) => row.status === 'running' },
  { table: T.run, name: 'uniq_integration_stock_prep_sheet_repair_run_sequence', columns: ['sheet_id', 'project_no', 'sequence_no'] },
])

// 108's CHECKs that are not plain enum lists (the enum lists are parsed from the SQL).
const SHAPE_CHECKS = Object.freeze([
  { table: T.run, name: 'integration_stock_prep_sheet_repair_run_open_check', test: (r) => (r.status === 'running') === isNull(r.finished_at) },
  { table: T.run, name: 'integration_stock_prep_sheet_repair_run_stop_check', test: (r) => (r.status === 'stopped') === !isNull(r.stop_reason) },
  {
    table: T.run,
    name: 'integration_stock_prep_sheet_repair_run_subject_check',
    test: (r) => (r.recipe === 'retire_superseded_root_subtree' && !isNull(r.component_handle) && isNull(r.source_run_id))
      || (r.recipe === 'restore_retired_rows' && !isNull(r.source_run_id) && isNull(r.component_handle)),
  },
  { table: T.run, name: 'integration_stock_prep_sheet_repair_run_digest_check', test: (r) => typeof r.plan_digest === 'string' && DIGEST.test(r.plan_digest) },
  {
    table: T.run,
    name: 'integration_stock_prep_sheet_repair_run_counts_check',
    test: (r) => Number.isInteger(r.sequence_no) && r.sequence_no >= 0 && Number.isInteger(r.fencing_epoch) && r.fencing_epoch >= 0
      && Number.isInteger(r.planned_count) && r.planned_count >= 1
      && (isNull(r.written_count) || (Number.isInteger(r.written_count) && r.written_count >= 0 && r.written_count <= r.planned_count)),
  },
  {
    table: T.run,
    name: 'integration_stock_prep_sheet_repair_run_written_check',
    test: (r) => (r.status === 'completed' && r.written_count === r.planned_count)
      || (r.status === 'stopped' && (!isNull(r.written_count) || r.stop_reason === 'abandoned'))
      || (r.status === 'running' && isNull(r.written_count)),
  },
  // Only a run the continuation closed carries a close approval, and such a run is `completed`.
  { table: T.run, name: 'integration_stock_prep_sheet_repair_run_close_check', test: (r) => isNull(r.close_approval_ref) || r.status === 'completed' },
  { table: T.claim, name: 'integration_stock_prep_sheet_repair_claim_digest_check', test: (r) => typeof r.plan_digest === 'string' && DIGEST.test(r.plan_digest) },
])

function matches(row, where) {
  return Object.entries(where || {}).every(([column, expected]) => (isNull(expected) ? isNull(row[column]) : row[column] === expected))
}

function compareValues(left, right) {
  if (isNull(left) && isNull(right)) return 0
  if (isNull(left)) return 1
  if (isNull(right)) return -1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left) < String(right) ? -1 : (String(left) > String(right) ? 1 : 0)
}

function createFakeRepairDb({ clock, pullBatch = false, withoutUniqueIndexes = [] } = {}) {
  const schema = {
    ...pbKit.parseSchema(pbKit.readMigrationText(MIGRATION_FILES.repair)),
    ...pbKit.parseSchema(pbKit.readMigrationText(MIGRATION_FILES.lock)),
    ...(pullBatch ? pbKit.parseSchema(pbKit.readMigrationText(MIGRATION_FILES.pullBatch)) : {}),
  }
  const allUniques = pullBatch ? UNIQUE_INDEXES.concat(pbKit.UNIQUE_INDEXES) : UNIQUE_INDEXES
  const allChecks = pullBatch ? SHAPE_CHECKS.concat(pbKit.SHAPE_CHECKS) : SHAPE_CHECKS
  for (const name of withoutUniqueIndexes) {
    if (!allUniques.some((index) => index.name === name)) throw new Error(`sheet-repair kit: unknown unique index ${name}`)
  }
  const uniques = allUniques.filter((index) => !withoutUniqueIndexes.includes(index.name))
  const nowIso = () => (clock && typeof clock.now === 'function' ? clock.now() : new Date()).toISOString()
  const tables = new Map(Object.keys(schema).map((name) => [name, new Map()]))
  const faults = {}
  const log = []
  let tail = Promise.resolve()

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
    for (const column of Object.keys(row)) {
      if (!columns[column]) throw sqlError('42703', `column "${column}" of relation "${name}" does not exist`)
    }
    for (const [column, meta] of Object.entries(columns)) {
      if (out[column] !== undefined) continue
      if (meta.default && meta.default.kind === 'now') out[column] = nowIso()
      else if (meta.default && meta.default.kind === 'literal') out[column] = meta.default.value
      else out[column] = null
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
    for (const check of allChecks) {
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
    /** Put a row straight into a table (a test fixture). Validated like an INSERT. */
    seed(name, row) {
      return insertRow(name, row)
    },
    /** What the fake host's write fence checks: the lock row still carries this lease and plan. */
    fenceRowExists(fence) {
      return Array.from(table(T.lock).values()).some((row) => row.scope_key === fence.scopeKey && row.lease_id === fence.leaseId
        && Number(row.fencing_epoch) === Number(fence.fencingEpoch) && row.generation_token === fence.generationToken)
    },
    ...autocommit,
    // Transactions run ONE AFTER ANOTHER (a route suite's lease heartbeat or release may meet a ledger transaction;
    // PostgreSQL would run them side by side — the interleavings themselves are the real-DB cases' job). A throw
    // ROLLS BACK (snapshot / restore).
    transaction(callback) {
      const run = tail.then(async () => {
        await enter('transaction', {}, '')
        const snapshot = new Map(Array.from(tables.entries()).map(([name, rows]) => [name, new Map(Array.from(rows.entries()).map(([key, row]) => [key, clone(row)]))]))
        const handle = {
          ...makeApi('trx.'),
          async setLocalLockTimeout(ms) {
            await enter('setLocalLockTimeout', { ms }, 'trx.')
            if (!Number.isInteger(ms) || ms <= 0 || ms > 30000) throw new Error('setLocalLockTimeout: integer 1..30000 required')
          },
        }
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
        }
      })
      tail = run.catch(() => undefined)
      return run
    },
  }
  return db
}

// ── the synthetic doubled sheet (design §6.1 D1) ─────────────────────────────────────────────────────────────

const PROJECT_NO = 'SYN-RP-01'
const TENANT_ID = 'tenant-syn-rp'
const SHEET_ID = 'sheet_syn_rp_01'
const OLD_ROOT = 'S-100'
const PARENT = 'P-200'
const PULL_RUN_ID = 'table-action:syn-pull-1'

/** One row as the project-scoped reader answers it: logical ids, the record ref on the planner's Symbol. */
function sheetRow({ projectNo = PROJECT_NO, tokens, id, version = 1, active = true, runId = PULL_RUN_ID, decision = 'add', summary = '', cells = {} }) {
  const component = tokens[tokens.length - 1]
  const row = {
    projectNo,
    idempotencyKey: expectedKeyForTokens(projectNo, tokens),
    componentSourceId: component,
    parentSourceId: tokens.length > 1 ? tokens[tokens.length - 2] : null,
    path: JSON.stringify(tokens),
    depth: tokens.length - 1,
    active,
    lastPlmRefreshRunId: runId,
    lastPlmRefreshAt: '2026-11-01T00:00:00.000Z',
    lastPlmRefreshDecision: decision,
    lastPlmConflictSummary: summary,
    ...cells,
  }
  if (id !== undefined) row[EXISTING_ROW_RECORD_REF] = Object.freeze({ id, version })
  return row
}

// The eleven positions of the fixture: the old root subtree (4), the parent and its own child (2), the nested copy (4)
// and an unrelated root (1).
const OLD_PATHS = Object.freeze([[OLD_ROOT], [OLD_ROOT, 'C-1'], [OLD_ROOT, 'C-2'], [OLD_ROOT, 'C-1', 'G-1']])
const COPY_PATHS = Object.freeze(OLD_PATHS.map((tokens) => [PARENT].concat(tokens)))
const OTHER_PATHS = Object.freeze([[PARENT], [PARENT, 'Q-9'], ['U-300']])

/**
 * The D1 fixture: `rows` (reader shape), plus the record ids by role. `mutate(spec)` may edit a row's spec before it is
 * built (spec: `{ tokens, id, version, active, runId, decision, summary, cells }`); return `null` to drop the row.
 */
function doubledSheet({ projectNo = PROJECT_NO, mutate } = {}) {
  const specs = []
  OLD_PATHS.forEach((tokens, index) => specs.push({ role: 'old', tokens, id: `rec_old_${index + 1}`, version: 3 + index }))
  COPY_PATHS.forEach((tokens, index) => specs.push({ role: 'copy', tokens, id: `rec_copy_${index + 1}`, version: 1 }))
  OTHER_PATHS.forEach((tokens, index) => specs.push({ role: 'other', tokens, id: `rec_other_${index + 1}`, version: 1 }))
  const rows = []
  const ids = { old: [], copy: [], other: [] }
  for (const spec of specs) {
    const next = typeof mutate === 'function' ? mutate({ ...spec, cells: {} }) : spec
    if (next === null) continue
    const row = sheetRow({ projectNo, ...(next || spec) })
    rows.push(row)
    ids[spec.role].push(spec.id)
  }
  return { rows, ids, projectNo }
}

/** The idempotency keys of a current expansion in which the component is only reached under its parent (the old root left). */
function expansionKeysOf({ projectNo = PROJECT_NO, includeOldRoot = false, includeOldChild = false } = {}) {
  const keys = new Set(COPY_PATHS.concat(OTHER_PATHS).map((tokens) => expectedKeyForTokens(projectNo, tokens)))
  if (includeOldRoot) keys.add(expectedKeyForTokens(projectNo, OLD_PATHS[0]))
  if (includeOldChild) keys.add(expectedKeyForTokens(projectNo, OLD_PATHS[1]))
  return keys
}

function handleOf(component = OLD_ROOT, { tenantId = TENANT_ID, projectNo = PROJECT_NO } = {}) {
  return componentHandle(tenantId, projectNo, component)
}

// ── a records host over reader-shaped rows ───────────────────────────────────────────────────────────

const WRITE_FIELDS = Object.freeze(['active', 'lastPlmRefreshRunId', 'lastPlmRefreshDecision', 'lastPlmConflictSummary'])
/** The physical ids the fixture's host uses for the four repair cells (a distinct namespace, so a logical id sent raw is seen). */
const PHYSICAL_FIELD_IDS = Object.freeze(Object.fromEntries(WRITE_FIELDS.map((fieldId) => [fieldId, `fld_syn_${fieldId}`])))

/**
 * A records host whose records are the fixture's rows: `patchRecord({ recordId, changes, expectedVersion })` is
 * version-conditional (VERSION_CONFLICT), refuses a locked record (FORBIDDEN) and a missing one (NOT_FOUND), merges
 * the PHYSICAL changes back onto the logical row and bumps the version by one. `rows()` re-reads the sheet as the
 * reader would (fresh record refs). Hooks: `beforePatch(recordId, callIndex)` runs before each patch (a test moves a
 * row, drops the lease, throws).
 */
function makeHost(rows) {
  const records = new Map()
  for (const row of rows) {
    const ref = row[EXISTING_ROW_RECORD_REF]
    if (!ref) continue
    const data = {}
    for (const key of Object.keys(row)) data[key] = row[key]
    records.set(ref.id, { id: ref.id, version: ref.version, locked: false, data })
  }
  const unaddressable = rows.filter((row) => !row[EXISTING_ROW_RECORD_REF])
  const logicalOf = Object.fromEntries(Object.entries(PHYSICAL_FIELD_IDS).map(([logical, physical]) => [physical, logical]))
  const calls = []
  const host = {
    records,
    calls,
    beforePatch: null,
    async patchRecord({ recordId, changes, expectedVersion }) {
      calls.push({ recordId, changes: clone(changes), expectedVersion })
      if (typeof host.beforePatch === 'function') await host.beforePatch(recordId, calls.length)
      const record = records.get(recordId)
      if (!record) throw Object.assign(new Error('Record not found'), { code: 'NOT_FOUND' })
      if (expectedVersion !== undefined && expectedVersion !== record.version) throw Object.assign(new Error('version conflict'), { code: 'VERSION_CONFLICT' })
      if (record.locked) throw Object.assign(new Error('Record is locked'), { code: 'FORBIDDEN' })
      for (const [key, value] of Object.entries(changes)) {
        if (!Object.prototype.hasOwnProperty.call(logicalOf, key)) throw Object.assign(new Error(`Unknown fieldId: ${key}`), { code: 'VALIDATION_ERROR' })
        record.data[logicalOf[key]] = value
      }
      record.version += 1
      return { id: record.id, version: record.version, data: clone(record.data) }
    },
    /** A person's edit of a human cell: the cell changes and the version moves. */
    humanEdit(recordId, cells) {
      const record = records.get(recordId)
      Object.assign(record.data, cells)
      record.version += 1
    },
    rows() {
      const out = Array.from(records.values()).map((record) => {
        const row = { ...clone(record.data) }
        row[EXISTING_ROW_RECORD_REF] = Object.freeze({ id: record.id, version: record.version })
        return row
      })
      return out.concat(unaddressable)
    },
    dataOf(recordId) {
      return clone(records.get(recordId).data)
    },
    versionOf(recordId) {
      return records.get(recordId).version
    },
  }
  return host
}

function createClock(startIso = '2026-11-10T01:00:00.000Z') {
  return pbKit.createClock(startIso)
}

module.exports = {
  COPY_PATHS,
  MIGRATION_FILES,
  OLD_PATHS,
  OLD_ROOT,
  OTHER_PATHS,
  PARENT,
  PHYSICAL_FIELD_IDS,
  PROJECT_NO,
  PULL_RUN_ID,
  RETIRE_SUMMARY: SHEET_REPAIR_RETIRE_SUMMARY,
  SHAPE_CHECKS,
  SHEET_ID,
  T,
  TENANT_ID,
  UNIQUE_INDEXES,
  clone,
  createClock,
  createFakeRepairDb,
  doubledSheet,
  expansionKeysOf,
  handleOf,
  makeHost,
  sheetRow,
  sqlError,
}
