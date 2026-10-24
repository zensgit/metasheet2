'use strict'

// R67 ④ — 试算 through the background lane: `POST …/table-actions/:actionId/dry-run-jobs` (enqueue,
// 202) + `GET …/dry-run-jobs?projectNo=` (the caller's job for that project). The synchronous
// `POST …/dry-run` is unchanged and stays for API / script callers (the scheduled pull).
//
// Driven on the REAL route stack over the shared project-sheet substrate
// (support/stock-preparation-project-sheet-harness.cjs): the registry, the overview stamping, the
// tenant wall, the plan and the dry-run token are all real; the host, the records API and the PLM
// source are fakes. Synthetic values only.
//
//   J-01 the enqueue answers 202 while the PLM read is still blocked; the poll says `running`; the
//        finished job carries the synchronous route's payload byte for byte (only the random token
//        differs) and its token applies exactly as the synchronous one does.
//   J-02 THE GUARD CHAIN, measured: every refusal (401 / 403 / 400 / 409 / tenant mismatch / the S1
//        wall / the value-scope door) is the SAME status, the SAME body and the SAME host-call trace
//        on both lanes; a successful run makes the same host calls in the same order, as the same
//        operator (the identity the source is loaded under included).
//   J-03 THE GUARD CHAIN, enumerated from the source: the guard sequence each lane walks before its
//        work is derived from http-routes.cjs and asserted equal — the enqueue handler has no guard of
//        its own and delegates to the dry-run handler, and inside that handler the job branch touches
//        exactly the slot claim (after the last guard) and the launch (after the adapter load).
//   J-04 tenancy / permission: a floor operator, a foreign action and a tenant mismatch are refused
//        on the enqueue AND the poll; a job is read back only by whoever started it.
//   J-05 one in-flight dry-run per project: a second enqueue while one runs is 409 IN_PROGRESS
//        (`ownJob` says whose — the CALLER, whichever opt-in value they pressed with), costs no
//        credential load, and a request-carried `?workspaceId=` cannot split the slot; it frees on
//        completion; a guard that refuses after the slot was claimed frees it too.
//   J-05b the window between the slot claim and the `running` record (B2a + credential load): the
//        same caller's second press is 409 ownJob and its poll already answers `running`, never 404.
//   J-06 the project sheet's registry row + overview are stamped ONCE, from inside the job — previewed
//        on success, refused + code on a typed failure — and the stored failure is the synchronous
//        route's exact error envelope.
//   J-07 the poll's own shape: 400s, 404 when there is none, and the value-bearing job is a separate
//        record reachable only through the proven operator scope.
//   J-08 a `running` record no live slot backs (a restarted process) is reported INTERRUPTED and frees
//        the project; a finished record past the token TTL is 404 and deleted.
//   J-09 no durable store: the enqueue is 501 before any source read; the synchronous route still 200.
//   J-10 the synchronous route writes no job record and claims no slot — a sync dry-run next to a
//        running job is not refused.
//   J-11 an untyped failure inside the job is stored as the fixed values-free 500 and logged with a
//        closed-list code only.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
const { withoutReadPhaseClock } = require(path.join(__dirname, 'support', 'dry-run-read-phase-clock.cjs'))
const dryRunJobs = require(path.join(LIB, 'stock-preparation-dry-run-jobs.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

const TENANT = 'tenant-r67-dry-run-job'
const OTHER_TENANT = 'tenant-r67-dry-run-foreign'
const PROJECT = 'PRJ-R67-J1'
const ACTION_ID = PLM_STOCK_PREPARATION_ACTION_ID
const OTHER_ACTION_ID = 'plm.some-other-connector.v1'

const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const JOBS_PATH = '/api/integration/table-actions/:actionId/dry-run-jobs'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'
const REGISTRY_UPDATE = 'updateRow:integration_stock_prep_project_target'

const PULLER = Object.freeze({ id: 'u_r67_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const PULLER_B = Object.freeze({ id: 'u_r67_pull_b', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const FLOOR = Object.freeze({ id: 'u_r67_floor', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const INTEGRATION_READER = Object.freeze({ id: 'u_r67_reader', tenantId: TENANT, permissions: ['integration:read'] })
const TENANTLESS_ADMIN = Object.freeze({ id: 'u_r67_admin', permissions: ['role:admin', 'integration:admin'] })

// ── substrate ────────────────────────────────────────────────────────────────────────────────────

/**
 * The shared project-sheet mount, with the two source services replaced by RECORDING twins of the
 * harness's own (same synthetic system, same source adapter) so a test can see which tenant and
 * principal the PLM source is loaded under — the only identity-bearing step of a dry-run.
 */
function mount(options = {}) {
  const holder = { adapter: null, failLoads: 0 }
  const identity = []
  const system = (input = {}) => ({
    id: input.id,
    tenantId: input.tenantId,
    name: 'Readonly PLM SQL (synthetic)',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    config: { dataSourceId: 'ds_synthetic', object: 'DN_PDM_PathExAttrInfo' },
  })
  const inert = (name) => async () => { throw new Error(`unexpected service call: ${name}`) }
  const serviceExtras = {
    externalSystemRegistry: {
      upsertExternalSystem: inert('upsertExternalSystem'),
      deleteExternalSystem: inert('deleteExternalSystem'),
      listExternalSystems: inert('listExternalSystems'),
      async getExternalSystem(input = {}) { return system(input) },
      async getExternalSystemForAdapter(input = {}) {
        identity.push(['load', input.tenantId || null, input.principal || null])
        if (holder.loadGate) await holder.loadGate
        if (holder.failLoads > 0) {
          holder.failLoads -= 1
          throw Object.assign(new Error('synthetic credential store refusal'), { status: 503, code: 'SYNTHETIC_CREDENTIALS_UNAVAILABLE' })
        }
        return { ...system(input), credentials: {} }
      },
    },
    adapterRegistry: {
      createAdapter(created, deps = {}) {
        identity.push(['adapter', created && created.tenantId ? created.tenantId : null, deps.principal || null])
        return holder.adapter
      },
      listAdapterKinds() { return [] },
    },
    ...(options.serviceExtras || {}),
  }
  const h = harness.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, ...options, serviceExtras })
  holder.adapter = h.source.adapter
  h.identity = identity
  h.holder = holder
  return h
}

const dryRunBody = (extra = {}) => ({ parameters: { projectNo: PROJECT }, ...extra })
const call = (h, method, routePath, { user, body, query, actionId = ACTION_ID } = {}) => harness.call(h.routes, method, routePath, { user, params: { actionId }, body, query })
const syncDryRun = (h, user, body = dryRunBody(), query = { tenantId: TENANT }, actionId) => call(h, 'POST', DRY_RUN_PATH, { user, body, query, actionId })
const startJob = (h, user, body = dryRunBody(), query = { tenantId: TENANT }, actionId) => call(h, 'POST', JOBS_PATH, { user, body, query, actionId })
const pollJob = (h, user, query = { tenantId: TENANT, projectNo: PROJECT }, actionId) => call(h, 'GET', JOBS_PATH, { user, query, actionId })
const settle = (h) => dryRunJobs.settleDryRunJobsForTest(h.context.storage)
const registryRow = (h, projectNo = PROJECT) => h.registryRows().find((row) => row.project_no === projectNo)

/** Hold every PLM read until `release()`. */
function blockSource(h) {
  const read = h.source.adapter.read.bind(h.source.adapter)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  h.source.adapter.read = async (input) => { await gate; return read(input) }
  return { release: () => release() }
}

/** Every host interaction the routes made, in order. */
function trace(h) {
  return harness.clone({
    provisioning: h.provisioning.calls,
    db: h.db.calls,
    records: h.records.calls,
    directory: h.tenantDirectoryCalls,
    source: h.source.calls,
    identity: h.identity,
    audit: h.auditAppends.map((entry) => entry.action),
  })
}

function resetTrace(h) {
  h.provisioning.calls.length = 0
  h.db.calls.length = 0
  h.records.calls.length = 0
  h.tenantDirectoryCalls.length = 0
  h.source.calls.length = 0
  h.identity.length = 0
  h.auditAppends.length = 0
}

function withoutToken(result) {
  const copy = harness.clone(result)
  delete copy.dryRunToken
  return copy
}

function jobKeysIn(storage) {
  return [...storage.keys()].filter((key) => key.startsWith(dryRunJobs.__internals.DRY_RUN_JOB_KEY_PREFIX))
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ── J-01 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-01 202 while the PLM read is still blocked; the poll says running; the finished job is the synchronous payload and its token applies unchanged', async () => {
  const a = mount()
  let syncResult
  let syncApply
  try {
    a.seedRegistryRow(PROJECT)
    const sync = await syncDryRun(a, PULLER)
    assert.equal(sync.statusCode, 200, JSON.stringify(sync.body))
    syncResult = sync.body.data
    syncApply = await call(a, 'POST', APPLY_PATH, { user: PULLER, body: { parameters: { projectNo: PROJECT }, confirm: { dryRunToken: syncResult.dryRunToken } }, query: { tenantId: TENANT } })
    assert.equal(syncApply.statusCode, 200, JSON.stringify(syncApply.body))
  } finally { a.restore() }

  const b = mount()
  try {
    b.seedRegistryRow(PROJECT)
    const gate = blockSource(b)
    const started = await startJob(b, PULLER)
    assert.equal(started.statusCode, 202, JSON.stringify(started.body))
    assert.equal(started.body.ok, true)
    const job = started.body.data
    assert.equal(job.status, 'running')
    assert.match(job.jobId, /^dry-run-[0-9a-f-]{36}$/)
    assert.equal(job.finishedAt, null)
    assert.equal(b.source.calls.length, 0, 'the 202 came back before a single PLM read completed')
    assert.equal(registryRow(b).last_pull_outcome, undefined, 'nothing is stamped before the job ends')

    const running = await pollJob(b, PULLER)
    assert.equal(running.statusCode, 200, JSON.stringify(running.body))
    assert.equal(running.body.data.status, 'running')
    assert.equal(running.body.data.jobId, job.jobId)
    assert.ok(!('result' in running.body.data), 'no result while running')

    gate.release()
    await settle(b)
    const done = await pollJob(b, PULLER)
    assert.equal(done.statusCode, 200, JSON.stringify(done.body))
    assert.equal(done.body.data.status, 'succeeded')
    assert.equal(done.body.data.jobId, job.jobId)
    assert.ok(typeof done.body.data.finishedAt === 'string')
    assert.ok(Number.isInteger(done.body.data.elapsedMs) && done.body.data.elapsedMs >= 0)
    const jobResult = done.body.data.result
    // R67 ③ (#6449) added `plmReadPhase.wallMs`, a clock reading, to the dry-run payload; the job result and
    // the synchronous result are the same payload minus the token and minus that one reading.
    assert.deepEqual(withoutReadPhaseClock(withoutToken(jobResult)), withoutReadPhaseClock(withoutToken(syncResult)), 'the job result IS the synchronous dry-run payload')
    assert.ok(Number.isInteger(jobResult.plmReadPhase?.wallMs) && jobResult.plmReadPhase.wallMs >= 0, 'the job result carries the read-phase clock reading')
    assert.equal(typeof jobResult.dryRunToken, 'string')
    assert.ok(jobResult.dryRunToken.length > 0, 'the job hands over a dry-run token')
    assert.equal(typeof syncResult.dryRunToken, 'string')

    const jobApply = await call(b, 'POST', APPLY_PATH, { user: PULLER, body: { parameters: { projectNo: PROJECT }, confirm: { dryRunToken: jobResult.dryRunToken } }, query: { tenantId: TENANT } })
    assert.equal(jobApply.statusCode, 200, `the job's token applies: ${JSON.stringify(jobApply.body)}`)
    assert.deepEqual(jobApply.body.data.apply.counts, syncApply.body.data.apply.counts, 'and writes what the synchronous token writes')
  } finally { b.restore() }
})

// ── J-02 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-02 every refusal is the same status, body and host-call trace on both lanes; a successful run makes the same host calls as the same operator', async () => {
  const scenarios = [
    { name: 'anonymous', user: undefined },
    { name: 'floor operator (no pull)', user: FLOOR },
    { name: 'a puller on another table action', user: PULLER, actionId: OTHER_ACTION_ID },
    { name: 'an unknown body key', user: PULLER, body: dryRunBody({ sheetId: 'sheet_x' }) },
    { name: 'a non-boolean opt-in', user: PULLER, body: dryRunBody({ includeMissingComponents: 'yes' }) },
    { name: 'the opt-in from a tenantless platform admin', user: TENANTLESS_ADMIN, body: dryRunBody({ includeMissingComponents: true }) },
    { name: 'a tenant the caller is not in', user: PULLER, query: { tenantId: OTHER_TENANT } },
    { name: 'an unregistered project (switch on)', user: PULLER, body: { parameters: { projectNo: 'PRJ-R67-NOPE' } } },
    { name: 'an archived project', user: PULLER, body: { parameters: { projectNo: 'PRJ-R67-ARCH' } }, seed: (h) => h.seedRegistryRow('PRJ-R67-ARCH', { archived: true }) },
    { name: 'parameters that are not an object', user: PULLER, body: { parameters: 'PRJ-R67-J1' } },
    // THE ONE PLACEMENT DIFFERENCE, pinned rather than hidden. The job lane validates `parameters` at its
    // slot claim (it needs the project number to key the slot), i.e. after the tenant wall and BEFORE the
    // B2a fence; the synchronous route only meets the same validator inside the plan, after the
    // credential load (and stamps `refused` there). Same status, same body; the job lane's host calls
    // are a strict PREFIX of the synchronous route's — it stops earlier and never loads a credential.
    { name: 'an unknown parameters key', user: PULLER, body: { parameters: { projectNo: PROJECT, sheetId: 'sheet_x' } }, seed: (h) => h.seedRegistryRow(PROJECT), jobStopsEarlier: true },
    { name: 'a parameters object with no projectNo', user: PULLER, body: { parameters: {} } },
    {
      name: 'the S1 wall (a registered sheet the registry does not attribute to the caller)',
      user: PULLER,
      seed: (h) => {
        h.db.rowsOf(harness.PROJECT_TARGET_TABLE).push({
          id: 'seed-planted', tenant_id: TENANT, project_no: PROJECT, sheet_id: 'sheet_planted_elsewhere',
          object_id: h.projectObjectId(PROJECT), status: 'active', created_by: 'seed', created_at: new Date('2026-10-08T00:00:00Z'),
          archived_at: null, archived_by: null, restored_at: null, restored_by: null, updated_at: new Date('2026-10-08T00:00:00Z'),
        })
      },
    },
  ]
  for (const scenario of scenarios) {
    const answers = {}
    for (const lane of ['sync', 'job']) {
      const h = mount()
      try {
        if (scenario.seed) scenario.seed(h)
        resetTrace(h)
        const body = scenario.body || dryRunBody()
        const query = scenario.query || { tenantId: TENANT }
        const res = lane === 'sync'
          ? await syncDryRun(h, scenario.user, body, query, scenario.actionId)
          : await startJob(h, scenario.user, body, query, scenario.actionId)
        answers[lane] = { status: res.statusCode, body: harness.clone(res.body), trace: trace(h), jobKeys: jobKeysIn(h.context.storage).length }
      } finally { h.restore() }
    }
    assert.ok(answers.sync.status >= 400, `${scenario.name}: the scenario is a refusal (got ${answers.sync.status})`)
    assert.equal(answers.job.status, answers.sync.status, `${scenario.name}: same status`)
    assert.deepEqual(answers.job.body, answers.sync.body, `${scenario.name}: same body`)
    if (scenario.jobStopsEarlier) {
      for (const [channel, calls] of Object.entries(answers.job.trace)) {
        assert.deepEqual(calls, answers.sync.trace[channel].slice(0, calls.length), `${scenario.name}: ${channel} is a prefix of the synchronous trace`)
      }
      assert.deepEqual(answers.job.trace.identity, [], `${scenario.name}: the job lane refused before any credential load`)
      assert.ok(answers.sync.trace.identity.length > 0, `${scenario.name}: calibration — the synchronous route refused later`)
    } else {
      assert.deepEqual(answers.job.trace, answers.sync.trace, `${scenario.name}: same host calls, same order`)
    }
    assert.equal(answers.job.jobKeys, 0, `${scenario.name}: a refused enqueue leaves no job record`)
  }

  // The success path, end to end: same host calls in the same order, the source loaded as the same
  // operator in the same tenant — the job has no identity of its own.
  const traces = {}
  for (const lane of ['sync', 'job']) {
    const h = mount()
    try {
      h.seedRegistryRow(PROJECT)
      resetTrace(h)
      const res = lane === 'sync' ? await syncDryRun(h, PULLER) : await startJob(h, PULLER)
      assert.equal(res.statusCode, lane === 'sync' ? 200 : 202, JSON.stringify(res.body))
      await settle(h)
      traces[lane] = trace(h)
    } finally { h.restore() }
  }
  assert.ok(traces.sync.source.length > 0, 'calibration: the synchronous run read the source')
  assert.deepEqual(traces.job, traces.sync, 'the job made exactly the synchronous run\'s host calls')
  assert.deepEqual(traces.job.identity, [['load', TENANT, PULLER.id], ['adapter', TENANT, PULLER.id]], 'the source is loaded as the enqueuing operator, in their tenant')
})

