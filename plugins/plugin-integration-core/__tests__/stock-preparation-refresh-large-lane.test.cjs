'use strict'

// Batch-refresh step 4, PR-3b — THE LARGE LANE'S GOVERNANCE (design §7.1 rows 7-11, D-7, O-1, §23 E-2 / E-3;
// plan-final §5). The four non-write large-BOM routes — expansion start, run, plan and approve — consult the
// governance reader right after PR B's pilot gate (`consultLargeLane`, PR-3a's helper and code); the plan records the
// not-governed verdict on the expansion job; the approval refuses a governed-shape plan and an unconsulted expansion
// before its binder bumps; the large planner never receives `continuation`. The chunk keeps PR-3a's in-lease gate.
//
//   LL-01 D-7 / P3-L1..L4: a project GOVERNED BY ROWS (a hold, a confirmed relationship, an execution, a bare state
//         row; pilot or not) => start / run / plan / approve answer 409 STOCK_PREP_REFRESH_LARGE_LANE_REFUSED
//         { reason, lane } after exactly ONE consult of the lane's own (tenant, project, sheet) and NOTHING after it:
//         no source read, no records / provisioning IO, no lock call (no observe, no bump), no storage write — every
//         stored job byte-identical, no job created.
//   LL-02 P3-L7 matrix: 5 routes x {pilot, protected, not governed}: pilot => PR B's code FIRST (the consult is never
//         asked); protected => LARGE_LANE_REFUSED (the chunk: PR-3a's in-lease gate); not governed => served, one
//         consult per call.
//   LL-03 G1 large / A11: the step-4 store UNREADABLE (42P01) => 503 STORE_FAILED on the four routes, nothing after.
//   LL-04 G2 large: an UNWIRED governance service => 501 governance_service on the four routes, nothing done.
//   LL-05 G5 large: a steered tenant (switch off, a state row of T on the env sheet, a tenantless platform admin
//         steering T') => 409 TENANT_MISMATCH on the four routes before any IO.
//   LL-06 G6 large / E-2(b): switch off — step-4 rows on the project's managed sheet while the action resolves the env
//         sheet => 409 RETARGETED `sheet` on the four routes; a PILOT registry row => PR B's code first; a registered
//         NOT-governed project => today's large lane (served on the env sheet).
//   LL-07 P3-L3: the plan records `governanceVerdict` (consulted, not_governed, the consult's generation token) beside
//         its write observation — replaced on every plan, outside the plan revision; a re-plan without one deletes it
//         and the approval refuses 409 GOVERNANCE_UNCONSULTED before the bump.
//   LL-08 O-1: an input carrying `continuation` (a REAL governed projection whose persisted hold carries a sentinel)
//         never reaches the large planner (a require-cache spy over the planner) — no key, no hold, no sentinel stored;
//         calibrated: the same input handed to the planner directly DOES carry the sentinel into `plan.holds`.
//   LL-09 P3-L4 (lib direct): crafted source jobs — a suspended plan, a plan carrying holds, a projected plan, no
//         verdict, a malformed or projected verdict — are refused before the manual-confirm acknowledgement, the
//         binder and any storage write, values-free.
//   LL-10 the plan's verdict input is validated BEFORE any IO: a malformed one is a 500 route defect, nothing read.
//   LL-11 brief item 2: an expansion planned while NOT governed, then governed (no bump) => approve 409 before the
//         binder's bump (generation unchanged, no apply job); an apply job approved while not governed, then governed
//         => the chunk 409 (PR-3a's gate), the job byte-identical, zero writes, the lease released.
//   LL-12 L05 / C09 large (brief item 5): the not-governed large lane matches the origin/main 4c4cd3aba capture —
//         every route answer, both stored job records (minus the one new verdict key), the plan revision and artifact,
//         the sheet rows, the records-API call sequence and the source reads (support/stock-preparation-large-lane-
//         golden-harness.cjs) — apart from ONE consult per start / run / plan / approve (4c4cd3aba: 0; the chunk's one
//         in-lease consult is PR-3a's on both) and the four digests #6323/#6324's v3 BOM evaluation identity moves,
//         pinned as an explicit main -> v3 delta in the LL-12 block below.
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const kit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const wiring = require('./support/stock-preparation-refresh-governance-wiring.cjs')
const refreshKit = require('./support/stock-preparation-refresh-store-kit.cjs')
const golden = require('./support/stock-preparation-large-lane-golden-harness.cjs')
const F = require('./support/stock-preparation-continuation-fixtures.cjs')
const largeBomJobs = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))
const { STOCK_PREPARATION_BOM_EVALUATION_VERSION: V } = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const lanes = require(path.join(LIB, 'stock-preparation-refresh-lanes.cjs'))
const pairing = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const lockLib = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const { PILOT_ERROR_CODES } = require(path.join(LIB, 'stock-preparation-pilot-gate.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-ll-a'
const OTHER_TENANT = 'tenant-ll-b'
const PROJECT = F.PROJECT_NO
const ENV_SHEET = 'sheet_env_synthetic'
const ENV_OBJECT = 'plm_stock_preparation_sandbox_synthetic_env'
// A sanctioned env binding (the shape scripts/ops/stock-preparation-derive-target-binding.mjs derives for THIS tenant).
const TENANT_ENV_SHEET = `sheet_${TENANT}:integration-core_${ENV_OBJECT}`.replace(/[^A-Za-z0-9_]/g, '_')
const JOBS_PATH = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'
const ADMIN = Object.freeze({ id: 'u_ll_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const PLATFORM = Object.freeze({ id: 'u_ll_platform', roles: ['admin'], permissions: ['integration:admin'] })
const CODE_REFUSED = 'STOCK_PREP_REFRESH_LARGE_LANE_REFUSED'
const LANE = Object.freeze({ start: 'large_expansion_start', run: 'large_expansion_run', plan: 'large_plan', approve: 'large_approve', chunk: 'large_apply_chunk' })
const SENTINEL = 'LL-SENTINEL-4b81d2'
const JOB_WORKSPACE = 'workspace-default'

const errorOf = (res) => (res && res.body && res.body.error ? res.body.error : {})
const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value))

// ── the world: the REAL routes over the project-sheet substrate, the REAL governance through a recording consult ──

function world({ switchOn = true, unwired = false, tenantEnv = false } = {}) {
  const lockEnv = kit.createInMemoryProjectWriteLock({ timers: 'real' })
  // Every lock call the ROUTES make (the governance reader reads the raw lock, inside its consult).
  const lockCalls = []
  const lock = {}
  for (const key of Object.keys(lockEnv.lock)) {
    const value = lockEnv.lock[key]
    lock[key] = typeof value === 'function' ? (...args) => { lockCalls.push(key); return value(...args) } : value
  }
  let h = null
  let sets = 0
  const consults = []
  const env = wiring.createRefreshGovernanceEnv({ lockOf: () => lockEnv.lock, registryOf: () => (h ? h.services.stockPreparationProjectTargetStore : null) })
  const io = () => ({ source: h.source.calls.length, records: h.records.calls.length, provisioning: h.provisioning.calls.length, sets, lock: lockCalls.length })
  // The recording consult: what it was asked and the IO counters AT the moment it ran (P3-C4 call order).
  const governance = Object.freeze({
    async consult(input) {
      consults.push({ input: plain(input), io: io() })
      return env.governance.consult(input)
    },
  })
  h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn,
    ...(tenantEnv ? {
      envObjectId: ENV_OBJECT,
      configExtras: {
        stockPreparationTableActions: [{
          actionId: PLM_STOCK_PREPARATION_ACTION_ID,
          source: { externalSystemId: 'plm_sql_source_synthetic', kind: 'data-source:sql-readonly' },
          target: { sheetId: TENANT_ENV_SHEET, objectId: ENV_OBJECT, fieldIdMap: {} },
        }],
      },
    } : {}),
    serviceExtras: {
      stockPreparationProjectWriteLock: lock,
      stockPreparationRefreshGovernance: unwired ? null : governance,
      stockPreparationContinuationStore: unwired ? null : env.store,
    },
  })
  const storage = h.context.storage
  const setOriginal = storage.set.bind(storage)
  storage.set = (key, value) => { sets += 1; return setOriginal(key, value) }
  const call = (method, routePath, { params = {}, body, user = ADMIN, query = { tenantId: TENANT } } = {}) =>
    harness.call(h.routes, method, routePath, { user, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID, ...params }, body, query })
  return {
    h,
    env,
    lockEnv,
    lockCalls,
    consults,
    io,
    envSheet: tenantEnv ? TENANT_ENV_SHEET : ENV_SHEET,
    start: (options = {}) => call('POST', JOBS_PATH, { body: { parameters: { projectNo: PROJECT } }, ...options }),
    run: (jobId, options = {}) => call('POST', `${JOBS_PATH}/:jobId/run`, { params: { jobId }, body: {}, ...options }),
    plan: (jobId, options = {}) => call('POST', `${JOBS_PATH}/:jobId/plan`, { params: { jobId }, body: {}, ...options }),
    approve: (jobId, options = {}) => call('POST', `${JOBS_PATH}/:jobId/apply-jobs`, { params: { jobId }, body: { confirm: { acceptManualConfirmHold: true } }, ...options }),
    chunk: (jobId, applyJobId, options = {}) => call('POST', `${JOBS_PATH}/:jobId/apply-jobs/:applyJobId/run`, { params: { jobId, applyJobId }, body: {}, ...options }),
    // Every large-BOM record of the store, serialized in key order (the "nothing persisted" fingerprint).
    largeBomState: () => JSON.stringify(Array.from(storage.entries()).filter(([key]) => String(key).startsWith('stock-preparation:large-bom:')).sort(([a], [b]) => (a < b ? -1 : (a > b ? 1 : 0)))),
    applyJobKeys: () => Array.from(storage.keys()).filter((key) => String(key).startsWith('stock-preparation:large-bom:apply:')),
    generation: async (sheetId) => plain(await lockEnv.lock.readGeneration(lockLib.sheetWriteScopeKey(sheetId))),
    restore: () => h.restore(),
  }
}

