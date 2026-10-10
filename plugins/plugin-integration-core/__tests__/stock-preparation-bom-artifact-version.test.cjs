'use strict'

// Every downgraded record below first comes from the real server create/run/plan
// path. No hand-built template, expansion artifact, conflict plan or checkpoint.
const assert = require('node:assert/strict')
const bom = require('../lib/stock-preparation-bom-expansion.cjs')
const jobs = require('../lib/stock-preparation-large-bom-jobs.cjs')
const { PROJECT, SCOPE, NOW, fixture, sourceFor, storage, recordsApi, actionFor, runCases, clone } = require('./stock-preparation-bom-active-state.test.cjs')
const VERSION = 'stock-preparation-bom.v2'
const VERSION_ERROR = 'LARGE_BOM_EVALUATION_VERSION_UNSUPPORTED'
const INVALID = [['missing'], ['old', 'stock-preparation-bom.v1'], ['future', 'stock-preparation-bom.v999'], ['number', 2], ['null', null], ['object', { version: VERSION }], ['blank', ''], ['padded', ` ${VERSION} `]]

async function createReal(stage = 'planned') {
  const f = fixture()
  const store = storage()
  const source = sourceFor(f.data)
  const target = recordsApi()
  const action = actionFor(f.plan)
  const common = { storage: store, ...SCOPE, actionId: action.actionId, jobId: 'synthetic-job', now: () => NOW }
  const queued = await jobs.createLargeBomBackgroundExpansionJob({ ...common, action, parameters: { projectNo: PROJECT },
    principal: 'synthetic-user', bomEvaluationVersion: 'caller-must-not-bless', createJobId: () => common.jobId })
  const key = jobs.__internals.backgroundJobKey(common)
  const result = { f, store, source, target, common, key, queued }
  if (stage === 'queued') return result
  result.completed = await jobs.runLargeBomBackgroundExpansionJob({ ...common, sourceAdapter: source, expansionOptions: { readPlan: f.plan } })
  assert.equal(result.completed.status, 'completed', 'real expander succeeds before any storage downgrade')
  assert.equal(result.completed.artifact.rows.length, 3)
  assert.ok(source.calls.some((read) => read.object === f.plan.bomDetail.object), 'actual expansion read descendant details')
  if (stage === 'completed') return result
  result.planned = await jobs.planLargeBomBackgroundExpansionJob({ ...common, existingRows: [], plannedAt: NOW, runId: 'synthetic-plan' })
  assert.equal(result.planned.planArtifact.plan.counts.add, 3, 'actual conflict planner produced three adds')
  if (stage === 'planned') return result
  result.applyId = 'synthetic-checkpoint'
  result.applyCommon = { ...common, applyJobId: result.applyId, recordsApi: target }
  result.checkpoint = await jobs.createLargeBomCheckpointApplyJob({ ...common, principal: 'synthetic-user', permission: 'write',
    bomEvaluationVersion: 'caller-must-not-bless', createApplyJobId: () => result.applyId })
  result.applyKey = jobs.__internals.checkpointApplyJobKey(result.applyCommon)
  if (stage === 'checkpoint') return result
  result.paused = await jobs.runLargeBomCheckpointApplyJobChunk({ ...result.applyCommon, maxDecisionsPerChunk: 1 })
  assert.equal(result.paused.status, 'paused')
  assert.equal(target.writes.length, 1, 'a genuine first chunk applied before downgrade')
  if (stage === 'paused') return result
  result.finished = await jobs.runLargeBomCheckpointApplyJobChunk({ ...result.applyCommon, maxDecisionsPerChunk: 10 })
  assert.equal(result.finished.status, 'succeeded')
  assert.equal(target.writes.length, 3)
  return result
}

function downgrade(context, key, path, value, missing) {
  const record = clone(context.store.map.get(key))
  let object = record
  for (const field of path) object = object[field]
  if (missing) delete object.bomEvaluationVersion
  else object.bomEvaluationVersion = clone(value)
  // Direct private storage fixture migration, not a server API which might normalize it.
  context.store.map.set(key, record)
}

async function expectNoEffects(context, run, code, status) {
  const before = { storage: context.store.writes.length, source: context.source.calls.length, writes: context.target.writes.length,
    rows: clone(context.target.rows), records: clone([...context.store.map]) }
  let failure
  try { await run() } catch (error) { failure = error }
  assert.equal(context.target.writes.length, before.writes, 'old artifact reached actual create/patch')
  assert.equal(context.source.calls.length, before.source, 'unsupported stored generation reached source.read')
  assert.equal(context.store.writes.length, before.storage, 'unsupported stored generation changed durable state')
  assert.deepEqual(context.target.rows, before.rows)
  assert.deepEqual([...context.store.map], before.records, 'history must remain readable and unmodified')
  assert.equal(failure && failure.code, code, 'real execution entry must reject the incompatible generation')
  if (status !== undefined) assert.equal(failure.status, status)
}

