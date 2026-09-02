'use strict'

// 项目备料页 — THE OPERATOR PROJECT BOARD READ, and the guards that make it safe to ship.
//
// The board is the FOURTH value-bearing stock-prep read, so it joins the list the operator-scope
// module's header names rather than inventing a fourth way to decide tenancy: it derives its tenant
// through `resolveOperatorValueScope`, and every refusal that scope can raise happens before any
// host IO.
//
// WHAT THIS SUITE PINS, and why each one is a guard rather than a coverage line:
//
//   B-01 the gate — operate ∧ read reaches it; read-only, orphan-operate, integration:* and
//        anonymous do not, and none of them costs a single host call.
//   B-02 THE TENANT BOUNDARY — tenant A's operator asking for tenant B's projectNo gets a 404 that
//        is BYTE-IDENTICAL to the 404 for a projectNo nobody has. A different status, a different
//        code, or a `details` field naming the project would turn this route into an existence
//        oracle across tenants, which is the whole reason the boundary exists.
//   B-03 the projection — the response key set is FROZEN here. The board answers with numbers,
//        names, counts, closed enums, timestamps and handles; a row value reaching it would be a
//        leak the type system cannot catch, so the key set is asserted literally.
//   B-04 the audit — appended BEFORE the values are sent (fail-closed), values-free in the same
//        sense migration 083 requires: project_id NULL, mode from a closed set, detail counts and
//        booleans only, and never the projectNo the caller asked about.
//   B-05 the deep-link handle — present ONLY when the fill table actually exists. A handle composed
//        from a hash alone would point the operator at a sheet that is not there.
//   B-06 the 404 costs the same audit row as a hit, and still leaks nothing.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_READ,
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
  STOCK_PREPARATION_PROJECT_BOARD_KEYS,
  STOCK_PREPARATION_PROJECT_BOARD_MODES,
} = require(path.join(LIB, 'stock-preparation-project-board.cjs'))
const { STOCK_PREP_AUDIT_ACTIONS } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const BOARD_PATH = '/api/integration/stock-preparation/projects/:projectNo/board'

const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const STAGING_A = `${TENANT_A}:integration-core`
const STAGING_B = `${TENANT_B}:integration-core`

const MAIN_OBJECT_ID = 'plm_stock_preparation_main'

const PROJECT_SHEET_A = 'sheet_project_a'
const PROJECT_SHEET_B = 'sheet_project_b'
const LEDGER_SHEET_A = 'sheet_ledger_a'
const MAIN_SHEET_A = 'sheet_main_a'

const PROJECT_A_NO = '230920006'
const PROJECT_A_NAME = 'RY2注射水缓冲罐部件'
const PROJECT_A_ID = 'stockprep_project_a1'

// Tenant B's project number is a string that appears NOWHERE in tenant A's fixture, so a single
// substring search over tenant A's response body proves the boundary rather than merely suggesting it.
const SECRET_B = 'ZZTENANTBSECRETZZ'
const PROJECT_B_NO = `NO-${SECRET_B}`

const UNKNOWN_PROJECT_NO = 'NO-SUCH-PROJECT-0000'