const snapshotOf = (w) => ({ consults: w.consults.length, io: w.io(), state: w.largeBomState() })

/**
 * The refusal happened AT the consult: exactly one consult, of `scope`, and nothing at all after it — no source read,
 * no records or provisioning IO, no lock call, no storage write — and every large-BOM record byte-identical.
 */
function assertStoppedAtTheConsult(label, w, before, res, { status = 409, code = CODE_REFUSED, details, scope } = {}) {
  assert.equal(res.statusCode, status, `${label}: ${JSON.stringify(res.body)}`)
  assert.equal(errorOf(res).code, code, `${label}: ${JSON.stringify(res.body)}`)
  if (details) assert.deepEqual(plain(errorOf(res).details), details, label)
  const consults = w.consults.slice(before.consults)
  assert.equal(consults.length, 1, `${label}: exactly one consult`)
  if (scope) assert.deepEqual(consults[0].input, scope, `${label}: the consult asked the lane's own (tenant, project, sheet)`)
  const after = w.io()
  assert.deepEqual(after, consults[0].io, `${label}: nothing ran after the consult (source / records / provisioning / storage / lock)`)
  assert.equal(after.source, before.io.source, `${label}: zero source reads`)
  assert.equal(after.records, before.io.records, `${label}: zero records IO`)
  assert.equal(after.sets, before.io.sets, `${label}: nothing stored`)
  assert.equal(after.lock, before.io.lock, `${label}: no lock call (no observation, no bump, no lease)`)
  assert.equal(w.largeBomState(), before.state, `${label}: every large-BOM record byte-identical`)
}

// Expansions at every stage, through the REAL routes while the project is NOT governed.
async function startedJob(w, options = {}) {
  const res = await w.start(options)
  assert.equal(res.statusCode, 202, `start: ${JSON.stringify(res.body)}`)
  return res.body.data.jobId
}
async function stages(w, options = {}) {
  const queued = await startedJob(w, options)
  const ran = await startedJob(w, options)
  const ranRes = await w.run(ran, options)
  assert.equal(ranRes.statusCode, 200, `run: ${JSON.stringify(ranRes.body)}`)
  const planned = await startedJob(w, options)
  assert.equal((await w.run(planned, options)).statusCode, 200)
  const plannedRes = await w.plan(planned, options)
  assert.equal(plannedRes.statusCode, 200, `plan: ${JSON.stringify(plannedRes.body)}`)
  return { queued, ran, planned }
}
async function approvedJob(w, options = {}) {
  const jobId = await startedJob(w, options)
  assert.equal((await w.run(jobId, options)).statusCode, 200)
  assert.equal((await w.plan(jobId, options)).statusCode, 200)
  const approved = await w.approve(jobId, options)
  assert.equal(approved.statusCode, 202, `approve: ${JSON.stringify(approved.body)}`)
  return { jobId, applyJobId: approved.body.data.jobId }
}