// ── J-03 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-03 the guard sequence, enumerated from the source, is the same list on both lanes', () => {
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const code = stripComments(fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8').replace(/\r\n/g, '\n'))
  const bodyOf = (name) => {
    const start = code.indexOf(`\n    async ${name}(req, res) {`)
    assert.notEqual(start, -1, `${name} exists`)
    return code.slice(start, code.indexOf('\n    },\n', start))
  }
  // Every call that can refuse a dry-run before its work starts, in the order the handler makes it.
  const GUARDS = [
    'requireTableActionAccess(',
    'normalizeTableActionBody(',
    'resolveOperatorValueScope(',
    'resolveTableActionExecution(',
    'resolveTenantId(',
    'assertResolvedProjectTargetTenancy(',
    // Batch-refresh phase 0 step 1: the sheet write-lock precheck (refuses while another run writes the sheet).
    'assertNoLiveWriter(',
    'assertB2aStockPreparationReadAuthorized(',
    'loadTableActionSourceAdapter(',
  ]
  const sequence = (body, until) => {
    const stop = body.indexOf(until)
    assert.notEqual(stop, -1, `the work starts at ${until}`)
    const found = []
    for (const guard of GUARDS) {
      let at = body.indexOf(guard)
      while (at !== -1 && at < stop) {
        found.push([at, guard])
        at = body.indexOf(guard, at + 1)
      }
    }
    return found.sort((x, y) => x[0] - y[0]).map(([, guard]) => guard)
  }
  const dryRun = bodyOf('tableActionDryRun')
  const start = bodyOf('tableActionDryRunJobStart')
  // SA01 moved the target lookup into the approved read-plan resolver. Pin its
  // nested guards as well: replacing the old two names must not hide a missing gate.
  const resolverStart = code.indexOf('  async function resolveTableActionExecution(req, input, snapshotAction, requireTarget = true) {')
  assert.notEqual(resolverStart, -1, 'target readiness remains enabled by default')
  const resolver = code.slice(resolverStart, code.indexOf('\n  async function ', resolverStart + 1))
  const nestedGuards = [
    'await tableActions.getTableActionForExecution(scope)',
    'await resolveStockPreparationReadPlanExecution({',
    'verifyTenant: () => resolveVerifiedClaimTenantId(req, input)',
    'requireTarget ? assertStockPreparationTargetReady(execution.action) : execution.action',
  ]
  let previous = -1
  for (const guard of nestedGuards) {
    const at = resolver.indexOf(guard)
    assert.ok(at > previous, 'the execution resolver retains its ordered lookup, approval, tenant and target guards')
    previous = at
  }
  assert.match(dryRun, /const action = await resolveTableActionExecution\(req, \{[\s\S]*?targetPurpose: 'write',\s*\}\)/,
    'both lanes require the target-ready execution path, with no override')

  // The synchronous lane: every guard before `runDryRun()` is awaited.
  const syncSequence = sequence(dryRun, 'return sendOk(res, await runDryRun())')
  // The job lane: the enqueue handler's own guards (there must be none) + the dry-run handler's up to
  // the launch.
  const ownGuards = GUARDS.filter((guard) => start.includes(guard))
  assert.deepEqual(ownGuards, [], 'the enqueue handler runs no guard of its own')
  assert.match(start, /return await handlers\.tableActionDryRun\(req, res\)/, 'the enqueue handler delegates to the dry-run handler itself')
  const jobSequence = [...ownGuards, ...sequence(dryRun, 'launchTableActionDryRunJob(dryRunJob, runDryRun)')]
  assert.ok(syncSequence.length >= GUARDS.length, `calibration: the scan found the chain (${syncSequence.join(' → ')})`)
  assert.deepEqual(jobSequence, syncSequence, 'the job lane walks exactly the synchronous guard chain')

  // …and the job branch inside the dry-run handler is exactly two touch points: the slot claim after
  // the LAST tenancy guard and before the B2a fence, and the launch after the adapter load. No guard
  // is conditional on the lane.
  assert.equal((dryRun.match(/\bdryRunJob\b/g) || []).length, 3, 'dryRunJob: declared once, launched once (two mentions on that line)')
  assert.ok(!dryRun.includes('dryRunJobRequests'), 'the dry-run handler never asks which lane it is on')
  const claimAt = dryRun.indexOf('const dryRunJob = reserveDryRunJobForRequest(')
  assert.ok(claimAt > dryRun.lastIndexOf('assertResolvedProjectTargetTenancy('), 'the slot is claimed after the tenant wall')
  assert.ok(claimAt < dryRun.indexOf('assertB2aStockPreparationReadAuthorized('), '…and before the B2a fence')
  assert.ok(dryRun.indexOf('launchTableActionDryRunJob(') > dryRun.indexOf('loadTableActionSourceAdapter('), 'the launch follows the adapter load')
  assert.ok(dryRun.indexOf('launchTableActionDryRunJob(') > dryRun.indexOf('const runDryRun = async () => {'), 'and launches the one shared closure')
})

