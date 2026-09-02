'use strict'

// 一线自己拉数据 — THE OPERATOR PULL GATE SPLIT, and the four things it must not widen.
//
// THE RULING. The owner ruled that a floor operator may self-serve the PLM pull: without it the
// 项目备料页 opens on a project whose BOM nobody on the floor can bring in, and "ask a platform
// administrator" is not an answer at 07:00 on a shop floor. What the ruling did NOT move is the
// pair of routes R-11(b) names as owner-level:
//
//   dry-run     was integration:read   -> ALSO stock-prep operate ∧ read, for ONE action id
//   apply       was integration:write  -> ALSO stock-prep operate ∧ read, for ONE action id
//   reconcile   requireAccess(req, 'admin')  UNCHANGED — a SOURCE READ that consumes a B2a claim
//   mvp-persist requireAccess(req, 'admin')  UNCHANGED
//
// WHAT THIS SUITE EXISTS TO CATCH. A gate split is the easiest change in this repository to get
// silently wrong, because the two routes it touches are GENERIC — `/table-actions/:actionId/...`
// serves every table action there is. So the assertions below are not "the operator can pull"; they
// are:
//
//   P-01 the operator reaches dry-run and apply, for the pull-bom action id.
//   P-02 the operator is REFUSED reconcile and mvp-persist. The two that stayed, stayed.
//   P-03 the split is SCOPED TO ONE ACTION ID. The same operator, on any other actionId, is refused
//        exactly as before — the widening is not a wildcard over the table-action namespace.
//   P-04 NOBODY ELSE GAINS ANYTHING. The legacy tiers admit exactly whom they admitted; a caller
//        holding neither the legacy tier nor the operator tier is still refused; and an orphan
//        `stock-prep:operate` without `stock-prep:read` confers nothing, because the operator tier
//        is a CONJUNCTION.
//   P-05 the decision is a pure function of (permissions, actionId) and is exported, so the web
//        mirror can be asserted byte-equal against it rather than re-deriving the rule.
//   P-06 THE OPERATOR BRANCH VERIFIES ITS TENANT. These routes resolve their tenant with
//        `resolveTenantId`, which accepts `user.tenantId` — a field the host's auth middleware fills
//        from the `x-tenant-id` REQUEST HEADER when the token carries no tenant claim. For the
//        legacy `integration:*` tiers that is pre-existing; for the operator tier it would be a NEW
//        cross-tenant capability on a route that reads the customer's PLM through a per-tenant source
//        binding. So an operator admitted through the split also passes `resolveOperatorValueScope`
//        (verified claim preferred, contradicting header refused, tenantless refused, steering
//        refused, HOST vouches for the pairing) — and the legacy branch returns before any of it, so
//        no existing caller changes shape.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_OPERATOR_PULL_ACTION_ID,
  STOCK_PREP_OPERATOR_PULL_STEPS,
  STOCK_PREP_PLATFORM_ADMIN_PULL_STEPS,
  STOCK_PREP_READ,
  operatorMayRunStockPrepPull,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const {
  normalizeStockPreparationActionConfig,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

const TENANT = 'tenant-a'
const OTHER_ACTION_ID = 'k3.material.pull.v1'

const ANONYMOUS = undefined
const LOGGED_IN = Object.freeze({ id: 'u_plain', tenantId: TENANT, permissions: [] })
const INTEGRATION_READER = Object.freeze({ id: 'u_int_r', tenantId: TENANT, permissions: ['integration:read'] })
const INTEGRATION_WRITER = Object.freeze({ id: 'u_int_w', tenantId: TENANT, permissions: ['integration:write'] })
const OPERATOR_READ = Object.freeze({ id: 'u_op_r', tenantId: TENANT, permissions: [STOCK_PREP_READ] })
const OPERATOR = Object.freeze({ id: 'u_op', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const OPERATOR_ORPHAN = Object.freeze({ id: 'u_op_o', tenantId: TENANT, permissions: [STOCK_PREP_OPERATE] })
const WORKBENCH_ADMIN = Object.freeze({ id: 'u_wb', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const PLATFORM_ADMIN = Object.freeze({ id: 'u_adm', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })

function permissionsOf(user) {
  if (!user) return []
  const permissions = [...(user.permissions || [])]
  for (const role of user.roles || []) permissions.push(`role:${role}`)
  return permissions
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

/**
 * THE HARNESS IS DELIBERATELY INERT BELOW THE GATE, and that is what makes it a gate test.
 *
 * No table action is configured (`context.config` carries none), so the registry answers 422
 * TABLE_ACTION_NOT_CONFIGURED to anything that reaches it, and the multitable surfaces throw. So:
 *   * a caller the gate ADMITS fails with one of those, never with a gate code -> 'admitted';
 *   * a caller the gate REFUSES fails with a gate code and never reaches the action lookup at all
 *     -> 'refused'.
 * The classification therefore measures the gate and nothing but the gate, on the real route table.
 */
const PAST_THE_GATE = 'PAST_THE_GATE'

function mount({ tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } } } = {}) {
  const routes = new Map()
  // EVERY host touch, counted. A refusal that is a real gate refusal costs ZERO of these: the gate is
  // the first thing each of these handlers does, so a refused caller must not reach a sheet, a record
  // or an external system. Counting is what turns "it 403'd" into "it 403'd before doing anything".
  let hostCalls = 0
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: {
          async findObjectSheet() { hostCalls += 1; throw new Error(PAST_THE_GATE) },
          async resolveFieldIds() { hostCalls += 1; throw new Error(PAST_THE_GATE) },
        },
        records: {
          async queryRecords() { hostCalls += 1; throw new Error(PAST_THE_GATE) },
        },
      },
    },
    storage: new Map(),
    config: {},
  }
  const services = {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
    adapterRegistry: inertService(['createAdapter', 'listAdapterKinds']),
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForApply']),
    stockPreparationAuditStore: { async append() { return { ok: true } } },
    ...(tenantPrincipalDirectory ? { tenantPrincipalDirectory } : {}),
    stockPreparationConfirmationReconcileLease: {
      async acquire() { return { leaseId: 'lease_1' } },
      async release() { return true },
      async renew() { return true },
    },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  routes.hostCallCount = () => hostCalls
  routes.resetHostCalls = () => { hostCalls = 0 }
  return routes
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

/**
 * Call one table-action route and classify the outcome as seen from the GATE:
 *   'refused'   — 401/403 with the gate's own error code, and no action lookup happened
 *   'admitted'  — execution reached past the gate (the sentinel, or any non-gate failure)
 */
const GATE_REFUSAL_CODES = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  // The operator branch's own refusals — every one of them is a gate refusal, decided before the
  // route touches an action, a source or a sheet.
  'TENANT_MISMATCH',
  'TENANT_CONTEXT_REQUIRED',
  'OPERATOR_SCOPE_UNAUTHENTICATED',
  'OPERATOR_SCOPE_TIER_REQUIRED',
  'OPERATOR_SCOPE_TENANT_CONTRADICTED',
  'OPERATOR_SCOPE_TENANT_REQUIRED',
  'OPERATOR_SCOPE_TENANT_MISMATCH',
  'OPERATOR_SCOPE_PRINCIPAL_UNKNOWN',
  'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED',
])

// The large-BOM routes carry job handles in the path. They are supplied for every call because a
// route that reads them AFTER its gate must behave identically whether they are present or not — the
// gate is the first statement, and nothing below it runs for a refused caller.
const JOB_PARAMS = Object.freeze({ jobId: 'job_1', applyJobId: 'applyjob_1' })

async function gateVerdict(routes, { method, routePath, user, actionId, body = {}, query = {}, authenticatedTenantId } = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  const req = { user, body, query, params: { ...JOB_PARAMS, actionId } }
  if (authenticatedTenantId !== undefined) req.authenticatedTenantId = authenticatedTenantId
  try {
    await handler(req, res)
  } catch (error) {
    // Anything thrown that is NOT a gate refusal means we got past the gate.
    if (error && (error.status === 401 || error.status === 403) && GATE_REFUSAL_CODES.has(error.code)) {
      return 'refused'
    }
    return 'admitted'
  }
  const code = res.body && res.body.error && res.body.error.code
  if ((res.statusCode === 401 || res.statusCode === 403) && GATE_REFUSAL_CODES.has(code)) {
    return 'refused'
  }
  return 'admitted'
}

/** Call a route and return the RESPONSE — for assertions past the gate. */
async function rawCall(routes, { method, routePath, user, actionId, jobId, body = {}, query = {} }) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  const req = { user, body, query, params: { ...JOB_PARAMS, actionId, ...(jobId ? { jobId } : {}) } }
  try {
    await handler(req, res)
  } catch (error) {
    res.statusCode = error && error.status ? error.status : 500
    res.body = { ok: false, error: { code: error && error.code ? error.code : 'THREW' } }
  }
  return res
}

