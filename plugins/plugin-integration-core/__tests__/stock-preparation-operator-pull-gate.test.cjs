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
 * The mount is deliberately INERT below the gate: `tableActions.getTableAction` throws a sentinel.
 * That is the point — this suite asserts on the GATE, so a caller that passes it must fail with the
 * sentinel (proving admission) and a caller that does not must fail with 401/403 BEFORE the sentinel
 * (proving refusal costs no action lookup).
 */
const PAST_THE_GATE = 'PAST_THE_GATE'

function mount({ tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } } } = {}) {
  const routes = new Map()
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: {
          async findObjectSheet() { throw new Error(PAST_THE_GATE) },
          async resolveFieldIds() { throw new Error(PAST_THE_GATE) },
        },
        records: {
          async queryRecords() { throw new Error(PAST_THE_GATE) },
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
    tableActionRegistry: {
      async getTableAction() { throw new Error(PAST_THE_GATE) },
      async listTableActions() { throw new Error(PAST_THE_GATE) },
    },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
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

async function gateVerdict(routes, { method, routePath, user, actionId, body = {}, query = {}, authenticatedTenantId } = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  const req = { user, body, query, params: { actionId } }
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

/** The exact refusal code, for the assertions that care WHICH refusal happened. */
async function refusalCode(routes, input) {
  const handler = routes.get(`${input.method.toUpperCase()} ${input.routePath}`)
  assert.ok(handler, 'route is registered')
  const res = createResponse()
  const req = { user: input.user, body: input.body || {}, query: input.query || {}, params: { actionId: input.actionId } }
  if (input.authenticatedTenantId !== undefined) req.authenticatedTenantId = input.authenticatedTenantId
  try {
    await handler(req, res)
  } catch (error) {
    return error && error.code ? String(error.code) : 'THREW'
  }
  return res.body && res.body.error && res.body.error.code ? String(res.body.error.code) : `OK_${res.statusCode}`
}

const DRY_RUN = { method: 'POST', routePath: '/api/integration/table-actions/:actionId/dry-run' }
const APPLY = { method: 'POST', routePath: '/api/integration/table-actions/:actionId/apply' }
const RECONCILE = { method: 'POST', routePath: '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile' }
const MVP_PERSIST = { method: 'POST', routePath: '/api/integration/table-actions/:actionId/mvp-persist' }

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
    ['dry-run', 'apply'],
    'P-05: exactly two steps moved to the operator tier',
  )
  assert.deepEqual(
    STOCK_PREP_PLATFORM_ADMIN_PULL_STEPS.map((step) => step.step),
    ['reconcile', 'mvp-persist'],
    'P-05: exactly two steps stayed platform-admin',
  )
  for (const step of STOCK_PREP_OPERATOR_PULL_STEPS) {
    assert.equal(typeof step.method, 'string')
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

async function main() {
  await theOperatorPullsButNeitherReconcilesNorArchives()
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
