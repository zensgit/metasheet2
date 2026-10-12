'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const entry = require('../index.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require('../lib/stock-preparation-templates.cjs')
const { FEATURE_FLAG } = require('../lib/sealed-export/stock-preparation-runtime-config.cjs')

const ACTION = 'plm.stock-preparation.pull-bom.v1'
const TENANT = 'synthetic-tenant'
const SYSTEM = 'synthetic-plm'
const OWNER = 'synthetic-owner'
const ROOT = '/api/integration/stock-preparation/read-plan-configs'

// Real plugin bootstrap, route registration, public registry, scoped SQL builder
// and ledger. Only host DB/metadata IO is synthetic. No socket or customer source
// is used; transaction/lock guarantees belong to the separate PostgreSQL suite.
function host() {
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
  const context = {
    config: { stockPreparationTableActions: [{
      actionId: ACTION,
      source: { externalSystemId: SYSTEM, kind: 'data-source:sql-readonly' },
      target: { sheetId: 'synthetic-sheet', objectId: 'stockPreparationMain', fieldIdMap:
        Object.fromEntries(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map(field => [field.id, `synthetic-${field.id}`])) },
    }] },
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
    if (previous === undefined) delete process.env[FEATURE_FLAG]
    else process.env[FEATURE_FLAG] = previous
  }
})