const ANONYMOUS = undefined
const OPERATOR_A = Object.freeze({ id: 'u_op_a', tenantId: TENANT_A, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const OPERATOR_B = Object.freeze({ id: 'u_op_b', tenantId: TENANT_B, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const OPERATOR_A_READ_ONLY = Object.freeze({ id: 'u_op_a_r', tenantId: TENANT_A, permissions: [STOCK_PREP_READ] })
const OPERATOR_A_ORPHAN = Object.freeze({ id: 'u_op_a_o', tenantId: TENANT_A, permissions: [STOCK_PREP_OPERATE] })
const INTEGRATION_READER_A = Object.freeze({ id: 'u_int_a', tenantId: TENANT_A, permissions: ['integration:read'] })
const INTEGRATION_WRITER_A = Object.freeze({ id: 'u_int_w_a', tenantId: TENANT_A, permissions: ['integration:write'] })
const WORKBENCH_ADMIN_A = Object.freeze({ id: 'u_wb_a', tenantId: TENANT_A, permissions: [STOCK_PREP_ADMIN] })
const PLATFORM_ADMIN_TENANTLESS = Object.freeze({ id: 'u_adm_platform', roles: ['admin'], permissions: ['integration:admin'] })

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

const EXPORT_AT = '2026-09-01T02:03:04.000Z'

function mount({
  mainTableProvisioned = true,
  tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } },
  auditAppend,
  auditEntries = [{ action: 'prep_line_export', createdAt: EXPORT_AT }],
  omitAuditList = false,
} = {}) {
  const routes = new Map()

  const provisioningA = makeFakeProvisioning({
    stagingProjectId: STAGING_A,
    sheetIdByObjectId: {
      [PROJECT_OBJECT_ID]: PROJECT_SHEET_A,
      [DECISION_OBJECT_ID]: LEDGER_SHEET_A,
      ...(mainTableProvisioned ? { [MAIN_OBJECT_ID]: MAIN_SHEET_A } : {}),
    },
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
      ],
      [LEDGER_SHEET_A]: [
        decisionRow(STAGING_A, LEDGER_SHEET_A, 'rec_d1', {
          decisionId: 'decision_a_1',
          projectNo: PROJECT_A_NO,
          conflictType: FIRST_CUT_CONFLICT_TYPE,
          status: STATUSES.PENDING,
          inputFingerprint: 'sha16:0000000000000001',
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
          sourceProjectNo: PROJECT_B_NO,
          projectName: `名称-${SECRET_B}`,
          projectStatus: 'active',
          lastSyncRunId: 'run_b1',
        }),
      ],
    },
  })

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
    getObjectViewId(projectId, objectId, viewId) {
      return `view_${projectId}_${objectId}_${viewId}`
    },
    async ensureObject() {
      throw new Error('unexpected provisioning write: ensureObject')
    },
    async ensureObjectDefaultView() {
      throw new Error('unexpected provisioning write: ensureObjectDefaultView')
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
  const auditListCalls = []
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
    ...(omitAuditList ? {} : {
      async list(input) {
        auditListCalls.push(input)
        return { rowCount: auditEntries.length, entries: auditEntries }
      },
    }),
  }
  if (tenantPrincipalDirectory) services.tenantPrincipalDirectory = tenantPrincipalDirectory

  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, auditAppends, auditListCalls, hostCallCount: () => hostCalls }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function callBoard(routes, { user, projectNo, query = {}, authenticatedTenantId } = {}) {
  const handler = routes.get(`GET ${BOARD_PATH}`)
  assert.ok(handler, `route GET ${BOARD_PATH} is registered`)
  const res = createResponse()
  const req = { user, body: {}, query, params: { projectNo } }
  if (authenticatedTenantId !== undefined) req.authenticatedTenantId = authenticatedTenantId
  await handler(req, res)
  assert.notEqual(res.body, undefined, 'the board route produced a body')
  return res
}

function errorOf(res) {
  return res.body && res.body.error ? res.body.error : null
}

// ---------------------------------------------------------------------------
// B-01 — THE GATE
// ---------------------------------------------------------------------------

async function onlyTheOperatorTierReachesTheBoard() {
  {
    const { routes } = mount()
    const res = await callBoard(routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200, `B-01: operate ∧ read reads the board, got ${JSON.stringify(res.body)}`)
    assert.equal(res.body.ok, true)
  }

  const refused = [
    { name: 'anonymous', user: ANONYMOUS, status: 401 },
    { name: 'read-only operator', user: OPERATOR_A_READ_ONLY, status: 403 },
    { name: 'orphan operate', user: OPERATOR_A_ORPHAN, status: 403 },
    { name: 'integration:read', user: INTEGRATION_READER_A, status: 403 },
    { name: 'integration:write', user: INTEGRATION_WRITER_A, status: 403 },
  ]
  for (const actor of refused) {
    const harness = mount()
    const res = await callBoard(harness.routes, { user: actor.user, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, actor.status, `B-01: ${actor.name} is refused the board`)
    assert.equal(harness.hostCallCount(), 0, `B-01: ${actor.name} reaches no host API`)
    assert.deepEqual(harness.auditAppends, [], `B-01: ${actor.name} writes no audit row`)
  }

  // The workbench admin satisfies operate through the ladder, so it reads — the same answer the
  // directory route gives it, kept identical here so the two operator surfaces never disagree.
  {
    const { routes } = mount()
    const res = await callBoard(routes, { user: WORKBENCH_ADMIN_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200, 'B-01: the workbench admin reads the board')
  }

  // THE PLATFORM SIDE. A tenantless platform admin passes the RBAC ladder and is then refused for
  // having no tenant of its own — the values-free surfaces are untouched and still answer for them.
  {
    const harness = mount()
    const res = await callBoard(harness.routes, { user: PLATFORM_ADMIN_TENANTLESS, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 403, 'B-01: a tenantless platform admin gets no values here')
    assert.equal(errorOf(res).code, 'OPERATOR_SCOPE_TENANT_REQUIRED')
    assert.equal(harness.hostCallCount(), 0, 'B-01: and costs no host work doing it')
  }

  // The host cannot vouch for principals -> 501, fail closed, before any IO.
  {
    const harness = mount({ tenantPrincipalDirectory: null })
    const res = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 501, 'B-01: no membership seam means no value-bearing answer')
    assert.equal(errorOf(res).code, 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE')
    assert.equal(harness.hostCallCount(), 0)
  }

  // The host says this principal is not in the tenant it claims -> 403, before any IO.
  {
    const harness = mount({ tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: false } } } })
    const res = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 403, 'B-01: a non-member of its own claimed tenant is refused')
    assert.equal(errorOf(res).code, 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED')
    assert.equal(harness.hostCallCount(), 0)
  }
}

