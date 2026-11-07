'use strict'

// R-69 1b-i — T8 (design baseline v2.3 §10.2.5): the governed entries' abort / checkpoint seam, and the
// proof that the HTTP routes did not move while their chain was extracted (§10.2.4; ADR
// adr-automation-pipeline-bridge-20261103.md §2 ③, §12 PR 1b-i). Synthetic data only; no host, no PLM,
// no K3, no DingTalk / YiDa. R-69 is OPEN: nothing in production passes a signal or a checkpoint yet.
//
//   G-01 the checkpoint seam itself: neither passed => null (no behaviour); malformed => TypeError; the
//        signal is checked BEFORE the checkpoint is awaited, and again after it; refusals carry OWN,
//        non-enumerable `failureStage` / `errorClass` and no `details` / `status`.
//   G-02 T8, table action: aborted after page 1 => page 2 is never read; a checkpoint that refuses at
//        page 2 => the same; an already-aborted signal => the checkpoint is never called and nothing is
//        read; a refusal before planning => no target-sheet read. Through `runGovernedStockPrepPull`.
//   G-03 T8, pipeline runner: aborted after page 1 => page 2 is never read, the run row closes `failed`,
//        the thrown PipelineRunnerError carries own `failureStage: 'read'` / `errorClass: 'aborted'` and
//        its `details` keep exactly `{ run, cause }`; a refusing checkpoint likewise; a write failure is
//        `failureStage: 'write'`; without a signal every page is read.
//   G-04 runGovernedPipeline hands the runner the exact input the route always built, and a second
//        argument ONLY when a signal / checkpoint was passed; triggeredBy is api | automation only.
//   G-05 BYTE-IDENTICAL HTTP: every failure path (and the pipeline success path, including the exact
//        runner input) answers the status and body captured on the pre-1b-i base, byte for byte.
//   G-06 THE PRINCIPAL CONTEXT: the fields it carries are exactly the request fields http-routes.cjs reads.
//   G-07 VALID_TRIGGERS gained `automation` (word only).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const checkpointSeam = require(path.join(LIB, 'governed-entry-checkpoint.cjs'))
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { createAdapterRegistry, createReadResult, createUpsertResult } = require(path.join(LIB, 'contracts.cjs'))
const { createPipelineRunner, PipelineRunnerError } = require(path.join(LIB, 'pipeline-runner.cjs'))
const { createRunLogger } = require(path.join(LIB, 'run-log.cjs'))
const { createWatermarkStore } = require(path.join(LIB, 'watermark.cjs'))
const { createDeadLetterStore } = require(path.join(LIB, 'dead-letter.cjs'))
const pipelines = require(path.join(LIB, 'pipelines.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const { runFailClosedSuite } = require('./support/fail-closed-suite-runner.cjs')

const TENANT = 'tenant-r69-governed'
const OTHER_TENANT = 'tenant-r69-governed-foreign'
const PROJECT = 'PRJ-R69-G1'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const JOBS_PATH = '/api/integration/table-actions/:actionId/dry-run-jobs'
const PIPELINE_RUN_PATH = '/api/integration/pipelines/:id/run'
const PIPELINE_DRY_RUN_PATH = '/api/integration/pipelines/:id/dry-run'

const PULLER = Object.freeze({ id: 'u_r69_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const FLOOR = Object.freeze({ id: 'u_r69_floor', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const INTEGRATION_READER = Object.freeze({ id: 'u_r69_reader', tenantId: TENANT, permissions: ['integration:read'] })
const INTEGRATION_WRITER = Object.freeze({ id: 'u_r69_writer', tenantId: TENANT, permissions: ['integration:write'] })
const TENANTLESS_WRITER = Object.freeze({ id: 'u_r69_tenantless', permissions: ['integration:write'] })
const silentLogger = Object.freeze({ info() {}, warn() {}, error() {} })

// ── shared fixtures ──────────────────────────────────────────────────────────────────────────────

/** The project-sheet route stack (real routes, fake host / PLM), plus a handler set over the SAME services. */
function mountStockPrep() {
  const h = harness.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, logger: silentLogger })
  h.seedRegistryRow(PROJECT)
  h.handlers = httpRoutes.createHandlers(h.services, { context: h.context, logger: silentLogger })
  return h
}

/** A principal context the way 1b-ii's port will hand one in: plain fields, no request. */
function pullerContext(extra = {}) {
  return { user: PULLER, query: { tenantId: TENANT }, params: {}, body: { parameters: { projectNo: PROJECT } }, ...extra }
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected a rejection')
  return null
}

function assertGovernedRefusal(error, failureStage, errorClass) {
  assert.ok(error instanceof checkpointSeam.GovernedEntryAbortError, `a governed refusal, got ${error && error.stack}`)
  assert.equal(error.code, checkpointSeam.GOVERNED_ENTRY_ABORTED_CODE)
  assert.equal(error.failureStage, failureStage)
  assert.equal(error.errorClass, errorClass)
  assertOwnHiddenTags(error)
  assert.equal(error.details, undefined, 'no details: nothing of the refusal is ever serialized')
  assert.equal(error.status, undefined)
}

function assertOwnHiddenTags(error) {
  for (const key of ['failureStage', 'errorClass']) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    assert.ok(descriptor, `${key} is an OWN property`)
    assert.equal(descriptor.enumerable, false, `${key} is non-enumerable`)
  }
  assert.ok(!Object.keys(error).includes('failureStage'))
  assert.ok(!JSON.stringify(error).includes('failureStage'), 'JSON of the error does not carry the tag')
  if (error.details) {
    assert.ok(!Object.prototype.hasOwnProperty.call(error.details, 'failureStage'), 'never inside details')
    assert.ok(!Object.prototype.hasOwnProperty.call(error.details, 'errorClass'), 'never inside details')
  }
}

// A minimal real pipeline runner: three pages of synthetic source rows, an in-memory run log.
function mountRunner({ pages = 3, targetUpsert, onRead, pipelineStatus = 'active' } = {}) {
  const tables = new Map([['integration_dead_letters', []], ['integration_watermarks', []], ['integration_runs', []]])
  const rowsOf = (table) => tables.get(table)
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => (value === null || value === undefined ? row[key] == null : row[key] === value))
  const db = {
    tables,
    async selectOne(table, where) { return rowsOf(table).find((row) => matches(row, where)) || null },
    async insertOne(table, row) { rowsOf(table).push({ ...row }); return [row] },
    async updateRow(table, set, where) { const row = rowsOf(table).find((candidate) => matches(candidate, where)); if (!row) return []; Object.assign(row, set); return [row] },
    async select(table, options = {}) { return rowsOf(table).filter((row) => matches(row, options.where || {})) },
  }
  const pipeline = {
    id: 'pipe_r69', tenantId: 'tenant_1', workspaceId: null, projectId: 'project_1',
    sourceSystemId: 'source_1', sourceObject: 'materials', targetSystemId: 'target_1', targetObject: 'BD_MATERIAL',
    mode: 'full', status: pipelineStatus, idempotencyKeyFields: ['code'], options: { batchSize: 1 },
    fieldMappings: [{ sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] }],
  }
  let nextRun = 1
  const runs = []
  const pipelineRegistry = {
    async getPipeline() { return pipeline },
    async createPipelineRun(input) { const run = { id: `run_${nextRun++}`, ...input }; runs.push(run); return run },
    async updatePipelineRun(input) { const run = runs.find((candidate) => candidate.id === input.id); Object.assign(run, input); return { ...run } },
  }
  const reads = []
  const adapterRegistry = createAdapterRegistry()
    .registerAdapter('mock-source', () => ({
      async testConnection() { return { ok: true } },
      async listObjects() { return [] },
      async getSchema() { return { fields: [] } },
      async read(input) {
        const page = input.cursor ? Number(input.cursor) : 1
        reads.push(page)
        if (onRead) onRead(page)
        return createReadResult({ records: [{ code: `SYN-${page}` }], nextCursor: page < pages ? String(page + 1) : null })
      },
      async upsert() { throw new Error('source upsert must not be called') },
    }))
    .registerAdapter('mock-target', () => ({
      async testConnection() { return { ok: true } },
      async listObjects() { return [] },
      async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: [] }) },
      async previewUpsert(input) { return { records: input.records.map(() => ({ action: 'create' })) } },
      async upsert(input) { if (targetUpsert) return targetUpsert(input); return createUpsertResult({ written: input.records.length }) },
    }))
  const systems = new Map([
    ['source_1', { id: 'source_1', name: 'synthetic source', kind: 'mock-source', role: 'source', status: 'active', config: {} }],
    ['target_1', { id: 'target_1', name: 'synthetic target', kind: 'mock-target', role: 'target', status: 'active', config: {} }],
  ])
  const runner = createPipelineRunner({
    pipelineRegistry,
    externalSystemRegistry: {
      async getExternalSystem(input) { return systems.get(input.id) },
      async getExternalSystemForAdapter(input) { const system = systems.get(input.id); return system ? { ...system, credentials: {} } : null },
    },
    adapterRegistry,
    deadLetterStore: createDeadLetterStore({ db, idGenerator: () => `dl_${rowsOf('integration_dead_letters').length + 1}` }),
    watermarkStore: createWatermarkStore({ db }),
    runLogger: createRunLogger({ pipelineRegistry }),
    clock: (() => { let tick = 0; return () => tick++ * 10 })(),
  })
  return { runner, reads, runs }
}

