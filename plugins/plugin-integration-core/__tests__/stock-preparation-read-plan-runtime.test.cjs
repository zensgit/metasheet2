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
const registrationMetadataRuntime = require('../lib/stock-preparation-read-plan-runtime.cjs')
const { createStockPreparationSourceBindingStore, BINDING_TABLE } = require('../lib/stock-preparation-source-binding-store.cjs')
const { createStockPreparationProjectTargetStore, PROJECT_TARGET_TABLE } = require('../lib/stock-preparation-project-target-store.cjs')
const { deriveProjectSheetObjectId, PROJECT_SHEETS_ENABLED_ENV } = require('../lib/stock-preparation-project-targets.cjs')
const { ONLINE_READ_PLANS_ENABLED_ENV } = require('../lib/stock-preparation-read-plan-switch.cjs')
const { consumableMap } = require('./support/consumable-storage.cjs')
const lockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
const { wireRefreshGovernance } = require('./support/stock-preparation-refresh-governance-wiring.cjs')

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
  const env = { MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED: 'true', MULTITABLE_STOCK_PREP_ONLINE_READ_PLANS_ENABLED: 'true', ...extraEnv }
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
  readPlanExtra, sourceProject, sourceCaseInsensitive = false, projectRegistry, routeTransform, routeDependencies, governanceMissing = false,
  refreshOptions = {}, deploySystemId = SYSTEM } = {}) {
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
  const calls = { binding: [], listed: [], ledger: [], adapter: [], created: [], read: [], write: [], targetRead: [] }
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
    source: { externalSystemId: deploySystemId, kind: 'data-source:sql-readonly', workspaceId: sourceWorkspaceId,
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
      // S1b: the canonical-binding assert (switch ON) lists the set; this fixture's one row, complete.
      async listForAction({ tenantId, actionId }) { calls.listed.push({ tenantId, actionId }); return { bindings: [{ tenantId, actionId, workspaceId: matchedWorkspaceId, externalSystemId: SYSTEM }], complete: true } },
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
  // Use the real refresh stores/reader over synthetic memory IO and this suite's write lock. `refreshOptions` (S1
  // RT-RP1b only): one db for the store and the real lock (the decision transaction's in-transaction bump) and the
  // wiring's pack-install fake (a governed computation's strict pack read).
  const refreshGovernanceEnv = wireRefreshGovernance(services, refreshOptions)
  if (governanceMissing) {
    delete services.stockPreparationRefreshGovernance
    delete services.stockPreparationContinuationStore
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
  return { call, calls, ledger, state, version, action, storage, services, projectTargets, projectSheetId, projectObjectId, refreshGovernanceEnv }
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

test('refresh governance is required with online read plans ON and OFF before source, target or token IO', async () => {
  for (const value of ['true', undefined]) {
    const register = loadRoutes(undefined, {}, { [ONLINE_READ_PLANS_ENABLED_ENV]: value }).registerIntegrationRoutes
    const options = { register, deployReadPlan: config().readPlan }
    // The same declared read shape reaches the real planner in both switch states.
    const control = await mount(options)
    const accepted = await control.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
    assert.equal(accepted.statusCode, 200, `${String(value)} control: ${JSON.stringify(accepted.body)}`)
    assert.ok(accepted.body.data.dryRunToken)
    assert.equal(control.calls.read[0].object, 'SYN_PathLink')
    assert.equal(control.refreshGovernanceEnv.stepFourRowCount(), 0, 'a not-governed preview does not persist governance rows')
    const absent = await mount({ ...options, governanceMissing: true })
    const storageBefore = clone([...absent.storage])
    for (const route of [`${BASE}/dry-run`]) {
      const refused = await absent.call(route, { body: { parameters: PARAMS } })
      assert.equal(refused.statusCode, 501, `${String(value)} ${route}: ${JSON.stringify(refused.body)}`)
      assert.equal(refused.body.error.code, 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE')
      assert.equal(refused.body.error.details.reason, 'governance_service')
      assert.equal(absent.calls.read.length, 0)
      assert.equal(absent.calls.targetRead.length, 0)
      assert.equal(absent.calls.write.length, 0)
      assert.deepEqual([...absent.storage], storageBefore, 'no token is minted without governance')
      assert.equal(absent.refreshGovernanceEnv.stepFourRowCount(), 0)
    }
    if (value === undefined) assert.deepEqual(absent.calls.ledger, [], 'OFF still skips the online ledger')
  }
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
  // S1b: a genuinely matched workspace binding selects the SOURCE row only; the pointer is probed at the tenant
  // scope, the only scope it can occupy, so a tenant activation applies to it like to every other lane.
  for (const status of ['disabled', 'active', 'absent']) {
    const f = await mount({ register, matchedWorkspaceId: 'real-workspace' })
    if (status === 'disabled') await f.ledger.deactivate({ ...SCOPE, actionId: ACTION, actor: USER.id, expectedGeneration: 1 })
    if (status === 'absent') f.state[ACTIVATION_TABLE].length = 0
    const result = await f.call(PREFLIGHT, { method: 'GET', query: { externalSystemId: SYSTEM, workspaceId: 'real-workspace' } })
    assert.equal(f.calls.binding.length, 1)
    assert.deepEqual(f.calls.ledger.map((input) => input.workspaceId), [null], `${status}: the probe reads the tenant scope`)
    if (status === 'absent') {
      assert.equal(result.statusCode, 200, JSON.stringify(result.body))
      assert.equal(f.calls.adapter[0].workspaceId, 'real-workspace', 'the matched row is the source the preflight loads')
    } else {
      assert.equal(result.statusCode, 409, `${status}: ${JSON.stringify(result.body)}`)
      assert.equal(result.body.error.code, status === 'disabled' ? 'READ_PLAN_ACTIVATION_DISABLED' : 'READ_PLAN_ACTION_REQUIRED')
      assert.equal(f.calls.adapter.length, 0)
    }
  }
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
  const legacy = await resolveStockPreparationReadPlanExecution({ resolved, store: f.ledger, onlineReadPlansEnabled: true, verifyTenant() { throw new Error('legacy does not demand a new claim') } })
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
      // S1b: the pointer probe is the tenant scope's whatever the source scope, so the observable of a hint taking
      // over the resolved source scope is the row the adapter loads (no pointer: the preflight measures the source).
      name: 'use request hint for unconfigured preflight source scope',
      options: { unconfigured: true, active: false },
      transform: replace('exactSourceScope = await resolveUnconfiguredPreflightSourceScope({ tenantId, workspaceId, externalSystemId })', 'exactSourceScope = { tenantId, workspaceId: workspaceId || null }'),
      async oracle(f) {
        const result = await f.call(PREFLIGHT, { method: 'GET', query: { externalSystemId: SYSTEM, workspaceId: 'fallback-selector' } })
        assert.equal(result.statusCode, 200, JSON.stringify(result.body))
        assert.equal(f.calls.adapter[0].workspaceId, null, 'the resolved binding row (tenant level), never the request hint')
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

// Registration metadata is not execution authority. The real ledger below hashes and normalizes
// each saved config; only its in-memory status/pointer rows are fixtures. No source-validation
// receipt is minted, and the execution getter must never be called by this metadata helper.
async function registrationMetadataFixture(options = {}) {
  const { bindingScopes = [null, 'workspace-synthetic'], activeScope, deploymentWorkspace = null } = options
  const deploymentComparison = Object.hasOwn(options, 'deploymentComparison') ? options.deploymentComparison : 'case-sensitive'
  const activeComparison = Object.hasOwn(options, 'activeComparison') ? options.activeComparison : 'case-insensitive'
  const { db, state } = memoryDb()
  state[BINDING_TABLE] = bindingScopes.map((workspaceId) => ({ tenant_id: TENANT, workspace_id: workspaceId,
    action_id: ACTION, external_system_id: SYSTEM }))
  let sequence = 0
  const ledger = createStockPreparationReadPlanStore({ db, idGenerator: () => `synthetic-registration-${++sequence}` })
  if (activeScope !== undefined) {
    const plan = config(activeComparison === undefined ? {} : { sourceProjectComparison: activeComparison })
    const saved = await ledger.saveVersion({ tenantId: TENANT, workspaceId: activeScope, actor: USER.id, config: plan })
    state[VERSION_TABLE].find((row) => row.id === saved.id).status = 'approved'
    state[ACTIVATION_TABLE].push({ id: 'synthetic-registration-pointer', tenant_id: TENANT, workspace_id: activeScope,
      action_id: ACTION, system_id: SYSTEM, version_id: saved.id, content_key: saved.contentKey, generation: 1, status: 'active' })
  }
  const bindings = createStockPreparationSourceBindingStore({ db })
  const calls = { activation: [], version: [], bindings: [], execution: 0 }
  // `...via` forwards the F2 read-handle argument (`{ executor }`) to the real stores untouched; without one it is empty.
  const bindingStore = {
    ...bindings,
    async listForAction(input, ...via) { calls.bindings.push(clone(input)); return bindings.listForAction(input, ...via) },
  }
  const readPlanStore = {
    async getActivation(input, ...via) { calls.activation.push(clone(input)); return ledger.getActivation(input, ...via) },
    async getForRuntime(input, ...via) { calls.version.push(clone(input)); return ledger.getForRuntime(input, ...via) },
    async getActiveForRuntime() { calls.execution += 1; throw new Error('metadata cannot borrow execution validation') },
  }
  const deploymentPlan = config(deploymentComparison === undefined ? {} : { sourceProjectComparison: deploymentComparison }).readPlan
  const registry = createStockPreparationTableActionRegistry({ actions: [{ actionId: ACTION,
    source: { externalSystemId: SYSTEM, kind: 'data-source:sql-readonly', workspaceId: deploymentWorkspace, readPlan: deploymentPlan },
    target: { sheetId: 'synthetic-registration-target', objectId: 'syntheticRegistrationTarget', fieldIdMap: {} },
  }] })
  const deploymentAction = await registry.getTableAction({ tenantId: TENANT, actionId: ACTION, targetPurpose: 'readiness' })
  return { state, ledger, db, bindingStore, readPlanStore, deploymentAction, calls }
}

function registrationMetadata(fixture, overrides = {}) {
  assert.equal(typeof registrationMetadataRuntime.resolveStockPreparationProjectRegistrationComparison, 'function', 'registration uses a dedicated metadata export')
  return registrationMetadataRuntime.resolveStockPreparationProjectRegistrationComparison({ tenantId: TENANT, actionId: ACTION,
    deploymentAction: fixture.deploymentAction, bindingStore: fixture.bindingStore, readPlanStore: fixture.readPlanStore, onlineReadPlansEnabled: true, ...overrides })
}
const registrationMetadataUnavailable = (error) => error && error.status === 503
  && error.code === 'STOCK_PREPARATION_PROJECT_IDENTITY_UNAVAILABLE' && !/synthetic-private/.test(error.message)

test('registration metadata: deployment CI is strict even without ledger capability; CS/default no-pointer stays legacy', async () => {
  const strict = await registrationMetadataFixture({ deploymentComparison: 'case-insensitive' })
  assert.equal(await registrationMetadata(strict, { readPlanStore: undefined, bindingStore: { async listForAction() { throw new Error('must not weaken deployment CI') } } }), 'case-insensitive')
  assert.equal(strict.calls.execution, 0)
  for (const deploymentComparison of [undefined, 'case-sensitive']) {
    const f = await registrationMetadataFixture({ deploymentComparison })
    const result = await registrationMetadata(f)
    assert.ok(result === undefined || result === 'case-sensitive', 'legacy modes do not gain a CI registration constraint')
    assert.equal(f.calls.execution, 0)
    assert.deepEqual(f.calls.activation[0], { tenantId: TENANT, workspaceId: null, actionId: ACTION }, 'first proof always probes the tenant-null pointer')
    const absentBinding = await registrationMetadataFixture({ deploymentComparison })
    assert.ok([undefined, 'case-sensitive'].includes(await registrationMetadata(absentBinding, { bindingStore: undefined })), 'absence of binding capability does not imply unreadable bindings')
  }
})

test('registration metadata: real ledger and bindings find CI in null, bound and deployment workspaces without source validation', async () => {
  for (const activeScope of [null, 'workspace-synthetic', 'deployment-workspace']) {
    const f = await registrationMetadataFixture({ activeScope,
      ...(activeScope === 'deployment-workspace' ? { deploymentWorkspace: activeScope } : {}) })
    assert.equal(await registrationMetadata(f), 'case-insensitive')
    assert.equal(f.calls.execution, 0)
    assert.ok(f.calls.version.some((input) => input.workspaceId === activeScope), 'approved metadata was read in the exact pointer scope')
    assert.ok(f.calls.bindings.length >= 2, 'the complete real binding list is re-read before deciding')
    assert.ok(f.calls.activation.filter((input) => input.workspaceId === activeScope).length >= 2, 'the pointer is re-read before deciding')
    assert.equal(f.state[VALIDATION_TABLE].length, 0, 'metadata is usable without a source-validation receipt')
  }
})

test('registration metadata: malformed, truncated, duplicate or foreign bindings fail closed', async () => {
  const binding = (extra = {}) => ({ tenantId: TENANT, actionId: ACTION, workspaceId: 'workspace-synthetic', externalSystemId: SYSTEM, ...extra })
  const cases = [
    null, {}, { complete: false, bindings: [] }, { complete: true, bindings: {} },
    { complete: true, bindings: Array.from({ length: 65 }, (_, index) => binding({ workspaceId: `workspace-${index}` })) },
    { complete: true, bindings: [binding(), binding()] },
    ...[{ tenantId: 'foreign' }, { actionId: 'foreign' }, { workspaceId: ' bad ' }, { workspaceId: '' },
      { externalSystemId: '' }, { externalSystemId: ' bad ' }].map((extra) => ({ complete: true, bindings: [binding(extra)] })),
  ]
  for (const result of cases) {
    const f = await registrationMetadataFixture()
    await assert.rejects(registrationMetadata(f, { bindingStore: { async listForAction() { return result } } }), registrationMetadataUnavailable)
  }
  const f = await registrationMetadataFixture()
  await assert.rejects(registrationMetadata(f, { bindingStore: {} }), registrationMetadataUnavailable)
  await assert.rejects(registrationMetadata(f, { bindingStore: { async listForAction() { throw new Error('synthetic-private-binding') } } }), registrationMetadataUnavailable)
  const complete = await registrationMetadataFixture({ bindingScopes: Array.from({ length: 64 }, (_, index) => `workspace-${index}`) })
  assert.equal(await registrationMetadata(complete), 'case-sensitive', 'exactly 64 complete real bindings fit the supported bound')
  for (const workspaceId of ['', ' bad ', 7]) {
    const invalid = await registrationMetadataFixture()
    invalid.deploymentAction.source.workspaceId = workspaceId
    await assert.rejects(registrationMetadata(invalid), registrationMetadataUnavailable)
    assert.equal(invalid.calls.activation.length, 0, 'an invalid deployment scope fails before ledger IO')
  }
})

test('registration metadata: active pointer and approved content must agree in every identity field', async () => {
  const mutations = [
    ['pointer missing id', 'activation', (value) => ({ ...value, id: undefined })],
    ['pointer noncanonical id', 'activation', (value) => ({ ...value, id: ' bad ' })],
    ['pointer invalid hash', 'activation', (value) => ({ ...value, contentKey: 'not-a-content-key' })],
    ['pointer invalid status', 'activation', (value) => ({ ...value, status: 'unknown' })],
    ['pointer invalid generation', 'activation', (value) => ({ ...value, generation: 0 })],
    ['pointer tenant', 'activation', (value) => ({ ...value, tenantId: 'foreign' })],
    ['pointer workspace', 'activation', (value) => ({ ...value, workspaceId: 'foreign' })],
    ['pointer action', 'activation', (value) => ({ ...value, actionId: 'foreign' })],
    ['pointer version', 'activation', (value) => ({ ...value, versionId: 'foreign' })],
    ['pointer system', 'activation', (value) => ({ ...value, systemId: 'foreign' })],
    ['pointer content', 'activation', (value) => ({ ...value, contentKey: '0'.repeat(64) })],
    ['version tenant', 'version', (value) => ({ ...value, tenantId: 'foreign' })],
    ['version workspace', 'version', (value) => ({ ...value, workspaceId: 'foreign' })],
    ['version action', 'version', (value) => ({ ...value, actionId: 'foreign' })],
    ['version system', 'version', (value) => ({ ...value, systemId: 'foreign' })],
    ['version id', 'version', (value) => ({ ...value, id: 'foreign' })],
    ['version content', 'version', (value) => ({ ...value, contentKey: '0'.repeat(64) })],
    ['version approval', 'version', (value) => ({ ...value, status: 'draft' })],
    ['stored version config hash', 'stored-version', (value) => ({ ...value, config: { ...value.config, readPlan: { ...value.config.readPlan, maxReadCount: 101 } } })],
    ['stored version content key', 'stored-version', (value) => ({ ...value, content_key: '0'.repeat(64) })],
  ]
  for (const [label, kind, mutate] of mutations) {
    const f = await registrationMetadataFixture({ activeScope: null })
    if (kind === 'stored-version') {
      // Content integrity belongs to the real ledger's checkedRow contract. Mutate persisted
      // data before getForRuntime validates it, rather than inventing a dishonest producer.
      Object.assign(f.state[VERSION_TABLE][0], mutate(f.state[VERSION_TABLE][0]))
      await assert.rejects(registrationMetadata(f), registrationMetadataUnavailable, label)
      continue
    }
    const readPlanStore = { ...f.readPlanStore }
    const method = kind === 'activation' ? 'getActivation' : 'getForRuntime'
    readPlanStore[method] = async (input) => {
      const value = await f.readPlanStore[method](input)
      return value ? mutate(value) : value
    }
    await assert.rejects(registrationMetadata(f, { readPlanStore }), registrationMetadataUnavailable, label)
    assert.equal(f.calls.execution, 0)
  }
})

test('registration metadata: changed pointers or binding lists cannot authorize a stale registration decision', async () => {
  const f = await registrationMetadataFixture({ activeScope: null })
  let reads = 0
  const movingPointer = { ...f.readPlanStore, async getActivation(input) {
    const value = await f.readPlanStore.getActivation(input)
    if (input.workspaceId === null && ++reads > 1) return { ...value, generation: value.generation + 1 }
    return value
  } }
  await assert.rejects(registrationMetadata(f, { readPlanStore: movingPointer }), registrationMetadataUnavailable)
  const replaced = await registrationMetadataFixture({ activeScope: null })
  let ids = 0
  await assert.rejects(registrationMetadata(replaced, { readPlanStore: { ...replaced.readPlanStore, async getActivation(input) {
    const value = await replaced.readPlanStore.getActivation(input)
    if (input.workspaceId === null && ++ids > 1) return { ...value, id: 'synthetic-replaced-pointer' }
    return value
  } } }), registrationMetadataUnavailable, 'a replaced pointer is a change even when its content stays the same')
  const other = await registrationMetadataFixture({ activeScope: 'workspace-synthetic' })
  let lists = 0
  const movingBindings = { ...other.bindingStore, async listForAction(input) {
    const value = await other.bindingStore.listForAction(input)
    if (++lists > 1) return { ...value, bindings: value.bindings.filter((row) => row.workspaceId === null) }
    return value
  } }
  await assert.rejects(registrationMetadata(other, { bindingStore: movingBindings }), registrationMetadataUnavailable)
})

test('registration metadata: only the first null activation exact 42P01 proves a pre-ledger deployment', async () => {
  const missing = () => Object.assign(new Error('synthetic-private-missing-table'), { code: '42P01' })
  const first = await registrationMetadataFixture()
  let initialReads = 0
  const legacy = await registrationMetadata(first, { readPlanStore: {
    async getActivation(input) { initialReads += 1; assert.equal(input.workspaceId, null); throw missing() },
    async getForRuntime() { throw new Error('must not read versions after first table-absent proof') },
  }, bindingStore: { async listForAction() { throw new Error('must not list after first table-absent proof') } } })
  assert.ok(legacy === undefined || legacy === 'case-sensitive')
  assert.equal(initialReads, 1)
  for (const readPlanStore of [undefined, {}, { async getActivation() { throw new Error('synthetic-private-driver') } },
    { async getActivation() { throw Object.assign(new Error('synthetic-private-other'), { code: '42P01-extra' }) } }]) {
    await assert.rejects(registrationMetadata(await registrationMetadataFixture(), { readPlanStore }), registrationMetadataUnavailable)
  }
  const later = await registrationMetadataFixture()
  await assert.rejects(registrationMetadata(later, { readPlanStore: { ...later.readPlanStore, async getActivation(input) {
    if (input.workspaceId !== null) throw missing()
    return null
  } } }), registrationMetadataUnavailable, 'a later workspace activation table error is unavailable, not legacy')
  const versions = await registrationMetadataFixture({ activeScope: null })
  await assert.rejects(registrationMetadata(versions, { readPlanStore: { ...versions.readPlanStore, async getForRuntime() { throw missing() } } }), registrationMetadataUnavailable, 'missing versions never imply absent activation table')
  await assert.rejects(registrationMetadata(await registrationMetadataFixture(), { bindingStore: { async listForAction() { throw missing() } } }), registrationMetadataUnavailable)
})

// F2: under the registry lock the project-target store hands the comparison its transaction (`executor`); every read
// must ride it. The executor here is the same synthetic database read through its own handle, and the stores' own db
// is starved (every read there fails), as a pool is while blocking takers of the registry lock hold its connections.
test('registration metadata (F2): with an executor EVERY read rides it — first activation, both listings, both pointer rounds, the version — none reaches the stores\' own db; without one nothing changes', async () => {
  const f = await registrationMetadataFixture({ activeScope: 'workspace-synthetic' })
  const own = { selectOne: f.db.selectOne, select: f.db.select }
  const onExecutor = []
  const executor = {
    async selectOne(table, where) { onExecutor.push(table); return own.selectOne(table, where) },
    async select(table, options) { onExecutor.push(table); return own.select(table, options) },
  }
  const onPool = []
  f.db.selectOne = async (table) => { onPool.push(table); throw new Error('synthetic-private-pool-exhausted') }
  f.db.select = async (table) => { onPool.push(table); throw new Error('synthetic-private-pool-exhausted') }
  assert.equal(await registrationMetadata(f, { executor }), 'case-insensitive')
  assert.deepEqual(onPool, [], 'no read on the stores\' own db')
  const tally = (table) => onExecutor.filter((name) => name === table).length
  // null + bound workspace: first null read, the bound pointer, both again in the stability round; two listings; one version.
  assert.deepEqual([tally(ACTIVATION_TABLE), tally(BINDING_TABLE), tally(VERSION_TABLE)], [4, 2, 1])
  assert.equal(onExecutor.length, 7, 'nothing else was read')
  assert.deepEqual([f.calls.activation.length, f.calls.bindings.length, f.calls.version.length, f.calls.execution], [4, 2, 1, 0])
  // Control: the starvation is live — the same comparison without the executor is the typed 503.
  await assert.rejects(registrationMetadata(f), registrationMetadataUnavailable)
  // Without an executor every store read is called exactly as before: one argument, on the stores' own db.
  const plain = await registrationMetadataFixture({ activeScope: 'workspace-synthetic' })
  const arity = []
  for (const [store, method] of [[plain.readPlanStore, 'getActivation'], [plain.readPlanStore, 'getForRuntime'], [plain.bindingStore, 'listForAction']]) {
    const read = store[method]
    store[method] = async (...args) => { arity.push(args.length); return read(...args) }
  }
  assert.equal(await registrationMetadata(plain), 'case-insensitive')
  assert.deepEqual(arity, [1, 1, 1, 1, 1, 1, 1], 'seven reads, none handed a second argument')
  for (const executorless of [undefined, null]) {
    assert.equal(await registrationMetadata(plain, { executor: executorless }), 'case-insensitive', `${String(executorless)} is no executor`)
  }
  assert.ok(arity.slice(7).every((count) => count === 1), 'undefined / null hand nothing on')
})

test('registration metadata (F2): a handed handle that cannot read is refused by the stores — never swapped for their own db — and the comparison answers the typed 503', async () => {
  const f = await registrationMetadataFixture({ activeScope: null })
  const scope = { tenantId: TENANT, workspaceId: null, actionId: ACTION }
  const versionScope = { tenantId: TENANT, workspaceId: null, id: f.state[VERSION_TABLE][0].id, actionId: ACTION, systemId: SYSTEM }
  for (const executor of [{}, { select() {} }, 'synthetic-handle']) {
    await assert.rejects(f.ledger.getActivation(scope, { executor }), /a read executor must expose selectOne/)
    await assert.rejects(f.ledger.getForRuntime(versionScope, { executor }), /a read executor must expose selectOne/)
  }
  for (const executor of [{}, { selectOne() {} }, 'synthetic-handle']) {
    await assert.rejects(f.bindingStore.listForAction({ tenantId: TENANT, actionId: ACTION }, { executor }), /a list executor must expose select/)
  }
  // Absent / null: the store's own db, exactly as before.
  for (const options of [undefined, {}, { executor: null }, { executor: undefined }]) {
    assert.equal((await f.ledger.getActivation(scope, options)).status, 'active')
    assert.equal((await f.ledger.getForRuntime(versionScope, options)).status, 'approved')
    assert.equal((await f.bindingStore.listForAction({ tenantId: TENANT, actionId: ACTION }, options)).complete, true)
  }
  const poolReads = []
  for (const name of ['selectOne', 'select']) {
    const read = f.db[name]
    f.db[name] = async (...args) => { poolReads.push(name); return read(...args) }
  }
  for (const executor of [{}, { select() {} }]) {
    await assert.rejects(registrationMetadata(f, { executor }), registrationMetadataUnavailable)
  }
  assert.deepEqual(poolReads, [], 'an unusable handle never falls back to the stores\' own db')
})

test('registration metadata (F2): on a handed transaction an exact 42P01 is the typed 503 by name — never the pre-ledger answer — and nothing more is read on the aborted transaction', async () => {
  const missing = () => Object.assign(new Error('synthetic-private-missing-table'), { code: '42P01' })
  // The real stores over an executor whose first statement fails 42P01: PostgreSQL has aborted that transaction.
  const f = await registrationMetadataFixture()
  let statements = 0
  const aborted = {
    async selectOne() { statements += 1; throw missing() },
    async select() { statements += 1; throw new Error('must not read on an aborted transaction') },
  }
  await assert.rejects(registrationMetadata(f, { executor: aborted }), registrationMetadataUnavailable)
  assert.equal(statements, 1, 'one statement, then nothing on the aborted transaction')
  assert.deepEqual([f.calls.activation.length, f.calls.bindings.length, f.calls.version.length], [1, 0, 0])
  // The same first-null 42P01 store as the pre-ledger case above: refused with an executor, still legacy without one.
  const first = await registrationMetadataFixture()
  let initialReads = 0
  const readPlanStore = {
    async getActivation(input) { initialReads += 1; assert.equal(input.workspaceId, null); throw missing() },
    async getForRuntime() { throw new Error('must not read versions after a 42P01') },
  }
  const bindingStore = { async listForAction() { throw new Error('must not list after a 42P01') } }
  await assert.rejects(registrationMetadata(first, { readPlanStore, bindingStore, executor: { async selectOne() {}, async select() {} } }), registrationMetadataUnavailable)
  assert.equal(initialReads, 1)
  const legacy = await registrationMetadata(first, { readPlanStore, bindingStore })
  assert.ok(legacy === undefined || legacy === 'case-sensitive', 'without an executor the pre-ledger answer is unchanged')
  assert.equal(initialReads, 2)
})

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
  resolved: unitResolved('case-insensitive'), store: noPointer, verifyTenant: () => TENANT, projectNo: 'Abc', onlineReadPlansEnabled: true, ...extra,
})
const refusal = (status, code) => ({ status, code, message: code })

test('runtime: absent/case-sensitive modes and the server-internal exemption make no registry or verifyTenant call', async () => {
  const claim = () => { throw new Error('no new tenant claim is demanded here') }
  for (const comparison of [undefined, 'case-sensitive']) {
    const registry = fakeRegistry([targetRow()])
    const result = await resolveStockPreparationReadPlanExecution({ resolved: unitResolved(comparison), store: noPointer, verifyTenant: claim, projectTargetStore: registry, onlineReadPlansEnabled: true })
    assert.equal(result.action.source.externalSystemId, SYSTEM)
    assert.deepEqual(registry.calls, [], String(comparison))
  }
  const registry = fakeRegistry([targetRow()])
  await resolveStockPreparationReadPlanExecution({ resolved: unitResolved('case-insensitive'), store: noPointer, verifyTenant: claim, projectTargetStore: registry, projectIdentityRequired: false, onlineReadPlansEnabled: true })
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

// ── Online read plans switched OFF (stock-preparation-read-plan-switch.cjs) ────────────────────────────────────────
// Off is the default: no activation pointer is read anywhere, the deployment action executes, and an in-flight
// request still carrying a read-plan execution identity is refused.
test('switch OFF: the real dry-run route reads no activation pointer and never executes the online plan', async () => {
  for (const value of [undefined, 'false', 'TRUE', ' true']) {
    const off = loadRoutes(undefined, {}, { [ONLINE_READ_PLANS_ENABLED_ENV]: value })
    const f = await mount({ register: off.registerIntegrationRoutes })
    assert.ok(f.version, 'an approved online plan IS active in the ledger')
    await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
    assert.deepEqual(f.calls.ledger, [], `${String(value)}: no activation pointer is read`)
    assert.ok(f.calls.read.every((read) => !String(read.object).startsWith('SYN_')), `${String(value)}: the online plan's objects are never read`)
  }
})

test('switch OFF: the runtime resolver skips the store, keeps the deployment action, and refuses an in-flight read-plan identity', async () => {
  const touched = []
  const throwing = { async getActiveForRuntime(input) { touched.push(input); throw new Error('synthetic-private-store') } }
  const result = await resolveStockPreparationReadPlanExecution({ resolved: unitResolved(undefined), store: throwing, verifyTenant: () => TENANT })
  assert.equal(result.action.source.externalSystemId, SYSTEM)
  assert.equal(result.sourceValidation, null)
  for (const flag of [undefined, false, 'true', 1]) {
    await resolveStockPreparationReadPlanExecution({ resolved: unitResolved(undefined), store: throwing, verifyTenant: () => TENANT, onlineReadPlansEnabled: flag })
  }
  assert.deepEqual(touched, [], 'only literal true reads the store')
  const resolved = unitResolved(undefined)
  const snapshotAction = { ...resolved.action, readPlanExecutionIdentity: { generation: 1 } }
  await assert.rejects(resolveStockPreparationReadPlanExecution({ resolved, store: throwing, snapshotAction, verifyTenant: () => TENANT }),
    { status: 409, code: 'READ_PLAN_ACTIVATION_MISSING' })
  assert.deepEqual(touched, [])
})

test('switch OFF: the registration comparison is the deployment answer and reads no online scope', async () => {
  // An online case-insensitive plan IS active at the tenant-null scope; the deployment says case-sensitive.
  const fixture = await registrationMetadataFixture({ activeScope: null })
  const on = await registrationMetadata(fixture)
  assert.equal(on, 'case-insensitive', 'control: with the switch on the online plan tightens the deployment')
  fixture.calls.activation.length = 0
  fixture.calls.version.length = 0
  fixture.calls.bindings.length = 0
  for (const flag of [undefined, false, 'true']) {
    const off = await registrationMetadata(fixture, { onlineReadPlansEnabled: flag })
    assert.equal(off, 'case-sensitive', `${String(flag)}: the deployment's answer`)
  }
  assert.deepEqual([fixture.calls.activation, fixture.calls.version, fixture.calls.bindings], [[], [], []], 'no pointer, version or binding read')
  const failing = { async getActivation() { throw new Error('synthetic-private-ledger') }, async getForRuntime() { throw new Error('synthetic-private-ledger') } }
  assert.equal(await registrationMetadata(fixture, { readPlanStore: failing, onlineReadPlansEnabled: false }), 'case-sensitive', 'a failing ledger cannot refuse it')
})

test('switch OFF: unconfigured source-preflight skips the activation probe; ON the same active plan refuses READ_PLAN_ACTION_REQUIRED', async () => {
  for (const [value, expected] of [['true', 409], [undefined, 200], ['false', 200]]) {
    const loaded = loadRoutes(undefined, {}, { [ONLINE_READ_PLANS_ENABLED_ENV]: value })
    const register = (args) => {
      args.context.config.stockPreparationTableActions = []
      loaded.registerIntegrationRoutes(args)
    }
    const f = await mount({ register })
    const result = await f.call(PREFLIGHT, { method: 'GET', query: { externalSystemId: SYSTEM } })
    assert.equal(result.statusCode, expected, `${String(value)}: ${JSON.stringify(result.body)}`)
    if (expected === 409) {
      assert.equal(result.body.error.code, 'READ_PLAN_ACTION_REQUIRED')
      assert.equal(f.calls.ledger.length, 1)
      assert.equal(f.calls.read.length, 0)
    } else {
      assert.deepEqual(f.calls.ledger, [], `${String(value)}: no activation pointer is read`)
      assert.ok(f.calls.read.length > 0, 'the deployment source is measured as before')
    }
  }
})

// The route module reads the switch per call; this loader hands it a live env object instead of a frozen literal.
function loadRoutesWithLiveEnv(env) {
  const routeModule = new Module(routePath, module)
  routeModule.filename = routePath
  routeModule.paths = Module._nodeModulePaths(path.dirname(routePath))
  routeModule.liveEnv = env
  routeModule._compile(`const process = { env: module.liveEnv };\n${routeSource}`, routePath)
  return routeModule.exports
}
const liveSwitchEnv = () => ({ MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED: 'true', [ONLINE_READ_PLANS_ENABLED_ENV]: 'true' })
const ioCounts = (f) => ({ ledger: f.calls.ledger.length, adapter: f.calls.adapter.length, created: f.calls.created.length,
  read: f.calls.read.length, targetRead: f.calls.targetRead.length, write: f.calls.write.length })

test('switch flips at run time (dry-run token): an ON token is refused under OFF before IO and unconsumed; ON again the still-active plan applies it', async () => {
  const env = liveSwitchEnv()
  const f = await mount({ register: loadRoutesWithLiveEnv(env).registerIntegrationRoutes })
  const dry = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  const token = dry.body.data.dryRunToken
  assert.ok(token)
  assert.equal(f.calls.read[0].object, 'SYN_PathLink', 'ON: the online plan executes')

  delete env[ONLINE_READ_PLANS_ENABLED_ENV]
  const before = ioCounts(f)
  const storageBefore = clone([...f.storage])
  const refused = await f.call(`${BASE}/apply`, { body: { parameters: PARAMS, confirm: { dryRunToken: token } } })
  assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
  // The token is bound to the plan-composed action; OFF recomposes the deployment action, so the binding no longer matches.
  assert.equal(refused.body.error.code, 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH')
  assert.deepEqual(ioCounts(f), before, 'OFF: no pointer read, no adapter, no source or target read, no write')
  assert.deepEqual([...f.storage], storageBefore, 'OFF: the token is not consumed')
  await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
  assert.equal(f.calls.ledger.length, before.ledger, 'OFF: a fresh dry-run reads no pointer either')
  assert.ok(f.calls.read.slice(before.read).every((read) => !String(read.object).startsWith('SYN_')), 'OFF: the online plan is not executed')

  env[ONLINE_READ_PLANS_ENABLED_ENV] = 'true'
  const resumed = await f.call(`${BASE}/apply`, { body: { parameters: PARAMS, confirm: { dryRunToken: token } } })
  assert.equal(resumed.statusCode, 200, `ON again: the pointer was never deleted, so the original token applies: ${JSON.stringify(resumed.body)}`)
  assert.ok(f.calls.ledger.length > before.ledger, 'ON again: the pointer is read')
  assert.equal(f.calls.write.length, before.write + 1)
})

test('switch flips at run time (large-BOM job): every stored stage minted under ON is refused READ_PLAN_ACTIVATION_MISSING under OFF before IO', async () => {
  const env = liveSwitchEnv()
  const f = await mount({ register: loadRoutesWithLiveEnv(env).registerIntegrationRoutes })
  const params = await expanded(f)
  delete env[ONLINE_READ_PLANS_ENABLED_ENV]
  const before = ioCounts(f)
  const storageBefore = clone([...f.storage])
  for (const suffix of ['/run', '/plan', '/apply-jobs', '/apply-jobs/:applyJobId/run']) {
    const result = await f.call(`${JOBS}/:jobId${suffix}`, { params })
    assert.equal(result.statusCode, 409, `${suffix}: ${JSON.stringify(result.body)}`)
    assert.equal(result.body.error.code, 'READ_PLAN_ACTIVATION_MISSING', suffix)
  }
  assert.deepEqual(ioCounts(f), before, 'OFF: no pointer read, no adapter, no source or target read, no write')
  assert.deepEqual([...f.storage], storageBefore, 'OFF: stored jobs are unchanged')
})

// ── S1 / N4 (review candidate): the confirm stamps what the hint-less lanes verify ─────────────────────────────────
// With the switch ON the decision route's confirm resolves the EFFECTIVE action of the hint-less lanes (its own
// helper, http-routes.cjs resolveStockPreparationEffectiveActionForScope); the decision-route suite pins each
// route answer (RT-RP1..RT-RP8). This suite closes the loop on the real ledger: what the confirm stamps is what the
// next hint-less governed computation verifies the relationship against.
const DECISIONS = '/api/integration/stock-preparation/projects/:projectNo/refresh'

test('RT-RP1b (S1) route-level closure: switch ON, a real activation — a candidate confirmed through the decision route, then ONE hint-less governed dry-run through the route: its reconcile verifies that relationship\'s source step as valid, never source_scope_changed', async () => {
  const pairing = require('../lib/stock-preparation-continuation-pairing.cjs')
  const refreshKit = require('./support/stock-preparation-refresh-store-kit.cjs')
  const f = await mount({ projectSheets: true, refreshOptions: { lockOnRefreshDb: true, wirePackInstallStore: true } })
  const env = f.refreshGovernanceEnv
  // A governed lane lists every binding of the (tenant, action) first (R-1): this fixture's one tenant-level row.
  f.services.stockPreparationSourceBindingStore.listForAction = async ({ tenantId, actionId }) => ({
    bindings: [{ tenantId, actionId, workspaceId: null, externalSystemId: SYSTEM }], complete: true,
  })
  // The decision writes its audit row on the store's transaction handle.
  f.services.stockPreparationAuditStore.appendWithin = async () => ({ ok: true })
  // The pilot marker, seeded on the registry row directly (pilot enable is impossible on this build).
  const registryRow = f.state[PROJECT_TARGET_TABLE].find((row) => row.project_no === PARAMS.projectNo)
  Object.assign(registryRow, { pilot_enabled_at: new Date('2026-10-27T00:00:00Z'), pilot_enabled_by: USER.id, pilot_readiness_version: 1 })
  // The refresh kit's canonical candidate, moved onto this fixture's project number (every key names it).
  const fixture = await refreshKit.candidateHoldFixture()
  const hold = JSON.parse(JSON.stringify(fixture.hold).split(fixture.projectNo).join(PARAMS.projectNo))
  hold.fingerprint = pairing.holdFingerprint(hold)
  const scope = { tenantId: TENANT, sheetId: f.projectSheetId, projectNo: PARAMS.projectNo }
  await env.seedHolds(scope, [hold])
  const candidateRow = env.rows('hold').find((row) => row.fingerprint === hold.fingerprint && row.status === 'open')
  assert.ok(candidateRow, 'the candidate hold is open')
  // Read the whole hold (every pair page) through the decision route, then confirm it there.
  const params = { projectNo: PARAMS.projectNo }
  const first = await f.call(`${DECISIONS}/holds`, { method: 'GET', params })
  assert.equal(first.statusCode, 200, JSON.stringify(first.body))
  let receipt = first.body.data.readReceipt
  const entry = first.body.data.page.holds.find((item) => item.id === candidateRow.id)
  for (let index = 1; index < (entry && entry.pairPage ? entry.pairPage.count : 1); index += 1) {
    const next = await f.call(`${DECISIONS}/holds`, { method: 'GET', params, query: { holdId: candidateRow.id, pairCursor: index, receipt: receipt.id } })
    assert.equal(next.statusCode, 200, JSON.stringify(next.body))
    receipt = next.body.data.readReceipt
  }
  const ledgerBefore = f.calls.ledger.length
  const confirmed = await f.call(`${DECISIONS}/continuations/confirm`, { params, body: {
    confirmProjectNo: PARAMS.projectNo, holdId: candidateRow.id, holdFingerprint: hold.fingerprint,
    comparisonFingerprint: hold.comparisonFingerprint, evidenceFingerprint: hold.evidenceFingerprint, candidateId: hold.pairingFingerprint,
    readReceipt: receipt.id, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true },
  } })
  assert.equal(confirmed.statusCode, 201, JSON.stringify(confirmed.body))
  const confirmLedgerReads = f.calls.ledger.slice(ledgerBefore)
  const continuationId = confirmed.body.data.continuationId
  // ONE hint-less governed computation through the route: no workspaceId query, the verified claim.
  const dry = await f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS } })
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  const continuation = env.rows('continuation').find((row) => row.id === continuationId)
  assert.ok(continuation && continuation.last_verified_at, 'the computation reconciled and verified the relationship')
  const verification = env.rows('hold').find((row) => row.continuation_id === continuationId && row.status === 'open')
  assert.ok(verification, 'the reconcile persisted the relationship\'s verification hold')
  // The source step is evaluated first and on its own (continuation-pairing.cjs verifyContinuation): the verdict
  // may name this fixture's BOM (not the kit's), the source step may not.
  assert.equal(verification.detail.steps.source, 'valid', 'the confirm stamped the identity the hint-less lane verifies against')
  assert.notEqual(continuation.last_verdict, 'source_scope_changed')
  // And the confirm itself read the real activation exactly once, at the tenant scope.
  assert.deepEqual(confirmLedgerReads.map((input) => input.workspaceId), [null], 'the confirm read the real activation once')
})

// The call-site guard skips helpers, so the hint-less lookup of the S1 helper is pinned here (RT-RP8 pins it by
// behaviour): workspace null, the lanes' verified-claim check, the switch-ON resolution — and both callers gate on
// the per-request switch; only the confirm handler opts in.
function assertEffectiveActionAnchor(source) {
  const start = source.indexOf('  async function resolveStockPreparationEffectiveActionForScope(req, { tenantId, projectNo, targetPurpose }) {')
  assert.notEqual(start, -1, 'the S1 helper exists')
  const helper = source.slice(start, source.indexOf('\n  }\n', start))
  assert.match(helper, /await tableActions\.getTableActionForExecution\(\{ tenantId, workspaceId: null, actionId: PLM_STOCK_PREPARATION_ACTION_ID, projectNo, targetPurpose \}\)/, 'the hint-less lookup')
  assert.match(helper, /verifyTenant: \(\) => resolveVerifiedClaimTenantId\(req, \{ tenantId \}\),/, 'the lanes\' verified-claim check')
  assert.match(helper, /\n {6}onlineReadPlansEnabled: true,\n/, 'the resolution is switch-ON by construction')
  assert.match(source, /const action = effectiveReadPlan && onlineReadPlansEnabled\(\)\n {6}\? assertStockPreparationTargetReady\(await resolveStockPreparationEffectiveActionForScope\(req, /, 'the decision context gates on the per-request switch')
  assert.match(source, /specSlotReadPlans: async \(\) => \(onlineReadPlansEnabled\(\)\n {8}\? \[action\.source\.readPlan, \(await resolveStockPreparationEffectiveActionForScope\(req, /, 'the readiness dep gates on the per-request switch')
  assert.equal(source.split('effectiveReadPlan: true })').length - 1, 1, 'one handler opts in')
  assert.match(source, /async stockPreparationRefreshContinuationConfirm\(req, res\) \{[^]*?effectiveReadPlan: true \}\)\n {6}return sendOk\(res, await stockPreparationRefreshDecisions\.confirm\(ctx, input\), 201\)/, 'and it is the confirm handler')
}

test('S1 anchor: the effective-action helper and its two gated callers, with a self-mutation pair (each seam mutated is refused)', () => {
  assertEffectiveActionAnchor(routeSource)
  for (const [label, needle, value] of [
    ['a request workspace hint', 'getTableActionForExecution({ tenantId, workspaceId: null, actionId', 'getTableActionForExecution({ tenantId, workspaceId: resolveWorkspaceId(req, {}), actionId'],
    ['the carried tenant', 'verifyTenant: () => resolveVerifiedClaimTenantId(req, { tenantId }),', 'verifyTenant: () => tenantId,'],
    ['a switch-OFF resolution', '      onlineReadPlansEnabled: true,\n    })\n    return execution.action', '      onlineReadPlansEnabled: false,\n    })\n    return execution.action'],
    ['an ungated decision context', 'const action = effectiveReadPlan && onlineReadPlansEnabled()', 'const action = effectiveReadPlan'],
    ['an ungated readiness dep', 'specSlotReadPlans: async () => (onlineReadPlansEnabled()', 'specSlotReadPlans: async () => (true'],
    ['the confirm opting out', 'decisionMigration, effectiveReadPlan: true })', 'decisionMigration })'],
  ]) {
    assert.equal(routeSource.split(needle).length - 1, 1, `${label}: the seam is unique`)
    assert.throws(() => assertEffectiveActionAnchor(routeSource.replace(needle, value)), { name: 'AssertionError' }, label)
  }
})

// ── S1b (review candidate): read-plan scope parity ──────────────────────────────────────────────────────────────────
// The activation pointer is read at the tenant scope whatever binding row matched (a pointer can exist only at
// (tenant, null)); the matched row selects the source row only. With the switch ON every executing lane and the S1
// confirm first require ONE agreeing source in the binding set (http-routes.cjs
// assertStockPreparationSourceBindingCanonical), before any pointer, lock or source read.
const S1B_WS = 'real-workspace'
const S1B_OTHER = 'other-source'
const SPLIT = 'READ_PLAN_SOURCE_BINDING_SPLIT'
const dryRun = (f, hint) => f.call(`${BASE}/dry-run`, { body: { parameters: PARAMS }, ...(hint === undefined ? {} : { query: { workspaceId: hint } }) })

// The REAL source-binding store over its own synthetic memory rows ([workspaceId, externalSystemId] each), patched
// onto the service object the routes captured at mount. `seed` replaces the rows.
function useRealBindings(f, rows) {
  const { db, state } = memoryDb()
  const real = createStockPreparationSourceBindingStore({ db })
  const seed = (list) => {
    state[BINDING_TABLE] = list.map(([workspaceId, externalSystemId]) => ({ tenant_id: TENANT, workspace_id: workspaceId, action_id: ACTION, external_system_id: externalSystemId }))
  }
  seed(rows)
  const store = f.services.stockPreparationSourceBindingStore
  store.get = async (input) => { f.calls.binding.push(clone(input)); return real.get(input) }
  store.listForAction = async (input) => { f.calls.listed.push(clone(input)); return real.listForAction(input) }
  return { seed }
}

// Every read-plan execution identity the stored dry-run token record carries.
function storedIdentities(fixture, token) {
  const found = []
  const walk = (value) => {
    if (typeof value === 'string') {
      let parsed = null
      try { parsed = JSON.parse(value) } catch (error) { return }
      if (parsed && typeof parsed === 'object') walk(parsed)
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'readPlanExecutionIdentity') found.push(inner)
        else walk(inner)
      }
    }
  }
  for (const [key, value] of fixture.storage) if (key.includes(token)) walk(value)
  return found
}

function assertSplit(result, reason, label) {
  assertRefused(result, 409, SPLIT, label)
  assert.deepEqual({ ...result.body.error.details }, { actionId: ACTION, reason }, label)
}

test('PAR-U1 (S1b) registry: the activation scope is the tenant\'s whatever row matched (or whatever the deployment declares); the matched row still selects the source scope', async () => {
  const f = await mount({ active: false })
  const registry = createStockPreparationTableActionRegistry({ actions: [f.action], resolveSourceBinding: async () => ({ externalSystemId: SYSTEM, matchedWorkspaceId: S1B_WS, scopeFallback: null }) })
  const resolved = await registry.getTableActionForExecution({ tenantId: TENANT, workspaceId: S1B_WS })
  assert.deepEqual(resolved.bindingScope, { tenantId: TENANT, workspaceId: null }, 'the activation scope')
  assert.deepEqual(resolved.sourceScope, { tenantId: TENANT, workspaceId: S1B_WS }, 'the matched row selects the source row')
  assert.deepEqual(resolved.legacySourceScope, { tenantId: TENANT, workspaceId: S1B_WS })
  const declared = createStockPreparationTableActionRegistry({ actions: [{ ...f.action, source: { ...f.action.source, workspaceId: 'ws-declared' } }] })
  const r1 = await declared.getTableActionForExecution({ tenantId: TENANT })
  assert.deepEqual(r1.bindingScope, { tenantId: TENANT, workspaceId: null }, 'R1 with a declared source workspace: still the tenant scope')
  assert.equal(r1.sourceScope.workspaceId, 'ws-declared')
})

test('PAR-U2 (S1b) runtime: SCOPE_MISMATCH names the tenant and the DEPLOYMENT-declared source workspace only; a workspace (or missing) activation scope is refused before any store call', async () => {
  const f = await mount()
  const touched = []
  const store = { async getActiveForRuntime(input) { touched.push(clone(input)); return f.ledger.getActiveForRuntime(input) } }
  const resolvedWith = async ({ action = f.action, bindingScope, sourceScope } = {}) => {
    const registry = createStockPreparationTableActionRegistry({ actions: [action], resolveSourceBinding: async () => ({ externalSystemId: SYSTEM, matchedWorkspaceId: null, scopeFallback: 'tenant_null_row' }) })
    const resolved = await registry.getTableActionForExecution({ tenantId: TENANT })
    if (bindingScope !== undefined) resolved.bindingScope = bindingScope
    if (sourceScope !== undefined) resolved.sourceScope = sourceScope
    return resolved
  }
  const run = (resolved) => resolveStockPreparationReadPlanExecution({ resolved, store, verifyTenant: () => TENANT, projectIdentityRequired: false, onlineReadPlansEnabled: true })
  // (a) a matched workspace in the SOURCE scope no longer refuses: the tenant pointer executes, the source row stays there.
  const a = await run(await resolvedWith({ sourceScope: { tenantId: TENANT, workspaceId: 'W' } }))
  assert.equal(a.action.readPlanExecutionIdentity.workspaceId, null)
  assert.deepEqual(a.sourceScope, { tenantId: TENANT, workspaceId: 'W' })
  assert.deepEqual(touched.map((input) => input.workspaceId), [null])
  // (b) a deployment that declares source.workspaceId still refuses (fail-closed; the route leg at the top of this suite).
  await assert.rejects(run(await resolvedWith({ action: { ...f.action, source: { ...f.action.source, workspaceId: 'different-workspace' } } })),
    { status: 409, code: 'READ_PLAN_EXECUTION_SCOPE_MISMATCH' })
  // (c) a source scope of another tenant
  await assert.rejects(run(await resolvedWith({ sourceScope: { tenantId: 'other-tenant', workspaceId: null } })),
    { status: 409, code: 'READ_PLAN_EXECUTION_SCOPE_MISMATCH' })
  // (d) a workspace activation scope, (e) an undefined one: refused with no store call
  touched.length = 0
  for (const workspaceId of ['W', undefined]) {
    await assert.rejects(run(await resolvedWith({ bindingScope: { tenantId: TENANT, workspaceId } })),
      { status: 409, code: 'READ_PLAN_BINDING_SCOPE_INVALID' }, String(workspaceId))
  }
  assert.deepEqual(touched, [], 'no store call')
})

test('PAR-U2b\' (S1b) a deployment that declares source.workspaceId cannot execute an online plan: with a tenant pointer every lane refuses READ_PLAN_EXECUTION_SCOPE_MISMATCH (R1, M6: a silently inert pointer); with no pointer the deployment plan runs at the declared workspace', async () => {
  const f = await mount()
  const declared = createStockPreparationTableActionRegistry({ actions: [{ ...f.action, source: { ...f.action.source, workspaceId: 'ws-declared' } }] })
  const touched = []
  const store = { async getActiveForRuntime(input) { touched.push(input.workspaceId); return f.ledger.getActiveForRuntime(input) } }
  for (const workspaceId of [undefined, 'ws-declared', 'request-selector']) {
    const resolved = await declared.getTableActionForExecution({ tenantId: TENANT, ...(workspaceId ? { workspaceId } : {}) })
    await assert.rejects(resolveStockPreparationReadPlanExecution({ resolved, store, verifyTenant: () => TENANT, projectIdentityRequired: false, onlineReadPlansEnabled: true }),
      { status: 409, code: 'READ_PLAN_EXECUTION_SCOPE_MISMATCH' }, String(workspaceId))
  }
  assert.deepEqual(touched, [null, null, null], 'the pointer is read at the tenant scope')
  const resolved = await declared.getTableActionForExecution({ tenantId: TENANT })
  const legacy = await resolveStockPreparationReadPlanExecution({ resolved, store: noPointer, verifyTenant() { throw new Error('legacy demands no claim') }, projectIdentityRequired: false, onlineReadPlansEnabled: true })
  assert.equal(Object.hasOwn(legacy.action, 'readPlanExecutionIdentity'), false)
  assert.equal(legacy.sourceScope.workspaceId, 'ws-declared')
  // The real route, R1 (no binding row), both lanes.
  for (const active of [true, false]) {
    const r = await mount({ active, sourceWorkspaceId: 'ws-declared', deployReadPlan: config().readPlan })
    useRealBindings(r, [])
    for (const hint of [undefined, 'request-selector']) {
      const result = await dryRun(r, hint)
      if (active) {
        assertRefused(result, 409, 'READ_PLAN_EXECUTION_SCOPE_MISMATCH', `pointer, hint ${String(hint)}`)
      } else {
        assert.equal(result.statusCode, 200, `no pointer, hint ${String(hint)}: ${JSON.stringify(result.body)}`)
        assert.deepEqual(storedIdentities(r, result.body.data.dryRunToken), [], 'the deployment plan')
      }
    }
    if (active) assert.equal(r.calls.adapter.length, 0, 'refused before any source read')
    else assert.ok(r.calls.adapter.every((input) => input.workspaceId === 'ws-declared'))
    assert.ok(r.calls.ledger.every((input) => input.workspaceId === null))
  }
})

test('PAR-R1 (S1b) R3/R4 hinted lane: the matched workspace row selects the source row only; the pointer is read at the tenant scope and the hinted and hint-less lanes execute the same online identity', async () => {
  const f = await mount({ matchedWorkspaceId: S1B_WS })
  const hinted = await dryRun(f, S1B_WS)
  assert.equal(hinted.statusCode, 200, JSON.stringify(hinted.body))
  assert.deepEqual(f.calls.ledger.map((input) => input.workspaceId), [null], 'the pointer is read at the tenant scope')
  assert.equal(f.calls.adapter[0].workspaceId, S1B_WS, 'the source row is loaded at the matched scope')
  assert.equal(f.calls.read[0].object, 'SYN_PathLink', 'the online plan executes')
  assertForwardedCurrentRevision(f.calls)
  const hintless = await dryRun(f)
  assert.equal(hintless.statusCode, 200, JSON.stringify(hintless.body))
  const hintedIdentities = storedIdentities(f, hinted.body.data.dryRunToken)
  assert.ok(hintedIdentities.length > 0, 'the hinted token carries the execution identity')
  assert.ok(hintedIdentities.every((identity) => identity.workspaceId === null && identity.systemId === SYSTEM))
  assert.deepEqual(hintedIdentities, storedIdentities(f, hintless.body.data.dryRunToken), 'parity: both lanes executed the same plan identity')
  // A disabled pointer refuses both lanes before any source read.
  await f.ledger.deactivate({ ...SCOPE, actionId: ACTION, actor: USER.id, expectedGeneration: 1 })
  const adapterBefore = f.calls.adapter.length
  for (const hint of [S1B_WS, undefined]) {
    assertRefused(await dryRun(f, hint), 409, 'READ_PLAN_ACTIVATION_DISABLED', `disabled, hint ${String(hint)}`)
  }
  assert.equal(f.calls.adapter.length, adapterBefore)
  // No pointer at all: the deployment plan, at the legacy source scope, with no identity.
  f.state[ACTIVATION_TABLE].length = 0
  for (const hint of [S1B_WS, undefined]) {
    const before = f.calls.adapter.length
    const result = await dryRun(f, hint)
    assert.equal(result.statusCode, 200, `no pointer, hint ${String(hint)}: ${JSON.stringify(result.body)}`)
    assert.deepEqual(storedIdentities(f, result.body.data.dryRunToken), [])
    assert.equal(f.calls.adapter[before].workspaceId, S1B_WS)
  }
})

test('PAR-R2 (S1b) R1 hinted (no binding row, a request workspace hint): the online plan executes at the tenant scope (M6: 409 READ_PLAN_EXECUTION_SCOPE_MISMATCH), with the hint-less lane\'s identity', async () => {
  const f = await mount()
  useRealBindings(f, [])
  const hinted = await dryRun(f, 'request-selector')
  assert.equal(hinted.statusCode, 200, JSON.stringify(hinted.body))
  assert.equal(f.calls.read[0].object, 'SYN_PathLink')
  const hintless = await dryRun(f)
  assert.equal(hintless.statusCode, 200, JSON.stringify(hintless.body))
  assert.deepEqual(f.calls.ledger.map((input) => input.workspaceId), [null, null])
  const identities = storedIdentities(f, hinted.body.data.dryRunToken)
  assert.ok(identities.length > 0 && identities.every((identity) => identity.workspaceId === null))
  assert.deepEqual(identities, storedIdentities(f, hintless.body.data.dryRunToken))
})

test('PAR-R1b (S1b) R3 with the deployment default != the bound system: a stray workspace hint resolves the deployment default and is refused hint_unbound before any pointer or source read', async () => {
  const f = await mount({ deploySystemId: 'system-deploy-default' })
  useRealBindings(f, [[S1B_WS, SYSTEM]])
  const before = ioCounts(f)
  const storageBefore = clone([...f.storage])
  const stray = await dryRun(f, 'stray-workspace')
  assertSplit(stray, 'hint_unbound', 'stray hint')
  assert.deepEqual(ioCounts(f), before, 'no pointer, adapter, source or target read, no write')
  assert.deepEqual([...f.storage], storageBefore, 'no token')
  assert.deepEqual(f.calls.listed.length, 1)
})

test('PAR-R7 (S1b) R3 with the deployment default != the bound system, an active pointer for the bound system: the workbench hint and the hint-less lane both execute the online plan (the set is compared with the RESOLVED system, never the deployment\'s)', async () => {
  const f = await mount({ deploySystemId: 'system-deploy-default' })
  useRealBindings(f, [[S1B_WS, SYSTEM]])
  const tokens = []
  for (const hint of [S1B_WS, undefined]) {
    const readsBefore = f.calls.read.length
    const result = await dryRun(f, hint)
    assert.equal(result.statusCode, 200, `hint ${String(hint)}: ${JSON.stringify(result.body)}`)
    assert.equal(f.calls.read[readsBefore].object, 'SYN_PathLink', 'the online plan executes')
    tokens.push(result.body.data.dryRunToken)
  }
  assert.deepEqual(f.calls.ledger.map((input) => [input.workspaceId, input.systemId]), [[null, SYSTEM], [null, SYSTEM]])
  assert.ok(f.calls.adapter.every((input) => input.id === SYSTEM && input.workspaceId === S1B_WS))
  assert.deepEqual(storedIdentities(f, tokens[0]), storedIdentities(f, tokens[1]))
})

test('PAR-R3 (S1b) R4 with different systems: hinted and hint-less dry-run, reconcile and mvp-persist all refuse READ_PLAN_SOURCE_BINDING_SPLIT bindings_disagree before any pointer or source read', async () => {
  const f = await mount()
  useRealBindings(f, [[null, SYSTEM], [S1B_WS, S1B_OTHER]])
  const before = ioCounts(f)
  for (const [label, run] of [
    ['hinted dry-run', () => dryRun(f, S1B_WS)],
    ['hint-less dry-run', () => dryRun(f)],
    ['reconcile', () => f.call(`${BASE}/confirmation-decisions/reconcile`, { body: { parameters: PARAMS } })],
    ['mvp-persist', () => f.call(`${BASE}/mvp-persist`, { body: { parameters: PARAMS } })],
  ]) {
    assertSplit(await run(), 'bindings_disagree', label)
  }
  assert.deepEqual(ioCounts(f), before, 'no pointer, adapter, source or target read, no write')
  assert.equal(f.calls.listed.length, 4)
})

test('PAR-R4 (S1b) C6 (two workspace rows, no tenant row, the same system): every lane refuses bindings_ambiguous before any pointer or source read; one tenant-level row repairs it', async () => {
  const f = await mount()
  const bindings = useRealBindings(f, [['ws-1', SYSTEM], ['ws-2', SYSTEM]])
  const before = ioCounts(f)
  for (const hint of ['ws-1', undefined]) assertSplit(await dryRun(f, hint), 'bindings_ambiguous', `hint ${String(hint)}`)
  assert.deepEqual(ioCounts(f), before)
  bindings.seed([[null, SYSTEM], ['ws-1', SYSTEM], ['ws-2', SYSTEM]])
  for (const hint of ['ws-1', undefined]) {
    const result = await dryRun(f, hint)
    assert.equal(result.statusCode, 200, `repaired, hint ${String(hint)}: ${JSON.stringify(result.body)}`)
  }
  assert.deepEqual(f.calls.ledger.map((input) => input.workspaceId), [null, null])
})

// The reason order (ambiguous before hint_unbound) is only observable when the hint-less lane resolves a system that
// is in none of the rows: C6 with the deployment default != the bound system. PAR-R4 binds the deployment's own
// system, so either order reports bindings_ambiguous there.
test('PAR-R4b (S1b) C6 with the deployment default != the bound system: the hint-less lookup resolves the deployment default (no tenant row, two workspace rows), and the lane still refuses bindings_ambiguous, never hint_unbound, before any pointer or source read', async () => {
  const f = await mount({ deploySystemId: 'system-deploy-default' })
  useRealBindings(f, [['ws-1', SYSTEM], ['ws-2', SYSTEM]])
  const store = f.services.stockPreparationSourceBindingStore
  assert.equal(await store.get({ tenantId: TENANT, actionId: ACTION, workspaceId: null }), null, 'calibration: C6 hint-less resolves no row, so the lane resolves the deployment default')
  assert.notEqual(f.action.source.externalSystemId, SYSTEM, 'calibration: the deployment default is not the bound system')
  const before = ioCounts(f)
  const listedBefore = f.calls.listed.length
  assertSplit(await dryRun(f), 'bindings_ambiguous', 'hint-less')
  assertSplit(await dryRun(f, 'ws-1'), 'bindings_ambiguous', 'hint ws-1')
  assert.deepEqual(ioCounts(f), before, 'no pointer, adapter, source or target read, no write')
  assert.equal(f.calls.listed.length - listedBefore, 2, 'each lane listed the binding set once')
})

// The multi-system C6 (no tenant row, two workspace rows naming DIFFERENT systems) is ambiguous AND disagreeing at
// once; the assert reports bindings_ambiguous first on every lane. PAR-R4 and PAR-R4b bind one system, so an ambiguous
// check narrowed to single-system sets, or a disagree check moved ahead of it, survives both; this case pins the cell.
test('PAR-R4c (S1b) multi-system C6 (no tenant row, two workspace rows naming different systems): the hint-less and the ws-1-hinted lanes both refuse bindings_ambiguous, never hint_unbound or bindings_disagree, before any pointer or source read', async () => {
  const f = await mount({ deploySystemId: 'system-deploy-default' })
  useRealBindings(f, [['ws-1', SYSTEM], ['ws-2', S1B_OTHER]])
  const store = f.services.stockPreparationSourceBindingStore
  assert.equal(await store.get({ tenantId: TENANT, actionId: ACTION, workspaceId: null }), null, 'calibration: multi-system C6 hint-less resolves no row, so the lane resolves the deployment default')
  const hinted = await store.get({ tenantId: TENANT, actionId: ACTION, workspaceId: 'ws-1' })
  assert.equal(hinted && hinted.externalSystemId, SYSTEM, 'calibration: the ws-1 hint resolves its own row, which the ws-2 row disagrees with')
  for (const bound of [SYSTEM, S1B_OTHER]) assert.notEqual(f.action.source.externalSystemId, bound, 'calibration: the deployment default is neither bound system')
  const before = ioCounts(f)
  const listedBefore = f.calls.listed.length
  assertSplit(await dryRun(f), 'bindings_ambiguous', 'hint-less')
  assertSplit(await dryRun(f, 'ws-1'), 'bindings_ambiguous', 'hint ws-1')
  assert.deepEqual(ioCounts(f), before, 'no pointer, adapter, source or target read, no write')
  assert.equal(f.calls.ledger.length, before.ledger, '0 pointer reads')
  assert.equal(f.calls.read.length, before.read, '0 source reads')
  assert.equal(f.calls.listed.length - listedBefore, 2, 'each lane listed the binding set once')
})

test('PAR-R5 (S1b) an unlistable, incomplete or failing binding listing refuses every lane before any pointer or source read; the store text never leaves', async () => {
  for (const [label, prepare, status, code, reason] of [
    ['no listForAction', (store) => { delete store.listForAction }, 409, SPLIT, 'bindings_unverifiable'],
    ['incomplete listing', (store) => { store.listForAction = async ({ tenantId, actionId }) => ({ bindings: [{ tenantId, actionId, workspaceId: null, externalSystemId: SYSTEM }], complete: false }) }, 409, SPLIT, 'bindings_unverifiable'],
    ['listing is not a list', (store) => { store.listForAction = async () => ({ bindings: null, complete: true }) }, 409, SPLIT, 'bindings_unverifiable'],
    ['listing throws', (store) => { store.listForAction = async () => { throw new Error('SYN-private-binding') } }, 503, 'READ_PLAN_SOURCE_BINDING_UNAVAILABLE', undefined],
  ]) {
    const f = await mount()
    prepare(f.services.stockPreparationSourceBindingStore)
    const before = ioCounts(f)
    const storageBefore = clone([...f.storage])
    for (const hint of [undefined, 'request-selector']) {
      const result = await dryRun(f, hint)
      assertRefused(result, status, code, label)
      assert.deepEqual({ ...result.body.error.details }, reason ? { actionId: ACTION, reason } : { actionId: ACTION }, label)
      assert.ok(!JSON.stringify(result.body).includes('SYN-private-binding'), `${label}: values-free`)
    }
    assert.deepEqual(ioCounts(f), before, `${label}: nothing read or written`)
    assert.deepEqual([...f.storage], storageBefore, label)
  }
})

test('PAR-R6 (S1b) the assert is not atomic with the lookup: when the listing disagrees with what the lookup just resolved, the lane refuses before any pointer read — it never executes a plan for another system', async () => {
  for (const [label, get, rows, reason] of [
    ['looked up the tenant row (R2), the set gained a row for another system (R4-diff)', () => ({ externalSystemId: SYSTEM, matchedWorkspaceId: null, scopeFallback: null }), [[null, SYSTEM], [S1B_WS, S1B_OTHER]], 'bindings_disagree'],
    ['looked up the workspace row of another system, the set still has the tenant row', () => ({ externalSystemId: S1B_OTHER, matchedWorkspaceId: S1B_WS, scopeFallback: null }), [[null, SYSTEM], [S1B_WS, S1B_OTHER]], 'bindings_disagree'],
    ['looked up a workspace row that was re-pointed since', () => ({ externalSystemId: S1B_OTHER, matchedWorkspaceId: S1B_WS, scopeFallback: null }), [[S1B_WS, SYSTEM]], 'hint_unbound'],
  ]) {
    const f = await mount()
    const store = f.services.stockPreparationSourceBindingStore
    store.get = async (input) => { f.calls.binding.push(clone(input)); return get() }
    store.listForAction = async ({ tenantId, actionId }) => ({ bindings: rows.map(([workspaceId, externalSystemId]) => ({ tenantId, actionId, workspaceId, externalSystemId })), complete: true })
    const before = ioCounts(f)
    assertSplit(await dryRun(f, S1B_WS), reason, label)
    assert.deepEqual(ioCounts(f), before, `${label}: no pointer or source read`)
  }
})

test('PAR-OFF (S1b) switch OFF: no binding listing, no pointer read, the deployment plan on the matched (or hinted) system — byte-identical in the split shapes too', async () => {
  for (const value of [undefined, 'false', 'TRUE', ' true']) {
    const register = loadRoutes(undefined, {}, { [ONLINE_READ_PLANS_ENABLED_ENV]: value }).registerIntegrationRoutes
    const f = await mount({ matchedWorkspaceId: S1B_WS, register })
    const result = await dryRun(f, S1B_WS)
    assert.equal(result.statusCode, 200, `${String(value)}: ${JSON.stringify(result.body)}`)
    assert.deepEqual(f.calls.ledger, [], `${String(value)}: no pointer read`)
    assert.deepEqual(f.calls.listed, [], `${String(value)}: no binding listing`)
    assert.ok(f.calls.read.every((read) => !String(read.object).startsWith('SYN_')), `${String(value)}: the online plan is never read`)
    assert.deepEqual(storedIdentities(f, result.body.data.dryRunToken), [])
    assert.equal(f.calls.adapter[0].workspaceId, S1B_WS)
    const split = await mount({ register })
    useRealBindings(split, [[null, SYSTEM], [S1B_WS, S1B_OTHER]])
    const hinted = await dryRun(split, S1B_WS)
    assert.equal(hinted.statusCode, 200, `${String(value)} R4-diff: ${JSON.stringify(hinted.body)}`)
    assert.equal(split.calls.adapter[0].id, S1B_OTHER, `${String(value)}: the hinted row's system, as before (R-1 territory)`)
    assert.deepEqual([split.calls.ledger, split.calls.listed], [[], []], `${String(value)}: no pointer read, no binding listing`)
  }
})

test('RT-RP1c (S1b) route-level closure over R4 bindings (a tenant row and a workspace row, the same system): a candidate confirmed hint-less, then ONE governed dry-run WITH the workspace hint — its reconcile verifies the relationship\'s source step as valid (M6: source_scope_changed)', async () => {
  const pairing = require('../lib/stock-preparation-continuation-pairing.cjs')
  const refreshKit = require('./support/stock-preparation-refresh-store-kit.cjs')
  const f = await mount({ projectSheets: true, refreshOptions: { lockOnRefreshDb: true, wirePackInstallStore: true } })
  const env = f.refreshGovernanceEnv
  useRealBindings(f, [[null, SYSTEM], [S1B_WS, SYSTEM]])
  f.services.stockPreparationAuditStore.appendWithin = async () => ({ ok: true })
  const registryRow = f.state[PROJECT_TARGET_TABLE].find((row) => row.project_no === PARAMS.projectNo)
  Object.assign(registryRow, { pilot_enabled_at: new Date('2026-10-27T00:00:00Z'), pilot_enabled_by: USER.id, pilot_readiness_version: 1 })
  const fixture = await refreshKit.candidateHoldFixture()
  const hold = JSON.parse(JSON.stringify(fixture.hold).split(fixture.projectNo).join(PARAMS.projectNo))
  hold.fingerprint = pairing.holdFingerprint(hold)
  await env.seedHolds({ tenantId: TENANT, sheetId: f.projectSheetId, projectNo: PARAMS.projectNo }, [hold])
  const candidateRow = env.rows('hold').find((row) => row.fingerprint === hold.fingerprint && row.status === 'open')
  assert.ok(candidateRow, 'the candidate hold is open')
  const params = { projectNo: PARAMS.projectNo }
  const first = await f.call(`${DECISIONS}/holds`, { method: 'GET', params })
  assert.equal(first.statusCode, 200, JSON.stringify(first.body))
  let receipt = first.body.data.readReceipt
  const entry = first.body.data.page.holds.find((item) => item.id === candidateRow.id)
  for (let index = 1; index < (entry && entry.pairPage ? entry.pairPage.count : 1); index += 1) {
    const next = await f.call(`${DECISIONS}/holds`, { method: 'GET', params, query: { holdId: candidateRow.id, pairCursor: index, receipt: receipt.id } })
    assert.equal(next.statusCode, 200, JSON.stringify(next.body))
    receipt = next.body.data.readReceipt
  }
  const confirmed = await f.call(`${DECISIONS}/continuations/confirm`, { params, body: {
    confirmProjectNo: PARAMS.projectNo, holdId: candidateRow.id, holdFingerprint: hold.fingerprint,
    comparisonFingerprint: hold.comparisonFingerprint, evidenceFingerprint: hold.evidenceFingerprint, candidateId: hold.pairingFingerprint,
    readReceipt: receipt.id, basis: { kind: 'puller_confirmed_same_demand' }, acknowledge: { historyUnknown: true },
  } })
  assert.equal(confirmed.statusCode, 201, JSON.stringify(confirmed.body))
  const continuationId = confirmed.body.data.continuationId
  const ledgerBefore = f.calls.ledger.length
  const dry = await dryRun(f, S1B_WS)
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  assert.deepEqual(f.calls.ledger.slice(ledgerBefore).map((input) => input.workspaceId), [null], 'the hinted lane read the pointer at the tenant scope')
  const continuation = env.rows('continuation').find((row) => row.id === continuationId)
  assert.ok(continuation && continuation.last_verified_at, 'the computation reconciled and verified the relationship')
  const verification = env.rows('hold').find((row) => row.continuation_id === continuationId && row.status === 'open')
  assert.ok(verification, 'the reconcile persisted the relationship\'s verification hold')
  assert.equal(verification.detail.steps.source, 'valid', 'the confirm stamped the identity the hinted lane executes')
  assert.notEqual(continuation.last_verdict, 'source_scope_changed')
})

// The parity seams, pinned statically (the behaviour is pinned above): each mutated seam is refused.
function assertScopeParityAnchor({ table, runtime, route }) {
  assert.match(table, /\n {8}bindingScope: \{\n {10}tenantId: optionalString\(input\.tenantId\),\n(?: {10}\/\/[^\n]*\n)* {10}workspaceId: null,\n {8}\},\n/, 'the activation scope is the tenant\'s')
  assert.ok(runtime.includes('(action.source.workspaceId || null) !== bindingScope.workspaceId'), 'SCOPE_MISMATCH names the declared source workspace')
  assert.ok(runtime.includes('bindingScope.workspaceId !== null) {'), 'a workspace activation scope is refused')
  const start = route.indexOf('  async function resolveTableActionExecution(req, input, snapshotAction, requireTarget = true) {')
  assert.notEqual(start, -1, 'the lane resolver exists')
  const resolver = route.slice(start, route.indexOf('\n  async function ', start + 1))
  assert.equal(resolver.split('onlineReadPlansEnabled()').length - 1, 1, 'the lane resolver reads the switch once')
  assert.match(resolver, /const online = onlineReadPlansEnabled\(\)\n {4}const resolved = await tableActions\.getTableActionForExecution\(scope\)\n {4}if \(online\) \{\n {6}await assertStockPreparationSourceBindingCanonical\(\{ tenantId: scope\.tenantId, actionId: resolved\.action\.actionId, externalSystemId: resolved\.action\.source\.externalSystemId \}\)\n/, 'one snapshot, then the gated assert on the resolved system')
  assert.match(resolver, /\n {6}onlineReadPlansEnabled: online,\n/, 'the resolution uses the same snapshot')
  assert.equal(route.split('await assertStockPreparationSourceBindingCanonical(').length - 1, 2, 'the lane resolver and the S1 helper')
}

test('PAR-ANCHOR (S1b) the parity seams in table-actions, the runtime and the lane resolver, with a self-mutation pair each', () => {
  const read = (file) => fs.readFileSync(require.resolve(`../lib/${file}`), 'utf8').replaceAll('\r\n', '\n')
  const sources = { table: read('stock-preparation-table-actions.cjs'), runtime: read('stock-preparation-read-plan-runtime.cjs'), route: routeSource }
  assertScopeParityAnchor(sources)
  for (const [label, key, needle, value] of [
    ['the matched row selects the activation scope', 'table', '          workspaceId: null,\n        },\n        sourceScope: {', '          workspaceId: binding ? binding.matchedWorkspaceId : null,\n        },\n        sourceScope: {'],
    ['the compare names the matched source scope', 'runtime', '(action.source.workspaceId || null) !== bindingScope.workspaceId', 'sourceScope.workspaceId !== bindingScope.workspaceId'],
    ['a workspace activation scope accepted', 'runtime', 'bindingScope.workspaceId !== null) {', 'bindingScope.workspaceId === undefined) {'],
    ['a second switch reading', 'route', '      onlineReadPlansEnabled: online,\n', '      onlineReadPlansEnabled: onlineReadPlansEnabled(),\n'],
    ['an ungated or skipped lane assert', 'route', '    if (online) {\n      await assertStockPreparationSourceBindingCanonical(', '    if (false) {\n      await assertStockPreparationSourceBindingCanonical('],
    ['the deployment system compared', 'route', 'externalSystemId: resolved.action.source.externalSystemId })\n    }\n', 'externalSystemId: configuredTableActions[0].source.externalSystemId })\n    }\n'],
    ['the S1 helper skips the assert', 'route', '    await assertStockPreparationSourceBindingCanonical({ tenantId, actionId: PLM_STOCK_PREPARATION_ACTION_ID', '    void ({ tenantId, actionId: PLM_STOCK_PREPARATION_ACTION_ID'],
  ]) {
    assert.equal(sources[key].split(needle).length - 1, 1, `${label}: the seam is unique`)
    assert.throws(() => assertScopeParityAnchor({ ...sources, [key]: sources[key].replace(needle, value) }), { name: 'AssertionError' }, label)
  }
})
