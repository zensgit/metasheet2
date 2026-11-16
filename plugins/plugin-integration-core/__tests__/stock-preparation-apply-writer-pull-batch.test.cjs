'use strict'

// 批次标识 BI-1b (design §3.4, §4.5; register R-65) — THE WRITER'S CREATE-LEG STAMPING and the RUN STOP.
//
//   AW-1  stamp ABSENT ⇒ every host call is byte-identical to the pre-BI-1 writer (the call log is compared whole)
//   AW-2  the create leg carries BOTH cells under their PHYSICAL ids, added after the mapping; 首次 null ⇒ this batch
//   AW-3  E10: an ADD that finds its row (the patch leg) writes NEITHER cell; UPDATE / INACTIVE never carry one either
//   AW-4  allocation is lazy and memoized: once per run, BEFORE the first create's fence, never before a patch;
//         a plan whose ADDs all hit existing rows (or that has no ADD) never allocates (A03)
//   AW-5  G2: an allocation failure STOPS THE RUN at the first create — zero INACTIVE patches, no later create, the
//         typed code kept, `aborted` with the decision index
//   AW-6  malformed side input / a carry map that misses an ADD key ⇒ 500 STAMP_INVALID before any IO
//   AW-7  the result's values-free `pullBatch` summary (present only with a stamp)
//   AW-8  the allocation runs INSIDE the guard's host-write bracket (P-5); a manual-key ADD still fails
//         APPLY_MANUAL_KEY_RESERVED before any allocation; a holder refusal (the fence's own error) stops the run
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const { applyStockPreparationPlan } = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))
const { DECISIONS } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const SHEET = 'sheet_syn_writer'
const keyOf = (component, pathTokens) => JSON.stringify({ projectNo: 'PRJ-W', componentSourceId: component, parentSourceId: pathTokens.length > 1 ? pathTokens[pathTokens.length - 2] : null, path: pathTokens })
const record = (component, pathTokens) => ({
  projectNo: 'PRJ-W',
  idempotencyKey: keyOf(component, pathTokens),
  componentSourceId: component,
  path: JSON.stringify(pathTokens),
  totalQuantity: 2,
  active: true,
  lastPlmRefreshRunId: 'run_w',
  lastPlmRefreshAt: '2026-10-27T01:00:00.000Z',
  lastPlmRefreshDecision: 'add',
})
const addDecision = (component, pathTokens) => ({ decision: DECISIONS.ADD, idempotencyKey: keyOf(component, pathTokens), record: record(component, pathTokens) })
const inactiveDecision = (component, pathTokens) => ({ decision: DECISIONS.INACTIVE, idempotencyKey: keyOf(component, pathTokens), patch: { active: false, lastPlmRefreshDecision: 'inactive' } })
const updateDecision = (component, pathTokens) => ({ decision: DECISIONS.UPDATE, idempotencyKey: keyOf(component, pathTokens), patch: { totalQuantity: 3 } })

function recordsApi(existing = []) {
  const rows = existing.map((data, index) => ({ id: `rec_${index + 1}`, sheetId: SHEET, version: 1, data: { ...data } }))
  const calls = []
  return {
    calls,
    rows,
    api: {
      async queryRecords(input) {
        calls.push(['queryRecords', JSON.parse(JSON.stringify(input))])
        return rows.filter((row) => Object.entries(input.filters || {}).every(([field, value]) => row.data[field] === value))
      },
      async createRecord(input) {
        calls.push(['createRecord', JSON.parse(JSON.stringify(input))])
        const created = { id: `rec_${rows.length + 1}`, sheetId: SHEET, version: 1, data: { ...input.data } }
        rows.push(created)
        return created
      },
      async patchRecord(input) {
        calls.push(['patchRecord', JSON.parse(JSON.stringify(input))])
        const row = rows.find((entry) => entry.id === input.recordId)
        Object.assign(row.data, input.changes)
        return row
      },
    },
  }
}

const TARGET = Object.freeze({ sheetId: SHEET, objectId: 'plm_stock_preparation_main', keyField: 'idempotencyKey', fieldIdMap: {} })
const FIELD_IDS = Object.freeze({ pullBatch: 'fld_syn_pullBatch', firstPullBatch: 'fld_syn_firstPullBatch' })
const write = (plan, api, extra = {}) => applyStockPreparationPlan({ permission: 'write', plan, target: TARGET, recordsApi: api, ...extra })
// A stamp whose allocation answers `answer` and logs each call (no ledger).
function stampStub({ fieldIds, firstPullBatchByKey, answer = { batchId: 'pbat_syn_1', batchNo: 1, label: '第1批（2026-10-27）', joined: false } }) {
  const calls = []
  return { calls, stamp: { fieldIds, firstPullBatchByKey, allocate: async () => { calls.push('allocate'); return answer } } }
}
const carryAll = (decisions, labels = {}) => new Map(decisions.filter((entry) => entry.decision === DECISIONS.ADD).map((entry) => [entry.idempotencyKey, Object.prototype.hasOwnProperty.call(labels, entry.idempotencyKey) ? labels[entry.idempotencyKey] : null]))