// A stored expansion job as the routes store it (for a world whose routes cannot create one: unwired / steered).
async function seedJob(w, { jobId, tenantId = TENANT, target, status = 'completed', planned = false, actor = ADMIN.id }) {
  const at = '2026-10-26T00:00:00.000Z'
  const scope = { tenantId, workspaceId: JOB_WORKSPACE }
  const writeObservation = lockLib.writeObservationFromGeneration(await w.lockEnv.lock.observeGeneration(lockLib.sheetWriteScopeKey(target.sheetId)))
  const job = {
    jobId, ...scope, actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    status, authoritative: status === 'completed', projectNoPresent: true,
    bomEvaluationVersion: V,
    parameters: { projectNo: PROJECT },
    principal: actor,
    actor,
    actionSnapshot: { actionId: PLM_STOCK_PREPARATION_ACTION_ID, source: { externalSystemId: 'plm_sql_source_synthetic', kind: 'data-source:sql-readonly' }, target },
    sourceKind: 'data-source:sql-readonly',
    artifactRevision: 'artifact-ll-1',
    artifact: { bomEvaluationVersion: V, revision: 'artifact-ll-1', status: 'expanded', rows: [], summary: {}, sealedAt: at },
    ...(planned ? {
      planRevision: 'plan-ll-1',
      planArtifact: { bomEvaluationVersion: V, sourceArtifactRevision: 'artifact-ll-1', revision: 'plan-ll-1', artifactRevision: 'artifact-ll-1', plan: { revision: 'plan-ll-1', decisions: [], plannedAt: at }, existingRowCount: 0, plannedAt: at },
      planWriteObservation: writeObservation,
      governanceVerdict: { consulted: true, verdict: 'not_governed', generationToken: writeObservation.generationToken },
    } : {}),
    progress: { rowsExpanded: 0, readCount: 0, frontierRemaining: 0, completedChunks: 1 },
    budgets: {},
    evidence: { sourceKind: 'data-source:sql-readonly', readObjects: [], errorTypes: [], readDiagnosticShapePresent: false },
    createdAt: at,
    updatedAt: at,
    writeObservation,
  }
  await w.h.context.storage.set(largeBomJobs.__internals.backgroundJobKey({ ...scope, actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId }), job)
  return job
}

function contentHold(key = 'k_ll', extraDetail = {}) {
  const hold = {
    kind: 'content_change',
    confirmable: false,
    notConfirmableReason: 'needs_step5',
    subject: { keyDigest: 'c'.repeat(64) },
    detail: { recordId: null, recordVersion: null, key, reason: 'plm_system_refresh', fields: {}, inContinuation: null, humanColumnsPresent: {}, ...extraDetail },
  }
  hold.fingerprint = pairing.holdFingerprint(hold)
  return hold
}

// Govern the project by ROWS only (no pilot column, no generation bump), the way each reason arises.
async function govern(w, reason, sheetId) {
  const scope = { tenantId: TENANT, sheetId, projectNo: PROJECT }
  if (reason === 'hold') return w.env.seedHolds(scope, [contentHold()])
  if (reason === 'continuation') {
    const candidate = await refreshKit.candidateHoldFixture()
    return w.env.seedConfirmedContinuation(scope, candidate.hold, { sourceIdentity: candidate.sourceIdentity })
  }
  if (reason === 'execution') return w.env.seedExecution(scope, { status: 'failed' })
  if (reason === 'refresh_state') return w.env.seedHolds(scope, [])
  throw new Error(`unknown reason ${reason}`)
}

function markPilot(w) {
  const row = w.h.registryRows().find((entry) => entry.project_no === PROJECT)
  assert.ok(row, 'the registry row exists')
  row.pilot_enabled_at = new Date('2026-10-26T00:00:00Z')
  row.pilot_enabled_by = 'seed'
  row.pilot_readiness_version = 1
}

// ── LL-01 ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LL-01 (D-7, P3-L1..L4) a project governed by ROWS — a hold, a confirmed relationship, an execution, a bare state row — is refused 409 LARGE_LANE_REFUSED { reason, lane } at start, run, plan and approve after ONE consult of its own scope, with nothing after it: no source read, no records / provisioning IO, no lock call, nothing stored, every job byte-identical, no bump', async () => {
  for (const reason of ['hold', 'continuation', 'execution', 'refresh_state']) {
    const w = world()
    try {
      const { sheetId } = w.h.seedRegistryRow(PROJECT)
      const jobs = await stages(w)
      await govern(w, reason, sheetId)
      const generation0 = await w.generation(sheetId)
      const scope = { tenantId: TENANT, projectNo: PROJECT, sheetId }
      for (const [route, run] of [['start', () => w.start()], ['run', () => w.run(jobs.queued)], ['plan', () => w.plan(jobs.ran)], ['approve', () => w.approve(jobs.planned)]]) {
        const before = snapshotOf(w)
        const res = await run()
        assertStoppedAtTheConsult(`${reason} / ${route}`, w, before, res, { details: { reason, lane: LANE[route], partial: false }, scope })
      }
      assert.deepEqual(await w.generation(sheetId), generation0, `${reason}: no observation clear, no bump`)
      assert.deepEqual(w.applyJobKeys(), [], `${reason}: no apply job exists`)
    } finally { w.restore() }
  }
})

// ── LL-02 ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LL-02 (P3-L7) the matrix — 5 routes x {pilot, protected, not governed}: pilot => PR B\'s code first with no consult at all; protected (rows, not pilot) => LARGE_LANE_REFUSED (the chunk from PR-3a\'s in-lease gate); not governed => served, exactly one consult per call', async () => {
  for (const variant of ['pilot', 'protected', 'not governed']) {
    const w = world()
    try {
      const { sheetId } = w.h.seedRegistryRow(PROJECT)
      // An apply job approved while NOT governed (its approval bumps), then expansions started after that bump.
      const approved = await approvedJob(w)
      const jobs = await stages(w)
      if (variant === 'pilot') markPilot(w)
      if (variant === 'protected') await govern(w, 'hold', sheetId)
      // The chunk runs LAST: a governed project's chunk is the job approved BEFORE governance (PR-3a's in-lease gate
      // refuses it); a not-governed project's chunk runs the job its served approval just created (a lease would
      // supersede the planned expansion's observation, and an approval the earlier job's binding, P1-b).
      let approvedNow = null
      const calls = [
        ['start', () => w.start()],
        ['run', () => w.run(jobs.queued)],
        ['plan', () => w.plan(jobs.ran)],
        ['approve', async () => {
          const res = await w.approve(jobs.planned)
          if (res.statusCode === 202) approvedNow = { jobId: jobs.planned, applyJobId: res.body.data.jobId }
          return res
        }],
        ['chunk', () => (approvedNow ? w.chunk(approvedNow.jobId, approvedNow.applyJobId) : w.chunk(approved.jobId, approved.applyJobId))],
      ]
      for (const [route, run] of calls) {
        const consultsBefore = w.consults.length
        const res = await run()
        const consulted = w.consults.length - consultsBefore
        if (variant === 'pilot') {
          assert.equal(res.statusCode, 409, `pilot ${route}: ${JSON.stringify(res.body)}`)
          assert.equal(errorOf(res).code, PILOT_ERROR_CODES.LARGE_LANE_REFUSED, `pilot ${route}`)
          assert.equal(errorOf(res).details.lane, LANE[route], `pilot ${route}`)
          assert.equal(consulted, 0, `pilot ${route}: PR B answers before the refresh consult`)
        } else if (variant === 'protected') {
          assert.equal(res.statusCode, 409, `protected ${route}: ${JSON.stringify(res.body)}`)
          assert.equal(errorOf(res).code, CODE_REFUSED, `protected ${route}`)
          assert.deepEqual(plain(errorOf(res).details), { reason: 'hold', lane: LANE[route], partial: false }, `protected ${route}`)
          assert.equal(consulted, 1, `protected ${route}: one consult`)
        } else {
          assert.ok([200, 202].includes(res.statusCode), `not governed ${route}: ${JSON.stringify(res.body)}`)
          assert.equal(consulted, 1, `not governed ${route}: exactly one consult`)
        }
      }
      const writes = w.h.records.calls.filter(([op]) => op === 'createRecord' || op === 'patchRecord').length
      if (variant === 'not governed') assert.ok(writes > 0, 'the not-governed chunk wrote')
      else assert.equal(writes, 0, `${variant}: zero record writes`)
    } finally { w.restore() }
  }
})

