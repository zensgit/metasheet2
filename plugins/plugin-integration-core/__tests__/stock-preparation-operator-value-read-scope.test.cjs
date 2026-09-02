'use strict'

// THE THREE VALUE-BEARING STOCK-PREP READS, ON ONE SCOPE.
//
// ---------------------------------------------------------------------------
// THE HOLE THIS SUITE CLOSES (pre-existing on main, not introduced by the directory)
// ---------------------------------------------------------------------------
//
// `auth/jwt-middleware.ts` `hydrateAuthenticatedUser` copies the `x-tenant-id` REQUEST HEADER onto
// `req.user.tenantId` whenever the verified token carried no tenant claim. `resolveTenantId` in
// http-routes.cjs then compares the request's tenant against `user.tenantId` — which on such a
// deployment is header-against-header. For a values-free read that is harmless: a count is the same
// count whoever asks. For a VALUE-BEARING read it is a cross-tenant leak, and this plugin has three
// of those:
//
//   1. the per-decision value readback   GET …/confirmation-decisions/value-entry   (O1')
//   2. the project materials Excel       GET …/prep-lines/export                    (#5437)
//   3. the operator project directory    GET …/operator/projects                    (this line)
//
// (3) was built on `stock-preparation-operator-scope.cjs`, which prefers the VERIFIED claim, refuses
// a header that contradicts it, refuses a principal with no tenant of its own, and — the load-bearing
// part on a claimless deployment — makes the HOST vouch for the (user, tenant) pairing. (1) and (2)
// were left on `resolveTenantId`, so at 5b4351d28 a token with no tenant claim plus
// `x-tenant-id: tenant-b` got tenant B's entered values and tenant B's material names back, 200, from
// an operator who belongs to tenant A. This suite is the witness for that, and for its closure.
//
// GUARDS (each RED-witnessed — see the PR body's mutation table):
//   V-01 THE SPOOF IS REFUSED, on all three routes: a tenant-A operator carrying `x-tenant-id:
//        tenant-b` (no verified claim, exactly the middleware's shape) gets 403 and ZERO of tenant B's
//        values, with zero multitable IO.
//   V-02 THE REFUSAL IS NOT VACUOUS: the same three routes serve tenant A's operator tenant A's real
//        values, and tenant B's own operator tenant B's — so V-01 is a refusal, not an empty fixture.
//   V-03 A CONTRADICTED CLAIM is refused before the host is even asked (verified tenant A, carried
//        tenant B) — the cheap refusal really is the first one.
//   V-04 THE PLATFORM SIDE IS OUT of all three: a TENANTLESS platform admin, who `resolveTenantId`
//        would have let steer `tenantId` to any tenant at all, is refused on every value-bearing read.
//   V-05 THE HOST SEAM IS REQUIRED, not fail-open, on all three: absent → 501 and no values.
//   V-06 THE SEAM IS ASKED THE RIGHT QUESTION on all three: exactly the SERVER-DERIVED principal id
//        and the tenant the read will be scoped to.
//   V-07 THE AUDIT ROW NAMES THE VERIFIED TENANT, not the header-carried one — the concrete, durable
//        consequence of the fix on the export, whose sheet (unlike the other two) is not tenant-derived.
//
// ---------------------------------------------------------------------------
// WHAT THE EXPORT LANE DOES AND DOES NOT PROVE — read this before trusting it
// ---------------------------------------------------------------------------
//
// The value-entry read and the directory both locate their SHEET from the verified tenant's staging
// project (`resolveIntegrationStagingProjectId(scope.tenantId)`), so for those two the refusals below
// really are per-tenant ROW isolation.
//
// The export is different, and is deliberately modelled as such here. Since it moved onto the
// table-action target it resolves its sheet from DEPLOY-TIME configuration — one sheet for the whole
// deployment, with no tenant in it anywhere — and the only row-level scoping inside that sheet is
// `projectNo`. So this suite seeds ONE shared export sheet holding both tenants' rows, because that
// is the system that exists. What the export lane therefore proves is that the spoofed, tenantless
// and contradicted callers are REFUSED (before any read, any action lookup, any workbook), and that
// the tenant reaching the action lookup and the audit trail is the verified one. It does NOT prove
// that tenant A cannot name tenant B's `projectNo` on a deployment that shares a sheet: nothing in
// this route stops that today, before or after this change. Making the export's target tenant-scoped
// is a separate change, and this note exists so the green here is not mistaken for it.
//
// Hermetic: no DB, no network, no xlsx (the injected `stockPreparationXlsxExport` fake JSON-encodes
// what it was asked to write).

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
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
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const MAIN_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId

const DIRECTORY_PATH = '/api/integration/stock-preparation/operator/projects'
const VALUE_ENTRY_PATH = '/api/integration/stock-preparation/confirmation-decisions/value-entry'
const EXPORT_PATH = '/api/integration/stock-preparation/prep-lines/export'

const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const STAGING_A = `${TENANT_A}:integration-core`
const STAGING_B = `${TENANT_B}:integration-core`

// The canaries. Planted ONLY in tenant B's value fields; a single occurrence in a response tenant A's
// operator received is the leak, and the assertion names which one.
const SECRET_B_VALUE = 'ZZTENANTBENTEREDVALUEZZ'
const SECRET_B_MATERIAL = 'ZZTENANTBMATERIALNAMEZZ'
const SECRET_B_PROJECT = 'ZZTENANTBPROJECTNAMEZZ'
const ALL_B_SECRETS = [SECRET_B_VALUE, SECRET_B_MATERIAL, SECRET_B_PROJECT]

// Tenant A's own values — the positive control. If tenant A cannot see THESE, the guards below are
// asserting nothing but a broken route.
const A_VALUE = 'A-ENTERED-VALUE'
const A_MATERIAL = 'A项目部件一'
const A_PROJECT_NAME = 'RY2注射水缓冲罐部件'

const PROJECT_NO_A = '230920006'
const PROJECT_NO_B = '230920099'
const DECISION_A = 'decision_a_1'
const DECISION_B = 'decision_b_1'
const FINGERPRINT = 'sha16:0123456789abcdef'

const SHEETS = Object.freeze({
  projectA: 'sheet_project_a',
  projectB: 'sheet_project_b',
  ledgerA: 'sheet_ledger_a',
  ledgerB: 'sheet_ledger_b',
  // THE EXPORT SHEET IS SINGULAR ON PURPOSE — see the note in the header. The export route resolves
  // its target from the DEPLOY-TIME table-action config, which is one sheet for the whole
  // deployment, so modelling it as two would be modelling a system that does not exist.
  mainShared: 'sheet_main_shared',
})

// ---------------------------------------------------------------------------
// actors
// ---------------------------------------------------------------------------