test('AW-1 stamp ABSENT: the host calls, the counts and the result are byte-identical to a pre-BI-1b run (no pullBatch key)', async () => {
  const decisions = [addDecision('P-07', ['P-07']), addDecision('S-01', ['P-07', 'S-01']), inactiveDecision('S-01', ['S-01'])]
  const existing = [record('S-01', ['S-01'])]
  const a = recordsApi(existing)
  const resultA = await write({ decisions }, a.api)
  const b = recordsApi(existing)
  const resultB = await write({ decisions }, b.api, { pullBatchStamp: undefined })
  assert.deepEqual(b.calls, a.calls)
  assert.deepEqual(resultB, resultA)
  assert.equal(Object.prototype.hasOwnProperty.call(resultA, 'pullBatch'), false)
  for (const [method, input] of a.calls) {
    if (method === 'createRecord') assert.equal(Object.keys(input.data).some((field) => field.includes('ullBatch')), false)
  }
})

test('AW-2 the create leg carries BOTH cells under their PHYSICAL ids (after the mapping); 首次 null ⇒ this batch, a carried label verbatim', async () => {
  const decisions = [addDecision('P-07', ['P-07']), addDecision('S-01', ['P-07', 'S-01'])]
  const { stamp, calls } = stampStub({
    fieldIds: FIELD_IDS,
    firstPullBatchByKey: carryAll(decisions, { [keyOf('S-01', ['P-07', 'S-01'])]: '第1批（2026-10-20）' }),
    answer: { batchId: 'pbat_2', batchNo: 2, label: '第2批（2026-10-27）', joined: false },
  })
  const h = recordsApi()
  const result = await write({ decisions }, h.api, { pullBatchStamp: stamp })
  const creates = h.calls.filter(([method]) => method === 'createRecord').map(([, input]) => input.data)
  assert.equal(creates.length, 2)
  assert.deepEqual([creates[0][FIELD_IDS.firstPullBatch], creates[0][FIELD_IDS.pullBatch]], ['第2批（2026-10-27）', '第2批（2026-10-27）'], 'P-07: 首次 = 本次 = 第2批')
  assert.deepEqual([creates[1][FIELD_IDS.firstPullBatch], creates[1][FIELD_IDS.pullBatch]], ['第1批（2026-10-20）', '第2批（2026-10-27）'], 'the S-01 copy: 首次 第1批, 本次 第2批')
  assert.equal(creates[0].pullBatch, undefined, 'never under the logical id')
  assert.deepEqual(calls, ['allocate'], 'ONE allocation for the run')
  assert.equal(result.counts.created, 2)
})

test('AW-3 E10: an ADD that finds its row patches WITHOUT either cell; UPDATE and INACTIVE patches carry none either', async () => {
  const decisions = [addDecision('X', ['X']), updateDecision('Y', ['Y']), inactiveDecision('Z', ['Z'])]
  const { stamp, calls } = stampStub({ fieldIds: FIELD_IDS, firstPullBatchByKey: carryAll(decisions) })
  const h = recordsApi([record('X', ['X']), record('Y', ['Y']), record('Z', ['Z'])])
  const result = await write({ decisions }, h.api, { pullBatchStamp: stamp })
  const patches = h.calls.filter(([method]) => method === 'patchRecord').map(([, input]) => input.changes)
  assert.equal(patches.length, 3)
  for (const changes of patches) {
    assert.equal(Object.prototype.hasOwnProperty.call(changes, FIELD_IDS.pullBatch), false)
    assert.equal(Object.prototype.hasOwnProperty.call(changes, FIELD_IDS.firstPullBatch), false)
  }
  assert.deepEqual(calls, [], 'nothing created ⇒ no batch is opened (A03)')
  assert.deepEqual({ ...result.pullBatch }, { allocated: false, batchNo: null, label: null, joined: false, stampedRowCount: 0 })
})

