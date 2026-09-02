'use strict'

// O2 / R-11 — the `/stock-prep` confirmation-queue workbench PERMISSION MATRIX.
//
// R-11 (decision-register.md) approves the vocabulary `stock-prep:read | :operate | :admin` with a
// zero-automatic mapping, and states the alignment principle this suite exists to enforce:
//
//     what is visible must be actionable, and what is not permitted must not be visible.
//
// The suite is structured as an ACTOR x ROUTE matrix, and the assertion that carries the principle is
// M-04: for every actor, the capability set the front end may RENDER equals the capability set the
// back end actually ANSWERS — asserted in BOTH directions, so neither "visible but 403s" nor
// "permitted but hidden" can survive. Because both sides are computed from the one frozen manifest in
// stock-preparation-workbench-access.cjs, the equality holds for every permission subset, not just
// the tiers enumerated here.
//
// Guards (each RED-witnessed by mutation; see the PR body's mutation table):
//   M-01 the three changed routes are gated on the NEW codes, and the four actor tiers land on the
//        exact expected status per route (the matrix golden itself)
//   M-02 NO PRIVILEGE REGRESSION: today's platform admin still passes every route in the manifest,
//        including the two that stayed platform-admin
//   M-03 NO PRIVILEGE GAIN: a bare logged-in user, an integration:read holder and an
//        integration:write holder gain NOTHING — R-11's zero-automatic mapping, asserted rather
//        than assumed. Anonymous is refused everywhere with 401.
//   M-04 ALIGNMENT, both directions, per actor: rendered-capability set == answered-route set
//   M-05 the degenerate grant `stock-prep:operate` WITHOUT `stock-prep:read` confers NOTHING on
//        either side — the conjunction is what makes M-04 hold for every subset, not just tidy ones
//   M-06 reconcile and ensure did NOT move: both still refuse every stock-prep code holder
//   M-07 the gate refuses BEFORE any host work (no provisioning/records call on a refused request)
//   M-08 every `stock-prep:*` token appearing in a requireAccess() call in http-routes.cjs is a
//        member of the frozen vocabulary, and every manifest route is really registered
//   M-09 the value-entry read is on OPERATE, not READ: a read-only actor is refused it, and the
//        values-free queue stays readable to them (the deliberate split, pinned)
//   M-10 项目接入 + THE OPERATOR PULL SPLIT: the four table-action routes the project-sync entry
//        drives keep their LEGACY gates; dry-run and apply additionally admit the stock-prep operator
//        tier for ONE frozen action id; reconcile and mvp-persist did not move and refuse it; the
//        split is not a wildcard over the table-action namespace; and every refusal still costs no
//        host work
//
// Hermetic: no DB, no network. Every service the route module requires that these routes must NOT
// touch is stubbed to throw.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  PLATFORM_ADMIN_GATE,
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_PERMISSION_CODES,
  STOCK_PREP_PERMISSION_DESCRIPTORS,
  STOCK_PREP_READ,
  STOCK_PREP_ROUTE_PERMISSION,
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  grantedStockPrepCapabilities,
  requireAccessGateExpressionsInSource,
  satisfiesStockPrepAccess,
  stockPrepGateTokensInSource,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const {
  OBJECT_ID,
  FIRST_CUT_CONFLICT_TYPE,
  STATUSES,
  RESOLUTION_ACTIONS,
} = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const TENANT_ID = 'tenant-a'
const STAGING = `${TENANT_ID}:integration-core`
const LEDGER_SHEET = 'sheet_confirmation_decisions'
const PROJECT_NO = 'PRJ-0001'
const DECISION_ID = 'decision_matrix_1'
const FINGERPRINT = 'sha16:0123456789abcdef'
const HTTP_ROUTES_SOURCE = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')

// ---------------------------------------------------------------------------
// actors
// ---------------------------------------------------------------------------
//
// All tenant-BOUND to TENANT_ID: the write routes derive the project from the authenticated tenant,
// so a tenantless principal would be refused for a reason unrelated to the permission gate and the
// matrix would be measuring the wrong thing. Synthetic ids only — values-free.