const runnerInput = (extra = {}) => ({ tenantId: 'tenant_1', workspaceId: null, pipelineId: 'pipe_r69', triggeredBy: 'api', runAs: 'user', ...extra })

// ── G-05 snapshot collection (the SAME function was run on the pre-1b-i base to capture EXPECTED) ──────

function pipelineMount() {
  const runnerCalls = []
  const pipeline = { id: 'pipe_snapshot', tenantId: TENANT, status: 'active', targetSystemId: 'target_snapshot', sourceSystemId: 'source_snapshot' }
  let runnerBehaviour = 'ok'
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn: true,
    logger: silentLogger,
    serviceExtras: {
      pipelineRegistry: {
        ...harness.inertService(['upsertPipeline', 'listPipelines', 'listPipelineRuns']),
        async getPipeline() { return pipeline },
      },
      pipelineRunner: {
        async runPipeline(...args) {
          runnerCalls.push(args)
          if (runnerBehaviour === 'throw') throw new PipelineRunnerError('pipeline run failed', { run: { id: 'run_snapshot', status: 'failed' }, cause: 'synthetic source unreachable' })
          return { run: { id: 'run_snapshot', status: 'succeeded' }, metrics: { rowsRead: 1 }, preview: args[0].dryRun ? { records: [], errors: [] } : null }
        },
      },
    },
  })
  return { h, runnerCalls, setRunner(behaviour) { runnerBehaviour = behaviour } }
}

