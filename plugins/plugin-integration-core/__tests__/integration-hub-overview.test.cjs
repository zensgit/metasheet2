'use strict'

// ---------------------------------------------------------------------------
// 对接总览 — GET /api/integration/hub/overview
//
// Driven through the REAL route registration (registerIntegrationRoutes) against mock services, so
// every assertion below is about the shipped handler, not about a re-implementation of it.
//
// Three witnessed REDs are pinned here, each written to FAIL against a plausible wrong build:
//   RED-1  read-tier gate — the tier is pinned by ENUMERATION (every code that passes and a
//          principal below it that must not), so a gate that widened to "any authenticated user"
//          or narrowed to admin-only both fail.
//   RED-2  values-free — a fixture whose config carries a live connection string, host, port and
//          username, and whose last_error quotes a DSN. If ANY of those strings reaches the
//          serialized response, the test fails. It is written against the ACTUAL leak vector:
//          `sanitizeIntegrationPayload` does NOT strip baseUrl/host/port/username, so a handler
//          that merely passed the sanitized config through would be green under a weaker test and
//          red under this one.
//   RED-3  consumers join — the stock-prep table action bound to a system must name that system,
//          and unplugging the binding (server config removed) must make it disappear.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')

const HTTP_ROUTES_PATH = path.join(__dirname, '..', 'lib', 'http-routes.cjs')
const { registerIntegrationRoutes } = require(HTTP_ROUTES_PATH)
const {
  buildIntegrationHubOverview,
  collectDataSourcePointers,
  describeConnectorKind,
  describeWriteCapability,
  K3_FENCE_NOTICE,
} = require(path.join(__dirname, '..', 'lib', 'integration-hub-overview.cjs'))
const {
  K3_EXTERNAL_WRITE_TARGET_KIND,
  // The SAME predicate describeWriteCapability consults. The write-capability test derives the
  // expected fence dimension from it rather than hardcoding today's answer, so the assertion tracks
  // the in-flight fence extension (#5402) in lock-step instead of tripping whoever merges second.
  isK3ExternalWriteTargetKind,
} = require(path.join(__dirname, '..', 'lib', 'k3-external-write-permanent-fence.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

const OVERVIEW_PATH = '/api/integration/hub/overview'

// ---------------------------------------------------------------------------
// THE POISON. Every string here is something an operator must never see on this screen. They are
// planted in the places the product actually stores them: `config` (public, sanitized — and the
// sanitizer lets host/port/user through), `lastError` (free-form driver text), and the credential
// projection fields the public row already carries.
// ---------------------------------------------------------------------------
const POISON = Object.freeze({
  connectionString: 'Server=10.20.30.40,1433;Database=PLMDB;User Id=svc_plm;Password=hunter2;',
  baseUrl: 'https://k3.internal.corp:8080/K3API',
  host: '10.20.30.40',
  username: 'svc_plm',
  password: 'hunter2',
  database: 'PLMDB',
  lastErrorText: "connect ECONNREFUSED sqlserver://svc_plm@10.20.30.40:1433/PLMDB (login failed for user 'svc_plm')",
  credentialFingerprint: 'fp_dead_beef_cafe',
})

function poisonedConfig(extra = {}) {
  return {
    // Secret-shaped keys: the existing sanitizer WOULD catch these.
    connectionString: POISON.connectionString,
    password: POISON.password,
    // NOT secret-shaped: the sanitizer lets every one of these through untouched. These are the
    // strings that make this test a real RED rather than a restatement of payload-redaction.
    baseUrl: POISON.baseUrl,
    host: POISON.host,
    port: 1433,
    username: POISON.username,
    database: POISON.database,
    schema: 'dbo',
    ...extra,
  }
}

function externalSystem(overrides = {}) {
  return {
    id: 'sys_default',
    tenantId: 'tenant_1',
    workspaceId: null,
    projectId: null,
    name: '默认系统',
    kind: 'http',
    role: 'source',
    config: poisonedConfig(),
    capabilities: { secretFlag: POISON.username },
    status: 'active',
    lastTestedAt: '2026-08-30T02:00:00.000Z',
    lastError: POISON.lastErrorText,
    hasCredentials: true,
    credentialFormat: 'enc',
    credentialFingerprint: POISON.credentialFingerprint,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-30T02:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

function createEnvironment(options = {}) {
  const calls = []
  const routes = new Map()
  const record = (name, arg) => calls.push([name, arg])

  const systems = options.systems || []
  const pipelines = options.pipelines || []
  const readSourceConfigs = options.readSourceConfigs || []
  const compositions = options.compositions || []

  const dataSources = options.dataSources === null
    ? undefined
    : (options.dataSources || {
      async describe(dataSourceId, principal) {
        record('dataSources.describe', { dataSourceId, principal })
        const entry = (options.dataSourceDirectory || {})[dataSourceId]
        if (!entry) throw new Error(`Data source with id '${dataSourceId}' not found`)
        return entry
      },
    })

  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: { async findObjectSheet() { return null }, async resolveFieldIds() { return {} }, async ensureObject() { throw new Error('unused') } },
        records: { async queryRecords() { return [] }, async createRecord() { throw new Error('unused') }, async patchRecord() { throw new Error('unused') } },
      },
      ...(dataSources ? { dataSources } : {}),
    },
    storage: { async get() { return null }, async set() {}, async delete() {} },
    config: options.config || {},
  }

  const listOrThrow = (name, rows) => async (input) => {
    record(name, input)
    return rows
  }

  // TENANT-AWARE fake, mirroring external-systems.cjs listExternalSystems, which BOTH requires a
  // tenantId (requiredString throws without one) AND scopes its query to it. A fake that ignored its
  // argument — the previous `listOrThrow` shape here — is exactly the BAD GREEN this closes: it let
  // the handler's own tenant predicate be dropped with every suite still green, because nothing ever
  // looked at the tenantId reaching the store. Rows that DECLARE a tenant are scoped to it; rows
  // with no tenantId (the pipeline/config fixtures the other suites seed) are left untouched.
  const tenantScopedList = (name, rows) => async (input = {}) => {
    record(name, input)
    const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : ''
    if (!tenantId) {
      // Faithful to requiredString(input.tenantId, 'tenantId') in the real store: no tenant, no read.
      const error = new Error(`${name}: tenantId is required`)
      error.name = 'ExternalSystemValidationError'
      throw error
    }
    return rows.filter((row) => !row || typeof row.tenantId !== 'string' || row.tenantId === tenantId)
  }

  const services = {
    externalSystemRegistry: {
      listExternalSystems: tenantScopedList('listExternalSystems', systems),
      async upsertExternalSystem(input) { record('upsertExternalSystem', input); throw new Error('the overview must never write') },
      async getExternalSystem(input) { record('getExternalSystem', input); return systems[0] || null },
      async deleteExternalSystem(input) { record('deleteExternalSystem', input); throw new Error('the overview must never delete') },
      async getExternalSystemForAdapter(input) { record('getExternalSystemForAdapter', input); throw new Error('the overview must never load credentials') },
    },
    readSourceConfigStore: {
      list: listOrThrow('readSourceConfigList', readSourceConfigs),
      async saveVersion(input) { record('readSourceConfigSaveVersion', input); throw new Error('unused') },
      async get(input) { record('readSourceConfigGet', input); return null },
      async getForRuntime(input) { record('readSourceConfigGetForRuntime', input); return null },
      async approve(input) { record('readSourceConfigApprove', input); throw new Error('unused') },
      async retire(input) { record('readSourceConfigRetire', input); throw new Error('unused') },
      async listAudit(input) { record('readSourceConfigListAudit', input); return [] },
    },
    readSourceCompositionConfigStore: {
      list: listOrThrow('readSourceCompositionList', compositions),
      async saveVersion(input) { record('readSourceCompositionSaveVersion', input); throw new Error('unused') },
      async get(input) { record('readSourceCompositionGet', input); return null },
      async getForRuntime(input) { record('readSourceCompositionGetForRuntime', input); return null },
      async approve(input) { record('readSourceCompositionApprove', input); throw new Error('unused') },
      async retire(input) { record('readSourceCompositionRetire', input); throw new Error('unused') },
      async listAudit(input) { record('readSourceCompositionListAudit', input); return [] },
    },
    bridgeAgentChecklistStore: {
      async saveVersion() { throw new Error('unused') },
      async approve() { throw new Error('unused') },
      async retire() { throw new Error('unused') },
      async getForApply() { throw new Error('unused') },
    },
    adapterRegistry: {
      listAdapterKinds() { record('listAdapterKinds'); return ['http'] },
      createAdapter(input) { record('createAdapter', input); throw new Error('the overview must never construct an adapter') },
    },
    pipelineRegistry: {
      listPipelines: listOrThrow('listPipelines', pipelines),
      async upsertPipeline(input) { record('upsertPipeline', input); throw new Error('unused') },
      async getPipeline(input) { record('getPipeline', input); return null },
      async listPipelineRuns(input) { record('listPipelineRuns', input); return [] },
    },
    pipelineRunner: { async runPipeline(input) { record('runPipeline', input); throw new Error('unused') } },
    deadLetterStore: { async listDeadLetters(input) { record('listDeadLetters', input); return [] } },
    stagingInstaller: {
      listStagingDescriptors() { return [] },
      async installStaging(input) { record('installStaging', input); throw new Error('unused') },
    },
    templateRegistry: {
      async upsertTemplate() { throw new Error('unused') },
      async getTemplate() { throw new Error('unused') },
      async listTemplates() { return [] },
      async deleteTemplate() { throw new Error('unused') },
      async instantiateTemplate() { throw new Error('unused') },
    },
  }

  registerIntegrationRoutes({ context, services, logger: { warn() {}, error() {}, info() {} } })
  return { calls, routes }
}

async function getOverview(env, user, query = {}) {
  const handler = env.routes.get(`GET ${OVERVIEW_PATH}`)
  assert.ok(handler, `route GET ${OVERVIEW_PATH} must be registered`)
  const res = createResponse()
  await handler({ user, body: {}, query, params: {} }, res)
  assert.notEqual(res.body, undefined, 'the overview route always produces a JSON body')
  return res
}

function systemById(res, id) {
  const found = res.body.data.systems.find((system) => system.id === id)
  assert.ok(found, `expected system ${id} in the overview`)
  return found
}

// A real, VALID stock-prep table-action config — built off the shipped template so the registry's
// own normalizer accepts it. Anything less and the "consumer disappears" half of RED-3 would pass
// for the wrong reason (an invalid config also produces no consumer).
function stockPreparationActionConfig(externalSystemId) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: {
      externalSystemId,
      kind: 'data-source:sql-readonly',
    },
    target: {
      sheetId: 'sheet_stock_preparation_main',
      fieldIdMap: Object.fromEntries(
        STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, `fld_${field.id}`]),
      ),
    },
  }
}