const ANONYMOUS = undefined
const LOGGED_IN = Object.freeze({ id: 'u_plain', tenantId: TENANT_ID, permissions: [] })
const INTEGRATION_READER = Object.freeze({ id: 'u_int_reader', tenantId: TENANT_ID, permissions: ['integration:read'] })
const INTEGRATION_WRITER = Object.freeze({ id: 'u_int_writer', tenantId: TENANT_ID, permissions: ['integration:write'] })
const OPERATOR_READ = Object.freeze({ id: 'u_op_read', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ] })
const OPERATOR_CONFIRM = Object.freeze({ id: 'u_op_confirm', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
// The DEGENERATE grant: operate without read. Must confer nothing (see M-05).
const OPERATOR_ORPHAN_OPERATE = Object.freeze({ id: 'u_op_orphan', tenantId: TENANT_ID, permissions: [STOCK_PREP_OPERATE] })
const WORKBENCH_ADMIN = Object.freeze({ id: 'u_wb_admin', tenantId: TENANT_ID, permissions: [STOCK_PREP_ADMIN] })
const PLATFORM_ADMIN = Object.freeze({ id: 'u_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] })

function permissionsOf(user) {
  if (!user) return []
  const permissions = [...(user.permissions || [])]
  for (const role of user.roles || []) permissions.push(`role:${role}`)
  return permissions
}

// ---------------------------------------------------------------------------
// substrate
// ---------------------------------------------------------------------------

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => {
      throw new Error(`unexpected service call: ${method}`)
    }
  }
  return service
}

function baseServices() {
  return {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
    adapterRegistry: inertService(['createAdapter', 'listAdapterKinds']),
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
  }
}

/** A pending decision row the operator may confirm and read back. Values-free ids only. */
function pendingRow() {
  const row = physicalRow(STAGING, OBJECT_ID, {
    decisionId: DECISION_ID,
    projectNo: PROJECT_NO,
    conflictType: FIRST_CUT_CONFLICT_TYPE,
    status: STATUSES.PENDING,
    inputFingerprint: FINGERPRINT,
    sourceRevision: 'rev-1',
  }, 'rec_seed_1')
  row.sheetId = LEDGER_SHEET
  return row
}

function mount() {
  const routes = new Map()
  const provisioning = {
    ...makeFakeProvisioning({
      stagingProjectId: STAGING,
      sheetIdByObjectId: { [OBJECT_ID]: LEDGER_SHEET },
    }),
    // The provisioning API contract requires ensureObject to EXIST (getProvisioningApi checks all
    // three methods before any read). It throws because none of the routes this matrix drives may
    // create a sheet — readiness inspects, and ensure is platform-admin and asserted refused for
    // every stock-prep tier. If a gate ever slipped and let an operator reach a create path, this
    // throws instead of quietly provisioning.
    async ensureObject() {
      throw new Error('unexpected provisioning write: ensureObject')
    },
  }
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [LEDGER_SHEET]: OBJECT_ID },
    rowsBySheet: { [LEDGER_SHEET]: [pendingRow()] },
  })
  // Counted so M-07 can assert a REFUSED request performs no host work at all.
  let hostCalls = 0
  const countedProvisioning = new Proxy(provisioning, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args) => {
        hostCalls += 1
        return value.apply(target, args)
      }
    },
  })
  const countedRecords = new Proxy(records, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args) => {
        hostCalls += 1
        return value.apply(target, args)
      }
    },
  })
  const auditAppends = []
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: { provisioning: countedProvisioning, records: countedRecords },
    },
    storage: new Map(),
    config: {},
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      auditAppends.push(entry)
      return { ok: true }
    },
  }
  // Present so reconcile passes the lease accessor and reaches its NEXT dependency — which is what
  // lets the matrix tell "refused by the gate" apart from "gate passed, failed downstream".
  // 一线看得见自己工厂的项目: the host tenant principal directory. Present (and admitting) so the
  // project-directory route reaches its READ for a permitted actor — otherwise every 'pass' cell for
  // that capability would be a 501 for a reason unrelated to the permission gate, and the matrix
  // would be measuring the wrong thing. The gate cells are unaffected: they refuse before this.
  services.tenantPrincipalDirectory = {
    async verifyTenantMembership() {
      return { member: true }
    },
  }
  services.stockPreparationConfirmationReconcileLease = {
    async acquire() {
      return { leaseId: 'lease_1' }
    },
    async release() {
      return true
    },
    async renew() {
      return true
    },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return {
    routes,
    auditAppends,
    hostCallCount: () => hostCalls,
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

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a body`)
  return res
}

/**
 * "The GATE refused this caller" — narrower than "the response was 4xx".
 *
 * Only requireAccess emits UNAUTHENTICATED / FORBIDDEN. Matching the CODE, not merely the status,
 * keeps a downstream 403 (a tenant-scope refusal, say) from being miscounted as a permission
 * refusal, which would let a broken gate read as a working one.
 */
function refusedByGate(res) {
  if (![401, 403].includes(res.statusCode)) return false
  const code = res.body && res.body.error && res.body.error.code
  return code === 'UNAUTHENTICATED' || code === 'FORBIDDEN'
}

/** The per-capability request shape, so one loop can drive every route in the manifest. */
const REQUEST_BY_CAPABILITY = Object.freeze({
  'confirmationQueue.readiness': () => ({ query: {} }),
  'confirmationQueue.list': () => ({ query: { projectNo: PROJECT_NO } }),
  'confirmationQueue.valueEntry': () => ({ query: { decisionId: DECISION_ID } }),
  'confirmationQueue.confirm': () => ({
    body: {
      decisionId: DECISION_ID,
      inputFingerprint: FINGERPRINT,
      resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
    },
  }),
  'confirmationQueue.ensure': () => ({ body: {} }),
  'confirmationQueue.reconcile': () => ({ params: { actionId: 'plm-stock-preparation' }, body: {} }),
  // The shared mount()'s provisioning/records fakes only know the confirmation-decision LEDGER object
  // (LEDGER_SHEET), not plm_stock_preparation_main — a 'pass' actor therefore reaches a 404 downstream
  // (findObjectSheet misses -> zero rows -> PREP_LINE_EXPORT_PROJECT_NOT_FOUND), which is exactly the
  // "gate let it through, something else happened" case M-01 measures (404 is not refusedByGate).
  'confirmationQueue.export': () => ({ query: { projectNo: PROJECT_NO } }),
  // 一线看得见自己工厂的项目: the operator project directory takes no selector — it IS the selector.
  // A 'pass' actor reaches the read and gets an empty-but-successful directory (the shared mount()'s
  // provisioning only knows the LEDGER object, so the project table misses and directoryReady is
  // false), which is exactly the "gate let it through, something else happened" case M-01 measures.
  'confirmationQueue.projectDirectory': () => ({ query: {} }),
  // 通知下一步. The shared mount() configures no handoff chain and injects no handoff store, so a
  // 'pass' actor lands PAST the gate on the feature's inert behaviour: the status read answers 200
  // with `configured: false`, and the advance answers 501 STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED.
  // Neither is refusedByGate, which is exactly the "the gate let it through, something else happened"
  // case M-01 measures — and it doubles as a restatement here that an unconfigured deployment refuses
  // by CONFIG rather than by permission.
  'handoff.read': () => ({ query: { projectNo: PROJECT_NO } }),
  'handoff.advance': () => ({ body: { projectNo: PROJECT_NO, fromStepKey: 'prep_entry' } }),
})

async function callCapability(routes, capability, user) {
  const build = REQUEST_BY_CAPABILITY[capability.capability]
  assert.ok(build, `capability ${capability.capability} has a request shape`)
  return call(routes, capability.method, capability.path, { ...build(), user })
}

/** The capability ids the BACK END actually answers for this user (i.e. does not refuse at the gate). */
async function answeredCapabilities(routes, user) {
  const answered = []
  for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) {
    const res = await callCapability(routes, capability, user)
    if (!refusedByGate(res)) answered.push(capability.capability)
  }
  return answered
}

// ---------------------------------------------------------------------------
// M-01 the matrix golden
// ---------------------------------------------------------------------------

// Expected outcome per actor x capability. `gate` = refused by requireAccess; `pass` = the gate let
// it through (whatever happens downstream). Written out in full rather than derived, so a change in
// the decision function has to be RESTATED here to stay green — a derived table would silently agree
// with whatever the code does.
const MATRIX = Object.freeze({
  anonymous: Object.freeze({
    'confirmationQueue.readiness': 'gate',
    'confirmationQueue.list': 'gate',
    'confirmationQueue.valueEntry': 'gate',
    'confirmationQueue.confirm': 'gate',
    'confirmationQueue.export': 'gate',
    'confirmationQueue.projectDirectory': 'gate',
    'handoff.read': 'gate',
    'handoff.advance': 'gate',
    'confirmationQueue.ensure': 'gate',
    'confirmationQueue.reconcile': 'gate',
  }),
  loggedIn: Object.freeze({
    'confirmationQueue.readiness': 'gate',
    'confirmationQueue.list': 'gate',
    'confirmationQueue.valueEntry': 'gate',
    'confirmationQueue.confirm': 'gate',
    'confirmationQueue.export': 'gate',
    'confirmationQueue.projectDirectory': 'gate',
    'handoff.read': 'gate',
    'handoff.advance': 'gate',
    'confirmationQueue.ensure': 'gate',
    'confirmationQueue.reconcile': 'gate',
  }),
  integrationWriter: Object.freeze({
    'confirmationQueue.readiness': 'gate',
    'confirmationQueue.list': 'gate',
    'confirmationQueue.valueEntry': 'gate',
    'confirmationQueue.confirm': 'gate',
    'confirmationQueue.export': 'gate',
    'confirmationQueue.projectDirectory': 'gate',
    'handoff.read': 'gate',
    'handoff.advance': 'gate',
    'confirmationQueue.ensure': 'gate',
    'confirmationQueue.reconcile': 'gate',
  }),
  operatorRead: Object.freeze({
    'confirmationQueue.readiness': 'pass',
    'confirmationQueue.list': 'pass',
    'confirmationQueue.valueEntry': 'gate',
    'confirmationQueue.confirm': 'gate',
    'confirmationQueue.export': 'gate',
    'confirmationQueue.projectDirectory': 'gate',
    'handoff.read': 'pass',
    'handoff.advance': 'gate',
    'confirmationQueue.ensure': 'gate',
    'confirmationQueue.reconcile': 'gate',
  }),
  operatorConfirm: Object.freeze({
    'confirmationQueue.readiness': 'pass',
    'confirmationQueue.list': 'pass',
    'confirmationQueue.valueEntry': 'pass',
    'confirmationQueue.confirm': 'pass',
    'confirmationQueue.export': 'pass',
    'confirmationQueue.projectDirectory': 'pass',
    'handoff.read': 'pass',
    'handoff.advance': 'pass',
    'confirmationQueue.ensure': 'gate',
    'confirmationQueue.reconcile': 'gate',
  }),
  orphanOperate: Object.freeze({
    'confirmationQueue.readiness': 'gate',
    'confirmationQueue.list': 'gate',
    'confirmationQueue.valueEntry': 'gate',
    'confirmationQueue.confirm': 'gate',
    'confirmationQueue.export': 'gate',
    'confirmationQueue.projectDirectory': 'gate',
    'handoff.read': 'gate',
    'handoff.advance': 'gate',
    'confirmationQueue.ensure': 'gate',
    'confirmationQueue.reconcile': 'gate',
  }),
  workbenchAdmin: Object.freeze({
    'confirmationQueue.readiness': 'pass',
    'confirmationQueue.list': 'pass',
    'confirmationQueue.valueEntry': 'pass',
    'confirmationQueue.confirm': 'pass',
    'confirmationQueue.export': 'pass',
    'confirmationQueue.projectDirectory': 'pass',
    'handoff.read': 'pass',
    'handoff.advance': 'pass',
    'confirmationQueue.ensure': 'gate',
    'confirmationQueue.reconcile': 'gate',
  }),
  platformAdmin: Object.freeze({
    'confirmationQueue.readiness': 'pass',
    'confirmationQueue.list': 'pass',
    'confirmationQueue.valueEntry': 'pass',
    'confirmationQueue.confirm': 'pass',
    'confirmationQueue.export': 'pass',
    'confirmationQueue.projectDirectory': 'pass',
    'handoff.read': 'pass',
    'handoff.advance': 'pass',
    'confirmationQueue.ensure': 'pass',
    'confirmationQueue.reconcile': 'pass',
  }),
})

const ACTORS = Object.freeze({
  anonymous: ANONYMOUS,
  loggedIn: LOGGED_IN,
  integrationWriter: INTEGRATION_WRITER,
  operatorRead: OPERATOR_READ,
  operatorConfirm: OPERATOR_CONFIRM,
  orphanOperate: OPERATOR_ORPHAN_OPERATE,
  workbenchAdmin: WORKBENCH_ADMIN,
  platformAdmin: PLATFORM_ADMIN,
})

async function matrixGoldenHolds() {
  for (const [actorName, expectations] of Object.entries(MATRIX)) {
    const user = ACTORS[actorName]
    for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) {
      // A fresh mount per call: confirm MUTATES the seeded row, and a matrix whose later cells
      // depend on earlier ones is not a matrix.
      const { routes } = mount()
      const res = await callCapability(routes, capability, user)
      const expected = expectations[capability.capability]
      assert.ok(expected, `M-01: ${actorName} has an expectation for ${capability.capability}`)
      if (expected === 'gate') {
        assert.ok(
          refusedByGate(res),
          `M-01: ${actorName} must be REFUSED at ${capability.method} ${capability.path}, got ${res.statusCode} ${JSON.stringify(res.body && res.body.error)}`,
        )
        // Anonymous is 401 (no principal); every authenticated refusal is 403.
        assert.equal(res.statusCode, user === undefined ? 401 : 403, `M-01: ${actorName} refusal status at ${capability.capability}`)
      } else {
        assert.ok(
          !refusedByGate(res),
          `M-01: ${actorName} must PASS the gate at ${capability.method} ${capability.path}, got ${res.statusCode} ${JSON.stringify(res.body && res.body.error)}`,
        )
      }
    }
  }
}

/**
 * Positive control for the matrix: 'pass' is not merely "not a gate refusal" for the four operator
 * routes — an authorized caller gets a real 200 with the values-free queue projection. Without this
 * the whole 'pass' column could be satisfied by every route failing 500 downstream.
 */
async function authorizedOperatorGetsRealResponses() {
  {
    const { routes } = mount()
    const res = await call(routes, 'GET', '/api/integration/stock-preparation/confirmation-decisions', {
      user: OPERATOR_READ,
      query: { projectNo: PROJECT_NO },
    })
    assert.equal(res.statusCode, 200, 'M-01+: the operator READS the queue')
    assert.equal(res.body.ok, true)
    assert.equal(res.body.data.rowCount, 1)
    assert.equal(res.body.data.rows[0].decisionId, DECISION_ID)
    // Values-free: the queue carries presence booleans, never contents.
    assert.equal(res.body.data.rows[0].resolvedValuePresent, false)
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body.data.rows[0], 'resolvedValue'))
  }
  {
    const { routes } = mount()
    const res = await call(routes, 'GET', '/api/integration/stock-preparation/confirmation-decisions/readiness', {
      user: OPERATOR_READ,
      query: {},
    })
    assert.equal(res.statusCode, 200, 'M-01+: the operator reads READINESS')
    assert.equal(res.body.ok, true)
  }
  {
    const { routes } = mount()
    const res = await call(routes, 'GET', '/api/integration/stock-preparation/confirmation-decisions/value-entry', {
      user: OPERATOR_CONFIRM,
      query: { decisionId: DECISION_ID },
    })
    assert.equal(res.statusCode, 200, 'M-01+: the confirming operator reads its own VALUE ENTRY')
    assert.equal(res.body.data.decisionId, DECISION_ID)
  }
  {
    const { routes, auditAppends } = mount()
    const res = await call(routes, 'POST', '/api/integration/stock-preparation/confirmation-decisions/confirm', {
      user: OPERATOR_CONFIRM,
      body: {
        decisionId: DECISION_ID,
        inputFingerprint: FINGERPRINT,
        resolutionAction: RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS,
      },
    })
    assert.equal(res.statusCode, 200, `M-01+: the operator CONFIRMS, got ${JSON.stringify(res.body)}`)
    // Attributable: the customer operator's own principal is stamped, exactly as an admin's was.
    assert.equal(auditAppends.length, 1)
    assert.equal(auditAppends[0].actor, OPERATOR_CONFIRM.id)
  }
}

// ---------------------------------------------------------------------------
// M-02 / M-03 the negative controls (which matter more than the positives)
// ---------------------------------------------------------------------------

async function platformAdminLosesNothing() {
  for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) {
    const { routes } = mount()
    const res = await callCapability(routes, capability, PLATFORM_ADMIN)
    assert.ok(
      !refusedByGate(res),
      `M-02: platform admin must keep ${capability.method} ${capability.path}, got ${res.statusCode}`,
    )
  }
  // Both admin shapes the pre-change gate honoured still pass: role:admin alone, and
  // integration:admin alone. Neither holds any stock-prep code.
  for (const admin of [
    { id: 'u_role_admin', tenantId: TENANT_ID, roles: ['admin'] },
    { id: 'u_int_admin', tenantId: TENANT_ID, permissions: ['integration:admin'] },
  ]) {
    for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) {
      const { routes } = mount()
      const res = await callCapability(routes, capability, admin)
      assert.ok(!refusedByGate(res), `M-02: ${admin.id} must keep ${capability.capability}`)
    }
  }
}

async function nobodyGainsAnything() {
  // R-11's zero-automatic mapping, asserted: no pre-existing integration scope becomes a stock-prep
  // scope. These three actors could reach NOTHING here before this change and must reach nothing now.
  for (const user of [LOGGED_IN, INTEGRATION_READER, INTEGRATION_WRITER]) {
    for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) {
      const { routes } = mount()
      const res = await callCapability(routes, capability, user)
      assert.ok(refusedByGate(res), `M-03: ${user.id} must be refused ${capability.capability}`)
      assert.equal(res.statusCode, 403)
    }
    assert.deepEqual(grantedStockPrepCapabilities(permissionsOf(user)), [], `M-03: ${user.id} is granted no capability`)
  }
  for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) {
    const { routes } = mount()
    const res = await callCapability(routes, capability, ANONYMOUS)
    assert.equal(res.statusCode, 401, `M-03: anonymous is unauthenticated at ${capability.capability}`)
    assert.equal(res.body.error.code, 'UNAUTHENTICATED')
  }
}

// ---------------------------------------------------------------------------
// M-04 THE ALIGNMENT ASSERTION — the point of the whole suite
// ---------------------------------------------------------------------------

/**
 * For every actor, in BOTH directions:
 *   nothing visible-but-403   : every capability the FE would render is answered by the BE
 *   nothing permitted-but-hidden: every capability the BE answers is rendered by the FE
 *
 * `grantedStockPrepCapabilities` is the SAME function the browser mirror is asserted byte-equal to
 * (apps/web/tests/stockPrepPermissionMatrix.spec.ts), so proving it here against the live routes
 * proves it for the rendered surface too.
 */
async function visibleEqualsActionableForEveryActor() {
  for (const [actorName, user] of Object.entries(ACTORS)) {
    const { routes } = mount()
    const answered = await answeredCapabilities(routes, user)
    const rendered = grantedStockPrepCapabilities(permissionsOf(user))

    const visibleButRefused = rendered.filter((capability) => !answered.includes(capability))
    assert.deepEqual(visibleButRefused, [], `M-04 (${actorName}): a control would render for a route that refuses it — ${visibleButRefused.join(', ')}`)

    const permittedButHidden = answered.filter((capability) => !rendered.includes(capability))
    assert.deepEqual(permittedButHidden, [], `M-04 (${actorName}): a route is permitted but no control renders for it — ${permittedButHidden.join(', ')}`)

    assert.deepEqual([...rendered].sort(), [...answered].sort(), `M-04 (${actorName}): visible set must EQUAL actionable set`)
  }
}

/**
 * The equality above is asserted over eight named actors; this widens it to EVERY subset of the
 * vocabulary plus the platform-admin bit. 2^3 x 2 = 16 principals, each checked against the live
 * routes — so the alignment claim is exhaustive over the vocabulary, not a sample of it.
 */
async function alignmentHoldsForEverySubsetOfTheVocabulary() {
  const codes = [...STOCK_PREP_PERMISSION_CODES]
  for (let mask = 0; mask < (1 << codes.length); mask += 1) {
    for (const platformAdmin of [false, true]) {
      const held = codes.filter((_, index) => (mask & (1 << index)) !== 0)
      const user = {
        id: `u_subset_${mask}_${platformAdmin ? 'admin' : 'plain'}`,
        tenantId: TENANT_ID,
        permissions: platformAdmin ? [...held, 'integration:admin'] : held,
      }
      const { routes } = mount()
      const answered = await answeredCapabilities(routes, user)
      const rendered = grantedStockPrepCapabilities(permissionsOf(user))
      assert.deepEqual(
        [...rendered].sort(),
        [...answered].sort(),
        `M-04*: alignment must hold for the subset {${held.join(', ')}}${platformAdmin ? ' + integration:admin' : ''}`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// M-05 / M-06 / M-07 / M-08 / M-09
// ---------------------------------------------------------------------------

async function orphanOperateGrantConfersNothing() {
  assert.equal(satisfiesStockPrepAccess([STOCK_PREP_OPERATE], STOCK_PREP_OPERATE), false, 'M-05: operate alone does not satisfy operate')
  assert.equal(satisfiesStockPrepAccess([STOCK_PREP_OPERATE], STOCK_PREP_READ), false, 'M-05: operate alone does not satisfy read')
  assert.deepEqual(grantedStockPrepCapabilities([STOCK_PREP_OPERATE]), [], 'M-05: operate alone renders nothing')
  for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) {
    const { routes } = mount()
    const res = await callCapability(routes, capability, OPERATOR_ORPHAN_OPERATE)
    assert.ok(refusedByGate(res), `M-05: operate-without-read must be refused ${capability.capability}`)
  }
  // And the conjunction is the ONLY thing standing between that grant and a misaligned actor: adding
  // read turns it into the full operator tier.
  assert.deepEqual(
    grantedStockPrepCapabilities([STOCK_PREP_OPERATE, STOCK_PREP_READ]).sort(),
    [
      'confirmationQueue.confirm',
      'confirmationQueue.export',
      'confirmationQueue.list',
      // 一线看得见自己工厂的项目: the own-tenant project directory joins the operator tier. Note this
      // list is the RENDERABLE set; holding the tier is necessary but not sufficient to be ANSWERED
      // this one — the route additionally requires a principal with a tenant of its own, which is
      // what keeps a tenantless platform admin off the value surface (see the directory suite's G-04).
      'confirmationQueue.projectDirectory',
      'confirmationQueue.readiness',
      'confirmationQueue.valueEntry',
      // 通知下一步: the turn signal rides READ, the handoff itself rides the OPERATE conjunction — so
      // both appear here and neither appears for the orphan-operate grant above.
      'handoff.advance',
      'handoff.read',
    ],
    'M-05: operate + read is the full operator tier',
  )
}

async function reconcileAndEnsureDidNotMove() {
  const ownerLevel = STOCK_PREP_WORKBENCH_CAPABILITIES.filter((capability) => capability.code === PLATFORM_ADMIN_GATE)
  assert.deepEqual(
    ownerLevel.map((capability) => capability.capability).sort(),
    ['confirmationQueue.ensure', 'confirmationQueue.reconcile'],
    'M-06: exactly reconcile and ensure stay platform-admin',
  )
  // No stock-prep code, not even the workbench-admin ceiling, reaches them.
  for (const user of [OPERATOR_READ, OPERATOR_CONFIRM, WORKBENCH_ADMIN]) {
    for (const capability of ownerLevel) {
      const { routes } = mount()
      const res = await callCapability(routes, capability, user)
      assert.ok(refusedByGate(res), `M-06: ${user.id} must not reach ${capability.capability}`)
    }
  }
  // Structural: the two handlers still carry the literal platform-admin gate.
  assert.ok(
    /async stockPreparationConfirmationDecisionsEnsure\(req, res\) \{\s*requireAccess\(req, 'admin'\)/.test(HTTP_ROUTES_SOURCE),
    "M-06: ensure still calls requireAccess(req, 'admin')",
  )
  assert.ok(
    /async tableActionConfirmationDecisionsReconcile\(req, res\) \{\s*const user = requireAccess\(req, 'admin'\)/.test(HTTP_ROUTES_SOURCE),
    "M-06: reconcile still calls requireAccess(req, 'admin')",
  )
}

async function refusedRequestsPerformNoHostWork() {
  for (const user of [ANONYMOUS, LOGGED_IN, INTEGRATION_WRITER, OPERATOR_ORPHAN_OPERATE]) {
    const harness = mount()
    for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) {
      const res = await callCapability(harness.routes, capability, user)
      assert.ok(refusedByGate(res), 'M-07: precondition — this actor is refused everywhere')
    }
    assert.equal(harness.hostCallCount(), 0, `M-07: a refused caller (${user ? user.id : 'anonymous'}) reaches no host API`)
    assert.deepEqual(harness.auditAppends, [], 'M-07: a refused caller writes no audit row')
  }
}

function vocabularyIsFrozenAndRoutesAreRegistered() {
  // The stock-prep gates are written as the imported CONSTANTS, never as hand-typed strings. That
  // matters because the decision function refuses an unknown token for EVERYONE, admins included: a
  // literal typo would be a silent outage, whereas a misspelt identifier is a load-time ReferenceError.
  const gates = requireAccessGateExpressionsInSource(HTTP_ROUTES_SOURCE)
  assert.deepEqual(
    stockPrepGateTokensInSource(HTTP_ROUTES_SOURCE),
    [],
    'M-08: no requireAccess gate hand-types a stock-prep token — they reference the frozen constants',
  )
  assert.deepEqual(
    gates.identifiers,
    ['STOCK_PREP_OPERATE', 'STOCK_PREP_READ'],
    'M-08: exactly the read and operate constants are used as gate expressions',
  )
  // ...and those identifiers really carry the frozen codes (the names alone prove nothing).
  for (const code of [STOCK_PREP_READ, STOCK_PREP_OPERATE]) {
    assert.ok(STOCK_PREP_PERMISSION_CODES.includes(code), `M-08: ${code} is in the frozen vocabulary`)
  }
  // The legacy tokens are untouched: the three-tier integration vocabulary still gates everything else.
  for (const legacy of ['admin', 'read', 'write']) {
    assert.ok(gates.literals.includes(legacy), `M-08: the legacy '${legacy}' gate still exists`)
  }

  // The manifest is not decoration: every entry names a route that is really registered.
  const { routes } = mount()
  for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES) {
    assert.ok(
      routes.has(`${capability.method} ${capability.path}`),
      `M-08: manifest route ${capability.method} ${capability.path} is registered`,
    )
  }

  // The seed migration's rows and the vocabulary cannot drift.
  assert.deepEqual(
    STOCK_PREP_PERMISSION_DESCRIPTORS.map((descriptor) => descriptor.code),
    [...STOCK_PREP_PERMISSION_CODES],
    'M-08: every code has a seed descriptor, in order',
  )
  for (const descriptor of STOCK_PREP_PERMISSION_DESCRIPTORS) {
    assert.equal(typeof descriptor.name, 'string')
    assert.ok(descriptor.name.length > 0, 'M-08: permissions.name is NOT NULL in the schema')
  }
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'packages', 'core-backend', 'src', 'db', 'migrations', 'zzzz20260830100000_add_stock_prep_permissions.ts'),
    'utf8',
  )
  for (const code of STOCK_PREP_PERMISSION_CODES) {
    assert.ok(migration.includes(`'${code}'`), `M-08: the migration seeds ${code}`)
  }
  // R-11: zero holders. The migration must NOT bind any role to these codes.
  assert.ok(
    !/INSERT INTO role_permissions/.test(migration),
    'M-08: the seed grants the codes to NO role — R-11 requires zero automatic holders',
  )

  // The route the FE guards on is the READ code, stated once and shared.
  assert.equal(STOCK_PREP_ROUTE_PERMISSION, STOCK_PREP_READ, 'M-08: /stock-prep reachability is the queue read code')
}

async function valueEntryIsOperateNotRead() {
  // The deliberate split (see the route comment): the ONE content-bearing read sits one notch above
  // the queue. A read-only actor keeps the values-free queue and is refused the contents.
  const { routes } = mount()
  const queue = await call(routes, 'GET', '/api/integration/stock-preparation/confirmation-decisions', {
    user: OPERATOR_READ,
    query: { projectNo: PROJECT_NO },
  })
  assert.equal(queue.statusCode, 200, 'M-09: the read-only actor keeps the queue')

  const valueEntry = await call(routes, 'GET', '/api/integration/stock-preparation/confirmation-decisions/value-entry', {
    user: OPERATOR_READ,
    query: { decisionId: DECISION_ID },
  })
  assert.ok(refusedByGate(valueEntry), 'M-09: the read-only actor is refused the value contents')
  assert.equal(valueEntry.statusCode, 403)

  const capabilityByCode = new Map(STOCK_PREP_WORKBENCH_CAPABILITIES.map((capability) => [capability.capability, capability.code]))
  assert.equal(capabilityByCode.get('confirmationQueue.valueEntry'), STOCK_PREP_OPERATE, 'M-09: value-entry is manifested on OPERATE')
  assert.equal(capabilityByCode.get('confirmationQueue.list'), STOCK_PREP_READ, 'M-09: the queue list is manifested on READ')
}

// ---------------------------------------------------------------------------
// M-10 项目接入 — the four routes the project-sync entry drives, and the OPERATOR PULL SPLIT
// ---------------------------------------------------------------------------

/**
 * The 项目接入 panel (apps/web/src/components/integration/stockPreparation/
 * StockPreparationProjectSyncPanel.vue) turns the owner's sentence — 「点一下项目号,该项目号里的 bom
 * 就自动导入到我们的多维表中」 — into four calls.
 *
 * WHAT THE OWNER THEN CHANGED, AND WHAT THEY DID NOT. 项目备料页 carries a ruling that a floor
 * operator may SELF-SERVE the pull: without it the page opens on a project whose BOM nobody on the
 * floor can bring in, and 「找平台管理员」 is not an answer at 07:00 on a shop floor. Two of the four
 * routes therefore gained a SECOND admitted tier. Two did not — and the pair that did not is exactly
 * the pair R-11(b) names as owner-level. So this block pins the SPLIT rather than the old uniform
 * refusal. Same job, sharper claim:
 *
 *   M-10a the four routes keep their LEGACY gates unchanged, read out of the SOURCE. dry-run and
 *         apply reach them through `requireTableActionAccess`, which consults the operator tier ONLY
 *         after the legacy gate has already refused — so a gate quietly relaxed the other way (a bare
 *         `requireAccess(req, STOCK_PREP_OPERATE)`, which would widen these GENERIC routes to every
 *         table action on the deployment) still reddens here.
 *   M-10b THE TWO THAT STAYED, STAYED. The operator tier is refused at the gate on reconcile (a
 *         SOURCE READ that consumes a B2a claim when armed) and on mvp-persist, and neither handler
 *         may even mention the split helper. Everything below the operator tier is still refused on
 *         all four — including an operate-WITHOUT-read grant, because the tier is a CONJUNCTION.
 *   M-10c THE SPLIT IS SCOPED TO ONE ACTION ID. The same operator on any other actionId is refused
 *         on all four: the widening is not a wildcard over the table-action namespace.
 *   M-10d and every refusal still costs nothing — no provisioning or records call is made on the way
 *         to it, which is what makes "hidden in the UI" a courtesy rather than the enforcement.
 *
 * The POSITIVE half — that the operator actually reaches dry-run and apply — belongs to
 * __tests__/stock-preparation-operator-pull-gate.test.cjs, which owns the split end to end.
 */
const PROJECT_SYNC_ROUTES = Object.freeze([
  Object.freeze({
    handler: 'tableActionDryRun',
    gate: 'read',
    path: '/api/integration/table-actions/:actionId/dry-run',
    operatorMayRun: true,
  }),
  Object.freeze({
    handler: 'tableActionApply',
    gate: 'write',
    path: '/api/integration/table-actions/:actionId/apply',
    operatorMayRun: true,
  }),
  Object.freeze({
    handler: 'tableActionConfirmationDecisionsReconcile',
    gate: 'admin',
    path: '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile',
    operatorMayRun: false,
  }),
  Object.freeze({
    handler: 'tableActionMvpPersist',
    gate: 'admin',
    path: '/api/integration/table-actions/:actionId/mvp-persist',
    operatorMayRun: false,
  }),
])

const PULL_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const NON_STOCK_PREP_ACTION_ID = 'k3.material.pull.v1'

function projectSyncGatesAreUnchanged() {
  for (const route of PROJECT_SYNC_ROUTES) {
    // The gate is the FIRST gate call in the handler body. Matching on the handler name keeps the
    // assertion attached to the route rather than to a line number. The two split routes name their
    // legacy token as the third argument of `requireTableActionAccess`; the two that stayed name it
    // as the second argument of `requireAccess`. Either way the TOKEN must be the one the route has
    // always used.
    const pattern = route.operatorMayRun
      ? new RegExp(`async ${route.handler}\\(req, res\\) \\{[\\s\\S]{0,400}?requireTableActionAccess\\(req, actionId, '([a-z]+)'\\)`)
      : new RegExp(`async ${route.handler}\\(req, res\\) \\{[\\s\\S]{0,400}?requireAccess\\(req, '([a-z]+)'\\)`)
    const match = pattern.exec(HTTP_ROUTES_SOURCE)
    assert.ok(match, `M-10a: ${route.handler} must open with its gate call`)
    assert.equal(
      match[1],
      route.gate,
      `M-10a: ${route.handler} keeps its legacy '${route.gate}' tier. The operator split is ADDITIVE — ` +
      'if this moved, a UI change relaxed a server gate.',
    )
    assert.ok(
      HTTP_ROUTES_SOURCE.includes(`'${route.path}'`),
      `M-10a: ${route.path} is registered in the route table`,
    )
  }
  // The two that stayed must not have acquired the split helper at all.
  for (const route of PROJECT_SYNC_ROUTES.filter((entry) => !entry.operatorMayRun)) {
    const body = new RegExp(`async ${route.handler}\\(req, res\\) \\{[\\s\\S]{0,400}`).exec(HTTP_ROUTES_SOURCE)
    assert.ok(body, `M-10b: ${route.handler} body is readable`)
    assert.ok(
      !body[0].includes('requireTableActionAccess'),
      `M-10b: ${route.handler} must NOT use the operator-split gate — it stayed platform-admin`,
    )
  }
}

async function projectSyncRefusesTheTiersItAlwaysRefused() {
  const { routes, hostCallCount } = mount()
  const before = hostCallCount()

  // Everything BELOW the operator tier, refused on all four routes exactly as before. The orphan
  // operate grant is in this list on purpose: the tier is a conjunction, so the split confers
  // nothing on it either.
  for (const user of [OPERATOR_READ, OPERATOR_ORPHAN_OPERATE, LOGGED_IN, ANONYMOUS]) {
    for (const route of PROJECT_SYNC_ROUTES) {
      const res = await call(routes, 'POST', route.path, {
        user,
        params: { actionId: PULL_ACTION_ID },
        body: { parameters: { projectNo: PROJECT_NO } },
      })
      assert.ok(
        refusedByGate(res),
        `M-10b: ${route.handler} must refuse ${(user && user.id) || 'anonymous'} at the gate ` +
        `(got ${res.statusCode} ${res.body && res.body.error && res.body.error.code})`,
      )
    }
  }

  // THE TWO THAT STAYED: the operator tier, and the workbench-admin tier above it, are refused on
  // reconcile and mvp-persist — on the pull action itself, where the split is live.
  for (const user of [OPERATOR_CONFIRM, WORKBENCH_ADMIN]) {
    for (const route of PROJECT_SYNC_ROUTES.filter((entry) => !entry.operatorMayRun)) {
      const res = await call(routes, 'POST', route.path, {
        user,
        params: { actionId: PULL_ACTION_ID },
        body: { parameters: { projectNo: PROJECT_NO } },
      })
      assert.ok(
        refusedByGate(res),
        `M-10b: ${route.handler} stayed platform-admin and must refuse ${user.id} ` +
        `(got ${res.statusCode} ${res.body && res.body.error && res.body.error.code})`,
      )
    }
  }

  // M-10c: on any OTHER table action the operator is refused on all four, split included.
  for (const user of [OPERATOR_CONFIRM, WORKBENCH_ADMIN]) {
    for (const route of PROJECT_SYNC_ROUTES) {
      const res = await call(routes, 'POST', route.path, {
        user,
        params: { actionId: NON_STOCK_PREP_ACTION_ID },
        body: { parameters: { projectNo: PROJECT_NO } },
      })
      assert.ok(
        refusedByGate(res),
        `M-10c: ${route.handler} must refuse ${user.id} on a table action that is not the stock-prep pull ` +
        `(got ${res.statusCode} ${res.body && res.body.error && res.body.error.code})`,
      )
    }
  }

  // M-10d: every refusal above reached no host service.
  assert.equal(hostCallCount(), before, 'M-10d: a refused project-sync request performs no host work')
}

// ---------------------------------------------------------------------------

async function main() {
  await matrixGoldenHolds()
  await authorizedOperatorGetsRealResponses()
  await platformAdminLosesNothing()
  await nobodyGainsAnything()
  await visibleEqualsActionableForEveryActor()
  await alignmentHoldsForEverySubsetOfTheVocabulary()
  await orphanOperateGrantConfersNothing()
  await reconcileAndEnsureDidNotMove()
  await refusedRequestsPerformNoHostWork()
  vocabularyIsFrozenAndRoutesAreRegistered()
  await valueEntryIsOperateNotRead()
  // The RUNTIME refusal first: it is the claim that matters, and the source check below only
  // corroborates it. Running the source check first would let it short-circuit a real relaxation.
  await projectSyncRefusesTheTiersItAlwaysRefused()
  projectSyncGatesAreUnchanged()
  console.log('stock-preparation permission matrix (O2/R-11): all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