async function collectRouteSnapshots() {
  const out = []
  const record = (name, res, extra = {}) => out.push({ name, status: res.statusCode, body: JSON.stringify(res.body), ...extra })
  const sp = harness.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, logger: silentLogger })
  try {
    sp.seedRegistryRow(PROJECT)
    const dry = (req) => harness.call(sp.routes, 'POST', DRY_RUN_PATH, { params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, ...req })
    const job = (req) => harness.call(sp.routes, 'POST', JOBS_PATH, { params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, ...req })
    const body = { parameters: { projectNo: PROJECT } }
    record('dry-run: no principal', await dry({ body, query: { tenantId: TENANT } }))
    record('dry-run: floor operator', await dry({ user: FLOOR, body, query: { tenantId: TENANT } }))
    record('dry-run: foreign action id for an operator', await dry({ user: PULLER, body, query: { tenantId: TENANT }, params: { actionId: 'plm.some-other-connector.v1' } }))
    record('dry-run: unsupported body key', await dry({ user: PULLER, body: { ...body, extra: 1 }, query: { tenantId: TENANT } }))
    record('dry-run: non-boolean opt-in', await dry({ user: PULLER, body: { ...body, includeMissingComponents: 'yes' }, query: { tenantId: TENANT } }))
    record('dry-run: operator, foreign tenant', await dry({ user: PULLER, body, query: { tenantId: OTHER_TENANT } }))
    record('dry-run: reader, foreign tenant', await dry({ user: INTEGRATION_READER, body, query: { tenantId: OTHER_TENANT } }))
    record('dry-run: reader, opt-in, foreign tenant', await dry({ user: INTEGRATION_READER, body: { ...body, includeMissingComponents: true }, query: { tenantId: OTHER_TENANT } }))
    record('dry-run: tenantless writer, no tenant', await dry({ user: TENANTLESS_WRITER, body, query: {} }))
    record('dry-run: malformed project number', await dry({ user: PULLER, body: { parameters: { projectNo: '' } }, query: { tenantId: TENANT } }))
    record('dry-run: unregistered project', await dry({ user: PULLER, body: { parameters: { projectNo: 'PRJ-R69-ABSENT' } }, query: { tenantId: TENANT } }))
    record('dry-run-jobs: floor operator', await job({ user: FLOOR, body, query: { tenantId: TENANT } }))
    record('dry-run-jobs: unsupported body key', await job({ user: PULLER, body: { ...body, extra: 1 }, query: { tenantId: TENANT } }))
  } finally {
    sp.restore()
  }
  const pm = pipelineMount()
  try {
    for (const [label, routePath] of [['run', PIPELINE_RUN_PATH], ['dry-run', PIPELINE_DRY_RUN_PATH]]) {
      const call = (req) => harness.call(pm.h.routes, 'POST', routePath, { params: { id: 'pipe_snapshot' }, ...req })
      pm.setRunner('ok')
      record(`pipeline ${label}: no principal`, await call({ body: {}, query: { tenantId: TENANT } }))
      record(`pipeline ${label}: reader`, await call({ user: INTEGRATION_READER, body: {}, query: { tenantId: TENANT } }))
      record(`pipeline ${label}: non-string cursor`, await call({ user: INTEGRATION_WRITER, body: { cursor: 7 }, query: { tenantId: TENANT } }))
      record(`pipeline ${label}: unknown mode`, await call({ user: INTEGRATION_WRITER, body: { mode: 'replay' }, query: { tenantId: TENANT } }))
      record(`pipeline ${label}: foreign tenant`, await call({ user: INTEGRATION_WRITER, body: {}, query: { tenantId: OTHER_TENANT } }))
      record(`pipeline ${label}: tenantless writer, no tenant`, await call({ user: TENANTLESS_WRITER, body: {}, query: {} }))
      pm.setRunner('throw')
      record(`pipeline ${label}: runner failure`, await call({ user: INTEGRATION_WRITER, body: {}, query: { tenantId: TENANT } }))
      pm.setRunner('ok')
      pm.runnerCalls.length = 0
      const ok = await call({ user: INTEGRATION_WRITER, body: { mode: 'full', cursor: 'c-1', sampleLimit: 5, tenantId: TENANT }, query: { tenantId: TENANT } })
      record(`pipeline ${label}: success`, ok, {
        runnerArgs: pm.runnerCalls.length === 1 ? pm.runnerCalls[0].length : -1,
        runnerInput: pm.runnerCalls.length === 1 ? JSON.stringify(pm.runnerCalls[0][0]) : null,
      })
    }
  } finally {
    pm.h.restore()
  }
  return out
}

