'use strict'

// R-69 1b-ii — the plugin's IntegrationRunPort (lib/integration-run-port.cjs) and its registration with the host
// (index.cjs activate / deactivate). Synthetic only; no host, no PLM, no DingTalk / YiDa. R-69 is OPEN.
//
//   P-01 registration: activate() registers the port with `services.integrationRun` ONLY when the host offers
//        it, built from the governed entries registerIntegrationRoutes returns (non-enumerable on the route
//        array: the spread stays a plain route list); deactivate() calls the unbind; no capability => no call.
//   P-02 one chain, two callers: run({ kind: stock_prep_pull }) calls runGovernedStockPrepPull with the SAME
//        context object, `{ actionId }` and `{ signal, checkpoint }` passed through untouched (no runAs, no
//        write-lifecycle marker, no tenant, nothing added); kind pipeline => runGovernedPipeline with
//        dryRun:true and triggeredBy 'automation' ALWAYS; no signal / checkpoint => an empty third argument.
//   P-03 values-free summary: the dry-run payload's statuses map to the ADR vocabulary; `missingComponents`,
//        `dryRunToken`, `revision` and `evidence` never leave; counts keep integers only.
//   P-04 refusals: 401/403 => skipped(principal_unauthorized); PROJECT_ABSENT / ARCHIVED => held; other
//        HttpRouteError => failed(errorClass = code); an abort or a lease-lost checkpoint rejection is RETHROWN.
//   P-05 a REAL GovernedEntryAbortError (lib/governed-entry-checkpoint.cjs) thrown by the REAL
//        runGovernedStockPrepPull (the I2 project-sheet harness: real routes, fake host / PLM) is RETHROWN as the
//        same instance — the host's signal firing after page 1, and the host's checkpoint refusing page 2 (its
//        rejection travelling as `cause`); the ungoverned run over the same entry still summarizes.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const { createIntegrationRunPort, __internals } = require(path.join(LIB, 'integration-run-port.cjs'))
const { HttpRouteError } = require(path.join(LIB, 'http-routes.cjs'))
const { runFailClosedSuite } = require('./support/fail-closed-suite-runner.cjs')

const ENTRY_PATH = path.join(__dirname, '..', 'index.cjs')
const ROUTES_PATH = path.join(LIB, 'http-routes.cjs')

function fakeEntries() {
  const calls = { pull: [], pipeline: [] }
  return {
    calls,
    governedEntries: Object.freeze({
      async runGovernedStockPrepPull(context, job, options) {
        calls.pull.push({ context, job, options })
        return { status: 'ready', canApply: true, counts: { add: 3, update: 1, skip: 0 }, revision: 'r9', dryRunToken: 'tok', missingComponents: { distinctCount: 2, items: ['PART-1'] }, evidence: { x: 1 } }
      },
      async runGovernedPipeline(context, job, options) {
        calls.pipeline.push({ context, job, options })
        return { runId: 'run_1', status: 'succeeded', metrics: { rowsRead: 5, rowsCleaned: 5, rowsWritten: 0, rowsFailed: 0 } }
      },
    }),
  }
}

