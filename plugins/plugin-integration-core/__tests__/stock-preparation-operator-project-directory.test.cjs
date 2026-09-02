'use strict'

// 一线看得见自己工厂的项目 — GUARDS for the operator-scoped, NAME-BEARING project directory.
//
// This is the first stock-preparation READ that returns the customer's own business values
// (`projectNo` / `projectName`) to a caller. The owner's ruling that permits it is that the boundary
// is "WHOSE DATA IS IT", not "which screen is it": the values-free posture exists to keep the
// PLATFORM/CONSULTANT side out of customer values, and a factory operator seeing their OWN tenant's
// project numbers is the job. Everything below exists to make that sentence mechanically true rather
// than merely intended.
//
// GUARDS (each RED-witnessed by mutation — see the PR body's mutation table):
//   G-01 CROSS-TENANT REFUSED — the single most important one. An operator of tenant A never sees
//        tenant B's project names: not by steering `tenantId`, not by default, not in any byte of the
//        serialized response.
//   G-02 THE PLATFORM VALUES-FREE ROUTE IS UNCHANGED — GET /stock-preparation/projects still emits
//        the exact 8-key values-free projection, and a planted sourceProjectNo/projectName reaches
//        neither its values NOR its field names. Pinned at the ROUTE level (the pre-existing suite
//        pins it at the module level), so this PR's new sibling cannot have widened it.
//   G-03 UNDER-PRIVILEGED REFUSED BEFORE ANY IO — anonymous, integration:read, stock-prep:read and
//        the degenerate operate-without-read grant are all refused with ZERO host calls.
//   G-04 THE PLATFORM-SIDE REFUSAL — a TENANTLESS platform admin passes the permission gate and is
//        then refused for having no tenant of its own, with zero host calls. This is the guard that
//        keeps "us" out of the value surface, and it is the one an implication-shaped design loses.
//   G-05 AUDIT STAYS VALUES-FREE THOUGH THE RESPONSE DOES NOT — the response carries the planted
//        secret (that is the feature); no audit row does, in any key or any value.
//   G-06 AUDIT-BEFORE-VALUES — an audit store that refuses the row means no value-bearing body is
//        ever sent (the H0 lock's H3-0 ③ fail-closed requirement).
//   G-07 THE HOST MUST VOUCH — absent directory → 501; a `member:false` verdict → 403; neither
//        touches records/provisioning.
//   G-08 A HEADER TENANT CANNOT OVERRIDE A VERIFIED CLAIM — the concrete hole this capability closes
//        (jwt-middleware copies `x-tenant-id` onto `user.tenantId` when the token carries no claim).
//   G-09 THE WORKLIST IS REAL — pendingDecisionCount comes from the ledger, joined on the
//        projectNo == sourceProjectNo identity the persist path stamps.
//   G-10 EMPTY-STATE HONESTY — directoryReady / ledgerReady distinguish "nothing installed",
//        "no ledger yet" and "genuinely nothing pending" instead of collapsing them into one screen.
//
// Hermetic: no DB, no network, no xlsx. Every service the route module requires that these routes
// must not touch is stubbed to throw.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_READ,
  STOCK_PREP_WORKBENCH_CAPABILITIES,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const {
  OBJECT_ID: DECISION_OBJECT_ID,
  FIRST_CUT_CONFLICT_TYPE,
  STATUSES,
} = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const {
  PROJECT_OBJECT_ID,
} = require(path.join(LIB, 'stock-preparation-operator-project-directory.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const DIRECTORY_PATH = '/api/integration/stock-preparation/operator/projects'
const VALUES_FREE_PROJECTS_PATH = '/api/integration/stock-preparation/projects'

const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const STAGING_A = `${TENANT_A}:integration-core`
const STAGING_B = `${TENANT_B}:integration-core`

// The canary. Planted into tenant B's VALUE fields; if it ever appears in a response tenant A's
// operator received, the cross-tenant guard has failed and the test says so by name.
const SECRET_B = 'ZZTENANTBSECRETZZ'

const PROJECT_SHEET_A = 'sheet_project_a'
const PROJECT_SHEET_B = 'sheet_project_b'
const LEDGER_SHEET_A = 'sheet_ledger_a'

// Tenant A's real-shaped project: the number an operator would otherwise have to memorise, and the
// name that makes memorising it unnecessary.
const PROJECT_A_NO = '230920006'
const PROJECT_A_NAME = 'RY2注射水缓冲罐部件'
const PROJECT_A_ID = 'stockprep_project_a1'
// A second tenant-A project with NOTHING pending — G-10's "genuinely nothing pending" case.
const PROJECT_A2_NO = '230920007'
const PROJECT_A2_NAME = 'RY2纯化水储罐部件'
const PROJECT_A2_ID = 'stockprep_project_a2'

// ---------------------------------------------------------------------------
// actors
// ---------------------------------------------------------------------------

const ANONYMOUS = undefined
const OPERATOR_A = Object.freeze({ id: 'u_op_a', tenantId: TENANT_A, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const OPERATOR_B = Object.freeze({ id: 'u_op_b', tenantId: TENANT_B, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const OPERATOR_A_READ_ONLY = Object.freeze({ id: 'u_op_a_r', tenantId: TENANT_A, permissions: [STOCK_PREP_READ] })
// The degenerate grant the workbench vocabulary deliberately makes worthless.
const OPERATOR_A_ORPHAN = Object.freeze({ id: 'u_op_a_o', tenantId: TENANT_A, permissions: [STOCK_PREP_OPERATE] })
const INTEGRATION_READER_A = Object.freeze({ id: 'u_int_a', tenantId: TENANT_A, permissions: ['integration:read'] })
const WORKBENCH_ADMIN_A = Object.freeze({ id: 'u_wb_a', tenantId: TENANT_A, permissions: [STOCK_PREP_ADMIN] })
// TENANT-BOUND platform admin — has a tenant, so the value surface is legitimately theirs.
const TENANT_ADMIN_A = Object.freeze({ id: 'u_adm_a', tenantId: TENANT_A, roles: ['admin'], permissions: ['integration:admin'] })
// TENANTLESS platform admin — us / the consultant / support. G-04's subject.
const PLATFORM_ADMIN_TENANTLESS = Object.freeze({ id: 'u_adm_platform', roles: ['admin'], permissions: ['integration:admin'] })

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
    bridgeAgentChecklistStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForApply']),
  }
}

function projectRow(stagingProjectId, sheetId, recordId, fields) {
  const row = physicalRow(stagingProjectId, PROJECT_OBJECT_ID, fields, recordId)
  row.sheetId = sheetId
  return row
}

function decisionRow(stagingProjectId, sheetId, recordId, fields) {
  const row = physicalRow(stagingProjectId, DECISION_OBJECT_ID, fields, recordId)
  row.sheetId = sheetId
  return row
}

/**
 * A TWO-TENANT substrate. The shipped fixtures are scoped to one staging project each (a lookup with
 * any other projectId misses, mirroring the real provisioning scope), so the cross-tenant guard is
 * built by composing two of them behind a dispatcher — which is also the only way the guard can be
 * MEANINGFUL: tenant B's rows have to genuinely exist and be genuinely reachable by SOMEONE, or
 * "tenant A did not see them" proves nothing.
 */
function mount({
  ledgerProvisioned = true,
  directoryProvisioned = true,
  tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } },
  auditAppend,
} = {}) {
  const routes = new Map()

  const missingA = new Set()
  if (!ledgerProvisioned) missingA.add(DECISION_OBJECT_ID)
  if (!directoryProvisioned) missingA.add(PROJECT_OBJECT_ID)

  const provisioningA = makeFakeProvisioning({
    stagingProjectId: STAGING_A,
    sheetIdByObjectId: { [PROJECT_OBJECT_ID]: PROJECT_SHEET_A, [DECISION_OBJECT_ID]: LEDGER_SHEET_A },
    missing: missingA,
  })
  const provisioningB = makeFakeProvisioning({
    stagingProjectId: STAGING_B,
    sheetIdByObjectId: { [PROJECT_OBJECT_ID]: PROJECT_SHEET_B },
  })
  const recordsA = makeStrictRecordsApi({
    stagingProjectId: STAGING_A,
    objectIdBySheetId: { [PROJECT_SHEET_A]: PROJECT_OBJECT_ID, [LEDGER_SHEET_A]: DECISION_OBJECT_ID },
    rowsBySheet: {
      [PROJECT_SHEET_A]: [
        projectRow(STAGING_A, PROJECT_SHEET_A, 'rec_a1', {
          projectId: PROJECT_A_ID,
          sourceProjectNo: PROJECT_A_NO,
          projectName: PROJECT_A_NAME,
          projectStatus: 'active',
          lastSyncRunId: 'run_a1',
        }),
        projectRow(STAGING_A, PROJECT_SHEET_A, 'rec_a2', {
          projectId: PROJECT_A2_ID,
          sourceProjectNo: PROJECT_A2_NO,
          projectName: PROJECT_A2_NAME,
          projectStatus: 'active',
          lastSyncRunId: 'run_a2',
        }),
      ],
      [LEDGER_SHEET_A]: [
        // TWO pending rows on project A, so a count that silently collapsed to a boolean would show.
        decisionRow(STAGING_A, LEDGER_SHEET_A, 'rec_d1', {
          decisionId: 'decision_a_1',
          projectNo: PROJECT_A_NO,
          conflictType: FIRST_CUT_CONFLICT_TYPE,
          status: STATUSES.PENDING,
          inputFingerprint: 'sha16:0000000000000001',
        }),
        decisionRow(STAGING_A, LEDGER_SHEET_A, 'rec_d2', {
          decisionId: 'decision_a_2',
          projectNo: PROJECT_A_NO,
          conflictType: FIRST_CUT_CONFLICT_TYPE,
          status: STATUSES.PENDING,
          inputFingerprint: 'sha16:0000000000000002',
        }),
        // CONFIRMED, not pending — must not be counted as work waiting for the operator.
        decisionRow(STAGING_A, LEDGER_SHEET_A, 'rec_d3', {
          decisionId: 'decision_a_3',
          projectNo: PROJECT_A2_NO,
          conflictType: FIRST_CUT_CONFLICT_TYPE,
          status: STATUSES.CONFIRMED,
          inputFingerprint: 'sha16:0000000000000003',
        }),
      ],
    },
  })
  const recordsB = makeStrictRecordsApi({
    stagingProjectId: STAGING_B,
    objectIdBySheetId: { [PROJECT_SHEET_B]: PROJECT_OBJECT_ID },
    rowsBySheet: {
      [PROJECT_SHEET_B]: [
        projectRow(STAGING_B, PROJECT_SHEET_B, 'rec_b1', {
          projectId: 'stockprep_project_b1',
          sourceProjectNo: `NO-${SECRET_B}`,
          projectName: `名称-${SECRET_B}`,
          projectStatus: 'active',
          lastSyncRunId: 'run_b1',
        }),
      ],
    },
  })

  // Counted so "refused before any IO" is measured, not assumed.
  let hostCalls = 0
  function counted(target) {
    return new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver)
        if (typeof value !== 'function') return value
        return (...args) => {
          hostCalls += 1
          return value.apply(obj, args)
        }
      },
    })
  }

  const provisioning = counted({
    async findObjectSheet(input = {}) {
      const a = await provisioningA.findObjectSheet(input)
      return a || provisioningB.findObjectSheet(input)
    },
    async resolveFieldIds(input = {}) {
      return provisioningA.resolveFieldIds(input)
    },
    async ensureObject() {
      throw new Error('unexpected provisioning write: ensureObject')
    },
  })
  const records = counted({
    async queryRecords(input = {}) {
      const sheetId = input && input.sheetId
      if (sheetId === PROJECT_SHEET_B) return recordsB.queryRecords(input)
      return recordsA.queryRecords(input)
    },
    async createRecord() {
      throw new Error('unexpected records write: createRecord')
    },
    async patchRecord() {
      throw new Error('unexpected records write: patchRecord')
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
      multitable: { provisioning, records },
    },
    storage: new Map(),
    config: {},
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      auditAppends.push(entry)
      if (typeof auditAppend === 'function') return auditAppend(entry)
      return { ok: true }
    },
  }
  if (tenantPrincipalDirectory) services.tenantPrincipalDirectory = tenantPrincipalDirectory

  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, auditAppends, hostCallCount: () => hostCalls, recordsA, recordsB }
}

