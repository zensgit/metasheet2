'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createStockPreparationReadPlanValidationReader } = require('../lib/stock-preparation-read-plan-validation-runtime.cjs')
const { createExternalSystemRegistry } = require('../lib/external-systems.cjs')
const { createConnectionResolver } = require('../lib/connection-resolver.cjs')
const { createAdapterRegistry } = require('../lib/contracts.cjs')
const { createDataSourceSqlReadonlySourceAdapterFactory } = require('../lib/adapters/data-source-sql-readonly-source-adapter.cjs')
const { READ_PLAN_ID } = require('../lib/stock-preparation-read-plan-config.cjs')
const { createB2aRegistry, createB2aOperationClaim, B2A_PURPOSE_STOCK_PREPARATION_PLAN_VALIDATION,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION } = require('../lib/b2a-trial-registry.cjs')

const ACTION = 'plm.stock-preparation.pull-bom.v1'
const KIND = 'data-source:sql-readonly'
const REVISION = '10000000-0000-4000-8000-000000000001'
const clone = value => structuredClone(value)
function fixture() {
  const config = { schemaVersion: 1, actionId: ACTION, systemId: 'synthetic-system', readPlan: {
    id: READ_PLAN_ID, sourceKind: KIND, matchField: 'project', maxReadCount: 100,
    pathExAttr: { object: 'syn.links', matchField: 'project', pathIdField: 'path' },
    pathInfo: { object: 'syn.paths', idField: 'id' },
    orderHead: { object: 'syn.orders', idField: 'id', pathIdField: 'path' },
    orderDetail: { object: 'syn.lines', orderIdField: 'orderid', componentIdField: 'part', quantityField: 'qty', versionField: 'rev' },
    part: { object: 'syn.parts', idField: 'id', codeField: 'code', nameField: 'name', versionField: 'rev' },
    bomHead: { object: 'syn.boms', parentPartField: 'part', bomIdField: 'id', versionField: 'rev', activeField: 'active' },
    bomDetail: { object: 'syn.children', bomParentField: 'bom', componentIdField: 'part', quantityField: 'qty' },
  } }
  const data = {
    'syn.links': [{ project: 'SYN', path: 'P' }], 'syn.paths': [{ id: 'P' }],
    'syn.orders': [{ id: 'O', path: 'P' }], 'syn.lines': [{ orderid: 'O', part: 'ROOT', qty: 2, rev: 'B2' }],
    'syn.parts': [{ id: 'ROOT', code: 'ROOT-CODE', name: 'Synthetic root', rev: 'P1' },
      { id: 'CHILD', code: 'CHILD-CODE', name: 'Synthetic child', rev: 'P1' }],
    'syn.boms': [{ part: 'ROOT', id: 'B', rev: 'B2', active: true }],
    'syn.children': [{ bom: 'B', part: 'CHILD', qty: 3 }],
  }
  const binding = { id: config.systemId, tenant_id: 'synthetic-tenant', workspace_id: null,
    kind: KIND, role: 'source', status: 'active', connection_id: 'synthetic-connection', config: {},
    name: 'Synthetic source' }
  const registration = { id: binding.connection_id, tenantId: binding.tenant_id, type: 'postgresql',
    scopeKind: 'private', validationRevision: REVISION }
  const identity = { tenantId: binding.tenant_id, workspaceId: null, actor: 'synthetic-owner' }
  const trace = []
  const state = { revision: REVISION, onResolve: null }
  const facade = {
    async resolveConnectionRegistration(id, options) {
      trace.push(['resolve', id, clone(options)])
      if (options.principal !== identity.actor) throw new Error('owner mismatch')
      state.onResolve?.()
      return { ...registration, validationRevision: state.revision }
    },
    async getTableInfo(id, table, principal, schema, options) {
      trace.push(['schema', id, principal, options, `${schema}.${table}`])
      assert.equal(principal, identity.actor)
      assert.equal(options?.expectedValidationRevision, state.revision)
      const object = `${schema}.${table}`
      return { columns: Object.keys(data[object][0]).map(name => ({ name, type: 'text', nullable: false })) }
    },
    async select(id, object, query, principal, armed, options) {
      trace.push(['select', id, principal, options, object, armed])
      assert.equal(principal, identity.actor)
      assert.equal(options?.expectedValidationRevision, state.revision)
      const rows = data[object].filter(row => Object.entries(query.where || {}).every(([key, value]) => row[key] === value))
      return { data: clone(rows.slice(query.offset || 0, (query.offset || 0) + query.limit)) }
    },
    async getSchema() { assert.fail('no broad schema scan') },
    async test() { assert.fail('no connection test') },
  }
  const db = {
    async select() { assert.fail('no broad registry list') },
    async insertOne() { assert.fail('no binding write') },
    async updateRow() { assert.fail('no binding write') },
    async deleteRows() { assert.fail('no binding delete') },
    async countRows() { assert.fail('no binding mutation') },
    async selectOne(table, where) {
      assert.equal(table, 'integration_external_systems')
      assert.equal(where.tenant_id, identity.tenantId)
      assert.equal(where.workspace_id, null)
      return where.id === binding.id ? clone(binding) : null
    },
  }
  const externalSystems = createExternalSystemRegistry({ db, connectionResolver: createConnectionResolver({ facade }),
    credentialStore: { decrypt() { assert.fail('no embedded credential') },
      encrypt() { assert.fail('no credential write') }, fingerprint() { assert.fail('no credential fingerprint') } } })
  const adapterRegistry = createAdapterRegistry().registerAdapter(KIND,
    createDataSourceSqlReadonlySourceAdapterFactory({ context: { api: { dataSources: facade } } }))
  const input = { identity, registration, projectNo: 'SYN',
    version: { id: 'synthetic-version', ...identity, actionId: ACTION, systemId: binding.id, config } }
  // This template's default readPlan uses completely different objects. A call
  // to the execution/active-plan resolver would therefore not produce this BOM.
  const deps = { configuredTableActions: [{ actionId: ACTION,
    source: { kind: KIND, externalSystemId: 'synthetic-deployment-default' },
    target: { sheetId: 'synthetic-target', objectId: 'stockPreparationMain' }, rootSelection: { enabled: false } }],
    externalSystems, adapterRegistry, storage: new Map(), registry: null }
  return { input, deps, state, trace, binding, data }
}
function arm(f, purpose = B2A_PURPOSE_STOCK_PREPARATION_PLAN_VALIDATION) {
  const now = Date.parse('2026-10-01T12:00:00Z')
  const claims = new Map()
  f.deps.operationClaim = createB2aOperationClaim({ db: {
    async insertOne(_table, row) { claims.set(row.claim_key, clone(row)); return [clone(row)] },
    async selectOne(_table, where) { return clone(claims.get(where.claim_key) || null) },
  } })
  f.deps.now = () => now
  f.deps.registry = createB2aRegistry({ config: { b2aTrialRegistry: {
    registryId: 'synthetic-registry', registryVersion: 1, registrations: [{
      registrationId: 'synthetic-validation', registrationVersion: 1, tenantScope: f.input.identity.tenantId,
      sourceSystemType: KIND, sourceBindingRef: f.binding.id, projectDataScope: { dataScopeRefs: ['SYN'] },
      objectScope: { sourceObjects: Object.keys(f.data) }, purpose, ownerPrincipalRef: f.input.identity.actor,
      authorizationRef: 'synthetic-auth', operationRef: 'synthetic-op',
      effectiveAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-02T00:00:00Z',
      forbidReuse: true, sourceReadOperationLimit: 1, artifactReplayLimit: 0, consumptionState: 'unconsumed',
      consumedAt: null, b2bMigrationCondition: 'synthetic only', expiryHandling: 'deny_replay', status: 'active',
    }],
  } } })
}