/** The exact refusal code, for the assertions that care WHICH refusal happened. */
async function refusalCode(routes, input) {
  const handler = routes.get(`${input.method.toUpperCase()} ${input.routePath}`)
  assert.ok(handler, 'route is registered')
  const res = createResponse()
  const req = { user: input.user, body: input.body || {}, query: input.query || {}, params: { ...JOB_PARAMS, actionId: input.actionId } }
  if (input.authenticatedTenantId !== undefined) req.authenticatedTenantId = input.authenticatedTenantId
  try {
    await handler(req, res)
  } catch (error) {
    return error && error.code ? String(error.code) : 'THREW'
  }
  return res.body && res.body.error && res.body.error.code ? String(res.body.error.code) : `OK_${res.statusCode}`
}

// ---------------------------------------------------------------------------
// A HARNESS THAT GOES PAST THE GATE — because P-01..P-07 deliberately do not
// ---------------------------------------------------------------------------
//
// Every case above measures the GATE and stops there: the mount has no configured action and an
// inert adapter registry, so "admitted" means "reached the action lookup". That was the right shape
// for a gate test and it is exactly why it could not see P-08's bug — the split moved the HTTP gate
// and nothing else, so an admitted operator went on to fail in the DATA plane, every time, on the
// default source kind. This second harness configures the action and records the principal the
// source read is actually performed as.
const DATA_SOURCE_OWNER = 'u_source_owner'
const SOURCE_SYSTEM_ID = 'ext_plm_sql'