// ── J-04 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-04 floor / foreign action / tenant mismatch are refused on enqueue AND poll; a job is read back only by its starter', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    assert.equal((await startJob(h, FLOOR)).statusCode, 403)
    assert.equal((await startJob(h, PULLER, dryRunBody(), { tenantId: TENANT }, OTHER_ACTION_ID)).statusCode, 403)
    assert.equal((await startJob(h, PULLER, dryRunBody(), { tenantId: OTHER_TENANT })).statusCode, 403)
    assert.equal((await startJob(h, undefined)).statusCode, 401)
    assert.deepEqual(jobKeysIn(h.context.storage), [], 'no refused enqueue wrote a record')

    assert.equal((await startJob(h, PULLER)).statusCode, 202)
    await settle(h)
    assert.equal((await pollJob(h, PULLER)).body.data.status, 'succeeded')

    const floorPoll = await pollJob(h, FLOOR)
    assert.equal(floorPoll.statusCode, 403, JSON.stringify(floorPoll.body))
    assert.equal(floorPoll.body.error.code, 'FORBIDDEN')
    assert.equal((await pollJob(h, PULLER, { tenantId: TENANT, projectNo: PROJECT }, OTHER_ACTION_ID)).statusCode, 403)
    const foreign = await pollJob(h, PULLER, { tenantId: OTHER_TENANT, projectNo: PROJECT })
    assert.equal(foreign.statusCode, 403, JSON.stringify(foreign.body))
    assert.equal((await pollJob(h, undefined)).statusCode, 401)
    // Another puller of the SAME tenant, and the legacy reader: a job is keyed by its starter.
    for (const user of [PULLER_B, INTEGRATION_READER]) {
      const other = await pollJob(h, user)
      assert.equal(other.statusCode, 404, `${user.id}: ${JSON.stringify(other.body)}`)
      assert.equal(other.body.error.code, 'STOCK_PREPARATION_DRY_RUN_JOB_NOT_FOUND')
    }
    // A tenantless platform admin steering ?tenantId= addresses only jobs it started itself.
    const steered = await pollJob(h, TENANTLESS_ADMIN)
    assert.equal(steered.statusCode, 404, JSON.stringify(steered.body))
  } finally { h.restore() }
})