// ===========================================================================================
// RED-1 — the read-tier gate, pinned by enumeration.
// ===========================================================================================
async function testReadTierGate() {
  const env = createEnvironment({ systems: [externalSystem({ id: 'sys_1' })] })

  // Unauthenticated: 401 before anything is read.
  const anonymous = await getOverview(env, undefined)
  assert.equal(anonymous.statusCode, 401, 'an unauthenticated caller is refused')
  assert.equal(anonymous.body.error.code, 'UNAUTHENTICATED')

  // BELOW the tier. `stock-prep:*` is a SEPARATE vocabulary that owns its whole namespace and
  // never falls through to integration:* — so a stock-prep operator, and any other authenticated
  // principal without an integration code, is refused. This is the honest statement of "below the
  // read tier": there is no principal holding integration WRITE but not READ, because
  // hasPermission('read') accepts integration:write. A build that widened this gate to "any
  // authenticated user" fails right here.
  for (const permissions of [
    [],
    ['stock-prep:read'],
    ['stock-prep:admin'],
    ['multitable:manage-schema'],
    ['role:user'],
  ]) {
    const res = await getOverview(env, { id: 'u', tenantId: 'tenant_1', permissions })
    assert.equal(res.statusCode, 403, `principal with ${JSON.stringify(permissions)} must be refused`)
    assert.equal(res.body.error.code, 'FORBIDDEN')
  }

  // INSIDE the tier — all four codes, each independently.
  const insiders = [
    { label: 'integration:read', user: { id: 'u1', tenantId: 'tenant_1', permissions: ['integration:read'] } },
    { label: 'integration:write', user: { id: 'u2', tenantId: 'tenant_1', permissions: ['integration:write'] } },
    { label: 'integration:admin', user: { id: 'u3', tenantId: 'tenant_1', permissions: ['integration:admin'] } },
    { label: 'role:admin', user: { id: 'u4', tenantId: 'tenant_1', roles: ['admin'] } },
  ]
  for (const insider of insiders) {
    const res = await getOverview(env, insider.user)
    assert.equal(res.statusCode, 200, `${insider.label} is inside the integration read tier`)
    assert.equal(res.body.ok, true)
  }

  // Tenant scoping still applies: a tenant-bound principal cannot steer the overview at another
  // tenant through the query string.
  const crossTenant = await getOverview(
    env,
    { id: 'u1', tenantId: 'tenant_1', permissions: ['integration:read'] },
    { tenantId: 'tenant_evil' },
  )
  assert.equal(crossTenant.statusCode, 403, 'cross-tenant steering is refused')
  assert.equal(crossTenant.body.error.code, 'TENANT_MISMATCH')

  console.log('  testReadTierGate OK')
}