// ── LL-03 ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LL-03 (G1 large, A11) the step-4 store UNREADABLE (42P01): start, run, plan and approve answer 503 STOCK_PREP_REFRESH_STORE_FAILED at the consult with nothing after it — never "not governed"', async () => {
  const w = world()
  try {
    const { sheetId } = w.h.seedRegistryRow(PROJECT)
    const jobs = await stages(w)
    const generation0 = await w.generation(sheetId)
    w.env.db.faults.select = (args) => (args && /integration_stock_prep_(continuation|refresh)/.test(args.table) ? refreshKit.sqlError('42P01', 'relation does not exist') : null)
    try {
      for (const [route, run] of [['start', () => w.start()], ['run', () => w.run(jobs.queued)], ['plan', () => w.plan(jobs.ran)], ['approve', () => w.approve(jobs.planned)]]) {
        const before = snapshotOf(w)
        const res = await run()
        assertStoppedAtTheConsult(`unreadable / ${route}`, w, before, res, { status: 503, code: 'STOCK_PREP_REFRESH_STORE_FAILED' })
        assert.equal(JSON.stringify(res.body).includes('does not exist'), false, `${route}: the store message never travels`)
      }
    } finally {
      delete w.env.db.faults.select
    }
    assert.deepEqual(await w.generation(sheetId), generation0)
    assert.deepEqual(w.applyJobKeys(), [])
  } finally { w.restore() }
})

// ── LL-04 ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LL-04 (G2 large) an UNWIRED governance service: start, run, plan and approve answer 501 STOCK_PREP_REFRESH_STORE_UNAVAILABLE governance_service by name — no source read, no records IO, no lock call, nothing stored', async () => {
  const w = world({ unwired: true })
  try {
    const { sheetId, objectId } = w.h.seedRegistryRow(PROJECT)
    const target = { sheetId, objectId, fieldIdMap: {} }
    await seedJob(w, { jobId: 'job-ll-04-queued', target, status: 'queued' })
    await seedJob(w, { jobId: 'job-ll-04-ran', target })
    await seedJob(w, { jobId: 'job-ll-04-planned', target, planned: true })
    for (const [route, run] of [['start', () => w.start()], ['run', () => w.run('job-ll-04-queued')], ['plan', () => w.plan('job-ll-04-ran')], ['approve', () => w.approve('job-ll-04-planned')]]) {
      const before = snapshotOf(w)
      const res = await run()
      assert.equal(res.statusCode, 501, `${route}: ${JSON.stringify(res.body)}`)
      assert.equal(errorOf(res).code, 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE', route)
      assert.equal(errorOf(res).details.reason, 'governance_service', route)
      const after = w.io()
      assert.equal(after.source, before.io.source, `${route}: zero source reads`)
      assert.equal(after.records, before.io.records, `${route}: zero records IO`)
      assert.equal(after.sets, before.io.sets, `${route}: nothing stored`)
      assert.equal(after.lock, before.io.lock, `${route}: no lock call`)
      assert.equal(w.largeBomState(), before.state, `${route}: byte-identical`)
    }
    assert.deepEqual(w.applyJobKeys(), [])
  } finally { w.restore() }
})

// ── LL-05 ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LL-05 (G5 large) a steered tenant: switch off, a state row of T on the env sheet, a tenantless platform admin steering T\' => start, run, plan and approve answer 409 TENANT_MISMATCH (refresh_state) at the consult, nothing after it', async () => {
  const w = world({ switchOn: false })
  try {
    await w.env.seedHolds({ tenantId: TENANT, sheetId: ENV_SHEET, projectNo: PROJECT }, [])
    const steered = { user: PLATFORM, query: { tenantId: OTHER_TENANT } }
    const target = { sheetId: ENV_SHEET, objectId: ENV_OBJECT, fieldIdMap: {} }
    await seedJob(w, { jobId: 'job-ll-05-queued', tenantId: OTHER_TENANT, target, status: 'queued', actor: PLATFORM.id })
    await seedJob(w, { jobId: 'job-ll-05-ran', tenantId: OTHER_TENANT, target, actor: PLATFORM.id })
    await seedJob(w, { jobId: 'job-ll-05-planned', tenantId: OTHER_TENANT, target, planned: true, actor: PLATFORM.id })
    const rows = w.env.stepFourRowCount()
    const scope = { tenantId: OTHER_TENANT, projectNo: PROJECT, sheetId: ENV_SHEET }
    for (const [route, run] of [['start', () => w.start(steered)], ['run', () => w.run('job-ll-05-queued', steered)], ['plan', () => w.plan('job-ll-05-ran', steered)], ['approve', () => w.approve('job-ll-05-planned', steered)]]) {
      const before = snapshotOf(w)
      const res = await run()
      assertStoppedAtTheConsult(`steered / ${route}`, w, before, res, { code: 'STOCK_PREP_REFRESH_TENANT_MISMATCH', details: { store: 'continuation', table: 'refresh_state' }, scope })
    }
    assert.equal(w.env.stepFourRowCount(), rows, 'no step-4 write')
  } finally { w.restore() }
})

