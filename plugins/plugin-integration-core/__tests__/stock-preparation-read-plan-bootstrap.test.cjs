'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const managementModule = require('../lib/stock-preparation-read-plan-management.cjs')
// Pass-through spy, never a stub: records the options the REAL bootstrap hands
// the real factory, so an unwired deployment resolver fails here, not silently.
const managementOptions = []
const createManagement = managementModule.createStockPreparationReadPlanManagement
managementModule.createStockPreparationReadPlanManagement = (options) => {
  managementOptions.push(options)
  return createManagement(options)
}
const entry = require('../index.cjs')
const { assertStockPreparationReadPlanDeploymentCompatible } = require('../lib/stock-preparation-read-plan-execution.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require('../lib/stock-preparation-templates.cjs')
const { FEATURE_FLAG } = require('../lib/sealed-export/stock-preparation-runtime-config.cjs')
const { ONLINE_READ_PLANS_ENABLED_ENV } = require('../lib/stock-preparation-read-plan-switch.cjs')
// The real plugin entry reads the online read-plan switch from process.env; these cases serve read plans.
function withOnlineReadPlans(value) {
  const previous = process.env[ONLINE_READ_PLANS_ENABLED_ENV]
  if (value === undefined) delete process.env[ONLINE_READ_PLANS_ENABLED_ENV]
  else process.env[ONLINE_READ_PLANS_ENABLED_ENV] = value
  return () => { if (previous === undefined) delete process.env[ONLINE_READ_PLANS_ENABLED_ENV]; else process.env[ONLINE_READ_PLANS_ENABLED_ENV] = previous }
}

const ACTION = 'plm.stock-preparation.pull-bom.v1'
const TENANT = 'synthetic-tenant'
const SYSTEM = 'synthetic-plm'
const OWNER = 'synthetic-owner'
const ROOT = '/api/integration/stock-preparation/read-plan-configs'
const READ_PLAN = Object.freeze({
  id: 'plm.stock-preparation.bom-read.user-draft.v1', sourceKind: 'data-source:sql-readonly', matchField: 'project', maxReadCount: 100,
  pathExAttr: { object: 'SYN_PathLink', matchField: 'project', pathIdField: 'path' },
  pathInfo: { object: 'SYN_Path', idField: 'id' },
  orderHead: { object: 'SYN_Order', idField: 'id', pathIdField: 'path' },
  orderDetail: { object: 'SYN_OrderLine', orderIdField: 'order', componentIdField: 'part', quantityField: 'qty' },
  part: { object: 'SYN_Part', idField: 'id', codeField: 'code', nameField: 'name' },
  bomHead: { object: 'SYN_Bom', parentPartField: 'part', bomIdField: 'id' },
  bomDetail: { object: 'SYN_BomLine', bomParentField: 'bom', componentIdField: 'part', quantityField: 'qty' },
})
// Deploy-only readPlan blocks SA02 v1 cannot express (same fixture as the
// management/runtime suites); tests self-check that the real normalizer keeps them.
const DEPLOY_DECLARATIONS = Object.freeze({
  projectSubtree: { pathInfo: { parentIdField: 'parent' }, bomHead: { pathIdField: 'path' } },
  batchIdentity: { mode: 'material_create_hour' },
})

// Real plugin bootstrap, route registration, public registry, scoped SQL builder
// and ledger. Only host DB/metadata IO is synthetic. No socket or customer source
// is used; transaction/lock guarantees belong to the separate PostgreSQL suite.
function host({ actionsKey = 'stockPreparationTableActions', readPlan, unconfigured = false } = {}) {
  const routes = new Map()
  const namespaces = new Map()
  const queries = []
  const facadeCalls = []
  let ledgerFailure = false
  let disabled = false
  const BINDING_REVISION = '33333333-3333-4333-8333-333333333333'
  const CONNECTION_REVISION = '44444444-4444-4444-8444-444444444444'
  const system = {
    id: SYSTEM, tenant_id: TENANT, workspace_id: null, kind: 'data-source:sql-readonly',
    role: 'source', status: 'active', connection_id: 'synthetic-connection', config: {},
    validation_revision: BINDING_REVISION,
  }
  const deployAction = {
    actionId: ACTION,
    source: { externalSystemId: SYSTEM, kind: 'data-source:sql-readonly', ...(readPlan ? { readPlan } : {}) },
    target: { sheetId: 'synthetic-sheet', objectId: 'stockPreparationMain', fieldIdMap:
      Object.fromEntries(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map(field => [field.id, `synthetic-${field.id}`])) },
  }
  const context = {
    config: unconfigured ? {} : { [actionsKey]: [deployAction] },
    api: {
      http: { addRoute(method, route, handler) { routes.set(`${method} ${route}`, handler) } },
      database: { async query(sql, params) {
        queries.push({ sql, params })
        if (sql.includes('integration_stock_prep_read_plan_') && ledgerFailure) {
          const error = new Error('synthetic-private-db-detail-MUST-NOT-LEAK')
          error.code = '42P01'
          throw error
        }
        if (sql.includes('FROM "integration_external_systems"')) {
          assert.ok(params.includes(TENANT) && params.includes(SYSTEM))
          assert.match(sql, /"workspace_id" IS NULL/)
          return [structuredClone(system)]
        }
        if (sql.includes('FROM "integration_stock_prep_source_binding"')) {
          return [{ id: 'synthetic-binding', tenant_id: TENANT, workspace_id: null,
            action_id: ACTION, external_system_id: SYSTEM }]
        }
        if (sql.includes('FROM "integration_stock_prep_read_plan_activation"') && disabled) {
          return [{ id: 'synthetic-pointer', tenant_id: TENANT, workspace_id: null,
            action_id: ACTION, version_id: 'synthetic-version', system_id: SYSTEM,
            content_key: 'a'.repeat(64), generation: 2, status: 'disabled' }]
        }
        if (sql.includes('FROM "integration_data_source_validation_revisions"')) {
          return [{ data_source_id: 'synthetic-connection', validation_revision: CONNECTION_REVISION,
            tenant_id: TENANT, workspace_id: null, owner_id: OWNER, scope_kind: 'private',
            type: 'postgresql', is_active: true, deleted_at: null }]
        }
        if (sql.includes('FROM "integration_stock_prep_read_plan_validations"')) return []
        return []
      } },
      dataSources: { async resolveConnectionRegistration(id, input) {
        facadeCalls.push({ id, ...input })
        assert.equal(input.tenantId, TENANT)
        assert.equal(input.workspaceId, null)
        assert.equal(input.runAs, 'user')
        if (input.principal !== OWNER) throw new Error('synthetic-owner-private-detail-MUST-NOT-LEAK')
        return { id, tenantId: TENANT, type: 'postgresql', scopeKind: 'private', validationRevision: CONNECTION_REVISION }
      } },
    },
    communication: { register(name, api) { namespaces.set(name, api) }, on() {}, emit() {} },
    logger: { info() {}, warn() {}, error() {} },
    services: { security: {
      async encrypt() { throw new Error('bootstrap test must not encrypt') },
      async decrypt() { throw new Error('bootstrap test must not decrypt') },
      async hash() { throw new Error('bootstrap test must not hash credentials') },
    } },
  }
  return { context, routes, namespaces, queries, facadeCalls,
    set ledgerFailure(value) { ledgerFailure = value }, set disabled(value) { disabled = value } }
}
function request(overrides = {}) {
  return { user: { id: OWNER, tenantId: TENANT, permissions: ['integration:admin', 'integration:read'] },
    authenticatedTenantId: TENANT, query: {}, params: {}, body: {}, ...overrides }
}
async function call(h, method, route, req) {
  const handler = h.routes.get(`${method} ${route}`)
  assert.equal(typeof handler, 'function', 'real bootstrap must register the route')
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
  await handler(req, res)
  return res
}

test('real bootstrap injects private management/ledger and never exposes them cross-plugin', async () => {
  const previous = process.env[FEATURE_FLAG]
  process.env[FEATURE_FLAG] = 'false'
  const restoreOnline = withOnlineReadPlans('true')
  const h = host()
  try {
    await entry.activate(h.context)
    const admin = request({ query: { managementScope: 'tenant', systemId: SYSTEM } })
    const listed = await call(h, 'GET', ROOT, admin)
    assert.equal(listed.statusCode, 200)
    assert.deepEqual(listed.body, { ok: true, data: { versions: [], activation: null } })
    assert.equal(h.facadeCalls.length, 1)
    assert.ok(h.queries.some(({ sql }) => sql.includes('integration_stock_prep_read_plan_versions')),
      'must reach the real persisted ledger, not return a fixed empty list')
    assert.ok(h.queries.some(({ sql }) => sql.includes('integration_stock_prep_read_plan_activation')))
    assert.ok(!Object.keys(h.namespaces.get('integration-core')).some(key => /readPlan|read.plan/i.test(key)),
      'no caller-supplied cross-plugin management identity')

    const reads = h.queries.length
    const nonAdmin = await call(h, 'GET', ROOT, request({
      user: { id: OWNER, tenantId: TENANT, permissions: ['integration:write'] }, query: admin.query,
    }))
    assert.equal(nonAdmin.statusCode, 403)
    assert.equal(h.queries.length, reads, 'admin gate precedes metadata/ledger')
    const claimless = await call(h, 'GET', ROOT, request({ authenticatedTenantId: undefined,
      headers: { 'x-tenant-id': TENANT }, query: admin.query }))
    assert.equal(claimless.statusCode, 403)
    assert.equal(h.queries.length, reads, 'request header cannot grant a missing JWT tenant')

    const otherOwner = await call(h, 'GET', ROOT, request({
      user: { id: 'synthetic-other', tenantId: TENANT, permissions: ['integration:admin'] }, query: admin.query,
    }))
    assert.equal(otherOwner.statusCode, 403)
    assert.doesNotMatch(JSON.stringify(otherOwner.body), /MUST-NOT-LEAK/)
    assert.equal(h.queries.filter(({ sql }) => sql.includes('integration_stock_prep_read_plan_versions')).length, 1)

    h.disabled = true
    const denied = await call(h, 'POST', '/api/integration/table-actions/:actionId/dry-run', request({
      params: { actionId: ACTION }, body: { parameters: { projectNo: 'SYNTHETIC-PROJECT' } },
    }))
    assert.equal(denied.statusCode, 409)
    assert.equal(denied.body.error.code, 'READ_PLAN_ACTIVATION_DISABLED',
      'production bootstrap must feed disabled pointer into the actual execution route')
    assert.equal(h.facadeCalls.length, 2, 'disabled plan refuses before any source adapter authorization')

    h.ledgerFailure = true
    const unavailable = await call(h, 'POST', '/api/integration/table-actions/:actionId/dry-run', request({
      params: { actionId: ACTION }, body: { parameters: { projectNo: 'SYNTHETIC-PROJECT' } },
    }))
    assert.ok([500, 503].includes(unavailable.statusCode), 'missing migration is not an absent pointer')
    assert.doesNotMatch(JSON.stringify(unavailable.body), /MUST-NOT-LEAK|42P01/)
  } finally {
    await entry.deactivate()
    restoreOnline()
    if (previous === undefined) delete process.env[FEATURE_FLAG]
    else process.env[FEATURE_FLAG] = previous
  }
})

async function withActivated(options, run) {
  const previous = process.env[FEATURE_FLAG]
  process.env[FEATURE_FLAG] = 'false'
  const restoreOnline = withOnlineReadPlans('true')
  const h = host(options)
  const start = managementOptions.length
  try {
    await entry.activate(h.context)
    assert.ok(managementOptions.length > start, 'real bootstrap must build read-plan management')
    await run(h, managementOptions[start])
  } finally {
    await entry.deactivate()
    restoreOnline()
    if (previous === undefined) delete process.env[FEATURE_FLAG]
    else process.env[FEATURE_FLAG] = previous
  }
}

test('real bootstrap injects a server-only deployment resolver from either table-action config key', async () => {
  for (const actionsKey of ['stockPreparationTableActions', 'tableActions']) {
    await withActivated({ actionsKey }, async (h, options) => {
      assert.equal(typeof options.resolveDeploymentAction, 'function', `${actionsKey}: bootstrap must wire the resolver`)
      const before = { queries: h.queries.length, facade: h.facadeCalls.length }
      const deployed = await options.resolveDeploymentAction(ACTION)
      assert.equal(deployed.actionId, ACTION)
      assert.equal(deployed.source.externalSystemId, SYSTEM)
      assert.equal(Object.hasOwn(deployed, 'projectTarget'), false)
      assert.doesNotThrow(() => assertStockPreparationReadPlanDeploymentCompatible(deployed))
      deployed.source.externalSystemId = 'caller-mutated'
      assert.equal((await options.resolveDeploymentAction(ACTION)).source.externalSystemId, SYSTEM, 'immutable trusted config')
      assert.deepEqual({ queries: h.queries.length, facade: h.facadeCalls.length }, before,
        'pure config read: no metadata, binding or ledger IO')
      const forged = await call(h, 'POST', `${ROOT}/:id/activate`, request({ params: { id: 'synthetic-version' },
        body: { managementScope: 'tenant', systemId: SYSTEM, expectedGeneration: 0, resolveDeploymentAction: 'compatible' } }))
      assert.equal(forged.statusCode, 400)
      assert.equal(h.queries.length, before.queries, 'a request key is not a deployment resolver')
    })
  }
})

test('bootstrap resolver reflects declared and unconfigured deploy config, never a compatible default', async () => {
  for (const [key, block] of Object.entries(DEPLOY_DECLARATIONS)) {
    await withActivated({ readPlan: { ...structuredClone(READ_PLAN), [key]: structuredClone(block) } }, async (_h, options) => {
      const deployed = await options.resolveDeploymentAction(ACTION)
      assert.ok(Object.hasOwn(deployed.source.readPlan, key), `${key} fixture must survive the real deploy normalizer`)
      assert.throws(() => assertStockPreparationReadPlanDeploymentCompatible(deployed), (error) => {
        assert.equal(error.status, 409)
        assert.equal(error.code, 'READ_PLAN_DEPLOYMENT_INCOMPATIBLE')
        assert.equal(error.message, 'READ_PLAN_DEPLOYMENT_INCOMPATIBLE')
        return true
      })
    })
  }
  await withActivated({ unconfigured: true }, async (_h, options) => {
    assert.equal(typeof options.resolveDeploymentAction, 'function')
    await assert.rejects(options.resolveDeploymentAction(ACTION))
  })
})

test('switch OFF: the real bootstrap hides read-plan management and the pull path never touches the read-plan tables', async () => {
  const previous = process.env[FEATURE_FLAG]
  process.env[FEATURE_FLAG] = 'false'
  const restoreOnline = withOnlineReadPlans(undefined)
  const h = host()
  try {
    await entry.activate(h.context)
    const admin = request({ query: { managementScope: 'tenant', systemId: SYSTEM } })
    const before = h.queries.length
    const listed = await call(h, 'GET', ROOT, admin)
    assert.equal(listed.statusCode, 404)
    assert.equal(listed.body.error.code, 'READ_PLAN_MANAGEMENT_DISABLED')
    assert.equal(h.queries.length, before, 'no metadata or ledger IO while the switch is off')
    // As if migration 089 had not run: every read-plan statement fails. The pull path must not reach one.
    h.ledgerFailure = true
    const dry = await call(h, 'POST', '/api/integration/table-actions/:actionId/dry-run', request({
      params: { actionId: ACTION }, body: { parameters: { projectNo: 'SYNTHETIC-PROJECT' } },
    }))
    assert.ok(!h.queries.slice(before).some(({ sql }) => sql.includes('integration_stock_prep_read_plan_')),
      'no read-plan table is queried by the pull path while the switch is off')
    assert.doesNotMatch(JSON.stringify(dry.body), /READ_PLAN_RUNTIME_UNAVAILABLE|READ_PLAN_ACTIVATION/)
  } finally {
    await entry.deactivate()
    restoreOnline()
    if (previous === undefined) delete process.env[FEATURE_FLAG]
    else process.env[FEATURE_FLAG] = previous
  }
})