// ── J-05 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-05 one in-flight dry-run per project: 409 while running (ownJob says whose), no credential load for it; frees on completion; a later refusal frees it too', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    const gate = blockSource(h)
    assert.equal((await startJob(h, PULLER)).statusCode, 202)
    const loadsBefore = h.identity.length

    const again = await startJob(h, PULLER)
    assert.equal(again.statusCode, 409, JSON.stringify(again.body))
    assert.equal(again.body.error.code, 'STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS')
    assert.deepEqual({ ...again.body.error.details }, { status: 'running', ownJob: true })
    const other = await startJob(h, PULLER_B)
    assert.equal(other.statusCode, 409, JSON.stringify(other.body))
    assert.deepEqual({ ...other.body.error.details }, { status: 'running', ownJob: false })
    // The value-bearing variant of the same project is the same target — and still the caller's OWN
    // trial, so the page attaches instead of telling them someone else is pulling.
    const flagged = await startJob(h, PULLER, dryRunBody({ includeMissingComponents: true }))
    assert.equal(flagged.statusCode, 409, JSON.stringify(flagged.body))
    assert.deepEqual({ ...flagged.body.error.details }, { status: 'running', ownJob: true })
    // A request-carried workspace is not a different target: no second trial of the project.
    for (const workspaceId of ['workspace-other', 'workspace-default']) {
      const steered = await startJob(h, PULLER_B, dryRunBody(), { tenantId: TENANT, workspaceId })
      assert.equal(steered.statusCode, 409, `?workspaceId=${workspaceId}: ${JSON.stringify(steered.body)}`)
      assert.equal(steered.body.error.code, 'STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS')
    }
    const ownSteered = await startJob(h, PULLER, dryRunBody(), { tenantId: TENANT, workspaceId: 'workspace-other' })
    assert.equal(ownSteered.statusCode, 409, JSON.stringify(ownSteered.body))
    assert.deepEqual({ ...ownSteered.body.error.details }, { status: 'running', ownJob: true })
    // …and the caller's poll finds the one job whatever workspace it names.
    const steeredPoll = await pollJob(h, PULLER, { tenantId: TENANT, projectNo: PROJECT, workspaceId: 'workspace-other' })
    assert.equal(steeredPoll.statusCode, 200, JSON.stringify(steeredPoll.body))
    assert.equal(steeredPoll.body.data.status, 'running')
    assert.equal(h.identity.length, loadsBefore, 'a refused second enqueue loaded no credential and built no adapter')
    assert.equal((await pollJob(h, PULLER)).body.data.status, 'running', 'the running job is untouched')

    gate.release()
    await settle(h)
    assert.equal((await pollJob(h, PULLER)).body.data.status, 'succeeded')
    const next = await startJob(h, PULLER_B)
    assert.equal(next.statusCode, 202, `the project is free again: ${JSON.stringify(next.body)}`)
    await settle(h)
  } finally { h.restore() }

  // A guard AFTER the claim (the credential load) refuses: nothing launched, the slot is freed.
  const g = mount()
  try {
    g.seedRegistryRow(PROJECT)
    g.holder.failLoads = 1
    const refused = await startJob(g, PULLER)
    assert.equal(refused.statusCode, 503, JSON.stringify(refused.body))
    assert.deepEqual(jobKeysIn(g.context.storage), [], 'no record for a launch that never happened')
    const retried = await startJob(g, PULLER)
    assert.equal(retried.statusCode, 202, `the refused enqueue did not keep the project: ${JSON.stringify(retried.body)}`)
    await settle(g)
  } finally { g.restore() }
})

