'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createStockPreparationReadPlanStore, VERSION_TABLE, ACTIVATION_TABLE, AUDIT_TABLE, VALIDATION_TABLE } = require('../lib/stock-preparation-read-plan-store.cjs')
const { SOURCE_REVISION_TABLE } = require('../lib/stock-preparation-read-plan-validation-ledger.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require('../lib/stock-preparation-templates.cjs')
const { createStockPreparationTableActionRegistry } = require('../lib/stock-preparation-table-actions.cjs')
const { resolveStockPreparationReadPlanExecution } = require('../lib/stock-preparation-read-plan-runtime.cjs')
const { createStockPreparationProjectTargetStore, PROJECT_TARGET_TABLE } = require('../lib/stock-preparation-project-target-store.cjs')
const { deriveProjectSheetObjectId, PROJECT_SHEETS_ENABLED_ENV } = require('../lib/stock-preparation-project-targets.cjs')
const { consumableMap } = require('./support/consumable-storage.cjs')
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')

// Only the module-local environment is synthetic. No process.env assignment,
// .env read, network call, customer endpoint or persistent file write occurs.
const routePath = require.resolve('../lib/http-routes.cjs')
const routeSource = fs.readFileSync(routePath, 'utf8')
function loadRoutes(transform = (source) => source, dependencies = {}, extraEnv = {}) {
  const routeModule = new Module(routePath, module)
  routeModule.filename = routePath
  routeModule.paths = Module._nodeModulePaths(path.dirname(routePath))
  const originalRequire = routeModule.require.bind(routeModule)
  routeModule.require = (specifier) => dependencies[specifier] || originalRequire(specifier)
  const env = { MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED: 'true', ...extraEnv }
  routeModule._compile(`const process = { env: ${JSON.stringify(env)} };\n${transform(routeSource)}`, routePath)
  return routeModule.exports
}
function loadActionModule(transform) {
  const filename = require.resolve('../lib/stock-preparation-table-actions.cjs')
  const copy = new Module(filename, module)
  copy.filename = filename
  copy.paths = Module._nodeModulePaths(path.dirname(filename))
  copy._compile(transform(fs.readFileSync(filename, 'utf8')), filename)
  return copy.exports
}
function withoutSnapshotRuntimeRechecks() {
  const filename = require.resolve('../lib/stock-preparation-read-plan-runtime.cjs')
  const copy = new Module(filename, module)
  copy.filename = filename
  copy.paths = Module._nodeModulePaths(path.dirname(filename))
  const source = fs.readFileSync(filename, 'utf8').replaceAll('\r\n', '\n')
  const generation = `    ...(snapshotAction && snapshotAction.readPlanExecutionIdentity
      ? { expectedGeneration: snapshotAction.readPlanExecutionIdentity.generation } : {}),`
  const contract = '  if (snapshotAction) assertLargeBomActionExecutionContract(effective, snapshotAction)'
  for (const needle of [generation, contract]) {
    assert.equal(source.split(needle).length - 1, 1, 'snapshot runtime mutation must have one real seam')
  }
  copy._compile(source.replace(generation, '').replace(contract, ''), filename)
  return copy.exports
}
const { registerIntegrationRoutes } = loadRoutes()

const ACTION = 'plm.stock-preparation.pull-bom.v1'
const TENANT = 'tenant-synthetic'
const SYSTEM = 'system-synthetic'
const CONNECTION_ID = 'synthetic-connection'
const BINDING_REVISION = '11111111-1111-4111-8111-111111111111'
const CONNECTION_REVISION = '22222222-2222-4222-8222-222222222222'
const STALE_BINDING_REVISION = '99999999-9999-4999-8999-999999999999'
const STATUS_FIXTURE_COUNTS = Object.freeze({ sampleCount: 2, readCount: 10, objectCount: 7 })
const SCOPE = { tenantId: TENANT, workspaceId: null }
const clone = (value) => structuredClone(value)
const PARAMS = { projectNo: 'SYN-PROJECT' }
const USER = { id: 'synthetic-owner', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] }
const BASE = '/api/integration/table-actions/:actionId'
const JOBS = `${BASE}/large-bom/expansion-jobs`
const PREFLIGHT = '/api/integration/stock-preparation/source-preflight'
// Deploy-only readPlan blocks SA02 v1 cannot express (same fixture as the
// management/bootstrap suites); tests self-check that the real normalizer keeps them.
const DEPLOY_DECLARATIONS = Object.freeze({
  projectSubtree: { pathInfo: { parentIdField: 'parent' }, bomHead: { pathIdField: 'path' } },
  batchIdentity: { mode: 'material_create_hour' },
})

function config(readPlanExtra = {}) {
  return {
    schemaVersion: 1, actionId: ACTION, systemId: SYSTEM,
    readPlan: {
      id: 'plm.stock-preparation.bom-read.user-draft.v1', sourceKind: 'data-source:sql-readonly', matchField: 'project', maxReadCount: 100,
      pathExAttr: { object: 'SYN_PathLink', matchField: 'project', pathIdField: 'path' },
      pathInfo: { object: 'SYN_Path', idField: 'id' },
      orderHead: { object: 'SYN_Order', idField: 'id', pathIdField: 'path' },
      orderDetail: { object: 'SYN_OrderLine', orderIdField: 'order', componentIdField: 'part', quantityField: 'qty' },
      part: { object: 'SYN_Part', idField: 'id', codeField: 'code', nameField: 'name' },
      bomHead: { object: 'SYN_Bom', parentPartField: 'part', bomIdField: 'id' },
      bomDetail: { object: 'SYN_BomLine', bomParentField: 'bom', componentIdField: 'part', quantityField: 'qty' },
      ...readPlanExtra,
    },
  }
}

function memoryDb() {
  const state = {
    [VERSION_TABLE]: [], [ACTIVATION_TABLE]: [], [AUDIT_TABLE]: [], [VALIDATION_TABLE]: [],
    [PROJECT_TARGET_TABLE]: [],
    [SOURCE_REVISION_TABLE]: [{ data_source_id: CONNECTION_ID, validation_revision: CONNECTION_REVISION,
      tenant_id: TENANT, workspace_id: null, owner_id: USER.id, scope_kind: 'private',
      type: 'postgresql', is_active: true, deleted_at: null }],
    integration_external_systems: [{ id: SYSTEM, tenant_id: TENANT, workspace_id: null,
      kind: 'data-source:sql-readonly', status: 'active', role: 'source',
      connection_id: CONNECTION_ID, validation_revision: BINDING_REVISION }],
  }
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const db = {
    async selectOne(table, where) { return clone(state[table].find((row) => matches(row, where)) || null) },
    async selectOneForUpdate(table, where) { return db.selectOne(table, where) },
    async selectOneForKeyShare(table, where) { return db.selectOne(table, where) },
    async select(table, { where = {}, orderBy, limit = 1000, offset = 0 } = {}) {
      const rows = state[table].filter((row) => matches(row, where))
      if (orderBy) rows.sort((a, b) => (a[orderBy[0]] - b[orderBy[0]]) * (orderBy[1] === 'DESC' ? -1 : 1))
      return clone(rows.slice(offset, offset + limit))
    },
    async insertOne(table, row) { state[table].push(clone(row)); return [clone(row)] },
    async updateRow(table, patch, where) {
      const row = state[table].find((candidate) => matches(candidate, where))
      if (!row) return []
      Object.assign(row, clone(patch)); return [clone(row)]
    },
    async transaction(callback) { return callback(db) },
    async advisoryXactLock() {},
    async countRows(table, where) { return state[table].filter((row) => matches(row, where)).length },
    async setTransactionIsolationLevel() {},
  }
  return { db, state }
}

const inert = (methods) => Object.fromEntries(methods.map((name) => [name, async () => { throw new Error(`unexpected synthetic call: ${name}`) }]))

