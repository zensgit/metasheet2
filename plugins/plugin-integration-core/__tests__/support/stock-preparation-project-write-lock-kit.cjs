'use strict'

// Test kit for the stock-preparation PROJECT WRITE LOCK (lib/stock-preparation-project-write-lock.cjs).
// Not a suite (lives under support/, so the chain-completeness walk does not see it).
//
// It holds three things the lock suites share:
//   1. a FAITHFUL fake of the scoped db helper (lib/db.cjs) over one in-memory table: equality WHERE
//      with null meaning IS NULL, PRIMARY KEY 23505 on insert, RETURNING arrays, per-method fault
//      injection, and per-method pause hooks so a test can freeze one statement mid-flight and run
//      another one against the same row;
//   2. small fakes for the stores the lib needs (a token store WITH an atomic consume, a source
//      adapter, a records API);
//   3. the synthetic GOLDEN fixture whose revision digests were captured on a clean origin/main
//      (4c78e75a0) before this change and are asserted as literals. Every value in it is synthetic.

const crypto = require('node:crypto')
const path = require('node:path')

const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  normalizeActionParameters,
} = require(path.join(__dirname, '..', '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  createStockPreparationProjectWriteLock,
  projectWriteScopeKey,
  writeBindingFromGeneration,
} = require(path.join(__dirname, '..', '..', 'lib', 'stock-preparation-project-write-lock.cjs'))

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

// ---------------------------------------------------------------------------------------------------
// 1. Fake scoped db
// ---------------------------------------------------------------------------------------------------

function uniqueViolation() {
  const error = new Error('duplicate key value violates unique constraint')
  error.code = '23505'
  return error
}

function matches(row, where) {
  return Object.entries(where || {}).every(([column, expected]) => {
    if (expected === null || expected === undefined) return row[column] === null || row[column] === undefined
    return row[column] === expected
  })
}

// `faults[method]` = an Error (thrown once and cleared), or a function(args) that returns an Error to
// throw (kept until the test removes it). `pauses[method]` = an async function(args) awaited BEFORE
// the statement takes effect — the statement is atomic from the moment the pause resolves, which is
// what a single PostgreSQL statement is.
function createFakeLockDb({ primaryKey = 'scope_key' } = {}) {
  const tables = new Map()
  const faults = {}
  const pauses = {}
  const log = []
  function table(name) {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  async function enter(method, args) {
    log.push([method, clone(args)])
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
  return {
    tables,
    faults,
    pauses,
    log,
    rows(name) {
      return Array.from(table(name).values()).map(clone)
    },
    async selectOne(name, where) {
      await enter('selectOne', { table: name, where })
      for (const row of table(name).values()) {
        if (matches(row, where)) return clone(row)
      }
      return null
    },
    async insertOne(name, row) {
      await enter('insertOne', { table: name, row })
      const rows = table(name)
      const key = row[primaryKey]
      if (rows.has(key)) throw uniqueViolation()
      rows.set(key, clone(row))
      return [clone(row)]
    },
    async updateRow(name, set, where) {
      await enter('updateRow', { table: name, set, where })
      const out = []
      for (const [key, row] of table(name).entries()) {
        if (!matches(row, where)) continue
        const next = { ...row, ...clone(set) }
        table(name).set(key, next)
        out.push(clone(next))
      }
      return out
    },
    async deleteRows(name, where) {
      await enter('deleteRows', { table: name, where })
      const out = []
      for (const [key, row] of Array.from(table(name).entries())) {
        if (!matches(row, where)) continue
        table(name).delete(key)
        out.push(clone(row))
      }
      return out
    },
  }
}

// A controllable clock. `now()` answers a Date, the shape the lock module asks for.
function createClock(startIso = '2026-10-22T00:00:00.000Z') {
  let ms = Date.parse(startIso)
  return {
    now: () => new Date(ms),
    advance(deltaMs) { ms += deltaMs },
    set(iso) { ms = Date.parse(iso) },
    ms: () => ms,
  }
}

// Manual timers: the heartbeat registers here and a test fires it explicitly.
function createManualTimers() {
  const active = new Map()
  let seq = 0
  return {
    active,
    setInterval(fn, ms) {
      seq += 1
      const handle = { id: seq, fn, ms, unref() { return handle } }
      active.set(seq, handle)
      return handle
    },
    clearInterval(handle) {
      if (handle) active.delete(handle.id)
    },
    async fireAll() {
      for (const handle of Array.from(active.values())) await handle.fn()
    },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------------------------------
// 2. Store fakes
// ---------------------------------------------------------------------------------------------------

// The host storage contract (packages/core-backend/src/types/plugin.ts): get / set / delete and the
// OPTIONAL atomic consume. `consume` here is atomic the way the durable one is (one DELETE ... RETURNING):
// the read and the removal happen in one synchronous step, so two concurrent consumes of one key can
// never both answer the value.
function createConsumableStorage({ withConsume = true } = {}) {
  const map = new Map()
  const calls = []
  const store = {
    map,
    calls,
    async get(key) {
      calls.push(['get', key])
      return map.has(key) ? clone(map.get(key)) : null
    },
    async set(key, value) {
      calls.push(['set', key])
      map.set(key, clone(value))
    },
    async delete(key) {
      calls.push(['delete', key])
      map.delete(key)
    },
  }
  if (withConsume) {
    store.consume = async (key) => {
      calls.push(['consume', key])
      if (!map.has(key)) return null
      const value = map.get(key)
      map.delete(key)
      return clone(value)
    }
  }
  return store
}

function createSourceAdapter(data) {
  const calls = []
  return {
    calls,
    adapter: {
      async read(input = {}) {
        calls.push(clone(input))
        const rows = Array.isArray(data[input.object]) ? data[input.object] : []
        const found = rows.filter((row) =>
          Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected),
        )
        const offset = input.cursor ? Number(input.cursor) : 0
        const limit = input.limit || 1000
        const records = found.slice(offset, offset + limit).map(clone)
        return {
          records,
          done: offset + records.length >= found.length,
          nextCursor: offset + records.length < found.length ? String(offset + records.length) : null,
        }
      },
    },
  }
}

// `beforeWrite` (optional) is awaited inside createRecord / patchRecord BEFORE the row changes — the
// hook a test uses to hold a writer mid-run.
function createRecordsApi({ existing = [], beforeWrite } = {}) {
  const rows = existing.map((entry, index) => ({
    id: entry.id || `rec_${index + 1}`,
    sheetId: entry.sheetId,
    version: entry.version || 1,
    data: { ...(entry.data || {}) },
  }))
  const calls = []
  let created = 0
  return {
    rows,
    calls,
    writes: () => calls.filter(([method]) => method === 'createRecord' || method === 'patchRecord'),
    recordsApi: {
      async queryRecords(input = {}) {
        calls.push(['queryRecords', clone(input)])
        return rows
          .filter((record) => record.sheetId === input.sheetId)
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
          .map(clone)
      },
      async createRecord(input = {}) {
        calls.push(['createRecord', clone(input)])
        if (typeof beforeWrite === 'function') await beforeWrite('createRecord', input)
        created += 1
        const record = { id: `rec_new_${created}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(record)
        return clone(record)
      },
      async patchRecord(input = {}) {
        calls.push(['patchRecord', clone(input)])
        if (typeof beforeWrite === 'function') await beforeWrite('patchRecord', input)
        const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
        if (!record) throw new Error('record not found')
        record.version += 1
        record.data = { ...record.data, ...(input.changes || {}) }
        return clone(record)
      },
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// 2b. The REAL lock module over the fake db, and the wrappers that let pre-existing callers of the lib
//     (and route mounts) run through it.
// ---------------------------------------------------------------------------------------------------

// `timers: 'real'` keeps the module's own unref'd setInterval; the default is manual timers.
function createInMemoryProjectWriteLock({ db, clock, timers, ...options } = {}) {
  const lockDb = db || createFakeLockDb()
  const lockClock = clock || null
  const lockTimers = timers === 'real' ? undefined : (timers || createManualTimers())
  const lock = createStockPreparationProjectWriteLock({
    db: lockDb,
    ...(lockClock ? { now: lockClock.now } : {}),
    ...(lockTimers ? { timers: lockTimers } : {}),
    ...options,
  })
  return { db: lockDb, clock: lockClock, timers: lockTimers, lock }
}

// The write scope a table-action input addresses, or null when the input cannot name one (the lib then
// refuses with its own error before it ever asks for the guard).
function writeScopeOfInput(input = {}) {
  try {
    return projectWriteScopeKey(input.action && input.action.target && input.action.target.sheetId, normalizeActionParameters(input.parameters).projectNo)
  } catch {
    return null
  }
}

// Wraps `dryRunStockPreparationAction` / `applyStockPreparationAction` the way the routes call them:
// the dry-run gets a generation binder (an applicable preview bumps), the apply runs inside the lease
// with the guard. A caller that passes `projectWriteGenerationBinder` / `projectWriteGuard` itself
// (even as undefined) is passed through untouched — that is how the guard's own tests opt out.
function createLibWriteLockHarness(options = {}) {
  const env = options.lock ? { lock: options.lock } : createInMemoryProjectWriteLock(options)
  function wrapDryRun(dryRun) {
    return (input = {}) => {
      if (Object.prototype.hasOwnProperty.call(input, 'projectWriteGenerationBinder')) return dryRun(input)
      const scope = writeScopeOfInput(input)
      return dryRun({
        ...input,
        projectWriteGenerationBinder: scope
          ? async () => writeBindingFromGeneration(await env.lock.bumpGeneration(scope, { reason: 'small_preview', tenantId: input.tenantId }))
          : undefined,
      })
    }
  }
  function wrapApply(apply) {
    return (input = {}) => {
      if (Object.prototype.hasOwnProperty.call(input, 'projectWriteGuard')) return apply(input)
      const scope = writeScopeOfInput(input)
      if (!scope) return apply(input)
      return env.lock.withProjectWriteLease(scope, { purpose: 'small_apply', runId: 'swl-test-run', tenantId: input.tenantId }, (guard) => apply({ ...input, projectWriteGuard: guard }))
    }
  }
  return { ...env, wrapDryRun, wrapApply, scopeOf: writeScopeOfInput }
}

// ---------------------------------------------------------------------------------------------------
// 3. The synthetic golden fixture
// ---------------------------------------------------------------------------------------------------

const GOLDEN_SHEET_ID = 'sheet_swl_golden'
const GOLDEN_PROJECT_NO = 'SYN-SWL-0001'
const GOLDEN_PLANNED_AT = '2026-10-22T08:00:00.000Z'
const GOLDEN_RUN_ID = 'run_swl_golden'
const SANDBOX_POLICY = Object.freeze({ enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] })

function goldenAction(overrides = {}) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'swl_source_1', kind: 'data-source:sql-readonly' },
    target: { sheetId: GOLDEN_SHEET_ID, objectId: 'stockPreparationMain' },
    ...overrides,
  }
}

function goldenPlmData(projectNo = GOLDEN_PROJECT_NO) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: 'SWL-PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'SWL-PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'SWL-ORDER-1', path_id: 'SWL-PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'SWL-ORDER-1', part_id: 'SWL-PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [
      { OBJ_ID: 'SWL-PART-A', IdentityNo: 'SWL-A-001', IdentityName: 'Synthetic assembly', Material: 'Synthetic', SysVer: 'V1' },
      { OBJ_ID: 'SWL-PART-B', IdentityNo: 'SWL-B-001', IdentityName: 'Synthetic part', Material: 'Synthetic', SysVer: 'V1' },
    ],
    DN_PDM_BomHeadInfo: [{ part_id: 'SWL-PART-A', bom_id: 'SWL-BOM-A', SysVer: 'V1', bom_able: true }],
    DN_PDM_BomDetailsInfo: [{ bom_pid: 'SWL-BOM-A', part_id: 'SWL-PART-B', Bom_ExAttr1: '3' }],
  }
}

function hashJsonForGolden(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

module.exports = {
  GOLDEN_PLANNED_AT,
  GOLDEN_PROJECT_NO,
  GOLDEN_RUN_ID,
  GOLDEN_SHEET_ID,
  SANDBOX_POLICY,
  clone,
  createClock,
  createConsumableStorage,
  createFakeLockDb,
  createInMemoryProjectWriteLock,
  createLibWriteLockHarness,
  createManualTimers,
  createRecordsApi,
  createSourceAdapter,
  deferred,
  goldenAction,
  goldenPlmData,
  hashJsonForGolden,
  uniqueViolation,
  writeScopeOfInput,
}
