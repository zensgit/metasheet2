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
  HOST_WRITE_FENCE_CODES,
  PROJECT_WRITE_LOCK_TABLE,
  createStockPreparationProjectWriteLock,
  sheetWriteScopeKey,
  writeBindingFromGeneration,
  writeObservationFromGeneration,
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
// Every fake lock db made in this process, so a fake records host can answer a fence without being told
// which db holds the lease (lease ids are random UUIDs, so a fence matches at most one db's row).
const FAKE_LOCK_DBS = new Set()

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
  const db = {
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
    // The scoped helper's `transaction` (lib/db.cjs): the handle carries the same CRUD methods (so faults,
    // pauses and the log apply unchanged) plus the handle-only `setLocalLockTimeout`, which the lock's
    // bounded statements call FIRST (review round 6, S1). Logged as ['setLocalLockTimeout', { ms }]; a
    // fault keyed 'setLocalLockTimeout' is honoured like any other. The fake has no row locks, so a bound
    // never fires by itself: a test that wants 55P03 injects it on `updateRow` (faults).
    async transaction(callback) {
      await enter('transaction', {})
      return callback({
        async setLocalLockTimeout(ms) {
          await enter('setLocalLockTimeout', { ms })
          if (!Number.isInteger(ms) || ms <= 0 || ms > 30000) throw new Error('setLocalLockTimeout: integer 1..30000 required')
        },
        selectOne: db.selectOne,
        insertOne: db.insertOne,
        updateRow: db.updateRow,
        deleteRows: db.deleteRows,
      })
    },
    // The fake host's fence read: synchronous, so check + write are one step (the real host holds the
    // row FOR SHARE until COMMIT; a takeover/bump can then only land before or after the whole write).
    fenceRowExists(fence) {
      for (const row of table(PROJECT_WRITE_LOCK_TABLE).values()) {
        if (row.scope_key === fence.scopeKey && row.lease_id === fence.leaseId
          && Number(row.fencing_epoch) === Number(fence.fencingEpoch) && row.generation_token === fence.generationToken) return true
      }
      return false
    },
  }
  FAKE_LOCK_DBS.add(db)
  return db
}

// ---------------------------------------------------------------------------------------------------
// 1b. The fake host's half of a fenced write (mirrors packages/core-backend/src/multitable/
//     plugin-write-fence.ts: exact five keys, the one allow-listed lock, the row must still match).
// ---------------------------------------------------------------------------------------------------

function hostFenceError(code, message) {
  const error = new Error(message)
  error.code = code
  error.status = code === HOST_WRITE_FENCE_CODES.REJECTED ? 409 : 403
  return error
}

const FENCE_KEYS = ['lock', 'scopeKey', 'leaseId', 'fencingEpoch', 'generationToken']

// `lockDb` pins the lookup to one fake db; otherwise every fake db in the process is searched.
function assertFakeHostWriteFence(fence, { lockDb } = {}) {
  if (fence === undefined) return
  if (!fence || typeof fence !== 'object' || Array.isArray(fence)) throw hostFenceError(HOST_WRITE_FENCE_CODES.NOT_ALLOWED, 'fence shape')
  const keys = Object.keys(fence)
  if (keys.length !== FENCE_KEYS.length || !FENCE_KEYS.every((key) => keys.includes(key))) throw hostFenceError(HOST_WRITE_FENCE_CODES.NOT_ALLOWED, 'fence shape')
  if (fence.lock !== PROJECT_WRITE_LOCK_TABLE) throw hostFenceError(HOST_WRITE_FENCE_CODES.NOT_ALLOWED, 'lock not allowed')
  const dbs = lockDb ? [lockDb] : Array.from(FAKE_LOCK_DBS)
  if (!dbs.some((db) => db.fenceRowExists(fence))) throw hostFenceError(HOST_WRITE_FENCE_CODES.REJECTED, 'the write fence no longer holds')
}