function mockContext({ integrationRun } = {}) {
  const registered = []
  return {
    context: {
      api: {
        http: { addRoute: () => {} },
        database: { async query() { return [] } },
      },
      communication: { register: () => {}, call: async () => { throw new Error('no') }, on: () => {}, emit: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      services: {
        security: {
          async encrypt(value) { return `enc:${value}` },
          async decrypt(value) { return value.slice(4) },
          async hash(value) { return `hash:${value}` },
        },
        ...(integrationRun ? { integrationRun } : {}),
      },
    },
    registered,
  }
}

const tests = [
  ['P-01 activate registers the port from the governed entries the route registration returns; deactivate unbinds; no capability => no registration', async () => {
    const routesModule = require(ROUTES_PATH)
    const originalRegister = routesModule.registerIntegrationRoutes
    const returned = []
    routesModule.registerIntegrationRoutes = function spy() {
      const result = originalRegister.apply(this, arguments)
      returned.push(result)
      return result
    }
    delete require.cache[require.resolve(ENTRY_PATH)]
    try {
      const entry = require(ENTRY_PATH)
      const ports = []
      let unbound = 0
      const { context } = mockContext({ integrationRun: { register: (port) => { ports.push(port); return () => { unbound += 1 } } } })
      await entry.activate(context)
      assert.equal(returned.length, 1, 'routes registered once')
      const routeList = returned[0]
      assert.ok(Array.isArray(routeList), 'registerIntegrationRoutes still returns the route array')
      assert.equal(Object.keys(routeList).includes('governedEntries'), false, 'governedEntries is NOT enumerable (the spread stays a route list)')
      assert.equal(typeof routeList.governedEntries.runGovernedStockPrepPull, 'function')
      assert.equal(typeof routeList.governedEntries.runGovernedPipeline, 'function')
      assert.equal(ports.length, 1, 'exactly one port registered')
      assert.equal(typeof ports[0].run, 'function')
      assert.equal(Object.isFrozen(ports[0]), true)
      await entry.deactivate()
      assert.equal(unbound, 1, 'deactivate called the unbind once')
      // A host that does not offer the capability (every plugin but this one): nothing is registered, no throw.
      const { context: bare } = mockContext()
      await entry.activate(bare)
      await entry.deactivate()
      assert.equal(ports.length, 1)
    } finally {
      routesModule.registerIntegrationRoutes = originalRegister
      delete require.cache[require.resolve(ENTRY_PATH)]
    }
  }],

  ['P-02 one chain, two callers: the port forwards the SAME context, the job selector and exactly the signal / checkpoint it was given', async () => {
    const { calls, governedEntries } = fakeEntries()
    const port = createIntegrationRunPort({ governedEntries })
    const context = { user: { id: 'u1', permissions: ['integration:read'], roles: [], role: 'user', tenantId: 't1' }, authUser: null, authenticatedTenantId: 't1', query: {}, params: {}, body: { parameters: { projectNo: 'P-1' } } }
    const controller = new AbortController()
    const checkpoint = async () => {}
    const summary = await port.run({ context, job: { kind: 'stock_prep_pull', projectNo: 'P-1' }, signal: controller.signal, checkpoint, automation: { ruleId: 'r', executionId: 'e', rootExecutionId: 'e' } })
    assert.equal(calls.pull.length, 1)
    assert.equal(calls.pull[0].context, context, 'the SAME context object, never a copy or a widened one')
    assert.deepEqual(Object.keys(calls.pull[0].context).sort(), ['authUser', 'authenticatedTenantId', 'body', 'params', 'query', 'user'], 'no field added')
    assert.equal(calls.pull[0].context.runAs, undefined)
    assert.deepEqual(calls.pull[0].job, { actionId: __internals.DEFAULT_STOCK_PREP_ACTION_ID })
    assert.deepEqual(Object.keys(calls.pull[0].options).sort(), ['checkpoint', 'signal'])
    assert.equal(calls.pull[0].options.signal, controller.signal)
    assert.equal(calls.pull[0].options.checkpoint, checkpoint)
    assert.deepEqual(summary, { status: 'succeeded', reason: 'ready', canApply: true, counts: { add: 3, update: 1, skip: 0 }, durationMs: summary.durationMs })
    // a configured actionId is forwarded; no signal / checkpoint => an EMPTY options object (ungoverned behaviour)
    await port.run({ context, job: { kind: 'stock_prep_pull', projectNo: 'P-1', actionId: 'custom.action.v1' }, automation: {} })
    assert.deepEqual(calls.pull[1].job, { actionId: 'custom.action.v1' })
    assert.deepEqual(calls.pull[1].options, {})
    // pipeline: ALWAYS dryRun:true, triggeredBy 'automation', nothing else
    const pipeline = await port.run({ context, job: { kind: 'pipeline', pipelineId: 'pipe_1', dryRun: false }, signal: controller.signal, checkpoint, automation: {} })
    assert.deepEqual(calls.pipeline[0].job, { pipelineId: 'pipe_1', dryRun: true, triggeredBy: 'automation' })
    assert.equal(calls.pipeline[0].options.signal, controller.signal)
    assert.deepEqual(pipeline, { status: 'succeeded', runId: 'run_1', counts: { read: 5, cleaned: 5, written: 0, failed: 0 }, durationMs: pipeline.durationMs })
    await assert.rejects(port.run({ context, job: { kind: 'apply' }, automation: {} }), TypeError)
    await assert.rejects(port.run({ job: { kind: 'stock_prep_pull' } }), TypeError)
    assert.throws(() => createIntegrationRunPort({ governedEntries: { runGovernedStockPrepPull() {} } }), TypeError)
  }],

  ['P-03 values-free summary: every dry-run status maps to the ADR vocabulary and nothing value-bearing leaves', () => {
    const { summarizeStockPrepDryRun, summarizePipelineRun } = __internals
    const t0 = Date.now()
    const ready = summarizeStockPrepDryRun({ status: 'ready', canApply: false, counts: { add: 1, bogus: 1.5, nested: { a: 1 } }, missingComponents: { distinctCount: 3, items: ['PART-X'] }, dryRunToken: 'secret', revision: 'r1', evidence: {} }, t0)
    assert.deepEqual(Object.keys(ready).sort(), ['canApply', 'counts', 'durationMs', 'reason', 'status'])
    assert.deepEqual(ready.counts, { add: 1 })
    assert.equal(JSON.stringify(ready).includes('PART-X'), false)
    assert.equal(JSON.stringify(ready).includes('secret'), false)
    for (const status of ['manual_confirm_required', 'suspended', 'large_bom_bounded']) {
      const held = summarizeStockPrepDryRun({ status, canApply: true, counts: { add: 2 } }, t0)
      assert.equal(held.status, 'held', status)
      assert.equal(held.reason, status)
      assert.equal(held.canApply, false, 'a held preview is never applicable')
    }
    // Same race as P-04: call once and assert on the stored result.
    const recoveryPending = summarizeStockPrepDryRun({ status: 'recovery_pending' }, t0)
    assert.equal(typeof recoveryPending.durationMs, 'number')
    assert.deepEqual(recoveryPending, { status: 'failed', errorClass: 'STOCK_PREP_REFRESH_RECOVERY_PENDING', failureStage: 'read', durationMs: recoveryPending.durationMs })
    assert.equal(summarizeStockPrepDryRun({ status: 'something_new' }, t0).errorClass, 'unexpected_dry_run_status')
    assert.equal(summarizeStockPrepDryRun(null, t0).status, 'failed')
    const partial = summarizePipelineRun({ runId: 'run_2', status: 'partial', metrics: { rowsRead: 3, rowsFailed: 1 } }, t0)
    assert.equal(partial.status, 'partial')
    assert.deepEqual(partial.counts, { read: 3, failed: 1 })
    assert.equal(summarizePipelineRun({ status: 'failed' }, t0).status, 'failed')
    assert.equal(summarizePipelineRun({ status: 'failed' }, t0).errorClass, 'failed')
  }],

  ['P-04 refusals: 401/403 => skipped(principal_unauthorized); PROJECT_ABSENT / ARCHIVED => held; other HttpRouteError => failed(code); aborts and lease-lost rejections are rethrown', async () => {
    const { classifyRefusal } = __internals
    const t0 = Date.now()
    // One call, then assert on the stored result: a second call can land a millisecond later (durationMs 0 vs 1).
    const forbidden = classifyRefusal(new HttpRouteError(403, 'FORBIDDEN', 'Insufficient integration permissions'), t0)
    assert.equal(typeof forbidden.durationMs, 'number')
    assert.deepEqual(forbidden, { status: 'skipped', reason: 'principal_unauthorized', errorClass: 'FORBIDDEN', durationMs: forbidden.durationMs })
    assert.equal(classifyRefusal(new HttpRouteError(401, 'UNAUTHENTICATED', 'x'), t0).reason, 'principal_unauthorized')
    assert.equal(classifyRefusal(new HttpRouteError(409, 'STOCK_PREPARATION_PROJECT_ABSENT', 'x'), t0).status, 'held')
    assert.equal(classifyRefusal(new HttpRouteError(409, 'STOCK_PREPARATION_PROJECT_ABSENT', 'x'), t0).reason, 'project_absent')
    assert.equal(classifyRefusal(new HttpRouteError(404, 'STOCK_PREPARATION_PROJECT_ABSENT', 'x'), t0).reason, 'project_absent')
    assert.equal(classifyRefusal(new HttpRouteError(409, 'STOCK_PREPARATION_PROJECT_ARCHIVED', 'x'), t0).reason, 'project_archived')
    const other = classifyRefusal(new HttpRouteError(503, 'B2A_AUTHORITY_UNAVAILABLE', 'the message body must not leak'), t0)
    assert.deepEqual(other, { status: 'failed', errorClass: 'B2A_AUTHORITY_UNAVAILABLE', failureStage: 'authorize', durationMs: other.durationMs })
    assert.equal(JSON.stringify(other).includes('message body'), false)
    const plain = classifyRefusal(Object.assign(new Error('boom with values'), { code: 'ECONNRESET', failureStage: 'read' }), t0)
    assert.deepEqual(plain, { status: 'failed', errorClass: 'ECONNRESET', failureStage: 'read', durationMs: plain.durationMs })
    assert.equal(classifyRefusal(new TypeError('x'), t0).errorClass, 'TypeError')
    // through the port: a governed entry that throws the signal's reason (abort) or a lease-lost checkpoint rejection propagates
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const lostErr = Object.assign(new Error('lost'), { name: 'JobLeaseLostError', code: 'JOB_LEASE_LOST' })
    for (const error of [abortErr, lostErr]) {
      const port = createIntegrationRunPort({ governedEntries: { async runGovernedStockPrepPull() { throw error }, async runGovernedPipeline() { throw error } } })
      await assert.rejects(port.run({ context: {}, job: { kind: 'stock_prep_pull', projectNo: 'P' }, automation: {} }), (e) => e === error)
    }
    const refusing = createIntegrationRunPort({ governedEntries: { async runGovernedStockPrepPull() { throw new HttpRouteError(403, 'FORBIDDEN', 'x') }, async runGovernedPipeline() {} } })
    assert.equal((await refusing.run({ context: {}, job: { kind: 'stock_prep_pull', projectNo: 'P' }, automation: {} })).reason, 'principal_unauthorized')
  }],

  ['P-05 a REAL GovernedEntryAbortError from the REAL governed entry is rethrown as the same instance: the signal after page 1 (aborted) and a refusing checkpoint at page 2 (checkpoint_refused, host error as cause); the ungoverned run still summarizes', async () => {
    const checkpointSeam = require(path.join(LIB, 'governed-entry-checkpoint.cjs'))
    const httpRoutes = require(ROUTES_PATH)
    const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
    const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
    const TENANT = 'tenant-r69-port'
    const PROJECT = 'PRJ-R69-PORT'
    const silent = Object.freeze({ info() {}, warn() {}, error() {} })
    const puller = Object.freeze({ id: 'u_r69_port_pull', permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL], roles: [], role: 'user', tenantId: TENANT })
    // The context exactly as core's buildIntegrationRunPrincipalContext shapes it: six fields, no request.
    const coreContext = () => ({ user: puller, authUser: puller, authenticatedTenantId: TENANT, query: {}, params: {}, body: { parameters: { projectNo: PROJECT } } })
    const job = { kind: 'stock_prep_pull', projectNo: PROJECT }
    const automation = { ruleId: 'r', executionId: 'e', rootExecutionId: 'e' }
    const mount = () => {
      const h = harness.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, logger: silent })
      h.seedRegistryRow(PROJECT)
      h.handlers = httpRoutes.createHandlers(h.services, { context: h.context, logger: silent })
      return h
    }
    const rejectionOf = async (promise) => {
      try { await promise } catch (error) { return error }
      assert.fail('expected the port to rethrow the governed refusal, it resolved instead')
      return null
    }

    // Calibration: the same real entry, ungoverned, reads more than one page and summarizes (so "no page 2" below is not vacuous).
    const base = mount()
    let baselineReads
    try {
      const summary = await createIntegrationRunPort({ governedEntries: base.handlers.governedEntries }).run({ context: coreContext(), job, automation })
      assert.ok(['succeeded', 'held'].includes(summary.status), `a real dry run summarizes to the ADR vocabulary, got ${summary.status}`)
      baselineReads = base.source.calls.length
      assert.ok(baselineReads >= 2, `calibration: the synthetic BOM takes ${baselineReads} reads`)
    } finally {
      base.restore()
    }

    // The host's signal fires once page 1 has been read ⇒ the entry throws its own GovernedEntryAbortError (aborted); the port rethrows THAT instance.
    const h1 = mount()
    try {
      const port = createIntegrationRunPort({ governedEntries: h1.handlers.governedEntries })
      const controller = new AbortController()
      const read = h1.source.adapter.read.bind(h1.source.adapter)
      h1.source.adapter.read = async (input) => { const page = await read(input); controller.abort(Object.assign(new Error('shutdown'), { name: 'AbortError' })); return page }
      const error = await rejectionOf(port.run({ context: coreContext(), job, signal: controller.signal, checkpoint: async () => {}, automation }))
      assert.ok(error instanceof checkpointSeam.GovernedEntryAbortError, `rethrown as the governed refusal itself, got ${error && error.name}`)
      assert.equal(error.code, checkpointSeam.GOVERNED_ENTRY_ABORTED_CODE)
      assert.equal(error.errorClass, 'aborted')
      assert.equal(error.failureStage, 'read')
      assert.equal(h1.source.calls.length, 1, 'page 1 was read, page 2 never was')
    } finally {
      h1.restore()
    }

    // The host's checkpoint refuses page 2 (the job fence is no longer ours) ⇒ GovernedEntryAbortError (checkpoint_refused) wrapping the host's rejection as `cause`; rethrown as-is.
    const h2 = mount()
    try {
      const port = createIntegrationRunPort({ governedEntries: h2.handlers.governedEntries })
      const lost = Object.assign(new Error('lost'), { name: 'JobLeaseLostError', code: 'JOB_LEASE_LOST', stage: 'verify' })
      let checkpoints = 0
      const checkpoint = async () => { checkpoints += 1; if (checkpoints >= 3) throw lost } // 1 = before the source read, 2 = page 1, 3 = page 2
      const error = await rejectionOf(port.run({ context: coreContext(), job, signal: new AbortController().signal, checkpoint, automation }))
      assert.ok(error instanceof checkpointSeam.GovernedEntryAbortError, `rethrown as the governed refusal itself, got ${error && error.name}`)
      assert.equal(error.errorClass, 'checkpoint_refused')
      assert.equal(error.failureStage, 'read')
      assert.equal(error.cause, lost, 'the host’s own rejection travels as the cause (in-process only, non-enumerable)')
      assert.equal(h2.source.calls.length, 1, 'the refused page was never read')
      assert.equal(checkpoints, 3)
    } finally {
      h2.restore()
    }
  }],
]

if (require.main === module) {
  runFailClosedSuite('integration-run-port.test.cjs', tests, { passLine: 'integration-run-port.test.cjs OK' })
}