async function mount({ active = true, storeMissing = false, sourceWorkspaceId = null, matchedWorkspaceId = null, register = registerIntegrationRoutes, unconfigured = false, projectSheets = false, deployReadPlan,
  readPlanExtra, sourceProject, sourceCaseInsensitive = false, projectRegistry, routeTransform, routeDependencies } = {}) {
  const { db, state } = memoryDb()
  let sequence = 0
  const ledger = createStockPreparationReadPlanStore({ db, idGenerator: () => `synthetic-${++sequence}` })
  let version
  if (active) {
    version = await ledger.saveVersion({ ...SCOPE, actor: USER.id, config: config(readPlanExtra) })
    // Synthetic status fixture, NOT source-validation proof. The real store still
    // returns sourceValidation only when this confirmed receipt matches the current revision.
    const source = { connectionId: CONNECTION_ID, connectionRevision: CONNECTION_REVISION }
    const validationInput = { ...SCOPE, actor: USER.id, id: version.id, source }
    const begun = await ledger.beginValidation(validationInput)
    await ledger.finishValidation({ ...validationInput, validationId: begun.validationId, counts: STATUS_FIXTURE_COUNTS })
    await ledger.confirmValidation({ ...validationInput, validationId: begun.validationId })
    await ledger.approve({ ...SCOPE, actor: USER.id, id: version.id })
    await ledger.activate({ ...SCOPE, actor: USER.id, id: version.id, expectedGeneration: 0 })
  }
  const calls = { binding: [], ledger: [], adapter: [], created: [], read: [], write: [], targetRead: [] }
  const projectObjectId = deriveProjectSheetObjectId(TENANT, PARAMS.projectNo)
  const projectSheetId = 'synthetic-project-sheet'
  let projectTargets = null
  if (projectSheets) {
    projectTargets = createStockPreparationProjectTargetStore({ db, idGenerator: () => 'synthetic-project-target' })
    await projectTargets.create({ tenantId: TENANT, projectNo: PARAMS.projectNo, sheetId: projectSheetId, objectId: projectObjectId })
    register = loadRoutes(routeTransform, routeDependencies, { [PROJECT_SHEETS_ENABLED_ENV]: 'true' }).registerIntegrationRoutes
  }
  // Emulates a case-insensitive source column for the entry field only; every other field compares exactly.
  const sourceMatches = (object, key, actual, wanted) => (sourceCaseInsensitive && object === 'SYN_PathLink' && key === 'project'
    ? typeof actual === 'string' && typeof wanted === 'string' && actual.toLowerCase() === wanted.toLowerCase()
    : actual === wanted)
  const data = {
    SYN_PathLink: [{ project: sourceProject || PARAMS.projectNo, path: 'path-1' }], SYN_Path: [{ id: 'path-1' }],
    SYN_Order: [{ id: 'order-1', path: 'path-1' }], SYN_OrderLine: [{ order: 'order-1', part: 'part-1', qty: '2' }],
    SYN_Part: [{ id: 'part-1', code: 'SYN-001', name: 'Synthetic part' }], SYN_Bom: [], SYN_BomLine: [],
  }
  const action = {
    source: { externalSystemId: SYSTEM, kind: 'data-source:sql-readonly', workspaceId: sourceWorkspaceId,
      ...(deployReadPlan ? { readPlan: clone(deployReadPlan) } : {}) },
    target: { sheetId: 'synthetic-sheet', objectId: 'syntheticSandbox', fieldIdMap: Object.fromEntries(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, field.id])) },
    rootSelection: { enabled: false },
  }
  const registry = {
    ...inert(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
    async getExternalSystem(input) {
      // Public projection. The row nonce stays off this object.
      return {
        id: input.id, tenantId: input.tenantId, workspaceId: input.workspaceId,
        kind: 'data-source:sql-readonly', status: 'active', connectionId: CONNECTION_ID,
        config: { dataSourceOwnerId: USER.id, dataSourceId: CONNECTION_ID },
      }
    },
    async getExternalSystemForAdapter(input) {
      calls.adapter.push(clone(input))
      // Adapter-only projection. Baseline nonce is the current binding row.
      return {
        id: input.id, tenantId: input.tenantId, workspaceId: input.workspaceId,
        kind: 'data-source:sql-readonly', status: 'active', connectionId: CONNECTION_ID,
        bindingValidationRevision: BINDING_REVISION,
        config: { dataSourceOwnerId: USER.id, dataSourceId: CONNECTION_ID },
      }
    },
  }
  const services = {
    // Apply paths take the project write lease and fail closed 501 without a lock: the REAL in-memory lock, not a stub.
    stockPreparationProjectWriteLock: lockKit.createInMemoryProjectWriteLock({ timers: 'real' }).lock,
    externalSystemRegistry: registry,
    stockPreparationSourceBindingStore: {
      async get(input) { calls.binding.push(clone(input)); return { externalSystemId: SYSTEM, matchedWorkspaceId, scopeFallback: matchedWorkspaceId === null ? 'tenant_null_row' : 'single_workspace_binding' } },
      async set() { throw new Error('unexpected binding mutation') },
    },
    stockPreparationReadPlanStore: {
      async getActiveForRuntime(input) { calls.ledger.push(clone(input)); return ledger.getActiveForRuntime(input) },
    },
    stockPreparationAuditStore: { async append() {} },
    ...(projectTargets ? { stockPreparationProjectTargetStore: projectRegistry ? projectRegistry(projectTargets) : projectTargets } : {}),
    stockPreparationConfirmationDecisionLease: { async acquire() { return 'synthetic-lease' }, async release() {} },
    tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
    adapterRegistry: { listAdapterKinds() { return [] }, createAdapter(system, deps = {}) {
      calls.created.push(clone({ system, deps }))
      if (Object.hasOwn(deps, 'expectedValidationRevision') && deps.expectedValidationRevision !== CONNECTION_REVISION) {
        throw new Error('synthetic adapter refused a stale validation revision')
      }
      return { async read(input) {
        calls.read.push(clone(input))
        return { records: clone((data[input.object] || []).filter((row) => Object.entries(input.filters || {}).every(([key, value]) => sourceMatches(input.object, key, row[key], value)))), done: true, nextCursor: null }
      } }
    } },
    pipelineRegistry: inert(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inert(['runPipeline']), deadLetterStore: inert(['listDeadLetters']),
    stagingInstaller: inert(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inert(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inert(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inert(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inert(['saveVersion', 'approve', 'retire', 'getForApply']),
  }
  if (storeMissing) delete services.stockPreparationReadPlanStore
  const records = []
  const storage = consumableMap()
  const routes = new Map()
  const context = {
    storage, config: { stockPreparationTableActions: unconfigured ? [] : [action], stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: ['syntheticSandbox'] } },
    api: { http: { addRoute(method, route, handler) { routes.set(`${method} ${route}`, handler) } }, multitable: {
      provisioning: {
        async findObjectSheet({ objectId } = {}) { return { id: objectId === projectObjectId ? projectSheetId : 'synthetic-sheet' } },
        async resolveFieldIds({ objectId, fieldIds }) {
          assert.equal(objectId, projectObjectId, 'the real project overlay requests its own physical map')
          return Object.fromEntries(fieldIds.map((id) => [id, `project_field_${id}`]))
        },
        async isSheetOwnedByProject(sheetId, projectId) {
          return sheetId === projectSheetId && projectId === `${TENANT}:integration-core`
        },
        async readObjectFieldsContent({ fieldIds }) { return Object.fromEntries(fieldIds.map((id) => [id, { name: id.replace(/^project_field_/, ''), type: 'string' }])) },
      },
      records: {
        async queryRecords(input) { calls.targetRead.push(clone(input)); return clone(records.filter((row) => Object.entries(input.filters || {}).every(([key, value]) => row.data[key] === value))) },
        async createRecord(input) { calls.write.push(clone(input)); const row = { id: `row-${records.length}`, version: 1, data: clone(input.data) }; records.push(row); return clone(row) },
        async patchRecord(input) { calls.write.push(clone(input)); return { id: input.recordId, version: 2, data: input.changes } },
      },
    } },
  }
  // The host side of the lease: the fake declares and enforces the write fence the apply paths hand it.
  context.api.multitable.records = lockKit.withFakeHostWriteFence(context.api.multitable.records)
  register({ services, context, logger: { warn() {}, info() {} } })
  async function call(route, { body = {}, params = {}, query = {}, claimed = true, method = 'POST' } = {}) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(value) { this.body = value; return this } }
    const handler = routes.get(`${method} ${route}`)
    assert.ok(handler, route)
    await handler({ user: USER, ...(claimed ? { authenticatedTenantId: TENANT } : {}), body, params: { actionId: ACTION, ...params }, query }, response)
    return response
  }
  return { call, calls, ledger, state, version, action, storage, services, projectTargets, projectSheetId, projectObjectId }
}

// Synthetic receipt overlay. The real pair stays approved; only the returned binding nonce changes.
function withReceiptBindingRevision(fixture, bindingRevision) {
  const store = fixture.services.stockPreparationReadPlanStore
  const readActive = store.getActiveForRuntime.bind(store)
  store.getActiveForRuntime = async (input) => {
    const active = await readActive(input)
    if (!active || !active.sourceValidation) return active
    return { ...active, sourceValidation: { ...active.sourceValidation, bindingRevision } }
  }
}

function assertForwardedCurrentRevision(calls) {
  assert.equal(calls.created[0].system.bindingValidationRevision, BINDING_REVISION)
  assert.equal(calls.created[0].deps.expectedValidationRevision, CONNECTION_REVISION)
}

async function expanded(fixture) {
  const start = await fixture.call(JOBS, { body: { parameters: PARAMS } })
  assert.equal(start.statusCode, 202, JSON.stringify(start.body))
  const params = { jobId: start.body.data.jobId }
  const run = await fixture.call(`${JOBS}/:jobId/run`, { params })
  assert.equal(run.statusCode, 200, JSON.stringify(run.body))
  assert.equal(run.body.data.authoritative, true)
  const plan = await fixture.call(`${JOBS}/:jobId/plan`, { params })
  assert.equal(plan.statusCode, 200, JSON.stringify(plan.body))
  const approve = await fixture.call(`${JOBS}/:jobId/apply-jobs`, { params, body: { confirm: { acceptManualConfirmHold: true } } })
  assert.equal(approve.statusCode, 202, JSON.stringify(approve.body))
  return { ...params, applyJobId: approve.body.data.jobId }
}

test('real ledger -> HTTP dry-run -> token -> apply uses approved synthetic plan', async () => {
  const f = await mount()
  const active = await f.ledger.getActiveForRuntime({ ...SCOPE, actionId: ACTION, systemId: SYSTEM })
  assert.deepEqual(active.sourceValidation, {
    connectionId: CONNECTION_ID, connectionRevision: CONNECTION_REVISION, bindingRevision: BINDING_REVISION,
  })
  assert.equal(typeof active.activation.validationId, 'string')
  assert.ok(active.activation.validationId)
  const dry = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS }, query: { workspaceId: 'request-selector' } })
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  assert.ok(dry.body.data.dryRunToken, JSON.stringify(dry.body))
  assert.equal(f.calls.read[0].object, 'SYN_PathLink')
  assertForwardedCurrentRevision(f.calls)
  assert.equal(f.calls.binding.length, 1)
  assert.equal(f.calls.ledger[0].workspaceId, null)
  assert.equal(f.calls.adapter[0].workspaceId, null)
  const applied = await f.call(`${BASE}/apply`, { body: { parameters: PARAMS, confirm: { dryRunToken: dry.body.data.dryRunToken } } })
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.equal(f.calls.write.length, 1)
})