// ===========================================================================================
// RED-1b — tenant scoping at the STORE boundary (not just the request-tenant door).
//
// The gate test above exercises the request-tenant-mismatch door (a caller supplying a foreign
// query.tenantId is refused by resolveTenantId BEFORE any store read). It says nothing about the
// OTHER half: that the overview's own systems read is actually SCOPED to the resolved tenant. That
// half was a BAD GREEN — dropping `tenantId` from the handler's listScope left every suite green,
// because the fake store ignored its argument and no assertion inspected the tenantId it received.
//
// This pins it at the store: the fake is tenant-aware (see tenantScopedList), seeded with two
// tenants' systems, and the assertion is isolation — tenant A sees only A's systems, none of B's,
// AND the id that reached the store is A's. Same cross-tenant class the sibling PR #5401 hardened;
// pinned here where the overview does its reads.
//
// Witnessed RED: delete `tenantId:` from `const listScope = { tenantId: scope.tenantId, ... }` in
// http-routes.cjs → the store is called with no tenantId → the faithful fake throws (as the real
// requiredString does) → statusCode is no longer 200 and this test reds. Restore → green.
// ===========================================================================================
async function testTenantScopingAtStoreBoundary() {
  const systems = [
    externalSystem({ id: 'sys_a1', name: '甲租户·系统一', tenantId: 'tenant_a', kind: 'http', config: {} }),
    externalSystem({ id: 'sys_a2', name: '甲租户·系统二', tenantId: 'tenant_a', kind: 'http', config: {} }),
    externalSystem({ id: 'sys_b1', name: '乙租户·系统', tenantId: 'tenant_b', kind: 'http', config: {} }),
  ]

  // Tenant A sees ONLY A's systems, never B's.
  const envA = createEnvironment({ systems })
  const resA = await getOverview(envA, { id: 'ua', tenantId: 'tenant_a', permissions: ['integration:read'] })
  assert.equal(resA.statusCode, 200, 'tenant A overview succeeds')
  assert.deepEqual(
    resA.body.data.systems.map((system) => system.id).sort(),
    ['sys_a1', 'sys_a2'],
    'tenant A sees exactly its own two systems',
  )
  assert.equal(
    resA.body.data.systems.some((system) => system.id === 'sys_b1'),
    false,
    'tenant A must NEVER see tenant B systems',
  )
  // The tenant predicate actually reached the store — not just the request door.
  const listCallA = envA.calls.find(([name]) => name === 'listExternalSystems')
  assert.ok(listCallA, 'listExternalSystems must be called')
  assert.equal(listCallA[1].tenantId, 'tenant_a', 'the overview scopes its systems read to the resolved tenant')

  // Tenant B sees ONLY B's system — the reverse direction, so the filter is not vacuously matching.
  const envB = createEnvironment({ systems })
  const resB = await getOverview(envB, { id: 'ub', tenantId: 'tenant_b', permissions: ['integration:read'] })
  assert.equal(resB.statusCode, 200)
  assert.deepEqual(resB.body.data.systems.map((system) => system.id), ['sys_b1'])

  console.log('  testTenantScopingAtStoreBoundary OK')
}