test('AW-4 allocation is lazy: after the lookup found no row, BEFORE the first create\'s fence CAS and host write; never for a plan with no create', async () => {
  const order = []
  const fence = {
    beforeWrite: async (meta) => order.push(`fence:${meta.operation}`),
    hostWriteFence: () => ({ lock: 'x' }),
    hostFenceRefused: async (error) => error,
    withHostWrite: async (fn) => fn(),
  }
  const decisions = [updateDecision('Y', ['Y']), addDecision('X', ['X']), addDecision('W', ['W'])]
  const stamp = {
    fieldIds: FIELD_IDS,
    firstPullBatchByKey: carryAll(decisions),
    allocate: async () => { order.push('allocate'); return { batchId: 'b', batchNo: 1, label: '第1批（2026-10-27）', joined: false } },
  }
  const h = recordsApi([record('Y', ['Y'])])
  const api = { ...h.api, supportsWriteFence: true }
  const wrapped = {
    ...api,
    async createRecord(input) { order.push('createRecord'); return h.api.createRecord(input) },
    async patchRecord(input) { order.push('patchRecord'); return h.api.patchRecord(input) },
  }
  await write({ decisions }, wrapped, { pullBatchStamp: stamp, writeFence: fence })
  assert.deepEqual(order, ['fence:patchRecord', 'patchRecord', 'allocate', 'fence:createRecord', 'createRecord', 'fence:createRecord', 'createRecord'])
  const none = stampStub({ fieldIds: FIELD_IDS, firstPullBatchByKey: new Map() })
  await write({ decisions: [updateDecision('Y', ['Y'])] }, recordsApi([record('Y', ['Y'])]).api, { pullBatchStamp: none.stamp })
  assert.deepEqual(none.calls, [], 'no ADD ⇒ no allocation')
})

test('AW-5 G2: an allocation failure STOPS the run at the first create — zero INACTIVE patches, no later create; the typed code is kept', async () => {
  const decisions = [updateDecision('Y', ['Y']), addDecision('S-01', ['P-07', 'S-01']), addDecision('C', ['P-07', 'S-01', 'C']), inactiveDecision('S-01', ['S-01']), inactiveDecision('C', ['S-01', 'C'])]
  for (const [label, failure, code, status] of [
    ['a ledger failure', Object.assign(new Error('ledger down'), { status: 503, code: 'STOCK_PREP_PULL_BATCH_STORE_FAILED' }), 'STOCK_PREP_PULL_BATCH_STORE_FAILED', 503],
    ['an install in progress', Object.assign(new Error('installing'), { status: 409, code: 'STOCK_PREP_PULL_BATCH_INSTALL_IN_PROGRESS' }), 'STOCK_PREP_PULL_BATCH_INSTALL_IN_PROGRESS', 409],
    ['an untyped throw', new Error('boom'), 'STOCK_PREP_PULL_BATCH_STORE_FAILED', 503],
    // The answer contract (assertAllocatedBatch): a malformed answer is the caller defect 500 STAMP_INVALID — still a run stop.
    ['a malformed answer', null, 'STOCK_PREP_PULL_BATCH_STAMP_INVALID', 500],
  ]) {
    const h = recordsApi([record('Y', ['Y']), record('S-01', ['S-01']), record('C', ['S-01', 'C'])])
    const stamp = {
      fieldIds: FIELD_IDS,
      firstPullBatchByKey: carryAll(decisions),
      allocate: async () => { if (failure) throw failure; return { batchId: '', batchNo: 0 } },
    }
    const result = await write({ decisions }, h.api, { pullBatchStamp: stamp })
    assert.equal(result.status, 'aborted', label)
    assert.equal(result.abort.index, 1, `${label}: stopped at the first create`)
    assert.equal(result.abort.code, code, label)
    assert.equal(result.abort.error.status, status, label)
    assert.equal(result.abort.error.stopsRun, true, label)
    const methods = h.calls.map(([method]) => method)
    assert.equal(methods.filter((method) => method === 'createRecord').length, 0, `${label}: no create`)
    assert.equal(methods.filter((method) => method === 'patchRecord').length, 1, `${label}: only the UPDATE before the stop — zero INACTIVE patches`)
    assert.deepEqual(result.counts, { created: 0, updated: 1, inactive: 0, skipped: 0, held: 0, failed: 0 }, label)
  }
})

