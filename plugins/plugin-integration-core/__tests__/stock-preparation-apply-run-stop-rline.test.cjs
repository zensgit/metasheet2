'use strict'

// 批次标识 BI-4 (R line only; R83 on onprem-r82) — the writer RUN STOP and its two callers.
//
// Main carries the run stop since #6501 / PR-8 (the lease fence) and BI-1b (the pull-batch allocation stop). This line has
// no lease, so it ports a sliver (survey D4 / D5, critic C2–C4): an error with `stopsRun === true` breaks the decision
// loop and the run answers `status: 'aborted'` with `abort: { index, code, error }`; the small lane rethrows it as a typed
// error with the partial outcome; the large lane stores the job `failed` with the checkpoint at the stop and rethrows.
//
//   RS-W1 a stop at decision k: status 'aborted', abort.index k, k results, nothing after k is attempted, the stop is NOT
//         counted failed; a non-stop failure (control) is counted failed and the run goes on ('partial').
//   RS-W2 an uninterrupted run carries no `abort` key (byte-identical result shape); applyStatus(…, aborted) = 'aborted'.
//   RS-W3 countAttemptedHostWrites: confirmed writes + failures INSIDE createRecord / patchRecord; nothing else.
//   RS-T1 small lane: a stop at the FIRST create rethrows the stop's own status / code / details with partial false,
//         abortedAtDecisionIndex 0; a stop at the SECOND create says partial true, written 1, attemptedWrites 1.
//   RS-L1 large lane: a stop mid-chunk stores the job `failed` with checkpoint = start + k (NOT end), completedChunks
//         unchanged, the code in the evidence, and rethrows; the NEXT chunk re-runs decision start + k and finishes
//         `succeeded` with every row written exactly once.
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const writer = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  applyStockPreparationAction,
  dryRunStockPreparationAction,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  __internals: largeInternals,
  createLargeBomCheckpointApplyJob,
  runLargeBomCheckpointApplyJobChunk,
} = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))

const {
  StockPreparationApplyRunStopError,
  StockPreparationApplyWriterError,
  applyStockPreparationPlan,
  countAttemptedHostWrites,
} = writer

const tests = []
const test = (name, fn) => tests.push([name, fn])
const clone = (value) => JSON.parse(JSON.stringify(value))

const SANDBOX_POLICY = { enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] }
const STOP_CODE = 'STOCK_PREP_PULL_BATCH_CONFLICT'

/** A stop exactly as BI-1b's pullBatchAllocationStop shapes it: typed, own status / code, `stopsRun`. */
function stopError(details = { operation: 'allocate', partial: false }) {
  const error = new StockPreparationApplyWriterError('synthetic allocation stop', { code: STOP_CODE })
  error.status = 409
  error.code = STOP_CODE
  error.details = details
  error.stopsRun = true
  return error
}

function recordsApiStoppingAt(stopAtCreate, { plainFailure = false, existing = [] } = {}) {
  const rows = existing.map((entry, index) => ({ id: entry.id || `rec_${index + 1}`, sheetId: entry.sheetId || 'sheet_stock', version: 1, data: { ...(entry.data || entry) } }))
  const calls = []
  let creates = 0
  return {
    rows,
    calls,
    recordsApi: {
      async queryRecords(input = {}) {
        calls.push(['queryRecords'])
        return rows
          .filter((record) => record.sheetId === input.sheetId)
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
          .map(clone)
      },
      async createRecord(input = {}) {
        creates += 1
        calls.push(['createRecord', creates])
        if (creates === stopAtCreate) {
          if (plainFailure) throw new Error('synthetic host failure')
          throw stopError()
        }
        const record = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(record)
        return clone(record)
      },
      async patchRecord(input = {}) {
        calls.push(['patchRecord'])
        const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
        if (!record) throw new Error('record not found')
        record.version += 1
        record.data = { ...record.data, ...(input.changes || {}) }
        return clone(record)
      },
    },
  }
}