/**
 * A response fake that models EXPRESS'S ONE-WAY DOOR.
 *
 * `body` is the last thing written, which is what most assertions want. `sentBody` / `sent` record
 * the FIRST write and never change afterwards — because on a real response that first write has
 * already gone to the socket, and a later `sendError` cannot recall it.
 *
 * This distinction is load-bearing for G-06. A handler that sends the values and only then appends
 * the audit row leaks them for real; against a fake where the trailing error envelope overwrites
 * `body`, that leak is invisible and the guard would be vacuous.
 */
function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    sentBody: undefined,
    sent: false,
    sentStatus: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this },
    _write(body) {
      this.body = body
      if (!this.sent) {
        this.sent = true
        this.sentBody = body
        this.sentStatus = this.statusCode
      }
      return this
    },
    json(body) { return this._write(body) },
    setHeader(name, value) { this.headers[name] = value; return this },
    send(body) { return this._write(body) },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({
    user: req.user,
    authenticatedTenantId: req.authenticatedTenantId,
    body: req.body || {},
    query: req.query || {},
    params: req.params || {},
  }, res)
  return res
}

function errorCode(res) {
  return res.body && res.body.error && res.body.error.code
}

let failures = 0
const only = process.env.ONLY_TEST || ''
async function run(name, fn) {
  if (only && !name.includes(only)) return
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}\n    ${error && error.stack ? error.stack : error}`)
  }
}

async function main() {
  // -------------------------------------------------------------------------
  // G-01 CROSS-TENANT REFUSED — the single most important guard
  // -------------------------------------------------------------------------

  await run('G-01a an operator of tenant A cannot steer the read to tenant B', async () => {
    const { routes, hostCallCount } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: { tenantId: TENANT_B } })
    assert.equal(res.statusCode, 403)
    assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_MISMATCH')
    assert.equal(hostCallCount(), 0, 'a cross-tenant attempt must cost zero host work')
    assert.equal(JSON.stringify(res.body).includes(SECRET_B), false)
  })

  await run("G-01b tenant A's operator sees ONLY tenant A — tenant B's names appear in no byte", async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)
    const serialized = JSON.stringify(res.body)
    assert.equal(serialized.includes(SECRET_B), false, "tenant B's planted secret must never cross")
    assert.equal(res.body.data.tenantId, TENANT_A)
    const numbers = res.body.data.projects.map((project) => project.projectNo).sort()
    assert.deepEqual(numbers, [PROJECT_A_NO, PROJECT_A2_NO])
  })

  await run('G-01c tenant B IS reachable by its own operator — so G-01b measures scoping, not emptiness', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_B })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.tenantId, TENANT_B)
    assert.equal(JSON.stringify(res.body).includes(SECRET_B), true, "tenant B's own operator DOES see tenant B")
  })

  await run('G-01d the READ MODULE refuses a staging project outside its own scope (defence in depth)', async () => {
    // The route derives the staging locator from the verified scope, so this cannot be reached
    // through HTTP today. It is asserted at the module level anyway: the cross-tenant property then
    // belongs to the read itself rather than to the one caller that currently gets it right, and a
    // future second caller cannot lose it silently.
    const { listOperatorProjectDirectory, StockPreparationOperatorDirectoryError } =
      require(path.join(LIB, 'stock-preparation-operator-project-directory.cjs'))
    const { routes } = mount()
    void routes
    await assert.rejects(
      () => listOperatorProjectDirectory({
        recordsApi: { async queryRecords() { throw new Error('must not read') } },
        provisioning: { async findObjectSheet() { throw new Error('must not resolve') }, async resolveFieldIds() { return {} } },
        targetProjectId: STAGING_B,
        scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      }),
      (error) => error instanceof StockPreparationOperatorDirectoryError
        && error.code === 'OPERATOR_DIRECTORY_SCOPE_MISMATCH',
    )
  })

  await run('G-01e the read refuses outright when no scope was established', async () => {
    const { listOperatorProjectDirectory } = require(path.join(LIB, 'stock-preparation-operator-project-directory.cjs'))
    await assert.rejects(
      () => listOperatorProjectDirectory({
        recordsApi: { async queryRecords() { throw new Error('must not read') } },
        provisioning: { async findObjectSheet() { throw new Error('must not resolve') } },
        targetProjectId: STAGING_A,
      }),
      (error) => error.code === 'OPERATOR_DIRECTORY_SCOPE_REQUIRED',
    )
  })

  // -------------------------------------------------------------------------
  // G-02 THE PLATFORM VALUES-FREE ROUTE IS BYTE-IDENTICAL
  // -------------------------------------------------------------------------

  await run('G-02 the values-free /projects route still emits its exact projection and leaks nothing', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', VALUES_FREE_PROJECTS_PATH, { user: INTEGRATION_READER_A })
    assert.equal(res.statusCode, 200)
    const serialized = JSON.stringify(res.body)
    // The values planted in tenant A's OWN rows must not cross THIS route — the boundary is per-route,
    // and this is the route the platform/admin workspace consumes.
    assert.equal(serialized.includes(PROJECT_A_NAME), false, 'projectName must never cross the values-free route')
    assert.equal(serialized.includes(PROJECT_A_NO), false, 'sourceProjectNo must never cross the values-free route')
    assert.equal(serialized.includes('projectName'), false, 'the field NAME never crosses either')
    assert.equal(serialized.includes('sourceProjectNo'), false)
    // The projection, pinned key-for-key. A new key here is a widening of the platform contract.
    assert.deepEqual(Object.keys(res.body.data).sort(), ['projectCount', 'projects', 'statusCounts'])
    assert.deepEqual(Object.keys(res.body.data.projects[0]).sort(), [
      'heldLineCount',
      'lastSyncRunId',
      'openExceptionCount',
      'projectId',
      'projectStatus',
      'readyLineCount',
      'snapshotBatchCount',
    ])
  })

  await run('G-02b the values-free route keeps its own gate — a stock-prep operator is still refused there', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', VALUES_FREE_PROJECTS_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 403, 'stock-prep:operate confers no integration:read — R-11 zero-automatic')
  })

  // -------------------------------------------------------------------------
  // G-03 UNDER-PRIVILEGED REFUSED BEFORE ANY IO
  // -------------------------------------------------------------------------

  const UNDERPRIVILEGED = [
    ['anonymous', ANONYMOUS, 401, 'UNAUTHENTICATED'],
    ['integration:read', INTEGRATION_READER_A, 403, 'FORBIDDEN'],
    ['stock-prep:read only', OPERATOR_A_READ_ONLY, 403, 'FORBIDDEN'],
    ['operate WITHOUT read (degenerate)', OPERATOR_A_ORPHAN, 403, 'FORBIDDEN'],
  ]
  for (const [label, user, status, code] of UNDERPRIVILEGED) {
    await run(`G-03 ${label} is refused at the gate with zero host work`, async () => {
      const { routes, hostCallCount, auditAppends } = mount()
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user })
      assert.equal(res.statusCode, status)
      assert.equal(errorCode(res), code)
      assert.equal(hostCallCount(), 0, 'the gate must refuse before any provisioning/records call')
      assert.equal(auditAppends.length, 0, 'a refused read writes no audit row')
    })
  }

  await run('G-03b stock-prep:admin and a TENANT-BOUND platform admin are both served', async () => {
    for (const user of [WORKBENCH_ADMIN_A, TENANT_ADMIN_A]) {
      const { routes } = mount()
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user })
      assert.equal(res.statusCode, 200, `${user.id} holds the operator tier and has a tenant of its own`)
      assert.equal(res.body.data.tenantId, TENANT_A)
    }
  })

  // -------------------------------------------------------------------------
  // G-04 THE PLATFORM-SIDE REFUSAL
  // -------------------------------------------------------------------------

  await run('G-04 a TENANTLESS platform admin passes the permission gate and is then refused the values', async () => {
    const { routes, hostCallCount, auditAppends } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: PLATFORM_ADMIN_TENANTLESS })
    assert.equal(res.statusCode, 403)
    assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_REQUIRED')
    assert.equal(hostCallCount(), 0)
    assert.equal(auditAppends.length, 0)
    assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), false)
  })

  await run('G-04b ...and the SAME tenantless admin still reads the values-free route for any tenant', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', VALUES_FREE_PROJECTS_PATH, {
      user: PLATFORM_ADMIN_TENANTLESS,
      query: { tenantId: TENANT_A },
    })
    assert.equal(res.statusCode, 200, 'the platform side keeps exactly the reach it had — values-free')
    assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), false)
  })

  // -------------------------------------------------------------------------
  // G-05 AUDIT STAYS VALUES-FREE THOUGH THE RESPONSE DOES NOT
  // -------------------------------------------------------------------------

  await run('G-05 the response carries the values; no audit row carries any of them', async () => {
    const { routes, auditAppends } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)
    // The feature: the operator really does get the name.
    assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), true)
    assert.equal(auditAppends.length, 1)
    const serializedAudit = JSON.stringify(auditAppends)
    for (const value of [PROJECT_A_NAME, PROJECT_A_NO, PROJECT_A2_NAME, PROJECT_A2_NO]) {
      assert.equal(serializedAudit.includes(value), false, `audit must not carry ${value}`)
    }
    for (const key of ['projectNo', 'projectName', 'projects']) {
      assert.equal(serializedAudit.includes(key), false, `audit must not carry a ${key} key`)
    }
    const entry = auditAppends[0]
    assert.equal(entry.action, 'project_directory_read')
    assert.equal(entry.actor, OPERATOR_A.id)
    assert.equal(entry.tenantId, TENANT_A)
    assert.equal(entry.projectId, undefined, 'this read is not about one project — no projectNo on the trail')
    assert.deepEqual(Object.keys(entry.detail).sort(), [
      'directoryReady',
      'ledgerReady',
      'operation',
      'pendingProjectCount',
      'projectCount',
      'tenantClaimVerified',
    ])
  })

  await run('G-05b the audit action is a member of the store vocabulary (migration 082)', async () => {
    const store = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
    const actions = store.STOCK_PREP_AUDIT_ACTIONS || (store.__internals && store.__internals.STOCK_PREP_AUDIT_ACTIONS)
    if (actions) {
      assert.equal(actions.includes('project_directory_read'), true)
    }
    const fs = require('node:fs')
    const migration = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'packages', 'core-backend', 'migrations', '082_extend_stock_prep_audit_project_directory_read_action.sql'),
      'utf8',
    )
    assert.equal(migration.includes("'project_directory_read'"), true, 'the DB CHECK must admit the action the route writes')
  })

  // -------------------------------------------------------------------------
  // G-06 AUDIT-BEFORE-VALUES (H3-0 (3), fail-closed)
  // -------------------------------------------------------------------------

  await run('G-06 an audit store that refuses the row means no value-bearing body is sent', async () => {
    const { routes } = mount({
      auditAppend() {
        const error = new Error('audit store unavailable')
        error.status = 503
        error.code = 'AUDIT_STORE_UNAVAILABLE'
        throw error
      },
    })
    // The response object is held HERE, not returned by a helper, so the assertion can see what the
    // handler wrote even when the handler then throws. A witness that only inspects the helper's
    // return value is blind to exactly the regression this guard exists for — a handler that sends
    // the values first and appends the audit row afterwards.
    const handler = routes.get(`GET ${DIRECTORY_PATH}`)
    assert.ok(handler)
    const res = createResponse()
    await handler({ user: OPERATOR_A, body: {}, query: {}, params: {} }, res).catch(() => {})
    // Assert on what was FIRST written to the wire, not on what the response object ended up holding:
    // the registration wrapper turns the thrown audit error into an error envelope, and on a real
    // response that envelope arrives too late to unsend anything already flushed.
    const sent = JSON.stringify(res.sentBody === undefined ? null : res.sentBody)
    assert.equal(sent.includes(PROJECT_A_NAME), false, 'no value may reach the caller when the audit row did not land')
    assert.equal(sent.includes(PROJECT_A_NO), false)
    assert.equal(res.sentBody && res.sentBody.ok, false, 'the FIRST thing written must be the failure, not an ok payload')
    assert.ok(res.sentStatus >= 400, 'and it must fail with an error status')
  })

  // -------------------------------------------------------------------------
  // G-07 THE HOST MUST VOUCH
  // -------------------------------------------------------------------------

  await run('G-07a an absent host directory 501s — it does NOT fail open onto req.user.tenantId', async () => {
    const { routes, hostCallCount } = mount({ tenantPrincipalDirectory: null })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 501)
    assert.equal(errorCode(res), 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE')
    assert.equal(hostCallCount(), 0)
    assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), false)
  })

  await run('G-07b a member:false verdict refuses, before any records read', async () => {
    const { routes, hostCallCount } = mount({
      tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: false } } },
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 403)
    assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED')
    assert.equal(hostCallCount(), 0)
  })

  await run('G-07c a directory that throws is a refusal, never a pass', async () => {
    const { routes } = mount({
      tenantPrincipalDirectory: {
        async verifyTenantMembership() { throw new Error('boom') },
      },
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A }).catch(() => null)
    const serialized = res ? JSON.stringify(res.body) : ''
    assert.equal(serialized.includes(PROJECT_A_NAME), false)
  })

  // -------------------------------------------------------------------------
  // G-08 A HEADER TENANT CANNOT OVERRIDE A VERIFIED CLAIM
  // -------------------------------------------------------------------------

  await run('G-08a a carried tenant that contradicts the verified token claim is refused', async () => {
    const { routes, hostCallCount } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, {
      // The middleware shape: the token said tenant A, the user object says tenant B.
      user: OPERATOR_B,
      authenticatedTenantId: TENANT_A,
    })
    assert.equal(res.statusCode, 403)
    assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_CONTRADICTED')
    assert.equal(hostCallCount(), 0)
    assert.equal(JSON.stringify(res.body).includes(SECRET_B), false)
  })

  await run('G-08b the VERIFIED claim is what the read is scoped by, and it is reported as verified', async () => {
    const { routes, auditAppends } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, authenticatedTenantId: TENANT_A })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.tenantId, TENANT_A)
    assert.equal(auditAppends[0].detail.tenantClaimVerified, true)
  })

  await run('G-08c a header-only tenant is still served, but the audit records that no claim backed it', async () => {
    const { routes, auditAppends } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)
    assert.equal(auditAppends[0].detail.tenantClaimVerified, false, 'the host membership check is what made this safe')
  })

  // -------------------------------------------------------------------------
  // G-09 THE WORKLIST IS REAL
  // -------------------------------------------------------------------------

  await run('G-09 pendingDecisionCount joins the ledger on projectNo == sourceProjectNo', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    const byNo = new Map(res.body.data.projects.map((project) => [project.projectNo, project]))
    assert.equal(byNo.get(PROJECT_A_NO).pendingDecisionCount, 2, 'two PENDING ledger rows')
    assert.equal(byNo.get(PROJECT_A2_NO).pendingDecisionCount, 0, 'a CONFIRMED row is not pending work')
    assert.equal(byNo.get(PROJECT_A_NO).projectName, PROJECT_A_NAME)
    assert.equal(res.body.data.pendingProjectCount, 1)
    assert.equal(res.body.data.projectCount, 2)
  })

  await run('G-09b every project row carries the number AND the name — the whole point', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    for (const project of res.body.data.projects) {
      assert.equal(typeof project.projectNo, 'string')
      assert.equal(typeof project.projectName, 'string')
      assert.ok(project.projectName.length > 0)
    }
  })

  // -------------------------------------------------------------------------
  // G-10 EMPTY-STATE HONESTY
  // -------------------------------------------------------------------------

  await run('G-10a nothing synced yet -> directoryReady false, not an empty "all clear"', async () => {
    const { routes } = mount({ directoryProvisioned: false })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.directoryReady, false)
    assert.equal(res.body.data.projectCount, 0)
  })

  await run('G-10b no ledger yet -> ledgerReady false, and the directory still answers', async () => {
    const { routes } = mount({ ledgerProvisioned: false })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.ledgerReady, false)
    assert.equal(res.body.data.directoryReady, true)
    assert.equal(res.body.data.projectCount, 2, 'the operator can still find their project by name')
    assert.equal(res.body.data.pendingProjectCount, 0)
  })

  await run('G-10c both ready and genuinely nothing pending is a DIFFERENT state from the two above', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    const idle = res.body.data.projects.find((project) => project.projectNo === PROJECT_A2_NO)
    assert.equal(res.body.data.directoryReady, true)
    assert.equal(res.body.data.ledgerReady, true)
    assert.equal(idle.pendingDecisionCount, 0)
  })

  // -------------------------------------------------------------------------
  // manifest wiring
  // -------------------------------------------------------------------------

  await run('the new capability is a frozen manifest member on the OPERATE tier', async () => {
    const entry = STOCK_PREP_WORKBENCH_CAPABILITIES.find((row) => row.capability === 'confirmationQueue.projectDirectory')
    assert.ok(entry, 'a new operator-facing route MUST be in the manifest')
    assert.equal(entry.code, STOCK_PREP_OPERATE, 'value-bearing reads ride OPERATE, never the broad READ tier')
    assert.equal(entry.method, 'GET')
    assert.equal(entry.path, DIRECTORY_PATH)
    assert.equal(entry.control, 'stock-prep-operator-project-directory')
  })

  await run('the values-free /projects route is deliberately NOT in the workbench manifest', async () => {
    const entry = STOCK_PREP_WORKBENCH_CAPABILITIES.find((row) => row.path === VALUES_FREE_PROJECTS_PATH)
    assert.equal(entry, undefined, 'that route belongs to the platform workspace, not this workbench')
  })

  if (failures > 0) {
    console.error(`\n${failures} guard(s) FAILED`)
    process.exitCode = 1
  } else {
    console.log('\nall operator project directory guards passed')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