// ── J-05b ────────────────────────────────────────────────────────────────────────────────────────
test('J-05b between the slot claim and the running record (B2a + credential load) a second own press attaches and its poll answers running, never 404', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    let releaseLoad
    h.holder.loadGate = new Promise((resolve) => { releaseLoad = resolve })
    // The first enqueue is held INSIDE the credential load: slot claimed, no `running` record yet.
    const first = startJob(h, PULLER)
    for (let i = 0; i < 20 && h.identity.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.identity.length, 1, 'calibration: the first enqueue is inside the credential load')
    assert.deepEqual(jobKeysIn(h.context.storage), [], 'calibration: no running record has been written yet')

    const again = await startJob(h, PULLER)
    assert.equal(again.statusCode, 409, JSON.stringify(again.body))
    assert.deepEqual({ ...again.body.error.details }, { status: 'running', ownJob: true })
    const polled = await pollJob(h, PULLER)
    assert.equal(polled.statusCode, 200, `the attached poll finds the claimed job: ${JSON.stringify(polled.body)}`)
    assert.equal(polled.body.data.status, 'running')
    // Another caller's poll does not see it — the window answers only its own record.
    assert.equal((await pollJob(h, PULLER_B)).statusCode, 404)

    h.holder.loadGate = null
    releaseLoad()
    const started = await first
    assert.equal(started.statusCode, 202, JSON.stringify(started.body))
    assert.equal(started.body.data.jobId, polled.body.data.jobId, 'the window answered the job that was then launched')
    await settle(h)
    assert.equal((await pollJob(h, PULLER)).body.data.status, 'succeeded')
  } finally { h.restore() }
})