// ── LL-06 ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LL-06 (G6 large, E-2(b), GV-1) switch off: step-4 rows on the project\'s managed sheet while the action resolves the env sheet => start, run, plan and approve 409 RETARGETED `sheet` at the consult; a PILOT registry row => PR B\'s code first; a registered NOT-governed project => today\'s large lane, served on the env sheet with zero step-4 rows', async () => {
  // Registered, not pilot, no rows: today's behaviour on the env sheet (GV-1) — and the jobs the governed leg reuses.
  const w = world({ switchOn: false, tenantEnv: true })
  try {
    const { sheetId: managedSheet } = w.h.seedRegistryRow(PROJECT)
    const served = await approvedJob(w)
    assert.ok(served.applyJobId, 'the registered, not-governed project is served on the env sheet')
    const chunk = await w.chunk(served.jobId, served.applyJobId)
    assert.equal(chunk.statusCode, 200, JSON.stringify(chunk.body))
    assert.equal(w.env.stepFourRowCount(), 0, 'not governed: zero step-4 rows')
    const jobs = await stages(w)
    // Now step-4 rows land on the MANAGED sheet (the project is governed by rows; the switch-off action resolves the env sheet).
    await w.env.seedHolds({ tenantId: TENANT, sheetId: managedSheet, projectNo: PROJECT }, [contentHold('k_ll_06')])
    const scope = { tenantId: TENANT, projectNo: PROJECT, sheetId: w.envSheet }
    for (const [route, run] of [['start', () => w.start()], ['run', () => w.run(jobs.queued)], ['plan', () => w.plan(jobs.ran)], ['approve', () => w.approve(jobs.planned)]]) {
      const before = snapshotOf(w)
      const res = await run()
      assertStoppedAtTheConsult(`retargeted / ${route}`, w, before, res, { code: 'STOCK_PREP_REFRESH_TARGET_RETARGETED', scope })
      assert.equal(errorOf(res).details.reason, 'sheet', route)
    }
  } finally { w.restore() }
  // A PILOT registry row, switch off: PR B's gate answers by project number before the refresh consult.
  const p = world({ switchOn: false, tenantEnv: true })
  try {
    p.h.seedRegistryRow(PROJECT)
    markPilot(p)
    const res = await p.start()
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, PILOT_ERROR_CODES.LARGE_LANE_REFUSED)
    assert.equal(p.consults.length, 0, 'PR B answered first')
  } finally { p.restore() }
})

// ── LL-07 ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LL-07 (P3-L3) the plan records the consult\'s not-governed verdict beside its write observation — closed to three keys, the consult\'s token, outside the plan revision; replaced on every plan; a re-plan without one deletes it and the approval refuses 409 GOVERNANCE_UNCONSULTED before the bump', async () => {
  const w = world()
  try {
    const { sheetId } = w.h.seedRegistryRow(PROJECT)
    // A lock row with a real token, so the verdict carries one (a never-written row answers null).
    await w.lockEnv.lock.bumpGeneration(lockLib.sheetWriteScopeKey(sheetId), { reason: 'small_preview', tenantId: TENANT })
    const jobId = await startedJob(w)
    assert.equal((await w.run(jobId)).statusCode, 200)
    const planned = await w.plan(jobId)
    assert.equal(planned.statusCode, 200, JSON.stringify(planned.body))
    assert.equal(JSON.stringify(planned.body).includes('governanceVerdict'), false, 'the verdict is never answered')
    const key = largeBomJobs.__internals.backgroundJobKey({ tenantId: TENANT, workspaceId: JOB_WORKSPACE, actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId })
    const stored = plain(await w.h.context.storage.get(key))
    const token = (await w.generation(sheetId)).generationToken
    assert.ok(typeof token === 'string' && token, 'calibration: the lock row carries a token')
    assert.deepEqual(stored.governanceVerdict, { consulted: true, verdict: 'not_governed', generationToken: token })
    assert.deepEqual(Object.keys(stored.governanceVerdict).sort(), ['consulted', 'generationToken', 'verdict'])
    assert.deepEqual(stored.planWriteObservation && stored.planWriteObservation.generationToken, token, 'the same generation the plan observed')
    // A lib re-plan WITHOUT a verdict (a caller that never consulted): the key is deleted, the plan revision unchanged.
    const replanned = await largeBomJobs.planLargeBomBackgroundExpansionJob({
      storage: w.h.context.storage, tenantId: TENANT, workspaceId: JOB_WORKSPACE, actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId,
      existingRows: stored.planArtifact.existingRowCount === 0 ? [] : undefined,
      plannedAt: stored.planArtifact.plannedAt,
      runId: stored.planArtifact.plan.runId,
      writeGenerationReader: (observed) => w.lockEnv.lock.readGeneration(observed),
    })
    assert.equal(Object.prototype.hasOwnProperty.call(replanned, 'governanceVerdict'), false, 'a plan without a verdict records none')
    assert.equal(replanned.planRevision, stored.planRevision, 'the verdict is outside the plan revision')
    assert.deepEqual(plain(replanned.planArtifact), stored.planArtifact, 'and outside the plan artifact')
    const generation0 = await w.generation(sheetId)
    const refused = await w.approve(jobId)
    assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
    assert.equal(errorOf(refused).code, 'LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED')
    assert.deepEqual(plain(errorOf(refused).details), { reason: 'verdict_absent', partial: false })
    assert.deepEqual(await w.generation(sheetId), generation0, 'refused before the binder bumped')
    assert.deepEqual(w.applyJobKeys(), [], 'no apply job')
    // The route re-plan records it again; the approval is served.
    assert.equal((await w.plan(jobId)).statusCode, 200)
    assert.deepEqual(plain(await w.h.context.storage.get(key)).governanceVerdict, { consulted: true, verdict: 'not_governed', generationToken: token })
    const approved = await w.approve(jobId)
    assert.equal(approved.statusCode, 202, JSON.stringify(approved.body))
  } finally { w.restore() }
})

// ── LL-08 ────────────────────────────────────────────────────────────────────────────────────────────────────────

// A FRESH copy of the large-BOM lib whose planner reference is a spy (the lib destructures the planner at require time;
// the shared instance the rest of the suite uses is restored untouched).
function largeBomJobsWithPlannerSpy() {
  const plannerPath = require.resolve(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
  const lbPath = require.resolve(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))
  const planner = require(plannerPath)
  const original = planner.planStockPreparationConflicts
  const inputs = []
  const shared = require.cache[lbPath]
  delete require.cache[lbPath]
  planner.planStockPreparationConflicts = (input) => {
    inputs.push(input)
    return original(input)
  }
  try {
    return { lb: require(lbPath), inputs }
  } finally {
    planner.planStockPreparationConflicts = original
    require.cache[lbPath] = shared
  }
}

