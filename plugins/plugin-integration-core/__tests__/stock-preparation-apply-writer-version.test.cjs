'use strict'

// Batch-refresh step 5, PR-8 — THE WRITER'S VERSION FENCE (design §10.3 (2) last sentence, D-2; the generic F15
// hazard; plan §5.1 「普通人工填写可继续；机器写入不得覆盖它」, A12). Register R-63 ①.
//
// The records fake below models the HOST's patchRecord the way packages/core-backend/src/multitable/records.ts does:
// it READS the record, compares `expectedVersion` with what it read, MERGES the patch into what it read, and writes
// `data = merged, version = version + 1 WHERE id [AND version = expected]`. Two hooks inject a concurrent commit:
//   beforeHostRead(recordId)  — between the writer's lookup and the host's read (the recompute -> write window);
//   insideHostWrite(recordId) — between the host's read and its UPDATE (the F15 read-modify-write window).
//
// Cases:
//   EV-1  an entry => the host call carries the entry's version; no map / no entry for the key => the host call is
//         byte-identical to the pre-PR-8 call (deep-equal); an ADD that finds a row ignores the map (byte-identical).
//   EV-2  a person's edit (a column the plugin does not write) moved the version => ONE re-read, ONE retry with the
//         fresh version, the SAME patch, the person's value intact.
//   EV-3  a plugin-written column moved => the run STOPS (409 STOCK_PREP_CHANGE_PLAN_STALE machine_columns_moved),
//         nothing after it is written.
//   EV-4  the retry conflicts again => stop `version_conflict_repeated`.
//   EV-5  the planned row replaced (lookup) / gone or doubled or replaced (re-read) => stop by name, no patch.
//   EV-6  the re-read bypasses the chunk's prefetch index (a fresh per-key query).
//   EV-8  F15 itself: a person's commit INSIDE the host's read-modify-write window is LOST without a version and KEPT
//         with one (the conflict, the re-read, the retry).
//   EV-9  the map is validated before any IO (a malformed entry is a caller defect: 500-class writer error, zero IO).
//   EV-10 the large chunk's writer call carries no map (source pin): its host calls stay byte-identical.
// Synthetic values only.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const { DECISIONS } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const writer = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))

const { applyStockPreparationPlan, CHANGE_PLAN_STALE_CODE, StockPreparationApplyWriterError } = writer

const tests = []
const test = (name, fn) => tests.push([name, fn])

const SHEET = 'sheet_ev_main'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function keyOf(component) {
  return JSON.stringify({ projectNo: 'P-EV', componentSourceId: component, parentSourceId: null, path: [component] })
}

function seedRow(component, id, extra = {}) {
  return {
    id,
    sheetId: SHEET,
    version: 3,
    data: {
      idempotencyKey: keyOf(component),
      projectNo: 'P-EV',
      componentSourceId: component,
      componentCode: `${component}-C`,
      material: 'M-1',
      rawQuantity: 2,
      totalQuantity: 2,
      active: true,
      notes: null,
      ...extra,
    },
  }
}

function updateDecision(component, patch) {
  return {
    decision: DECISIONS.UPDATE,
    idempotencyKey: keyOf(component),
    patch: { ...patch, lastPlmRefreshRunId: 'run_ev', lastPlmRefreshAt: '2026-10-27T00:00:00.000Z', lastPlmRefreshDecision: 'update', lastPlmConflictSummary: '{}' },
    changedFields: Object.keys(patch),
    conflictSummary: { type: 'plm_system_refresh', changedFieldCount: Object.keys(patch).length },
  }
}

function inactiveDecision(component) {
  return {
    decision: DECISIONS.INACTIVE,
    idempotencyKey: keyOf(component),
    patch: { active: false, lastPlmRefreshRunId: 'run_ev', lastPlmRefreshAt: '2026-10-27T00:00:00.000Z', lastPlmRefreshDecision: 'inactive', lastPlmConflictSummary: '{"type":"missing_from_plm"}' },
    conflictSummary: { type: 'missing_from_plm' },
  }
}

function versionConflict() {
  return Object.assign(new Error('Record version conflict'), { code: 'VERSION_CONFLICT', name: 'MultitableRecordVersionConflictError' })
}

