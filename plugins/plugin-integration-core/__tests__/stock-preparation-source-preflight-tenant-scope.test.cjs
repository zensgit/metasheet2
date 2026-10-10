'use strict'

// 源就绪预检 (SOURCE PREFLIGHT) — THE TABLE-ACTION LOOKUP, AND WHOSE TENANT IT RUNS UNDER.
//
// THE DEFECT. The route looked its table action up with `getTableAction({ actionId })` — no tenant.
// A deployment that wires the persisted source-binding store (index.cjs does, wherever there is a
// SQL db) makes the registry refuse a tenant-less lookup
// (TABLE_ACTION_SOURCE_BINDING_SCOPE_REQUIRED), and the route's blanket `catch` turned that refusal
// into "no action configured". Neither web entry point sends `externalSystemId`, so both got
// `409 SOURCE_PREFLIGHT_NO_SOURCE` before anything was loaded — the binding owner and everyone else
// alike. The existing route suite could not see it: its harness mounts the routes WITHOUT a binding
// store, which is not the shape a deployment with a database has.
//
// WHY THE FIX IS ALSO A TENANT DECISION. Giving the lookup a tenant means choosing which one, and the
// tenant this route already used for its load (`resolveTenantId`) accepts `user.tenantId`, which the
// host's auth middleware fills from the `x-tenant-id` REQUEST HEADER when the verified token carries
// no tenant claim. The report is not values-free: `checks.projectData.livenessSamples` carries up to
// two observed project numbers. Resolving the bound source under a header-chosen tenant would
// therefore have made an existing cross-tenant read easier (no source id needed) rather than fixing
// anything. So the route now PROVES its tenant, once, before it looks at anything — and that one
// value drives the lookup, the binding peek and the load.
//
// THE PROOF IS THE ONE EVERY VALUE-BEARING STOCK-PREP READ ALREADY USES: `resolveProvenOwnTenant`
// (stock-preparation-operator-scope.cjs), the tenant half of `resolveOperatorValueScope` without its
// stock-prep tier. It prefers the verified claim and refuses a carried tenant that contradicts it,
// refuses a principal with no tenant and a request-named tenant that is not the principal's, and makes
// the HOST DIRECTORY vouch for the (principal, tenant) pairing. So a claimless token whose header names
// the caller's OWN tenant is served when the directory says "member", and a header naming any other
// tenant is refused — before any lookup, with the same answer whatever that tenant holds.
//
// WHAT THIS SUITE PINS (each has a RED witness — see the PR body's mutation table):
//   TS-01 REPRODUCTION. Binding store wired, the binding owner, the four query shapes the two web
//         entry points can send: 200, the BOUND source was read, under the owner's tenant.
//   TS-02 THE PERSISTED BINDING IS PER TENANT, AND THE DEPLOY DEFAULT STILL STANDS WHERE NONE EXISTS.
//   TS-03 A NON-OWNER WITH THE RIGHT PERMISSION. The lookup resolves the bound source; the load is
//         handed the REQUESTER's identity (no delegation); the host's refusal is what they get, and
//         nothing was read. A stock-prep operator without an integration tier is still 403.
//   TS-04 THE PRINCIPAL TABLE: claim; no claim + own header with the directory vouching / refusing /
//         absent; no claim + another tenant's header; no claim and no header; a claim the directory
//         refuses; two memberships; platform admin (claimed / tenantless / header). Each row names
//         exactly which (principal, tenant) pairs the directory was asked about.
//   TS-05 NAMING ANOTHER TENANT TEACHES NOTHING. A tenant that has a source and a binding, a tenant
//         that has nothing and a tenant that never existed answer with the same status, code and body,
//         and none of them costs a lookup.
//   TS-06 THE SOURCE-NAMING (API) SHAPE IS HELD TO THE SAME TENANT.
//   TS-07 ONE TENANT VALUE: the binding lookup, the binding peek and the load all carry it.
//   TS-08 THE SWALLOW IS GONE. "Not configured" still degrades to the default plan; a binding store
//         that cannot answer is a fixed, values-free refusal and nothing is read.
//   TS-09 REFUSALS ARE VALUES-FREE: no tenant id, no source id, no principal, no store message.
//   TS-10 STRUCTURE: the handler proves the tenant (and applies the staged claim door) before the
//         lookup, hands the proof the verified claim, every request-carried tenant and the host
//         directory, and reaches for no request-steerable resolver.
//   TS-11 THE STAGED CLAIM DOOR (MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED). Armed, a claimless
//         caller the directory vouches for is refused BEFORE the lookup; a claim-bearing one is
//         served. Disarmed, the same claimless caller is served.
//
// Hermetic: no DB, no network. The binding store is the REAL one over an in-memory db; the external
// system registry, the adapter, the host directory and the logger are spies. The directory spy answers
// from a membership table, the way the host's (packages/core-backend/src/services/
// tenant-principal-directory-boundary.ts) answers from `user_orgs`: "member" only for a listed pair.
//
// WHAT THE REGISTRY SPY DOES AND DOES NOT PROVE. It refuses a `data-source:*` load whose principal is
// not the stamped owner, which is the host facade's rule, restated here so a non-owner's answer can be
// shown. That refusal is the HOST's to make and is tested where it lives. What this suite proves is
// the plugin's half: WHICH tenant and WHICH principal the route hands over.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { createStockPreparationSourceBindingStore } = require(path.join(LIB, 'stock-preparation-source-binding-store.cjs'))
const { SOURCE_PREFLIGHT_ROUTE_PATH } = require(path.join(LIB, 'stock-preparation-source-preflight.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))

const ROUTES_SRC = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')

const TENANT_OWN = 'tenant-own'
const TENANT_OTHER = 'tenant-other'
const TENANT_EMPTY = 'tenant-empty'
const TENANT_NEVER_EXISTED = 'tenant-never-existed'

const SYS_OWN = 'sys_own_bound'
const SYS_OTHER = 'sys_other_bound'
const SYS_DEPLOY_DEFAULT = 'sys_deploy_default'
const SYS_INVENTED = 'sys_invented'

const OWNER_OF_OWN = 'u_owner_own'

// THE HOST DIRECTORY'S MEMBERSHIP TABLE, as `user_orgs` would hold it: one row per (principal, tenant)
// pair. A principal not listed has no membership at all — the shape of an account created by a
// bootstrap script or by the user-management screen without an organisation.
const MEMBERSHIPS = Object.freeze({
  [OWNER_OF_OWN]: Object.freeze([TENANT_OWN]),
  u_reader_own: Object.freeze([TENANT_OWN]),
  u_reader_empty: Object.freeze([TENANT_EMPTY]),
  u_floor_own: Object.freeze([TENANT_OWN]),
  u_member_own: Object.freeze([TENANT_OWN]),
  u_prober: Object.freeze([TENANT_OWN]),
  u_admin: Object.freeze([TENANT_OWN]),
})

// Made-up project numbers. They exist so a leak is OBSERVABLE: a response that carries one of
// tenant-other's says whose source was read.
const PROJECTS_OF = Object.freeze({
  [TENANT_OWN]: Object.freeze(['P-TEST-001', 'P-TEST-002']),
  [TENANT_OTHER]: Object.freeze(['P-TEST-901', 'P-TEST-902']),
})

const STORE_FAILURE_TEXT = 'connect ECONNREFUSED db-host.invalid:5432 (user=svc_reader)'

const DEFAULT_SYSTEMS = Object.freeze([
  Object.freeze({
    id: SYS_OWN,
    tenantId: TENANT_OWN,
    workspaceId: null,
    kind: 'data-source:sql-readonly',
    connectionId: 'conn_own',
    status: 'active',
    config: Object.freeze({ dataSourceOwnerId: OWNER_OF_OWN }),
  }),
  // The OTHER tenant's source is a SELF-CONTAINED kind on purpose: it carries its own connection, so
  // no host owner check stands between a caller and its rows. Whatever keeps a stranger out of it
  // has to be the tenant this route resolves — which is what makes it the witness for that.
  Object.freeze({
    id: SYS_OTHER,
    tenantId: TENANT_OTHER,
    workspaceId: null,
    kind: 'bridge:legacy-sql-readonly',
    connectionId: null,
    status: 'active',
    config: Object.freeze({}),
  }),
])

let passed = 0
let failed = 0

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  ✓ ${name}`)
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

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

/** A scoped-db stand-in returning the pg RESULT shape lib/db.cjs produces. */
function createFakeDb() {
  const rows = []
  const matches = (row, where) => Object.entries(where)
    .every(([column, value]) => (row[column] ?? null) === (value ?? null))
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
    async selectOneForKeyShare(_table, where) {
      return { id: where.id, tenant_id: where.tenant_id }
    },
    async transaction(callback) { return callback(handle) },
    async setTransactionIsolationLevel() {},
  }
  return handle
}

/** A source shaped like the vendor family the shipped read plan describes; values are synthetic. */
function catalogOf(tenantId) {
  const projects = PROJECTS_OF[tenantId] || []
  return {
    DN_PDM_PathExAttrInfo: projects.map((fileCode, index) => ({
      ID: index + 1,
      FileCode: fileCode,
      Parent_OBJ_ID: `PATH-${index + 1}`,
      NodeType: index === 0 ? 2 : 1,
    })),
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1', Parent_OBJ_ID: null }],
    DN_PDM_OrderHeadInfo: [{ ID: 1, OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ ID: 1, order_id: 'ORDER-1', part_id: 'PART-1', sort_id: 0, quantity: '1' }],
    DN_PDM_PartLibraryInfo: [{ ID: 1, OBJ_ID: 'PART-1', IdentityNo: 'DWG-1', IdentityName: 'part-1', SysVer: 'V1', isable: 0 }],
    DN_PDM_BomHeadInfo: [{ ID: 1, part_id: 'PART-1', bom_id: 'BOM-1', SysVer: 'V1', bom_able: 1 }],
    DN_PDM_BomDetailsInfo: [{ ID: 1, bom_pid: 'BOM-1', part_id: 'PART-1', sort_id: 0, Bom_ExAttr1: '2', Bom_ExAttr2: 'PCS' }],
    DN_PM_BomExAttrInfo: [],
    DN_PM_BomExAttrInfo_header: [],
    DN_PM_PartExAttrInfo: [],
    DN_PM_OrderExAttrInfo: [],
  }
}

// Mirrors external-systems.cjs's `selectScopedRow`: exact (tenant, workspace, id) first; a NON-null
// hint that misses falls back ONCE to the same tenant's tenant-wide row; it never crosses `tenantId`.
function selectScopedSystem(systems, { tenantId, workspaceId = null, id }) {
  const hint = workspaceId ?? null
  const exact = systems.find((entry) => entry.id === id && entry.tenantId === tenantId && (entry.workspaceId ?? null) === hint)
  if (exact) return exact
  if (hint === null) return null
  return systems.find((entry) => entry.id === id && entry.tenantId === tenantId && (entry.workspaceId ?? null) === null) || null
}

function notFound(input) {
  const error = new Error('external system not found')
  error.name = 'ExternalSystemNotFoundError'
  error.details = { id: input.id, tenantId: input.tenantId, workspaceId: input.workspaceId ?? null }
  return error
}

function createRecordingLogger() {
  const warnCalls = []
  return {
    warnCalls,
    info() {},
    warn(message, payload) { warnCalls.push([message, payload]) },
    error() {},
  }
}

/**
 * Mount the real routes the way `activate()` does on a deployment with a SQL db — binding store
 * WIRED, which is the shape the existing route suite does not mount.
 */
async function mount({
  systems = DEFAULT_SYSTEMS,
  withBindingStore = true,
  bindingStoreFails = false,
  memberships = MEMBERSHIPS,
  withDirectory = true,
  actions,
  bindings = [
    { tenantId: TENANT_OWN, workspaceId: null, externalSystemId: SYS_OWN },
    { tenantId: TENANT_OTHER, workspaceId: null, externalSystemId: SYS_OTHER },
  ],
} = {}) {
  const routes = new Map()
  const calls = { bindingGets: [], peeks: [], loads: [], adapters: [], reads: [], directory: [] }

  const registry = {
    ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
    async getExternalSystem(input) {
      calls.peeks.push({ via: 'getExternalSystem', tenantId: input.tenantId, workspaceId: input.workspaceId ?? null, id: input.id })
      const found = selectScopedSystem(systems, input)
      if (!found) throw notFound(input)
      return { ...found, config: { ...found.config } }
    },
    async getExternalSystemAdapterConfig(input) {
      calls.peeks.push({ via: 'getExternalSystemAdapterConfig', tenantId: input.tenantId, workspaceId: input.workspaceId ?? null, id: input.id })
      const found = selectScopedSystem(systems, input)
      if (!found) throw notFound(input)
      return { id: found.id, kind: found.kind, connectionId: found.connectionId, config: { ...found.config } }
    },
    async getExternalSystemForAdapter(input) {
      calls.loads.push({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId ?? null,
        id: input.id,
        principal: input.principal,
        runAs: input.runAs,
      })
      const found = selectScopedSystem(systems, input)
      if (!found) throw notFound(input)
      if (found.kind === 'data-source:sql-readonly' && input.principal !== found.config.dataSourceOwnerId) {
        // The host facade's rule, restated: strict owner equality, one uniform refusal.
        const error = new Error('canonical connection is unavailable')
        error.name = 'ExternalSystemValidationError'
        error.details = { field: 'connectionId', code: 'CONNECTION_CANONICAL_UNAVAILABLE' }
        throw error
      }
      return { ...found, config: { ...found.config } }
    },
  }

  const adapterRegistry = {
    listAdapterKinds() { return ['data-source:sql-readonly', 'bridge:legacy-sql-readonly'] },
    createAdapter(system, deps) {
      calls.adapters.push({ id: system.id, tenantId: system.tenantId, principal: deps && deps.principal })
      const catalog = catalogOf(system.tenantId)
      return {
        async read(request) {
          calls.reads.push({ tenantId: system.tenantId, id: system.id, object: request.object })
          const key = Object.keys(catalog).find((name) => name.toLowerCase() === String(request.object).toLowerCase())
          if (!key) {
            const error = new Error(`Invalid object name '${request.object}'.`)
            error.code = 'EREQUEST'
            throw error
          }
          return { records: catalog[key].slice(0, request.limit) }
        },
      }
    },
  }

  const db = createFakeDb()
  const realStore = createStockPreparationSourceBindingStore({ db, idGenerator: () => `bind_${db.rows.length + 1}` })
  for (const binding of bindings) {
    await realStore.set({ ...binding, actionId: PLM_STOCK_PREPARATION_ACTION_ID, actor: 'seed' })
  }
  // The REAL store's answers, observed. `get` is the only method the registry's resolver calls.
  const bindingStore = {
    async get(scope) {
      calls.bindingGets.push({ tenantId: scope.tenantId, workspaceId: scope.workspaceId ?? null, actionId: scope.actionId })
      if (bindingStoreFails) throw new Error(STORE_FAILURE_TEXT)
      return realStore.get(scope)
    },
    set: realStore.set,
  }

  // The host directory the route's tenant proof asks. It answers from `memberships` only, and records
  // every question, so each case can say exactly which (principal, tenant) pairs were asked about.
  const tenantPrincipalDirectory = {
    async verifyTenantMembership(input) {
      calls.directory.push({ userId: input.userId, tenantId: input.tenantId })
      const tenants = Object.prototype.hasOwnProperty.call(memberships, input.userId) ? memberships[input.userId] : []
      return { member: tenants.includes(input.tenantId) }
    },
  }

  const logger = createRecordingLogger()
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
      },
      multitable: { provisioning: {}, records: {} },
    },
    storage: new Map(),
    config: actions === null
      ? {}
      : {
          stockPreparationTableActions: actions || [{
            actionId: PLM_STOCK_PREPARATION_ACTION_ID,
            source: { externalSystemId: SYS_DEPLOY_DEFAULT, kind: 'data-source:sql-readonly' },
            target: { sheetId: 'sheet_stock', objectId: 'stockPreparationMain' },
          }],
        },
  }

  httpRoutes.registerIntegrationRoutes({
    context,
    services: {
      // SA-02: this legacy-path fixture explicitly models a reachable empty plan ledger.
      stockPreparationReadPlanStore: { async getActiveForRuntime() { return null } },
      externalSystemRegistry: registry,
      adapterRegistry,
      pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
      pipelineRunner: inertService(['runPipeline']),
      deadLetterStore: inertService(['listDeadLetters']),
      stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
      templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
      readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
      readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
      bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
      ...(withDirectory ? { tenantPrincipalDirectory } : {}),
      ...(withBindingStore ? { stockPreparationSourceBindingStore: bindingStore } : {}),
    },
    logger,
  })
  return { routes, calls, logger }
}

/**
 * WHAT THE HOST HANDS THE PLUGIN (packages/core-backend/src/auth/jwt-middleware.ts), modelled, not
 * assumed:
 *   a tenant claim in the verified token -> `req.authenticatedTenantId` AND `user.tenantId` are it,
 *                                           and an `x-tenant-id` header is ignored;
 *   no claim, a header                   -> `user.tenantId` is the HEADER's value, and
 *                                           `req.authenticatedTenantId` is absent;
 *   no claim, no header                  -> neither is set.
 * There is deliberately no default: a principal that should carry a claim names it.
 */
function requestOf({ id, permissions = [], roles, claim, header, carried, query = {} }) {
  const user = { id, permissions: [...permissions], ...(roles ? { roles: [...roles] } : {}) }
  if (claim) user.tenantId = claim
  else if (header) user.tenantId = header
  // `carried` forces a user.tenantId that disagrees with the claim — not a state the middleware
  // produces, but one the resolver is specified to refuse.
  if (carried) user.tenantId = carried
  return {
    user,
    body: {},
    query: { ...query },
    params: {},
    headers: header ? { 'x-tenant-id': header } : {},
    ...(claim ? { authenticatedTenantId: claim } : {}),
  }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function callRoute(mounted, principal) {
  const handler = mounted.routes.get(`GET ${SOURCE_PREFLIGHT_ROUTE_PATH}`)
  assert.ok(handler, `route GET ${SOURCE_PREFLIGHT_ROUTE_PATH} is registered`)
  const res = createResponse()
  await handler(requestOf(principal), res)
  assert.notEqual(res.body, undefined, 'the route produced a body')
  return res
}

function plain(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value))
}

function codeOf(res) {
  return res.body && res.body.error ? res.body.error.code : null
}

function assertNoIo(mounted, label) {
  assert.deepEqual(mounted.calls.bindingGets, [], `${label}: the binding store was not asked`)
  assert.deepEqual(mounted.calls.peeks, [], `${label}: no external system row was peeked`)
  assert.deepEqual(mounted.calls.loads, [], `${label}: no external system was loaded`)
  assert.deepEqual(mounted.calls.adapters, [], `${label}: no adapter was built`)
  assert.deepEqual(mounted.calls.reads, [], `${label}: the source was not read`)
}

/** Every tenant, source, principal and project handle this suite knows — none may reach a refusal. */
const HANDLES_THAT_MUST_NOT_TRAVEL = Object.freeze([
  TENANT_OWN, TENANT_OTHER, TENANT_EMPTY, TENANT_NEVER_EXISTED,
  SYS_OWN, SYS_OTHER, SYS_DEPLOY_DEFAULT,
  OWNER_OF_OWN,
  'conn_own',
  ...PROJECTS_OF[TENANT_OWN], ...PROJECTS_OF[TENANT_OTHER],
  'db-host.invalid', 'svc_reader', 'ECONNREFUSED',
])

function assertCarriesNoHandle(res, label, { except = [] } = {}) {
  const text = JSON.stringify(res.body)
  for (const handle of HANDLES_THAT_MUST_NOT_TRAVEL) {
    if (except.includes(handle)) continue
    assert.equal(text.includes(handle), false, `${label}: the answer must not carry ${JSON.stringify(handle)}`)
  }
}

function handlerBody(src, name) {
  const start = src.indexOf(`\n    async ${name}(req, res) {`)
  assert.notEqual(start, -1, `handler ${name} exists`)
  const next = src.indexOf('\n    async ', start + 1)
  return src.slice(start, next === -1 ? src.length : next)
}

// ---------------------------------------------------------------------------
// principals
// ---------------------------------------------------------------------------

const READ = Object.freeze(['integration:read'])

const OWNER = Object.freeze({ id: OWNER_OF_OWN, permissions: READ, claim: TENANT_OWN })
const NON_OWNER_READER = Object.freeze({ id: 'u_reader_own', permissions: READ, claim: TENANT_OWN })
const STOCK_PREP_OPERATOR = Object.freeze({ id: 'u_floor_own', permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE], claim: TENANT_OWN })

/** The query shapes the two web entry points can produce (sourcePreflight.ts, buildQueryString). */
const WEB_QUERY_SHAPES = Object.freeze([
  ['ops panel, empty page scope', {}],
  ['page scope with a tenant', { tenantId: TENANT_OWN }],
  ['page scope with a tenant and a workspace hint', { tenantId: TENANT_OWN, workspaceId: 'default' }],
  ['install view re-run with a declared bridge', { tenantId: TENANT_OWN, workspaceId: 'default', declaredBridge: 'order-module' }],
])

async function main() {
  // -------------------------------------------------------------------------
  // TS-01 — THE REPRODUCTION
  // -------------------------------------------------------------------------
  await run('TS-01 the binding owner, called the way the web calls, is answered — not refused 409', async () => {
    for (const [shape, query] of WEB_QUERY_SHAPES) {
      const mounted = await mount()
      const res = await callRoute(mounted, { ...OWNER, query })
      assert.equal(res.statusCode, 200, `${shape}: answered (was 409 ${'SOURCE_PREFLIGHT_NO_SOURCE'}), got ${res.statusCode} ${codeOf(res)}`)
      assert.equal(res.body.ok, true, shape)
      assert.equal(res.body.data.externalSystemId, SYS_OWN, `${shape}: the source checked is the one this tenant BOUND`)
      assert.deepEqual(
        mounted.calls.bindingGets[0],
        { tenantId: TENANT_OWN, workspaceId: query.workspaceId || null, actionId: PLM_STOCK_PREPARATION_ACTION_ID },
        `${shape}: the binding was looked up under the caller's tenant`,
      )
      assert.equal(mounted.calls.loads.length, 1, `${shape}: exactly one load`)
      assert.equal(mounted.calls.loads[0].tenantId, TENANT_OWN, `${shape}: loaded under the caller's tenant`)
      assert.equal(mounted.calls.loads[0].id, SYS_OWN, `${shape}: loaded the bound source`)
      assert.ok(mounted.calls.reads.length > 0, `${shape}: the source was actually measured`)
      assert.ok(mounted.calls.reads.every((read) => read.tenantId === TENANT_OWN), `${shape}: every read hit the caller's own source`)
      assert.deepEqual(res.body.data.checks.projectData.livenessSamples, [...PROJECTS_OF[TENANT_OWN]],
        `${shape}: the evidence is the caller's own`)
    }
  })

  // -------------------------------------------------------------------------
  // TS-02 — per tenant, and the deploy default
  // -------------------------------------------------------------------------
  await run('TS-02 the persisted binding is per tenant; without one the deploy default stands; unconfigured is still 409', async () => {
    // A tenant that bound nothing resolves the DEPLOY-TIME default — under its own tenant, where no
    // such row exists, so the registry's own not-found is the answer. Never another tenant's binding.
    const unbound = await mount()
    const res = await callRoute(unbound, { id: 'u_reader_empty', permissions: READ, claim: TENANT_EMPTY })
    assert.deepEqual(unbound.calls.bindingGets.map((call) => call.tenantId), [TENANT_EMPTY])
    assert.deepEqual(unbound.calls.loads.map((call) => [call.tenantId, call.id]), [[TENANT_EMPTY, SYS_DEPLOY_DEFAULT]])
    assert.equal(res.statusCode, 404)
    assert.deepEqual(unbound.calls.reads, [], 'nothing was read')

    // No action configured at all: the documented "not plugged in" state keeps its own refusal.
    const unconfigured = await mount({ actions: null, bindings: [] })
    const none = await callRoute(unconfigured, OWNER)
    assert.equal(none.statusCode, 409)
    assert.equal(codeOf(none), 'SOURCE_PREFLIGHT_NO_SOURCE')
    assertNoIo(unconfigured, 'unconfigured deployment')

    // ...and naming a source on an unconfigured deployment still measures it, on the default plan.
    const named = await mount({ actions: null, bindings: [] })
    const measured = await callRoute(named, { ...OWNER, query: { externalSystemId: SYS_OWN } })
    assert.equal(measured.statusCode, 200)
    assert.equal(measured.body.data.externalSystemId, SYS_OWN)

    // No binding store wired (the pre-079 shape): the deploy default, under the caller's tenant.
    const storeless = await mount({
      withBindingStore: false,
      actions: [{
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        source: { externalSystemId: SYS_OWN, kind: 'data-source:sql-readonly' },
        target: { sheetId: 'sheet_stock', objectId: 'stockPreparationMain' },
      }],
    })
    const viaDefault = await callRoute(storeless, OWNER)
    assert.equal(viaDefault.statusCode, 200)
    assert.deepEqual(storeless.calls.loads.map((call) => [call.tenantId, call.id]), [[TENANT_OWN, SYS_OWN]])
  })

  // -------------------------------------------------------------------------
  // TS-03 — the non-owner
  // -------------------------------------------------------------------------
  await run('TS-03 a non-owner holding the read tier reads as THEMSELVES and gets the host`s refusal; nothing is read', async () => {
    const mounted = await mount()
    const res = await callRoute(mounted, { ...NON_OWNER_READER, query: { tenantId: TENANT_OWN, workspaceId: 'default' } })
    assert.equal(mounted.calls.bindingGets.length, 1, 'the bound source WAS resolved for them')
    assert.deepEqual(
      mounted.calls.loads,
      [{ tenantId: TENANT_OWN, workspaceId: 'default', id: SYS_OWN, principal: NON_OWNER_READER.id, runAs: 'user' }],
      'the load carried the REQUESTER`s identity — the binding owner`s was not borrowed',
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.details.code, 'CONNECTION_CANONICAL_UNAVAILABLE')
    assert.deepEqual(mounted.calls.adapters, [], 'no adapter was built')
    assert.deepEqual(mounted.calls.reads, [], 'the source was not read')
    assertCarriesNoHandle(res, 'non-owner refusal')

    // The stock-prep namespace still does not open this route (R-11), and costs nothing.
    const floor = await mount()
    const refused = await callRoute(floor, STOCK_PREP_OPERATOR)
    assert.equal(refused.statusCode, 403)
    assert.equal(codeOf(refused), 'FORBIDDEN')
    assertNoIo(floor, 'stock-prep operator')
  })

  // -------------------------------------------------------------------------
  // TS-04 — the principal table
  // -------------------------------------------------------------------------
  await run('TS-04 each principal ends up with the documented tenant and answer', async () => {
    const refused = (code, status = 403) => ({ status, code })
    const TENANT_REQUIRED = 'OPERATOR_SCOPE_TENANT_REQUIRED'
    const MEMBERSHIP_DENIED = 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED'
    const MISMATCH = 'OPERATOR_SCOPE_TENANT_MISMATCH'
    const CONTRADICTED = 'OPERATOR_SCOPE_TENANT_CONTRADICTED'
    const DIRECTORY_UNAVAILABLE = 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE'
    const asked = (...pairs) => pairs.map(([userId, tenantId]) => ({ userId, tenantId }))
    const TWO_MEMBERSHIPS = Object.freeze({ ...MEMBERSHIPS, [OWNER_OF_OWN]: Object.freeze([TENANT_OWN, TENANT_OTHER]) })
    const table = [
      // [label, principal, expected, mount options]
      ['token with a tenant claim', { ...OWNER, query: { tenantId: TENANT_OWN } },
        { status: 200, tenant: TENANT_OWN, directory: asked([OWNER_OF_OWN, TENANT_OWN]) }],
      ['token with a tenant claim + an x-tenant-id header naming another tenant (the host ignores the header)',
        { ...OWNER, header: TENANT_OTHER },
        { status: 200, tenant: TENANT_OWN, directory: asked([OWNER_OF_OWN, TENANT_OWN]) }],
      // THE RESCUE M1 IS FOR: a member whose token carries no claim (a token minted before the
      // membership row existed, or an account with two memberships and no organisation chosen).
      ['no claim + header naming its own tenant, the directory vouches (the binding owner)',
        { id: OWNER_OF_OWN, permissions: READ, header: TENANT_OWN, query: { tenantId: TENANT_OWN } },
        { status: 200, tenant: TENANT_OWN, directory: asked([OWNER_OF_OWN, TENANT_OWN]) }],
      ['no claim + header naming its own tenant, the directory vouches (not the connection owner)',
        { id: 'u_member_own', permissions: READ, header: TENANT_OWN },
        { status: 400, tenant: TENANT_OWN, directory: asked(['u_member_own', TENANT_OWN]) }],
      ['no claim + header naming a tenant, the directory says no (an account with no membership)',
        { id: 'u_no_membership', permissions: READ, header: TENANT_OWN, query: { tenantId: TENANT_OWN } },
        { ...refused(MEMBERSHIP_DENIED), directory: asked(['u_no_membership', TENANT_OWN]) }],
      ['no claim + header naming its own tenant, NO directory wired',
        { id: OWNER_OF_OWN, permissions: READ, header: TENANT_OWN },
        { ...refused(DIRECTORY_UNAVAILABLE, 501), directory: [] }, { withDirectory: false }],
      ['no claim + header naming ANOTHER tenant',
        { id: OWNER_OF_OWN, permissions: READ, header: TENANT_OTHER, query: { tenantId: TENANT_OTHER } },
        { ...refused(MEMBERSHIP_DENIED), directory: asked([OWNER_OF_OWN, TENANT_OTHER]) }],
      ['no claim + header naming its own tenant + a query naming another',
        { id: OWNER_OF_OWN, permissions: READ, header: TENANT_OWN, query: { tenantId: TENANT_OTHER } },
        { ...refused(MISMATCH), directory: [] }],
      ['no claim, no header', { id: 'u_claimless', permissions: READ },
        { ...refused(TENANT_REQUIRED), directory: [] }],
      ['no claim, no header, a tenant named in the query', { id: OWNER_OF_OWN, permissions: READ, query: { tenantId: TENANT_OWN } },
        { ...refused(TENANT_REQUIRED), directory: [] }],
      ['a claim the directory does not vouch for (membership gone since sign-in)',
        { id: 'u_no_membership', permissions: READ, claim: TENANT_OWN },
        { ...refused(MEMBERSHIP_DENIED), directory: asked(['u_no_membership', TENANT_OWN]) }],
      ['a claim, NO directory wired', { ...OWNER },
        { ...refused(DIRECTORY_UNAVAILABLE, 501), directory: [] }, { withDirectory: false }],
      ['two memberships, no organisation chosen at sign-in (no claim), no header',
        { id: OWNER_OF_OWN, permissions: READ },
        { ...refused(TENANT_REQUIRED), directory: [] }, { memberships: TWO_MEMBERSHIPS }],
      ['two memberships, no claim, the header names one of them',
        { id: OWNER_OF_OWN, permissions: READ, header: TENANT_OWN },
        { status: 200, tenant: TENANT_OWN, directory: asked([OWNER_OF_OWN, TENANT_OWN]) }, { memberships: TWO_MEMBERSHIPS }],
      ['two memberships, no claim, the header names the other one (a tenant it IS a member of)',
        { id: OWNER_OF_OWN, permissions: READ, header: TENANT_OTHER },
        { status: 200, tenant: TENANT_OTHER, directory: asked([OWNER_OF_OWN, TENANT_OTHER]) }, { memberships: TWO_MEMBERSHIPS }],
      ['platform admin with a tenant claim, who owns the source', { id: OWNER_OF_OWN, roles: ['admin'], claim: TENANT_OWN },
        { status: 200, tenant: TENANT_OWN, directory: asked([OWNER_OF_OWN, TENANT_OWN]) }],
      ['platform admin with a tenant claim, naming another tenant', { id: 'u_admin', roles: ['admin'], claim: TENANT_OWN, query: { tenantId: TENANT_OTHER } },
        { ...refused(MISMATCH), directory: [] }],
      ['tenantless platform admin', { id: 'u_admin', roles: ['admin'] },
        { ...refused(TENANT_REQUIRED), directory: [] }],
      ['tenantless platform admin naming a tenant in the query', { id: 'u_admin', roles: ['admin'], query: { tenantId: TENANT_OTHER } },
        { ...refused(TENANT_REQUIRED), directory: [] }],
      ['platform admin, no claim + header naming a tenant it is not a member of', { id: 'u_admin', roles: ['admin'], header: TENANT_OTHER },
        { ...refused(MEMBERSHIP_DENIED), directory: asked(['u_admin', TENANT_OTHER]) }],
      ['token with a claim, a query naming another tenant', { ...OWNER, query: { tenantId: TENANT_OTHER } },
        { ...refused(MISMATCH), directory: [] }],
      ['token with a claim, a carried tenant that contradicts it', { ...OWNER, carried: TENANT_OTHER },
        { ...refused(CONTRADICTED), directory: [] }],
    ]
    for (const [label, principal, expected, options] of table) {
      const mounted = await mount(options)
      const res = await callRoute(mounted, principal)
      assert.equal(res.statusCode, expected.status, `${label}: status (got ${res.statusCode} ${codeOf(res)})`)
      assert.deepEqual(mounted.calls.directory, expected.directory, `${label}: the (principal, tenant) pairs the host directory was asked about`)
      if (expected.status === 200) {
        assert.deepEqual(mounted.calls.bindingGets.map((call) => call.tenantId), [expected.tenant], `${label}: lookup tenant`)
        assert.deepEqual(mounted.calls.loads.map((call) => call.tenantId), [expected.tenant], `${label}: load tenant`)
        assert.ok(mounted.calls.reads.every((read) => read.tenantId === expected.tenant), `${label}: read tenant`)
        assert.deepEqual(res.body.data.checks.projectData.livenessSamples, [...PROJECTS_OF[expected.tenant]], `${label}: whose evidence`)
      } else if (expected.status === 400) {
        // Admitted to its own tenant, then refused by the host's owner check at the load — the same
        // answer TS-03 pins for a claim-bearing non-owner. Nothing was read.
        assert.deepEqual(mounted.calls.bindingGets.map((call) => call.tenantId), [expected.tenant], `${label}: lookup tenant`)
        assert.deepEqual(mounted.calls.loads.map((call) => [call.tenantId, call.principal]), [[expected.tenant, principal.id]], `${label}: loaded as the requester`)
        assert.deepEqual(mounted.calls.reads, [], `${label}: nothing was read`)
      } else {
        assert.equal(codeOf(res), expected.code, `${label}: code`)
        assertNoIo(mounted, label)
        assertCarriesNoHandle(res, label)
      }
    }
  })

  // -------------------------------------------------------------------------
  // TS-05 — naming another tenant teaches nothing
  // -------------------------------------------------------------------------
  await run('TS-05 a tenant with a source and a tenant with nothing give the same answer, at the same cost', async () => {
    // Every prober is a member of tenant-own and of nothing else. The ones that carry the named tenant
    // in a header reach the host directory — the directory is the proof — and are refused on its
    // answer; nothing is looked up for any of them.
    const probers = [
      ['no claim, the header names it', (tenant) => ({ id: 'u_prober', permissions: READ, header: tenant })],
      ['no claim, header and query name it', (tenant) => ({ id: 'u_prober', permissions: READ, header: tenant, query: { tenantId: tenant } })],
      ['no claim, only the query names it', (tenant) => ({ id: 'u_prober', permissions: READ, query: { tenantId: tenant } })],
      ['no claim, own header, the query names it', (tenant) => ({ id: 'u_prober', permissions: READ, header: TENANT_OWN, query: { tenantId: tenant } })],
      ['own claim, the query names it', (tenant) => ({ ...NON_OWNER_READER, query: { tenantId: tenant } })],
      ['tenantless platform admin, the query names it', (tenant) => ({ id: 'u_admin', roles: ['admin'], query: { tenantId: tenant } })],
      ['platform admin, no claim, the header names it', (tenant) => ({ id: 'u_admin', roles: ['admin'], header: tenant })],
    ]
    // With and without naming a source: the one that exists there, and one that exists nowhere.
    const sourceShapes = [
      ['no source named', () => ({})],
      ['a source named', (tenant) => ({ externalSystemId: tenant === TENANT_OTHER ? SYS_OTHER : SYS_INVENTED })],
    ]
    for (const [proberLabel, proberOf] of probers) {
      for (const [sourceLabel, sourceOf] of sourceShapes) {
        const answers = []
        for (const tenant of [TENANT_OTHER, TENANT_EMPTY, TENANT_NEVER_EXISTED]) {
          const label = `${proberLabel} / ${sourceLabel} / ${tenant}`
          const mounted = await mount()
          const base = proberOf(tenant)
          const res = await callRoute(mounted, { ...base, query: { ...(base.query || {}), ...sourceOf(tenant) } })
          assert.equal(res.statusCode, 403, `${label}: refused (got ${res.statusCode} ${codeOf(res)})`)
          assertNoIo(mounted, label)
          // The directory is asked about the named tenant or not at all — never about anything a
          // lookup produced, because there was no lookup.
          assert.ok(
            mounted.calls.directory.every((call) => call.tenantId === tenant),
            `${label}: the directory was asked only about the tenant the request named`,
          )
          assertCarriesNoHandle(res, label)
          answers.push({ status: res.statusCode, body: plain(res.body), directoryQuestions: mounted.calls.directory.length })
        }
        assert.deepEqual(answers[0], answers[1], `${proberLabel} / ${sourceLabel}: a tenant with a source answers like a tenant with nothing`)
        assert.deepEqual(answers[1], answers[2], `${proberLabel} / ${sourceLabel}: ...and like a tenant that never existed`)
      }
    }
  })

  // -------------------------------------------------------------------------
  // TS-06 — the source-naming shape
  // -------------------------------------------------------------------------
  await run('TS-06 naming a source does not move the tenant: another tenant`s id is an invented id', async () => {
    const answers = []
    for (const id of [SYS_OTHER, SYS_INVENTED]) {
      const mounted = await mount()
      const res = await callRoute(mounted, { ...OWNER, query: { tenantId: TENANT_OWN, externalSystemId: id } })
      assert.deepEqual(mounted.calls.loads.map((call) => [call.tenantId, call.id]), [[TENANT_OWN, id]], `${id}: looked for under the caller's tenant only`)
      assert.deepEqual(mounted.calls.reads, [], `${id}: nothing was read`)
      answers.push({ status: res.statusCode, code: codeOf(res), message: res.body.error.message })
    }
    assert.deepEqual(answers[0], answers[1], 'a source that exists in another tenant is indistinguishable from one that exists nowhere')
    assert.equal(answers[0].status, 404)

    // And the claimless header principal, who could name tenant-other's source and read it before
    // (on main). It is a member of tenant-own only, so the host refuses the pairing it carried.
    const mounted = await mount()
    const res = await callRoute(mounted, {
      id: 'u_prober', permissions: READ, header: TENANT_OTHER, query: { tenantId: TENANT_OTHER, externalSystemId: SYS_OTHER },
    })
    assert.equal(res.statusCode, 403)
    assert.equal(codeOf(res), 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED')
    assertNoIo(mounted, 'header + named source')
    assert.equal(JSON.stringify(res.body).includes(PROJECTS_OF[TENANT_OTHER][0]), false, 'no evidence from the other tenant travels')
  })

  // -------------------------------------------------------------------------
  // TS-07 — one tenant value
  // -------------------------------------------------------------------------
  await run('TS-07 the lookup, the binding peek and the load all run under the one resolved tenant', async () => {
    const mounted = await mount()
    const res = await callRoute(mounted, { ...OWNER, query: { workspaceId: 'default' } })
    assert.equal(res.statusCode, 200)
    const tenants = new Set([
      ...mounted.calls.bindingGets.map((call) => call.tenantId),
      ...mounted.calls.peeks.map((call) => call.tenantId),
      ...mounted.calls.loads.map((call) => call.tenantId),
    ])
    assert.deepEqual([...tenants], [TENANT_OWN])
    assert.equal(mounted.calls.bindingGets.length, 1, 'one binding lookup')
    assert.equal(mounted.calls.peeks.length, 1, 'one peek')
    assert.equal(mounted.calls.loads.length, 1, 'one load')
    assert.equal(mounted.calls.peeks[0].id, SYS_OWN, 'the peek read the row the load resolved')
    // The binding half is still reported, and still as a boolean and two closed words.
    const delegation = res.body.data.checks.pullDelegation
    assert.equal(delegation.available, true)
    assert.equal(delegation.bindingShape, 'canonical')
    assert.equal(delegation.reason, null)

    // A non-string tenantId cannot stand in for one: the claim is the tenant, the array is not read.
    const arrayed = await mount()
    const viaArray = await callRoute(arrayed, { ...OWNER, query: { tenantId: [TENANT_OTHER] } })
    const arrayTenants = new Set([
      ...arrayed.calls.bindingGets.map((call) => call.tenantId),
      ...arrayed.calls.loads.map((call) => call.tenantId),
      ...arrayed.calls.reads.map((call) => call.tenantId),
    ])
    assert.ok([...arrayTenants].every((tenant) => tenant === TENANT_OWN), 'an array-valued tenantId moved nothing')
    assert.equal(JSON.stringify(viaArray.body).includes(PROJECTS_OF[TENANT_OTHER][0]), false)
  })

  // -------------------------------------------------------------------------
  // TS-08 — the swallow
  // -------------------------------------------------------------------------
  await run('TS-08 a binding store that cannot answer is a fixed refusal, not "no source" and not the default plan', async () => {
    for (const [shape, query] of [['no source named', {}], ['a source named', { externalSystemId: SYS_OWN }]]) {
      const mounted = await mount({ bindingStoreFails: true })
      const res = await callRoute(mounted, { ...OWNER, query })
      assert.equal(res.statusCode, 503, `${shape}: got ${res.statusCode} ${codeOf(res)}`)
      assert.equal(codeOf(res), 'SOURCE_PREFLIGHT_BINDING_UNAVAILABLE', shape)
      assert.deepEqual(mounted.calls.loads, [], `${shape}: nothing was loaded on a guess`)
      assert.deepEqual(mounted.calls.reads, [], `${shape}: nothing was read on a guess`)
      assertCarriesNoHandle(res, shape)
      assert.deepEqual(Object.keys(res.body.error.details || {}), [], `${shape}: no details`)
      // The reason reaches the log as ONE closed-list word, never as the store's own text.
      const logged = JSON.stringify(mounted.logger.warnCalls)
      assert.equal(mounted.logger.warnCalls.length, 1, `${shape}: one warn line`)
      for (const fragment of ['db-host.invalid', 'svc_reader', 'ECONNREFUSED', TENANT_OWN, OWNER_OF_OWN]) {
        assert.equal(logged.includes(fragment), false, `${shape}: the log line must not carry ${fragment}`)
      }
    }
  })

  // -------------------------------------------------------------------------
  // TS-09 — refusals are values-free
  // -------------------------------------------------------------------------
  await run('TS-09 every tenant refusal is a code and a fixed sentence — no details, no echo', async () => {
    const refusals = [
      // the membership refusal, the steering refusal, the no-tenant refusal, the contradiction refusal
      { id: 'u_prober', permissions: READ, header: TENANT_OTHER, query: { tenantId: TENANT_OTHER, externalSystemId: SYS_OTHER } },
      { ...OWNER, query: { tenantId: TENANT_OTHER, externalSystemId: SYS_OTHER } },
      { id: 'u_admin', roles: ['admin'], query: { tenantId: TENANT_OTHER } },
      { ...OWNER, carried: TENANT_OTHER, query: { externalSystemId: SYS_OTHER } },
    ]
    const codes = []
    for (const principal of refusals) {
      const mounted = await mount()
      const res = await callRoute(mounted, principal)
      assert.equal(res.statusCode, 403)
      codes.push(codeOf(res))
      assert.deepEqual(Object.keys(res.body).sort(), ['error', 'ok'])
      for (const key of Object.keys(res.body.error)) {
        assert.ok(['code', 'details', 'message'].includes(key), `an error carries code/message/details only, found ${key}`)
      }
      assert.deepEqual(plain(res.body.error.details) || {}, {}, 'no details')
      assertCarriesNoHandle(res, 'tenant refusal')
      assert.equal(JSON.stringify(res.body).includes('u_prober'), false)
      assert.equal(JSON.stringify(res.body).includes('u_admin'), false)
    }
    assert.deepEqual(codes, [
      'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED',
      'OPERATOR_SCOPE_TENANT_MISMATCH',
      'OPERATOR_SCOPE_TENANT_REQUIRED',
      'OPERATOR_SCOPE_TENANT_CONTRADICTED',
    ], 'the four tenant refusals were each exercised')

    // The missing-directory refusal carries ONE detail, a method name from a closed list.
    const absent = await mount({ withDirectory: false })
    const noDirectory = await callRoute(absent, { id: OWNER_OF_OWN, permissions: READ, header: TENANT_OWN })
    assert.equal(noDirectory.statusCode, 501)
    assert.deepEqual(plain(noDirectory.body.error.details), { requiredMethods: ['verifyTenantMembership'] })
    assertCarriesNoHandle(noDirectory, 'directory refusal')
  })

  // -------------------------------------------------------------------------
  // TS-10 — structure
  // -------------------------------------------------------------------------
  await run('TS-10 the handler proves the tenant before the lookup and reaches for no request-steerable resolver', async () => {
    // Comments are stripped first: an explanation of why a resolver is unsafe must not trip an
    // absence check, and must not satisfy a presence check either.
    const body = handlerBody(ROUTES_SRC, 'stockPreparationSourcePreflight')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    const proof = body.indexOf('await resolveProvenOwnTenant({')
    const door = body.indexOf('assertVerifiedTenantClaim(req, tenantId)')
    const lookup = body.indexOf('resolveTableActionExecution(')
    const load = body.indexOf('loadSystem(')
    assert.notEqual(proof, -1, 'the tenant is proven by the shared tenant proof')
    assert.notEqual(door, -1, 'the staged claim door is applied to the proven tenant')
    assert.notEqual(lookup, -1, 'the table action is looked up')
    assert.notEqual(load, -1, 'the system is loaded')
    assert.ok(proof < lookup, 'the tenant is proven BEFORE the lookup')
    assert.ok(proof < door && door < lookup, 'the claim door runs on the proven tenant, BEFORE the lookup')
    assert.ok(lookup < load, 'the lookup precedes the load')
    // The proof is handed the three inputs it is specified over — the verified claim, every tenant the
    // request carried, and the host directory — and nothing the request could substitute for them.
    const proofCall = body.slice(proof, body.indexOf('})', proof))
    assert.match(proofCall, /authenticatedTenantId: req\.authenticatedTenantId,/, 'the proof reads the verified claim')
    assert.match(proofCall, /explicitTenantIds: collectExplicitTenantIds\(req, input\),/, 'the proof sees every request-carried tenant')
    assert.match(proofCall, /\btenantPrincipalDirectory,/, 'the proof is handed the host directory')
    assert.equal((body.match(/resolveProvenOwnTenant\(/g) || []).length, 1, 'the tenant is proven exactly once')
    assert.equal(/resolveTenantId\(/.test(body), false, 'no request-steerable resolveTenantId in the handler')
    assert.equal(/user\.tenantId/.test(body), false, 'no direct read of the header-fillable user.tenantId')
    assert.equal(/resolveAuthUserTenantId\(/.test(body), false, 'nor through resolveAuthUserTenantId')
    assert.equal(/resolveTableActionExecution\(req, \{\s*actionId/.test(body), false, 'the lookup is never tenant-less again')
    assert.match(body, /resolveTableActionExecution\(req, \{\s*tenantId,/, 'the execution lookup carries the resolved tenant')
    // Every scoped input the handler builds names the resolved tenant explicitly, so the helper's own
    // resolver can only agree with it or refuse.
    const scoped = body.match(/scoped(?:Adapter)?Input\(req, \{[^}]*\}/g) || []
    assert.equal(scoped.length, 1, 'legacy selector is resolved once into the shared adapter scope')
    for (const call of scoped) {
      assert.match(call, /\btenantId\b/, `${call} must carry the resolved tenant`)
    }
    assert.match(body, /await loadSystem\(adapterScope\)/, 'source load uses the resolved shared scope')
    assert.match(body, /await peekTableActionSourceBinding\(adapterScope\)/, 'delegation peek uses that very same scope')
    assert.match(body, /\? \{ \.\.\.exactSourceScope, id: externalSystemId, principal: requestPrincipal\(req\), runAs: 'user' \}/,
      'online exact scope still uses the requester, never a borrowed principal')
  })

  // -------------------------------------------------------------------------
  // TS-11 — the staged claim door
  // -------------------------------------------------------------------------
  await run('TS-11 with the claim door armed a claimless member is refused before the lookup; disarmed it is served', async () => {
    const FLAG = 'MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED'
    const had = Object.prototype.hasOwnProperty.call(process.env, FLAG)
    const previous = process.env[FLAG]
    const CLAIMLESS_MEMBER_OWNER = { id: OWNER_OF_OWN, permissions: READ, header: TENANT_OWN }
    try {
      process.env[FLAG] = 'true'
      const armed = await mount()
      const refusedRes = await callRoute(armed, CLAIMLESS_MEMBER_OWNER)
      assert.equal(refusedRes.statusCode, 403, `armed, claimless: got ${refusedRes.statusCode} ${codeOf(refusedRes)}`)
      assert.equal(codeOf(refusedRes), 'OPERATOR_SCOPE_TENANT_REQUIRED')
      assertNoIo(armed, 'armed door, claimless member')
      assert.deepEqual(armed.calls.directory, [{ userId: OWNER_OF_OWN, tenantId: TENANT_OWN }], 'the proof ran first')
      assertCarriesNoHandle(refusedRes, 'armed door refusal')

      const armedClaim = await mount()
      const served = await callRoute(armedClaim, OWNER)
      assert.equal(served.statusCode, 200, `armed, claim-bearing owner: got ${served.statusCode} ${codeOf(served)}`)
      assert.deepEqual(served.body.data.checks.projectData.livenessSamples, [...PROJECTS_OF[TENANT_OWN]])

      delete process.env[FLAG]
      const disarmed = await mount()
      const open = await callRoute(disarmed, CLAIMLESS_MEMBER_OWNER)
      assert.equal(open.statusCode, 200, `disarmed, claimless member: got ${open.statusCode} ${codeOf(open)}`)
      assert.deepEqual(disarmed.calls.bindingGets.map((call) => call.tenantId), [TENANT_OWN])
    } finally {
      if (had) process.env[FLAG] = previous
      else delete process.env[FLAG]
    }
  })

  console.log(`\nstock-preparation-source-preflight-tenant-scope: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error('stock-preparation-source-preflight-tenant-scope FAILED')
    process.exitCode = 1
    return
  }
  console.log('stock-preparation-source-preflight-tenant-scope OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
