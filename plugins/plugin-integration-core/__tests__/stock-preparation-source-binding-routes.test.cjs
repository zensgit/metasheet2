'use strict'

// 工作台里选源 — THE HTTP SURFACE. Two routes, and the property that justifies them:
//
//   Setting the binding through the API changes which source the NEXT table-action request reads,
//   in the SAME running process, with no restart and no re-registration.
//
// R-10 proves exactly that end to end: it mounts the routes ONCE (the object `activate()` builds),
// POSTs a new source, and then drives the real `tableActionDryRun` handler and asserts the external
// system the adapter loader asked for is the newly bound one. Mutate
// `applyPersistedSourceBinding` to ignore the resolver and R-10 goes red on the id.
//
// Covered:
//   R-10  POST -> the next dry-run loads the NEWLY BOUND source. Same process, same handlers.
//   R-11  the ADMIN gate on both legs: anonymous / reader / writer are refused, and refused BEFORE
//         any store, registry or external-system call.
//   R-12  the fallback: with nothing bound, GET reports `deploy_default` and the dry-run loads the
//         env-configured source — byte-identical to the pre-feature behaviour.
//   R-13  validation: an unknown id 404s; an ineligible kind / inactive / target-role / not-yours
//         data source 422s with its reason token; and NOTHING is persisted or audited on a refusal.
//   R-14  the body allowlist — only `externalSystemId`. A request cannot move kind, readPlan, target
//         or tenant.
//   R-15  the tenant on the WRITE leg is auth-derived: a mismatched carrier is refused.
//   R-16  the audit row: closed action, actor, old -> new, values-free detail; and the write is
//         refused outright when no audit store is wired.
//   R-17  the GET picker: eligible-only, plain-language kind labels, effective source + origin, and
//         the #5401 join drops a data source this principal does not own.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { createStockPreparationSourceBindingStore } = require(path.join(LIB, 'stock-preparation-source-binding-store.cjs'))
const { createStockPreparationAuditStore } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const TENANT = 'tenant-a'
const GET_ROUTE = '/api/integration/stock-preparation/source-binding'
const SET_ROUTE = '/api/integration/stock-preparation/source-binding'

const ENV_DEFAULT_SOURCE = 'sys_synthetic_demo'
const CUSTOMER_PLM = 'sys_customer_plm'

const ADMIN = Object.freeze({ id: 'u_admin', roles: ['admin'], tenantId: TENANT })
const WRITER = Object.freeze({ id: 'u_writer', permissions: ['integration:write'], tenantId: TENANT })
const READER = Object.freeze({ id: 'u_reader', permissions: ['integration:read'], tenantId: TENANT })