test('active online plan refuses deploy-only projectSubtree/batchIdentity before adapter, reads and token writes', async () => {
  for (const [key, block] of Object.entries(DEPLOY_DECLARATIONS)) {
    const f = await mount({ deployReadPlan: { ...config().readPlan, [key]: clone(block) } })
    const normalized = await createStockPreparationTableActionRegistry({ actions: [f.action] }).getTableAction({})
    assert.ok(Object.hasOwn(normalized.source.readPlan, key), `${key} fixture must survive the real deploy normalizer`)
    const before = clone([...f.storage])
    for (const route of [`${BASE}/dry-run`, JOBS]) {
      const result = await f.call(route, { body: { parameters: PARAMS } })
      assert.equal(result.statusCode, 409, `${key} ${route}: ${JSON.stringify(result.body)}`)
      assert.equal(result.body.error.code, 'READ_PLAN_DEPLOYMENT_INCOMPATIBLE', JSON.stringify(result.body))
      assert.doesNotMatch(JSON.stringify(result.body), /SYN_|projectSubtree|batchIdentity/)
    }
    assert.ok(f.calls.ledger.length > 0, 'the actual active pointer was consulted')
    assert.equal(f.calls.adapter.length, 0)
    assert.equal(f.calls.created.length, 0)
    assert.equal(f.calls.read.length, 0)
    assert.equal(f.calls.write.length, 0)
    assert.deepEqual([...f.storage], before)
  }
})

test('absent online plan preserves deploy legacy blocks; compatible inline deploy plan stays online', async () => {
  for (const [key, block] of Object.entries(DEPLOY_DECLARATIONS)) {
    const f = await mount({ active: false, deployReadPlan: { ...config().readPlan, [key]: clone(block) } })
    const result = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
    assert.notEqual(result.body && result.body.error && result.body.error.code, 'READ_PLAN_DEPLOYMENT_INCOMPATIBLE', JSON.stringify(result.body))
    assert.ok(f.calls.ledger.length > 0)
    assert.ok(f.calls.adapter.length > 0, `${key}: legacy reached its source adapter; approved composition never ran`)
    if (key === 'projectSubtree') {
      assert.ok(f.calls.read.some((input) => input.object === 'SYN_Path' && input.filters.parent === 'path-1'),
        'legacy executes the declared subtree read, not just the ordinary order path')
    }
  }
  const online = await mount({ deployReadPlan: config().readPlan })
  const dry = await online.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  assert.ok(dry.body.data.dryRunToken)
  assert.equal(online.calls.read[0].object, 'SYN_PathLink')
  assertForwardedCurrentRevision(online.calls)
})

test('generation changed or pointer missing rejects token before adapter, reads, consume and writes', async () => {
  for (const missing of [false, true]) {
    const f = await mount()
    const dry = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
    const token = dry.body.data.dryRunToken
    assert.ok(token)
    if (missing) f.state[ACTIVATION_TABLE].length = 0
    else await f.ledger.activate({ ...SCOPE, id: f.version.id, actor: USER.id, expectedGeneration: 1 })
    const counts = { adapter: f.calls.adapter.length, reads: f.calls.read.length, size: f.storage.size }
    const applied = await f.call(`${BASE}/apply`, { body: { parameters: PARAMS, confirm: { dryRunToken: token } } })
    assert.equal(applied.statusCode, 409, JSON.stringify(applied.body))
    assert.equal(f.calls.adapter.length, counts.adapter)
    assert.equal(f.calls.read.length, counts.reads)
    assert.equal(f.storage.size, counts.size)
    assert.equal(f.calls.write.length, 0)
  }
})

test('real large-BOM route chain accepts current identity and writes synthetic records', async () => {
  const f = await mount()
  const params = await expanded(f)
  const chunk = await f.call(`${JOBS}/:jobId/apply-jobs/:applyJobId/run`, { params })
  assert.equal(chunk.statusCode, 200, JSON.stringify(chunk.body))
  assert.equal(f.calls.write.length, 1)
})

test('active plan and project sheets coexist through the real five-stage large-BOM route chain', async () => {
  const f = await mount({ projectSheets: true })
  const params = await expanded(f)
  const result = await f.call(`${JOBS}/:jobId/apply-jobs/:applyJobId/run`, { params })
  assert.equal(result.statusCode, 200, JSON.stringify(result.body))
  assert.notEqual(f.projectSheetId, f.action.target.sheetId, 'the deployment target cannot accidentally satisfy this fixture')
  assert.equal(f.calls.write.length, 1)
  assert.equal(f.calls.write[0].sheetId, f.projectSheetId)
  assert.equal(f.calls.write[0].data.project_field_projectNo, PARAMS.projectNo)
  assert.equal(Object.hasOwn(f.calls.write[0].data, 'projectNo'), false, 'only this project sheet physical map is written')
  assert.ok(f.calls.targetRead.length > 0)
  assert.ok(f.calls.targetRead.every((call) => call.sheetId === f.projectSheetId), 'no read falls back to the mixed deployment table')
  assert.ok(f.calls.ledger.every((call) => call.tenantId === TENANT && call.workspaceId === null))
  assert.ok(f.calls.adapter.every((call) => call.id === SYSTEM && call.workspaceId === null))
})

test('project-sheet execution rejects stale generation, archived write targets and changed target before IO', async () => {
  for (const change of ['generation', 'archived', 'target']) {
    const f = await mount({ projectSheets: true })
    const params = await expanded(f)
    if (change === 'generation') await f.ledger.activate({ ...SCOPE, id: f.version.id, actor: USER.id, expectedGeneration: 1 })
    else if (change === 'archived') await f.projectTargets.archive({ tenantId: TENANT, projectNo: PARAMS.projectNo, actorId: USER.id })
    else f.state[PROJECT_TARGET_TABLE][0].sheet_id = 'synthetic-replaced-project-sheet'
    const before = { source: f.calls.read.length, adapter: f.calls.adapter.length, target: f.calls.targetRead.length, write: f.calls.write.length, storage: clone([...f.storage]) }
    const suffixes = change === 'generation' ? ['/run', '/plan', '/apply-jobs', '/apply-jobs/:applyJobId/run'] : ['/plan', '/apply-jobs', '/apply-jobs/:applyJobId/run']
    for (const suffix of suffixes) {
      const result = await f.call(`${JOBS}/:jobId${suffix}`, { params })
      assert.equal(result.statusCode, 409, `${change} ${suffix}: ${JSON.stringify(result.body)}`)
      if (change === 'archived') assert.equal(result.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
      if (change === 'target') assert.equal(result.body.error.code, 'STOCK_PREPARATION_JOB_TARGET_STALE')
      assert.equal(f.calls.read.length, before.source, 'no source read after a refusal')
      assert.equal(f.calls.adapter.length, before.adapter, 'no source adapter lookup after a refusal')
      assert.equal(f.calls.targetRead.length, before.target, 'no target row read after a refusal')
      assert.equal(f.calls.write.length, before.write, 'no business write after a refusal')
      assert.deepEqual([...f.storage], before.storage, 'refusal leaves persisted jobs unchanged')
    }
  }
})

test('disabled and retired plans stop all ten execution entries, retaining snapshots', async () => {
  for (const retired of [false, true]) {
    const f = await mount()
    const params = await expanded(f)
    if (retired) await f.ledger.retire({ ...SCOPE, id: f.version.id, actor: USER.id })
    else await f.ledger.deactivate({ ...SCOPE, actionId: ACTION, actor: USER.id, expectedGeneration: 1 })
    const before = { adapter: f.calls.adapter.length, reads: f.calls.read.length, storage: clone([...f.storage]) }
    const endpoints = [
      [`${BASE}/dry-run`, { body: { parameters: PARAMS } }],
      [`${BASE}/apply`, { body: { parameters: PARAMS, confirm: { dryRunToken: 'unused' } } }],
      [`${BASE}/confirmation-decisions/reconcile`, { body: { parameters: PARAMS } }],
      [`${BASE}/mvp-persist`, { body: { parameters: PARAMS } }],
      [JOBS, { body: { parameters: PARAMS } }],
      [`${JOBS}/:jobId/run`, { params }], [`${JOBS}/:jobId/plan`, { params }],
      [`${JOBS}/:jobId/apply-jobs`, { params }], [`${JOBS}/:jobId/apply-jobs/:applyJobId/run`, { params }],
      [PREFLIGHT, { method: 'GET' }],
    ]
    for (const [route, request] of endpoints) {
      const result = await f.call(route, request)
      assert.ok([409, 503].includes(result.statusCode), `${route}: ${JSON.stringify(result.body)}`)
    }
    assert.equal(f.calls.adapter.length, before.adapter)
    assert.equal(f.calls.read.length, before.reads)
    assert.equal(f.calls.write.length, 0)
    assert.deepEqual([...f.storage], before.storage)
  }
})

test('changed generation invalidates every stored large-BOM execution stage', async () => {
  const f = await mount()
  const params = await expanded(f)
  await f.ledger.activate({ ...SCOPE, id: f.version.id, actor: USER.id, expectedGeneration: 1 })
  const before = f.calls.adapter.length
  for (const suffix of ['/run', '/plan', '/apply-jobs', '/apply-jobs/:applyJobId/run']) {
    const result = await f.call(`${JOBS}/:jobId${suffix}`, { params })
    assert.equal(result.statusCode, 409, JSON.stringify(result.body))
  }
  assert.equal(f.calls.adapter.length, before)
  assert.equal(f.calls.write.length, 0)
})

test('online execution requires verified tenant and refuses cross-source preflight and selector mismatch', async () => {
  const f = await mount()
  const claimless = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS }, claimed: false })
  assert.equal(claimless.statusCode, 403)
  const override = await f.call(PREFLIGHT, { method: 'GET', query: { externalSystemId: 'different-source' } })
  assert.equal(override.statusCode, 409)
  assert.equal(f.calls.adapter.length, 0)
  const mismatched = await mount({ sourceWorkspaceId: 'different-workspace' })
  const result = await mismatched.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
  assert.equal(result.statusCode, 409)
  assert.equal(mismatched.calls.adapter.length, 0)
})