test('LL-08 (O-1) an input carrying `continuation` — a REAL governed projection whose persisted hold carries a sentinel — never reaches the large planner: the spy sees no `continuation` key, the stored plan has no holds / suspension / projection and no sentinel; calibrated: the same input handed to the planner directly carries the sentinel into plan.holds', async () => {
  const flow = kit.createLibWriteLockHarness()
  const env = flow.refresh()
  const storage = kit.createConsumableStorage()
  storage.durable = true
  const action = kit.goldenAction()
  const scope = { tenantId: 'tenant_rgw_default', workspaceId: JOB_WORKSPACE }
  const refreshScope = { tenantId: scope.tenantId, sheetId: action.target.sheetId, projectNo: kit.GOLDEN_PROJECT_NO }
  await env.seedHolds(refreshScope, [contentHold('k_ll_08', { key: SENTINEL, fields: { material: { before: SENTINEL, after: `${SENTINEL}-2` } } })])
  const consult = await env.governance.consult(refreshScope)
  assert.equal(consult.governed, true, 'calibration: governed by the persisted hold')
  const continuation = lanes.continuationInputFor({ consult, governed: true }, { action, expansion: null })
  assert.ok(JSON.stringify(continuation.persistedHolds).includes(SENTINEL), 'calibration: the sentinel rides persistedHolds')
  await flow.wrapLargeExpansionStart(largeBomJobs.createLargeBomBackgroundExpansionJob)({ storage, ...scope, action, parameters: { projectNo: kit.GOLDEN_PROJECT_NO }, principal: 'll-principal', createJobId: () => 'll-08-job' })
  await largeBomJobs.runLargeBomBackgroundExpansionJob({ storage, ...scope, actionId: action.actionId, jobId: 'll-08-job', sourceAdapter: kit.createSourceAdapter(kit.goldenPlmData()).adapter })
  // Calibration: the planner itself, handed this projection, re-emits the persisted hold (pilot exit) WITH the sentinel.
  const { planStockPreparationConflicts } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
  const direct = planStockPreparationConflicts({ expandedRows: [], existingRows: [], rowErrors: [], runId: 'run-ll-08', plannedAt: kit.GOLDEN_PLANNED_AT, continuation })
  assert.ok(Array.isArray(direct.holds) && JSON.stringify(direct.holds).includes(SENTINEL), 'calibration: a planner that received it would carry the sentinel')
  const { lb, inputs } = largeBomJobsWithPlannerSpy()
  const planned = await lb.planLargeBomBackgroundExpansionJob({
    storage, ...scope, actionId: action.actionId, jobId: 'll-08-job', existingRows: [], plannedAt: kit.GOLDEN_PLANNED_AT, runId: kit.GOLDEN_RUN_ID,
    continuation,
    governanceVerdict: { consulted: true, verdict: 'not_governed', generationToken: null },
  })
  assert.equal(inputs.length, 1, 'the spy saw the planner call')
  assert.equal(Object.prototype.hasOwnProperty.call(inputs[0], 'continuation'), false, 'the planner never receives `continuation`')
  assert.ok(Object.prototype.hasOwnProperty.call(inputs[0], 'expandedRows'), 'calibration: the spy sees the real input')
  const stored = await storage.get(largeBomJobs.__internals.backgroundJobKey({ ...scope, actionId: action.actionId, jobId: 'll-08-job' }))
  const text = JSON.stringify(stored)
  assert.equal(text.includes(SENTINEL), false, 'no hold value is stored')
  for (const key of ['holds', 'suspended', 'continuation']) assert.equal(Object.prototype.hasOwnProperty.call(stored.planArtifact.plan, key), false, `planArtifact.plan.${key} absent`)
  assert.equal(Object.prototype.hasOwnProperty.call(stored.planArtifact.plan.summary || {}, 'continuation'), false, 'no projection summary')
  assert.equal(JSON.stringify(planned).includes(SENTINEL), false)
})

// ── LL-09 ────────────────────────────────────────────────────────────────────────────────────────────────────────

// A planned expansion job written straight into a store, in a chosen (possibly crafted) shape.
async function craftedSource({ plan, verdict, storage = kit.createConsumableStorage() }) {
  storage.durable = true
  const at = '2026-10-26T00:00:00.000Z'
  const scope = { tenantId: 'tenant-ll-lbu', workspaceId: JOB_WORKSPACE }
  const job = {
    jobId: 'll-lbu-job', ...scope, actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    status: 'completed', authoritative: true, projectNoPresent: true,
    bomEvaluationVersion: V,
    parameters: { projectNo: 'PRJ-LL-LBU' },
    principal: 'll-principal',
    actionSnapshot: { actionId: PLM_STOCK_PREPARATION_ACTION_ID, source: { externalSystemId: 'plm_ll', kind: 'data-source:sql-readonly' }, target: { sheetId: 'sheet_ll_lbu', objectId: 'stockPreparationMain', fieldIdMap: {} } },
    artifactRevision: 'artifact-ll', artifact: { bomEvaluationVersion: V, revision: 'artifact-ll', status: 'expanded', rows: [], summary: {}, sealedAt: at },
    planRevision: 'plan-ll', planArtifact: { bomEvaluationVersion: V, sourceArtifactRevision: 'artifact-ll', revision: 'plan-ll', artifactRevision: 'artifact-ll', plan, existingRowCount: 0, plannedAt: at },
    ...(verdict === undefined ? {} : { governanceVerdict: verdict }),
    createdAt: at, updatedAt: at,
  }
  await storage.set(largeBomJobs.__internals.backgroundJobKey({ ...scope, actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId: 'll-lbu-job' }), job)
  return { storage, scope }
}