// ===========================================================================================
// RED-2 — values-free. No connection detail may reach the response, from any of its sources.
// ===========================================================================================
async function testValuesFreeBoundary() {
  const env = createEnvironment({
    systems: [
      externalSystem({ id: 'sys_bridge', name: 'PLM 只读桥', kind: 'data-source:sql-readonly', config: poisonedConfig({ dataSourceId: 'ds_plm' }) }),
      externalSystem({ id: 'sys_k3', name: 'K3 生产账套', kind: K3_EXTERNAL_WRITE_TARGET_KIND }),
    ],
    dataSourceDirectory: {
      // The host descriptor is poisoned too: a handler that spread the descriptor instead of
      // naming its three fields would leak these.
      ds_plm: {
        id: 'ds_plm',
        name: 'PLM 生产库(只读)',
        type: 'sqlserver',
        status: 'connected',
        connection: { host: POISON.host, port: 1433, database: POISON.database },
        credentials: { password: POISON.password },
      },
    },
  })

  const res = await getOverview(env, { id: 'u1', tenantId: 'tenant_1', permissions: ['integration:read'] })
  assert.equal(res.statusCode, 200)
  const serialized = JSON.stringify(res.body)

  for (const [label, value] of Object.entries(POISON)) {
    assert.ok(!serialized.includes(value), `values-free: "${label}" must not reach the overview response`)
  }
  assert.ok(!serialized.includes('1433'), 'values-free: a port number must not reach the response')
  assert.ok(!serialized.includes('"dbo"'), 'values-free: a schema name must not reach the response')

  // The permitted labels DO come through — the screen would be useless otherwise.
  assert.ok(serialized.includes('PLM 只读桥'), 'the operator-authored system name is shown')
  assert.ok(serialized.includes('PLM 生产库(只读)'), 'the operator-authored data source name is shown')
  assert.ok(serialized.includes('sqlserver'), 'the data source type is shown')

  // Structural: the whole class of leaky keys is absent, not merely value-scrubbed.
  for (const system of res.body.data.systems) {
    for (const forbidden of ['config', 'capabilities', 'credentials', 'hasCredentials', 'credentialFormat', 'credentialFingerprint', 'lastError']) {
      assert.ok(!(forbidden in system), `the projected system must not carry "${forbidden}"`)
    }
    assert.equal(typeof system.hasLastError, 'boolean', 'the failure signal is a boolean, never the text')
    for (const forbidden of ['connection', 'credentials', 'host', 'port', 'database', 'schema']) {
      assert.ok(!(forbidden in system.connection) || forbidden === 'connection', `connection block must not carry "${forbidden}"`)
    }
    assert.deepEqual(
      Object.keys(system.connection).sort(),
      ['bound', 'dataSourceId', 'model', 'name', 'resolved', 'status', 'type', 'unresolvedReason'],
      'the connection block is a closed key set',
    )
  }

  // hasLastError is TRUE here (the fixture has one) — proving the boolean is derived, not hardcoded.
  assert.equal(systemById(res, 'sys_bridge').hasLastError, true)

  // Nothing was written, no adapter was built, no credential was reloaded.
  for (const forbidden of ['upsertExternalSystem', 'deleteExternalSystem', 'getExternalSystemForAdapter', 'createAdapter', 'runPipeline', 'installStaging']) {
    assert.equal(env.calls.filter(([name]) => name === forbidden).length, 0, `the overview must not call ${forbidden}`)
  }

  console.log('  testValuesFreeBoundary OK')
}