let passed = 0
let failed = 0

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
    })
    .catch((error) => {
      failed += 1
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function system(overrides = {}) {
  return {
    id: CUSTOMER_PLM,
    tenantId: TENANT,
    workspaceId: null,
    name: '客户 PLM 只读库',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    config: { dataSourceId: 'ds_customer' },
    capabilities: {},
    ...overrides,
  }
}

const DEFAULT_SYSTEMS = Object.freeze([
  system({ id: ENV_DEFAULT_SOURCE, name: '内置演示源', config: { dataSourceId: 'ds_demo' } }),
  system(),
  system({ id: 'sys_bridge', name: '旧库桥接', kind: 'bridge:legacy-sql-readonly', config: {} }),
  system({ id: 'sys_k3_write', name: 'K3 写接口', kind: 'erp:k3-wise-webapi', role: 'target', config: {} }),
  system({ id: 'sys_inactive', name: '未启用源', status: 'inactive' }),
  system({ id: 'sys_not_mine', name: '同事的连接', config: { dataSourceId: 'ds_someone_else' } }),
])

// The host's narrow, principal-gated descriptor seam (#5401 data plane: owner-only, NO admin
// bypass). `ds_someone_else` refuses for everybody here, which is what makes `sys_not_mine`
// ineligible even for a platform admin.
function createDataSourceDirectory() {
  const describeCalls = []
  return {
    describeCalls,
    async describe(dataSourceId, principal) {
      describeCalls.push({ dataSourceId, principal })
      if (dataSourceId === 'ds_someone_else') throw new Error(`Data source with id '${dataSourceId}' not found`)
      return { id: dataSourceId, name: dataSourceId, type: 'postgres', status: 'active' }
    },
  }
}

function createExternalSystemRegistry(systems = DEFAULT_SYSTEMS) {
  const calls = []
  return {
    calls,
    async listExternalSystems({ tenantId }) {
      calls.push({ op: 'list', tenantId })
      return systems.filter((entry) => entry.tenantId === tenantId).map((entry) => ({ ...entry }))
    },
    async getExternalSystem({ tenantId, id }) {
      calls.push({ op: 'get', tenantId, id })
      const found = systems.find((entry) => entry.id === id && entry.tenantId === tenantId)
      return found ? { ...found } : null
    },
    async getExternalSystemForAdapter({ tenantId, id }) {
      calls.push({ op: 'getForAdapter', tenantId, id })
      const found = systems.find((entry) => entry.id === id && entry.tenantId === tenantId)
      return found ? { ...found } : null
    },
    async upsertExternalSystem() { throw new Error('unexpected upsertExternalSystem') },
    async deleteExternalSystem() { throw new Error('unexpected deleteExternalSystem') },
  }
}

// A scoped-db stand-in returning the pg RESULT shape lib/db.cjs produces.
function createFakeDb() {
  const rows = []
  function matches(row, where) {
    return Object.entries(where).every(([column, value]) => (row[column] ?? null) === (value ?? null))
  }
  const handle = {
    rows,
    async selectOne(table, where) {
      return rows.find((row) => row.__table === table && matches(row, where)) || null
    },
    async select(table, { where } = {}) {
      return rows.filter((row) => row.__table === table && matches(row, where || {}))
    },
    async insertOne(table, row) {
      const stored = { __table: table, created_at: 't0', updated_at: 't0', ...row }
      rows.push(stored)
      return { rows: [{ ...stored }] }
    },
    async updateRow(table, set, where) {
      const target = rows.find((row) => row.__table === table && matches(row, where))
      if (!target) return { rows: [] }
      Object.assign(target, set)
      return { rows: [{ ...target }] }
    },
    async transaction(callback) {
      return callback(handle)
    },
  }
  return handle
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => {
      throw new Error(`unexpected service call: ${method}`)
    }
  }
  return service
}

function envConfiguredAction(externalSystemId = ENV_DEFAULT_SOURCE) {
  return [{
    actionId: ACTION_ID,
    source: { externalSystemId },
    target: { sheetId: 'sheet_stock_prep', objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId },
  }]
}

/**
 * Mount the real routes ONCE, exactly as `activate()` does. Everything a test later asserts about
 * "no restart" is asserted against THIS object graph — nothing is rebuilt between calls.
 */
function mount({ systems, withBindingStore = true, withAuditStore = true, withDataSourceDirectory = true, actions } = {}) {
  const routes = new Map()
  const db = createFakeDb()
  const bindingStore = createStockPreparationSourceBindingStore({ db, idGenerator: () => 'bind_1' })
  const auditStore = createStockPreparationAuditStore({ db, idGenerator: () => 'audit_1' })
  const externalSystemRegistry = createExternalSystemRegistry(systems)
  const dataSources = createDataSourceDirectory()
  // Records every adapter the runtime asked to build — this is how "which source did the next
  // request actually read" is observed, rather than trusting a response field.
  const adapterCalls = []
  const adapterRegistry = {
    listAdapterKinds() { return ['data-source:sql-readonly', 'bridge:legacy-sql-readonly'] },
    createAdapter(sourceSystem) {
      adapterCalls.push(sourceSystem.id)
      return {
        async read() {
          // The dry-run stops here: what matters is WHICH system produced this adapter.
          throw new Error(`SOURCE_READ_STOP:${sourceSystem.id}`)
        },
      }
    },
  }

  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      ...(withDataSourceDirectory ? { dataSources } : {}),
      multitable: {
        provisioning: {
          async findObjectSheet({ objectId }) { return { id: `sheet_${objectId}` } },
          async resolveFieldIds() { return {} },
        },
        records: { async queryRecords() { return [] } },
      },
    },
    storage: new Map(),
    config: { stockPreparationTableActions: actions === undefined ? envConfiguredAction() : actions },
  }

  const services = {
    externalSystemRegistry,
    adapterRegistry,
    // The 对接总览 join (R-18) reads these three lists alongside the external systems. They return
    // EMPTY rather than throwing so that route's own 500-on-inert-service noise cannot masquerade as
    // the binding assertion failing; every OTHER method on them stays inert.
    pipelineRegistry: { ...inertService(['upsertPipeline', 'getPipeline', 'listPipelineRuns']), async listPipelines() { return [] } },
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: { ...inertService(['saveVersion', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']), async list() { return [] } },
    readSourceCompositionConfigStore: { ...inertService(['saveVersion', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']), async list() { return [] } },
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    ...(withBindingStore ? { stockPreparationSourceBindingStore: bindingStore } : {}),
    ...(withAuditStore ? { stockPreparationAuditStore: auditStore } : {}),
  }

  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  return { routes, db, bindingStore, auditStore, externalSystemRegistry, dataSources, adapterCalls }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a body`)
  return res
}

/**
 * Drive the REAL dry-run route and report which external system the adapter was built from. The
 * source read then throws a marker, so nothing downstream runs — this observes the binding, not the
 * expansion.
 */
async function sourceUsedByNextDryRun(mounted) {
  const before = mounted.adapterCalls.length
  await call(mounted.routes, 'POST', '/api/integration/table-actions/:actionId/dry-run', {
    user: ADMIN,
    params: { actionId: ACTION_ID },
    body: { parameters: { projectNo: 'P-1' } },
  })
  const built = mounted.adapterCalls.slice(before)
  assert.equal(built.length, 1, 'the dry-run built exactly one source adapter')
  return built[0]
}

async function main() {
  // -------------------------------------------------------------------------
  // R-10 — THE HEADLINE. Same process, same handlers, no restart.
  // -------------------------------------------------------------------------
  await run('R-10 setting the binding changes which source the NEXT dry-run reads — same process, no restart', async () => {
    const mounted = mount()

    assert.equal(await sourceUsedByNextDryRun(mounted), ENV_DEFAULT_SOURCE, 'starts on the env-configured source')

    const saved = await call(mounted.routes, 'POST', SET_ROUTE, { user: ADMIN, body: { externalSystemId: CUSTOMER_PLM } })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.data.binding.externalSystemId, CUSTOMER_PLM)
    assert.equal(saved.body.data.changed, true)
    assert.equal(saved.body.data.takesEffectWithoutRestart, true)

    // NOTHING was re-registered, reloaded or restarted between these two lines.
    assert.equal(await sourceUsedByNextDryRun(mounted), CUSTOMER_PLM, 'the next dry-run reads the newly bound source')

    // And the GET now reports it as the live, persisted answer.
    const view = await call(mounted.routes, 'GET', GET_ROUTE, { user: ADMIN })
    assert.equal(view.body.data.effectiveExternalSystemId, CUSTOMER_PLM)
    assert.equal(view.body.data.origin, 'persisted')
    assert.equal(view.body.data.persistedBinding.updatedBy, ADMIN.id)
  })

  // -------------------------------------------------------------------------
  // R-11 — the ADMIN gate, and that it fires before anything else does.
  // -------------------------------------------------------------------------
  await run('R-11 both legs are integration-ADMIN gated, and refuse before any store or registry call', async () => {
    const mounted = mount()
    const legs = [['GET', GET_ROUTE, {}], ['POST', SET_ROUTE, { body: { externalSystemId: CUSTOMER_PLM } }]]

    for (const [method, routePath, extra] of legs) {
      for (const user of [undefined, READER, WRITER]) {
        const res = await call(mounted.routes, method, routePath, { ...extra, user })
        assert.equal(res.body.ok, false, `${method} rejects ${user ? user.id : 'anonymous'}`)
        assert.ok([401, 403].includes(res.statusCode), `${method} as ${user ? user.id : 'anonymous'} -> ${res.statusCode}`)
      }
    }
    // A write-tier principal is INSIDE the read tier but outside this one, which is the distinction
    // the picker depends on: it enumerates the choices whose Save would succeed.
    assert.deepEqual(mounted.externalSystemRegistry.calls, [], 'a refused caller reaches no external-system read')
    assert.deepEqual(mounted.dataSources.describeCalls, [], 'a refused caller reaches no data-source descriptor')
    assert.deepEqual(mounted.db.rows, [], 'a refused caller persists nothing and audits nothing')
  })

  // -------------------------------------------------------------------------
  // R-12 — the pre-migration state.
  // -------------------------------------------------------------------------
  await run('R-12 with nothing bound the env default stands and the GET says so', async () => {
    const mounted = mount()
    const view = await call(mounted.routes, 'GET', GET_ROUTE, { user: ADMIN })
    assert.equal(view.statusCode, 200)
    assert.equal(view.body.data.persistedBinding, null)
    assert.equal(view.body.data.origin, 'deploy_default')
    assert.equal(view.body.data.effectiveExternalSystemId, ENV_DEFAULT_SOURCE)
    assert.equal(view.body.data.effectiveSourceKind, 'data-source:sql-readonly')
    assert.equal(await sourceUsedByNextDryRun(mounted), ENV_DEFAULT_SOURCE)

    // And a deployment with NO binding store at all still serves the action off the env default —
    // absence degrades to the old behaviour, never to a wrong source.
    const noStore = mount({ withBindingStore: false })
    assert.equal(await sourceUsedByNextDryRun(noStore), ENV_DEFAULT_SOURCE)
    const refused = await call(noStore.routes, 'GET', GET_ROUTE, { user: ADMIN })
    assert.equal(refused.statusCode, 501)
    assert.equal(refused.body.error.code, 'SOURCE_BINDING_STORE_UNAVAILABLE')
  })

  // -------------------------------------------------------------------------
  // R-13 — validation, and that a refusal writes nothing.
  // -------------------------------------------------------------------------
  await run('R-13 an ineligible or unknown source is refused with its reason, and nothing is persisted', async () => {
    const cases = [
      ['sys_missing', 404, 'SOURCE_BINDING_SOURCE_NOT_FOUND', 'not_found'],
      ['sys_k3_write', 422, 'SOURCE_BINDING_SOURCE_INELIGIBLE', 'kind_ineligible'],
      ['sys_inactive', 422, 'SOURCE_BINDING_SOURCE_INELIGIBLE', 'not_active'],
      ['sys_not_mine', 422, 'SOURCE_BINDING_SOURCE_INELIGIBLE', 'data_source_not_accessible'],
    ]
    for (const [externalSystemId, status, code, reason] of cases) {
      const mounted = mount()
      const res = await call(mounted.routes, 'POST', SET_ROUTE, { user: ADMIN, body: { externalSystemId } })
      assert.equal(res.statusCode, status, `${externalSystemId} -> ${res.statusCode}`)
      assert.equal(res.body.ok, false)
      assert.equal(res.body.error.code, code, externalSystemId)
      assert.equal(res.body.error.details.reason, reason, externalSystemId)
      // The refusal never borrows the permanent K3 write-fence token (§15.2 E4-06): a mis-picked
      // source must not read as an attempted external write.
      assert.ok(!JSON.stringify(res.body).includes('K3_WISE_EXTERNAL_WRITE_DISABLED'), externalSystemId)
      assert.deepEqual(mounted.db.rows, [], `${externalSystemId} persisted nothing and audited nothing`)
      // And the action still reads what it read before.
      assert.equal(await sourceUsedByNextDryRun(mounted), ENV_DEFAULT_SOURCE, externalSystemId)
    }

    // A target-role system of an otherwise eligible kind is refused on ROLE, so the reason names the
    // property that actually disqualified it.
    const roleMounted = mount({
      systems: [...DEFAULT_SYSTEMS, system({ id: 'sys_write_target', role: 'target', config: { dataSourceId: 'ds_customer' } })],
    })
    const roleRes = await call(roleMounted.routes, 'POST', SET_ROUTE, { user: ADMIN, body: { externalSystemId: 'sys_write_target' } })
    assert.equal(roleRes.statusCode, 422)
    assert.equal(roleRes.body.error.details.reason, 'role_ineligible')
  })

  // -------------------------------------------------------------------------
  // R-14 — the body allowlist.
  // -------------------------------------------------------------------------
  await run('R-14 the body may name a source and nothing else', async () => {
    const mounted = mount()
    for (const body of [
      { externalSystemId: CUSTOMER_PLM, kind: 'bridge:legacy-sql-readonly' },
      { externalSystemId: CUSTOMER_PLM, readPlan: { sourceKind: 'x' } },
      { externalSystemId: CUSTOMER_PLM, target: { sheetId: 'sheet_evil' } },
      { externalSystemId: CUSTOMER_PLM, actionId: 'something.else' },
      { externalSystemId: CUSTOMER_PLM, tenantId: 'tenant-b' },
    ]) {
      const res = await call(mounted.routes, 'POST', SET_ROUTE, { user: ADMIN, body })
      assert.equal(res.statusCode, 400, JSON.stringify(body))
      assert.equal(res.body.error.code, 'SOURCE_BINDING_REQUEST_INVALID', JSON.stringify(body))
    }
    for (const body of [{}, { externalSystemId: '' }, { externalSystemId: '   ' }]) {
      const res = await call(mounted.routes, 'POST', SET_ROUTE, { user: ADMIN, body })
      assert.equal(res.statusCode, 400, JSON.stringify(body))
    }
    assert.deepEqual(mounted.db.rows, [], 'no malformed request persisted anything')
  })

  // -------------------------------------------------------------------------
  // R-15 — the write leg's tenant is auth-derived.
  // -------------------------------------------------------------------------
  await run('R-15 a tenantless admin cannot bind, and a mismatched tenant carrier is refused', async () => {
    const mounted = mount()
    const tenantless = await call(mounted.routes, 'POST', SET_ROUTE, {
      user: { id: 'u_platform', roles: ['admin'] },
      body: { externalSystemId: CUSTOMER_PLM },
    })
    assert.equal(tenantless.body.ok, false, 'a tenantless platform admin has no scope to bind in')
    assert.equal(tenantless.statusCode, 400)
    assert.equal(tenantless.body.error.code, 'TENANT_REQUIRED')

    // A carrier naming another tenant is refused by the allowlist BEFORE the tenant resolver even
    // sees it — two independent gates, and this one fires first.
    const carrier = await call(mounted.routes, 'POST', SET_ROUTE, {
      user: ADMIN,
      body: { externalSystemId: CUSTOMER_PLM },
      query: { tenantId: 'tenant-b' },
    })
    assert.equal(carrier.body.ok, false)
    assert.deepEqual(mounted.db.rows, [])
  })

  // -------------------------------------------------------------------------
  // R-16 — the audit row.
  // -------------------------------------------------------------------------
  await run('R-16 the change is audited with actor and old -> new, and refused outright without an audit store', async () => {
    const mounted = mount()
    await call(mounted.routes, 'POST', SET_ROUTE, { user: ADMIN, body: { externalSystemId: CUSTOMER_PLM } })

    const audits = mounted.db.rows.filter((row) => row.__table === 'integration_stock_prep_audit')
    assert.equal(audits.length, 1, 'exactly one audit row')
    assert.equal(audits[0].action, 'source_binding_set')
    assert.equal(audits[0].actor, ADMIN.id)
    assert.equal(audits[0].tenant_id, TENANT)
    assert.equal(audits[0].subject_id, CUSTOMER_PLM, 'the newly bound source is the subject')
    assert.equal(audits[0].mode, 'bound', 'first bind')
    assert.equal(audits[0].detail.changed, true)
    assert.equal(audits[0].detail.previousExternalSystemId, undefined, 'there was no previous binding')
    assert.equal(audits[0].detail.sourceKind, 'data-source:sql-readonly')

    // A REBIND records the id it replaced — the old/new pair a reviewer needs.
    await call(mounted.routes, 'POST', SET_ROUTE, { user: WRITER_ADMIN, body: { externalSystemId: 'sys_bridge' } })
    const rebind = mounted.db.rows.filter((row) => row.__table === 'integration_stock_prep_audit')[1]
    assert.equal(rebind.mode, 'rebound')
    assert.equal(rebind.actor, WRITER_ADMIN.id)
    assert.equal(rebind.subject_id, 'sys_bridge')
    assert.equal(rebind.detail.previousExternalSystemId, CUSTOMER_PLM)
    assert.equal(rebind.detail.changed, true)

    // Re-confirming the SAME source is still recorded, as changed:false.
    await call(mounted.routes, 'POST', SET_ROUTE, { user: ADMIN, body: { externalSystemId: 'sys_bridge' } })
    const resave = mounted.db.rows.filter((row) => row.__table === 'integration_stock_prep_audit')[2]
    assert.equal(resave.detail.changed, false)
    assert.equal(resave.mode, 'rebound')

    // Values-free: nothing in any audit row carries connection material.
    const serialized = JSON.stringify(audits.concat(rebind, resave))
    for (const forbidden of ['ds_customer', 'ds_demo', 'password', 'dataSourceId']) {
      assert.ok(!serialized.includes(forbidden), `audit rows must not carry ${forbidden}`)
    }

    // No audit store -> the WRITE is refused. An unaudited repoint of a customer's data source is
    // exactly what this trail exists to prevent.
    const unaudited = mount({ withAuditStore: false })
    const refused = await call(unaudited.routes, 'POST', SET_ROUTE, { user: ADMIN, body: { externalSystemId: CUSTOMER_PLM } })
    assert.equal(refused.statusCode, 501)
    assert.equal(refused.body.error.code, 'AUDIT_STORE_UNAVAILABLE')
    assert.deepEqual(unaudited.db.rows, [], 'the binding did not land either')
    assert.equal(await sourceUsedByNextDryRun(unaudited), ENV_DEFAULT_SOURCE)
  })

  // -------------------------------------------------------------------------
  // R-17 — the picker.
  // -------------------------------------------------------------------------
  await run('R-17 the GET offers only bindable sources, in plain language, honouring data-source ownership', async () => {
    const mounted = mount()
    const res = await call(mounted.routes, 'GET', GET_ROUTE, { user: ADMIN })
    assert.equal(res.statusCode, 200)
    const data = res.body.data
    assert.equal(data.actionId, ACTION_ID)
    assert.equal(data.takesEffectWithoutRestart, true)

    const offered = data.eligibleSources.map((row) => row.externalSystemId).sort()
    assert.deepEqual(offered, [CUSTOMER_PLM, ENV_DEFAULT_SOURCE, 'sys_bridge'].sort())
    // The K3 write connector, the inactive source and the colleague's connection are ABSENT, not
    // greyed out — R-11: what is not permitted must not be visible.
    for (const excluded of ['sys_k3_write', 'sys_inactive', 'sys_not_mine']) {
      assert.ok(!offered.includes(excluded), `${excluded} must not be offered`)
    }

    // Plain language first (#5391), reusing 对接总览's own kind register.
    const plm = data.eligibleSources.find((row) => row.externalSystemId === CUSTOMER_PLM)
    assert.equal(plm.name, '客户 PLM 只读库')
    assert.equal(plm.kindLabel.zh, '只读数据库桥接')
    assert.equal(plm.kindLabel.en, 'Read-only database bridge')
    assert.equal(plm.status, 'active')
    // Nothing off the system's config reaches the wire.
    assert.ok(!JSON.stringify(data).includes('ds_customer'))
    assert.ok(!JSON.stringify(data).includes('ds_demo'))

    // A host WITHOUT the descriptor seam must not silently empty the picker — undecided is not
    // disqualifying, so the two data-source-backed systems stay offered.
    const noDirectory = mount({ withDataSourceDirectory: false })
    const fallback = await call(noDirectory.routes, 'GET', GET_ROUTE, { user: ADMIN })
    assert.deepEqual(
      fallback.body.data.eligibleSources.map((row) => row.externalSystemId).sort(),
      [CUSTOMER_PLM, ENV_DEFAULT_SOURCE, 'sys_bridge', 'sys_not_mine'].sort(),
    )
  })

  // -------------------------------------------------------------------------
  // R-18 — 对接总览 must agree with the runtime about which system 备料 reads.
  //
  // That screen's table-action lookup used to pass only `{ actionId }`, which was harmless while the
  // source could only come from process env (one answer per process). With a per-tenant override it
  // is not: an unscoped lookup reports the ENV DEFAULT while every actual read uses the bound
  // source, so the overview would quietly disagree with the runtime — and because the lookup sits
  // inside a try/catch that renders "no consumer", the disagreement would be silent.
  // -------------------------------------------------------------------------
  await run('R-18 the 对接总览 consumer card reports the BOUND source, not the deploy-time default', async () => {
    const mounted = mount()
    const before = await call(mounted.routes, 'GET', '/api/integration/hub/overview', { user: ADMIN })
    assert.equal(before.statusCode, 200)
    const beforeIds = JSON.stringify(before.body.data)
    assert.ok(beforeIds.includes(ENV_DEFAULT_SOURCE), 'unbound, the overview shows the env default')

    await call(mounted.routes, 'POST', SET_ROUTE, { user: ADMIN, body: { externalSystemId: CUSTOMER_PLM } })

    const after = await call(mounted.routes, 'GET', '/api/integration/hub/overview', { user: ADMIN })
    assert.equal(after.statusCode, 200)
    // The 备料 consumer must now hang off the customer's PLM. Located by walking the projection for
    // the action id rather than pinning the overview's own shape, which this change does not own.
    const consumers = JSON.stringify(after.body.data)
    assert.ok(consumers.includes(ACTION_ID), 'the 备料 action still appears as a consumer')
    const boundCard = (after.body.data.systems || []).find((entry) => entry.id === CUSTOMER_PLM)
    const defaultCard = (after.body.data.systems || []).find((entry) => entry.id === ENV_DEFAULT_SOURCE)
    assert.ok(boundCard, 'the bound system is on the overview')
    assert.ok(
      JSON.stringify(boundCard).includes(ACTION_ID),
      'the 备料 consumer moved to the bound source',
    )
    assert.ok(
      !JSON.stringify(defaultCard).includes(ACTION_ID),
      'the 备料 consumer no longer hangs off the deploy-time default',
    )
  })

  const total = passed + failed
  console.log(`\nstock-preparation-source-binding-routes: ${passed}/${total} passed`)
  if (failed > 0) {
    console.error(`${failed} test(s) failed`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-source-binding-routes')
}

// A second tenant-bound platform admin, used to prove the audit records WHO rebound.
const WRITER_ADMIN = Object.freeze({ id: 'u_admin2', roles: ['admin'], tenantId: TENANT })

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