test('source-preflight measures the approved plan under the requester and exact matched scope', async () => {
  const f = await mount()
  const result = await f.call(PREFLIGHT, { method: 'GET', query: { workspaceId: 'request-selector' } })
  assert.equal(result.statusCode, 200, JSON.stringify(result.body))
  assert.equal(result.body.data.readPlanId, config().readPlan.id)
  assert.equal(f.calls.adapter[0].workspaceId, null)
  assert.equal(f.calls.adapter[0].principal, USER.id)
  assert.equal(f.calls.binding.length, 1)
  assertForwardedCurrentRevision(f.calls)
})

test('loader and preflight refuse a receipt binding nonce that is not the resolved adapter row before createAdapter', async () => {
  const request = { query: { workspaceId: 'request-selector' } }
  for (const entry of [
    { name: 'loader', run: (fixture) => fixture.call(`${BASE}/dry-run`, { ...request, body: { parameters: PARAMS } }) },
    { name: 'preflight', run: (fixture) => fixture.call(PREFLIGHT, { ...request, method: 'GET' }) },
  ]) {
    const matched = await mount()
    const publicRow = await matched.services.externalSystemRegistry.getExternalSystem({ id: SYSTEM, tenantId: TENANT, workspaceId: null })
    assert.equal(Object.hasOwn(publicRow, 'bindingValidationRevision'), false)
    const adapterRow = await matched.services.externalSystemRegistry.getExternalSystemForAdapter({ id: SYSTEM, tenantId: TENANT, workspaceId: null })
    assert.equal(adapterRow.bindingValidationRevision, BINDING_REVISION)
    const matchedResult = await entry.run(matched)
    assert.equal(matchedResult.statusCode, 200, `${entry.name}: ${JSON.stringify(matchedResult.body)}`)
    assert.equal(matched.calls.ledger[0].workspaceId, null)
    assert.equal(matched.calls.adapter.find((input) => input.principal).workspaceId, null)
    assertForwardedCurrentRevision(matched.calls)
    const mismatched = await mount()
    withReceiptBindingRevision(mismatched, STALE_BINDING_REVISION)
    const refused = await entry.run(mismatched)
    assert.equal(refused.statusCode, 409, `${entry.name}: ${JSON.stringify(refused.body)}`)
    assert.equal(refused.body.error.code, 'READ_PLAN_VALIDATION_SOURCE_CHANGED')
    assert.equal(mismatched.calls.ledger[0].workspaceId, null)
    assert.ok(mismatched.calls.adapter.length > 0, entry.name)
    assert.equal(mismatched.calls.created.length, 0, entry.name)
    assert.equal(mismatched.calls.read.length, 0, entry.name)
  }
})

test('unconfigured preflight resolves actual binding scope before activation, never a fallback hint', async () => {
  const register = (args) => {
    args.context.config.stockPreparationTableActions = []
    registerIntegrationRoutes(args)
  }
  for (const status of ['active', 'disabled', 'retired', 'absent']) {
    for (const workspaceId of ['request-selector', undefined]) {
      const f = await mount({ register, active: status !== 'absent' })
      if (status === 'disabled') await f.ledger.deactivate({ ...SCOPE, actionId: ACTION, actor: USER.id, expectedGeneration: 1 })
      if (status === 'retired') await f.ledger.retire({ ...SCOPE, id: f.version.id, actor: USER.id })
      const result = await f.call(PREFLIGHT, { method: 'GET', query: { externalSystemId: SYSTEM, ...(workspaceId ? { workspaceId } : {}) } })
      assert.equal(result.statusCode, status === 'absent' ? 200 : 409, `${status}/${workspaceId}: ${JSON.stringify(result.body)}`)
      assert.equal(f.calls.binding.length, 1)
      assert.equal(f.calls.ledger[0].workspaceId, null)
      if (status !== 'absent') {
        assert.equal(f.calls.adapter.length, 0)
        assert.equal(f.calls.read.length, 0)
      } else {
        assert.equal(f.calls.adapter[0].workspaceId, null)
        assert.ok(f.calls.read.length > 0)
      }
    }
  }
  // A genuinely matched workspace binding is distinct from a hint that fell
  // back to null. Do not impose the unrelated tenant activation on it.
  const f = await mount({ register, matchedWorkspaceId: 'real-workspace' })
  await f.ledger.deactivate({ ...SCOPE, actionId: ACTION, actor: USER.id, expectedGeneration: 1 })
  const result = await f.call(PREFLIGHT, { method: 'GET', query: { externalSystemId: SYSTEM, workspaceId: 'real-workspace' } })
  assert.equal(result.statusCode, 200, JSON.stringify(result.body))
  assert.equal(f.calls.binding.length, 1)
  assert.equal(f.calls.ledger[0].workspaceId, 'real-workspace')
  assert.equal(f.calls.adapter[0].workspaceId, 'real-workspace')
})

test('unconfigured and unbound preflight resolves source metadata fallback before activation', async () => {
  for (const active of [true, false]) {
    const f = await mount({ unconfigured: true, active })
    f.services.stockPreparationSourceBindingStore.get = async (input) => { f.calls.binding.push(clone(input)); return null }
    const publicGet = f.services.externalSystemRegistry.getExternalSystem
    f.services.externalSystemRegistry.getExternalSystem = async (input) => ({ ...await publicGet(input), workspaceId: null })
    if (active) await f.ledger.deactivate({ ...SCOPE, actionId: ACTION, actor: USER.id, expectedGeneration: 1 })
    const result = await f.call(PREFLIGHT, { method: 'GET', query: { externalSystemId: SYSTEM, workspaceId: 'fallback-selector' } })
    assert.equal(result.statusCode, active ? 409 : 200, JSON.stringify(result.body))
    assert.equal(f.calls.binding.length, 1)
    assert.equal(f.calls.ledger[0].workspaceId, null)
    if (active) assert.equal(f.calls.adapter.length, 0)
    else assert.equal(f.calls.adapter[0].workspaceId, null)
  }
})

test('unreadable supplied token cannot downgrade to legacy after its online pointer disappears', async () => {
  const f = await mount()
  const dry = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
  const token = dry.body.data.dryRunToken
  assert.ok(token)
  f.state[ACTIVATION_TABLE].length = 0
  const get = f.storage.get.bind(f.storage)
  let failed = false
  f.storage.get = (key) => {
    if (!failed && key.includes(token)) { failed = true; throw new Error('SYN-token-storage-private') }
    return get(key)
  }
  const before = { adapter: f.calls.adapter.length, read: f.calls.read.length, storage: clone([...f.storage]) }
  const result = await f.call(`${BASE}/apply`, { body: { parameters: PARAMS, confirm: { dryRunToken: token } } })
  assert.equal(result.statusCode, 503, JSON.stringify(result.body))
  assert.equal(failed, true)
  assert.equal(f.calls.adapter.length, before.adapter)
  assert.equal(f.calls.read.length, before.read)
  assert.equal(f.calls.write.length, 0)
  assert.deepEqual([...f.storage], before.storage)
  assert.ok(!JSON.stringify(result.body).includes('SYN-token-storage-private'))
})

test('legacy reconcile ignores request workspace selectors while using its actual matched binding', async () => {
  const f = await mount({ active: false })
  f.services.stockPreparationSourceBindingStore.get = async (input) => {
    f.calls.binding.push(clone(input))
    return { externalSystemId: input.workspaceId ? 'other-source' : SYSTEM, matchedWorkspaceId: input.workspaceId || null }
  }
  await f.call(`${BASE}/confirmation-decisions/reconcile`, { query: { workspaceId: 'other-workspace' }, body: { parameters: PARAMS } })
  assert.equal(f.calls.binding.length, 1)
  assert.equal(f.calls.binding[0].workspaceId, null)
  assert.equal(f.calls.adapter.length, 1)
  assert.equal(f.calls.adapter[0].id, SYSTEM)
  assert.equal(f.calls.adapter[0].workspaceId, 'other-workspace', 'only the historical adapter selector survives; it cannot repoint the tenant binding')
})