// ===========================================================================================
// RED-3 — the consumers join, including the unplug direction.
// ===========================================================================================
async function testConsumersJoin() {
  const systems = [
    externalSystem({ id: 'sys_plm', name: 'PLM 只读桥', kind: 'data-source:sql-readonly', config: { dataSourceId: 'ds_plm' } }),
    externalSystem({ id: 'sys_k3', name: 'K3', kind: K3_EXTERNAL_WRITE_TARGET_KIND, config: {} }),
    externalSystem({ id: 'sys_idle', name: '闲置系统', kind: 'http', config: {} }),
  ]
  const pipelines = [
    { id: 'pipe_1', name: '物料同步', status: 'active', sourceSystemId: 'sys_plm', targetSystemId: 'sys_k3' },
    { id: 'pipe_self', name: '自环', status: 'draft', sourceSystemId: 'sys_k3', targetSystemId: 'sys_k3' },
  ]
  const readSourceConfigs = [
    { id: 'rsc_1', systemId: 'sys_plm', status: 'approved' },
    { id: 'rsc_2', systemId: 'sys_plm', status: 'approved' },
    { id: 'rsc_3', systemId: 'sys_k3', status: 'approved' },
  ]
  const compositions = [
    // Both steps read sys_plm -> ONE composition using it, not two.
    { id: 'comp_1', name: 'material-to-bom', status: 'approved', config: { steps: [{ readSourceConfigId: 'rsc_1' }, { readSourceConfigId: 'rsc_2' }] } },
    { id: 'comp_2', name: 'cross', status: 'approved', config: { steps: [{ readSourceConfigId: 'rsc_1' }, { readSourceConfigId: 'rsc_3' }] } },
  ]

  // --- PLUGGED IN: the 备料 table action is bound to sys_plm in SERVER config.
  const plugged = createEnvironment({
    systems,
    pipelines,
    readSourceConfigs,
    compositions,
    config: { stockPreparationTableActions: [stockPreparationActionConfig('sys_plm')] },
  })
  const res = await getOverview(plugged, { id: 'u1', tenantId: 'tenant_1', permissions: ['integration:read'] })
  assert.equal(res.statusCode, 200)

  const plm = systemById(res, 'sys_plm')
  const action = plm.consumers.find((consumer) => consumer.type === 'table-action')
  assert.ok(action, 'a system consumed by the stock-prep table action must list it')
  assert.equal(action.id, PLM_STOCK_PREPARATION_ACTION_ID)
  assert.equal(action.label.zh, 'BOM备料·同步', 'the action is named in plain words, not by its id')

  assert.deepEqual(
    plm.consumers.filter((c) => c.type === 'pipeline').map((c) => [c.id, c.role]),
    [['pipe_1', 'source']],
  )
  assert.equal(plm.consumers.find((c) => c.type === 'read-source-config').count, 2)
  assert.equal(plm.consumers.find((c) => c.type === 'read-source-composition').count, 2, 'two distinct compositions reach sys_plm')

  const k3 = systemById(res, 'sys_k3')
  assert.deepEqual(
    k3.consumers.filter((c) => c.type === 'pipeline').map((c) => [c.id, c.role]).sort(),
    [['pipe_1', 'target'], ['pipe_self', 'source'], ['pipe_self', 'target']].sort(),
    'a self-referential pipeline is reported on BOTH ends',
  )
  assert.equal(k3.consumers.find((c) => c.type === 'read-source-composition').count, 1)
  assert.equal(k3.consumers.some((c) => c.type === 'table-action'), false, 'the action names sys_plm, not sys_k3')

  assert.deepEqual(systemById(res, 'sys_idle').consumers, [], 'an unused system reports no consumers')

  // --- UNPLUGGED: the same deployment with the table action removed from server config.
  const unplugged = createEnvironment({ systems, pipelines, readSourceConfigs, compositions, config: {} })
  const after = await getOverview(unplugged, { id: 'u1', tenantId: 'tenant_1', permissions: ['integration:read'] })
  assert.equal(after.statusCode, 200, 'an unconfigured table action must not 5xx the whole overview')
  assert.equal(
    systemById(after, 'sys_plm').consumers.some((c) => c.type === 'table-action'),
    false,
    'unplug the binding -> the consumer is gone',
  )
  // ...and everything else about the card is unchanged.
  assert.equal(systemById(after, 'sys_plm').consumers.find((c) => c.type === 'read-source-config').count, 2)

  // --- REPOINTED: the same action bound to a different system moves with it.
  const repointed = createEnvironment({
    systems,
    pipelines,
    readSourceConfigs,
    compositions,
    config: { stockPreparationTableActions: [stockPreparationActionConfig('sys_idle')] },
  })
  const moved = await getOverview(repointed, { id: 'u1', tenantId: 'tenant_1', permissions: ['integration:read'] })
  assert.equal(systemById(moved, 'sys_idle').consumers.some((c) => c.type === 'table-action'), true)
  assert.equal(systemById(moved, 'sys_plm').consumers.some((c) => c.type === 'table-action'), false)

  console.log('  testConsumersJoin OK')
}