// Captured by running `collectRouteSnapshots` on the pre-1b-i base (origin/main a8ab73bee), unchanged.
const EXPECTED_ROUTE_SNAPSHOTS = require('./fixtures/governed-entry-route-snapshots.json')

// ── tests ────────────────────────────────────────────────────────────────────────────────────────

const tests = [
  ['G-01 the checkpoint seam: null when neither is passed, TypeError when malformed, signal before and after the checkpoint, own hidden tags', async () => {
    assert.equal(checkpointSeam.normalizeGovernedEntryOptions(undefined), null)
    assert.equal(checkpointSeam.normalizeGovernedEntryOptions(null), null)
    assert.equal(checkpointSeam.normalizeGovernedEntryOptions({}), null)
    assert.equal(checkpointSeam.normalizeGovernedEntryOptions({ signal: null, checkpoint: undefined }), null)
    assert.throws(() => checkpointSeam.normalizeGovernedEntryOptions({ signal: {} }), TypeError)
    assert.throws(() => checkpointSeam.normalizeGovernedEntryOptions({ checkpoint: 'yes' }), TypeError)
    assert.throws(() => checkpointSeam.normalizeGovernedEntryOptions([]), TypeError)
    await checkpointSeam.passGovernedCheckpoint(null, 'read')

    const adapter = { async read() { return 'page' } }
    assert.equal(checkpointSeam.governSourceAdapterReads(adapter, null), adapter, 'ungoverned: the adapter itself, same identity')

    // Signal FIRST: an aborted signal refuses without ever calling the checkpoint.
    const aborted = new AbortController()
    aborted.abort()
    let checkpointCalls = 0
    const refusal = await rejection(checkpointSeam.passGovernedCheckpoint(
      checkpointSeam.normalizeGovernedEntryOptions({ signal: aborted.signal, checkpoint: async () => { checkpointCalls += 1 } }), 'read'))
    assertGovernedRefusal(refusal, 'read', 'aborted')
    assert.equal(checkpointCalls, 0, 'the checkpoint is not awaited once the signal has fired')

    // The checkpoint is AWAITED: a slow refusal still refuses.
    const slow = await rejection(checkpointSeam.passGovernedCheckpoint(
      checkpointSeam.normalizeGovernedEntryOptions({ checkpoint: () => new Promise((_, reject) => setTimeout(() => reject(new Error('fence is not ours')), 5)) }), 'plan'))
    assertGovernedRefusal(slow, 'plan', 'checkpoint_refused')
    assert.ok(!JSON.stringify(slow).includes('fence'), 'the checkpoint error is never serialized')

    // …and the signal is re-read after the checkpoint: an abort DURING the checkpoint refuses.
    const during = new AbortController()
    const late = await rejection(checkpointSeam.passGovernedCheckpoint(
      checkpointSeam.normalizeGovernedEntryOptions({ signal: during.signal, checkpoint: async () => { during.abort() } }), 'read'))
    assertGovernedRefusal(late, 'read', 'aborted')

    // tagGovernedFailure never replaces or breaks an error, never overwrites an own tag.
    const frozen = Object.freeze(new Error('frozen'))
    assert.equal(checkpointSeam.tagGovernedFailure(frozen, 'read'), frozen)
    const tagged = checkpointSeam.tagGovernedFailure(new TypeError('x'), 'load')
    assert.equal(tagged.failureStage, 'load')
    assert.equal(tagged.errorClass, 'TypeError')
    checkpointSeam.tagGovernedFailure(tagged, 'write', 'other')
    assert.equal(tagged.failureStage, 'load', 'an existing own tag is kept')
    assertOwnHiddenTags(tagged)
  }],

  ['G-02 T8 table action: aborted after page 1 => no page 2; a refusing checkpoint likewise; an aborted signal reads nothing; a refusal before planning reads no target rows', async () => {
    // Baseline: the ungoverned run reads more than one page (otherwise "no page 2" would be vacuous).
    const base = mountStockPrep()
    let baselineReads
    try {
      const result = await base.handlers.governedEntries.runGovernedStockPrepPull(pullerContext(), { actionId: PLM_STOCK_PREPARATION_ACTION_ID })
      assert.ok(result && typeof result.status === 'string' && result.counts, 'calibration: an ungoverned governed-entry dry run answers the route payload')
      baselineReads = base.source.calls.length
      assert.ok(baselineReads >= 2, `calibration: the synthetic BOM takes ${baselineReads} reads`)
    } finally {
      base.restore()
    }

    // Abort fires once page 1 has been read.
    const h1 = mountStockPrep()
    try {
      const controller = new AbortController()
      const read = h1.source.adapter.read.bind(h1.source.adapter)
      h1.source.adapter.read = async (input) => { const page = await read(input); controller.abort(); return page }
      const error = await rejection(h1.handlers.governedEntries.runGovernedStockPrepPull(pullerContext(), { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, { signal: controller.signal }))
      assertGovernedRefusal(error, 'read', 'aborted')
      assert.equal(h1.source.calls.length, 1, 'page 1 was read, page 2 never was')
    } finally {
      h1.restore()
    }

    // A checkpoint that refuses its third call (1 = before the source read, 2 = before page 1, 3 = before page 2).
    const h2 = mountStockPrep()
    try {
      const stages = []
      const checkpoint = async ({ stage }) => { stages.push(stage); if (stages.length >= 3) throw new Error('the job fence moved on') }
      const error = await rejection(h2.handlers.governedEntries.runGovernedStockPrepPull(pullerContext(), { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, { checkpoint }))
      assertGovernedRefusal(error, 'read', 'checkpoint_refused')
      assert.deepEqual(stages, ['read', 'read', 'read'], 'awaited before the source read and before each page')
      assert.equal(h2.source.calls.length, 1, 'the refused page was never read')
    } finally {
      h2.restore()
    }

    // An already-aborted signal: nothing is read and the checkpoint is never called.
    const h3 = mountStockPrep()
    try {
      const controller = new AbortController()
      controller.abort()
      let calls = 0
      const error = await rejection(h3.handlers.governedEntries.runGovernedStockPrepPull(pullerContext(), { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, { signal: controller.signal, checkpoint: async () => { calls += 1 } }))
      assertGovernedRefusal(error, 'read', 'aborted')
      assert.equal(calls, 0)
      assert.equal(h3.source.calls.length, 0, 'no source read at all')
    } finally {
      h3.restore()
    }

    // Before planning: every page read, then the refusal — the target sheet is never read.
    const h4 = mountStockPrep()
    try {
      const stages = []
      const checkpoint = async ({ stage }) => { stages.push(stage); if (stage === 'plan') throw new Error('stop before planning') }
      h4.records.calls.length = 0
      const error = await rejection(h4.handlers.governedEntries.runGovernedStockPrepPull(pullerContext(), { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, { checkpoint }))
      assertGovernedRefusal(error, 'plan', 'checkpoint_refused')
      assert.equal(h4.source.calls.length, baselineReads, 'the whole source read ran')
      assert.equal(stages.filter((stage) => stage === 'read').length, baselineReads + 1, 'one check before the source read, one per page')
      assert.equal(stages[stages.length - 1], 'plan')
      assert.deepEqual(h4.records.calls.filter(([method]) => method === 'queryRecords'), [], 'no target-sheet read: planning never started')
    } finally {
      h4.restore()
    }

    // The governed entry runs the HTTP route's own gate: a floor operator is refused before any read.
    const h5 = mountStockPrep()
    try {
      const error = await rejection(h5.handlers.governedEntries.runGovernedStockPrepPull(pullerContext({ user: FLOOR }), { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, { checkpoint: async () => {} }))
      assert.equal(error.status, 403)
      assert.equal(h5.source.calls.length, 0)
    } finally {
      h5.restore()
    }
  }],

  ['G-03 T8 pipeline runner: aborted after page 1 => no page 2, run closed failed, own failureStage/errorClass, details unchanged; refusing checkpoint; write stage; no signal = every page', async () => {
    const plain = mountRunner()
    const plainResult = await plain.runner.runPipeline(runnerInput({ dryRun: true }))
    assert.deepEqual(plain.reads, [1, 2, 3], 'calibration: three pages without a signal')
    assert.equal(plainResult.run.status, 'succeeded')

    const controller = new AbortController()
    const aborted = mountRunner({ onRead: (page) => { if (page === 1) controller.abort() } })
    const watched = await rejection(aborted.runner.runPipeline(runnerInput({ dryRun: true }), { signal: controller.signal }))
    assert.ok(watched instanceof PipelineRunnerError)
    assert.equal(watched.message, 'pipeline run failed')
    assert.deepEqual(Object.keys(watched.details).sort(), ['cause', 'run'], 'details keep exactly { run, cause }')
    assert.equal(watched.failureStage, 'read')
    assert.equal(watched.errorClass, 'aborted')
    assertOwnHiddenTags(watched)
    assert.deepEqual(aborted.reads, [1], 'page 2 was never read')
    assert.equal(aborted.runs[0].status, 'failed', 'the run row is closed failed')

    const refused = mountRunner()
    let checks = 0
    const refusedError = await rejection(refused.runner.runPipeline(runnerInput({ dryRun: true }), { checkpoint: async () => { checks += 1; if (checks === 2) throw new Error('lease lost') } }))
    assert.equal(refusedError.failureStage, 'read')
    assert.equal(refusedError.errorClass, 'checkpoint_refused')
    assert.deepEqual(refused.reads, [1])
    assert.equal(refusedError.details.cause, 'the governed run checkpoint refused its next call', 'the cause is the governed message, never the checkpoint error')

    const writeFailure = mountRunner({ targetUpsert: async () => { throw new RangeError('synthetic target refused') } })
    const writeError = await rejection(writeFailure.runner.runPipeline(runnerInput()))
    assert.equal(writeError.failureStage, 'write')
    assert.equal(writeError.errorClass, 'RangeError')
    assertOwnHiddenTags(writeError)

    // An error before the run row exists (an inactive pipeline refused while loading) says where it stopped too.
    const inactive = mountRunner({ pipelineStatus: 'paused' })
    const loadError = await rejection(inactive.runner.runPipeline(runnerInput({ dryRun: true })))
    assert.equal(loadError.message, 'pipeline is not active')
    assert.equal(loadError.failureStage, 'load')
    assert.equal(loadError.errorClass, 'PipelineRunnerError')
    assertOwnHiddenTags(loadError)
    assert.deepEqual(inactive.reads, [])
  }],

  ['G-04 runGovernedPipeline: the exact runner input, a second argument only when governed, triggeredBy api | automation only', async () => {
    const pm = pipelineMount()
    try {
      const handlers = httpRoutes.createHandlers(pm.h.services, { context: pm.h.context, logger: silentLogger })
      const { runGovernedPipeline } = handlers.governedEntries
      assert.equal(Object.keys(handlers).includes('governedEntries'), false, 'not an enumerable handler (route registration never sees it)')
      const context = { user: INTEGRATION_WRITER, query: { tenantId: TENANT }, params: {}, body: {} }
      await runGovernedPipeline(context, { pipelineId: 'pipe_snapshot', dryRun: true })
      assert.equal(pm.runnerCalls[0].length, 1, 'ungoverned: one argument, as before 1b-i')
      const controller = new AbortController()
      await runGovernedPipeline(context, { pipelineId: 'pipe_snapshot', dryRun: true, triggeredBy: 'automation' }, { signal: controller.signal })
      assert.equal(pm.runnerCalls[1].length, 2)
      assert.equal(pm.runnerCalls[1][1].signal, controller.signal)
      assert.equal(pm.runnerCalls[1][0].triggeredBy, 'automation')
      assert.equal(pm.runnerCalls[1][0].dryRun, true)
      await assert.rejects(() => runGovernedPipeline(context, { pipelineId: 'pipe_snapshot', dryRun: true, triggeredBy: 'cron' }), TypeError)
      await assert.rejects(() => runGovernedPipeline(context, { pipelineId: 'pipe_snapshot', dryRun: true }, { signal: 'stop' }), TypeError)
      // The same gate as the route: a reader is refused before the runner.
      const before = pm.runnerCalls.length
      const refused = await rejection(runGovernedPipeline({ ...context, user: INTEGRATION_READER }, { pipelineId: 'pipe_snapshot', dryRun: true }, { checkpoint: async () => {} }))
      assert.equal(refused.status, 403)
      assert.equal(pm.runnerCalls.length, before)
    } finally {
      pm.h.restore()
    }
  }],

  ['G-05 byte-identical HTTP: every failure path and the pipeline success path answer exactly what the pre-1b-i base answered', async () => {
    const actual = await collectRouteSnapshots()
    assert.ok(EXPECTED_ROUTE_SNAPSHOTS.length >= 25, 'calibration: the captured set is the full list')
    assert.deepEqual(actual.map((entry) => entry.name), EXPECTED_ROUTE_SNAPSHOTS.map((entry) => entry.name), 'same cases, same order')
    for (let index = 0; index < actual.length; index += 1) {
      assert.deepEqual(actual[index], EXPECTED_ROUTE_SNAPSHOTS[index], `byte-identical: ${actual[index].name}`)
    }
    // Calibration: the set is not all one answer.
    assert.ok(new Set(actual.map((entry) => entry.status)).size >= 4, 'several distinct statuses are covered')
  }],

  ['G-06 the principal context carries exactly the request fields http-routes.cjs reads, by reference, and nothing else', () => {
    const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
    const read = new Set([...source.matchAll(/\breq\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((match) => match[1]))
    const { GOVERNED_PRINCIPAL_CONTEXT_FIELDS, governedPrincipalContextFromRequest } = httpRoutes.__internals
    assert.deepEqual([...read].sort(), [...GOVERNED_PRINCIPAL_CONTEXT_FIELDS].sort(), 'every req.<field> the file reads is carried, and only those')
    assert.equal((source.match(/\breq\[/g) || []).length, 1, 'the only computed request read is the context builder')
    const req = {
      user: { id: 'u' }, authUser: { id: 'a' }, authenticatedTenantId: 't', query: { q: 1 }, params: { p: 1 }, body: { b: 1 },
      headers: { 'x-tenant-id': 't' }, socket: {}, method: 'POST', get() { return 'x' },
    }
    const context = governedPrincipalContextFromRequest(req)
    assert.deepEqual(Object.keys(context).sort(), [...GOVERNED_PRINCIPAL_CONTEXT_FIELDS].sort())
    for (const field of GOVERNED_PRINCIPAL_CONTEXT_FIELDS) assert.equal(context[field], req[field], `${field} is the same reference`)
    assert.equal(context.headers, undefined, 'no header rides along')
  }],

  ['G-07 VALID_TRIGGERS gained automation (word only)', () => {
    assert.deepEqual([...pipelines.__internals.VALID_TRIGGERS].sort(), ['api', 'automation', 'cron', 'manual', 'replay'])
  }],
]

if (require.main === module) {
  runFailClosedSuite('governed-entry-abort-checkpoints.test.cjs', tests, { passLine: 'governed-entry-abort-checkpoints.test.cjs OK' })
}

module.exports = { collectRouteSnapshots }