test('missing or failing store cannot silently select deployment plan; failures are values-free', async () => {
  const missing = await mount({ active: false, storeMissing: true })
  assert.equal((await missing.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })).statusCode, 501)
  const failed = await mount()
  failed.services.stockPreparationReadPlanStore.getActiveForRuntime = async () => { throw new Error('SYN-private-db-detail') }
  const response = await failed.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
  assert.equal(response.statusCode, 503)
  assert.ok(!JSON.stringify(response.body).includes('SYN-private-db-detail'))
  assert.equal(failed.calls.adapter.length, 0)
})

test('only absent pointer keeps legacy shape and exact binding scope never adopts request workspace', async () => {
  const f = await mount({ active: false })
  const registry = createStockPreparationTableActionRegistry({ actions: [f.action], resolveSourceBinding: async () => ({ externalSystemId: SYSTEM, matchedWorkspaceId: null }) })
  const resolved = await registry.getTableActionForExecution({ tenantId: TENANT, workspaceId: 'request-selector' })
  assert.equal(resolved.bindingScope.workspaceId, null)
  const legacy = await resolveStockPreparationReadPlanExecution({ resolved, store: f.ledger, verifyTenant() { throw new Error('legacy does not demand a new claim') } })
  assert.deepEqual(legacy.action, await registry.getTableAction({ tenantId: TENANT }))
  assert.equal(Object.hasOwn(legacy.action, 'readPlanExecutionIdentity'), false)
})

test('route omission mutations are rejected by real-path assertions without editing production files', async (t) => {
  const replace = (needle, value, all = false) => (source) => {
    assert.ok(source.includes(needle), `mutation seam is missing: ${needle}`)
    return all ? source.replaceAll(needle, value) : source.replace(needle, value)
  }
  const cases = [
    {
      name: 'use request hint for unconfigured preflight activation',
      options: { unconfigured: true },
      transform: replace('exactSourceScope = await resolveUnconfiguredPreflightSourceScope({ tenantId, workspaceId, externalSystemId })', 'exactSourceScope = { tenantId, workspaceId: workspaceId || null }'),
      async oracle(f) {
        await f.ledger.deactivate({ ...SCOPE, actionId: ACTION, actor: USER.id, expectedGeneration: 1 })
        const result = await f.call(PREFLIGHT, { method: 'GET', query: { externalSystemId: SYSTEM, workspaceId: 'fallback-selector' } })
        assert.equal(result.statusCode, 409)
        assert.equal(f.calls.adapter.length, 0)
      },
    },
    {
      name: 'swallow unreadable token after online pointer disappears',
      dependencies: {
        './stock-preparation-table-actions.cjs': loadActionModule(replace(
          "throw new StockPreparationTableActionError(503, 'TABLE_ACTION_TOKEN_STORE_UNAVAILABLE', 'dry-run token store is unavailable')",
          "if (!currentOnline) return\n    throw new StockPreparationTableActionError(503, 'TABLE_ACTION_TOKEN_STORE_UNAVAILABLE', 'dry-run token store is unavailable')",
        )),
      },
      async oracle(f) {
        const dry = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
        const token = dry.body.data.dryRunToken
        f.state[ACTIVATION_TABLE].length = 0
        const get = f.storage.get.bind(f.storage)
        let failed = false
        f.storage.get = (key) => {
          if (!failed && key.includes(token)) { failed = true; throw new Error('synthetic transient storage failure') }
          return get(key)
        }
        const before = f.calls.adapter.length
        const result = await f.call(`${BASE}/apply`, { body: { parameters: PARAMS, confirm: { dryRunToken: token } } })
        assert.equal(result.statusCode, 503)
        assert.equal(f.calls.adapter.length, before)
      },
    },
    {
      name: 'refill explicit tenant-level reconcile scope from workspace query',
      options: { active: false },
      transform: replace("if (Object.prototype.hasOwnProperty.call(input, 'workspaceId')) scope.workspaceId = input.workspaceId", 'void input'),
      async oracle(f) {
        f.services.stockPreparationSourceBindingStore.get = async (input) => {
          f.calls.binding.push(clone(input))
          return { externalSystemId: input.workspaceId ? 'other-source' : SYSTEM, matchedWorkspaceId: input.workspaceId || null }
        }
        await f.call(`${BASE}/confirmation-decisions/reconcile`, { query: { workspaceId: 'other-workspace' }, body: { parameters: PARAMS } })
        assert.equal(f.calls.binding[0].workspaceId, null)
        assert.equal(f.calls.adapter[0].id, SYSTEM)
      },
    },
    {
      name: 'omit injected runtime ledger',
      transform: replace('store: services.stockPreparationReadPlanStore,', 'store: { getActiveForRuntime: async () => null },'),
      async oracle(f) {
        await f.ledger.deactivate({ ...SCOPE, actionId: ACTION, actor: USER.id, expectedGeneration: 1 })
        const before = f.calls.adapter.length
        await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
        assert.equal(f.calls.adapter.length, before)
      },
    },
    {
      name: 'omit ordinary token identity precheck',
      transform: replace('await assertDryRunTokenReadPlanCurrent({ tokenStore: context.storage, dryRunToken: confirm.dryRunToken, action, parameters: body.parameters })', 'void confirm'),
      async oracle(f) {
        const dry = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
        await f.ledger.activate({ ...SCOPE, id: f.version.id, actor: USER.id, expectedGeneration: 1 })
        const before = f.calls.adapter.length
        await f.call(`${BASE}/apply`, { body: { parameters: PARAMS, confirm: { dryRunToken: dry.body.data.dryRunToken } } })
        assert.equal(f.calls.adapter.length, before)
      },
    },
    ...['run', 'plan'].map((stage) => ({
      name: `omit stored snapshot ${stage} recheck`,
      transform: replace(stage === 'run'
        ? `await resolveTableActionExecution(req, {
        actionId,
        projectNo: queuedJob.parameters && queuedJob.parameters.projectNo,
        targetPurpose: 'read',
      }, action)`
        : `await resolveTableActionExecution(req, {
        actionId,
        projectNo: job.parameters && job.parameters.projectNo,
        targetPurpose: 'write',
      }, action)`, 'void action'),
      async oracle(f) {
        const params = await expanded(f)
        await f.ledger.deactivate({ ...SCOPE, actionId: ACTION, actor: USER.id, expectedGeneration: 1 })
        const result = await f.call(`${JOBS}/:jobId/${stage}`, { params })
        assert.equal(result.statusCode, 409)
        // Typed oracle for the plan stage: the healthy control is refused by the readPlan boundary
        // (READ_PLAN_ACTIVATION_DISABLED). With the stored-snapshot recheck omitted it is still 409, but
        // answered by the write-generation defense (STOCK_PREP_PROJECT_PLAN_SUPERSEDED). This proves readPlan
        // boundary / code ownership only; that overlapping main guard still rejects the mutant, so it does NOT
        // claim a single deletion makes the write path exploitable, and the guard is not removed or weakened.
        if (stage === 'plan') {
          assert.equal(result.body.error.code, 'READ_PLAN_ACTIVATION_DISABLED', JSON.stringify(result.body))
        }
      },
    })),
    {
      name: 'omit approved preflight source match',
      transform: replace('if (action && action.readPlanExecutionIdentity && externalSystemId !== configuredSystemId)', 'if (false && action && action.readPlanExecutionIdentity && externalSystemId !== configuredSystemId)'),
      async oracle(f) {
        await f.call(PREFLIGHT, { method: 'GET', query: { externalSystemId: 'different-source' } })
        assert.equal(f.calls.adapter.length, 0)
      },
    },
    {
      name: 'use carried tenant instead of verified claim',
      transform: replace('verifyTenant: () => resolveVerifiedClaimTenantId(req, input),', 'verifyTenant: () => resolveTenantId(req, input),'),
      async oracle(f) {
        await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS }, claimed: false })
        assert.equal(f.calls.adapter.length, 0)
      },
    },
    ...['snapshotAction', 'runSnapshotAction'].map((snapshot) => ({
      // The aligned path checks the stored snapshot both in the execution
      // resolver and here; the store also checks its generation. A single
      // deletion is intentionally masked by those real, overlapping defenses.
      // This explicitly COMPOSITE probe removes all three, never credits a
      // surviving single deletion to an isolated guard, and keeps the healthy
      // control on the unmodified real route / runtime / ledger.
      // Typed oracle: the healthy control is refused by the readPlan boundary
      // (READ_PLAN_GENERATION_CONFLICT); the mutant is still 409, but only the write
      // generation guard answers (STOCK_PREP_PROJECT_PLAN_SUPERSEDED). The code assertion
      // proves readPlan boundary / code ownership only. That overlapping main guard still
      // rejects the mutant, so this does NOT claim a single deletion makes the write
      // path exploitable, and nothing here removes or weakens that guard.
      name: `omit both ${snapshot} apply comparisons and generation recheck`,
      transform: replace(`assertLargeBomActionExecutionContract(currentAction, ${snapshot})`, `void ${snapshot}`),
      dependencies: { './stock-preparation-read-plan-runtime.cjs': withoutSnapshotRuntimeRechecks() },
      async oracle(f) {
        const params = await expanded(f)
        await f.ledger.activate({ ...SCOPE, id: f.version.id, actor: USER.id, expectedGeneration: 1 })
        const suffix = snapshot === 'snapshotAction' ? '/apply-jobs' : '/apply-jobs/:applyJobId/run'
        const result = await f.call(`${JOBS}/:jobId${suffix}`, { params })
        assert.equal(result.statusCode, 409)
        assert.equal(result.body.error.code, 'READ_PLAN_GENERATION_CONFLICT', JSON.stringify(result.body))
      },
    })),
    {
      name: 'omit loader binding nonce compare',
      transform: replace(
        'assertValidatedSourceRow(system, validationSource)\n    // The delegation, recorded.',
        '// The delegation, recorded.',
      ),
      async oracle(f) {
        withReceiptBindingRevision(f, STALE_BINDING_REVISION)
        const result = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS }, query: { workspaceId: 'request-selector' } })
        assert.equal(result.statusCode, 409, JSON.stringify(result.body))
        assert.equal(result.body.error.code, 'READ_PLAN_VALIDATION_SOURCE_CHANGED')
        assert.equal(f.calls.ledger[0].workspaceId, null)
        assert.equal(f.calls.created.length, 0)
        assert.equal(f.calls.read.length, 0)
      },
    },
    {
      name: 'omit preflight binding nonce compare',
      transform: replace(
        'assertValidatedSourceRow(system, validationSource)\n      const adapter = adapterRegistry.createAdapter(system, {\n        principal: requestPrincipal(req),',
        'const adapter = adapterRegistry.createAdapter(system, {\n        principal: requestPrincipal(req),',
      ),
      async oracle(f) {
        withReceiptBindingRevision(f, STALE_BINDING_REVISION)
        const result = await f.call(PREFLIGHT, { method: 'GET', query: { workspaceId: 'request-selector' } })
        assert.equal(result.statusCode, 409, JSON.stringify(result.body))
        assert.equal(result.body.error.code, 'READ_PLAN_VALIDATION_SOURCE_CHANGED')
        assert.equal(f.calls.ledger[0].workspaceId, null)
        assert.equal(f.calls.adapter[0].workspaceId, null)
        assert.equal(f.calls.created.length, 0)
        assert.equal(f.calls.read.length, 0)
      },
    },
    {
      name: 'omit loader expected validation revision',
      transform: replace(
        '      ...(validationSource ? { expectedValidationRevision: validationSource.connectionRevision } : {}),\n      ...(options.b2aAuthorization ? { b2aAuthorization: options.b2aAuthorization } : {}),',
        '      ...(options.b2aAuthorization ? { b2aAuthorization: options.b2aAuthorization } : {}),',
      ),
      async oracle(f) {
        const result = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS }, query: { workspaceId: 'request-selector' } })
        assert.equal(result.statusCode, 200, JSON.stringify(result.body))
        assert.equal(f.calls.ledger[0].workspaceId, null)
        assert.equal(f.calls.adapter[0].workspaceId, null)
        assertForwardedCurrentRevision(f.calls)
      },
    },
    {
      name: 'omit preflight expected validation revision',
      transform: replace(
        '        ...(validationSource ? { expectedValidationRevision: validationSource.connectionRevision } : {}),\n      })',
        '      })',
      ),
      async oracle(f) {
        const result = await f.call(PREFLIGHT, { method: 'GET', query: { workspaceId: 'request-selector' } })
        assert.equal(result.statusCode, 200, JSON.stringify(result.body))
        assert.equal(f.calls.ledger[0].workspaceId, null)
        assert.equal(f.calls.adapter[0].workspaceId, null)
        assertForwardedCurrentRevision(f.calls)
      },
    },
  ]
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      // Healthy path controls ensure a refusal cannot be credited to the fixture.
      await entry.oracle(await mount(entry.options))
      const mutated = loadRoutes(entry.transform, entry.dependencies)
      const fixture = await mount({ ...entry.options, register: mutated.registerIntegrationRoutes })
      await assert.rejects(() => entry.oracle(fixture), { name: 'AssertionError' })
    })
  }
})