// The host, as records.ts models it (read -> compare -> merge -> UPDATE ... [AND version = expected]).
function createHost(seed, { batchCapable = false } = {}) {
  const rows = seed.map(clone)
  const calls = []
  const hooks = { beforeHostRead: null, insideHostWrite: null }
  const api = {
    supportsWriteFence: true,
    ...(batchCapable ? { supportsFilterValueLists: true } : {}),
    async queryRecords(input = {}) {
      calls.push(['queryRecords', clone(input)])
      return rows
        .filter((record) => record.sheetId === input.sheetId)
        .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => (Array.isArray(value) ? value.includes(record.data[field]) : record.data[field] === value)))
        .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
        .map(clone)
    },
    async createRecord(input = {}) {
      const { writeFence, ...rest } = input
      calls.push(['createRecord', clone(rest)])
      const record = { id: `rec_ev_new_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(record)
      return clone(record)
    },
    async patchRecord(input = {}) {
      const { writeFence, ...rest } = input
      calls.push(['patchRecord', clone(rest)])
      if (hooks.beforeHostRead) await hooks.beforeHostRead(input.recordId)
      const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
      if (!record) throw Object.assign(new Error('Record not found'), { name: 'MultitableRecordNotFoundError' })
      if (input.expectedVersion !== undefined && record.version !== input.expectedVersion) throw versionConflict()
      const read = clone(record.data)
      if (hooks.insideHostWrite) await hooks.insideHostWrite(input.recordId)
      // UPDATE meta_records SET data = merged, version = version + 1 WHERE id [AND version = expected]
      if (input.expectedVersion !== undefined && record.version !== input.expectedVersion) throw versionConflict()
      record.data = { ...read, ...(input.changes || {}) }
      record.version += 1
      return clone(record)
    },
  }
  return { rows, calls, hooks, api }
}

// A commit by "someone else" straight into the host's row (a person's cell, or a host-side machine write).
function commit(host, recordId, changes) {
  const record = host.rows.find((row) => row.id === recordId)
  record.data = { ...record.data, ...changes }
  record.version += 1
}

function expectedFor(rows) {
  return new Map(rows.map((row) => [row.data.idempotencyKey, { id: row.id, version: row.version, row: clone(row.data) }]))
}

function apply(host, plan, extra = {}) {
  return applyStockPreparationPlan({
    permission: 'write',
    plan: { decisions: plan },
    target: { sheetId: SHEET, objectId: 'stockPreparationMain' },
    recordsApi: host.api,
    ...extra,
  })
}

const patchesOf = (host) => host.calls.filter(([method]) => method === 'patchRecord').map(([, input]) => input)
const scalarQueriesOf = (host) => host.calls.filter(([method, input]) => method === 'queryRecords' && !Object.values(input.filters || {}).some(Array.isArray))

// ── EV-1 ───────────────────────────────────────────────────────────────────────────────────────────────

test('EV-1a an entry => the host patch carries exactly the entry\'s version', async () => {
  const seed = [seedRow('A', 'rec_a'), seedRow('B', 'rec_b')]
  const host = createHost(seed)
  const result = await apply(host, [updateDecision('A', { material: 'M-2' }), inactiveDecision('B')], { expectedRecords: expectedFor(seed) })
  assert.equal(result.status, 'succeeded')
  const patches = patchesOf(host)
  assert.equal(patches.length, 2)
  assert.equal(patches[0].expectedVersion, 3)
  assert.equal(patches[1].expectedVersion, 3)
  assert.equal(host.rows[0].data.material, 'M-2')
  assert.equal(host.rows[1].data.active, false)
})

test('EV-1b no map / an empty map / no entry for the key => the host patch call is byte-identical to the pre-PR-8 call', async () => {
  const seed = [seedRow('A', 'rec_a')]
  const runs = []
  for (const variant of ['absent', 'null', 'empty', 'other_key']) {
    const host = createHost(seed)
    const extra = variant === 'absent' ? {} : variant === 'null' ? { expectedRecords: null } : variant === 'empty' ? { expectedRecords: new Map() }
      : { expectedRecords: new Map([[keyOf('Z'), { id: 'rec_z', version: 9, row: {} }]]) }
    const result = await apply(host, [updateDecision('A', { material: 'M-2' })], extra)
    runs.push({ result, patches: patchesOf(host) })
  }
  assert.equal(Object.prototype.hasOwnProperty.call(runs[0].patches[0], 'expectedVersion'), false, 'no expectedVersion key at all')
  for (const run of runs.slice(1)) {
    assert.deepEqual(run.patches, runs[0].patches)
    assert.deepEqual(run.result, runs[0].result)
  }
  // The exact pre-PR-8 shape: sheetId, recordId, changes — nothing else.
  assert.deepEqual(Object.keys(runs[0].patches[0]).sort(), ['changes', 'recordId', 'sheetId'])
})

test('EV-1c an ADD that finds an existing row is patched exactly as before, whatever the map says (D-2 correction)', async () => {
  const seed = [seedRow('A', 'rec_a')]
  const host = createHost(seed)
  const add = { decision: DECISIONS.ADD, idempotencyKey: keyOf('A'), record: { idempotencyKey: keyOf('A'), material: 'M-9' } }
  const result = await apply(host, [add], { expectedRecords: expectedFor(seed) })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(Object.keys(patchesOf(host)[0]).sort(), ['changes', 'recordId', 'sheetId'])
})

// ── EV-2 / EV-3 / EV-4 ─────────────────────────────────────────────────────────────────────────────────

test('EV-2 a person\'s edit since the recompute => one re-read, one retry with the fresh version, the same patch, the person\'s value kept', async () => {
  const seed = [seedRow('A', 'rec_a'), seedRow('B', 'rec_b')]
  const host = createHost(seed)
  const expected = expectedFor(seed)
  let injected = false
  host.hooks.beforeHostRead = async (recordId) => {
    if (recordId === 'rec_a' && !injected) {
      injected = true
      commit(host, 'rec_a', { notes: 'synthetic person note' })
    }
  }
  const result = await apply(host, [updateDecision('A', { material: 'M-2' }), updateDecision('B', { material: 'M-3' })], { expectedRecords: expected })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.counts.updated, 2)
  const patches = patchesOf(host)
  assert.equal(patches.length, 3, 'A twice (conflict + retry), B once')
  assert.equal(patches[0].expectedVersion, 3)
  assert.equal(patches[1].expectedVersion, 4, 'the retry carries the version the re-read found')
  assert.deepEqual(patches[1].changes, patches[0].changes, 'the patch is never rebuilt from the re-read row')
  assert.equal(Object.prototype.hasOwnProperty.call(patches[1].changes, 'notes'), false, 'the patch never carries a human column')
  assert.equal(host.rows[0].data.notes, 'synthetic person note', 'the person\'s value survives')
  assert.equal(host.rows[0].data.material, 'M-2')
  assert.equal(scalarQueriesOf(host).length >= 2, true, 'one fresh per-key read for the retry')
})

test('EV-2b the same under an EXPLICIT fieldIdMap (physical column ids, a pack ext_ column, a blank binding): the re-read is unmapped exactly like the planning read — a person\'s cell is never a false machine move', async () => {
  const fieldIdMap = { material: 'fld_mat', notes: 'fld_notes', rawQuantity: 'fld_raw', idempotencyKey: 'fld_key', ext_nameAndSpec: 'fld_ext_ns', componentCode: '' }
  const physical = (logical) => Object.fromEntries(Object.entries(logical).map(([field, value]) => [fieldIdMap[field] || field, value]))
  const logicalSeed = { idempotencyKey: keyOf('A'), projectNo: 'P-EV', componentSourceId: 'A', componentCode: 'A-C', material: 'M-1', rawQuantity: 2, ext_nameAndSpec: 'A spec', notes: null }
  const host = createHost([{ id: 'rec_a', sheetId: SHEET, version: 3, data: physical(logicalSeed) }])
  // The planning read's logical row, as readExistingStockPreparationRows unmaps it (the RAW action map).
  const inverse = Object.fromEntries(Object.entries(fieldIdMap).map(([logical, phys]) => [phys, logical]))
  const plannedRow = Object.fromEntries(Object.entries(physical(logicalSeed)).map(([field, value]) => [inverse[field] || field, value]))
  const expected = new Map([[keyOf('A'), { id: 'rec_a', version: 3, row: plannedRow }]])
  let injected = false
  host.hooks.beforeHostRead = async () => {
    if (injected) return
    injected = true
    commit(host, 'rec_a', { fld_notes: 'synthetic person note' })
  }
  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan: { decisions: [updateDecision('A', { material: 'M-2' })] },
    target: { sheetId: SHEET, objectId: 'stockPreparationMain', fieldIdMap, keyField: 'idempotencyKey' },
    recordsApi: host.api,
    expectedRecords: expected,
  })
  assert.equal(result.status, 'succeeded', JSON.stringify(result.abort && result.abort.error && result.abort.error.details))
  assert.equal(patchesOf(host).length, 2, 'one conflict, one retry')
  assert.equal(host.rows[0].data.fld_notes, 'synthetic person note')
  assert.equal(host.rows[0].data.fld_mat, 'M-2')
  // And a moved plugin-written PHYSICAL column (the pack's ext_ column) is a machine move.
  const host2 = createHost([{ id: 'rec_a', sheetId: SHEET, version: 3, data: physical(logicalSeed) }])
  let moved = false
  host2.hooks.beforeHostRead = async () => {
    if (moved) return
    moved = true
    commit(host2, 'rec_a', { fld_ext_ns: 'A spec (host write)' })
  }
  const stopped = await applyStockPreparationPlan({
    permission: 'write',
    plan: { decisions: [updateDecision('A', { material: 'M-2' })] },
    target: { sheetId: SHEET, objectId: 'stockPreparationMain', fieldIdMap, keyField: 'idempotencyKey' },
    recordsApi: host2.api,
    expectedRecords: expected,
    installedFieldProperties: [{ fieldId: 'ext_nameAndSpec', property: { stockPreparation: { ownership: 'plm_system', extension: true } } }],
  })
  assert.equal(stopped.status, 'aborted')
  assert.equal(stopped.abort.error.details.reason, 'machine_columns_moved')
})

test('EV-3 a plugin-written column moved since the recompute => the run stops machine_columns_moved; nothing after it', async () => {
  const seed = [seedRow('A', 'rec_a'), seedRow('B', 'rec_b')]
  const host = createHost(seed)
  host.hooks.beforeHostRead = async (recordId) => {
    if (recordId === 'rec_a' && host.rows[0].data.material === 'M-1') commit(host, 'rec_a', { material: 'M-HOST' })
  }
  const result = await apply(host, [updateDecision('A', { material: 'M-2' }), updateDecision('B', { material: 'M-3' })], { expectedRecords: expectedFor(seed) })
  assert.equal(result.status, 'aborted')
  assert.equal(result.abort.code, CHANGE_PLAN_STALE_CODE)
  assert.equal(result.abort.index, 0)
  assert.equal(result.abort.error.details.reason, 'machine_columns_moved')
  assert.equal(result.written, 0)
  assert.equal(patchesOf(host).length, 1, 'no retry, and decision B is never attempted')
  assert.equal(host.rows[0].data.material, 'M-HOST', 'the machine value the host wrote is not overwritten')
  assert.equal(host.rows[1].data.material, 'M-1')
})

test('EV-3b a RUN stamp moved counts as a plugin-written column (another plugin run): stop', async () => {
  const seed = [seedRow('A', 'rec_a')]
  const host = createHost(seed)
  host.hooks.beforeHostRead = async () => {
    if (!host.rows[0].data.lastPlmRefreshRunId) commit(host, 'rec_a', { lastPlmRefreshRunId: 'run_other' })
  }
  const result = await apply(host, [updateDecision('A', { material: 'M-2' })], { expectedRecords: expectedFor(seed) })
  assert.equal(result.status, 'aborted')
  assert.equal(result.abort.error.details.reason, 'machine_columns_moved')
})

test('EV-4 the retry conflicts again => stop version_conflict_repeated (no blind loop)', async () => {
  const seed = [seedRow('A', 'rec_a')]
  const host = createHost(seed)
  let n = 0
  host.hooks.beforeHostRead = async () => {
    n += 1
    if (n <= 2) commit(host, 'rec_a', { notes: `synthetic person note ${n}` })
  }
  const result = await apply(host, [updateDecision('A', { material: 'M-2' })], { expectedRecords: expectedFor(seed) })
  assert.equal(result.status, 'aborted')
  assert.equal(result.abort.error.details.reason, 'version_conflict_repeated')
  assert.equal(patchesOf(host).length, 2, 'exactly one retry')
  assert.equal(host.rows[0].data.material, 'M-1')
})

// ── EV-5 ───────────────────────────────────────────────────────────────────────────────────────────────

test('EV-5a the lookup finds another row under the key (re-created since the recompute) => stop record_replaced before any patch', async () => {
  const seed = [seedRow('A', 'rec_a')]
  const host = createHost([{ ...seed[0], id: 'rec_a_recreated' }])
  const result = await apply(host, [updateDecision('A', { material: 'M-2' })], { expectedRecords: expectedFor(seed) })
  assert.equal(result.status, 'aborted')
  assert.equal(result.abort.error.details.reason, 'record_replaced')
  assert.equal(patchesOf(host).length, 0)
})

test('EV-5b after a conflict the re-read finds the row gone / doubled / replaced => stop by name', async () => {
  for (const [reason, mutate] of [
    ['record_missing', (host) => { host.rows.splice(0, 1) }],
    ['duplicate_target_key', (host) => { host.rows.push({ ...clone(host.rows[0]), id: 'rec_a_twin' }) }],
    ['record_replaced', (host) => { host.rows[0].id = 'rec_a_other' }],
  ]) {
    const seed = [seedRow('A', 'rec_a')]
    const host = createHost(seed)
    let done = false
    host.hooks.beforeHostRead = async () => {
      if (done) return
      done = true
      commit(host, 'rec_a', { notes: 'synthetic' })
    }
    const original = host.api.queryRecords
    let queries = 0
    host.api.queryRecords = async (input) => {
      queries += 1
      if (queries === 2) mutate(host)
      return original(input)
    }
    const result = await apply(host, [updateDecision('A', { material: 'M-2' })], { expectedRecords: expectedFor(seed) })
    assert.equal(result.status, 'aborted', reason)
    assert.equal(result.abort.error.details.reason, reason)
    assert.equal(patchesOf(host).length, 1, `${reason}: no retry`)
  }
})

// ── EV-6 ───────────────────────────────────────────────────────────────────────────────────────────────

test('EV-6 the re-read is a fresh per-key query even when the chunk prefetched an index', async () => {
  const seed = [seedRow('A', 'rec_a'), seedRow('B', 'rec_b')]
  const host = createHost(seed, { batchCapable: true })
  let injected = false
  host.hooks.beforeHostRead = async (recordId) => {
    if (recordId === 'rec_a' && !injected) {
      injected = true
      commit(host, 'rec_a', { notes: 'synthetic' })
    }
  }
  const result = await apply(host, [updateDecision('A', { material: 'M-2' }), updateDecision('B', { material: 'M-3' })], { expectedRecords: expectedFor(seed) })
  assert.equal(result.status, 'succeeded')
  const lists = host.calls.filter(([method, input]) => method === 'queryRecords' && Object.values(input.filters || {}).some(Array.isArray))
  assert.equal(lists.length, 1, 'one prefetch for the chunk')
  const scalars = scalarQueriesOf(host)
  assert.equal(scalars.length, 1, 'exactly one per-key re-read (for A), none for B (served by the index)')
  assert.equal(scalars[0][1].filters.idempotencyKey, keyOf('A'))
})

// ── EV-8 (F15) ─────────────────────────────────────────────────────────────────────────────────────────

test('EV-8 F15: a person\'s commit inside the host read-modify-write window is LOST without a version and KEPT with one', async () => {
  const outcomes = {}
  for (const variant of ['without', 'with']) {
    const seed = [seedRow('A', 'rec_a')]
    const host = createHost(seed)
    let injected = false
    host.hooks.insideHostWrite = async () => {
      if (injected) return
      injected = true
      commit(host, 'rec_a', { notes: 'synthetic person note' })
    }
    const result = await apply(host, [updateDecision('A', { material: 'M-2' })], variant === 'with' ? { expectedRecords: expectedFor(seed) } : {})
    outcomes[variant] = { status: result.status, notes: host.rows[0].data.notes, material: host.rows[0].data.material }
  }
  assert.deepEqual(outcomes.without, { status: 'succeeded', notes: null, material: 'M-2' }, 'the hazard: the note is gone')
  assert.deepEqual(outcomes.with, { status: 'succeeded', notes: 'synthetic person note', material: 'M-2' }, 'the fence: the note survives')
})

// ── EV-9 / EV-10 ───────────────────────────────────────────────────────────────────────────────────────

test('EV-9 a malformed map is refused before any IO', async () => {
  for (const bad of [{}, [['k', {}]], new Map([['', { id: 'r', version: 1, row: {} }]]), new Map([[keyOf('A'), { id: 'r', version: 0, row: {} }]]), new Map([[keyOf('A'), { id: '', version: 1, row: {} }]]), new Map([[keyOf('A'), { id: 'r', version: 1 }]])]) {
    const host = createHost([seedRow('A', 'rec_a')])
    await assert.rejects(apply(host, [updateDecision('A', { material: 'M-2' })], { expectedRecords: bad }), (error) => error instanceof StockPreparationApplyWriterError && error.details.field === 'expectedRecords')
    assert.equal(host.calls.length, 0)
  }
})

test('EV-10 the large chunk hands the writer no expectedRecords (its host calls stay byte-identical; D-2 correction)', () => {
  const source = fs.readFileSync(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'), 'utf8')
  assert.equal(source.includes('expectedRecords'), false)
  const tableActions = fs.readFileSync(path.join(LIB, 'stock-preparation-table-actions.cjs'), 'utf8')
  assert.equal((tableActions.match(/expectedRecords: expectedRecordsOf\(dryRun\)/g) || []).length, 1, 'exactly one writer call passes the map: the small apply')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-apply-writer-version.test.cjs', tests)
