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
  listOperatorProjectDirectory,
  __internals: { EXPORT_AUDIT_WINDOW },
} = require(path.join(LIB, 'stock-preparation-operator-project-directory.cjs'))
const {
  PULL_TARGET_MAX_PAGES,
  PULL_TARGET_PAGE_LIMIT,
  SCAN_WHOLE_SHEET,
  createPullTargetScanCache,
  scanPullTargetProjects,
} = require(path.join(LIB, 'stock-preparation-pull-target-scan.cjs'))
const {
  __internals: { MAX_LIST_ROWS },
} = require(path.join(LIB, 'stock-preparation-project-reads.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const DIRECTORY_PATH = '/api/integration/stock-preparation/operator/projects'
const VALUES_FREE_PROJECTS_PATH = '/api/integration/stock-preparation/projects'

/**
 * THE OPT-IN, SPELLED ONCE (核验裁决 r3).
 *
 * The 设计稿 N1 union — scanning the bound table-action target for the project numbers the
 * operator's own pull wrote — is a full-sheet, LIMIT/OFFSET-paged read, so the owner ruled it may
 * not run on an unqualified GET. Every N1/N6 guard below therefore asks for it in as many words,
 * and N1-r asserts what a caller who does NOT ask gets: the pre-N1 response, and zero queries
 * against that sheet.
 */
const UNION_QUERY = Object.freeze({ includePullTargets: '1' })

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
// 设计稿 N1/N2/N6 — THE SECOND STORE
// ---------------------------------------------------------------------------
//
// The bound table-action target: the sheet the operator's OWN four-step pull writes, and the sheet
// the export reads. It is the ONLY store a floor operator's run touches — `mvp-persist`, which fills
// the project ledger above, stayed platform-admin — so a project they pulled themselves lives here
// and NOWHERE else. The directory is now a union over the two, keyed by project number.
const MAIN_OBJECT_ID = 'plm_stock_preparation_main'
/** The deterministic sheet id the CALLER'S OWN provisioning computes — the tenant gate's yardstick. */
const MAIN_SHEET_A = `sheet__${STAGING_A}__${MAIN_OBJECT_ID}`
const MAIN_FIELD_ID_MAP = Object.freeze({
  projectNo: physicalFieldId(STAGING_A, MAIN_OBJECT_ID, 'projectNo'),
  active: physicalFieldId(STAGING_A, MAIN_OBJECT_ID, 'active'),
  lastPlmRefreshAt: physicalFieldId(STAGING_A, MAIN_OBJECT_ID, 'lastPlmRefreshAt'),
})

/** Two projects that exist ONLY in the pull target — the self-service main line F1 describes. */
const PROJECT_A3_NO = '230920008'
const PROJECT_A4_NO = '230920009'

/**
 * A PART NAME planted in the pull target's own `componentName` column.
 *
 * This is the canary N1 makes necessary: the union's second store is a MATERIALS table, one row per
 * BOM line, carrying part numbers, names, specs and quantities. The directory is a values-free
 * projection over project-level facts — numbers, counts, enums, timestamps — and a scan that leaked
 * a row value out of that table would be a new disclosure class, not a widening of an old one.
 */
const PART_CANARY = 'ZZPARTNAMECANARYZZ'

const EXPORT_AT_A = '2026-09-01T02:03:04.000Z'
const EXPORT_AT_A_OLDER = '2026-08-01T02:03:04.000Z'
const PLM_REFRESH_OLD = '2026-08-20T01:00:00.000Z'
const PLM_REFRESH_NEW = '2026-08-27T09:30:00.000Z'

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

/** One BOM line in the bound table-action target — the sheet the operator's OWN pull writes. */
function mainRow(stagingProjectId, sheetId, recordId, fields) {
  const row = physicalRow(stagingProjectId, MAIN_OBJECT_ID, fields, recordId)
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
  // G-05c — `undefined` models an audit store with no `supportsAction` at all (the vocabulary guard
  // returns at its first line, fail-open), which is what every other case here wants.
  auditSupportsAction,
  // ── 设计稿 N1/N2/N6 knobs. All default to the PRE-EXISTING world: no bound table action, no main
  //    table, no audit `list`. Every guard written before this change therefore runs against exactly
  //    the substrate it was written against, and the new state is opt-in per scenario.
  //
  // `null` = no table action is configured at all (the default, and a real deployment state).
  // An ARRAY = the rows the operator's own pull put in the bound target, `{ projectNo, active,
  // lastPlmRefreshAt, componentName }` per row.
  mainTableRows = null,
  // Which sheet the action is bound to. Defaults to the caller's OWN deterministic id, which is what
  // the tenant gate demands; a scenario that models a foreign binding overrides it.
  boundSheetIdOverride = null,
  // `null` = the audit store has no `list` at all (the default). An ARRAY = what one descending
  // window over `prep_line_export` returns, newest first, as the store would return it.
  auditEntries = null,
  // MVP-side rows. `false` models the self-service main line: nobody ever ran mvp-persist here.
  archivePersisted = true,
  // THE PERSISTED SOURCE-BINDING STORE, which `getTableAction` resolves through and whose throws the
  // registry deliberately lets PROPAGATE. `undefined` = no such store (the default). A function
  // models a deployment where that table is missing or unreachable — the half-migrated upgrade — and
  // is how N1-j proves the landing page still opens.
  sourceBindingGet,
} = {}) {
  const MAIN_SHEET = boundSheetIdOverride || MAIN_SHEET_A
  const routes = new Map()

  const missingA = new Set()
  if (!ledgerProvisioned) missingA.add(DECISION_OBJECT_ID)
  if (!directoryProvisioned) missingA.add(PROJECT_OBJECT_ID)

  const provisioningA = makeFakeProvisioning({
    stagingProjectId: STAGING_A,
    sheetIdByObjectId: {
      [PROJECT_OBJECT_ID]: PROJECT_SHEET_A,
      [DECISION_OBJECT_ID]: LEDGER_SHEET_A,
      ...(mainTableRows ? { [MAIN_OBJECT_ID]: MAIN_SHEET } : {}),
    },
    missing: missingA,
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
      ...(mainTableRows ? { [MAIN_SHEET]: MAIN_OBJECT_ID } : {}),
    },
    rowsBySheet: {
      ...(mainTableRows ? {
        [MAIN_SHEET]: mainTableRows.map((row, index) => mainRow(STAGING_A, MAIN_SHEET, `rec_main_a${index}`, {
          projectNo: row.projectNo,
          idempotencyKey: `idem_${index}`,
          componentSourceId: `comp_${index}`,
          path: `/${index}`,
          totalQuantity: row.totalQuantity !== undefined ? row.totalQuantity : 1,
          active: row.active !== false,
          ...(row.componentName !== undefined ? { componentName: row.componentName } : {}),
          ...(row.lastPlmRefreshAt !== undefined ? { lastPlmRefreshAt: row.lastPlmRefreshAt } : {}),
        })),
      } : {}),
      [PROJECT_SHEET_A]: archivePersisted ? [
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
      ] : [],
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
    // The host's PURE id derivation — the yardstick the bound target's sheet id is compared against.
    getObjectSheetId(projectId, objectId) {
      return `sheet__${projectId}__${objectId}`
    },
    // The host's OWNERSHIP question, a BOOLEAN about the project we name. ONLY tenant A's own
    // staging project owns the main sheet; tenant B asking about it gets `false` and therefore never
    // reads a row of it, which is what makes the cross-tenant guard below non-vacuous.
    async isSheetOwnedByProject(sheetId, projectId) {
      return sheetId === MAIN_SHEET && projectId === STAGING_A
    },
    async ensureObject() {
      throw new Error('unexpected provisioning write: ensureObject')
    },
  })
  const queryLog = []
  const records = counted({
    async queryRecords(input = {}) {
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
    // union scan is gated on, and the tenant gate compares it against the caller's own deterministic
    // sheet id. Absent by default — a real deployment state, and the one every pre-existing guard
    // here was written against.
    config: mainTableRows
      ? {
          stockPreparationTableActions: [{
            actionId: 'plm.stock-preparation.pull-bom.v1',
            source: { kind: 'data-source:sql-readonly', externalSystemId: 'ext_demo' },
            target: {
              sheetId: MAIN_SHEET,
              objectId: MAIN_OBJECT_ID,
              // THE EXPLICIT MODE, which is what a real deployment configures: logical id -> the
              // PHYSICAL fieldId provisioning materialized.
              fieldIdMap: MAIN_FIELD_ID_MAP,
            },
          }],
        }
      : {},
  }
  const services = baseServices()
  const auditListCalls = []
  services.stockPreparationAuditStore = {
    async append(entry) {
      auditAppends.push(entry)
      if (typeof auditAppend === 'function') return auditAppend(entry)
      return { ok: true }
    },
    // `lastExportAt` reads ONE descending window over `prep_line_export`. A store with no `list` at
    // all is the pre-existing default here, and the directory must still answer.
    ...(auditEntries === null ? {} : {
      async list(input) {
        auditListCalls.push(input)
        // The real store CLAMPS `limit` to its own MAX_LIST_LIMIT and returns at most that many
        // rows, newest first. Slicing here is what makes a SATURATED window reachable in a test.
        const entries = auditEntries.slice(0, input.limit)
        return { rowCount: entries.length, entries }
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
  if (typeof sourceBindingGet === 'function') {
    services.stockPreparationSourceBindingStore = { get: sourceBindingGet }
  }

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
    queryLog,
    recordsA,
    recordsB,
    mainSheetId: MAIN_SHEET,
  }
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
    // CONTRACT REVIEW (设计稿 N1 + 核验裁决 r3). THE DEFAULT TRAIL ROW DID NOT GROW. The union is
    // `?includePullTargets=1` opt-in, and a read that did not scan has nothing to say about a scan:
    // three booleans that really meant 「没人要求扫」 would make every ordinary home-page open look
    // like a deployment with a broken binding, which is how a trail stops being evidence. G-05d
    // pins what the opt-in path records instead.
    assert.deepEqual(Object.keys(entry.detail).sort(), [
      'directoryReady',
      'ledgerReady',
      'operation',
      'pendingProjectCount',
      'projectCount',
      'tenantClaimVerified',
    ])
  })

  await run('G-05d the opt-in trail records WHICH store answered and WHY the answer was short', async () => {
    // CONTRACT REVIEW (设计稿 N1 + r3). Three booleans join the trail on the scanning path:
    //   `pullTargetReady`          — was the operator's OWN store readable at all,
    //   `directoryMayBeIncomplete` — was the answer whole, and
    //   `pullTargetScanCapped`     — if it was short, was that the standing 5-万行 cap or an incident.
    // All three are values-free by construction (booleans; the store's structural gate would refuse
    // anything else), and none is recoverable from `projectCount` alone: when an operator reports
    // 「我的项目不见了」, the trail has to separate 「目录本来就是空的」 from 「拉取目标没绑好」 from
    // 「扫描撞到上限被截断了」 from 「读挂了」. No key here names a project.
    const { routes, auditAppends } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(Object.keys(auditAppends[0].detail).sort(), [
      'directoryMayBeIncomplete',
      'directoryReady',
      'ledgerReady',
      'operation',
      'pendingProjectCount',
      'projectCount',
      'pullTargetReady',
      'pullTargetScanCapped',
      'tenantClaimVerified',
    ])
    assert.equal(JSON.stringify(auditAppends).includes(PROJECT_A_NO), false, 'still values-free')
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

  await run('G-05c (H13) the read refuses BEFORE the values when the DB cannot store its audit action', async () => {
    // G-05b proves the migration FILE admits the action. It cannot prove the DEPLOYMENT ran it:
    // `db:migrate` is a separate CLI, so this code can run against a schema whose CHECK constraint
    // predates 082. Because the append is fail-closed and precedes the response (G-06), the symptom
    // was the whole tenant-scoped read followed by a raw constraint violation. Now it is a 503 that
    // names the migration, before any records IO.
    {
      const { routes, auditAppends, auditProbes, hostCallCount } = mount({
        auditSupportsAction: async () => ({ supported: false, reason: 'check_constraint_rejects' }),
      })
      const before = hostCallCount()
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
      assert.equal(res.statusCode, 503, `a narrow vocabulary refuses, got ${JSON.stringify(res.body)}`)
      assert.equal(errorCode(res), 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE')
      assert.equal(res.body.error.details.migration, '082', 'the refusal names the migration to run')
      assert.deepEqual(auditAppends, [], 'nothing is appended when the table cannot accept it')
      assert.equal(hostCallCount(), before, 'the refusal costs zero records work')
      assert.equal(auditProbes.length, 1)
      assert.equal(auditProbes[0].action, 'project_directory_read')
      // Probed under the RESOLVED tenant, so the row it inserts and rolls back belongs to the tenant
      // being cleared — not to a placeholder.
      assert.equal(auditProbes[0].tenantId, TENANT_A)
      assert.equal(auditProbes[0].at, 0, 'the probe runs before any append')
    }
    // A current schema answers, and the positive verdict is cached for the process.
    {
      const { routes, auditProbes } = mount({
        auditSupportsAction: async () => ({ supported: true, reason: 'check_constraint_accepts' }),
      })
      assert.equal((await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })).statusCode, 200)
      assert.equal((await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })).statusCode, 200)
      assert.equal(auditProbes.length, 1, 'the positive verdict is cached')
    }
    // A probe that itself blows up tells us nothing, so it must NOT become a refusal: a connection
    // blip degrades to "just try the write", exactly as before the probe existed.
    {
      const { routes } = mount({ auditSupportsAction: async () => { throw new Error('connection reset') } })
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
      assert.equal(res.statusCode, 200, `an undiagnosable probe fails open, got ${JSON.stringify(res.body)}`)
    }
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
  // 设计稿 N1 — THE UNION, AND THE FLAG THAT FORBIDS A SILENT TRUNCATION
  // -------------------------------------------------------------------------

  await run('N1-a the directory is a UNION over the archive and the pull target, deduped by project number', async () => {
    const { routes } = mount({
      mainTableRows: [
        // PROJECT_A_NO is in BOTH stores — the dedupe case. Two rows here, ONE directory row.
        { projectNo: PROJECT_A_NO },
        { projectNo: PROJECT_A_NO, active: false },
        // …and two projects that exist ONLY here: the self-service main line F1 describes.
        { projectNo: PROJECT_A4_NO },
        { projectNo: PROJECT_A3_NO },
        { projectNo: PROJECT_A3_NO },
      ],
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    assert.equal(res.statusCode, 200)
    const data = res.body.data
    const numbers = data.projects.map((project) => project.projectNo)
    assert.deepEqual(numbers, [PROJECT_A_NO, PROJECT_A2_NO, PROJECT_A3_NO, PROJECT_A4_NO],
      'four project numbers, each exactly once — the overlap is ONE row, and the pull-only tail is sorted')
    assert.equal(data.projectCount, 4)
    assert.equal(data.pullTargetReady, true)
    assert.equal(data.directoryMayBeIncomplete, false, 'the scan finished, so the union is whole')

    const byNo = new Map(data.projects.map((project) => [project.projectNo, project]))
    assert.deepEqual(byNo.get(PROJECT_A_NO).sources, ['mvp', 'pull_target'], 'in both stores')
    assert.deepEqual(byNo.get(PROJECT_A2_NO).sources, ['mvp'], 'archived, never pulled through the bound target')
    assert.deepEqual(byNo.get(PROJECT_A3_NO).sources, ['pull_target'], 'the operator pulled it themselves')

    // A pull-only row keeps the ARCHIVE fields honest: null/zero, never invented. `projectId` is
    // null because there is no archive row to take a handle from, and a fabricated handle would
    // resolve to nothing.
    const pullOnly = byNo.get(PROJECT_A3_NO)
    assert.equal(pullOnly.projectId, null)
    assert.equal(pullOnly.projectName, null)
    assert.equal(pullOnly.projectStatus, null)
    assert.equal(pullOnly.lastSyncRunId, null)
    assert.equal(pullOnly.snapshotBatchCount, 0)
    assert.equal(pullOnly.readyLineCount, 0)
    // …and the MVP row keeps everything it always had.
    assert.equal(byNo.get(PROJECT_A_NO).projectId, PROJECT_A_ID)
    assert.equal(byNo.get(PROJECT_A_NO).projectName, PROJECT_A_NAME)
  })

  await run('N1-b F1 ITSELF: nobody ever ran mvp-persist, and the operator still sees their own projects', async () => {
    const { routes } = mount({
      archivePersisted: false,
      mainTableRows: [{ projectNo: PROJECT_A3_NO }, { projectNo: PROJECT_A4_NO }],
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.directoryReady, true, 'the archive TABLE exists — it is simply empty')
    assert.deepEqual(res.body.data.projects.map((project) => project.projectNo), [PROJECT_A3_NO, PROJECT_A4_NO])
    // Before this change this response was `projects: []` on the one flow the operator tier exists
    // for. That is the whole bug F1 names.
    assert.equal(res.body.data.projectCount, 2)
  })

  await run('N1-c no bound table action -> the archive alone, and pullTargetReady says why', async () => {
    const { routes, queryLog } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.pullTargetReady, false)
    assert.equal(res.body.data.directoryMayBeIncomplete, false,
      'nothing is bound, so there are no pull-target projects to be missing — a permanently-true flag would be ignored')
    assert.deepEqual(res.body.data.projects.map((project) => project.sources), [['mvp'], ['mvp']])
    assert.equal(queryLog.some((entry) => entry.sheetId === MAIN_SHEET_A), false, 'and nothing was scanned')
  })

  await run('N1-d the union is TENANT-GATED: tenant B never reads tenant A\'s bound sheet', async () => {
    // The action config is deploy-time and shared by every tenant on the deployment, so tenant B's
    // operator is handed the SAME target — naming tenant A's sheet. The gate is what stops it.
    const { routes, queryLog } = mount({
      mainTableRows: [{ projectNo: PROJECT_A3_NO }, { projectNo: `NO-${SECRET_B}-PULL` }],
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_B, query: UNION_QUERY })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.tenantId, TENANT_B)
    assert.equal(res.body.data.pullTargetReady, false, 'the sheet is not tenant B\'s own, so it is not read')
    assert.equal(queryLog.some((entry) => entry.sheetId === MAIN_SHEET_A), false)
    assert.equal(JSON.stringify(res.body).includes(PROJECT_A3_NO), false,
      'a project number that lives only in tenant A\'s pull target must not cross')
  })

  await run('N1-e VALUES-FREE: the pull target is a MATERIALS table and not one part value crosses', async () => {
    // A QUANTITY as well as a NAME: the two families 派活 names, and the second one is a number, so a
    // leak that survives a string search for a part name would still be caught here.
    const QTY_CANARY = 90210424242
    const { routes } = mount({
      mainTableRows: [
        { projectNo: PROJECT_A3_NO, componentName: PART_CANARY, totalQuantity: QTY_CANARY },
        { projectNo: PROJECT_A_NO, componentName: PART_CANARY, totalQuantity: QTY_CANARY },
      ],
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    const serialized = JSON.stringify(res.body)
    assert.equal(serialized.includes(PART_CANARY), false, 'a part NAME must not ride the directory out')
    assert.equal(serialized.includes(String(QTY_CANARY)), false, 'nor a quantity')
    // THE FIELD NAMES, AS THE SUBSTRATE REALLY KEYS THEM. The stored row is keyed by the PHYSICAL
    // fieldId provisioning materialized — a hash — not by the logical name, so searching the
    // response for the string 'componentName' proves nothing at all: it could not appear even if the
    // whole row were spread into the response. These are the keys a spread would actually produce.
    for (const logicalField of ['componentName', 'totalQuantity', 'path', 'idempotencyKey', 'componentSourceId', 'projectNo']) {
      assert.equal(
        serialized.includes(physicalFieldId(STAGING_A, MAIN_OBJECT_ID, logicalField)),
        false,
        `${logicalField}'s physical key discloses the schema and must not appear`,
      )
    }
    // The canaries really were in the substrate, or this guard is vacuous. Proved from BOTH ends: the
    // projection carries the number, and the stored row carries the value the projection dropped.
    assert.equal(serialized.includes(PROJECT_A3_NO), true, 'the project number IS the projection — that part works')
    const storedRow = mainRow(STAGING_A, MAIN_SHEET_A, 'rec_probe', { componentName: PART_CANARY, totalQuantity: QTY_CANARY })
    assert.equal(JSON.stringify(storedRow).includes(PART_CANARY), true, 'the fixture really does store the part name')
    assert.equal(
      JSON.stringify(storedRow).includes(physicalFieldId(STAGING_A, MAIN_OBJECT_ID, 'componentName')),
      true,
      'and it stores it under the physical key this guard searches for',
    )
  })

  await run('N1-f PAST THE SCAN BOUND the directory says so — it never truncates silently', async () => {
    // Driven at the MODULE, not the route: forcing 100 full pages through the route harness would
    // seed 50,000 rows to prove a branch that one always-full page proves.
    const projectNoField = MAIN_FIELD_ID_MAP.projectNo
    const activeField = MAIN_FIELD_ID_MAP.active
    let pages = 0
    const recordsApi = {
      async queryRecords({ sheetId }) {
        if (sheetId !== MAIN_SHEET_A) return []
        pages += 1
        // ALWAYS a full page: the scan can never reach its short-page exit.
        return Array.from({ length: PULL_TARGET_PAGE_LIMIT }, (_unused, index) => ({
          data: { [projectNoField]: `NO-${index}`, [activeField]: true },
        }))
      },
    }
    const provisioning = {
      async findObjectSheet() { return null },
      getObjectSheetId(projectId, objectId) { return `sheet__${projectId}__${objectId}` },
      async isSheetOwnedByProject(sheetId, projectId) { return sheetId === MAIN_SHEET_A && projectId === STAGING_A },
    }
    const result = await listOperatorProjectDirectory({
      recordsApi,
      provisioning,
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      includePullTargets: true,
      boundTarget: { sheetId: MAIN_SHEET_A, objectId: MAIN_OBJECT_ID, fieldIdMap: { ...MAIN_FIELD_ID_MAP } },
    })
    assert.equal(pages, PULL_TARGET_MAX_PAGES, 'the scan stops AT the shared export bound, not beyond it')
    assert.equal(result.pullTargetReady, true)
    assert.equal(result.directoryMayBeIncomplete, true,
      'the page bound was hit, so the set of project numbers is a SUBSET and the response must say so')
    // …and WHICH kind of short answer this is, which `directoryMayBeIncomplete` alone cannot say
    // (核验裁决 r3). This is the standing 5-万行 cap, not an incident.
    assert.equal(result.pullTargetScanCapped, true)
    // …and the timestamps go to "unknown", not to "never changed".
    for (const project of result.projects) {
      assert.equal(project.lastChangedFromPlmAt, null)
      assert.equal(project.lastChangedFromPlmBounded, true)
    }
  })

  await run('N1-g the merge cap is a DEGRADE plus the same flag, never a 422 that hides the pull target', async () => {
    const projectNoField = MAIN_FIELD_ID_MAP.projectNo
    const activeField = MAIN_FIELD_ID_MAP.active
    const TOTAL = MAX_LIST_ROWS + 100
    const recordsApi = {
      async queryRecords({ sheetId, offset }) {
        if (sheetId !== MAIN_SHEET_A) return []
        const start = offset
        if (start >= TOTAL) return []
        return Array.from({ length: Math.min(PULL_TARGET_PAGE_LIMIT, TOTAL - start) }, (_unused, index) => ({
          data: { [projectNoField]: `NO-${String(start + index).padStart(6, '0')}`, [activeField]: true },
        }))
      },
    }
    const provisioning = {
      async findObjectSheet() { return null },
      getObjectSheetId(projectId, objectId) { return `sheet__${projectId}__${objectId}` },
      async isSheetOwnedByProject(sheetId, projectId) { return sheetId === MAIN_SHEET_A && projectId === STAGING_A },
    }
    const result = await listOperatorProjectDirectory({
      recordsApi,
      provisioning,
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      includePullTargets: true,
      boundTarget: { sheetId: MAIN_SHEET_A, objectId: MAIN_OBJECT_ID, fieldIdMap: { ...MAIN_FIELD_ID_MAP } },
    })
    assert.equal(result.projectCount, MAX_LIST_ROWS, 'capped at the same row bound the archive path uses')
    assert.equal(result.directoryMayBeIncomplete, true, 'and the cap is DECLARED')
    // THE MERGE CAP IS NOT THE SCAN CAP. `pullTargetScanCapped` names ONE bound — the scan's page
    // bound — and this scan ran to its short-page exit. Collapsing the two would leave a front end
    // unable to say which limit it hit, which is the whole reason the key exists.
    assert.equal(result.pullTargetScanCapped, false)
    assert.equal(result.pullTargetReady, true)
  })

  // -------------------------------------------------------------------------
  // N1-h/N1-i — A SCAN THAT BREAKS MID-FLIGHT IS THE THIRD WAY THE UNION GOES SHORT
  // -------------------------------------------------------------------------
  //
  // The failure this pins: the pull target is bound, provisioned and the caller's own; the read
  // starts, and page 3 of 100 throws. The pages already read are DISCARDED — a partial group would
  // understate a project's row count and hand back a max timestamp over an arbitrary prefix — so
  // every project that lives only in the pull target vanishes from the answer. If the response also
  // said `directoryMayBeIncomplete: false`, it would be asserting the union is whole in the one case
  // where the whole second store went missing, and an operator whose project disappeared would be
  // shown a page that confidently says it does not exist.
  //
  // It must ALSO be distinguishable from 「什么都没绑」, because the audit trail is what a support
  // question is answered from: N1-c pins {pullTargetReady:false, directoryMayBeIncomplete:false} for
  // "nothing bound", and this pins {false, true} for "the read broke". Those are the two signatures.
  const breakingScanProvisioning = {
    async findObjectSheet() { return null },
    getObjectSheetId(projectId, objectId) { return `sheet__${projectId}__${objectId}` },
    async isSheetOwnedByProject(sheetId, projectId) { return sheetId === MAIN_SHEET_A && projectId === STAGING_A },
  }
  const BOUND_TARGET_A = {
    sheetId: MAIN_SHEET_A,
    objectId: MAIN_OBJECT_ID,
    fieldIdMap: { ...MAIN_FIELD_ID_MAP },
  }
  /** Two full pages of real project numbers, and then the break. */
  function recordsApiThatBreaksOnPage(breakAt, breakWith) {
    let pages = 0
    return {
      pageCount: () => pages,
      async queryRecords({ sheetId, offset }) {
        if (sheetId !== MAIN_SHEET_A) return []
        pages += 1
        if (pages >= breakAt) return breakWith()
        return Array.from({ length: PULL_TARGET_PAGE_LIMIT }, (_unused, index) => ({
          data: {
            [MAIN_FIELD_ID_MAP.projectNo]: `NO-${String(offset + index).padStart(6, '0')}`,
            [MAIN_FIELD_ID_MAP.active]: true,
          },
        }))
      },
    }
  }

  await run('N1-h A SCAN THAT THREW MIDWAY says 「可能不全」 — it never claims a whole union', async () => {
    const recordsApi = recordsApiThatBreaksOnPage(3, () => { throw new Error('connection reset by peer') })
    const result = await listOperatorProjectDirectory({
      recordsApi,
      provisioning: breakingScanProvisioning,
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      includePullTargets: true,
      boundTarget: BOUND_TARGET_A,
    })
    assert.equal(recordsApi.pageCount(), 3, 'two pages read, the third threw')
    assert.equal(result.pullTargetReady, false, 'the store was not readable through to the end')
    assert.equal(result.directoryMayBeIncomplete, true,
      'and every project number the pull target held is missing from this answer, so it says so')
    assert.equal(result.projectCount, 0, 'the partial read is DISCARDED rather than served as a whole union')
    // AN INCIDENT, NOT THE CAP. A page bound that was never reached must not be reported as reached
    // — 「稍后再试」 and 「表太大」 are different sentences and this is the flag that picks one.
    assert.equal(result.pullTargetScanCapped, false)
  })

  await run('N1-i …and a page that comes back as a non-array is the same break, not an empty sheet', async () => {
    const recordsApi = recordsApiThatBreaksOnPage(3, () => null)
    const result = await listOperatorProjectDirectory({
      recordsApi,
      provisioning: breakingScanProvisioning,
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      includePullTargets: true,
      boundTarget: BOUND_TARGET_A,
    })
    assert.equal(result.pullTargetReady, false)
    assert.equal(result.directoryMayBeIncomplete, true,
      'a null page is a broken read; treating it as "the sheet ended" is how a truncation goes silent')
    assert.equal(result.pullTargetScanCapped, false, 'and it is not the cap either')
  })

  await run('N1-j THE TWO SIGNATURES ARE DIFFERENT, which is what the audit trail is read for', async () => {
    // Nothing bound at all — N1-c's state, restated here so the pair is asserted side by side and a
    // future change cannot collapse one into the other without failing this.
    const { routes, auditAppends } = mount()
    assert.equal((await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })).statusCode, 200)
    assert.deepEqual(
      { ready: auditAppends[0].detail.pullTargetReady, incomplete: auditAppends[0].detail.directoryMayBeIncomplete },
      { ready: false, incomplete: false },
      '「什么都没绑」',
    )
    const broken = await listOperatorProjectDirectory({
      recordsApi: recordsApiThatBreaksOnPage(1, () => { throw new Error('connection reset by peer') }),
      provisioning: breakingScanProvisioning,
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      includePullTargets: true,
      boundTarget: BOUND_TARGET_A,
    })
    assert.deepEqual(
      { ready: broken.pullTargetReady, incomplete: broken.directoryMayBeIncomplete },
      { ready: false, incomplete: true },
      '「读挂了」 — a different pair, so the trail can tell a support question apart',
    )
  })

  await run('N1-j2 …and the THIRD signature — 「表太大被截断」 — is distinguishable from both', async () => {
    // 核验裁决 r3. The two pairs above use `pullTargetReady` + `directoryMayBeIncomplete`; that pair
    // is exhausted by them, so the page bound and the merge bound BOTH read {true, true} and a front
    // end cannot tell 「这是这个部署的固定上限」 from 「刚才那次读出了问题」. `pullTargetScanCapped`
    // is the third bit, and this asserts all three signatures side by side so a future change cannot
    // collapse any two of them without failing here.
    const projectNoField = MAIN_FIELD_ID_MAP.projectNo
    const cappedScan = {
      async queryRecords({ sheetId }) {
        if (sheetId !== MAIN_SHEET_A) return []
        // ALWAYS full: the scan can only ever stop at its page bound.
        return Array.from({ length: PULL_TARGET_PAGE_LIMIT }, (_unused, index) => ({
          data: { [projectNoField]: `NO-${index}` },
        }))
      },
    }
    const capped = await listOperatorProjectDirectory({
      recordsApi: cappedScan,
      provisioning: breakingScanProvisioning,
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      includePullTargets: true,
      boundTarget: BOUND_TARGET_A,
    })
    assert.deepEqual(
      { ready: capped.pullTargetReady, incomplete: capped.directoryMayBeIncomplete, capped: capped.pullTargetScanCapped },
      { ready: true, incomplete: true, capped: true },
      '「表太大,被上限截断」',
    )
    const broken = await listOperatorProjectDirectory({
      recordsApi: recordsApiThatBreaksOnPage(1, () => { throw new Error('connection reset by peer') }),
      provisioning: breakingScanProvisioning,
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      includePullTargets: true,
      boundTarget: BOUND_TARGET_A,
    })
    assert.deepEqual(
      { ready: broken.pullTargetReady, incomplete: broken.directoryMayBeIncomplete, capped: broken.pullTargetScanCapped },
      { ready: false, incomplete: true, capped: false },
      '「读挂了」 — a THIRD distinct triple',
    )
  })

  // -------------------------------------------------------------------------
  // N1-k — WHICH READ WAS ASKED FOR, SAID IN AS MANY WORDS
  // -------------------------------------------------------------------------

  await run('N1-k the whole-sheet read has a NAME: a missing narrowing reads nothing, never everything', async () => {
    const seen = []
    const recordsApi = {
      async queryRecords(input) {
        seen.push(input.filters)
        return []
      },
    }
    const ownSheet = { sheetId: MAIN_SHEET_A, objectId: MAIN_OBJECT_ID }

    const whole = await scanPullTargetProjects(recordsApi, ownSheet, BOUND_TARGET_A, SCAN_WHOLE_SHEET)
    assert.equal(whole.ready, true)
    assert.deepEqual(seen.at(-1), {}, 'the sentinel is the ONLY way to get an unfiltered scan')

    const narrowed = await scanPullTargetProjects(recordsApi, ownSheet, BOUND_TARGET_A, PROJECT_A_NO)
    assert.equal(narrowed.ready, true)
    assert.deepEqual(seen.at(-1), { [MAIN_FIELD_ID_MAP.projectNo]: PROJECT_A_NO }, 'a number narrows')

    // A NUMERIC project number narrows too, because `optionalString` — the one reader every cell in
    // this feature goes through — coerces a number to its string, and a business number arriving out
    // of a spreadsheet cell as a number is ordinary. The sentinel rule tightens the EMPTY cases; it
    // does not invent a stricter type discipline than the rest of the module keeps.
    assert.equal((await scanPullTargetProjects(recordsApi, ownSheet, BOUND_TARGET_A, 230920006)).ready, true)
    assert.deepEqual(seen.at(-1), { [MAIN_FIELD_ID_MAP.projectNo]: '230920006' })

    // The case this rule exists for: a caller that MEANT to narrow and lost its number. Widening to
    // the whole sheet here would report the whole table's rows and max timestamp under one project's
    // name; reading nothing is the honest answer, and it is what the pre-merge board did by accident.
    const before = seen.length
    for (const lost of [null, undefined, '', '   ', {}, []]) {
      const result = await scanPullTargetProjects(recordsApi, ownSheet, BOUND_TARGET_A, lost)
      assert.equal(result.ready, false, `a ${JSON.stringify(lost) || String(lost)} narrowing must not become a whole-sheet scan`)
      assert.equal(result.failed, false, 'and it is not a READ failure — nothing was read')
    }
    assert.equal(seen.length, before, 'not one query was issued for any of them')
  })

  await run('N1-l the directory NARROWS the pull-target scan too when it is asked about one project', async () => {
    // 项目备料页 reaches `listOperatorProjectDirectory` with a projectNo; the narrowing has to reach
    // the pull target as well as the archive, or a single-project caller pays the whole-sheet scan.
    const filters = []
    const recordsApi = {
      async queryRecords(input) {
        if (input.sheetId === MAIN_SHEET_A) filters.push(input.filters)
        return []
      },
    }
    const result = await listOperatorProjectDirectory({
      recordsApi,
      provisioning: breakingScanProvisioning,
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      projectNo: PROJECT_A_NO,
      includePullTargets: true,
      boundTarget: BOUND_TARGET_A,
    })
    assert.equal(result.pullTargetReady, true)
    assert.deepEqual(filters, [{ [MAIN_FIELD_ID_MAP.projectNo]: PROJECT_A_NO }],
      'ONE narrowed page, not a walk of the whole sheet')
  })

  // -------------------------------------------------------------------------
  // N1-m/N1-n — THE COST OF THE LANDING PAGE IS PER WINDOW, NOT PER CLICK
  // -------------------------------------------------------------------------
  //
  // The union scan reads the whole bound sheet, of every column, with no DISTINCT and no projection,
  // and the records port pages by OFFSET (so a full pass is quadratic in pages). This route is the
  // operator's LANDING PAGE and carries a refresh button that any holder of the operate grant can
  // replay. Without a window, holding it down is one full-table scan per click.
  //
  // WHAT THIS DOES NOT DO: it does not make the scan cheap, and it does not raise the 50,000-row
  // ceiling. Both are in the PR body as owner decisions.

  await run('N1-m a refresh inside the window re-reads NOTHING, and answers the same thing', async () => {
    const { routes, queryLog } = mount({ mainTableRows: [{ projectNo: PROJECT_A3_NO }, { projectNo: PROJECT_A4_NO }] })
    const scanQueries = () => queryLog.filter((entry) => entry.sheetId === MAIN_SHEET_A).length
    const first = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    assert.equal(first.statusCode, 200)
    const afterFirst = scanQueries()
    assert.ok(afterFirst > 0, 'the first read really did scan the bound sheet')
    const second = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    assert.equal(second.statusCode, 200)
    assert.equal(scanQueries(), afterFirst, 'the second read paid nothing')
    assert.deepEqual(
      second.body.data.projects.map((project) => project.projectNo),
      first.body.data.projects.map((project) => project.projectNo),
      'and it is the same answer, not a degraded one',
    )
    assert.equal(second.body.data.pullTargetReady, true)
  })

  await run('N1-n a WARM window is still not a way past the tenant gate', async () => {
    // The gate runs in the CALLER's own request, before the window is ever consulted, and the window
    // is keyed by the sheet id that gate proved. So tenant A's freshly-cached scan of tenant A's
    // sheet is not reachable by tenant B, who is handed the same deploy-time target.
    const { routes, queryLog } = mount({
      mainTableRows: [{ projectNo: PROJECT_A3_NO }, { projectNo: `NO-${SECRET_B}-PULL` }],
    })
    assert.equal((await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })).statusCode, 200)
    const afterWarming = queryLog.filter((entry) => entry.sheetId === MAIN_SHEET_A).length
    assert.ok(afterWarming > 0)
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_B, query: UNION_QUERY })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.tenantId, TENANT_B)
    assert.equal(res.body.data.pullTargetReady, false, 'tenant B never proved ownership, so nothing was read for them')
    assert.equal(JSON.stringify(res.body).includes(PROJECT_A3_NO), false,
      'and not one project number out of tenant A\'s window crosses')
  })

  await run('N1-o a FAILED scan is never held: one blip is not a window of blips', async () => {
    let clock = 1_000
    const cache = createPullTargetScanCache({ ttlMs: 5_000, now: () => clock })
    let runs = 0
    const failing = async () => { runs += 1; return { ready: false, failed: true } }
    const succeeding = async () => { runs += 1; return { ready: true, failed: false } }

    await cache.resolve('k', failing)
    await cache.resolve('k', failing)
    assert.equal(runs, 2, 'a broken read is retried immediately rather than served for the whole window')

    await cache.resolve('k', succeeding)
    await cache.resolve('k', succeeding)
    assert.equal(runs, 3, 'a good read IS held')
    clock += 5_001
    await cache.resolve('k', succeeding)
    assert.equal(runs, 4, 'and released when the window closes')
  })

  await run('N1-p the window is BOUNDED — a deployment cannot grow one entry per sheet forever', async () => {
    let clock = 1_000
    const cache = createPullTargetScanCache({ ttlMs: 60_000, maxEntries: 4, now: () => clock })
    for (let index = 0; index < 40; index += 1) {
      await cache.resolve(`sheet-${index}`, async () => ({ ready: true, failed: false }))
    }
    assert.ok(cache.size() <= 4, `at most maxEntries are held, saw ${cache.size()}`)
  })

  await run('N1-q the landing page still OPENS when the source-binding table is unreachable', async () => {
    // `getTableAction` resolves the persisted source binding on the way out, and the registry lets a
    // throw from that store PROPAGATE on purpose. Every other failure path in this feature degrades;
    // this one used to 500 the one page the whole operator tier starts from — over a table the route
    // can simply report as unbound. A half-migrated upgrade is the realistic way to reach it.
    const { routes } = mount({
      mainTableRows: [{ projectNo: PROJECT_A3_NO }],
      sourceBindingGet: async () => { throw new Error('relation "stock_preparation_source_binding" does not exist') },
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    assert.equal(res.statusCode, 200, `the landing page must open, got ${JSON.stringify(res.body)}`)
    assert.equal(res.body.data.pullTargetReady, false, 'reported as unbound, which is what it is from here')
    assert.equal(res.body.data.directoryReady, true, 'and the archive half still answers')
    assert.equal(res.body.data.projectCount, 2, 'the two archived projects are still findable')
  })

  // -------------------------------------------------------------------------
  // 设计稿 N2 — THE PENDING INDEX, OPT-IN AND ONLY OPT-IN
  // -------------------------------------------------------------------------

  await run('N2-a the serializable pending index is ABSENT unless the caller asks for it', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)
    assert.equal(Object.prototype.hasOwnProperty.call(res.body.data, 'pendingCountsByProjectNo'), false,
      'the default response shape is frozen (S-02a) and this key is not in it')
    // The per-row count is NOT the opt-in: it predates this change and the confirmation queue's
    // worklist is built on it.
    assert.equal(res.body.data.projects.find((project) => project.projectNo === PROJECT_A_NO).pendingDecisionCount, 2)
  })

  await run('N2-b …and with includePendingCounts=1 it is present and agrees with the board\'s own index', async () => {
    const { routes, recordsA } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, {
      user: OPERATOR_A,
      query: { includePendingCounts: '1' },
    })
    assert.equal(res.statusCode, 200)
    const index = res.body.data.pendingCountsByProjectNo
    assert.ok(index, 'the opt-in key is served')
    assert.deepEqual({ ...index }, { [PROJECT_A_NO]: 2 },
      'two pending decisions on project A; the CONFIRMED one on project A2 is not work waiting for anyone')
    // THE SAME NUMBERS THE BOARD READS. `pendingByProjectNo` is the in-process Map 项目备料页
    // consumes; both are projections of one computation, and this pins that they cannot drift.
    const boardChannel = await listOperatorProjectDirectory({
      recordsApi: recordsA,
      provisioning: makeFakeProvisioning({
        stagingProjectId: STAGING_A,
        sheetIdByObjectId: { [PROJECT_OBJECT_ID]: PROJECT_SHEET_A, [DECISION_OBJECT_ID]: LEDGER_SHEET_A },
      }),
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      includePendingIndex: true,
    })
    assert.deepEqual({ ...index }, Object.fromEntries(boardChannel.pendingByProjectNo))
    // …and with every row's own count, which is the third projection of the same map.
    for (const project of res.body.data.projects) {
      assert.equal(project.pendingDecisionCount, index[project.projectNo] || 0)
    }
  })

  await run('N2-c an unknown query flag is still refused — the allowlist did not become a sieve', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, {
      user: OPERATOR_A,
      query: { includePendingIndex: '1' },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(errorCode(res), 'STOCK_PREPARATION_OPERATOR_PROJECT_DIRECTORY_REQUEST_INVALID')
  })

  await run('N2-d any value but "1" is not an opt-in — a flag is a flag, not a truthiness test', async () => {
    const { routes } = mount()
    for (const value of ['0', 'true', 'yes', '']) {
      const res = await call(routes, 'GET', DIRECTORY_PATH, {
        user: OPERATOR_A,
        query: { includePendingCounts: value },
      })
      assert.equal(res.statusCode, 200)
      assert.equal(Object.prototype.hasOwnProperty.call(res.body.data, 'pendingCountsByProjectNo'), false,
        `includePendingCounts=${JSON.stringify(value)} must not open the index`)
    }
  })

  // -------------------------------------------------------------------------
  // 设计稿 N6 — THE TWO TIMESTAMPS, THREE-STATE
  // -------------------------------------------------------------------------

  await run('N6-a lastChangedFromPlmAt is the MAX over the project\'s own rows', async () => {
    const { routes } = mount({
      mainTableRows: [
        { projectNo: PROJECT_A_NO, lastPlmRefreshAt: PLM_REFRESH_OLD },
        { projectNo: PROJECT_A_NO, lastPlmRefreshAt: PLM_REFRESH_NEW },
        // Another project's NEWER stamp must not leak into project A's answer.
        { projectNo: PROJECT_A3_NO, lastPlmRefreshAt: '2027-01-01T00:00:00.000Z' },
      ],
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    const byNo = new Map(res.body.data.projects.map((project) => [project.projectNo, project]))
    assert.equal(byNo.get(PROJECT_A_NO).lastChangedFromPlmAt, PLM_REFRESH_NEW)
    assert.equal(byNo.get(PROJECT_A_NO).lastChangedFromPlmBounded, false)
    assert.equal(byNo.get(PROJECT_A3_NO).lastChangedFromPlmAt, '2027-01-01T00:00:00.000Z')
  })

  await run('N6-b THE THREE STATES are distinguishable: a value / never / unknown', async () => {
    // (1) and (2): the scan finished. A project with a stamp gets it; a project whose rows carry
    //     none gets null with `bounded:false` — 「从未变更」 is then safe to say.
    {
      const { routes } = mount({
        mainTableRows: [
          { projectNo: PROJECT_A_NO, lastPlmRefreshAt: PLM_REFRESH_NEW },
          { projectNo: PROJECT_A3_NO },
        ],
      })
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
      const byNo = new Map(res.body.data.projects.map((project) => [project.projectNo, project]))
      assert.equal(byNo.get(PROJECT_A_NO).lastChangedFromPlmAt, PLM_REFRESH_NEW)
      assert.equal(byNo.get(PROJECT_A_NO).lastChangedFromPlmBounded, false)
      assert.equal(byNo.get(PROJECT_A3_NO).lastChangedFromPlmAt, null)
      assert.equal(byNo.get(PROJECT_A3_NO).lastChangedFromPlmBounded, false, 'no row of this project ever changed')
      // A project the pull target has never heard of is in the same state — the scan DID look.
      assert.equal(byNo.get(PROJECT_A2_NO).lastChangedFromPlmBounded, false)
    }
    // (3): NOBODY LOOKED. The pull target is not bound, so 「从未变更」 would be a fabrication —
    //      the row's own flag has to carry the "unknown", because a row travels alone into a table
    //      cell or a sort key, separated from the top-level `pullTargetReady`.
    {
      const { routes } = mount()
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
      assert.equal(res.body.data.pullTargetReady, false)
      for (const project of res.body.data.projects) {
        assert.equal(project.lastChangedFromPlmAt, null)
        assert.equal(project.lastChangedFromPlmBounded, true, 'unknown, NOT "never"')
      }
    }
    // (4) NOBODY ASKED. Not a fourth state of the flag — the KEY is gone, because a column of
    //     「未知」 on every unqualified home-page open is worse than no column. N1-r pins the shape.
    {
      const { routes } = mount({ mainTableRows: [{ projectNo: PROJECT_A_NO, lastPlmRefreshAt: PLM_REFRESH_NEW }] })
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
      for (const project of res.body.data.projects) {
        assert.equal(Object.prototype.hasOwnProperty.call(project, 'lastChangedFromPlmAt'), false)
        assert.equal(Object.prototype.hasOwnProperty.call(project, 'lastChangedFromPlmBounded'), false)
      }
    }
  })

  await run('N6-c lastExportAt comes from the values-free audit trail, newest row per project', async () => {
    const { routes, auditListCalls } = mount({
      auditEntries: [
        { projectId: PROJECT_A_NO, action: 'prep_line_export', createdAt: EXPORT_AT_A },
        { projectId: PROJECT_A_NO, action: 'prep_line_export', createdAt: EXPORT_AT_A_OLDER },
      ],
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    const byNo = new Map(res.body.data.projects.map((project) => [project.projectNo, project]))
    assert.equal(byNo.get(PROJECT_A_NO).lastExportAt, EXPORT_AT_A, 'the DESC window\'s first row for a project wins')
    assert.equal(byNo.get(PROJECT_A2_NO).lastExportAt, null)
    assert.equal(res.body.data.lastExportAtMayBeIncomplete, false, 'the window was not full, so null really means never')
    // ONE query for the whole tenant, not one per project: the audit table has no index on
    // project_id, and this read is a home page.
    assert.equal(auditListCalls.length, 1)
    assert.equal(auditListCalls[0].projectId, undefined)
    assert.equal(auditListCalls[0].action, 'prep_line_export')
    assert.equal(auditListCalls[0].tenantId, TENANT_A)
  })

  await run('N6-d a SATURATED export window is declared, so a null is not read as "never exported"', async () => {
    // A FULL page back from the store means older rows exist that this window never saw. Project A2
    // really has exported — its row is one past the window — and the response must not claim it
    // never did. Seeded to exactly the width the reader asks for, which is what saturation IS.
    const { routes } = mount({
      auditEntries: [
        { projectId: PROJECT_A_NO, action: 'prep_line_export', createdAt: EXPORT_AT_A },
        ...Array.from({ length: EXPORT_AUDIT_WINDOW - 1 }, (_unused, index) => ({
          projectId: `OTHER-${index}`,
          action: 'prep_line_export',
          createdAt: EXPORT_AT_A_OLDER,
        })),
        { projectId: PROJECT_A2_NO, action: 'prep_line_export', createdAt: EXPORT_AT_A_OLDER },
      ],
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    assert.equal(res.body.data.lastExportAtMayBeIncomplete, true)
    const byNo = new Map(res.body.data.projects.map((project) => [project.projectNo, project]))
    assert.equal(byNo.get(PROJECT_A_NO).lastExportAt, EXPORT_AT_A)
    assert.equal(byNo.get(PROJECT_A2_NO).lastExportAt, null, '…and this null is an "unknown", which the flag says')
  })

  await run('N6-e no audit `list` at all -> the directory still answers, and declares the gap', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.lastExportAtMayBeIncomplete, true)
    for (const project of res.body.data.projects) assert.equal(project.lastExportAt, null)
  })

  // -------------------------------------------------------------------------
  // N1-r — 核验裁决 r3: THE UNION IS OPT-IN, AND OPTING OUT COSTS NOTHING
  // -------------------------------------------------------------------------
  //
  // The scan reads the whole bound sheet through a LIMIT/OFFSET port (≈P²·500/2 row accesses for a
  // P-page pass), and this route is a landing page. The owner ruled the union may not be charged to
  // a caller who did not ask, and that the unqualified response must be what it was before 设计稿
  // N1 — not "the same keys with nulls in them", the SAME KEYS.
  //
  // This is the guard the whole ruling rests on: without it, a later change that quietly restores
  // the default scan (or leaves one key behind) is invisible, because every other N1/N6 guard now
  // passes the parameter and would stay green.

  await run('N1-r NO `includePullTargets` -> zero pull-target queries, and the pre-N1 response shape', async () => {
    // The substrate is FULLY configured — a bound target with rows in it, an audit window with an
    // export in it — so nothing here passes because there was nothing to find.
    const { routes, queryLog, auditAppends, auditListCalls } = mount({
      mainTableRows: [{ projectNo: PROJECT_A3_NO, lastPlmRefreshAt: PLM_REFRESH_NEW }],
      auditEntries: [{ projectId: PROJECT_A_NO, action: 'prep_line_export', createdAt: EXPORT_AT_A }],
    })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)

    // ① NOT ONE QUERY against the bound sheet, and not one audit window read. This is the cost
    //    assertion — the reason the ruling exists — and it is measured, not assumed.
    assert.equal(queryLog.filter((entry) => entry.sheetId === MAIN_SHEET_A).length, 0,
      'the expensive scan must not run for a caller who did not ask for it')
    assert.deepEqual(auditListCalls, [], 'nor the export window, which only exists to fill an opt-in column')

    // ② THE RESPONSE IS THE PRE-N1 ONE, key for key. Absent, never present-and-null.
    assert.deepEqual(Object.keys(res.body.data).sort(), [
      'directoryReady',
      'ledgerReady',
      'pendingProjectCount',
      'projectCount',
      'projects',
      'tenantId',
    ])
    assert.ok(res.body.data.projects.length > 0, 'precondition: there is a row to pin')
    for (const project of res.body.data.projects) {
      assert.deepEqual(Object.keys(project).sort(), [
        'heldLineCount',
        'lastSyncRunId',
        'openExceptionCount',
        'pendingDecisionCount',
        'projectId',
        'projectName',
        'projectNo',
        'projectStatus',
        'readyLineCount',
        'snapshotBatchCount',
      ])
    }

    // ③ AND THE PULL-TARGET-ONLY PROJECT IS SIMPLY NOT THERE. That is the honest consequence of not
    //    scanning, and the front end's cue to pass the parameter on a surface that needs it.
    assert.equal(res.body.data.projects.some((project) => project.projectNo === PROJECT_A3_NO), false)
    assert.equal(res.body.data.projectCount, 2, 'the archive half answers exactly as it always did')

    // ④ THE AUDIT DETAIL IS THE PRE-N1 ONE TOO — the trail must not report on a scan nobody ran.
    assert.deepEqual(Object.keys(auditAppends[0].detail).sort(), [
      'directoryReady',
      'ledgerReady',
      'operation',
      'pendingProjectCount',
      'projectCount',
      'tenantClaimVerified',
    ])

    // ⑤ THE POSITIVE CONTROL, on the SAME substrate: with the parameter, all of it appears. Without
    //    this, ①–④ would also pass on a build where the union had simply been deleted.
    const asked = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A, query: UNION_QUERY })
    assert.equal(asked.statusCode, 200)
    assert.ok(queryLog.filter((entry) => entry.sheetId === MAIN_SHEET_A).length > 0)
    assert.equal(asked.body.data.pullTargetReady, true)
    assert.equal(asked.body.data.pullTargetScanCapped, false)
    assert.equal(asked.body.data.projects.some((project) => project.projectNo === PROJECT_A3_NO), true)
    assert.equal(asked.body.data.projects.find((project) => project.projectNo === PROJECT_A_NO).lastExportAt, EXPORT_AT_A)
  })

  await run('N1-r2 any value but "1" is not an opt-in, and the flag is still allowlisted', async () => {
    const { routes, queryLog } = mount({ mainTableRows: [{ projectNo: PROJECT_A3_NO }] })
    // (Whitespace around a value is normalized away before this comparison — the same rule every
    // other query flag in this family is read under — so `'1 '` IS an opt-in and is not listed.)
    for (const value of ['0', 'true', 'yes', '']) {
      const res = await call(routes, 'GET', DIRECTORY_PATH, {
        user: OPERATOR_A,
        query: { includePullTargets: value },
      })
      assert.equal(res.statusCode, 200)
      assert.equal(Object.prototype.hasOwnProperty.call(res.body.data, 'pullTargetReady'), false,
        `includePullTargets=${JSON.stringify(value)} must not open the union`)
    }
    assert.equal(queryLog.filter((entry) => entry.sheetId === MAIN_SHEET_A).length, 0,
      'and none of them paid for a scan')
    // THE TWO OPT-INS ARE INDEPENDENT: asking for the cheap pending index must not drag the
    // expensive scan in with it.
    const pendingOnly = await call(routes, 'GET', DIRECTORY_PATH, {
      user: OPERATOR_A,
      query: { includePendingCounts: '1' },
    })
    assert.equal(pendingOnly.statusCode, 200)
    assert.ok(pendingOnly.body.data.pendingCountsByProjectNo, 'the index really was served')
    assert.equal(Object.prototype.hasOwnProperty.call(pendingOnly.body.data, 'pullTargetReady'), false)
    assert.equal(queryLog.filter((entry) => entry.sheetId === MAIN_SHEET_A).length, 0)
  })

  // -------------------------------------------------------------------------
  // 项目备料页 PAYS NOTHING FOR ANY OF THIS
  // -------------------------------------------------------------------------

  await run('N-cost the board\'s in-process call opts out, so it runs no union scan', async () => {
    let mainSheetQueries = 0
    const recordsApi = {
      async queryRecords({ sheetId }) {
        if (sheetId === MAIN_SHEET_A) mainSheetQueries += 1
        return []
      },
    }
    const provisioning = {
      async findObjectSheet() { return null },
      getObjectSheetId(projectId, objectId) { return `sheet__${projectId}__${objectId}` },
      async isSheetOwnedByProject() { return true },
    }
    const result = await listOperatorProjectDirectory({
      recordsApi,
      provisioning,
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      projectNo: PROJECT_A_NO,
      includePendingIndex: true,
    })
    assert.equal(mainSheetQueries, 0, 'the scan is opt-in; the board does not opt in')
    // AND IT PAYS FOR NOTHING IT DOES NOT READ, even if a caller later hands it a boundTarget: the
    // switch is `includePullTargets`, so a board that grew a target parameter still scans nothing.
    const withTarget = await listOperatorProjectDirectory({
      recordsApi,
      provisioning,
      targetProjectId: STAGING_A,
      scope: { tenantId: TENANT_A, actorId: 'u_op_a' },
      projectNo: PROJECT_A_NO,
      includePendingIndex: true,
      boundTarget: BOUND_TARGET_A,
    })
    assert.equal(mainSheetQueries, 0, 'a boundTarget alone is not an opt-in')
    // The board reads `projectId`/`projectNo`/counts and `pendingByProjectNo` off this result and
    // projects its OWN frozen key set, so the union keys being absent is invisible to it — pinned
    // here so a future reader does not "restore" them for the board's benefit.
    for (const project of [...result.projects, ...withTarget.projects]) {
      assert.equal(Object.prototype.hasOwnProperty.call(project, 'sources'), false)
      assert.equal(Object.prototype.hasOwnProperty.call(project, 'lastExportAt'), false)
    }
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'pullTargetReady'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'directoryMayBeIncomplete'), false)
    assert.ok(result.pendingByProjectNo instanceof Map, 'and the channel the board DOES read is intact')
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