// ── J-06 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-06 the registry row and the overview are stamped once, from inside the job; a typed failure stamps refused and stores the synchronous error envelope', async () => {
  const counts = {}
  for (const lane of ['sync', 'job']) {
    const h = mount()
    try {
      h.seedRegistryRow(PROJECT)
      const res = lane === 'sync' ? await syncDryRun(h, PULLER) : await startJob(h, PULLER)
      assert.ok(res.statusCode === 200 || res.statusCode === 202, JSON.stringify(res.body))
      await settle(h)
      counts[lane] = h.db.calls.filter((entry) => entry === REGISTRY_UPDATE).length
      const row = registryRow(h)
      assert.equal(row.last_pull_outcome, 'previewed', `${lane}: previewed`)
      assert.equal(row.last_pull_code, null)
    } finally { h.restore() }
  }
  assert.equal(counts.job, 1, 'the job stamped the registry exactly once')
  assert.equal(counts.job, counts.sync)

  const failures = {}
  for (const lane of ['sync', 'job']) {
    const h = mount()
    try {
      h.seedRegistryRow(PROJECT)
      // The target-field probe finds nothing: a typed 422 TARGET_SCHEMA_INCOMPLETE from inside the plan.
      h.provisioning.resolveExistingObjectFieldIds = async () => ({})
      if (lane === 'sync') {
        const res = await syncDryRun(h, PULLER)
        failures.sync = { httpStatus: res.statusCode, ...res.body.error }
      } else {
        const res = await startJob(h, PULLER)
        assert.equal(res.statusCode, 202, 'the refusal comes from the work, after the 202')
        await settle(h)
        const polled = await pollJob(h, PULLER)
        assert.equal(polled.statusCode, 200)
        assert.equal(polled.body.data.status, 'failed')
        failures.job = polled.body.data.error
      }
      assert.equal(registryRow(h).last_pull_outcome, 'refused', `${lane}: refused`)
      assert.equal(registryRow(h).last_pull_code, 'TARGET_SCHEMA_INCOMPLETE')
      assert.equal(h.db.calls.filter((entry) => entry === REGISTRY_UPDATE).length, 1, `${lane}: stamped once`)
    } finally { h.restore() }
  }
  assert.equal(failures.sync.httpStatus, 422)
  assert.equal(failures.sync.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.deepEqual(harness.clone(failures.job), harness.clone(failures.sync), 'the stored failure is the synchronous route\'s answer')
})