test('LL-09 (P3-L4, O-1, E-3) the approval lib refuses a governed-shape plan (suspended / carrying holds / projected) 409 LARGE_BOM_APPLY_PLAN_SUSPENDED and an unconsulted expansion (no verdict / a malformed or projected one) 409 LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED — before the manual-confirm acknowledgement, the binder and any storage write, values-free', async () => {
  const notGoverned = Object.freeze({ consulted: true, verdict: 'not_governed', generationToken: null })
  const manual = { decision: 'manual_confirm', idempotencyKey: 'll-key-1', record: { projectNo: 'PRJ-LL-LBU' } }
  const basePlan = { revision: 'plan-ll', decisions: [manual], counts: { add: 0, update: 0, inactive: 0, skip: 0, manual_confirm: 1 }, plannedAt: '2026-10-26T00:00:00.000Z' }
  const sentinelHold = contentHold('k_ll_09', { key: SENTINEL })
  const cases = [
    ['a suspended plan carrying a sentinel hold', { ...basePlan, suspended: true, holds: [sentinelHold], continuation: { verdicts: {} } }, notGoverned, 'LARGE_BOM_APPLY_PLAN_SUSPENDED', 'suspended'],
    ['a governed plan with an empty hold list', { ...basePlan, suspended: false, holds: [] }, notGoverned, 'LARGE_BOM_APPLY_PLAN_SUSPENDED', 'holds'],
    ['a projected plan (a continuation stanza only)', { ...basePlan, continuation: { verdicts: {} } }, notGoverned, 'LARGE_BOM_APPLY_PLAN_SUSPENDED', 'projected'],
    ['no verdict', basePlan, undefined, 'LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED', 'verdict_absent'],
    ['a null verdict', basePlan, null, 'LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED', 'verdict_absent'],
    ['a projected verdict', basePlan, { consulted: true, verdict: 'projected', generationToken: 'tok' }, 'LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED', 'verdict_invalid'],
    ['an unconsulted verdict', basePlan, { consulted: false, verdict: 'not_governed', generationToken: null }, 'LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED', 'verdict_invalid'],
    ['a blank token', basePlan, { consulted: true, verdict: 'not_governed', generationToken: ' ' }, 'LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED', 'verdict_invalid'],
    ['an extra key (a value channel)', basePlan, { consulted: true, verdict: 'not_governed', generationToken: null, holds: [sentinelHold] }, 'LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED', 'verdict_invalid'],
    ['a string verdict', basePlan, 'not_governed', 'LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED', 'verdict_invalid'],
  ]
  for (const [label, plan, verdict, code, reason] of cases) {
    const { storage, scope } = await craftedSource({ plan, verdict })
    const keysBefore = Array.from(storage.map.keys()).sort()
    const setsBefore = storage.calls.filter(([op]) => op === 'set').length
    let binderCalls = 0
    let error = null
    try {
      await largeBomJobs.createLargeBomCheckpointApplyJob({
        storage, ...scope, actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId: 'll-lbu-job', principal: 'll-approver', permission: 'write', createApplyJobId: () => 'll-lbu-apply',
        writeGenerationBinder: async () => { binderCalls += 1; throw new Error('the binder must not be reached') },
      })
    } catch (thrown) {
      error = thrown
    }
    assert.ok(error, `${label}: refused`)
    assert.equal(error.code, code, `${label}: ${error && error.message}`)
    assert.equal(error.status, 409, label)
    assert.deepEqual(plain(error.details), { reason, partial: false }, label)
    assert.equal(binderCalls, 0, `${label}: the binder never ran (no bump)`)
    assert.equal(storage.calls.filter(([op]) => op === 'set').length, setsBefore, `${label}: nothing stored`)
    assert.deepEqual(Array.from(storage.map.keys()).sort(), keysBefore, `${label}: no apply job`)
    assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(SENTINEL), false, `${label}: values-free`)
  }
  // A clean plan with a valid verdict passes BOTH refusals: the manual-confirm acknowledgement is what answers next,
  // and with it the job is created through the binder.
  const ok = await craftedSource({ plan: basePlan, verdict: notGoverned })
  await assert.rejects(largeBomJobs.createLargeBomCheckpointApplyJob({ storage: ok.storage, ...ok.scope, actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId: 'll-lbu-job', principal: 'll-approver', permission: 'write', createApplyJobId: () => 'll-lbu-apply' }),
    (error) => error.code === 'LARGE_BOM_APPLY_MANUAL_CONFIRM_ACK_REQUIRED')
  const created = await largeBomJobs.createLargeBomCheckpointApplyJob({ storage: ok.storage, ...ok.scope, actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId: 'll-lbu-job', principal: 'll-approver', permission: 'write', acceptManualConfirmHold: true, createApplyJobId: () => 'll-lbu-apply' })
  assert.equal(created.status, 'queued')
  for (const key of ['holds', 'suspended', 'continuation']) assert.equal(Object.prototype.hasOwnProperty.call(created.plan, key), false, `the apply-job copy has no ${key}`)
})

// ── LL-10 ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LL-10 the plan validates its verdict input BEFORE any IO: a malformed / projected / unconsulted / blank-token / extended / non-object verdict is a 500 route defect LARGE_BOM_PLAN_GOVERNANCE_VERDICT_INVALID with nothing read or stored; a null token and a non-blank token are accepted', async () => {
  const bad = [
    null,
    'not_governed',
    { consulted: true, verdict: 'projected', generationToken: 'tok' },
    { consulted: false, verdict: 'not_governed', generationToken: 'tok' },
    { consulted: true, verdict: 'not_governed', generationToken: '' },
    { consulted: true, verdict: 'not_governed', generationToken: 7 },
    { consulted: true, verdict: 'not_governed' },
    { consulted: true, verdict: 'not_governed', generationToken: null, holds: [] },
  ]
  for (const verdict of bad) {
    const calls = []
    const storage = { durable: true, async get(key) { calls.push(['get', key]); return null }, async set(key) { calls.push(['set', key]) } }
    await assert.rejects(largeBomJobs.planLargeBomBackgroundExpansionJob({ storage, tenantId: 'tenant-ll-lbu', workspaceId: JOB_WORKSPACE, actionId: PLM_STOCK_PREPARATION_ACTION_ID, jobId: 'll-lbu-job', existingRows: [], governanceVerdict: verdict }),
      (error) => error.code === 'LARGE_BOM_PLAN_GOVERNANCE_VERDICT_INVALID' && error.status === 500 && error.details.partial === false, JSON.stringify(verdict))
    assert.deepEqual(calls, [], `${JSON.stringify(verdict)}: no storage IO`)
  }
  assert.equal(largeBomJobs.__internals.isLargePlanGovernanceVerdict({ consulted: true, verdict: 'not_governed', generationToken: null }), true)
  assert.equal(largeBomJobs.__internals.isLargePlanGovernanceVerdict({ consulted: true, verdict: 'not_governed', generationToken: 'tok' }), true)
  assert.equal(largeBomJobs.__internals.normalizeLargePlanGovernanceVerdict(undefined), null, 'absent => the job records none')
})

// ── LL-11 ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LL-11 (brief item 2) an expansion planned while NOT governed, then governed by a hold (no bump): the approval 409 LARGE_LANE_REFUSED before the binder\'s bump — generation unchanged, no apply job; an apply job approved while not governed, then governed: the chunk 409 from PR-3a\'s in-lease gate — the job byte-identical, zero writes, the lease released', async () => {
  const w = world()
  try {
    const { sheetId } = w.h.seedRegistryRow(PROJECT)
    const approved = await approvedJob(w)
    const plannedJob = await startedJob(w)
    assert.equal((await w.run(plannedJob)).statusCode, 200)
    assert.equal((await w.plan(plannedJob)).statusCode, 200)
    const generation0 = await w.generation(sheetId)
    await govern(w, 'hold', sheetId)
    assert.deepEqual(await w.generation(sheetId), generation0, 'governing by a hold bumps nothing')
    const before = snapshotOf(w)
    const refused = await w.approve(plannedJob)
    assertStoppedAtTheConsult('approve after governance', w, before, refused, { details: { reason: 'hold', lane: 'large_approve', partial: false } })
    assert.deepEqual(await w.generation(sheetId), generation0, 'the binder never bumped')
    assert.equal(w.lockCalls.slice(before.io.lock).includes('bumpGeneration'), false, 'no bump call after governance')
    assert.equal(w.applyJobKeys().length, 1, 'only the earlier approval\'s job exists')
    const applyKey = w.applyJobKeys()[0]
    const job0 = JSON.stringify(await w.h.context.storage.get(applyKey))
    const writes0 = w.h.records.calls.filter(([op]) => op === 'createRecord' || op === 'patchRecord').length
    const chunk = await w.chunk(approved.jobId, approved.applyJobId)
    assert.equal(chunk.statusCode, 409, JSON.stringify(chunk.body))
    assert.equal(errorOf(chunk).code, CODE_REFUSED)
    assert.deepEqual(plain(errorOf(chunk).details), { reason: 'hold', lane: 'large_apply_chunk', partial: false })
    assert.equal(JSON.stringify(await w.h.context.storage.get(applyKey)), job0, 'the apply job byte-identical (never running)')
    assert.equal(w.h.records.calls.filter(([op]) => op === 'createRecord' || op === 'patchRecord').length, writes0, 'zero writes')
    assert.equal((await w.lockEnv.lock.readState(lockLib.sheetWriteScopeKey(sheetId))).leaseHeld, false, 'the lease was released')
  } finally { w.restore() }
})