async function positiveLifecycle() {
  assert.equal(bom.STOCK_PREPARATION_BOM_EVALUATION_VERSION, VERSION)
  const c = await createReal('finished')
  assert.equal(c.queued.bomEvaluationVersion, VERSION, 'server stamps queued job, ignores caller stamp')
  assert.equal(c.queued.artifact, undefined, 'no pre-expansion artifact gets a stamp')
  assert.equal(c.completed.artifact.bomEvaluationVersion, VERSION)
  assert.equal(c.planned.planArtifact.bomEvaluationVersion, VERSION)
  assert.equal(c.planned.planArtifact.sourceArtifactRevision, c.completed.artifactRevision)
  assert.equal(c.checkpoint.bomEvaluationVersion, VERSION)
  assert.equal(c.finished.bomEvaluationVersion, VERSION)
  assert.equal(jobs.isAuthoritativeLargeBomExpansion(c.completed), true)
  assert.equal(jobs.publicBackgroundExpansionJob(c.completed).authoritative, true)
  assert.equal(jobs.isAuthoritativeLargeBomPlan(c.planned), true)
  assert.equal(c.target.rows.length, 3)
  assert.equal(jobs.publicCheckpointApplyJob(c.finished).status, 'succeeded')
  assert.equal(Object.hasOwn(jobs.publicCheckpointApplyJob(c.finished), 'bomEvaluationVersion'), false, 'no extra public checkpoint field')
}

async function rejectOldRun(stage, value, missing) {
  const c = await createReal(stage)
  downgrade(c, c.key, [], value, missing)
  const loaded = await jobs.loadLargeBomBackgroundExpansionJob(c.common)
  assert.equal(loaded.status, stage, 'history GET remains readable')
  if (stage === 'completed') assert.equal(jobs.publicBackgroundExpansionJob(loaded).authoritative, false)
  await expectNoEffects(c, () => jobs.runLargeBomBackgroundExpansionJob({ ...c.common, sourceAdapter: c.source,
    bomEvaluationVersion: VERSION, expansionOptions: { readPlan: c.f.plan } }), VERSION_ERROR, 409)
}

async function rejectAuthority(path, value, missing, entry) {
  const c = await createReal('planned')
  downgrade(c, c.key, path, value, missing)
  const loaded = await jobs.loadLargeBomBackgroundExpansionJob(c.common)
  if (path[0] !== 'planArtifact') {
    assert.equal(jobs.isAuthoritativeLargeBomExpansion(loaded), false)
    assert.equal(jobs.publicBackgroundExpansionJob(loaded).authoritative, false)
  }
  assert.equal(jobs.isAuthoritativeLargeBomPlan(loaded), false)
  if (entry === 'plan') {
    await expectNoEffects(c, () => jobs.planLargeBomBackgroundExpansionJob({ ...c.common, existingRows: [], bomEvaluationVersion: VERSION }), 'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE')
  } else {
    await expectNoEffects(c, () => jobs.createLargeBomCheckpointApplyJob({ ...c.common, principal: 'synthetic-user', permission: 'write',
      bomEvaluationVersion: VERSION, createApplyJobId: () => 'not-created' }), 'LARGE_BOM_PLAN_ARTIFACT_NOT_AUTHORITATIVE')
  }
}

async function rejectCompletedArtifactRun(value, missing) {
  const c = await createReal('completed')
  downgrade(c, c.key, ['artifact'], value, missing)
  const loaded = await jobs.loadLargeBomBackgroundExpansionJob(c.common)
  assert.equal(loaded.bomEvaluationVersion, VERSION, 'only the artifact is incompatible; the job is current')
  assert.equal(loaded.status, 'completed')
  await expectNoEffects(c, () => jobs.runLargeBomBackgroundExpansionJob({ ...c.common, sourceAdapter: c.source,
    bomEvaluationVersion: VERSION, expansionOptions: { readPlan: c.f.plan } }), 'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE')
}

async function rejectCheckpoint(stage, value, missing) {
  const c = await createReal(stage)
  downgrade(c, c.applyKey, [], value, missing)
  const loaded = await jobs.loadLargeBomCheckpointApplyJob(c.applyCommon)
  assert.equal(loaded.status, stage === 'checkpoint' ? 'queued' : stage === 'finished' ? 'succeeded' : 'paused')
  await expectNoEffects(c, () => jobs.runLargeBomCheckpointApplyJobChunk({ ...c.applyCommon, maxDecisionsPerChunk: 10,
    bomEvaluationVersion: VERSION }), VERSION_ERROR, 409)
}

async function rejectSourceRevision(kind) {
  const c = await createReal('planned')
  const record = clone(c.store.map.get(c.key))
  if (kind === 'missing') delete record.planArtifact.sourceArtifactRevision
  else record.planArtifact.sourceArtifactRevision = kind === 'wrong' ? 'unrelated-artifact-revision' : 42
  c.store.map.set(c.key, record)
  await expectNoEffects(c, () => jobs.createLargeBomCheckpointApplyJob({ ...c.common, principal: 'synthetic-user', permission: 'write',
    createApplyJobId: () => 'not-created' }), 'LARGE_BOM_PLAN_ARTIFACT_NOT_AUTHORITATIVE')
}