// ── J-07 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-07 the poll: 400 on shape, 404 when there is none, and the value-bearing job only through the proven scope', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    for (const query of [
      { tenantId: TENANT },
      { tenantId: TENANT, projectNo: '' },
      { tenantId: TENANT, projectNo: PROJECT, sheetId: 'sheet_x' },
      { tenantId: TENANT, projectNo: PROJECT, includeMissingComponents: 'yes' },
    ]) {
      const res = await pollJob(h, PULLER, query)
      assert.equal(res.statusCode, 400, `${JSON.stringify(query)}: ${JSON.stringify(res.body)}`)
    }
    const none = await pollJob(h, PULLER)
    assert.equal(none.statusCode, 404)
    assert.equal(none.body.error.code, 'STOCK_PREPARATION_DRY_RUN_JOB_NOT_FOUND')

    assert.equal((await startJob(h, PULLER, dryRunBody({ includeMissingComponents: true }))).statusCode, 202)
    await settle(h)
    assert.equal((await pollJob(h, PULLER)).statusCode, 404, 'the value-bearing job is not the values-free record')
    const flagged = await pollJob(h, PULLER, { tenantId: TENANT, projectNo: PROJECT, includeMissingComponents: 'true' })
    assert.equal(flagged.statusCode, 200, JSON.stringify(flagged.body))
    assert.equal(flagged.body.data.status, 'succeeded')
    assert.equal(typeof flagged.body.data.result.dryRunToken, 'string')
    // The scope door on the poll: a tenantless platform admin is refused before any lookup.
    const admin = await pollJob(h, TENANTLESS_ADMIN, { tenantId: TENANT, projectNo: PROJECT, includeMissingComponents: 'true' })
    assert.equal(admin.statusCode, 403, JSON.stringify(admin.body))
    assert.match(admin.body.error.code, /^OPERATOR_SCOPE_/)
  } finally { h.restore() }
})