function mountWithSource({
  sourceKind = 'data-source:sql-readonly',
  dataSourceOwnerId = DATA_SOURCE_OWNER,
  actionId = STOCK_PREP_OPERATOR_PULL_ACTION_ID,
} = {}) {
  const routes = new Map()
  const adapterPrincipals = []
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: {
          async findObjectSheet() { return null },
          async resolveFieldIds() { return {} },
        },
        records: { async queryRecords() { return [] } },
      },
    },
    // The large-BOM channel refuses a non-durable store outright (it drives a job across requests),
    // so this harness supplies the same durable key/value shape the plugin's own storage exposes.
    storage: Object.assign(new Map(), {
      durable: true,
      async get(key) { return Map.prototype.get.call(this, key) ?? null },
      async set(key, value) { Map.prototype.set.call(this, key, value); return value },
      async delete(key) { return Map.prototype.delete.call(this, key) },
    }),
    config: {
      stockPreparationTableActions: [{
        actionId,
        source: { kind: sourceKind, externalSystemId: SOURCE_SYSTEM_ID },
        target: { sheetId: 'sheet_main', objectId: 'plm_stock_preparation_main', fieldIdMap: {} },
      }],
    },
  }
  const services = {
    externalSystemRegistry: {
      async getExternalSystem() {
        return {
          id: SOURCE_SYSTEM_ID,
          kind: sourceKind,
          status: 'active',
          // The SERVER-STAMPED binding owner. external-systems.cjs writes this on every upsert that
          // asserts a dataSourceId binding, discarding whatever the client sent, so it is the one
          // trustworthy answer to "who may read through this connection".
          config: {
            dataSourceId: 'ds_1',
            ...(dataSourceOwnerId ? { dataSourceOwnerId } : {}),
          },
        }
      },
      async upsertExternalSystem() { throw new Error('unexpected') },
      async deleteExternalSystem() { throw new Error('unexpected') },
      async listExternalSystems() { return { items: [] } },
    },
    // RECORDS the principal each adapter is built for, then refuses the read — this suite is about
    // WHOSE identity the read runs as, not about what the source returns.
    adapterRegistry: {
      async createAdapter(system, deps = {}) {
        adapterPrincipals.push(deps.principal ?? null)
        return {
          kind: system.kind,
          async readObjects() { throw new Error('source read not exercised here') },
        }
      },
      async listAdapterKinds() { return [] },
    },
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForApply']),
    stockPreparationAuditStore: { async append() { return { ok: true } } },
    tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, adapterPrincipals }
}