// ---------------------------------------------------------------------------
// B-02 — THE TENANT BOUNDARY, AND THE ABSENCE OF AN EXISTENCE ORACLE
// ---------------------------------------------------------------------------

async function anotherTenantsProjectIsIndistinguishableFromNoProject() {
  const crossTenant = await callBoard(mount().routes, { user: OPERATOR_A, projectNo: PROJECT_B_NO })
  const unknown = await callBoard(mount().routes, { user: OPERATOR_A, projectNo: UNKNOWN_PROJECT_NO })

  assert.equal(crossTenant.statusCode, 404, 'B-02: tenant B\'s project is NOT FOUND for tenant A')
  assert.equal(unknown.statusCode, 404, 'B-02: a project nobody has is NOT FOUND')
  assert.deepEqual(
    crossTenant.body,
    unknown.body,
    'B-02: the two 404 bodies must be BYTE-IDENTICAL — anything else is an existence oracle across tenants',
  )
  assert.equal(errorOf(crossTenant).code, 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND')
  assert.ok(
    !JSON.stringify(crossTenant.body).includes(SECRET_B),
    'B-02: the refusal never echoes tenant B\'s value back',
  )

  // Tenant B's own operator reads tenant B's project — the boundary is per-caller, not a blocklist.
  {
    const res = await callBoard(mount().routes, { user: OPERATOR_B, projectNo: PROJECT_B_NO })
    assert.equal(res.statusCode, 200, 'B-02: tenant B\'s operator reads tenant B\'s own project')
    assert.equal(res.body.data.projectNo, PROJECT_B_NO)
    assert.equal(res.body.data.tenantId, TENANT_B)
  }

  // Steering: a request that carries ANOTHER tenant is refused outright, never resolved toward it.
  {
    const harness = mount()
    const res = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO, query: { tenantId: TENANT_B } })
    assert.equal(res.statusCode, 403, 'B-02: a request-carried foreign tenant is refused')
    assert.equal(errorOf(res).code, 'OPERATOR_SCOPE_TENANT_MISMATCH')
    assert.equal(harness.hostCallCount(), 0, 'B-02: and costs no host work')
  }

  // A header tenant that contradicts the VERIFIED token claim is refused rather than resolved.
  {
    const harness = mount()
    const res = await callBoard(harness.routes, {
      user: OPERATOR_A,
      projectNo: PROJECT_A_NO,
      authenticatedTenantId: TENANT_B,
    })
    assert.equal(res.statusCode, 403, 'B-02: a carried tenant contradicting the verified claim is refused')
    assert.equal(errorOf(res).code, 'OPERATOR_SCOPE_TENANT_CONTRADICTED')
    assert.equal(harness.hostCallCount(), 0)
  }
}

// ---------------------------------------------------------------------------
// B-03 — THE FROZEN PROJECTION
// ---------------------------------------------------------------------------

async function theBoardAnswersWithHandlesCountsAndTheProjectsOwnNameOnly() {
  const res = await callBoard(mount().routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
  assert.equal(res.statusCode, 200)
  const board = res.body.data

  assert.deepEqual(
    Object.keys(board).sort(),
    [...STOCK_PREPARATION_PROJECT_BOARD_KEYS].sort(),
    'B-03: the board key set is FROZEN — a new key is a deliberate act, never a spread',
  )

  assert.equal(board.tenantId, TENANT_A)
  assert.equal(board.projectNo, PROJECT_A_NO)
  assert.equal(board.projectName, PROJECT_A_NAME)
  assert.equal(board.projectId, PROJECT_A_ID)
  assert.equal(board.projectStatus, 'active')
  assert.equal(board.lastSyncRunId, 'run_a1')
  assert.equal(typeof board.snapshotBatchCount, 'number')
  assert.equal(typeof board.openExceptionCount, 'number')
  assert.equal(typeof board.heldLineCount, 'number')
  assert.equal(typeof board.readyLineCount, 'number')
  assert.equal(board.pendingDecisionCount, 1, 'B-03: the one pending decision on this project is counted')
  assert.equal(board.lastExportAt, EXPORT_AT, 'B-03: the last export timestamp comes from the values-free audit trail')
  assert.equal(board.directoryReady, true)
  assert.equal(board.ledgerReady, true)

  // NO ROW VALUES. The board must never carry a materials array, a row list, or a per-line payload —
  // filling stays in the multitable grid and this page is a status bar, not a second grid.
  for (const forbidden of ['rows', 'lines', 'prepLines', 'materials', 'records', 'projects', 'decisions']) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(board, forbidden),
      `B-03: the board must not carry a ${forbidden} payload`,
    )
  }
}