// ── J-08 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-08 a running record no live slot backs is INTERRUPTED and frees the project; a finished record past the token TTL is 404 and deleted', async () => {
  const h = mount()
  const realNow = Date.now
  try {
    h.seedRegistryRow(PROJECT)
    const recordKey = dryRunJobs.__internals.dryRunJobRecordKey({ tenantId: TENANT, actionId: ACTION_ID, projectNo: PROJECT, principal: PULLER.id, valueBearing: false })
    await h.context.storage.set(recordKey, { jobId: 'dry-run-earlier-process', status: 'running', startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: null, instanceId: 'an-earlier-process' })
    const polled = await pollJob(h, PULLER)
    assert.equal(polled.statusCode, 200, JSON.stringify(polled.body))
    assert.equal(polled.body.data.status, 'failed')
    assert.equal(polled.body.data.error.code, 'STOCK_PREPARATION_DRY_RUN_JOB_INTERRUPTED')
    assert.equal((await h.context.storage.get(recordKey)).status, 'failed', 'the verdict is persisted')
    assert.equal((await startJob(h, PULLER)).statusCode, 202, 'the orphaned record holds nothing')
    await settle(h)
    assert.equal((await pollJob(h, PULLER)).body.data.status, 'succeeded')

    Date.now = () => realNow() + dryRunJobs.STOCK_PREPARATION_DRY_RUN_JOB_RESULT_TTL_MS + 60 * 1000
    const expired = await pollJob(h, PULLER)
    assert.equal(expired.statusCode, 404, JSON.stringify(expired.body))
    assert.deepEqual({ ...expired.body.error.details }, { expired: true })
    assert.equal(await h.context.storage.get(recordKey), undefined, 'and the record is gone')
  } finally {
    Date.now = realNow
    h.restore()
  }
})

// ── J-09 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-09 no durable store: the enqueue is 501 before any source read; the synchronous route still answers', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    h.context.storage.durable = false
    const res = await startJob(h, PULLER)
    assert.equal(res.statusCode, 501, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_DRY_RUN_JOB_STORE_UNAVAILABLE')
    assert.equal(h.source.calls.length, 0)
    assert.deepEqual(h.identity, [], 'no credential was loaded for it')
    assert.equal((await syncDryRun(h, PULLER)).statusCode, 200)
  } finally { h.restore() }
})

// ── J-10 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-10 the synchronous route writes no job record and claims no slot', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    assert.equal((await syncDryRun(h, PULLER)).statusCode, 200)
    assert.deepEqual(jobKeysIn(h.context.storage), [])
    const gate = blockSource(h)
    assert.equal((await startJob(h, PULLER)).statusCode, 202)
    const sync = syncDryRun(h, PULLER_B)
    gate.release()
    assert.equal((await sync).statusCode, 200, 'a synchronous dry-run next to a running job is not refused')
    await settle(h)
    assert.deepEqual(jobKeysIn(h.context.storage).length, 1)
  } finally { h.restore() }
})

// ── J-11 ─────────────────────────────────────────────────────────────────────────────────────────
test('J-11 an untyped failure inside the job is stored as the fixed values-free 500 and logged with a closed-list code only', async () => {
  const warnings = []
  const logger = { info() {}, error() {}, warn(message, meta) { warnings.push({ message, meta }) } }
  const h = mount({ logger })
  try {
    h.seedRegistryRow(PROJECT)
    // An untyped host failure inside the plan (the records read), the way O-11 drives one.
    h.records.queryRecords = async () => { throw new Error('host said value-4242 at host-internal') }
    assert.equal((await startJob(h, PULLER)).statusCode, 202)
    await settle(h)
    const polled = await pollJob(h, PULLER)
    assert.equal(polled.body.data.status, 'failed')
    assert.equal(polled.body.data.error.code, 'STOCK_PREPARATION_ROUTE_FAILED')
    assert.equal(polled.body.data.error.httpStatus, 500)
    assert.ok(!JSON.stringify(polled.body).includes('value-4242'), 'the stored failure carries no source text')
    const jobWarns = warnings.filter((entry) => /background dry-run failed/.test(entry.message))
    assert.equal(jobWarns.length, 1)
    assert.ok(!JSON.stringify(jobWarns).includes('value-4242'), 'the warn carries no source text')
    assert.deepEqual(Object.keys(jobWarns[0].meta), ['code'])
  } finally { h.restore() }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-dry-run-jobs.test.cjs', tests, { passLine: '✓ stock-preparation-dry-run-jobs' })