// ===========================================================================================
// The connection join, in all five of its states.
// ===========================================================================================
async function testConnectionJoin() {
  const systems = [
    externalSystem({ id: 'sys_resolved', kind: 'data-source:sql-readonly', config: { dataSourceId: 'ds_mine' } }),
    externalSystem({ id: 'sys_foreign', kind: 'data-source:sql-readonly', config: { dataSourceId: 'ds_theirs' } }),
    externalSystem({ id: 'sys_unbound', kind: 'data-source:sql-readonly', config: {} }),
    externalSystem({ id: 'sys_k3', kind: K3_EXTERNAL_WRITE_TARGET_KIND, config: {} }),
    externalSystem({ id: 'sys_internal', kind: 'metasheet:multitable', config: {} }),
  ]
  const env = createEnvironment({
    systems,
    dataSourceDirectory: { ds_mine: { id: 'ds_mine', name: '我的只读库', type: 'sqlserver', status: 'disconnected' } },
  })
  const res = await getOverview(env, { id: 'u1', tenantId: 'tenant_1', permissions: ['integration:read'] })

  assert.deepEqual(systemById(res, 'sys_resolved').connection, {
    model: 'data-source', bound: true, dataSourceId: 'ds_mine', resolved: true,
    name: '我的只读库', type: 'sqlserver', status: 'disconnected', unresolvedReason: null,
  })
  // Owned by someone else: bound, but deliberately unnamed.
  assert.deepEqual(systemById(res, 'sys_foreign').connection, {
    model: 'data-source', bound: true, dataSourceId: 'ds_theirs', resolved: false,
    name: null, type: null, status: null, unresolvedReason: 'not_visible',
  })
  assert.equal(systemById(res, 'sys_unbound').connection.bound, false)
  assert.equal(systemById(res, 'sys_unbound').connection.unresolvedReason, 'not_bound')
  assert.equal(systemById(res, 'sys_k3').connection.model, 'self-contained')
  assert.equal(systemById(res, 'sys_internal').connection.model, 'internal')

  // The descriptor is asked ONCE per distinct pointer, and only for the two bridge systems.
  const describeCalls = env.calls.filter(([name]) => name === 'dataSources.describe')
  assert.deepEqual(describeCalls.map(([, arg]) => arg.dataSourceId).sort(), ['ds_mine', 'ds_theirs'])
  assert.equal(describeCalls[0][1].principal, 'u1', 'the descriptor is resolved AS the request principal')
  assert.equal(res.body.data.dataSourceDirectory.available, true)

  // A host with no descriptor seam at all says so, rather than implying ownership.
  const bare = createEnvironment({ systems, dataSources: null })
  const bareRes = await getOverview(bare, { id: 'u1', tenantId: 'tenant_1', permissions: ['integration:read'] })
  assert.equal(bareRes.body.data.dataSourceDirectory.available, false)
  assert.equal(systemById(bareRes, 'sys_resolved').connection.unresolvedReason, 'directory_unavailable')

  console.log('  testConnectionJoin OK')
}