function addDecision(n) {
  const key = `SYN-KEY-${n}`
  return {
    decision: 'add',
    idempotencyKey: key,
    record: { idempotencyKey: key, projectNo: 'SYN-P', componentSourceId: `SYN-C${n}`, active: true, lastPlmRefreshDecision: 'add' },
    conflictSummary: { type: 'add_missing' },
  }
}
const planOf = (decisions) => ({ valid: true, ok: true, counts: { add: decisions.length, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, decisions: decisions.map(clone), plannedAt: '2026-11-08T00:00:00.000Z' })
const target = () => ({ sheetId: 'sheet_stock', objectId: 'stockPreparationMain' })

test('RS-W1 a stop at decision k aborts the run there; a plain failure is counted and the run goes on', async () => {
  const api = recordsApiStoppingAt(2)
  const result = await applyStockPreparationPlan({ permission: 'write', plan: planOf([addDecision(1), addDecision(2), addDecision(3)]), target: target(), recordsApi: api.recordsApi })
  assert.equal(result.status, 'aborted')
  assert.equal(result.ok, true, 'ok keeps its meaning (no failed / held row); status says the run did not finish')
  assert.equal(result.abort.index, 1)
  assert.equal(result.abort.code, STOP_CODE)
  assert.equal(result.abort.error.stopsRun, true)
  assert.equal(result.results.length, 1, 'exactly the decisions before the stop ran')
  assert.equal(result.counts.created, 1)
  assert.equal(result.counts.failed, 0, 'the stop is not a per-row failure')
  assert.deepEqual(result.errors, [])
  assert.equal(api.calls.filter((call) => call[0] === 'createRecord').length, 2, 'nothing after the stop is attempted')
  assert.equal(api.rows.length, 1)

  const control = recordsApiStoppingAt(2, { plainFailure: true })
  const failed = await applyStockPreparationPlan({ permission: 'write', plan: planOf([addDecision(1), addDecision(2), addDecision(3)]), target: target(), recordsApi: control.recordsApi })
  assert.equal(failed.status, 'partial')
  assert.equal(failed.counts.failed, 1)
  assert.equal(failed.counts.created, 2)
  assert.equal(failed.results.length, 3)
  assert.equal(Object.prototype.hasOwnProperty.call(failed, 'abort'), false)
})

test('RS-W2 an uninterrupted run has no abort key; applyStatus maps aborted first', async () => {
  const api = recordsApiStoppingAt(0)
  const result = await applyStockPreparationPlan({ permission: 'write', plan: planOf([addDecision(1), addDecision(2)]), target: target(), recordsApi: api.recordsApi })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(Object.keys(result).sort(), ['counts', 'errors', 'ok', 'permission', 'results', 'status', 'target', 'written'])
  const { applyStatus } = writer.__internals
  assert.equal(applyStatus({ failed: 1, held: 0 }, 3, true), 'aborted')
  assert.equal(applyStatus({ failed: 1, held: 0 }, 3, false), 'partial')
  assert.equal(applyStatus({ failed: 0, held: 0 }, 0), 'succeeded')
})

test('RS-W3 countAttemptedHostWrites counts confirmed writes and failures inside a host write call only', () => {
  assert.equal(countAttemptedHostWrites({}), 0)
  assert.equal(countAttemptedHostWrites({ written: 2, errors: [] }), 2)
  assert.equal(countAttemptedHostWrites({ written: 1, errors: [{ operation: 'createRecord' }, { operation: 'patchRecord' }, { operation: 'queryRecords' }, { operation: 'apply' }, null] }), 3)
})

// ── the small lane ──────────────────────────────────────────────────────────────────────────────────────

function createMemoryStorage() {
  const map = new Map()
  return { map, async get(key) { return map.get(key) || null }, async set(key, value) { map.set(key, clone(value)) }, async delete(key) { map.delete(key) } }
}
function sourceAdapterOf(data) {
  return {
    async read(input = {}) {
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit || 1000
      const records = matches.slice(offset, offset + limit).map(clone)
      return { records, done: offset + records.length >= matches.length, nextCursor: offset + records.length < matches.length ? String(offset + records.length) : null }
    },
  }
}
const TWO_PARTS = {
  DN_PDM_PathExAttrInfo: [{ FileCode: 'SYN-P-001', Parent_OBJ_ID: 'PATH-1' }],
  DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
  DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
  DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' }],
  DN_PDM_PartLibraryInfo: [
    { OBJ_ID: 'PART-A', IdentityNo: 'SYN-A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' },
    { OBJ_ID: 'PART-B', IdentityNo: 'SYN-B-001', IdentityName: 'Bolt', Material: 'Iron', SysVer: 'V1' },
  ],
  DN_PDM_BomHeadInfo: [{ part_id: 'PART-A', bom_id: 'BOM-A', SysVer: 'V1', bom_able: true }],
  DN_PDM_BomDetailsInfo: [{ bom_pid: 'BOM-A', part_id: 'PART-B', Bom_ExAttr1: '3' }],
}

async function smallApply(stopAtCreate) {
  const storage = createMemoryStorage()
  const records = recordsApiStoppingAt(stopAtCreate)
  const action = { actionId: PLM_STOCK_PREPARATION_ACTION_ID, source: { externalSystemId: 'plm_source_1', kind: 'data-source:sql-readonly' }, target: target() }
  const common = { action, parameters: { projectNo: 'SYN-P-001' }, sourceAdapter: sourceAdapterOf(TWO_PARTS), recordsApi: records.recordsApi, tokenStore: storage }
  const dryRun = await dryRunStockPreparationAction({ ...common, plannedAt: '2026-11-08T00:00:00.000Z' })
  assert.equal(dryRun.status, 'ready', JSON.stringify(dryRun.status))
  let caught = null
  try {
    await applyStockPreparationAction({ ...common, sandboxPolicy: SANDBOX_POLICY, dryRunToken: dryRun.dryRunToken, permission: 'write' })
  } catch (error) {
    caught = error
  }
  return { caught, records }
}

test('RS-T1 small lane: a stop rethrows the stop\'s own status / code / details with the partial outcome', async () => {
  const first = await smallApply(1)
  assert.ok(first.caught instanceof StockPreparationApplyRunStopError, String(first.caught && first.caught.stack))
  assert.equal(first.caught.status, 409, 'the stop\'s own status, never re-derived')
  assert.equal(first.caught.code, STOP_CODE)
  assert.equal(first.caught.details.operation, 'allocate', 'the stop\'s own details are kept')
  assert.equal(first.caught.details.partial, false, 'nothing was attempted before the stop')
  assert.equal(first.caught.details.written, 0)
  assert.equal(first.caught.details.attemptedWrites, 0)
  assert.equal(first.caught.details.abortedAtDecisionIndex, 0)
  assert.equal(first.records.rows.length, 0)

  const second = await smallApply(2)
  assert.ok(second.caught instanceof StockPreparationApplyRunStopError)
  assert.equal(second.caught.details.partial, true, 'a row landed before the stop: the route stamps failed + recount')
  assert.equal(second.caught.details.written, 1)
  assert.equal(second.caught.details.attemptedWrites, 1)
  assert.equal(second.caught.details.abortedAtDecisionIndex, 1)
  assert.equal(second.caught.details.counts.created, 1)
  assert.equal(second.records.rows.length, 1)
})

// ── the large lane ──────────────────────────────────────────────────────────────────────────────────────

const SCOPE = Object.freeze({ tenantId: 'tenant_rs', workspaceId: 'ws_rs' })
function durableStorage() {
  const map = new Map()
  return { durable: true, map, async get(key) { return map.get(key) || null }, async set(key, value) { map.set(key, clone(value)) } }
}
async function seedLargeJob(plan) {
  const storage = durableStorage()
  const actionId = PLM_STOCK_PREPARATION_ACTION_ID
  const jobId = 'job-rs-1'
  const job = {
    jobId, ...SCOPE, actionId, status: 'completed', authoritative: true, projectNoPresent: true,
    parameters: { projectNo: 'SYN-P' }, principal: 'u_rs',
    actionSnapshot: { actionId, source: { kind: 'data-source:sql-readonly', externalSystemId: 'syn_source' }, target: { sheetId: 'sheet_stock' } },
    sourceKind: 'data-source:sql-readonly', artifactRevision: 'artifact-revision-1',
    artifact: { revision: 'artifact-revision-1', status: 'expanded', rows: [], summary: {}, sealedAt: '2026-11-08T00:00:00.000Z' },
    planRevision: 'plan-revision-1',
    planArtifact: { revision: 'plan-revision-1', artifactRevision: 'artifact-revision-1', plan: clone(plan), existingRowCount: 0, plannedAt: plan.plannedAt },
    progress: { rowsExpanded: 0, readCount: 0, frontierRemaining: 0, completedChunks: 1 },
    budgets: {}, evidence: { sourceKind: 'data-source:sql-readonly', readObjects: [], errorTypes: [], readDiagnosticShapePresent: false },
    createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z',
  }
  await storage.set(largeInternals.backgroundJobKey({ ...SCOPE, actionId, jobId }), job)
  await createLargeBomCheckpointApplyJob({ storage, ...SCOPE, actionId, jobId, principal: 'u_rs', permission: 'write', createApplyJobId: () => 'apply-rs-1', now: () => '2026-11-08T00:01:00.000Z' })
  return { storage, actionId }
}

test('RS-L1 large lane: a stop mid-chunk stores failed at start + k and rethrows; the next chunk re-runs start + k', async () => {
  const { storage, actionId } = await seedLargeJob(planOf([addDecision(1), addDecision(2), addDecision(3), addDecision(4)]))
  const run = (recordsApi, maxDecisionsPerChunk) => runLargeBomCheckpointApplyJobChunk({ storage, ...SCOPE, actionId, applyJobId: 'apply-rs-1', recordsApi, maxDecisionsPerChunk, now: () => '2026-11-08T00:02:00.000Z' })
  const host = recordsApiStoppingAt(0)
  // Chunk 1 = decision 0 (clean), so the stop below sits in a chunk that does not start at 0.
  const firstChunk = await run(host.recordsApi, 1)
  assert.equal(firstChunk.status, 'paused')
  assert.equal(firstChunk.checkpoint.nextDecisionIndex, 1)
  assert.equal(firstChunk.checkpoint.completedChunks, 1)
  // Chunk 2 = decisions 1..3; the SECOND create of this chunk (decision 2) stops.
  const stopping = recordsApiStoppingAt(2, { existing: host.rows })
  let caught = null
  try {
    await run(stopping.recordsApi, 3)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof StockPreparationApplyRunStopError, String(caught && caught.stack))
  assert.equal(caught.status, 409)
  assert.equal(caught.code, STOP_CODE)
  assert.equal(caught.details.partial, true)
  assert.equal(caught.details.written, 1)
  assert.equal(caught.details.abortedAtDecisionIndex, 2, 'start (1) + k (1)')
  const stored = [...storage.map.values()].find((value) => value && value.jobId === 'apply-rs-1' || (value && value.applyJobId === 'apply-rs-1'))
  assert.ok(stored, 'the apply job is stored')
  assert.equal(stored.status, 'failed', 'never left running, never paused / succeeded')
  assert.equal(stored.checkpoint.nextDecisionIndex, 2, 'the checkpoint is at the stop, not at the chunk end (4)')
  assert.equal(stored.checkpoint.completedChunks, 1, 'the stopped chunk is not completed')
  assert.ok(stored.evidence.errorCodes.includes(STOP_CODE))
  assert.equal(stored.counts.created, 2, 'decision 0 + decision 1')
  // The resume re-runs decision 2 (it never landed) and finishes.
  const resumeHost = recordsApiStoppingAt(0, { existing: stopping.rows })
  const resumed = await run(resumeHost.recordsApi, 10)
  assert.equal(resumed.status, 'succeeded')
  assert.equal(resumed.checkpoint.nextDecisionIndex, 4)
  assert.equal(resumed.counts.created, 4)
  assert.equal(resumeHost.rows.length, 4)
  const keys = resumeHost.rows.map((row) => row.data.idempotencyKey).sort()
  assert.deepEqual(keys, ['SYN-KEY-1', 'SYN-KEY-2', 'SYN-KEY-3', 'SYN-KEY-4'], 'every row written exactly once')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-apply-run-stop-rline.test.cjs', tests)