// ---- Registry ambiguity guard: sourceProjectComparison === 'case-insensitive' (opt-in only) ----
const CI_PLAN = Object.freeze({ sourceProjectComparison: 'case-insensitive' })
const CI_SOURCE = Object.freeze({ sourceProject: 'syn-project', sourceCaseInsensitive: true })
const VARIANT = 'syn-project'
const AMBIGUOUS = 'READ_PLAN_PROJECT_IDENTITY_AMBIGUOUS'
const UNAVAILABLE = 'READ_PLAN_PROJECT_IDENTITY_UNAVAILABLE'
const TARGET_REQUIRED = 'READ_PLAN_PROJECT_TARGET_REQUIRED'

function loadRuntimeCopy(transform) {
  const filename = require.resolve('../lib/stock-preparation-read-plan-runtime.cjs')
  const copy = new Module(filename, module)
  copy.filename = filename
  copy.paths = Module._nodeModulePaths(path.dirname(filename))
  copy._compile(transform(fs.readFileSync(filename, 'utf8').replaceAll('\r\n', '\n')), filename)
  return copy.exports
}

const registryLog = () => ({ get: 0, list: 0, count: 0 })
// Counting wrapper over the REAL registry. overrides[name](input, realStore, priorCalls) replaces a method; null removes it.
function spyRegistry(log, overrides = {}) {
  return (store) => {
    const wrapped = { ...store }
    for (const name of ['get', 'list', 'count']) {
      if (overrides[name] === null) { delete wrapped[name]; continue }
      wrapped[name] = async (input) => {
        const prior = log[name]++
        return overrides[name] ? overrides[name](input, store, prior) : store[name](input)
      }
    }
    return wrapped
  }
}

function ciMount(options = {}) {
  return mount({ projectSheets: true, readPlanExtra: CI_PLAN, ...CI_SOURCE, ...options })
}

// A second registration whose project number differs from the canonical one only by case.
function addCaseVariant(fixture, status = 'active') {
  const row = clone(fixture.state[PROJECT_TARGET_TABLE][0])
  Object.assign(row, { project_no: VARIANT, sheet_id: `synthetic-variant-sheet-${status}`, object_id: `synthetic-variant-object-${status}`, status })
  if (Object.hasOwn(row, 'id')) row.id = `synthetic-variant-${status}`
  if (status === 'archived') row.archived_at = '2026-01-01T00:00:00.000Z'
  fixture.state[PROJECT_TARGET_TABLE].push(row)
}

function snapshotIo(fixture) {
  const { calls } = fixture
  return { adapter: calls.adapter.length, created: calls.created.length, read: calls.read.length, write: calls.write.length, storage: clone([...fixture.storage]) }
}
function assertNoIoSince(fixture, before, label) {
  assert.deepEqual(snapshotIo(fixture), before, `${label}: no source adapter, source read, token, job or write`)
}
function assertRefused(result, status, code, label) {
  assert.equal(result.statusCode, status, `${label}: ${JSON.stringify(result.body)}`)
  assert.equal(result.body.error.code, code, `${label}: ${JSON.stringify(result.body)}`)
  assert.doesNotMatch(JSON.stringify(result.body), /SYN-|syn-project|SYN_/, `${label}: values-free`)
}

function parametersHashes(fixture, token) {
  const found = []
  const walk = (value) => {
    if (typeof value === 'string') {
      let parsed = null
      try { parsed = JSON.parse(value) } catch (error) { return }
      if (parsed && typeof parsed === 'object') walk(parsed)
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'parametersHash') found.push(inner)
        else walk(inner)
      }
    }
  }
  for (const [key, value] of fixture.storage) if (key.includes(token)) walk(value)
  return found
}

// Direct runtime fixtures (no HTTP): exact control over what the registry returns.
function fakeRegistry(rows) {
  return {
    calls: [],
    async get({ tenantId, projectNo }) { this.calls.push('get'); return clone(rows.find((row) => row.tenantId === tenantId && row.projectNo === projectNo) || null) },
    async list() { this.calls.push('list'); return clone(rows) },
    async count() { this.calls.push('count'); return rows.length },
  }
}
const targetRow = (projectNo = 'Abc', status = 'active') => ({ tenantId: TENANT, projectNo, sheetId: 'sheet-1', objectId: 'object-1', status })
function unitResolved(comparison, projectNo = 'Abc') {
  return {
    action: {
      actionId: ACTION,
      source: { externalSystemId: SYSTEM, readPlan: comparison === undefined ? {} : { sourceProjectComparison: comparison } },
      target: { sheetId: 'sheet-1', objectId: 'object-1' },
      projectTarget: { projectNo, status: 'active' },
    },
    bindingScope: { tenantId: TENANT, workspaceId: null },
    sourceScope: { tenantId: TENANT, workspaceId: null },
  }
}
const noPointer = { async getActiveForRuntime() { return null } }
const unitRun = (extra = {}) => resolveStockPreparationReadPlanExecution({
  resolved: unitResolved('case-insensitive'), store: noPointer, verifyTenant: () => TENANT, projectNo: 'Abc', ...extra,
})
const refusal = (status, code) => ({ status, code, message: code })

test('runtime: absent/case-sensitive modes and the server-internal exemption make no registry or verifyTenant call', async () => {
  const claim = () => { throw new Error('no new tenant claim is demanded here') }
  for (const comparison of [undefined, 'case-sensitive']) {
    const registry = fakeRegistry([targetRow()])
    const result = await resolveStockPreparationReadPlanExecution({ resolved: unitResolved(comparison), store: noPointer, verifyTenant: claim, projectTargetStore: registry })
    assert.equal(result.action.source.externalSystemId, SYSTEM)
    assert.deepEqual(registry.calls, [], String(comparison))
  }
  const registry = fakeRegistry([targetRow()])
  await resolveStockPreparationReadPlanExecution({ resolved: unitResolved('case-insensitive'), store: noPointer, verifyTenant: claim, projectTargetStore: registry, projectIdentityRequired: false })
  assert.deepEqual(registry.calls, [])
})