// ===========================================================================================
// Write-capability truth, including the permanent K3 fence and the honest 'unregistered' state.
// ===========================================================================================
async function testWriteCapabilityTruth() {
  // The register's NON-fence baseline, as independent literals — this half of the test still pins
  // the exact write-capability mapping (a bug returning 'none' for metasheet:multitable reds here).
  //
  // The FENCE is a SEPARATE authority. describeWriteCapability asks isK3ExternalWriteTargetKind
  // FIRST and returns 'fenced' whenever it is true, whatever the register would otherwise say. So we
  // derive the expected FENCE dimension from that same predicate rather than hardcoding today's
  // answer. This keeps the test correct across the in-flight fence extension #5402 (which adds
  // erp:k3-wise-sqlserver to the fence): the day the product auto-returns 'fenced' for that kind,
  // this expectation flips in lock-step — no edit, no CI break for whoever merges second. It is not
  // circular: the baseline values below are literal, only the fence branch tracks the predicate,
  // and that is exactly the one dimension #5402 changes.
  //
  // erp:k3-wise-sqlserver is 'unregistered' TODAY precisely because it is not yet fenced; http is
  // 'unregistered' because it declares source/target/bidirectional roles with a real upsert path.
  // Neither is claimed 只读 — a false absolute on the first screen an operator sees.
  const baselineWrites = {
    'metasheet:multitable': 'internal',
    'data-source:sql-write-gated': 'gated',
    'data-source:sql-readonly': 'none',
    'bridge:legacy-sql-readonly': 'none',
    'metasheet:staging': 'none',
    'plm:yuantus-wrapper': 'none',
    http: 'unregistered',
    'erp:k3-wise-sqlserver': 'unregistered',
    'some:kind-nobody-registered': 'unregistered',
  }
  const kinds = [K3_EXTERNAL_WRITE_TARGET_KIND, ...Object.keys(baselineWrites)]
  const expectedFor = (kind) => (isK3ExternalWriteTargetKind(kind)
    ? { writes: 'fenced', fenced: true }
    : { writes: baselineWrites[kind], fenced: false })

  const env = createEnvironment({
    systems: kinds.map((kind, index) => externalSystem({ id: `sys_${index}`, kind, config: {} })),
  })
  const res = await getOverview(env, { id: 'u1', tenantId: 'tenant_1', permissions: ['integration:read'] })

  kinds.forEach((kind, index) => {
    const system = systemById(res, `sys_${index}`)
    const expected = expectedFor(kind)
    assert.equal(system.writeCapability.reads, 'real', `${kind} reads are real`)
    assert.equal(system.writeCapability.writes, expected.writes, `${kind} write capability`)
    assert.equal(system.writeCapability.fenced, expected.fenced, `${kind} fence flag`)
    assert.equal(system.kind, kind, 'the raw kind token is carried verbatim for 技术详情')
    assert.equal(system.technical.kind, kind)
  })

  // The K3 WebAPI target is fenced TODAY and its card renders the fence sentence verbatim. This is
  // stable across #5402 — that PR ADDS a fenced kind, it never un-fences this one.
  const k3 = systemById(res, `sys_${kinds.indexOf(K3_EXTERNAL_WRITE_TARGET_KIND)}`)
  assert.equal(k3.writeCapability.fenced, true, 'the K3 WebAPI target is fenced')
  assert.deepEqual(k3.writeCapability.notice, { ...K3_FENCE_NOTICE })
  assert.equal(k3.writeCapability.notice.zh, '只读·永不写入', 'the K3 card renders the fence sentence verbatim')

  // An unregistered kind still gets a usable card.
  const custom = systemById(res, `sys_${kinds.indexOf('some:kind-nobody-registered')}`)
  assert.equal(custom.kindRegistered, false)
  assert.equal(custom.kindLabel.zh, '自定义连接器')

  console.log('  testWriteCapabilityTruth OK')
}