const OPERATOR_A = Object.freeze({ id: 'u_op_a', tenantId: TENANT_A, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const OPERATOR_B = Object.freeze({ id: 'u_op_b', tenantId: TENANT_B, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
/**
 * THE SPOOF, in exactly the shape the middleware produces. The token carried NO tenant claim (so
 * `req.authenticatedTenantId` is absent), and `x-tenant-id: tenant-b` was copied onto `user.tenantId`.
 * The principal is really tenant A's operator: the host directory below knows that, and it is the
 * only thing in the request that does.
 */
const OPERATOR_A_SPOOFING_B = Object.freeze({ id: 'u_op_a', tenantId: TENANT_B, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
/** TENANTLESS platform admin — us / the consultant. `resolveTenantId` lets them steer `tenantId`. */
const PLATFORM_ADMIN_TENANTLESS = Object.freeze({ id: 'u_adm_platform', roles: ['admin'], permissions: ['integration:admin'] })

/**
 * THE REAL MEMBERSHIP RELATION, as the host would answer it. `u_op_a` is in tenant A and nothing else;
 * `u_op_b` is in tenant B and nothing else. This is what makes the header spoof answerable at all —
 * a seam that admitted every pairing would leave V-01 green for the wrong reason, so V-02 drives the
 * same seam to a `true` for the legitimate pairings.
 */
const MEMBERSHIPS = Object.freeze({
  u_op_a: [TENANT_A],
  u_op_b: [TENANT_B],
  u_adm_platform: [],
})

function hostDirectory() {
  const calls = []
  return {
    calls,
    async verifyTenantMembership(input) {
      calls.push(input)
      const tenants = MEMBERSHIPS[input && input.userId] || []
      return { member: tenants.includes(input && input.tenantId) }
    },
  }
}

// The pack columns a real provisioning run binds alongside the frozen template's (same list the
// prep-line export suite uses) — the export refuses a target that does not bind the whole band.
const PACK_FIELD_IDS = Object.freeze([
  'ext_parentDrawingNo', 'ext_parentName', 'ext_spec', 'ext_pickingNode', 'ext_stockPrepDate', 'ext_blankLength',
])

/**
 * THE DEPLOY-TIME TABLE ACTION the export resolves its target through. Note the shape of the thing:
 * ONE sheet, configured per DEPLOYMENT, with no tenant in it anywhere. That is why this suite models
 * a single shared export sheet — see the header note.
 */
function exportTableActionConfig() {
  const fieldIds = [
    ...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id),
    ...PACK_FIELD_IDS,
  ]
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
    target: {
      sheetId: SHEETS.mainShared,
      objectId: MAIN_OBJECT_ID,
      fieldIdMap: Object.fromEntries(fieldIds.map((fieldId) => [fieldId, physicalFieldId(STAGING_A, MAIN_OBJECT_ID, fieldId)])),
    },
  }
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
    bridgeAgentChecklistStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForApply']),
  }
}

function row(stagingProjectId, objectId, sheetId, recordId, fields) {
  const record = physicalRow(stagingProjectId, objectId, fields, recordId)
  record.sheetId = sheetId
  return record
}

function mainRow(stagingProjectId, sheetId, recordId, projectNo, componentName) {
  return row(stagingProjectId, MAIN_OBJECT_ID, sheetId, recordId, {
    projectNo,
    active: true,
    componentCode: `DWG-${recordId}`,
    componentName,
    ext_spec: 'DN100',
    material: 'Q235B',
    totalQuantity: 4,
    stockPreparationStatus: '20 - 已下单',
    demandDate: '2026-09-10',
    ext_pickingNode: '10 - 示例节点一',
    ext_stockPrepDate: '2026-09-02',
    ext_blankLength: 1250,
  })
}

/**
 * A TWO-TENANT substrate carrying, for each tenant, all three value-bearing surfaces: the project
 * table (directory), the confirmation-decision ledger (value entry) and the canonical main table
 * (export). Tenant B's rows genuinely exist and are genuinely reachable BY TENANT B — without that,
 * "tenant A did not see them" would prove nothing.
 */
function mount({ tenantPrincipalDirectory = hostDirectory() } = {}) {
  const routes = new Map()

  const provisioningA = makeFakeProvisioning({
    stagingProjectId: STAGING_A,
    sheetIdByObjectId: {
      [PROJECT_OBJECT_ID]: SHEETS.projectA,
      [DECISION_OBJECT_ID]: SHEETS.ledgerA,
      [MAIN_OBJECT_ID]: SHEETS.mainShared,
    },
  })
  const provisioningB = makeFakeProvisioning({
    stagingProjectId: STAGING_B,
    sheetIdByObjectId: {
      [PROJECT_OBJECT_ID]: SHEETS.projectB,
      [DECISION_OBJECT_ID]: SHEETS.ledgerB,
    },
  })

  const recordsA = makeStrictRecordsApi({
    stagingProjectId: STAGING_A,
    objectIdBySheetId: {
      [SHEETS.projectA]: PROJECT_OBJECT_ID,
      [SHEETS.ledgerA]: DECISION_OBJECT_ID,
      [SHEETS.mainShared]: MAIN_OBJECT_ID,
    },
    rowsBySheet: {
      [SHEETS.projectA]: [
        row(STAGING_A, PROJECT_OBJECT_ID, SHEETS.projectA, 'rec_pa', {
          projectId: 'stockprep_project_a1',
          sourceProjectNo: PROJECT_NO_A,
          projectName: A_PROJECT_NAME,
          projectStatus: 'active',
          lastSyncRunId: 'run_a1',
        }),
      ],
      [SHEETS.ledgerA]: [
        row(STAGING_A, DECISION_OBJECT_ID, SHEETS.ledgerA, 'rec_da', {
          decisionId: DECISION_A,
          projectNo: PROJECT_NO_A,
          conflictType: FIRST_CUT_CONFLICT_TYPE,
          status: STATUSES.CONFIRMED,
          inputFingerprint: FINGERPRINT,
          resolvedValue: A_VALUE,
        }),
      ],
      // BOTH tenants' material rows live here, because on a real deployment they do: the export's
      // sheet is deploy-time, not per-tenant, and `projectNo` is the only row-level scoping in it.
      [SHEETS.mainShared]: [
        mainRow(STAGING_A, SHEETS.mainShared, 'rec_ma', PROJECT_NO_A, A_MATERIAL),
        mainRow(STAGING_A, SHEETS.mainShared, 'rec_mb', PROJECT_NO_B, SECRET_B_MATERIAL),
      ],
    },
  })
  const recordsB = makeStrictRecordsApi({
    stagingProjectId: STAGING_B,
    objectIdBySheetId: {
      [SHEETS.projectB]: PROJECT_OBJECT_ID,
      [SHEETS.ledgerB]: DECISION_OBJECT_ID,
    },
    rowsBySheet: {
      [SHEETS.projectB]: [
        row(STAGING_B, PROJECT_OBJECT_ID, SHEETS.projectB, 'rec_pb', {
          projectId: 'stockprep_project_b1',
          sourceProjectNo: PROJECT_NO_B,
          projectName: SECRET_B_PROJECT,
          projectStatus: 'active',
          lastSyncRunId: 'run_b1',
        }),
      ],
      [SHEETS.ledgerB]: [
        row(STAGING_B, DECISION_OBJECT_ID, SHEETS.ledgerB, 'rec_db', {
          decisionId: DECISION_B,
          projectNo: PROJECT_NO_B,
          conflictType: FIRST_CUT_CONFLICT_TYPE,
          status: STATUSES.CONFIRMED,
          inputFingerprint: FINGERPRINT,
          resolvedValue: SECRET_B_VALUE,
        }),
      ],
    },
  })

  // Counted, so "refused before any multitable IO" is measured rather than argued.
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

  const B_SHEETS = new Set([SHEETS.projectB, SHEETS.ledgerB])
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
      return B_SHEETS.has(input && input.sheetId) ? recordsB.queryRecords(input) : recordsA.queryRecords(input)
    },
    async createRecord() {
      throw new Error('unexpected records write: createRecord')
    },
    async patchRecord() {
      throw new Error('unexpected records write: patchRecord')
    },
  })

  const auditAppends = []
  const xlsxCalls = []
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
    config: { stockPreparationTableActions: [exportTableActionConfig()] },
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      auditAppends.push(entry)
      return { ok: true }
    },
  }
  services.stockPreparationXlsxExport = {
    async buildWorkbookBuffer(params) {
      xlsxCalls.push(params)
      return Buffer.from(JSON.stringify(params), 'utf8')
    },
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
    xlsxCalls,
    tenantPrincipalDirectory,
    hostCallCount: () => hostCalls,
  }
}