test('runtime: case-insensitive mode passes only for the sole exact canonical row, via count, get, list, count', async () => {
  const registry = fakeRegistry([targetRow(), targetRow('Other')])
  const result = await unitRun({ projectTargetStore: registry })
  assert.equal(result.action.projectTarget.projectNo, 'Abc')
  assert.deepEqual(registry.calls, ['count', 'get', 'list', 'count'])
})

test('runtime: absent or malformed projectNo and a missing or foreign marker cannot skip the default-on guard', async () => {
  for (const projectNo of [undefined, null, '', 'Abc ', 123]) {
    const registry = fakeRegistry([targetRow()])
    await assert.rejects(unitRun({ projectNo, projectTargetStore: registry }), refusal(409, TARGET_REQUIRED), String(projectNo))
    assert.deepEqual(registry.calls, [])
  }
  for (const mutate of [
    (resolved) => { delete resolved.action.projectTarget },
    (resolved) => { resolved.action.projectTarget.projectNo = 'abc' },
    (resolved) => { resolved.action.projectTarget.status = 'unknown' },
  ]) {
    const resolved = unitResolved('case-insensitive')
    mutate(resolved)
    const registry = fakeRegistry([targetRow()])
    await assert.rejects(unitRun({ resolved, projectTargetStore: registry }), refusal(409, TARGET_REQUIRED))
    assert.deepEqual(registry.calls, [])
  }
})

test('runtime: untrusted tenant and an unusable registry service are refused before any registry read', async () => {
  for (const verifyTenant of [() => 'tenant-other', () => undefined, null]) {
    const registry = fakeRegistry([targetRow()])
    await assert.rejects(unitRun({ verifyTenant, projectTargetStore: registry }), refusal(403, 'READ_PLAN_EXECUTION_TENANT_MISMATCH'))
    assert.deepEqual(registry.calls, [])
  }
  const complete = fakeRegistry([targetRow()])
  for (const projectTargetStore of [undefined, null, {}, { get: complete.get, list: complete.list }, { get: complete.get, count: complete.count }]) {
    await assert.rejects(unitRun({ projectTargetStore }), refusal(501, UNAVAILABLE))
  }
})

test('runtime: equivalent-group ambiguity, target mismatch and incomplete or erroring registry reads fail closed', async () => {
  const other = { sheetId: 'sheet-2', objectId: 'object-2' }
  const boom = async () => { throw new Error('SYN-private-registry-detail') }
  const cases = [
    { name: 'live case variant', rows: [targetRow(), { ...targetRow('abc'), ...other }], status: 409, code: AMBIGUOUS },
    { name: 'archived case variant', rows: [targetRow(), { ...targetRow('ABC', 'archived'), ...other }], status: 409, code: AMBIGUOUS },
    { name: 'exact row absent', rows: [], status: 409, code: TARGET_REQUIRED },
    { name: 'get names another sheet', rows: [targetRow()], patch: { get: async () => ({ ...targetRow(), sheetId: 'sheet-other' }) }, status: 409, code: TARGET_REQUIRED },
    { name: 'get names another object', rows: [targetRow()], patch: { get: async () => ({ ...targetRow(), objectId: 'object-other' }) }, status: 409, code: TARGET_REQUIRED },
    { name: 'get status differs from marker', rows: [targetRow()], patch: { get: async () => targetRow('Abc', 'archived') }, status: 409, code: TARGET_REQUIRED },
    { name: 'get returns the wrong-case row', rows: [targetRow()], patch: { get: async () => targetRow('abc') }, status: 409, code: TARGET_REQUIRED },
    { name: 'get returns a foreign tenant row', rows: [targetRow()], patch: { get: async () => ({ ...targetRow(), tenantId: 'tenant-foreign' }) }, status: 503, code: UNAVAILABLE },
    { name: 'count over the cap', rows: [targetRow()], patch: { count: async () => 1001 }, status: 503, code: UNAVAILABLE },
    { name: 'count negative', rows: [targetRow()], patch: { count: async () => -1 }, status: 503, code: UNAVAILABLE },
    { name: 'count fractional', rows: [targetRow()], patch: { count: async () => 1.5 }, status: 503, code: UNAVAILABLE },
    { name: 'count not a number', rows: [targetRow()], patch: { count: async () => '1' }, status: 503, code: UNAVAILABLE },
    { name: 'list shorter than count', rows: [targetRow()], patch: { list: async () => [] }, status: 503, code: UNAVAILABLE },
    { name: 'list not an array', rows: [targetRow()], patch: { list: async () => ({}) }, status: 503, code: UNAVAILABLE },
    { name: 'count moves around list', rows: [targetRow()], patch: { count: (() => { let n = 0; return async () => (n++ === 0 ? 1 : 2) })() }, status: 503, code: UNAVAILABLE },
    { name: 'foreign tenant list row', rows: [targetRow(), { ...targetRow('Other'), tenantId: 'tenant-foreign' }], status: 503, code: UNAVAILABLE },
    { name: 'malformed list row', rows: [targetRow(), { ...targetRow('Other'), projectNo: 7 }], status: 503, code: UNAVAILABLE },
    { name: 'blank list target', rows: [targetRow(), { ...targetRow('Other'), sheetId: '' }], status: 503, code: UNAVAILABLE },
    { name: 'unknown list status', rows: [targetRow(), targetRow('Other', 'unknown')], status: 503, code: UNAVAILABLE },
    { name: 'list lacks the exact row', rows: [targetRow('abc')], patch: { get: async () => targetRow() }, status: 503, code: UNAVAILABLE },
    ...['get', 'list', 'count'].map((name) => ({ name: `${name} throws`, rows: [targetRow()], patch: { [name]: boom }, status: 503, code: UNAVAILABLE })),
  ]
  for (const entry of cases) {
    const registry = Object.assign(fakeRegistry(entry.rows), entry.patch || {})
    await assert.rejects(unitRun({ projectTargetStore: registry }), refusal(entry.status, entry.code), entry.name)
  }
})

test('default and case-sensitive HTTP previews keep the existing exact lookup without registry scans', async () => {
  for (const sourceProjectComparison of [undefined, 'case-sensitive']) {
    const log = registryLog()
    const f = await mount({ projectSheets: true, projectRegistry: spyRegistry(log),
      readPlanExtra: sourceProjectComparison === undefined ? {} : { sourceProjectComparison } })
    const dry = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.ok(dry.body.data.dryRunToken)
    assert.equal(log.get, 1, 'only the existing exact project-target lookup runs')
    assert.equal(log.list, 0)
    assert.equal(log.count, 0)
  }
})

test('case-insensitive source-only HTTP preflight does not require a project registration', async () => {
  const f = await ciMount({ projectSheets: false })
  const response = await f.call(PREFLIGHT, { method: 'GET' })
  assert.equal(response.statusCode, 200, JSON.stringify(response.body))
  assert.equal(response.body.data.readPlanId, config().readPlan.id)
  assert.ok(f.calls.adapter.length > 0)
  assert.equal(f.storage.size, 0, 'source preflight issues no execution token')
})

test('opt-in HTTP: canonical registered project with a differently cased source keeps canonical token hash, rows and project fields', async () => {
  const log = registryLog()
  const f = await ciMount({ projectRegistry: spyRegistry(log) })
  const control = await ciMount({ sourceProject: PARAMS.projectNo, sourceCaseInsensitive: true })
  const dry = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  const controlDry = await control.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
  assert.equal(controlDry.statusCode, 200, JSON.stringify(controlDry.body))
  assert.ok(f.calls.read.some((input) => input.object === 'SYN_PathLink'), 'the differently cased source row was actually read')
  assert.ok(log.list >= 1 && log.count === 2 * log.list, 'the guard ran against the real registry')
  const hashes = parametersHashes(f, dry.body.data.dryRunToken)
  assert.ok(hashes.length > 0 && hashes.every((hash) => typeof hash === 'string'), 'the stored token carries a parametersHash')
  assert.deepEqual(hashes, parametersHashes(control, controlDry.body.data.dryRunToken), 'a source spelling does not move the canonical parametersHash')
  const applied = await f.call(`${BASE}/apply`, { body: { parameters: PARAMS, confirm: { dryRunToken: dry.body.data.dryRunToken } } })
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.equal(f.calls.write.length, 1)
  assert.equal(f.calls.write[0].sheetId, f.projectSheetId)
  assert.equal(f.calls.write[0].data.project_field_projectNo, PARAMS.projectNo)
  assert.doesNotMatch(JSON.stringify(f.calls.write[0]), /syn-project/)
  assert.deepEqual(f.state[PROJECT_TARGET_TABLE].map((row) => row.project_no), [PARAMS.projectNo], 'no alias registration appeared')
})

test('opt-in HTTP: real large-BOM chain runs the FULL guard once per stage and writes the canonical project', async () => {
  const log = registryLog()
  const f = await ciMount({ projectRegistry: spyRegistry(log) })
  const params = await expanded(f)
  const chunk = await f.call(`${JOBS}/:jobId/apply-jobs/:applyJobId/run`, { params })
  assert.equal(chunk.statusCode, 200, JSON.stringify(chunk.body))
  assert.equal(f.calls.write.length, 1)
  assert.equal(f.calls.write[0].data.project_field_projectNo, PARAMS.projectNo)
  assert.equal(log.list, 5, 'start, run, plan, approve and chunk each ran the guard once; the readiness prechecks did not')
})