// ---------------------------------------------------------------------------
// B-04 / B-06 — THE AUDIT
// ---------------------------------------------------------------------------

async function theAuditRowIsValuesFreeAndPrecedesTheValues() {
  {
    const harness = mount()
    await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(harness.auditAppends.length, 1, 'B-04: exactly one audit row per board read')
    const entry = harness.auditAppends[0]
    assert.equal(entry.action, 'project_board_read')
    assert.ok(STOCK_PREP_AUDIT_ACTIONS.includes('project_board_read'), 'B-04: the action is in the closed vocabulary')
    assert.equal(entry.tenantId, TENANT_A)
    assert.equal(entry.actor, OPERATOR_A.id)
    assert.ok(
      STOCK_PREPARATION_PROJECT_BOARD_MODES.includes(entry.mode),
      `B-04: mode must come from the closed set, got ${entry.mode}`,
    )
    // project_id stays NULL: writing the projectNo here would put a customer business value on the
    // trail, which is exactly what migration 082 forbade for the sibling directory read.
    assert.ok(entry.projectId === undefined || entry.projectId === null, 'B-04: project_id stays NULL')

    const serialized = JSON.stringify(entry)
    assert.ok(!serialized.includes(PROJECT_A_NO), 'B-04: the audit row never carries the projectNo')
    assert.ok(!serialized.includes(PROJECT_A_NAME), 'B-04: the audit row never carries the projectName')

    for (const [key, value] of Object.entries(entry.detail || {})) {
      assert.ok(
        typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string',
        `B-04: detail.${key} must be a values-free scalar`,
      )
    }
    assert.equal(entry.detail.operation, 'operator_project_board')
  }

  // FAIL-CLOSED: an audit store that refuses the row means no value-bearing body is ever sent.
  {
    const harness = mount({
      auditAppend() {
        throw new Error('audit refused')
      },
    })
    let threw = false
    try {
      await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    } catch (error) {
      threw = true
    }
    assert.ok(threw, 'B-04: a refusing audit store blocks the response rather than being swallowed')
  }

  // B-06: the 404 is audited too, with the same values-free shape and a mode of its own.
  {
    const harness = mount()
    const res = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: UNKNOWN_PROJECT_NO })
    assert.equal(res.statusCode, 404)
    assert.equal(harness.auditAppends.length, 1, 'B-06: a miss is audited')
    const entry = harness.auditAppends[0]
    assert.equal(entry.action, 'project_board_read')
    assert.ok(STOCK_PREPARATION_PROJECT_BOARD_MODES.includes(entry.mode))
    assert.ok(!JSON.stringify(entry).includes(UNKNOWN_PROJECT_NO), 'B-06: the miss row never carries the asked-for number')
  }
}

// ---------------------------------------------------------------------------
// B-05 — THE DEEP-LINK HANDLE
// ---------------------------------------------------------------------------

async function theDeepLinkHandleAppearsOnlyWhenTheFillTableExists() {
  {
    const res = await callBoard(mount({ mainTableProvisioned: true }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    const target = res.body.data.fillTarget
    assert.ok(target, 'B-05: a provisioned fill table yields a handle')
    assert.deepEqual(Object.keys(target).sort(), ['sheetId', 'viewId'], 'B-05: the handle is exactly sheetId + viewId')
    assert.equal(target.sheetId, MAIN_SHEET_A)
    assert.equal(typeof target.viewId, 'string')
    assert.ok(target.viewId.length > 0)
  }
  {
    const res = await callBoard(mount({ mainTableProvisioned: false }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200, 'B-05: an unprovisioned fill table is not an error — the rest of the board still answers')
    assert.equal(res.body.data.fillTarget, null, 'B-05: no bound target, no handle — never a hash pointing at nothing')
  }
}

// ---------------------------------------------------------------------------
// the last-export read degrades rather than failing
// ---------------------------------------------------------------------------

async function anAuditStoreWithoutListStillAnswersTheBoard() {
  const res = await callBoard(mount({ omitAuditList: true }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
  assert.equal(res.statusCode, 200, 'a store without list() is a degraded read, not a failed one')
  assert.equal(res.body.data.lastExportAt, null)
}

async function main() {
  await onlyTheOperatorTierReachesTheBoard()
  await anotherTenantsProjectIsIndistinguishableFromNoProject()
  await theBoardAnswersWithHandlesCountsAndTheProjectsOwnNameOnly()
  await theAuditRowIsValuesFreeAndPrecedesTheValues()
  await theDeepLinkHandleAppearsOnlyWhenTheFillTableExists()
  await anAuditStoreWithoutListStillAnswersTheBoard()
  console.log('✓ stock-preparation-project-board')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