// ===========================================================================================
// Empty state, and the pure builder's own contracts.
// ===========================================================================================
async function testEmptyStateAndPureBuilder() {
  const env = createEnvironment({ systems: [] })
  const res = await getOverview(env, { id: 'u1', tenantId: 'tenant_1', permissions: ['integration:read'] })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.systemCount, 0)
  assert.deepEqual(res.body.data.systems, [])

  // The builder is pure: same inputs, byte-identical output (no clock, no env, no randomness).
  const input = {
    systems: [externalSystem({ id: 'sys_1', kind: 'data-source:sql-readonly', config: poisonedConfig({ dataSourceId: 'ds_1' }) })],
    pipelines: [],
    readSourceConfigs: [],
    compositions: [],
    tableActionBindings: [],
    dataSourceDescriptors: new Map([['ds_1', { resolved: true, name: 'n', type: 't', status: 'connected' }]]),
    dataSourceDirectoryAvailable: true,
  }
  assert.equal(
    JSON.stringify(buildIntegrationHubOverview(input)),
    JSON.stringify(buildIntegrationHubOverview(input)),
    'the projection is deterministic',
  )

  // Defensive shapes: garbage in does not throw, it is dropped.
  const junk = buildIntegrationHubOverview({ systems: [null, 'x', 42], pipelines: null, tableActionBindings: [{}] })
  assert.equal(junk.systemCount, 0)
  assert.deepEqual(junk.dataSourceDirectory, { available: false })

  // The pointer collector is the ONE place that decides which kinds carry a data source pointer.
  assert.deepEqual(
    collectDataSourcePointers([
      { kind: 'data-source:sql-readonly', config: { dataSourceId: 'a' } },
      { kind: 'data-source:sql-write-gated', config: { dataSourceId: 'b' } },
      { kind: 'data-source:sql-readonly', config: { dataSourceId: 'a' } },
      // A self-contained kind carrying a stray dataSourceId is NOT a bridge — the pointer is not
      // collected, and its card says 自带连接.
      { kind: 'erp:k3-wise-webapi', config: { dataSourceId: 'never' } },
      { kind: 'metasheet:multitable', config: { dataSourceId: 'never' } },
    ]).sort(),
    ['a', 'b'],
  )

  assert.equal(describeConnectorKind('data-source:sql-readonly').label.zh, '只读数据库桥接')
  assert.equal(describeConnectorKind('  ').registered, false)
  assert.equal(describeWriteCapability(K3_EXTERNAL_WRITE_TARGET_KIND).fenced, true)

  console.log('  testEmptyStateAndPureBuilder OK')
}

async function main() {
  await testReadTierGate()
  await testTenantScopingAtStoreBoundary()
  await testValuesFreeBoundary()
  await testConsumersJoin()
  await testConnectionJoin()
  await testWriteCapabilityTruth()
  await testEmptyStateAndPureBuilder()
  console.log('integration-hub-overview OK')
}

main().catch((err) => {
  console.error('integration-hub-overview FAILED')
  console.error(err)
  process.exit(1)
})