async function revisionsIncludeLineage() {
  const c = await createReal('planned')
  const job = c.completed
  // The revision is computed before JSON storage removes undefined keys. Use a
  // second actual expansion (same fixed source), not a fabricated summary.
  const expansion = await bom.expandPlmProjectBom({ sourceAdapter: sourceFor(c.f.data), projectNo: PROJECT,
    readPlan: c.f.plan, rootSelection: job.actionSnapshot.rootSelection })
  assert.deepEqual(JSON.parse(JSON.stringify(expansion.rows)), job.artifact.rows)
  assert.deepEqual(JSON.parse(JSON.stringify(expansion.summary)), job.artifact.summary)
  const input = { bomEvaluationVersion: VERSION, action: job.actionSnapshot, parameters: job.parameters, principal: job.principal,
    expansion: { rows: expansion.rows, summary: expansion.summary } }
  assert.equal(job.artifactRevision, jobs.__internals.hashJson(input), 'actual artifact revision seals evaluation version')
  delete input.bomEvaluationVersion
  assert.notEqual(job.artifactRevision, jobs.__internals.hashJson(input))
  const plan = c.planned.planArtifact.plan
  const expected = { bomEvaluationVersion: VERSION, artifactRevision: job.artifactRevision, existingRows: [], conflictPolicyReview: null,
    plan: { valid: plan.valid === true, counts: plan.counts || {}, conflictTypes: plan.summary && plan.summary.conflictTypes,
      duplicateExpandedKeyDiagnostics: plan.summary && plan.summary.duplicateExpandedKeyDiagnostics,
      duplicateExpandedKeyResolution: plan.summary && plan.summary.duplicateExpandedKeyResolution } }
  assert.equal(c.planned.planRevision, jobs.__internals.hashJson(expected), 'actual plan revision seals version and the source revision')
  delete expected.bomEvaluationVersion
  assert.notEqual(c.planned.planRevision, jobs.__internals.hashJson(expected))
}

async function retryClearsOldPlan(fail) {
  const c = await createReal('planned')
  // State-recovery fixture: retain a genuinely issued plan on a failed job. The
  // retry must discard it before even asking its first source question.
  const record = clone(c.store.map.get(c.key))
  record.status = 'failed'
  c.store.map.set(c.key, record)
  let firstReadObserved = false
  const read = c.source.read.bind(c.source)
  c.source.read = async (input) => {
    firstReadObserved = true
    const running = c.store.map.get(c.key)
    for (const key of ['artifact', 'artifactRevision', 'planArtifact', 'planRevision', 'planEvidence']) assert.equal(Object.hasOwn(running, key), false, `${key} survives into retry read`)
    if (fail) throw Object.assign(new Error('SYNTHETIC_READ_FAILED'), { code: 'SYNTHETIC_READ_FAILED' })
    return read(input)
  }
  const result = await jobs.runLargeBomBackgroundExpansionJob({ ...c.common, sourceAdapter: c.source, expansionOptions: { readPlan: c.f.plan } })
  assert.equal(firstReadObserved, true)
  for (const key of ['planArtifact', 'planRevision', 'planEvidence']) assert.equal(Object.hasOwn(result, key), false, 'retry cannot reuse old approval')
  assert.equal(result.status, fail ? 'failed' : 'completed')
  assert.equal(jobs.isAuthoritativeLargeBomPlan(result), false)
}

async function main() {
  globalThis.fetch = async () => { throw new Error('SYNTHETIC_TEST_FORBIDDEN_NETWORK') }
  const cases = [['real-positive-lifecycle', positiveLifecycle], ['revision-seals-lineage', revisionsIncludeLineage],
    ['retry-clears-old-plan-success', () => retryClearsOldPlan(false)], ['retry-clears-old-plan-failure', () => retryClearsOldPlan(true)]]
  for (const [label, value] of INVALID) {
    const missing = label === 'missing'
    for (const stage of ['queued', 'completed']) cases.push([`run-${stage}-${label}`, () => rejectOldRun(stage, value, missing)])
    cases.push([`run-completed-artifact-${label}`, () => rejectCompletedArtifactRun(value, missing)])
    for (const [name, path] of [['job', []], ['artifact', ['artifact']]]) {
      for (const entry of ['plan', 'checkpoint']) cases.push([`authority-${name}-${entry}-${label}`, () => rejectAuthority(path, value, missing, entry)])
    }
    cases.push([`authority-plan-checkpoint-${label}`, () => rejectAuthority(['planArtifact'], value, missing, 'checkpoint')])
    for (const stage of ['checkpoint', 'paused', 'finished']) cases.push([`chunk-${stage}-${label}`, () => rejectCheckpoint(stage, value, missing)])
  }
  for (const kind of ['missing', 'wrong', 'type']) cases.push([`source-revision-${kind}`, () => rejectSourceRevision(kind)])
  await runCases(cases, 'SA01F artifact-version')
}

module.exports = { main }
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1 })