test('opt-in HTTP: a live or archived case-variant registration is refused before adapter, read, token and job', async () => {
  for (const status of ['active', 'archived']) {
    const f = await ciMount()
    addCaseVariant(f, status)
    const before = snapshotIo(f)
    for (const route of [`${BASE}/dry-run`, JOBS]) {
      const result = await f.call(route, { body: { parameters: PARAMS } })
      assertRefused(result, 409, AMBIGUOUS, `${status} ${route}`)
      assertNoIoSince(f, before, `${status} ${route}`)
    }
    assert.ok(f.calls.ledger.length > 0, 'the effective readPlan was resolved before the guard')
  }
})

test('opt-in HTTP: unavailable, mismatched or incomplete registry fails closed before source, token and job', async () => {
  const boom = async () => { throw new Error('SYN-private-registry-detail') }
  const cases = [
    { name: 'registry service absent', options: { projectSheets: false }, status: 501, code: UNAVAILABLE },
    { name: 'registry lacks list', registry: { list: null }, status: 501, code: UNAVAILABLE },
    { name: 'registry lacks count', registry: { count: null }, status: 501, code: UNAVAILABLE },
    { name: 'exact get names another sheet', registry: { get: async (input, store, prior) => (prior === 0 ? store.get(input) : { ...(await store.get(input)), sheetId: 'synthetic-other-sheet' }) }, status: 409, code: TARGET_REQUIRED },
    { name: 'exact get throws', registry: { get: async (input, store, prior) => { if (prior === 0) return store.get(input); throw new Error('SYN-private-registry-detail') } }, status: 503, code: UNAVAILABLE },
    { name: 'count over the cap', registry: { count: async () => 1001 }, status: 503, code: UNAVAILABLE },
    { name: 'count errors', registry: { count: boom }, status: 503, code: UNAVAILABLE },
    { name: 'list shorter than count', registry: { list: async () => [] }, status: 503, code: UNAVAILABLE },
    { name: 'list errors', registry: { list: boom }, status: 503, code: UNAVAILABLE },
    { name: 'count moves around list', registry: { count: async (input, store, prior) => (prior === 0 ? store.count(input) : 2) }, status: 503, code: UNAVAILABLE },
    { name: 'list carries a foreign tenant row', registry: { list: async (input, store) => [{ ...(await store.list(input))[0], tenantId: 'tenant-foreign' }] }, status: 503, code: UNAVAILABLE },
  ]
  for (const entry of cases) {
    for (const route of [`${BASE}/dry-run`, JOBS]) {
      const f = await ciMount({ ...(entry.options || {}), ...(entry.registry ? { projectRegistry: spyRegistry(registryLog(), entry.registry) } : {}) })
      const before = snapshotIo(f)
      const result = await f.call(route, { body: { parameters: PARAMS } })
      assertRefused(result, entry.status, entry.code, `${entry.name} ${route}`)
      assert.doesNotMatch(JSON.stringify(result.body), /SYN-private/)
      assertNoIoSince(f, before, `${entry.name} ${route}`)
    }
  }
})

test('opt-in HTTP: wrong-case project input is not alias-routed to the canonical registration', async () => {
  const f = await ciMount()
  const rows = clone(f.state[PROJECT_TARGET_TABLE])
  const before = snapshotIo(f)
  for (const route of [`${BASE}/dry-run`, JOBS]) {
    const result = await f.call(route, { body: { parameters: { projectNo: VARIANT } } })
    assert.equal(result.statusCode, 409, `${route}: ${JSON.stringify(result.body)}`)
    assert.match(result.body.error.code, /^(READ_PLAN_PROJECT_TARGET_REQUIRED|STOCK_PREPARATION_PROJECT_)/, JSON.stringify(result.body))
    assertNoIoSince(f, before, route)
  }
  assert.deepEqual(f.state[PROJECT_TARGET_TABLE], rows, 'the registry was neither read into an alias nor changed')
})

test('opt-in HTTP: absent or malformed projectNo never reaches the source (exact refusal codes are pinned by the runtime tests)', async () => {
  const f = await ciMount()
  const before = snapshotIo(f)
  for (const parameters of [{}, { projectNo: 7 }, { projectNo: '   ' }, { projectNo: null }]) {
    for (const route of [`${BASE}/dry-run`, JOBS]) {
      const result = await f.call(route, { body: { parameters } })
      assert.ok(result.statusCode >= 400, `${route} ${JSON.stringify(parameters)}: ${JSON.stringify(result.body)}`)
      assertNoIoSince(f, before, `${route} ${JSON.stringify(parameters)}`)
    }
  }
})

test('opt-in HTTP: a deployed case-insensitive plan with no verified tenant claim is refused before any registry read', async () => {
  const log = registryLog()
  const f = await ciMount({ active: false, deployReadPlan: { ...config().readPlan, ...CI_PLAN }, projectRegistry: spyRegistry(log) })
  const before = snapshotIo(f)
  const result = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS }, claimed: false })
  assert.equal(result.statusCode, 403, JSON.stringify(result.body))
  assert.equal(log.list, 0)
  assert.equal(log.count, 0)
  assertNoIoSince(f, before, 'claimless')
})

test('opt-in HTTP: forged projectIdentityRequired/targetPurpose in body or query cannot bypass the guard on dry-run and apply', async () => {
  const f = await ciMount()
  const dry = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  const token = dry.body.data.dryRunToken
  addCaseVariant(f, 'archived')
  const before = snapshotIo(f)
  const forged = { projectIdentityRequired: false, targetPurpose: 'source' }
  const requests = [
    [`${BASE}/dry-run`, { parameters: PARAMS }],
    [`${BASE}/apply`, { parameters: PARAMS, confirm: { dryRunToken: token } }],
  ]
  for (const [route, body] of requests) {
    const viaBody = await f.call(route, { body: { ...body, ...forged } })
    assert.ok(viaBody.statusCode >= 400, `${route} body: ${JSON.stringify(viaBody.body)}`)
    const viaQuery = await f.call(route, { body, query: { projectIdentityRequired: 'false', targetPurpose: 'source' } })
    assertRefused(viaQuery, 409, AMBIGUOUS, `${route} query`)
    assertNoIoSince(f, before, route)
  }
})

test('opt-in HTTP: duplicating the registry after real queued jobs is refused by the FULL stored-project recheck at run, approve and chunk', async () => {
  for (const stage of ['run', 'approve', 'chunk']) {
    const log = registryLog()
    const f = await ciMount({ projectRegistry: spyRegistry(log) })
    let request
    if (stage === 'chunk') {
      request = [`${JOBS}/:jobId/apply-jobs/:applyJobId/run`, { params: await expanded(f) }]
    } else {
      const start = await f.call(JOBS, { body: { parameters: PARAMS } })
      assert.equal(start.statusCode, 202, JSON.stringify(start.body))
      const params = { jobId: start.body.data.jobId }
      if (stage === 'approve') {
        assert.equal((await f.call(`${JOBS}/:jobId/run`, { params })).statusCode, 200)
        assert.equal((await f.call(`${JOBS}/:jobId/plan`, { params })).statusCode, 200)
        request = [`${JOBS}/:jobId/apply-jobs`, { params, body: { confirm: { acceptManualConfirmHold: true } } }]
      } else {
        request = [`${JOBS}/:jobId/run`, { params }]
      }
    }
    addCaseVariant(f, stage === 'approve' ? 'archived' : 'active')
    const before = snapshotIo(f)
    const listBefore = log.list
    const result = await f.call(...request)
    // AMBIGUOUS (not TARGET_REQUIRED) shows the stored job's projectNo reached the guard; the
    // readiness precheck, which carries no project, ran no registry check of its own.
    assertRefused(result, 409, AMBIGUOUS, stage)
    assertNoIoSince(f, before, stage)
    assert.equal(log.list, listBefore + 1, `${stage}: exactly one registry check, the full stored-project one`)
  }
})

test('registry-guard omission mutants are rejected by the real duplicate-registry oracle', async (t) => {
  const replace = (needle, value) => (source) => {
    assert.ok(source.includes(needle), `mutation seam is missing: ${needle}`)
    return source.replace(needle, value)
  }
  const oracle = async (fixture) => {
    addCaseVariant(fixture, 'active')
    const result = await fixture.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
    assertRefused(result, 409, AMBIGUOUS, 'oracle')
    assert.equal(fixture.calls.adapter.length, 0)
  }
  const cases = [
    {
      name: 'delete the guard call inside the runtime',
      routeDependencies: { './stock-preparation-read-plan-runtime.cjs': loadRuntimeCopy(replace('await assertCaseInsensitiveProjectIdentity({', 'void ({')) },
    },
    {
      name: 'force the server-fixed identity flag off',
      routeTransform: replace(
        `projectIdentityRequired: requireTarget && input.targetPurpose !== 'source' && input.targetPurpose !== 'readiness',`,
        'projectIdentityRequired: false,',
      ),
    },
    {
      name: 'stop forwarding the registry',
      routeTransform: replace('projectTargetStore: stockPreparationProjectTargets,', ''),
    },
  ]
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      // Healthy control on the unmodified route and runtime.
      await oracle(await ciMount())
      const mutated = await ciMount({ routeTransform: entry.routeTransform, routeDependencies: entry.routeDependencies })
      await assert.rejects(() => oracle(mutated), { name: 'AssertionError' })
    })
  }
})