test('AW-6 malformed side input, or a carry map that misses an ADD key, is refused 500 STAMP_INVALID before any IO', async () => {
  const decisions = [addDecision('X', ['X'])]
  for (const [label, stamp] of [
    ['no field ids', { firstPullBatchByKey: carryAll(decisions), allocate: async () => ({}) }],
    ['a physical id that is in the target map', { fieldIds: { pullBatch: 'fld_mapped', firstPullBatch: 'fld_b' }, firstPullBatchByKey: carryAll(decisions), allocate: async () => ({}) }],
    ['a carry map built from another plan', { fieldIds: FIELD_IDS, firstPullBatchByKey: new Map([['another key', null]]), allocate: async () => ({}) }],
  ]) {
    const h = recordsApi()
    let thrown = null
    try {
      await applyStockPreparationPlan({ permission: 'write', plan: { decisions }, target: { ...TARGET, fieldIdMap: { notes: 'fld_mapped' } }, recordsApi: h.api, pullBatchStamp: stamp })
    } catch (error) { thrown = error }
    assert.ok(thrown, label)
    assert.equal(thrown.code, 'STOCK_PREP_PULL_BATCH_STAMP_INVALID', label)
    assert.equal(thrown.status, 500, label)
    assert.deepEqual(h.calls, [], `${label}: no IO`)
  }
})

test('AW-7 the result summary is values-free and counts only CONFIRMED stamped creates; a joined batch says so', async () => {
  const decisions = [addDecision('X', ['X']), addDecision('Y', ['Y'])]
  const { stamp } = stampStub({ fieldIds: FIELD_IDS, firstPullBatchByKey: carryAll(decisions), answer: { batchId: 'b', batchNo: 4, label: 'Batch 4 (2026-10-27)', joined: true } })
  const h = recordsApi()
  const failingSecond = { ...h.api, async createRecord(input) { if (input.data.componentSourceId === 'Y') throw Object.assign(new Error('VALIDATION_ERROR'), { code: 'VALIDATION_ERROR' }); return h.api.createRecord(input) } }
  const result = await write({ decisions }, failingSecond, { pullBatchStamp: stamp })
  assert.equal(result.status, 'partial')
  assert.deepEqual({ ...result.pullBatch }, { allocated: true, batchNo: 4, label: 'Batch 4 (2026-10-27)', joined: true, stampedRowCount: 1 })
})

test('AW-8 the allocation runs inside withHostWrite; a manual-key ADD fails APPLY_MANUAL_KEY_RESERVED before any allocation; a holder refusal stops the run', async () => {
  const order = []
  const fence = {
    beforeWrite: async (meta) => order.push(`fence:${meta.operation}`),
    hostWriteFence: () => ({ lock: 'x' }),
    hostFenceRefused: async (error) => error,
    withHostWrite: async (fn) => { order.push('bracket:open'); try { return await fn() } finally { order.push('bracket:close') } },
  }
  const decisions = [addDecision('X', ['X'])]
  const stamp = { fieldIds: FIELD_IDS, firstPullBatchByKey: carryAll(decisions), allocate: async () => { order.push('allocate'); return { batchId: 'b', batchNo: 1, label: '第1批（2026-10-27）', joined: false } } }
  const h = recordsApi()
  await write({ decisions }, { ...h.api, supportsWriteFence: true }, { pullBatchStamp: stamp, writeFence: fence })
  assert.deepEqual(order.slice(0, 3), ['bracket:open', 'allocate', 'bracket:close'], 'the allocation is bracketed (the heartbeat never queues behind its own holder assert)')
  // A manual-key ADD: refused per decision BEFORE the allocation (it never reaches the create leg).
  const manualKey = 'manual:syn-row'
  const manual = { decision: DECISIONS.ADD, idempotencyKey: manualKey, record: { ...record('M', ['M']), idempotencyKey: manualKey } }
  const m = stampStub({ fieldIds: FIELD_IDS, firstPullBatchByKey: new Map([[manualKey, null]]) })
  const refused = await write({ decisions: [manual] }, recordsApi().api, { pullBatchStamp: m.stamp })
  assert.equal(refused.counts.failed, 1)
  assert.equal(refused.errors[0].code, 'APPLY_MANUAL_KEY_RESERVED')
  assert.deepEqual(m.calls, [], 'no allocation for a refused manual-key ADD')
  // The holder assert's refusal (typed, the fence's own error) stops the run like a fenced stop.
  const lost = Object.assign(new Error('lease lost'), { status: 409, code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', fence: true })
  const holder = { fieldIds: FIELD_IDS, firstPullBatchByKey: carryAll([...decisions, addDecision('W', ['W'])]), allocate: async () => { throw lost } }
  const hh = recordsApi()
  const stopped = await write({ decisions: [...decisions, addDecision('W', ['W'])] }, { ...hh.api, supportsWriteFence: true }, { pullBatchStamp: holder, writeFence: { ...fence, withHostWrite: async (fn) => fn() } })
  assert.equal(stopped.status, 'aborted')
  assert.equal(stopped.abort.code, 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST')
  assert.equal(hh.calls.filter(([method]) => method === 'createRecord').length, 0, 'nothing created after the holder refused')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-apply-writer-pull-batch.test.cjs', tests)
