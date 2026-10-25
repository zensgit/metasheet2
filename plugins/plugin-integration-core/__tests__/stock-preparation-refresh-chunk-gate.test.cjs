'use strict'

// Batch-refresh step 4, PR-3a — THE LARGE CHUNK'S GOVERNANCE GATE (design §7.1 row 11; plan-final §2.7 LB-1/LB-2,
// AMB-11, refuter R-5). Direct `runLargeBomCheckpointApplyJobChunk` calls inside the REAL project write lease
// (in-memory lock kit), the gate built from the REAL governance reader over the step-4 fake db
// (support/stock-preparation-refresh-governance-wiring.cjs) and the REAL large-lane verdict.
//
//   CG-1 governed project (a store-seeded hold, no bump) => 409 STOCK_PREP_REFRESH_LARGE_LANE_REFUSED { reason,
//        lane }: the stored job byte-identical, no `storage.set` during the chunk, zero records writes.
//   CG-2 the gate absent => 501 chunk_gate_absent BEFORE `running`, job untouched.
//   CG-3 not governed => the chunk runs; the writer received the gate's verdict (its tripwire admitted it).
//   CG-4 a pilot job answers PR B's code FIRST (the in-lease pilot check) — the gate is never asked.
//   CG-5 the matrix {pilot by the registry, protected by rows, not governed}.
//   CG-6 a verdict that does not match the plan, or a stale token: refused BEFORE `running` by the writer's own
//        zero-IO tripwire (the job is never stranded `running`); the answer order binding -> host fence -> gate.
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const largeBomJobs = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))
const { sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const lanes = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))
const swlKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const refreshKit = require('./support/stock-preparation-refresh-store-kit.cjs')

const {
  createLargeBomBackgroundExpansionJob,
  createLargeBomCheckpointApplyJob,
  planLargeBomBackgroundExpansionJob,
  runLargeBomBackgroundExpansionJob,
  runLargeBomCheckpointApplyJobChunk,
  __internals,
} = largeBomJobs

const tests = []
const test = (name, fn) => tests.push([name, fn])