// ── LL-12 ────────────────────────────────────────────────────────────────────────────────────────────────────────

// PROVENANCE. The literals below are origin/main 4c4cd3aba's capture (PR-3a, before PR-3b; support/stock-preparation-
// large-lane-golden-harness.cjs run over that route module) with exactly FOUR digests moved: the ones that hash
// #6323/#6324's v3 BOM evaluation identity (`bomEvaluationVersion`, and the plan artifact's `sourceArtifactRevision`).
// Every other literal is byte-identical to the 4c4cd3aba capture. The explicit main -> v3 delta:
//   storedExpansionJob  7a436a91b2296b6a61929440e68a40d5dfb2b87dde6b0131ca207c89e69d898f
//                    -> 92c324229673737e39b61786ce1dc2a83f17fc140ce578e6ae562a13842ada80
//   storedApplyJob      fbb468ed6f8c1d7a2c76bfa8ae1799995493f15a9240e58515e82a2a06e62024
//                    -> 66d0f75ca2c0866dc49dd190c4e7ce38717607b07214772f1764d17bfb56582c
//   planRevision        8f3d54a18d17e039a202ea397719785498cef34ceb7404103ce135d9f864b7ec
//                    -> 8a3c30e435fbec131fe52da7903c51b206a1a657f3dba879660c859658396621
//   planArtifact        1accc34edc4fe05175646f7be30be74efdc346bcc65f9c538cab89cf7d6fb039
//                    -> d8b0439422754bfd75302375db22e02b4fd091d09d483de36c417179fd7e5e8e
// The v3 values came from running the same harness unmodified over the #6324 head 10fa41409 (#6323/#6324 on main
// 40ce1b47e, before PR-3b; there the consult counts were start 0, run 0, plan 0, approve 0, chunk 1 — PR-3a's in-lease
// gate — and the stored expansion job carried no `governanceVerdict`); the aligned heads reproduce all twelve values.
// 10fa41409 is a PR-branch commit, never on origin/main: once #6324 is merged it stays reachable through
// refs/pull/6324/head. GOLDEN_LARGE_BASE_SHA is a label the test name states; nothing fetches it.
const GOLDEN_LARGE_BASE_SHA = '10fa41409e4c459aa6d00e7190d2f265c7f394c3'
const GOLDEN_LARGE_LANE = Object.freeze({
  statuses: { start: 202, getQueued: 200, run: 200, plan: 200, approve: 202, getApply: 200, chunks: [200], getFinal: 200 },
  answers: {
    start: '7c1f2737b983081d5846027692ab829838d05bf7485e1e1f205b8c1c09313661',
    getQueued: '8c2eb1cd36b8b9111ae6950a6101e0f523e0ae6aad9faa3222ead9274f0e54e9',
    run: 'e5bf536de943b61864df826c979f18deb86ec3dfd532aeeac68ba8e94e7017d8',
    plan: '3406809e0af98d4ce2543ca4b67f66a144ed07a607b6889332d6a1e3cd9e3aac',
    approve: '0b6060354c278157326b173187c8979a85f5cde2ba77cc40ec8b2d8a724c5503',
    getApply: 'ac111b3e78d532a740762080229c404cb38ce7ffa17be9c1d28c5b2286ea190f',
    chunks: 'f9cf7f241870cd38bc196e490609ddaa11d0802ad5af98063dc0601074432e64',
    getFinal: '3406809e0af98d4ce2543ca4b67f66a144ed07a607b6889332d6a1e3cd9e3aac',
  },
  storedExpansionJob: '92c324229673737e39b61786ce1dc2a83f17fc140ce578e6ae562a13842ada80',
  storedApplyJob: '66d0f75ca2c0866dc49dd190c4e7ce38717607b07214772f1764d17bfb56582c',
  planRevision: '8a3c30e435fbec131fe52da7903c51b206a1a657f3dba879660c859658396621',
  planArtifact: 'd8b0439422754bfd75302375db22e02b4fd091d09d483de36c417179fd7e5e8e',
  sheetRows: 'e1721819926317c01680cd9cb7f9869aa78f2619bf5eee6d6bc43af8d05b83a3',
  sheetRowCount: 1,
  recordsCalls: '71e7be3b87ee4de2eff4a24f0f8e6adffb3979c3e0727603e657aadee8da7bb8',
  recordsWrites: 1,
  sourceReads: 6,
  sourceReadInputs: '7f83fca18f91f792fc6041061638907de4af9f26d30feb333c201425a784850a',
})

test('LL-12 (L05 / C09 large, brief item 5) the NOT-governed large lane is byte-identical to 10fa41409: every route answer, both stored job records (minus the one new verdict key), the plan revision and artifact, the sheet rows, the records-API call sequence and the source reads — apart from ONE consult per start / run / plan / approve and the values-free verdict the plan records', async () => {
  assert.equal(GOLDEN_LARGE_BASE_SHA.slice(0, 9), '10fa41409', 'the test name states the captured base')
  const out = await golden.observeLargeLane()
  assert.deepEqual(out.observed, GOLDEN_LARGE_LANE)
  assert.deepEqual(out.consults, { start: 1, run: 1, plan: 1, approve: 1, chunk: 1, get: 0 }, 'one consult per call (10fa41409: 0 / 0 / 0 / 0 / 1)')
  assert.deepEqual(plain(out.verdict), { consulted: true, verdict: 'not_governed', generationToken: out.planTimeToken === undefined ? null : out.planTimeToken })
  assert.equal(out.stepFourRowCount, 0, 'a not-governed project writes no step-4 row')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-large-lane.test.cjs', tests)