/** Models Express's one-way door: `sentBody` is the FIRST write and never changes afterwards. */
function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    sentBody: undefined,
    sent: false,
    headers: {},
    status(code) { this.statusCode = code; return this },
    _write(payload) {
      this.body = payload
      if (!this.sent) {
        this.sent = true
        this.sentBody = payload
      }
      return this
    },
    json(payload) { return this._write(payload) },
    setHeader(name, value) { this.headers[name] = value; return this },
    send(payload) { return this._write(payload) },
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

/**
 * EVERY BYTE the caller received, whatever the route's content type. The export streams a Buffer and
 * the other two send JSON; a leak check that only looked at `res.body` as an object would be blind to
 * exactly the surface that carries the most values.
 */
function everythingSent(res) {
  const parts = []
  for (const payload of [res.sentBody, res.body]) {
    if (payload === undefined) continue
    parts.push(Buffer.isBuffer(payload) ? payload.toString('utf8') : JSON.stringify(payload))
  }
  parts.push(JSON.stringify(res.headers))
  return parts.join('\n')
}

/** The three value-bearing reads, each with the request shape that would return VALUES if permitted. */
const VALUE_READS = Object.freeze([
  Object.freeze({
    label: 'operator project directory',
    method: 'GET',
    path: DIRECTORY_PATH,
    request: () => ({ query: {} }),
    aValue: A_PROJECT_NAME,
    bSecret: SECRET_B_PROJECT,
    bRequest: () => ({ query: {} }),
  }),
  Object.freeze({
    label: 'per-decision value readback',
    method: 'GET',
    path: VALUE_ENTRY_PATH,
    request: () => ({ query: { decisionId: DECISION_A } }),
    aValue: A_VALUE,
    bSecret: SECRET_B_VALUE,
    // Tenant B's own decision id — the row a spoofing tenant-A caller would be reaching for.
    spoofRequest: () => ({ query: { decisionId: DECISION_B } }),
    bRequest: () => ({ query: { decisionId: DECISION_B } }),
  }),
  Object.freeze({
    label: 'project materials Excel export',
    method: 'GET',
    path: EXPORT_PATH,
    request: () => ({ query: { projectNo: PROJECT_NO_A } }),
    aValue: A_MATERIAL,
    bSecret: SECRET_B_MATERIAL,
    spoofRequest: () => ({ query: { projectNo: PROJECT_NO_B } }),
    bRequest: () => ({ query: { projectNo: PROJECT_NO_B } }),
  }),
])

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
  // V-01 THE SPOOF IS REFUSED — the P1
  // -------------------------------------------------------------------------

  for (const read of VALUE_READS) {
    await run(`V-01 ${read.label}: an x-tenant-id header cannot buy another tenant's values`, async () => {
      const harness = mount()
      const request = (read.spoofRequest || read.request)()
      const res = await call(harness.routes, read.method, read.path, {
        user: OPERATOR_A_SPOOFING_B,
        // No verified claim — the tenant-claimless deployment where the header fallback is LIVE.
        authenticatedTenantId: undefined,
        ...request,
      })
      assert.equal(res.statusCode, 403, `${read.label} must refuse the spoof (got ${res.statusCode} ${JSON.stringify(res.body && res.body.error)})`)
      assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED',
        'the host — the only party that knows the truth — is what refuses it')
      const sent = everythingSent(res)
      for (const secret of ALL_B_SECRETS) {
        assert.equal(sent.includes(secret), false, `${read.label} must not leak ${secret}`)
      }
      assert.equal(harness.hostCallCount(), 0, 'a refused caller costs zero multitable IO')
      assert.deepEqual(harness.auditAppends, [], 'and writes no audit row')
      assert.deepEqual(harness.xlsxCalls, [], 'and builds no workbook')
    })
  }

  // -------------------------------------------------------------------------
  // V-02 …AND THE REFUSAL IS NOT VACUOUS
  // -------------------------------------------------------------------------

  for (const read of VALUE_READS) {
    await run(`V-02a ${read.label}: tenant A's operator DOES get tenant A's values`, async () => {
      const harness = mount()
      const res = await call(harness.routes, read.method, read.path, { user: OPERATOR_A, ...read.request() })
      assert.equal(res.statusCode, 200, `${read.label} must serve its own tenant (got ${JSON.stringify(res.body && res.body.error)})`)
      const sent = everythingSent(res)
      assert.equal(sent.includes(read.aValue), true, `${read.label} must carry ${read.aValue} to its own operator`)
      for (const secret of ALL_B_SECRETS) {
        assert.equal(sent.includes(secret), false, `${read.label} must never carry ${secret}`)
      }
    })

    await run(`V-02b ${read.label}: tenant B IS reachable — by tenant B's own operator`, async () => {
      const harness = mount()
      const res = await call(harness.routes, read.method, read.path, { user: OPERATOR_B, ...read.bRequest() })
      assert.equal(res.statusCode, 200, `${read.label} must serve tenant B's own operator`)
      // The canary really is in the substrate and really is reachable BY SOMEONE, so V-01's "it did
      // not appear" is a REFUSAL rather than an empty fixture. For the two tenant-derived reads that
      // is also per-tenant sheet scoping; for the export it is not — see the header note.
      assert.equal(everythingSent(res).includes(read.bSecret), true,
        'tenant B\'s data genuinely exists and is genuinely reachable, so V-01 is not vacuous')
    })
  }

  // -------------------------------------------------------------------------
  // V-03 A CONTRADICTED CLAIM IS THE CHEAPEST REFUSAL
  // -------------------------------------------------------------------------

  for (const read of VALUE_READS) {
    await run(`V-03 ${read.label}: a carried tenant that contradicts the VERIFIED claim never reaches the host`, async () => {
      const harness = mount()
      const request = (read.spoofRequest || read.request)()
      const res = await call(harness.routes, read.method, read.path, {
        user: OPERATOR_A_SPOOFING_B,
        // The token DID say tenant A this time; the header still says tenant B.
        authenticatedTenantId: TENANT_A,
        ...request,
      })
      assert.equal(res.statusCode, 403)
      assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_CONTRADICTED')
      assert.equal(harness.tenantPrincipalDirectory.calls.length, 0,
        'decidable from the principal alone, so the host is not even asked')
      assert.equal(harness.hostCallCount(), 0)
      const sent = everythingSent(res)
      for (const secret of ALL_B_SECRETS) assert.equal(sent.includes(secret), false)
    })
  }

  // -------------------------------------------------------------------------
  // V-04 THE PLATFORM SIDE IS OUT OF ALL THREE
  // -------------------------------------------------------------------------

  for (const read of VALUE_READS) {
    await run(`V-04 ${read.label}: a TENANTLESS platform admin is refused the values`, async () => {
      const harness = mount()
      // The steering `resolveTenantId` used to honour for exactly this principal.
      const request = (read.spoofRequest || read.request)()
      const query = { ...(request.query || {}), tenantId: TENANT_B }
      const res = await call(harness.routes, read.method, read.path, {
        user: PLATFORM_ADMIN_TENANTLESS,
        ...request,
        query,
      })
      assert.equal(res.statusCode, 403)
      assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_REQUIRED')
      assert.equal(harness.hostCallCount(), 0)
      const sent = everythingSent(res)
      for (const secret of ALL_B_SECRETS) assert.equal(sent.includes(secret), false)
    })
  }

  // -------------------------------------------------------------------------
  // V-05 THE HOST SEAM IS REQUIRED ON ALL THREE
  // -------------------------------------------------------------------------

  for (const read of VALUE_READS) {
    await run(`V-05 ${read.label}: absent host directory 501s — it does not fail open onto user.tenantId`, async () => {
      const harness = mount({ tenantPrincipalDirectory: null })
      const res = await call(harness.routes, read.method, read.path, { user: OPERATOR_A, ...read.request() })
      assert.equal(res.statusCode, 501)
      assert.equal(errorCode(res), 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE')
      assert.equal(harness.hostCallCount(), 0)
      assert.equal(everythingSent(res).includes(read.aValue), false, 'not even the caller\'s OWN values, when nobody can vouch')
    })
  }

  // -------------------------------------------------------------------------
  // V-06 THE SEAM IS ASKED THE RIGHT QUESTION
  // -------------------------------------------------------------------------

  for (const read of VALUE_READS) {
    await run(`V-06 ${read.label}: the host is asked about the SERVER-DERIVED principal and the scoped tenant`, async () => {
      const harness = mount()
      const res = await call(harness.routes, read.method, read.path, {
        user: OPERATOR_A,
        authenticatedTenantId: TENANT_A,
        ...read.request(),
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(harness.tenantPrincipalDirectory.calls, [{ userId: OPERATOR_A.id, tenantId: TENANT_A }],
        'exactly one question, with exactly the two server-derived identity strings')
    })
  }

  // -------------------------------------------------------------------------
  // V-07 THE AUDIT TRAIL NAMES THE VERIFIED TENANT
  // -------------------------------------------------------------------------

  await run('V-07 the export audit row records the VERIFIED tenant, never the carried header one', async () => {
    const harness = mount()
    const res = await call(harness.routes, 'GET', EXPORT_PATH, {
      // Verified tenant A; the request ALSO echoes tenant A (compatibility), so this is a legitimate
      // call — the question is which of the two the trail records.
      user: OPERATOR_A,
      authenticatedTenantId: TENANT_A,
      query: { projectNo: PROJECT_NO_A, tenantId: TENANT_A },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(harness.auditAppends.length, 1)
    assert.equal(harness.auditAppends[0].tenantId, TENANT_A)
    // ...and the spoofed call leaves NO row at all, so a leak attempt cannot be laundered into the
    // trail under a tenant the caller merely asserted.
    const spoofed = mount()
    const refused = await call(spoofed.routes, 'GET', EXPORT_PATH, {
      user: OPERATOR_A_SPOOFING_B,
      authenticatedTenantId: undefined,
      query: { projectNo: PROJECT_NO_B },
    })
    assert.equal(refused.statusCode, 403)
    assert.deepEqual(spoofed.auditAppends, [], 'a refused export writes nothing to the trail')
  })

  if (failures > 0) {
    console.error(`\n${failures} guard(s) FAILED`)
    process.exitCode = 1
  } else {
    console.log('\nall operator value-read scope guards passed')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