const SCOPE = Object.freeze({ tenantId: 'tenant-cg', workspaceId: 'workspace-cg' })
const CODE_REFUSED = 'STOCK_PREP_REFRESH_LARGE_LANE_REFUSED'
const CODE_UNCONSULTED = 'STOCK_PREP_REFRESH_GOVERNANCE_UNCONSULTED'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function createTargetRecordsApi() {
  const rows = []
  const calls = []
  return {
    rows,
    calls,
    writes: () => calls.filter(([op]) => op === 'createRecord' || op === 'patchRecord').length,
    recordsApi: {
      async queryRecords(input = {}) {
        calls.push(['queryRecords'])
        return rows.filter((row) => row.sheetId === input.sheetId)
          .filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row.data[field] === expected))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000)).map(clone)
      },
      async createRecord(input = {}) {
        calls.push(['createRecord'])
        const record = { id: `cg_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(record)
        return clone(record)
      },
      async patchRecord(input = {}) {
        calls.push(['patchRecord'])
        const row = rows.find((entry) => entry.sheetId === input.sheetId && entry.id === input.recordId)
        if (!row) throw new Error('cg: record not found')
        row.version += 1
        row.data = { ...row.data, ...(input.changes || {}) }
        return clone(row)
      },
    },
  }
}

// The golden large flow up to an approved checkpoint job (the lock kit's synthetic fixture), approval bound.
async function approvedJob() {
  const harness = swlKit.createLibWriteLockHarness()
  const storage = swlKit.createConsumableStorage()
  storage.durable = true
  const action = swlKit.goldenAction()
  const parameters = { projectNo: swlKit.GOLDEN_PROJECT_NO }
  const source = swlKit.createSourceAdapter(swlKit.goldenPlmData())
  await harness.wrapLargeExpansionStart(createLargeBomBackgroundExpansionJob)({ storage, ...SCOPE, action, parameters, principal: 'cg-principal', createJobId: () => 'cg-job-1', now: () => '2026-10-26T08:00:00.000Z' })
  await runLargeBomBackgroundExpansionJob({ storage, ...SCOPE, actionId: action.actionId, jobId: 'cg-job-1', sourceAdapter: source.adapter, now: () => '2026-10-26T08:01:00.000Z' })
  await harness.wrapLargePlan(planLargeBomBackgroundExpansionJob)({ storage, ...SCOPE, actionId: action.actionId, jobId: 'cg-job-1', existingRows: [], plannedAt: swlKit.GOLDEN_PLANNED_AT, runId: swlKit.GOLDEN_RUN_ID, now: () => '2026-10-26T08:02:00.000Z' })
  const job = await harness.wrapLargeApprove(createLargeBomCheckpointApplyJob)({
    storage, ...SCOPE, actionId: action.actionId, jobId: 'cg-job-1', principal: 'cg-principal', permission: 'write', createApplyJobId: () => 'cg-apply-1', now: () => '2026-10-26T08:03:00.000Z',
  })
  const env = harness.refresh()
  const key = __internals.checkpointApplyJobKey({ ...SCOPE, actionId: action.actionId, applyJobId: 'cg-apply-1' })
  const scopeKey = sheetWriteScopeKey(action.target.sheetId)
  const refreshScope = { tenantId: SCOPE.tenantId, sheetId: action.target.sheetId, projectNo: swlKit.GOLDEN_PROJECT_NO }
  return { harness, storage, action, job, env, key, scopeKey, refreshScope }
}

// Runs one chunk inside the REAL lease with the given extra inputs; returns the outcome and the storage.set calls
// the chunk itself made.
async function runChunk(flow, api, extra = {}) {
  const setsBefore = flow.storage.calls.filter(([op]) => op === 'set').length
  let result = null
  let error = null
  try {
    result = await flow.harness.lock.withProjectWriteLease(flow.scopeKey, { purpose: 'large_apply_chunk', runId: 'cg-chunk', tenantId: SCOPE.tenantId }, (guard) => runLargeBomCheckpointApplyJobChunk({
      storage: flow.storage, ...SCOPE, actionId: flow.action.actionId, applyJobId: 'cg-apply-1', recordsApi: swlKit.withFakeHostWriteFence(api.recordsApi), projectWriteGuard: guard, ...extra,
    }))
  } catch (thrown) {
    error = thrown
  }
  const sets = flow.storage.calls.filter(([op]) => op === 'set').length - setsBefore
  return { result, error, sets }
}

const gateOf = (flow) => flow.env.chunkGateFor(SCOPE.tenantId, swlKit.GOLDEN_PROJECT_NO)

test('CG-1 a GOVERNED project (a store-seeded hold, no bump): the in-lease gate refuses 409 LARGE_LANE_REFUSED { reason: hold, lane } — the stored job byte-identical, no storage.set, zero records writes', async () => {
  const flow = await approvedJob()
  const candidate = await refreshKit.candidateHoldFixture()
  await flow.env.seedHolds(flow.refreshScope, [candidate.hold])
  const before = await flow.storage.get(flow.key)
  const api = createTargetRecordsApi()
  const { error, sets } = await runChunk(flow, api, { refreshGovernanceGate: gateOf(flow) })
  assert.ok(error)
  assert.equal(error.status, 409)
  assert.equal(error.code, CODE_REFUSED)
  assert.deepEqual(error.details, { reason: 'hold', lane: 'large_apply_chunk', partial: false })
  assert.deepEqual(await flow.storage.get(flow.key), before, 'the job is untouched (status, checkpoint, counts)')
  assert.equal(sets, 0, 'no storage.set during the refused chunk')
  assert.equal(api.writes(), 0)
})

test('CG-2 the gate ABSENT: 501 chunk_gate_absent BEFORE the job turns running, the job untouched, nothing stored', async () => {
  const flow = await approvedJob()
  const before = await flow.storage.get(flow.key)
  const api = createTargetRecordsApi()
  const { error, sets } = await runChunk(flow, api)
  assert.equal(error.status, 501)
  assert.equal(error.code, CODE_UNCONSULTED)
  assert.deepEqual(error.details, { reason: 'chunk_gate_absent', partial: false })
  assert.deepEqual(await flow.storage.get(flow.key), before)
  assert.equal(sets, 0)
  assert.equal(api.writes(), 0)
})

test('CG-3 NOT governed: the chunk runs and writes; the writer received the gate\'s not_governed verdict (its tripwire admitted it under writeFenceRequired)', async () => {
  const flow = await approvedJob()
  const verdicts = []
  const gate = gateOf(flow)
  const api = createTargetRecordsApi()
  const { result, error } = await runChunk(flow, api, { refreshGovernanceGate: async (input) => { const verdict = await gate(input); verdicts.push(verdict); return verdict } })
  assert.equal(error, null, error && error.message)
  assert.ok(['succeeded', 'paused'].includes(result.status), result.status)
  assert.ok(api.writes() > 0, 'the chunk wrote')
  assert.equal(verdicts.length, 1)
  assert.equal(verdicts[0].consulted, true)
  assert.equal(verdicts[0].verdict, 'not_governed')
  assert.equal(verdicts[0].generationToken, (await flow.harness.lock.readGeneration(flow.scopeKey)).generationToken, 'the in-lease verdict carries the grant\'s token (TD-20 premise)')
  assert.equal(flow.env.stepFourRowCount(), 0, 'the gate wrote nothing to the step-4 stores')
})

test('CG-4 a PILOT job answers PR B\'s in-lease code FIRST: the gate is never asked, the job untouched', async () => {
  const flow = await approvedJob()
  let asked = 0
  const before = await flow.storage.get(flow.key)
  const api = createTargetRecordsApi()
  const pilotRefusal = Object.assign(new Error('pilot'), { status: 409, code: 'STOCK_PREP_PILOT_LARGE_LANE_REFUSED' })
  const { error, sets } = await runChunk(flow, api, {
    largeLanePilotCheck: async () => { throw pilotRefusal },
    refreshGovernanceGate: async () => { asked += 1; throw new Error('the gate must not be asked') },
  })
  assert.equal(error, pilotRefusal)
  assert.equal(asked, 0)
  assert.deepEqual(await flow.storage.get(flow.key), before)
  assert.equal(sets, 0)
})

test('CG-5 the matrix: pilot by the registry => refused `pilot`; protected by a relationship => `continuation`; by a state row alone => `refresh_state`; not governed => runs', async () => {
  const pilot = await approvedJob()
  await pilot.env.registerProject({ tenantId: SCOPE.tenantId, projectNo: swlKit.GOLDEN_PROJECT_NO, sheetId: pilot.action.target.sheetId, pilot: true })
  const pilotRun = await runChunk(pilot, createTargetRecordsApi(), { refreshGovernanceGate: gateOf(pilot) })
  assert.equal(pilotRun.error.code, CODE_REFUSED)
  assert.equal(pilotRun.error.details.reason, 'pilot')
  const protectedFlow = await approvedJob()
  const candidate = await refreshKit.candidateHoldFixture()
  // The kit's real candidate belongs to its own synthetic project; the relationship is confirmed for THAT project
  // on this job's sheet, and the gate consults that project (the chunk's project in this leg).
  await protectedFlow.env.seedConfirmedContinuation({ ...protectedFlow.refreshScope, projectNo: candidate.projectNo }, candidate.hold, { sourceIdentity: candidate.sourceIdentity })
  const protectedRun = await runChunk(protectedFlow, createTargetRecordsApi(), { refreshGovernanceGate: protectedFlow.env.chunkGateFor(SCOPE.tenantId, candidate.projectNo) })
  assert.equal(protectedRun.error.code, CODE_REFUSED)
  assert.equal(protectedRun.error.details.reason, 'continuation')
  const stateOnly = await approvedJob()
  await stateOnly.env.seedHolds(stateOnly.refreshScope, [])
  const stateRun = await runChunk(stateOnly, createTargetRecordsApi(), { refreshGovernanceGate: gateOf(stateOnly) })
  assert.equal(stateRun.error.code, CODE_REFUSED)
  assert.equal(stateRun.error.details.reason, 'refresh_state')
  const free = await approvedJob()
  const freeRun = await runChunk(free, createTargetRecordsApi(), { refreshGovernanceGate: gateOf(free) })
  assert.equal(freeRun.error, null)
})

test('CG-6 a verdict that does not match the plan (`projected` for an unprojected large plan), a stale / forged token, or a malformed verdict is refused by the writer\'s own tripwire BEFORE running — never stranded `running`; the binding (PLAN_SUPERSEDED) and the host fence answer before the gate', async () => {
  for (const [label, verdict, reason] of [
    ['projected verdict, unprojected plan', (token) => ({ consulted: true, verdict: 'projected', generationToken: token }), 'governance_plan_mismatch'],
    ['stale token', () => ({ consulted: true, verdict: 'not_governed', generationToken: 'tok-cg-stale' }), 'governance_stale'],
    ['not consulted', (token) => ({ consulted: false, verdict: 'not_governed', generationToken: token }), 'governance_malformed'],
    ['no verdict', () => undefined, 'governance_absent'],
  ]) {
    const flow = await approvedJob()
    const before = await flow.storage.get(flow.key)
    const api = createTargetRecordsApi()
    const token = (await flow.harness.lock.readGeneration(flow.scopeKey)).generationToken
    const { error, sets } = await runChunk(flow, api, { refreshGovernanceGate: async () => verdict(token) })
    assert.equal(error && error.code, CODE_UNCONSULTED, label)
    assert.equal(error.details.reason, reason, label)
    assert.deepEqual(await flow.storage.get(flow.key), before, `${label}: untouched, never running`)
    assert.equal(sets, 0, label)
    assert.equal(api.writes(), 0, label)
  }
  // Answer order: a superseded job is PLAN_SUPERSEDED (the binding) and the gate is never asked.
  const superseded = await approvedJob()
  await superseded.harness.lock.bumpGeneration(superseded.scopeKey, { reason: 'small_preview' })
  let asked = 0
  const run = await runChunk(superseded, createTargetRecordsApi(), { refreshGovernanceGate: async () => { asked += 1; return undefined } })
  assert.equal(run.error.code, 'STOCK_PREP_PROJECT_PLAN_SUPERSEDED')
  assert.equal(asked, 0, 'the binding answers before the gate')
  // ...and a host without fence support is 501 host_fence_unsupported before the gate.
  const unfenced = await approvedJob()
  let askedUnfenced = 0
  const plainApi = createTargetRecordsApi()
  let unfencedError = null
  try {
    await unfenced.harness.lock.withProjectWriteLease(unfenced.scopeKey, { purpose: 'large_apply_chunk', runId: 'cg-chunk', tenantId: SCOPE.tenantId }, (guard) => runLargeBomCheckpointApplyJobChunk({
      storage: unfenced.storage, ...SCOPE, actionId: unfenced.action.actionId, applyJobId: 'cg-apply-1', recordsApi: plainApi.recordsApi, projectWriteGuard: guard, refreshGovernanceGate: async () => { askedUnfenced += 1 },
    }))
  } catch (error) {
    unfencedError = error
  }
  assert.equal(unfencedError.details.reason, 'host_fence_unsupported')
  assert.equal(askedUnfenced, 0)
  // The exported pre-check is the writer's own (one definition).
  assert.equal(typeof lanes.largeLaneVerdictOf, 'function')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-chunk-gate.test.cjs', tests)
