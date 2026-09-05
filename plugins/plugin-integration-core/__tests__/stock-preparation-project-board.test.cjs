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
//   B-05 the deep-link handle — built from the BOUND table-action target (the sheet apply really
//        writes to), handed out ONLY when that sheet exists AND equals the id the caller's own
//        provisioning computes. `action.target` is deploy-time config shared by every tenant, so it
//        is the one input here that could name a sheet outside the caller's staging project; the
//        equality check is what keeps the fill link inside the tenant boundary.
//   B-06 the 404 costs the same audit row as a hit, and still leaks nothing.

const assert = require('node:assert/strict')
const fs = require('node:fs')
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
  BATCH_OBJECT_ID,
  EXCEPTION_OBJECT_ID,
  PREP_LINE_OBJECT_ID,
} = require(path.join(LIB, 'stock-preparation-project-reads.cjs'))
const {
  STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID,
  STOCK_PREPARATION_PROJECT_BOARD_KEYS,
  STOCK_PREPARATION_PROJECT_BOARD_MODES,
  readOperatorProjectBoard,
  __internals: BOARD_INTERNALS,
} = require(path.join(LIB, 'stock-preparation-project-board.cjs'))
const { STOCK_PREP_AUDIT_ACTIONS } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const {
  __internals: PREP_LINE_EXPORT_INTERNALS,
} = require(path.join(LIB, 'stock-preparation-prep-line-export.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
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
// The three MVP snapshot sheets the ARCHIVED numbers are read out of. They are provisioned in this
// fixture so the per-project loop over them is real work a cost assertion can measure (B-08) — and so
// the board's snapshot numbers can be told apart from the numbers the operator's own pull produces
// (B-11), which is the confusion that made a successful pull look like nothing happened.
const BATCH_SHEET_A = 'sheet_batch_a'
const EXCEPTION_SHEET_A = 'sheet_exception_a'
const PREP_LINE_SHEET_A = 'sheet_prep_line_a'
// The BOUND table-action target's sheet under tenant A's own staging project — the sheet `apply`
// writes and the export reads. Its id must be the one the CALLER'S OWN provisioning computes, which
// is the tenant gate both the fill handle and the pull-target row facts ride.
const MAIN_SHEET_A = `sheet__${STAGING_A}__${MAIN_OBJECT_ID}`
/**
 * The bound target's own logical -> physical field map, exactly as a deployment configures it. Only
 * the two SCOPE columns matter to the board (`projectNo` to filter, `active` to split), which is the
 * same pair the export declares as REQUIRED_EXPORT_FIELD_IDS — the board deliberately needs no more.
 */
const MAIN_FIELD_ID_MAP = Object.freeze({
  projectNo: physicalFieldId(STAGING_A, MAIN_OBJECT_ID, 'projectNo'),
  active: physicalFieldId(STAGING_A, MAIN_OBJECT_ID, 'active'),
})


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

function mvpRow(stagingProjectId, objectId, sheetId, recordId, fields) {
  const row = physicalRow(stagingProjectId, objectId, fields, recordId)
  row.sheetId = sheetId
  return row
}

const EXPORT_AT = '2026-09-01T02:03:04.000Z'

/**
 * The deterministic sheet id the CALLER'S OWN provisioning computes for the fill table. The bound
 * table-action target must name exactly this for a handle to be handed out — see `resolveFillTarget`.
 */
function ownSheetIdFor(stagingProjectId, objectId) {
  return `sheet__${stagingProjectId}__${objectId}`
}

function mount({
  mainTableProvisioned = true,
  // `undefined` = the action is bound to the caller's own canonical fill table (the normal case).
  // `null` = nothing is bound at all. An object = whatever the deployment configured, verbatim.
  boundTarget,
  actionConfigured = true,
  tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } },
  auditAppend,
  // B-13 — THE AUDIT VOCABULARY PROBE. `undefined` models a store that has no `supportsAction` at
  // all (the guard returns at its first line, fail-open), which is what every other case here wants.
  // A function makes the store probe-capable and records each probe.
  auditSupportsAction,
  auditEntries = [{ action: 'prep_line_export', createdAt: EXPORT_AT }],
  omitAuditList = false,
  // How many OTHER projects tenant A's directory holds besides the one under test. The board is
  // about ONE project, so its cost must not move when this does — see B-08.
  extraProjects = 0,
  // THE ROWS THE PULL ITSELF WROTE, in the bound table-action target — the sheet `apply` writes and
  // the export reads. `{ projectNo, active }` per row. This is the operator's own evidence and the
  // ONLY store their pull touches: mvp-persist, which fills the archive below, stayed platform-admin.
  mainTableRows = [
    { projectNo: PROJECT_A_NO },
    { projectNo: PROJECT_A_NO },
    { projectNo: PROJECT_A_NO, active: false },
  ],
  // THE ADMINISTRATOR'S ARCHIVE. `false` models the flow this page exists for: a floor operator ran
  // the pull themselves, so no MVP snapshot row exists for their project at all.
  archivePersisted = true,
  // WHAT THE PROVISIONING REGISTRY SAYS OWNS THE BOUND SHEET. A map of sheetId -> owning projectId,
  // which is what the host port answers from. `null` models a host too old to have the port at all;
  // `undefined` derives the honest default — the registry knows a sheet exactly when provisioning
  // created it, so an UNPROVISIONED main table is unclaimed there too.
  sheetOwners,
  // Which sheet id the main table actually LIVES on. Defaults to the deterministic one; a scenario
  // that models a hand-bound sheet moves it, which is the only way to model a sheet whose id does
  // not hash from the caller's own project.
  mainSheetIdOverride = null,
} = {}) {
  const routes = new Map()
  const MAIN_SHEET = mainSheetIdOverride || MAIN_SHEET_A
  const owners = sheetOwners === undefined
    ? (mainTableProvisioned ? { [MAIN_SHEET]: STAGING_A } : {})
    : sheetOwners

  const provisioningA = makeFakeProvisioning({
    stagingProjectId: STAGING_A,
    sheetIdByObjectId: {
      [PROJECT_OBJECT_ID]: PROJECT_SHEET_A,
      [DECISION_OBJECT_ID]: LEDGER_SHEET_A,
      [BATCH_OBJECT_ID]: BATCH_SHEET_A,
      [EXCEPTION_OBJECT_ID]: EXCEPTION_SHEET_A,
      [PREP_LINE_OBJECT_ID]: PREP_LINE_SHEET_A,
      ...(mainTableProvisioned ? { [MAIN_OBJECT_ID]: MAIN_SHEET } : {}),
    },
  })
  const provisioningB = makeFakeProvisioning({
    stagingProjectId: STAGING_B,
    sheetIdByObjectId: { [PROJECT_OBJECT_ID]: PROJECT_SHEET_B },
  })
  const recordsA = makeStrictRecordsApi({
    stagingProjectId: STAGING_A,
    objectIdBySheetId: {
      [PROJECT_SHEET_A]: PROJECT_OBJECT_ID,
      [LEDGER_SHEET_A]: DECISION_OBJECT_ID,
      [BATCH_SHEET_A]: BATCH_OBJECT_ID,
      [EXCEPTION_SHEET_A]: EXCEPTION_OBJECT_ID,
      [PREP_LINE_SHEET_A]: PREP_LINE_OBJECT_ID,
      [MAIN_SHEET]: MAIN_OBJECT_ID,
    },
    rowsBySheet: {
      // WHAT THE PULL ITSELF WROTE. The bound table-action target — the sheet `apply` writes and the
      // export reads. This is the only store an operator's own four-step run touches.
      [MAIN_SHEET]: mainTableRows.map((row, index) => mvpRow(
        STAGING_A,
        MAIN_OBJECT_ID,
        MAIN_SHEET,
        `rec_main_a${index}`,
        {
          projectNo: row.projectNo,
          idempotencyKey: `idem_${index}`,
          componentSourceId: `comp_${index}`,
          path: `/${index}`,
          totalQuantity: 1,
          active: row.active !== false,
          // Only present when a scenario asks for it (lastPulledAt fixtures) — omitted otherwise, so
          // every row shape that predates this key is unaffected.
          ...(row.lastPlmRefreshAt !== undefined ? { lastPlmRefreshAt: row.lastPlmRefreshAt } : {}),
        },
      )),
      // THE ADMINISTRATOR'S ARCHIVED SNAPSHOT for this project — one persisted batch, one open
      // exception, two prep lines (one held, one ready). These come from the mvp-persist path, which
      // is platform-admin, so on an operator's own pull they stay EMPTY; the fixture keeps them
      // populated precisely so the two number families can be told apart.
      [BATCH_SHEET_A]: archivePersisted ? [
        mvpRow(STAGING_A, BATCH_OBJECT_ID, BATCH_SHEET_A, 'rec_batch_a1', {
          snapshotBatchId: 'batch_a1',
          projectId: PROJECT_A_ID,
          snapshotStatus: 'active',
        }),
      ] : [],
      [EXCEPTION_SHEET_A]: archivePersisted ? [
        mvpRow(STAGING_A, EXCEPTION_OBJECT_ID, EXCEPTION_SHEET_A, 'rec_exc_a1', {
          exceptionId: 'exc_a1',
          projectId: PROJECT_A_ID,
          exceptionType: 'missing_mapping',
          status: 'open',
        }),
      ] : [],
      [PREP_LINE_SHEET_A]: archivePersisted ? [
        mvpRow(STAGING_A, PREP_LINE_OBJECT_ID, PREP_LINE_SHEET_A, 'rec_line_a1', {
          stockPrepLineId: 'line_a1',
          projectId: PROJECT_A_ID,
          prepStatus: 'held',
        }),
        mvpRow(STAGING_A, PREP_LINE_OBJECT_ID, PREP_LINE_SHEET_A, 'rec_line_a2', {
          stockPrepLineId: 'line_a2',
          projectId: PROJECT_A_ID,
          prepStatus: 'ready',
        }),
      ] : [],
      [PROJECT_SHEET_A]: [
        ...(archivePersisted ? [projectRow(STAGING_A, PROJECT_SHEET_A, 'rec_a1', {
          projectId: PROJECT_A_ID,
          sourceProjectNo: PROJECT_A_NO,
          projectName: PROJECT_A_NAME,
          projectStatus: 'active',
          lastSyncRunId: 'run_a1',
        })] : []),
        ...Array.from({ length: extraProjects }, (_unused, index) => projectRow(
          STAGING_A,
          PROJECT_SHEET_A,
          `rec_a_extra_${index}`,
          {
            projectId: `stockprep_project_extra_${index}`,
            sourceProjectNo: `EXTRA-${index}`,
            projectName: `其他项目 ${index}`,
            projectStatus: 'active',
            lastSyncRunId: `run_extra_${index}`,
          },
        )),
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
    // The host's two PURE id derivations. `getObjectSheetId` is what the tenant guard on the fill
    // handle compares the bound target against; `getObjectViewId` is what composes the deep link.
    getObjectSheetId(projectId, objectId) {
      return ownSheetIdFor(projectId, objectId)
    },
    getObjectViewId(projectId, objectId, viewId) {
      return `view_${projectId}_${objectId}_${viewId}`
    },
    // The host's OWNERSHIP question — a BOOLEAN about the project we name, so no other tenant's
    // project id is ever returned to this plugin.
    ...(owners === null ? {} : {
      async isSheetOwnedByProject(sheetId, projectId) {
        return (owners[sheetId] ?? null) === projectId
      },
    }),
    async ensureObject() {
      throw new Error('unexpected provisioning write: ensureObject')
    },
    async ensureObjectDefaultView() {
      throw new Error('unexpected provisioning write: ensureObjectDefaultView')
    },
  })
  let queryCalls = 0
  const queryLog = []
  const records = counted({
    async queryRecords(input = {}) {
      queryCalls += 1
      const sheetId = input && input.sheetId
      queryLog.push({ sheetId, filters: { ...(input && input.filters) } })
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
  const auditProbes = []
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
    // The deploy-time table-action config the registry is built from. `target.sheetId` is what the
    // fill handle is derived from, and the tenant guard compares it against the caller's own
    // deterministic sheet id.
    config: actionConfigured
      ? {
          stockPreparationTableActions: [{
            actionId: 'plm.stock-preparation.pull-bom.v1',
            source: { kind: 'data-source:sql-readonly', externalSystemId: 'ext_demo' },
            target: boundTarget === undefined
              ? {
                  sheetId: ownSheetIdFor(STAGING_A, MAIN_OBJECT_ID),
                  objectId: MAIN_OBJECT_ID,
                  // THE EXPLICIT MODE, which is what a real deployment configures: logical id ->
                  // the PHYSICAL fieldId provisioning materialized. The strict records fake rejects
                  // a logical key exactly as the real service does, so a target without this map is
                  // a target the export cannot read either — see the fixture's own header.
                  fieldIdMap: MAIN_FIELD_ID_MAP,
                }
              : boundTarget,
          }],
        }
      : {},
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
    ...(typeof auditSupportsAction === 'function' ? {
      async supportsAction(action, options = {}) {
        auditProbes.push({ action, tenantId: (options && options.tenantId) || null, at: auditAppends.length })
        return auditSupportsAction(action, options)
      },
    } : {}),
  }
  if (tenantPrincipalDirectory) services.tenantPrincipalDirectory = tenantPrincipalDirectory

  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return {
    routes,
    auditAppends,
    auditListCalls,
    auditProbes,
    hostCallCount: () => hostCalls,
    queryCallCount: () => queryCalls,
    queryLog,
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
  assert.equal(
    board.lastPulledAt,
    null,
    'B-03: the fixture\'s bound target does not bind lastPlmRefreshAt, so lastPulledAt degrades to null',
  )
  assert.equal(board.lastPulledAtBounded, false, 'B-03: an ordinary, unbounded scan is not truncated')
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
    const res = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.notEqual(res.body.ok, true, 'B-04: a refusing audit store blocks the response rather than being swallowed')
    assert.ok(res.statusCode >= 400, `B-04: the refusal surfaces as an error status, got ${res.statusCode}`)
    assert.ok(
      !JSON.stringify(res.body).includes(PROJECT_A_NAME),
      'B-04: and the blocked response carries no value either',
    )
  }

  // B-07: THE CALLER'S OWN QUERY STRING IS NOT A WAY ONTO THE TRAIL.
  //
  // `?workspaceId` used to be forwarded verbatim into the audit row's `workspace_id`, which made the
  // "the row never carries the projectNo" claim depend on the caller not putting it there: send
  // `?workspaceId=230920006` and the number was on the trail, in a column no gate looked at. The
  // board route now selects nothing from it at all (the key stays in the allowlist for shape
  // compatibility with the rest of this family, exactly like `tenantId`, and steers nothing), and
  // the store gates the column besides. Asserted on BOTH branches, because a miss writes a row too.
  for (const [label, askedFor] of [['hit', PROJECT_A_NO], ['miss', UNKNOWN_PROJECT_NO]]) {
    const harness = mount()
    await callBoard(harness.routes, {
      user: OPERATOR_A,
      projectNo: askedFor,
      query: { workspaceId: PROJECT_A_NO },
    })
    assert.equal(harness.auditAppends.length, 1, `B-07 (${label}): one row`)
    assert.ok(
      !JSON.stringify(harness.auditAppends[0]).includes(PROJECT_A_NO),
      `B-07 (${label}): a caller-supplied ?workspaceId must not put a business value on the audit row`,
    )
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
    assert.ok(target, 'B-05: a bound, provisioned fill table yields a handle')
    assert.deepEqual(Object.keys(target).sort(), ['sheetId', 'viewId'], 'B-05: the handle is exactly sheetId + viewId')
    assert.equal(target.sheetId, ownSheetIdFor(STAGING_A, MAIN_OBJECT_ID), 'B-05: and it names the BOUND target sheet')
    assert.equal(typeof target.viewId, 'string')
    assert.ok(target.viewId.length > 0)
  }
  {
    const res = await callBoard(mount({ mainTableProvisioned: false }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200, 'B-05: an unprovisioned fill table is not an error — the rest of the board still answers')
    assert.equal(res.body.data.fillTarget, null, 'B-05: the sheet does not exist, so there is no handle')
  }
  {
    const res = await callBoard(mount({ actionConfigured: false }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200, 'B-05: an unconfigured table action is a deployment state, not a board failure')
    assert.equal(res.body.data.fillTarget, null, 'B-05: nothing bound, no handle')
  }
  // THE TENANT GUARD ON THE HANDLE. `action.target` is deploy-time config shared by every tenant, so
  // it is the one input on this route that could name a sheet outside the caller's own staging
  // project. A bound target that does not equal the id the CALLER'S OWN provisioning computes is
  // never handed out — this is the assertion that keeps the fill link inside the tenant boundary.
  {
    const foreign = { sheetId: ownSheetIdFor(STAGING_B, MAIN_OBJECT_ID), objectId: MAIN_OBJECT_ID }
    const res = await callBoard(mount({ boundTarget: foreign }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.fillTarget, null, 'B-05: a bound target outside the caller\'s own tenant yields NO handle')
    assert.ok(
      !JSON.stringify(res.body).includes(STAGING_B),
      'B-05: and the refusal never echoes the foreign sheet id back',
    )
  }
  {
    const elsewhere = { sheetId: 'sheet_some_other_deployment_table', objectId: MAIN_OBJECT_ID }
    const res = await callBoard(mount({ boundTarget: elsewhere }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.body.data.fillTarget, null, 'B-05: an unrecognised bound sheet yields no handle either')
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

// ---------------------------------------------------------------------------
// lastPulledAt — the max lastPlmRefreshAt seen in the SAME pull-target scan
// ---------------------------------------------------------------------------
//
// Answers 「上次从 PLM 拉过是什么时候」 for the flow readPullTargetRowFacts already exists for: an
// operator's own pull, which mvp-persist never touches. No second read, no new write — the max is
// taken across the same rows the pull-target row count already scans.
async function theBoardReportsLastPulledAtFromTheBoundLastPlmRefreshColumn() {
  const OLDER = '2026-08-30T01:00:00.000Z'
  const NEWEST = '2026-09-02T03:04:05.000Z'
  const MIDDLE = '2026-09-01T00:00:00.000Z'
  const withLastPlmRefreshBinding = {
    sheetId: ownSheetIdFor(STAGING_A, MAIN_OBJECT_ID),
    objectId: MAIN_OBJECT_ID,
    fieldIdMap: {
      ...MAIN_FIELD_ID_MAP,
      lastPlmRefreshAt: physicalFieldId(STAGING_A, MAIN_OBJECT_ID, 'lastPlmRefreshAt'),
    },
  }

  // 1. THE ORDINARY CASE: the bound target binds lastPlmRefreshAt, rows carry different stamps ->
  //    the board reports the MAX, not the last row read or the first.
  {
    const res = await callBoard(mount({
      boundTarget: withLastPlmRefreshBinding,
      mainTableRows: [
        { projectNo: PROJECT_A_NO, lastPlmRefreshAt: OLDER },
        { projectNo: PROJECT_A_NO, lastPlmRefreshAt: NEWEST },
        { projectNo: PROJECT_A_NO, lastPlmRefreshAt: MIDDLE, active: false },
      ],
    }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.lastPulledAt, NEWEST, 'lastPulledAt is the MAX lastPlmRefreshAt across this project\'s rows')
  }

  // 2. THE FIELD IS UNBOUND (the default fixture's fieldIdMap, matching REQUIRED_EXPORT_FIELD_IDS's
  //    scope-only pair): degrades to null, and — the part that matters — the rest of the pull-target
  //    facts are UNAFFECTED. lastPlmRefreshAt must never behave like a missing SCOPE binding, which
  //    turns the whole target PULL_TARGET_NOT_READY.
  {
    const res = await callBoard(mount({
      mainTableRows: [
        { projectNo: PROJECT_A_NO, lastPlmRefreshAt: NEWEST },
        { projectNo: PROJECT_A_NO, lastPlmRefreshAt: OLDER },
      ],
    }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.pullTargetReady, true, 'an unbound lastPlmRefreshAt does not block readiness')
    assert.equal(res.body.data.pulledRowCount, 2)
    assert.equal(res.body.data.lastPulledAt, null, 'an unbound column can never be read, so lastPulledAt stays null')
  }

  // 3. THE FIELD IS BOUND BUT NO ROW CARRIES IT YET — an install that just turned the binding on.
  //    Never an error; null, the same as "no rows at all".
  {
    const res = await callBoard(mount({
      boundTarget: withLastPlmRefreshBinding,
      mainTableRows: [{ projectNo: PROJECT_A_NO }, { projectNo: PROJECT_A_NO }],
    }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.pulledRowCount, 2)
    assert.equal(res.body.data.lastPulledAt, null, 'bound but absent on every row -> null, not an error')
  }

  // 4. A TARGET THAT IS NOT READY AT ALL (nothing bound) -> lastPulledAt is null right alongside
  //    every other pull-target fact, via the same PULL_TARGET_NOT_READY shape.
  {
    const res = await callBoard(mount({ actionConfigured: false }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.pullTargetReady, false)
    assert.equal(res.body.data.lastPulledAt, null)
  }

  // 5. A garbage/unparseable stamp on one row must not crash the scan or poison the max — it simply
  //    does not vote, the same posture `parsePlmRefreshTimestampMs` documents.
  {
    const res = await callBoard(mount({
      boundTarget: withLastPlmRefreshBinding,
      mainTableRows: [
        { projectNo: PROJECT_A_NO, lastPlmRefreshAt: 'not-a-date' },
        { projectNo: PROJECT_A_NO, lastPlmRefreshAt: NEWEST },
      ],
    }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.lastPulledAt, NEWEST, 'an unparseable cell on another row does not poison the max')
  }
}

// ---------------------------------------------------------------------------
// lastPulledAtBounded — a TRUNCATED scan must not report a possibly-wrong max
// ---------------------------------------------------------------------------
//
// readPullTargetRowFacts pages by OFFSET, unordered by lastPlmRefreshAt. Past PULL_TARGET_MAX_PAGES
// the row COUNT is still a safe floor (bounded:true already says "at least this many"), but a MAX
// computed only over the pages actually read is not safe the same way: a row past the bound could
// carry the true latest stamp, so reporting the partial max would silently UNDERSTATE freshness with
// no way for a reader to tell "really is stale" apart from "the scan gave up". This is tested directly
// against `readPullTargetRowFacts` (not through the full route) because forcing the bound through the
// route's fixtures would mean materializing PULL_TARGET_MAX_PAGES * PULL_TARGET_PAGE_LIMIT physical
// rows through the strict multitable fake for no benefit — the scan loop itself is what is under test.
async function lastPulledAtIsNeverReportedFromATruncatedScan() {
  const { readPullTargetRowFacts } = BOARD_INTERNALS
  const PAGE_LIMIT = PREP_LINE_EXPORT_INTERNALS.READ_PAGE_LIMIT
  const MAX_PAGES = PREP_LINE_EXPORT_INTERNALS.READ_MAX_PAGES
  const ownSheet = { sheetId: 'sheet_bounded_scan', objectId: MAIN_OBJECT_ID }
  const boundTarget = {
    sheetId: 'sheet_bounded_scan',
    objectId: MAIN_OBJECT_ID,
    fieldIdMap: { projectNo: 'projectNo', active: 'active', lastPlmRefreshAt: 'lastPlmRefreshAt' },
  }
  let calls = 0
  const recordsApi = {
    async queryRecords() {
      calls += 1
      // EVERY page comes back exactly full, so the scan never sees a short final page and runs the
      // full MAX_PAGES. The LAST readable page plants the NEWEST stamp of the whole (synthetic)
      // dataset — proof that a partial max, had it been reported, would have been wrong.
      const isLastReadablePage = calls === MAX_PAGES
      return Array.from({ length: PAGE_LIMIT }, (_unused, i) => ({
        data: {
          projectNo: PROJECT_A_NO,
          active: true,
          lastPlmRefreshAt: isLastReadablePage && i === 0 ? '2099-01-01T00:00:00.000Z' : '2020-01-01T00:00:00.000Z',
        },
      }))
    },
  }
  const facts = await readPullTargetRowFacts(recordsApi, ownSheet, boundTarget, PROJECT_A_NO)
  assert.equal(facts.ready, true)
  assert.equal(facts.bounded, true, 'the row-count scan is truncated, exactly like pulledRowCountBounded')
  assert.equal(facts.rowCount, PAGE_LIMIT * MAX_PAGES)
  assert.equal(calls, MAX_PAGES, 'the scan reads exactly the page bound and no further')
  assert.equal(facts.lastPulledAt, null, 'a truncated scan must report null, never a possibly-wrong max')
  assert.equal(facts.lastPulledAtBounded, true, 'and say WHY it is null — truncation, not "no rows carry the stamp"')
}

// ---------------------------------------------------------------------------
// B-11 — THE BOARD REFLECTS THE PULL THE OPERATOR ACTUALLY RAN
// ---------------------------------------------------------------------------
//
// THE BUG THIS PINS. Every number on the first cut's status bar came from the MVP SNAPSHOT tables,
// which are written by `mvp-persist` — platform-admin, and deliberately left there. So on the flow
// this whole page exists for, where a floor operator runs the pull themselves, a successful import
// of hundreds of rows left the bar reading 「还没拉过」 / 「还没从 PLM 拉过这个项目」 and offered no
// way to tell that from a project nobody had touched. The operator's own evidence — the rows in the
// sheet `apply` just wrote — was never read.
//
// So the board now carries TWO families of numbers and never lets one stand in for the other:
//   * the PULL TARGET facts (pulledRowCount / activePulledRowCount / pullTargetReady), read from the
//     bound `action.target` — the same object the export reads through, so if the export can read
//     it, the board can count it; and
//   * the ARCHIVE (snapshotBatchCount / heldLineCount / readyLineCount / lastSyncRunId), unchanged,
//     and now flagged by `archivedSnapshotPresent` so the front end can say whose numbers they are.
async function theBoardReflectsThePullRatherThanTheAdminsArchive() {
  // 1. THE ORDINARY CASE: both families present, and they are DIFFERENT numbers — which is the whole
  //    point. The archive says 2 lines (1 held, 1 ready); the pull target holds 3 rows, 2 active.
  {
    const res = await callBoard(mount().routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    const board = res.body.data
    assert.equal(board.pullTargetReady, true, 'B-11: the bound target is the caller\'s own and readable')
    assert.equal(board.pulledRowCount, 3, 'B-11: every row the pull wrote for this project is counted')
    assert.equal(board.activePulledRowCount, 2, 'B-11: and the active ones are counted apart')
    assert.equal(board.pulledRowCountBounded, false)
    assert.equal(board.archivedSnapshotPresent, true, 'B-11: the administrator\'s archive is present here')
    assert.equal(board.heldLineCount, 1, 'B-11: the archive numbers are unchanged and still reported')
    assert.equal(board.readyLineCount, 1)
  }

  // 2. THE OPERATOR'S OWN RUN — the flow the page is for. `apply` wrote the rows; `mvp-persist` was
  //    refused (platform-admin, as ruled), so NOTHING is in the archive. The board must still answer
  //    and must still show the rows: this is the assertion the first cut could not pass.
  {
    const harness = mount({ archivePersisted: false })
    const res = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200, `B-11: an operator's own pull must produce a board, got ${JSON.stringify(res.body)}`)
    const board = res.body.data
    assert.equal(board.projectNo, PROJECT_A_NO)
    assert.ok(board.pulledRowCount > 0, 'B-11: the row count the operator just created is > 0')
    assert.equal(board.activePulledRowCount, 2)
    assert.equal(board.pullTargetReady, true)
    // And the archive is honestly reported as ABSENT rather than as zeros that read like "nothing
    // was ever pulled" — the exact conflation that produced 「还没从 PLM 拉过这个项目」.
    assert.equal(board.archivedSnapshotPresent, false, 'B-11: the archive is absent, and says so')
    assert.equal(board.snapshotBatchCount, 0)
    assert.equal(board.lastSyncRunId, null)
    assert.equal(board.projectId, null, 'B-11: there is no archive row, so there is no archive handle')

    // THE PENDING QUEUE IS NOT PART OF THE ARCHIVE, and must not vanish with it. The
    // confirmation-decision ledger is keyed by projectNo — not by the archive's projectId — so it is
    // answerable with or without an archive row. Reading the count off the archive row made the
    // board tell an operator 「没有要您拿主意的事」 while their own pull had just queued some, with
    // ledgerReady:true saying the ledger was consulted and healthy. The fixture seeds ONE pending
    // decision for this project, so the honest answer here is 1, and it was 0.
    assert.equal(board.ledgerReady, true, 'B-11: the ledger was consulted')
    assert.equal(
      board.pendingDecisionCount,
      1,
      'B-11: pending work is keyed by projectNo and survives an absent archive row',
    )
  }

  // 3. NEITHER FAMILY HAS ANYTHING -> the SAME shapeless 404 as always. "Not pulled and not archived"
  //    and "not yours" must stay one answer.
  {
    const harness = mount({ archivePersisted: false, mainTableRows: [] })
    const res = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 404, 'B-11: no rows anywhere is still NOT FOUND')
    assert.equal(errorOf(res).code, 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND')
  }

  // 4. THE TENANT GATE ON THE PULL-TARGET READ — the half that keeps (2) from being an existence
  //    oracle. `action.target` is DEPLOY-TIME config, so its sheet id is not derived from the
  //    caller's tenant; the row facts are read ONLY when that sheet is the one the CALLER'S OWN
  //    provisioning computes for their OWN staging project, which is the identical gate the fill
  //    handle rides. A bound target outside the caller's own staging project is not read at all, so
  //    it can neither answer nor deny existence.
  {
    const foreign = { sheetId: ownSheetIdFor(STAGING_B, MAIN_OBJECT_ID), objectId: MAIN_OBJECT_ID }
    const harness = mount({ archivePersisted: false, boundTarget: foreign })
    const res = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 404, 'B-11: a bound target outside the caller\'s own staging project proves nothing')
    assert.equal(errorOf(res).code, 'STOCK_PREPARATION_PROJECT_BOARD_NOT_FOUND')
  }
  // Same gate, viewed from the archive side: the project IS in the archive, so the board answers —
  // but the pull-target facts degrade to "not ready" rather than reading a sheet that is not ours.
  {
    const foreign = { sheetId: ownSheetIdFor(STAGING_B, MAIN_OBJECT_ID), objectId: MAIN_OBJECT_ID }
    const res = await callBoard(mount({ boundTarget: foreign }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.pullTargetReady, false, 'B-11: a foreign bound target is never read')
    assert.equal(res.body.data.pulledRowCount, 0)
    assert.equal(res.body.data.fillTarget, null, 'B-11: and the fill handle agrees — one gate, two consumers')
  }
  // Nothing bound at all is a deployment state, not a failure.
  {
    const res = await callBoard(mount({ actionConfigured: false }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.pullTargetReady, false)
  }
  // The sheet is bound and ours, but was never provisioned -> not ready, still not an error.
  {
    const res = await callBoard(mount({ mainTableProvisioned: false }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.pullTargetReady, false)
  }

  // 5. THE AUDIT STAYS VALUES-FREE over the new branch too — booleans and counts, no projectNo.
  {
    const harness = mount({ archivePersisted: false })
    await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    const entry = harness.auditAppends[0]
    assert.ok(!JSON.stringify(entry).includes(PROJECT_A_NO), 'B-11: still no projectNo on the trail')
    assert.equal(entry.detail.archivedSnapshotPresent, false)
    assert.equal(entry.detail.pullTargetReady, true)
  }
}

// ---------------------------------------------------------------------------
// B-13 — THE TENANT MODEL OF THE BOUND SHEET, PINNED FROM BOTH SIDES
// ---------------------------------------------------------------------------
//
// The bound `action.target` is DEPLOY-TIME configuration — one list, shared by every tenant — and
// `plm_stock_preparation_main` has NO tenant column; its only row-level scope is `projectNo`. Those
// are properties of the table-action model, not of this PR, and the export route has stated them in
// its own header since it shipped.
//
// An earlier version of the board comment claimed more than that: it said no cross-tenant projectNo
// could ever be answered. What is actually true — and sufficient — is a model with two halves, and
// this pins BOTH, because a claim that only ever gets tested on its comfortable side is not pinned.
async function theBoundSheetsTenantModelHoldsFromBothSides() {
  const CANONICAL_SHEET = ownSheetIdFor(STAGING_A, MAIN_OBJECT_ID)
  const NEIGHBOUR_PROJECT_NO = '230920007'

  // HALF ONE — THE OWNER READS THE WHOLE SHEET, and that is what "owning" means here. Two different
  // project numbers living in tenant A's own bound sheet are BOTH tenant A's data by definition:
  // the sheet has exactly one owner, and rows only arrive in it through an `apply` that owner ran.
  // Answering 404 for the second would be the bug, not the guarantee.
  {
    const harness = mount({
      archivePersisted: false,
      mainTableRows: [
        { projectNo: PROJECT_A_NO },
        { projectNo: NEIGHBOUR_PROJECT_NO },
        { projectNo: NEIGHBOUR_PROJECT_NO },
      ],
    })
    const first = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(first.statusCode, 200, 'B-13: the owner reads their own project')
    assert.equal(first.body.data.pulledRowCount, 1)

    const second = await callBoard(mount({
      archivePersisted: false,
      mainTableRows: [
        { projectNo: PROJECT_A_NO },
        { projectNo: NEIGHBOUR_PROJECT_NO },
        { projectNo: NEIGHBOUR_PROJECT_NO },
      ],
    }).routes, { user: OPERATOR_A, projectNo: NEIGHBOUR_PROJECT_NO })
    assert.equal(
      second.statusCode,
      200,
      'B-13: and every OTHER project number in the sheet they own, because a single-tenant sheet has '
      + 'no foreign project numbers in it',
    )
    assert.equal(second.body.data.pulledRowCount, 2)
  }

  // HALF TWO — A NON-OWNER LEARNS NOTHING, even about a project number that really does have rows in
  // that sheet. This is the half the boundary rests on: tenant B is not the owner of tenant A's
  // bound sheet, so `resolveOwnBoundSheet` refuses it, the sheet is never queried, and the
  // pull-target disjunct cannot fire. The refusal is the SAME detail-free 404 an unknown number gets.
  {
    const harness = mount({
      archivePersisted: false,
      mainTableRows: [{ projectNo: PROJECT_A_NO }, { projectNo: PROJECT_A_NO }],
      // Tenant B's own registry answer and hash both fail against tenant A's sheet.
      sheetOwners: { [CANONICAL_SHEET]: STAGING_A },
    })
    const foreign = await callBoard(harness.routes, { user: OPERATOR_B, projectNo: PROJECT_A_NO })
    const unknown = await callBoard(mount({
      archivePersisted: false,
      mainTableRows: [{ projectNo: PROJECT_A_NO }, { projectNo: PROJECT_A_NO }],
      sheetOwners: { [CANONICAL_SHEET]: STAGING_A },
    }).routes, { user: OPERATOR_B, projectNo: UNKNOWN_PROJECT_NO })

    assert.equal(foreign.statusCode, 404, 'B-13: a non-owner is refused a projectNo that HAS rows')
    assert.deepEqual(
      foreign.body,
      unknown.body,
      'B-13: and the refusal is byte-identical to the one an unknown number gets — the non-owner '
      + 'learns nothing about which project numbers exist in a sheet they do not own',
    )
  }
}
// ---------------------------------------------------------------------------
// B-12 — TENANCY IS PROVED FROM THE SHEET, NOT FROM THE SHAPE OF THE BINDING
// ---------------------------------------------------------------------------
//
// THE BUG THIS PINS. The first cut proved "this bound sheet is ours" by recomputing
// `getObjectSheetId(ourStagingProject, boundTarget.objectId)` and comparing. That is a
// BINDING-SHAPE test, not a tenancy proof, and it is wrong in both directions of usefulness:
//
//   * it REFUSES a sheet we genuinely own whenever the binding names a different objectId than the
//     one the sheet was created under. The sanctioned 222 deploy-window step (D1=B) does exactly
//     that — it rebinds the action to a SANDBOX objectId while KEEPING the existing sheetId — so on
//     the configuration the runbook tells operators to use, the fill handle would never appear and
//     the pull-target row counts would read "table not ready" over a table full of their rows; and
//   * it can only ever admit sheets whose id happens to hash from our own project, so it cannot
//     speak at all about a sheet an administrator bound by hand.
//
// The proof now comes from the SHEET: the host's provisioning registry records which project owns
// each sheet, plugin-scope narrows that answer to this plugin's namespace, and the handle/counts
// appear iff the owning project IS the caller's staging project. The hash test is KEPT as a second,
// independently sufficient proof (it embeds the caller's own project id, so it is sound) for hosts
// too old to have the port — widening a sound proof, never replacing it with a weaker one.
async function tenancyIsProvedFromTheSheetNotTheBindingShape() {
  const CANONICAL_SHEET = ownSheetIdFor(STAGING_A, MAIN_OBJECT_ID)

  // 1. THE 222 WINDOW SHAPE: the action is rebound to a SANDBOX objectId, the sheetId is the one
  //    the deployment already had. The hash test fails; the registry says the sheet is ours.
  {
    const sandboxBinding = {
      sheetId: CANONICAL_SHEET,
      objectId: 'plm_stock_preparation_sandbox_main',
      fieldIdMap: MAIN_FIELD_ID_MAP,
    }
    const res = await callBoard(mount({ boundTarget: sandboxBinding }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.ok(
      res.body.data.fillTarget,
      'B-12: a sandbox rebinding of a sheet we own must still yield a fill handle — this is the sanctioned deploy-window config',
    )
    assert.equal(res.body.data.fillTarget.sheetId, CANONICAL_SHEET)
    assert.equal(res.body.data.pullTargetReady, true, 'B-12: and its rows must be countable')
    assert.equal(res.body.data.pulledRowCount, 3)
  }

  // 2. A HAND-BOUND SHEET IN OUR OWN TENANT — an id that hashes from nothing we would compute, but
  //    that the registry records as ours. It must show.
  {
    const handBound = { sheetId: 'sheet_hand_made_by_an_admin', objectId: MAIN_OBJECT_ID, fieldIdMap: MAIN_FIELD_ID_MAP }
    const harness = mount({
      boundTarget: handBound,
      sheetOwners: { sheet_hand_made_by_an_admin: STAGING_A },
      mainSheetIdOverride: 'sheet_hand_made_by_an_admin',
    })
    const res = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.data.fillTarget, 'B-12: a hand-bound sheet the registry says is ours must show')
    assert.equal(res.body.data.fillTarget.sheetId, 'sheet_hand_made_by_an_admin')
  }

  // 3. A SHEET OWNED BY ANOTHER TENANT — the registry answers with somebody else's project (or, once
  //    plugin-scope has narrowed it, with null). No handle, no deep link, no row counts, and the
  //    foreign id is never echoed.
  {
    const foreign = { sheetId: ownSheetIdFor(STAGING_B, MAIN_OBJECT_ID), objectId: MAIN_OBJECT_ID, fieldIdMap: MAIN_FIELD_ID_MAP }
    const harness = mount({
      boundTarget: foreign,
      sheetOwners: { [ownSheetIdFor(STAGING_B, MAIN_OBJECT_ID)]: STAGING_B },
    })
    const res = await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.fillTarget, null, 'B-12: a sheet another tenant owns yields NO handle')
    assert.equal(res.body.data.pullTargetReady, false, 'B-12: and is never read for row counts')
    assert.equal(res.body.data.pulledRowCount, 0)
    assert.ok(!JSON.stringify(res.body).includes(STAGING_B), 'B-12: and the foreign project is never echoed')
  }

  // 4. THE SAME SHEET, WITH THE REGISTRY SILENT (an old host, or an unclaimed sheet). The hash proof
  //    is all that is left, and it correctly refuses a sheet that does not hash from our project.
  {
    const foreign = { sheetId: ownSheetIdFor(STAGING_B, MAIN_OBJECT_ID), objectId: MAIN_OBJECT_ID, fieldIdMap: MAIN_FIELD_ID_MAP }
    const res = await callBoard(mount({ boundTarget: foreign, sheetOwners: null }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.fillTarget, null, 'B-12: no port and no hash match means no handle')
  }

  // 5. …and with the registry silent, the ORDINARY canonical binding still works, because the hash
  //    proof still holds. A host too old for the port loses nothing it had.
  {
    const res = await callBoard(mount({ sheetOwners: null }).routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.data.fillTarget, 'B-12: the deterministic proof still stands on a host without the port')
    assert.equal(res.body.data.pullTargetReady, true)
  }
}

// ---------------------------------------------------------------------------
// B-08 — ONE PROJECT'S BOARD COSTS ONE PROJECT'S QUERIES
// ---------------------------------------------------------------------------
//
// The first cut answered this route by walking the caller's ENTIRE directory — 3 record queries per
// project in the tenant, plus a hard 422 above MAX_LIST_ROWS projects — to find one row. That is not
// a performance nit on a page an operator opens at 07:00 with one number in their hand: it is a page
// whose cost is set by somebody else's project count, and a tenant that grows past the list bound
// loses the board entirely for every project, including the one being asked about.
//
// The assertion is deliberately a SHAPE, not a magic number: the same board read, against a
// directory with one project and against a directory with seven, must cost the SAME queries. That
// stays true under any later refactor that keeps the read narrowed, and goes red the moment somebody
// re-widens it.
async function oneProjectsBoardCostsOneProjectsQueries() {
  const lone = mount()
  await callBoard(lone.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
  const loneQueries = lone.queryCallCount()

  const crowded = mount({ extraProjects: 6 })
  const res = await callBoard(crowded.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
  assert.equal(res.statusCode, 200, 'B-08: the crowded directory still answers')
  assert.equal(res.body.data.projectNo, PROJECT_A_NO, 'B-08: and it answers about the RIGHT project')

  assert.equal(
    crowded.queryCallCount(),
    loneQueries,
    `B-08: a board read must not cost more because the tenant has more projects (1 project: ${loneQueries} queries, 7 projects: ${crowded.queryCallCount()})`,
  )
  assert.ok(loneQueries <= 8, `B-08: and the fixed cost stays small, got ${loneQueries}`)

  // A MISS is narrowed the same way — otherwise the cheap path would be the hit and the expensive
  // one the typo, which is the wrong way round for a search box.
  const miss = mount({ extraProjects: 6 })
  const missRes = await callBoard(miss.routes, { user: OPERATOR_A, projectNo: UNKNOWN_PROJECT_NO })
  assert.equal(missRes.statusCode, 404)
  assert.ok(
    miss.queryCallCount() <= loneQueries,
    `B-08: a miss costs no more than a hit, got ${miss.queryCallCount()}`,
  )

  // ---------------------------------------------------------------------------
  // …AND THE READS ARE ACTUALLY NARROWED, not merely few.
  // ---------------------------------------------------------------------------
  //
  // A query COUNT cannot tell a narrowed read from an unnarrowed one: the pending-decision ledger is
  // ONE query either way, so deleting its `projectNo` filter kept this whole function green while
  // restoring the bound the narrowing exists for — a tenant whose OTHER projects have enough pending
  // decisions to pass CONFIRMATION_DECISION_LIST_LIMIT_EXCEEDED would take the board down for every
  // project, including the one being asked about. So assert the FILTER each read was issued with.
  {
    const harness = mount({ extraProjects: 6 })
    await callBoard(harness.routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })

    const projectReads = harness.queryLog.filter((call) => call.sheetId === PROJECT_SHEET_A)
    assert.ok(projectReads.length > 0, 'B-08: the project sheet was read')
    for (const call of projectReads) {
      assert.deepEqual(
        Object.values(call.filters),
        [PROJECT_A_NO],
        'B-08: the project sheet is read FILTERED by the one project number, never listed whole',
      )
    }

    const ledgerReads = harness.queryLog.filter((call) => call.sheetId === LEDGER_SHEET_A)
    assert.ok(ledgerReads.length > 0, 'B-08: the pending-decision ledger was read')
    for (const call of ledgerReads) {
      assert.ok(
        Object.values(call.filters).includes(PROJECT_A_NO),
        'B-08: the ledger read carries the project number as a filter — without it the row bound '
        + 'applies to the whole tenant\'s pending work, which is the bound the narrowing exists for',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// B-09 — THE MODULE'S OWN FAIL-CLOSED SCOPE GUARD
// ---------------------------------------------------------------------------
//
// `readOperatorProjectBoard` refuses outright when it is handed no resolved operator scope. Every
// route-level case above enters through the handler, which always resolves one — so disabling that
// guard left all nine plugin suites green. It is the module's promise that it cannot be reached from
// a route that forgot to establish who is asking, so it is asserted by DIRECT CALL, the only way
// that promise is expressible.
async function theModuleRefusesToProjectAValueWithoutAScope() {
  const provisioning = {
    async findObjectSheet() { throw new Error('B-09: no IO may happen before the scope guard') },
  }
  const recordsApi = {
    async queryRecords() { throw new Error('B-09: no IO may happen before the scope guard') },
  }
  for (const [label, scope] of [
    ['no scope at all', null],
    ['undefined scope', undefined],
    ['a scope with an empty tenant', { tenantId: '' }],
    ['a scope with a whitespace tenant', { tenantId: '   ' }],
    ['a scope with no tenant key', {}],
  ]) {
    await assert.rejects(
      () => readOperatorProjectBoard({
        recordsApi,
        provisioning,
        targetProjectId: STAGING_A,
        scope,
        projectNo: PROJECT_A_NO,
      }),
      (error) => {
        assert.equal(error.code, 'PROJECT_BOARD_SCOPE_REQUIRED', `B-09: ${label}`)
        assert.equal(error.status, 500, `B-09: ${label} fails closed as a server fault, not a 4xx the caller can shape`)
        return true
      },
      `B-09: ${label} must be refused before any read`,
    )
  }
}

// ---------------------------------------------------------------------------
// B-10 — THE DEEP LINK'S VIEW ID IS THE HOST'S, NOT A HAND-COPIED LITERAL
// ---------------------------------------------------------------------------
//
// `STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID` must be the same token the host's own default-view
// provisioning creates (`DEFAULT_OBJECT_VIEW_LOGICAL_ID`). Nothing enforced that: changing the
// plugin's copy to any other string kept every suite green and shipped a link to a view that does
// not exist. Mirrored byte-for-byte out of the host source, in the same style B-01's vocabulary
// mirror uses.
function theFillViewIdMirrorsTheHostsDefaultViewId() {
  const provisioningSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'packages', 'core-backend', 'src', 'multitable', 'provisioning.ts'),
    'utf8',
  )
  const match = provisioningSrc.match(/export const DEFAULT_OBJECT_VIEW_LOGICAL_ID = '([^']+)'/)
  assert.ok(match, 'B-10: the host still declares DEFAULT_OBJECT_VIEW_LOGICAL_ID')
  assert.equal(
    STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID,
    match[1],
    'B-10: the fill deep link must name the view id the host\'s own default-view provisioning creates',
  )
}

// ---------------------------------------------------------------------------
// B-13 (H13) — THE AUDIT VOCABULARY GATE
//
// The board's audit append is fail-closed and PRECEDES the values (B-04). That makes the width of
// the database's `action` CHECK constraint a precondition of the whole route, not a detail of its
// last statement: `db:migrate` is a separate CLI, so a deployment can run this code against a schema
// whose vocabulary stops at 085 — and then every board read did the entire tenant-scoped read and
// died on a raw constraint violation naming a constraint the operator has never heard of.
//
// Until this case existed, deleting the probe from the route stayed green, because no other case in
// this file gives the audit store a `supportsAction` at all.
// ---------------------------------------------------------------------------

async function theBoardRefusesBeforeItsAuditActionCanBeStored() {
  // (a) The schema is behind. One 503 that NAMES the migration, no audit row, and — the part that
  //     matters for a values-bearing read — no records IO at all.
  {
    const { routes, auditAppends, auditProbes, queryCallCount } = mount({
      auditSupportsAction: async () => ({ supported: false, reason: 'check_constraint_rejects' }),
    })
    const res = await callBoard(routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 503, `B-13: a narrow vocabulary refuses, got ${JSON.stringify(res.body)}`)
    assert.equal(errorOf(res).code, 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE')
    assert.equal(errorOf(res).details.migration, '086', 'B-13: the refusal names the migration to run')
    assert.deepEqual(auditAppends, [], 'B-13: nothing is appended when the table cannot accept it')
    assert.equal(queryCallCount(), 0, 'B-13: the refusal costs zero records queries')
    assert.equal(auditProbes.length, 1)
    assert.equal(auditProbes[0].action, 'project_board_read')
    // Probed under the RESOLVED tenant, not a placeholder: the row it inserts and rolls back belongs
    // to the tenant being cleared.
    assert.equal(auditProbes[0].tenantId, TENANT_A)
    assert.equal(auditProbes[0].at, 0, 'B-13: the probe runs before any append')
  }
  // (b) The schema is current. The board answers, and the probe is cached: a second read does not
  //     pay for a second rolled-back INSERT.
  {
    const { routes, auditProbes } = mount({
      auditSupportsAction: async () => ({ supported: true, reason: 'check_constraint_accepts' }),
    })
    const first = await callBoard(routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(first.statusCode, 200, `B-13: a current schema answers, got ${JSON.stringify(first.body)}`)
    const second = await callBoard(routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(second.statusCode, 200)
    assert.equal(auditProbes.length, 1, 'B-13: the positive verdict is cached for the process')
  }
  // (c) THE MISS PATH IS BEHIND THE SAME GATE. The 404 append writes the same action, so a narrow
  //     vocabulary must refuse a miss with the 503 too — never with the constraint violation that a
  //     404-then-append would have produced.
  {
    const { routes, auditAppends } = mount({
      auditSupportsAction: async () => ({ supported: false }),
    })
    const res = await callBoard(routes, { user: OPERATOR_A, projectNo: 'PRJ-NO-SUCH-THING' })
    assert.equal(res.statusCode, 503, `B-13: a miss is gated too, got ${JSON.stringify(res.body)}`)
    assert.equal(errorOf(res).code, 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE')
    assert.deepEqual(auditAppends, [])
  }
  // (d) FAIL-OPEN ON A PROBE THAT ITSELF BLOWS UP. A connection blip must degrade to "just try the
  //     write", exactly as before the probe existed — a diagnostic that cannot diagnose must not
  //     become a refusal.
  {
    const { routes } = mount({
      auditSupportsAction: async () => { throw new Error('connection reset') },
    })
    const res = await callBoard(routes, { user: OPERATOR_A, projectNo: PROJECT_A_NO })
    assert.equal(res.statusCode, 200, `B-13: an undiagnosable probe fails open, got ${JSON.stringify(res.body)}`)
  }
}

async function main() {
  await onlyTheOperatorTierReachesTheBoard()
  await anotherTenantsProjectIsIndistinguishableFromNoProject()
  await theBoardAnswersWithHandlesCountsAndTheProjectsOwnNameOnly()
  await theAuditRowIsValuesFreeAndPrecedesTheValues()
  await theDeepLinkHandleAppearsOnlyWhenTheFillTableExists()
  await theBoardReflectsThePullRatherThanTheAdminsArchive()
  await tenancyIsProvedFromTheSheetNotTheBindingShape()
  await theBoundSheetsTenantModelHoldsFromBothSides()
  await oneProjectsBoardCostsOneProjectsQueries()
  await theModuleRefusesToProjectAValueWithoutAScope()
  theFillViewIdMirrorsTheHostsDefaultViewId()
  await anAuditStoreWithoutListStillAnswersTheBoard()
  await theBoardReportsLastPulledAtFromTheBoundLastPlmRefreshColumn()
  await lastPulledAtIsNeverReportedFromATruncatedScan()
  await theBoardRefusesBeforeItsAuditActionCanBeStored()
  console.log('✓ stock-preparation-project-board')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