test('real registry + resolver + SQL source adapter + BOM reader preserves caller and revision through schema/select', async () => {
  const f = fixture()
  const result = await createStockPreparationReadPlanValidationReader(f.deps)(f.input)
  assert.equal(result.sample.totalRows, 2)
  assert.equal(result.sample.rows[1].totalQuantity, 6)
  assert.equal(result.sample.rows[1].componentCode, 'CHILD-CODE')
  assert.deepEqual(f.trace[0], ['resolve', 'synthetic-connection', {
    tenantId: f.input.identity.tenantId, workspaceId: null, principal: f.input.identity.actor, runAs: 'user',
  }])
  assert.equal(f.trace.filter(row => row[0] === 'schema').length, 7)
  assert.ok(f.trace.some(row => row[0] === 'select'))
  assert.equal(result.canApply, false)
  assert.equal(result.tokenIssued, false)
})

test('distinct B2a purpose reaches actual canonical reader with both schema pin legs', async () => {
  const f = fixture(); arm(f)
  const result = await createStockPreparationReadPlanValidationReader(f.deps)(f.input)
  assert.equal(result.sample.totalRows, 2)
  assert.equal(f.trace.filter(row => row[0] === 'schema').length, 21)
  assert.ok(f.trace.filter(row => row[0] === 'select').every(row => row[5] === true))
})

test('a table-action B2a registration cannot be spent by the new validation consumer', async () => {
  const f = fixture(); arm(f, B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION)
  await assert.rejects(createStockPreparationReadPlanValidationReader(f.deps)(f.input), { code: 'B2A_SCOPE_MISMATCH' })
  assert.equal(f.trace.length, 0)
})

test('expected loaded revision reaches the actual facade boundary even if canonical resolution sees a newer revision', async () => {
  const f = fixture()
  f.state.onResolve = () => { f.state.revision = '20000000-0000-4000-8000-000000000002' }
  await assert.rejects(createStockPreparationReadPlanValidationReader(f.deps)(f.input), { code: 'READ_PLAN_VALIDATION_SOURCE_FAILED' })
  assert.equal(f.trace.filter(row => row[0] === 'select').length, 0)
})

test('B2a authorization-time lookup projection cannot change before canonical adapter construction', async () => {
  const f = fixture(); arm(f)
  const actual = f.deps.externalSystems.getExternalSystemForAdapter
  f.deps.externalSystems.getExternalSystemForAdapter = async input => {
    f.binding.config.lookupProjection = { lookupObject: 'syn.unapproved' }
    return actual(input)
  }
  await assert.rejects(createStockPreparationReadPlanValidationReader(f.deps)(f.input), { code: 'B2A_AUTHORIZATION_INVALID' })
  assert.equal(f.trace.filter(row => row[0] === 'schema' || row[0] === 'select').length, 0)
})

for (const change of ['tenant', 'workspace', 'connection', 'bridge', 'inactive', 'owner']) {
  test(`validation runtime refuses changed ${change} without source IO`, async () => {
    const f = fixture()
    if (change === 'tenant') f.input.version.tenantId = 'foreign'
    if (change === 'workspace') f.input.version.workspaceId = 'foreign'
    if (change === 'connection') f.binding.connection_id = 'other-connection'
    if (change === 'bridge') f.binding.kind = 'bridge:legacy-sql-readonly'
    if (change === 'inactive') f.binding.status = 'inactive'
    if (change === 'owner') f.input.identity = { ...f.input.identity, actor: 'other-admin' }
    await assert.rejects(createStockPreparationReadPlanValidationReader(f.deps)(f.input))
    assert.equal(f.trace.filter(row => row[0] === 'schema' || row[0] === 'select').length, 0)
  })
}