// Wrap ANY records fake so it declares and enforces the host fence: `writeFence` is checked right before
// the delegated write and stripped from what the wrapped fake sees (its own call logs stay as they were).
// A transparent Proxy: every other read / write goes to the wrapped fake, so a test that swaps one of its
// methods later still reaches it. An api that already declares `supportsWriteFence` is returned as is.
function withFakeHostWriteFence(recordsApi, options = {}) {
  if (!recordsApi || recordsApi.supportsWriteFence === true) return recordsApi
  const fences = []
  const fencedMethod = (method) => async (input = {}) => {
    if (!input || !Object.prototype.hasOwnProperty.call(input, 'writeFence')) return recordsApi[method](input)
    const { writeFence, ...rest } = input
    fences.push([method, clone(writeFence)])
    assertFakeHostWriteFence(writeFence, options)
    return recordsApi[method](rest)
  }
  return new Proxy(recordsApi, {
    get(target, key, receiver) {
      if (key === 'supportsWriteFence') return true
      if (key === 'fakeHostFences') return fences
      if ((key === 'createRecord' || key === 'patchRecord') && typeof target[key] === 'function') return fencedMethod(key)
      return Reflect.get(target, key, receiver)
    },
  })
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
// hook a test uses to hold a writer mid-run. The fake HOST FENCE (P1-a) is checked AFTER that hook and
// atomically with the row change, the way the real host checks it inside the write transaction;
// `hostFence: false` builds a host without fence support (no `supportsWriteFence`; a fence is ignored).
// Calls are logged WITHOUT the fence; `fences` logs the fences seen.
function createRecordsApi({ existing = [], beforeWrite, hostFence = true, lockDb } = {}) {
  const rows = existing.map((entry, index) => ({
    id: entry.id || `rec_${index + 1}`,
    sheetId: entry.sheetId,
    version: entry.version || 1,
    data: { ...(entry.data || {}) },
  }))
  const calls = []
  const fences = []
  let created = 0
  function logWrite(method, input) {
    const { writeFence, ...rest } = input
    calls.push([method, clone(rest)])
    if (writeFence !== undefined) fences.push([method, clone(writeFence)])
  }
  function checkFence(input) {
    if (hostFence) assertFakeHostWriteFence(input.writeFence, { lockDb })
  }
  return {
    rows,
    calls,
    fences,
    writes: () => calls.filter(([method]) => method === 'createRecord' || method === 'patchRecord'),
    recordsApi: {
      ...(hostFence ? { supportsWriteFence: true } : {}),
      async queryRecords(input = {}) {
        calls.push(['queryRecords', clone(input)])
        return rows
          .filter((record) => record.sheetId === input.sheetId)
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
          .map(clone)
      },
      async createRecord(input = {}) {
        logWrite('createRecord', input)
        if (typeof beforeWrite === 'function') await beforeWrite('createRecord', input)
        checkFence(input)
        created += 1
        const record = { id: `rec_new_${created}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(record)
        return clone(record)
      },
      async patchRecord(input = {}) {
        logWrite('patchRecord', input)
        if (typeof beforeWrite === 'function') await beforeWrite('patchRecord', input)
        checkFence(input)
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

// The write scope a table-action input addresses (its target sheet, R-52; the project number is validated
// the way the routes validate it), or null when the input cannot name one (the lib then refuses with its own
// error before it ever asks for the guard).
function writeScopeOfInput(input = {}) {
  try {
    normalizeActionParameters(input.parameters)
    return sheetWriteScopeKey(input.action && input.action.target && input.action.target.sheetId)
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
      // A records fake that predates the host fence gets the fake host's fence (declared + enforced).
      const recordsApi = withFakeHostWriteFence(input.recordsApi)
      return env.lock.withProjectWriteLease(scope, { purpose: 'small_apply', runId: 'swl-test-run', tenantId: input.tenantId }, (guard) => apply({ ...input, recordsApi, projectWriteGuard: guard }))
    }
  }
  // The large lane, the way the routes drive it: the expansion start through the generation OBSERVER and
  // the plan through the generation READER (P1-b; scope = the action's target sheet), approval through the
  // generation binder (scope = the expansion snapshot's sheet; the bump is conditional on what the
  // expansion observed), every chunk inside the lease with the guard (scope = the job's own binding).
  // Same opt-out rule as above.
  function wrapLargeExpansionStart(createJob) {
    return async (input = {}) => {
      if (Object.prototype.hasOwnProperty.call(input, 'writeGenerationObserver')) return createJob(input)
      const sheetId = input.action && input.action.target && input.action.target.sheetId
      const scope = typeof sheetId === 'string' && sheetId ? sheetWriteScopeKey(sheetId) : null
      return createJob({
        ...input,
        writeGenerationObserver: scope ? async () => writeObservationFromGeneration(await env.lock.observeGeneration(scope)) : undefined,
      })
    }
  }
  function wrapLargePlan(planJob) {
    return async (input = {}) => {
      if (Object.prototype.hasOwnProperty.call(input, 'writeGenerationReader')) return planJob(input)
      return planJob({ ...input, writeGenerationReader: (scope) => env.lock.readGeneration(scope) })
    }
  }
  function wrapLargeApprove(createJob) {
    return async (input = {}) => {
      if (Object.prototype.hasOwnProperty.call(input, 'writeGenerationBinder')) return createJob(input)
      let scope = null
      try {
        const largeBomJobs = require(path.join(__dirname, '..', '..', 'lib', 'stock-preparation-large-bom-jobs.cjs'))
        const source = await largeBomJobs.loadLargeBomBackgroundExpansionJob({
          storage: input.storage, tenantId: input.tenantId, workspaceId: input.workspaceId, actionId: input.actionId, jobId: input.jobId,
        })
        scope = sheetWriteScopeKey(source.actionSnapshot.target.sheetId)
      } catch {
        scope = null
      }
      return createJob({
        ...input,
        writeGenerationBinder: scope
          ? async (expect) => writeBindingFromGeneration(await env.lock.bumpGeneration(scope, { reason: 'large_approval', tenantId: input.tenantId, expect }))
          : undefined,
      })
    }
  }
  function wrapLargeChunk(runChunk) {
    return async (input = {}) => {
      if (Object.prototype.hasOwnProperty.call(input, 'projectWriteGuard')) return runChunk(input)
      let job = null
      try {
        const largeBomJobs = require(path.join(__dirname, '..', '..', 'lib', 'stock-preparation-large-bom-jobs.cjs'))
        job = await input.storage.get(largeBomJobs.__internals.checkpointApplyJobKey({ ...input, applyJobId: input.applyJobId || input.jobId }))
      } catch {
        job = null
      }
      const scope = job && typeof job.writeScope === 'string' ? job.writeScope : null
      if (!scope) return runChunk(input)
      const recordsApi = withFakeHostWriteFence(input.recordsApi)
      return env.lock.withProjectWriteLease(scope, { purpose: 'large_apply_chunk', runId: 'swl-test-chunk', tenantId: input.tenantId }, (guard) => runChunk({ ...input, recordsApi, projectWriteGuard: guard }))
    }
  }
  return { ...env, wrapDryRun, wrapApply, wrapLargeExpansionStart, wrapLargePlan, wrapLargeApprove, wrapLargeChunk, scopeOf: writeScopeOfInput }
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
  assertFakeHostWriteFence,
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
  withFakeHostWriteFence,
  writeScopeOfInput,
}