// ---------------------------------------------------------------------------
// P-09 — THE PULL'S DATA-PLANE IDENTITY
// ---------------------------------------------------------------------------
//
// THE BUG. The split moved the HTTP gate; the source read still ran as the REQUEST principal. On the
// DEFAULT source kind (`data-source:sql-readonly`) the host facade authorizes by STRICT OWNER
// EQUALITY with no admin bypass — `DataSourceManager.assertAccess` throws unless `ownerId === userId`
// — and a floor operator is never the person who bound the connection. So every operator pull
// returned `status:"failed"`, `canApply:false`, `dryRunToken:null`: the tier was admitted to the
// route and refused the data, silently, for every operator except the single user who owns the row.
//
// THE FIX, and its exact scope: for the ONE frozen action id, the source read is performed as the
// SERVER-HELD BINDING OWNER (`config.dataSourceOwnerId`, stamped server-side by the external-system
// registry and never client-settable). It is a delegation, so it is auditable as one — the audit row
// carries the operator as `actor` and the owner as the read `principal`. No other action id gets it.
// ---------------------------------------------------------------------------
// P-10 — A STORED JOB IS RUN BY ITS OWN CREATOR, NOT BY WHOEVER FINDS IT
// ---------------------------------------------------------------------------
//
// `POST …/large-bom/expansion-jobs/:jobId/run` drives a job off a STORED artifact, and every scope
// it uses comes from that artifact — including, before this fix, the `principal:` it performed the
// customer-source read under. That was harmless while only `integration:*` holders could reach the
// route; the operator split made it a way for a newly-admitted tier to drive a source read under
// SOMEBODY ELSE'S identity, simply by naming a job id they did not create.
//
// The job now records two separate facts — the ACTOR who created it and the PRINCIPAL its reads run
// as (the binding owner, per P-09) — and the run route refuses a caller who is not the actor, before
// the B2a registration and before the adapter is loaded, so a refusal costs no claim and no
// credential lookup.
async function aStoredLargeBomJobIsRunOnlyByItsCreator() {
  const pull = STOCK_PREP_OPERATOR_PULL_ACTION_ID
  const RUN = {
    method: 'POST',
    routePath: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/run',
  }

  const { routes } = mountWithSource()
  // The operator starts a job of their own.
  const started = await rawCall(routes, {
    method: 'POST',
    routePath: '/api/integration/table-actions/:actionId/large-bom/expansion-jobs',
    user: OPERATOR,
    actionId: pull,
    body: { parameters: { projectNo: '230920006' } },
  })
  assert.equal(started.statusCode, 202, `P-10: the operator starts their own job (got ${JSON.stringify(started.body)})`)
  const jobId = started.body && started.body.data && started.body.data.jobId
  assert.ok(jobId, 'P-10: the job has an id')

  // ANOTHER operator of the same tenant and tier names that job id.
  const intruder = Object.freeze({ id: 'u_op_other', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
  const stolen = await rawCall(routes, { ...RUN, user: intruder, actionId: pull, jobId })
  assert.equal(stolen.statusCode, 403, `P-10: a job's run belongs to its creator (got ${stolen.statusCode})`)
  assert.equal(
    stolen.body && stolen.body.error && stolen.body.error.code,
    'LARGE_BOM_JOB_ACTOR_MISMATCH',
    'P-10: and it says so with its own code',
  )

  // The creator themselves is not refused by this guard (it fails later, in the inert source read).
  const own = await rawCall(routes, { ...RUN, user: OPERATOR, actionId: pull, jobId })
  assert.notEqual(
    own.body && own.body.error && own.body.error.code,
    'LARGE_BOM_JOB_ACTOR_MISMATCH',
    'P-10: the creator is never refused by the actor guard',
  )
}

async function theOperatorPullReadsAsTheBindingOwner() {
  const pull = STOCK_PREP_OPERATOR_PULL_ACTION_ID

  // 1. THE OPERATOR'S dry-run reads as the BINDING OWNER, not as themselves.
  {
    const { routes, adapterPrincipals } = mountWithSource()
    await gateVerdict(routes, { ...DRY_RUN, user: OPERATOR, actionId: pull })
    assert.deepEqual(
      adapterPrincipals,
      [DATA_SOURCE_OWNER],
      'P-09: an operator admitted by the split must read through the connection as its server-held '
      + 'owner — reading as themselves is a guaranteed refusal on the default source kind',
    )
  }

  // 2. …and so does APPLY, which re-expands the source in its own right.
  {
    const { routes, adapterPrincipals } = mountWithSource()
    await gateVerdict(routes, { ...APPLY, user: OPERATOR, actionId: pull })
    assert.deepEqual(adapterPrincipals, [DATA_SOURCE_OWNER], 'P-09: apply too')
  }

  // 3. THE DELEGATION IS SCOPED TO THE FROZEN ACTION ID, compared for EQUALITY. Two layers say so
  //    and both are asserted: this registry accepts no other actionId in its config at all
  //    (TABLE_ACTION_CONFIG_INVALID on anything else), and a request that NAMES another id never
  //    resolves an action, so no adapter is ever built for it. The equality check inside
  //    resolveTableActionReadPrincipal is the defence-in-depth layer under those two.
  {
    const { routes, adapterPrincipals } = mountWithSource()
    await gateVerdict(routes, { ...DRY_RUN, user: INTEGRATION_READER, actionId: OTHER_ACTION_ID })
    assert.deepEqual(
      adapterPrincipals,
      [],
      'P-09: a request naming another action id builds no adapter at all, so no identity is delegated',
    )
    assert.throws(
      () => normalizeStockPreparationActionConfig({ actionId: OTHER_ACTION_ID }),
      (error) => error && error.code === 'TABLE_ACTION_CONFIG_INVALID',
      'P-09: and no other action id can even be configured into this registry',
    )
  }

  // 4. THE LEGACY TIER ON THE PULL ACTION IS ALSO UNCHANGED in the one case that matters: an
  //    integration admin who IS the owner reads as themselves either way, and one who is NOT was
  //    already refused by the facade — the delegation only ever removes a guaranteed failure.
  {
    const { routes, adapterPrincipals } = mountWithSource({ dataSourceOwnerId: PLATFORM_ADMIN.id })
    await gateVerdict(routes, { ...DRY_RUN, user: PLATFORM_ADMIN, actionId: pull })
    assert.deepEqual(adapterPrincipals, [PLATFORM_ADMIN.id], 'P-09: the owner still reads as themselves')
  }

  // 5. NO OWNER STAMPED (a self-contained kind, or a binding predating the stamp) -> the request
  //    principal, i.e. exactly today's behaviour. The delegation never invents an identity.
  {
    const { routes, adapterPrincipals } = mountWithSource({ dataSourceOwnerId: null })
    await gateVerdict(routes, { ...DRY_RUN, user: OPERATOR, actionId: pull })
    assert.deepEqual(
      adapterPrincipals,
      [OPERATOR.id],
      'P-09: with no server-held owner there is nothing to delegate to, so nothing changes',
    )
  }
}

const DRY_RUN = { method: 'POST', routePath: '/api/integration/table-actions/:actionId/dry-run' }
const APPLY = { method: 'POST', routePath: '/api/integration/table-actions/:actionId/apply' }
const RECONCILE = { method: 'POST', routePath: '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile' }
const MVP_PERSIST = { method: 'POST', routePath: '/api/integration/table-actions/:actionId/mvp-persist' }

/**
 * THE BOUNDED BACKGROUND CHANNEL — the eight routes the 项目备料 panel switches to on its own the
 * moment a BOM is too large to expand inline. Read out of the shared manifest rather than retyped,
 * so a route that joins the split without joining this suite is impossible.
 */
const LARGE_BOM_ROUTES = STOCK_PREP_OPERATOR_PULL_STEPS
  .filter((step) => step.step.startsWith('large-bom-'))
  .map((step) => ({ method: step.method, routePath: step.path, step: step.step }))

/** Every moved step, small and large, as callable route descriptors. */
const ALL_MOVED_ROUTES = STOCK_PREP_OPERATOR_PULL_STEPS
  .map((step) => ({ method: step.method, routePath: step.path, step: step.step }))

// ---------------------------------------------------------------------------
// P-01 / P-02 — what moved, and what did not
// ---------------------------------------------------------------------------

async function theOperatorPullsButNeitherReconcilesNorArchives() {
  const routes = mount()
  const pull = STOCK_PREP_OPERATOR_PULL_ACTION_ID

  assert.equal(
    await gateVerdict(routes, { ...DRY_RUN, user: OPERATOR, actionId: pull }),
    'admitted',
    'P-01: the operator may DRY-RUN the stock-prep pull',
  )
  assert.equal(
    await gateVerdict(routes, { ...APPLY, user: OPERATOR, actionId: pull }),
    'admitted',
    'P-01: the operator may APPLY the stock-prep pull',
  )
  assert.equal(
    await gateVerdict(routes, { ...RECONCILE, user: OPERATOR, actionId: pull }),
    'refused',
    'P-02: reconcile stayed platform-admin — a source read is an owner-level act',
  )
  assert.equal(
    await gateVerdict(routes, { ...MVP_PERSIST, user: OPERATOR, actionId: pull }),
    'refused',
    'P-02: mvp-persist stayed platform-admin',
  )
}

// ---------------------------------------------------------------------------
// P-03 — the split is scoped to ONE action id
// ---------------------------------------------------------------------------

async function theWideningIsNotAWildcardOverTheTableActionNamespace() {
  const routes = mount()
  for (const route of [DRY_RUN, APPLY]) {
    assert.equal(
      await gateVerdict(routes, { ...route, user: OPERATOR, actionId: OTHER_ACTION_ID }),
      'refused',
      `P-03: the operator is refused ${route.routePath} for a table action that is not the stock-prep pull`,
    )
  }
  assert.equal(operatorMayRunStockPrepPull([STOCK_PREP_READ, STOCK_PREP_OPERATE], OTHER_ACTION_ID), false)
  assert.equal(operatorMayRunStockPrepPull([STOCK_PREP_READ, STOCK_PREP_OPERATE], ''), false)
  assert.equal(operatorMayRunStockPrepPull([STOCK_PREP_READ, STOCK_PREP_OPERATE], null), false)
  assert.equal(operatorMayRunStockPrepPull([STOCK_PREP_READ, STOCK_PREP_OPERATE], `${STOCK_PREP_OPERATOR_PULL_ACTION_ID}.evil`), false)
}

// ---------------------------------------------------------------------------
// P-04 — nobody else gains, nobody else loses
// ---------------------------------------------------------------------------

async function theLegacyTiersAreExactlyWhatTheyWere() {
  const routes = mount()
  const pull = STOCK_PREP_OPERATOR_PULL_ACTION_ID

  // Unchanged admissions: integration:read still dry-runs, integration:write still dry-runs AND
  // applies, the platform admin still does everything.
  assert.equal(await gateVerdict(routes, { ...DRY_RUN, user: INTEGRATION_READER, actionId: pull }), 'admitted')
  assert.equal(await gateVerdict(routes, { ...DRY_RUN, user: INTEGRATION_WRITER, actionId: pull }), 'admitted')
  assert.equal(await gateVerdict(routes, { ...APPLY, user: INTEGRATION_WRITER, actionId: pull }), 'admitted')
  assert.equal(await gateVerdict(routes, { ...RECONCILE, user: PLATFORM_ADMIN, actionId: pull }), 'admitted')

  // Unchanged refusals: integration:read still cannot APPLY.
  assert.equal(
    await gateVerdict(routes, { ...APPLY, user: INTEGRATION_READER, actionId: pull }),
    'refused',
    'P-04: integration:read did not gain the write half',
  )

  // The tiers that hold nothing relevant are still refused everywhere.
  for (const user of [ANONYMOUS, LOGGED_IN, OPERATOR_READ, OPERATOR_ORPHAN]) {
    for (const route of [DRY_RUN, APPLY, RECONCILE, MVP_PERSIST]) {
      assert.equal(
        await gateVerdict(routes, { ...route, user, actionId: pull }),
        'refused',
        `P-04: ${user ? user.id : 'anonymous'} must be refused ${route.routePath}`,
      )
    }
  }

  // stock-prep:admin satisfies operate through the ladder, so it pulls — and still not reconcile.
  assert.equal(await gateVerdict(routes, { ...DRY_RUN, user: WORKBENCH_ADMIN, actionId: pull }), 'admitted')
  assert.equal(await gateVerdict(routes, { ...APPLY, user: WORKBENCH_ADMIN, actionId: pull }), 'admitted')
  assert.equal(await gateVerdict(routes, { ...RECONCILE, user: WORKBENCH_ADMIN, actionId: pull }), 'refused')
}

// ---------------------------------------------------------------------------
// P-05 — the rule is one exported pure function, and the manifest names both halves
// ---------------------------------------------------------------------------

function theRuleIsDeclaredOnceAndTheSplitIsNamed() {
  assert.equal(STOCK_PREP_OPERATOR_PULL_ACTION_ID, 'plm.stock-preparation.pull-bom.v1')

  assert.deepEqual(
    STOCK_PREP_OPERATOR_PULL_STEPS.map((step) => step.step),
    [
      'dry-run',
      'apply',
      // The bounded background channel — the same pull, taken in pieces because the BOM is too big
      // to expand in one request. See P-07.
      'large-bom-expansion-start',
      'large-bom-expansion-get',
      'large-bom-expansion-run',
      'large-bom-expansion-plan',
      'large-bom-apply-start',
      'large-bom-apply-get',
      'large-bom-apply-run',
      'large-bom-expansion-cancel',
    ],
    'P-05: exactly these steps moved to the operator tier',
  )
  assert.deepEqual(
    STOCK_PREP_PLATFORM_ADMIN_PULL_STEPS.map((step) => step.step),
    ['reconcile', 'mvp-persist'],
    'P-05: exactly two steps stayed platform-admin',
  )
  for (const step of STOCK_PREP_OPERATOR_PULL_STEPS) {
    assert.ok(['GET', 'POST'].includes(step.method), `P-05: ${step.step} names a real method`)
    assert.ok(step.path.startsWith('/api/integration/table-actions/:actionId/'))
    assert.ok(['read', 'write'].includes(step.legacyGate), 'P-05: each moved step names the legacy gate it keeps')
  }

  // The CONJUNCTION, restated at this boundary: operate alone confers nothing here either.
  assert.equal(operatorMayRunStockPrepPull([STOCK_PREP_OPERATE], STOCK_PREP_OPERATOR_PULL_ACTION_ID), false)
  assert.equal(operatorMayRunStockPrepPull([STOCK_PREP_READ], STOCK_PREP_OPERATOR_PULL_ACTION_ID), false)
  assert.equal(operatorMayRunStockPrepPull([STOCK_PREP_READ, STOCK_PREP_OPERATE], STOCK_PREP_OPERATOR_PULL_ACTION_ID), true)
  assert.equal(operatorMayRunStockPrepPull([STOCK_PREP_ADMIN], STOCK_PREP_OPERATOR_PULL_ACTION_ID), true)
  assert.equal(operatorMayRunStockPrepPull(permissionsOf(PLATFORM_ADMIN), STOCK_PREP_OPERATOR_PULL_ACTION_ID), true)
  assert.equal(operatorMayRunStockPrepPull([], STOCK_PREP_OPERATOR_PULL_ACTION_ID), false)
  assert.equal(operatorMayRunStockPrepPull(null, STOCK_PREP_OPERATOR_PULL_ACTION_ID), false)
}

// ---------------------------------------------------------------------------
// P-06 — the operator branch verifies its tenant; the legacy branch is untouched
// ---------------------------------------------------------------------------

const TENANT_B = 'tenant-b'

async function theOperatorBranchCannotBeSteeredAcrossTenants() {
  const pull = STOCK_PREP_OPERATOR_PULL_ACTION_ID

  // A request that CARRIES another tenant is refused outright, never resolved toward it.
  {
    const routes = mount()
    for (const route of [DRY_RUN, APPLY]) {
      const code = await refusalCode(routes, { ...route, user: OPERATOR, actionId: pull, query: { tenantId: TENANT_B } })
      assert.equal(code, 'OPERATOR_SCOPE_TENANT_MISMATCH', `P-06: ${route.routePath} refuses a steered tenant`)
    }
  }

  // A carried tenant that CONTRADICTS the verified token claim is refused rather than resolved —
  // the header-against-header case that makes `resolveTenantId` alone insufficient here.
  {
    const routes = mount()
    for (const route of [DRY_RUN, APPLY]) {
      const code = await refusalCode(routes, { ...route, user: OPERATOR, actionId: pull, authenticatedTenantId: TENANT_B })
      assert.equal(code, 'OPERATOR_SCOPE_TENANT_CONTRADICTED', `P-06: ${route.routePath} refuses a contradicted tenant`)
    }
  }

  // The HOST says this principal is not a member of the tenant it claims -> refused. On a
  // tenant-claimless deployment this is the check that makes a spoofed x-tenant-id header useless.
  {
    const routes = mount({ tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: false } } } })
    for (const route of [DRY_RUN, APPLY]) {
      const code = await refusalCode(routes, { ...route, user: OPERATOR, actionId: pull })
      assert.equal(code, 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED', `P-06: ${route.routePath} refuses a non-member`)
    }
  }

  // No membership seam at all -> fail CLOSED (501), never proceed on the request's own say-so.
  {
    const routes = mount({ tenantPrincipalDirectory: null })
    for (const route of [DRY_RUN, APPLY]) {
      const code = await refusalCode(routes, { ...route, user: OPERATOR, actionId: pull })
      assert.equal(code, 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE', `P-06: ${route.routePath} fails closed without the seam`)
    }
  }

  // A principal with NO tenant of its own holding only the operator tier is refused — the operator
  // branch has no notion of a tenantless caller to serve.
  {
    const routes = mount()
    const tenantless = { id: 'u_op_tenantless', permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }
    for (const route of [DRY_RUN, APPLY]) {
      const code = await refusalCode(routes, { ...route, user: tenantless, actionId: pull })
      assert.equal(code, 'OPERATOR_SCOPE_TENANT_REQUIRED', `P-06: ${route.routePath} refuses a tenantless operator`)
    }
  }

  // THE LEGACY BRANCH IS UNTOUCHED: it returns before any of the above, so an integration:* caller
  // never reaches the scope — proven by the seam being ABSENT and them still getting through.
  {
    const routes = mount({ tenantPrincipalDirectory: null })
    assert.equal(
      await gateVerdict(routes, { ...DRY_RUN, user: INTEGRATION_READER, actionId: pull }),
      'admitted',
      'P-06: the legacy tier does not pay for the operator branch',
    )
    assert.equal(
      await gateVerdict(routes, { ...APPLY, user: INTEGRATION_WRITER, actionId: pull }),
      'admitted',
      'P-06: nor does the legacy write tier',
    )
    assert.equal(
      await gateVerdict(routes, { ...DRY_RUN, user: PLATFORM_ADMIN, actionId: pull }),
      'admitted',
      'P-06: nor does the platform admin',
    )
  }
}

// ---------------------------------------------------------------------------
// P-07 — THE BOUNDED BACKGROUND CHANNEL IS THE SAME PULL, SO IT TAKES THE SAME RULE
// ---------------------------------------------------------------------------
//
// THE BUG THIS PINS. The split originally moved dry-run and apply only. But the moment a BOM is too
// large to expand inline, the 项目备料 panel switches to the eight large-BOM routes BY ITSELF — and
// every one of them 403'd for the operator tier, underneath copy that promised
// 「不用重新点同步,也不用联系我们」. The operator was admitted to the easy pull and refused the hard
// one, which is the wrong way round: the projects that need the background channel are the big ones.
//
// Everything the small routes are asserted for is asserted here, route by route, from the manifest.
async function theOperatorReachesTheBoundedBackgroundChannel() {
  const pull = STOCK_PREP_OPERATOR_PULL_ACTION_ID
  assert.equal(LARGE_BOM_ROUTES.length, 8, 'P-07: all eight background-channel routes are in the split')

  // 1. ADMITTED for the pull-bom action id.
  {
    const routes = mount()
    for (const route of LARGE_BOM_ROUTES) {
      assert.equal(
        await gateVerdict(routes, { ...route, user: OPERATOR, actionId: pull }),
        'admitted',
        `P-07: the operator may run ${route.step}`,
      )
    }
  }

  // 2. SCOPED TO ONE ACTION ID. The same operator, on any other table action, is refused exactly as
  //    before — the widening is not a wildcard over the table-action namespace, on these routes any
  //    more than on the small ones. AND IT COSTS NO IO.
  {
    const routes = mount()
    for (const route of LARGE_BOM_ROUTES) {
      routes.resetHostCalls()
      assert.equal(
        await gateVerdict(routes, { ...route, user: OPERATOR, actionId: OTHER_ACTION_ID }),
        'refused',
        `P-07: ${route.step} is refused for a table action that is not the stock-prep pull`,
      )
      assert.equal(routes.hostCallCount(), 0, `P-07: ${route.step} refuses a foreign action id with zero IO`)
    }
  }

  // 3. NOBODY ELSE GAINS. The tiers that hold neither the legacy gate nor the operator conjunction
  //    are still refused everywhere, and still for free.
  {
    const routes = mount()
    for (const user of [ANONYMOUS, LOGGED_IN, OPERATOR_READ, OPERATOR_ORPHAN]) {
      for (const route of LARGE_BOM_ROUTES) {
        routes.resetHostCalls()
        assert.equal(
          await gateVerdict(routes, { ...route, user, actionId: pull }),
          'refused',
          `P-07: ${user ? user.id : 'anonymous'} must be refused ${route.step}`,
        )
        assert.equal(routes.hostCallCount(), 0, `P-07: and reaches no host API doing it`)
      }
    }
  }

  // 4. THE LEGACY TIERS ARE UNCHANGED on these routes too. integration:read still reaches the read
  //    half and still cannot reach the write half.
  {
    const routes = mount()
    for (const route of LARGE_BOM_ROUTES) {
      const step = STOCK_PREP_OPERATOR_PULL_STEPS.find((entry) => entry.step === route.step)
      const legacyUser = step.legacyGate === 'write' ? INTEGRATION_WRITER : INTEGRATION_READER
      assert.equal(
        await gateVerdict(routes, { ...route, user: legacyUser, actionId: pull }),
        'admitted',
        `P-07: the legacy ${step.legacyGate} tier still reaches ${route.step}`,
      )
      if (step.legacyGate === 'write') {
        assert.equal(
          await gateVerdict(routes, { ...route, user: INTEGRATION_READER, actionId: pull }),
          'refused',
          `P-07: integration:read did not gain ${route.step}`,
        )
      }
    }
  }

  // 5. THE TENANT IS VERIFIED, exactly as on the small routes — the whole reason the operator branch
  //    cannot lean on `resolveTenantId`, whose `user.tenantId` is filled from the x-tenant-id REQUEST
  //    HEADER on a tenant-claimless deployment. Every refusal below happens with zero IO.
  {
    const routes = mount()
    for (const route of LARGE_BOM_ROUTES) {
      routes.resetHostCalls()
      assert.equal(
        await refusalCode(routes, { ...route, user: OPERATOR, actionId: pull, query: { tenantId: TENANT_B } }),
        'OPERATOR_SCOPE_TENANT_MISMATCH',
        `P-07: ${route.step} refuses a steered tenant`,
      )
      assert.equal(routes.hostCallCount(), 0, `P-07: ${route.step} refuses a steered tenant with zero IO`)

      routes.resetHostCalls()
      assert.equal(
        await refusalCode(routes, { ...route, user: OPERATOR, actionId: pull, authenticatedTenantId: TENANT_B }),
        'OPERATOR_SCOPE_TENANT_CONTRADICTED',
        `P-07: ${route.step} refuses a header contradicting the verified claim`,
      )
      assert.equal(routes.hostCallCount(), 0, `P-07: ${route.step} refuses a contradicted tenant with zero IO`)

      routes.resetHostCalls()
      const tenantless = { id: 'u_op_tenantless', permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }
      assert.equal(
        await refusalCode(routes, { ...route, user: tenantless, actionId: pull }),
        'OPERATOR_SCOPE_TENANT_REQUIRED',
        `P-07: ${route.step} refuses a tenantless operator`,
      )
      assert.equal(routes.hostCallCount(), 0, `P-07: ${route.step} refuses a tenantless operator with zero IO`)
    }
  }

  // The host cannot vouch -> fail CLOSED on every one of them.
  {
    const routes = mount({ tenantPrincipalDirectory: null })
    for (const route of LARGE_BOM_ROUTES) {
      assert.equal(
        await refusalCode(routes, { ...route, user: OPERATOR, actionId: pull }),
        'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE',
        `P-07: ${route.step} fails closed without the membership seam`,
      )
    }
    // …and the LEGACY branch still returns before any of it, so no existing caller pays for it.
    for (const route of LARGE_BOM_ROUTES) {
      const step = STOCK_PREP_OPERATOR_PULL_STEPS.find((entry) => entry.step === route.step)
      assert.equal(
        await gateVerdict(routes, { ...route, user: step.legacyGate === 'write' ? INTEGRATION_WRITER : INTEGRATION_READER, actionId: pull }),
        'admitted',
        `P-07: the legacy tier does not pay for the operator branch on ${route.step}`,
      )
    }
  }

  // 6. WHAT STAYED, STAYED. reconcile and mvp-persist are still refused for the operator tier, and
  //    the background channel changes nothing about that.
  {
    const routes = mount()
    for (const route of [RECONCILE, MVP_PERSIST]) {
      assert.equal(
        await gateVerdict(routes, { ...route, user: OPERATOR, actionId: pull }),
        'refused',
        `P-07: ${route.routePath} is still platform-admin`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// P-08 — THE MANIFEST AND THE ROUTE TABLE AGREE, STEP FOR STEP
// ---------------------------------------------------------------------------
//
// Every moved step must name a route that is actually registered, and every large-BOM route the
// plugin registers must be in the split — otherwise the panel can auto-start a route the manifest
// does not know about, which is exactly how the first cut shipped eight silent 403s.
function everyLargeBomRouteIsInTheSplit() {
  const routes = mount()
  for (const route of ALL_MOVED_ROUTES) {
    assert.ok(
      routes.get(`${route.method.toUpperCase()} ${route.routePath}`),
      `P-08: the manifest names ${route.step}, so the route table must register it`,
    )
  }
  const registeredLargeBom = [...routes.keys()].filter((key) => key.includes('/large-bom/'))
  assert.equal(
    registeredLargeBom.length,
    LARGE_BOM_ROUTES.length,
    `P-08: every registered large-BOM route must be in the split (registered: ${JSON.stringify(registeredLargeBom)})`,
  )
}

async function main() {
  await theOperatorPullsButNeitherReconcilesNorArchives()
  await theOperatorPullReadsAsTheBindingOwner()
  await aStoredLargeBomJobIsRunOnlyByItsCreator()
  await theOperatorReachesTheBoundedBackgroundChannel()
  everyLargeBomRouteIsInTheSplit()
  await theOperatorBranchCannotBeSteeredAcrossTenants()
  await theWideningIsNotAWildcardOverTheTableActionNamespace()
  await theLegacyTiersAreExactlyWhatTheyWere()
  theRuleIsDeclaredOnceAndTheSplitIsNamed()
  console.log('✓ stock-preparation-operator-pull-gate')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
