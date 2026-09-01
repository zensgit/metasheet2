'use strict'

// 按项目导出物料 Excel — RED witnesses for the project-scoped stock-prep materials export.
//
//   R1 the route returns a workbook with EXACTLY the agreed columns, in order, for a seeded project
//   R2 rows of OTHER projects never appear (scoping proof)
//   R3 the permission gate refuses an under-privileged principal (stock-prep:read alone; a bare
//      integration:write holder; anonymous)
//   R4 a project with zero ACTIVE rows yields headers-only (empty rows), not an error
//   R5 the audit entry the route appends is values-free (counts/enums only — never a seeded material
//      name, spec or quantity)
//
// plus the module-level (no HTTP) equivalents of R1/R2/R3/R4, and the unknown-project 404 edge case
// (R1..R5 above are all driven through the mounted route; the module suite drives
// exportStockPreparationPrepLines directly, so a route-layer regression and a module-layer regression
// fail independently).
//
// Hermetic: no DB, no network, no xlsx dependency — the injected `stockPreparationXlsxExport` fake
// below stands in for the host-provided buildXlsxBuffer wrapper (packages/core-backend/src/index.ts);
// it is deliberately dumb (JSON-encodes exactly what it was asked to write) so these tests assert on
// the PROJECTION the route computed, not on xlsx binary internals (already covered by core-backend's
// own buildXlsxBuffer vitest suite — see stock-preparation-prep-line-export.cjs's header).

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  EXPORT_COLUMNS,
  StockPreparationPrepLineExportError,
  exportStockPreparationPrepLines,
} = require(path.join(LIB, 'stock-preparation-prep-line-export.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const TENANT_ID = 'tenant-export'
const STAGING = `${TENANT_ID}:integration-core`
const MAIN_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const MAIN_SHEET = 'sheet_main'

const PROJECT_A = 'PRJ-A'
const PROJECT_B = 'PRJ-B'
const PROJECT_EMPTY = 'PRJ-EMPTY-ACTIVE'
const PROJECT_UNKNOWN = 'PRJ-NEVER-SYNCED'

// One row's worth of every export column + the two scope-only fields, so a seed reads like the real
// sheet. Values are synthetic and structurally shaped (never a real customer string).
function mainRow(projectNo, overrides = {}, id) {
  const base = {
    projectNo,
    active: true,
    componentCode: 'DWG-0001',
    componentName: '示例部件',
    ext_spec: 'DN100',
    material: 'Q235B',
    totalQuantity: 4,
    stockPreparationStatus: '20 - 已下单',
    demandDate: '2026-09-10',
    ext_pickingNode: '10 - 示例节点一',
    ext_stockPrepDate: '2026-09-02',
    ext_blankLength: 1250,
  }
  return physicalRow(STAGING, MAIN_OBJECT_ID, { ...base, ...overrides }, id)
}

function seededRows() {
  return [
    mainRow(PROJECT_A, { componentCode: 'DWG-A1', componentName: 'A项目部件一', totalQuantity: 3 }, 'rec_a1'),
    mainRow(PROJECT_A, { componentCode: 'DWG-A2', componentName: 'A项目部件二', totalQuantity: 5 }, 'rec_a2'),
    // A's own inactive row: must be excluded from the active projection but still counts toward "this
    // project is known" (totalRowCount) so it never masquerades as PROJECT_UNKNOWN.
    mainRow(PROJECT_A, { componentCode: 'DWG-A3-OLD', componentName: 'A项目部件三(已停用)', active: false }, 'rec_a3'),
    // B's row — must NEVER appear in an A export (scoping proof) or vice versa.
    mainRow(PROJECT_B, { componentCode: 'DWG-B1', componentName: 'B项目部件一', totalQuantity: 9 }, 'rec_b1'),
    // An empty-but-known project: rows exist, none active.
    mainRow(PROJECT_EMPTY, { componentCode: 'DWG-E1', componentName: '已停用部件', active: false }, 'rec_e1'),
    mainRow(PROJECT_EMPTY, { componentCode: 'DWG-E2', componentName: '已停用部件二', active: false }, 'rec_e2'),
  ]
}

function moduleSubstrate() {
  const provisioning = makeFakeProvisioning({
    stagingProjectId: STAGING,
    sheetIdByObjectId: { [MAIN_OBJECT_ID]: MAIN_SHEET },
  })
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [MAIN_SHEET]: MAIN_OBJECT_ID },
    rowsBySheet: { [MAIN_SHEET]: seededRows() },
  })
  return { provisioning, records }
}

// ---------------------------------------------------------------------------
// module-level suite (no HTTP)
// ---------------------------------------------------------------------------

async function moduleReturnsExactAgreedColumnsForASeededProject() {
  const { provisioning, records } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    provisioning,
    targetProjectId: STAGING,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  assert.deepEqual(result.headers, EXPORT_COLUMNS.map((c) => c.label), 'R1: headers are exactly EXPORT_COLUMNS, in order')
  assert.equal(result.headers.length, 10, 'R1: exactly ten columns')
  assert.equal(result.totalRowCount, 3, 'PROJECT_A has 3 rows total (2 active + 1 inactive)')
  assert.equal(result.activeRowCount, 2, 'PROJECT_A has 2 active rows')
  assert.equal(result.rows.length, 2)
  // Column order in each row matches EXPORT_COLUMNS order: componentCode is column 0.
  const componentCodes = result.rows.map((row) => row[0]).sort()
  assert.deepEqual(componentCodes, ['DWG-A1', 'DWG-A2'], 'R1: exactly the two active PROJECT_A rows, nothing else')
  // Numeric column stays a NUMBER, not a stringified one (buildXlsxBuffer keeps native types).
  const totalQuantityColumn = EXPORT_COLUMNS.findIndex((c) => c.id === 'totalQuantity')
  for (const row of result.rows) assert.equal(typeof row[totalQuantityColumn], 'number')
}

async function moduleNeverLeaksOtherProjectsRows() {
  const { provisioning, records } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    provisioning,
    targetProjectId: STAGING,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  const flat = JSON.stringify(result.rows)
  assert.ok(!flat.includes('DWG-B1'), 'R2: PROJECT_B row id never appears in a PROJECT_A export')
  assert.ok(!flat.includes('B项目部件一'), 'R2: PROJECT_B row content never appears in a PROJECT_A export')

  const resultB = await exportStockPreparationPrepLines({
    recordsApi: records,
    provisioning,
    targetProjectId: STAGING,
    projectNo: PROJECT_B,
    permission: 'admin',
  })
  assert.equal(resultB.rows.length, 1)
  assert.equal(resultB.rows[0][0], 'DWG-B1')
}

async function moduleRefusesNonAdminInternalPermission() {
  const { provisioning, records } = moduleSubstrate()
  await assert.rejects(
    () => exportStockPreparationPrepLines({
      recordsApi: records,
      provisioning,
      targetProjectId: STAGING,
      projectNo: PROJECT_A,
      permission: 'read',
    }),
    (error) => {
      assert.ok(error instanceof StockPreparationPrepLineExportError)
      assert.equal(error.status, 403)
      assert.equal(error.code, 'PREP_LINE_EXPORT_PERMISSION_DENIED')
      return true
    },
    'R3 (module layer): a non-admin internal permission is refused',
  )
}

async function moduleZeroActiveRowsYieldsHeadersOnly() {
  const { provisioning, records } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    provisioning,
    targetProjectId: STAGING,
    projectNo: PROJECT_EMPTY,
    permission: 'admin',
  })
  assert.equal(result.totalRowCount, 2, 'R4: the two inactive rows are seen (this project IS known)')
  assert.equal(result.activeRowCount, 0)
  assert.deepEqual(result.rows, [], 'R4: zero rows, not an error')
  assert.deepEqual(result.headers, EXPORT_COLUMNS.map((c) => c.label), 'R4: headers are still the full agreed set')
}

async function moduleUnknownProjectIsNotFound() {
  const { provisioning, records } = moduleSubstrate()
  await assert.rejects(
    () => exportStockPreparationPrepLines({
      recordsApi: records,
      provisioning,
      targetProjectId: STAGING,
      projectNo: PROJECT_UNKNOWN,
      permission: 'admin',
    }),
    (error) => {
      assert.ok(error instanceof StockPreparationPrepLineExportError)
      assert.equal(error.status, 404)
      assert.equal(error.code, 'PREP_LINE_EXPORT_PROJECT_NOT_FOUND')
      assert.equal(error.details.projectNo, PROJECT_UNKNOWN)
      return true
    },
    'unknown project (never synced — zero rows of ANY status) is 404, not an empty export',
  )
}

async function moduleUnprovisionedSheetIsAlsoNotFound() {
  // The sheet itself was never provisioned (a tenant that has never installed stock-prep at all) —
  // same NOT_FOUND shape as a provisioned sheet with zero matching rows, not a 500/501.
  const provisioning = makeFakeProvisioning({ stagingProjectId: STAGING, sheetIdByObjectId: {} })
  const records = makeStrictRecordsApi({ stagingProjectId: STAGING, objectIdBySheetId: {}, rowsBySheet: {} })
  await assert.rejects(
    () => exportStockPreparationPrepLines({
      recordsApi: records,
      provisioning,
      targetProjectId: STAGING,
      projectNo: PROJECT_A,
      permission: 'admin',
    }),
    (error) => error instanceof StockPreparationPrepLineExportError && error.status === 404,
  )
}

// ---------------------------------------------------------------------------
// route-level suite (mounted through registerIntegrationRoutes)
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

/** A dumb, inspectable xlsx-builder fake: JSON-encodes exactly what it was asked to write. */
function fakeXlsxExport() {
  const calls = []
  return {
    calls,
    async buildWorkbookBuffer(params) {
      calls.push(params)
      return Buffer.from(JSON.stringify(params), 'utf8')
    },
  }
}

function mount() {
  const { provisioning, records } = moduleSubstrate()
  const routes = new Map()
  const auditAppends = []
  const xlsxExport = fakeXlsxExport()
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
      return { ok: true }
    },
  }
  services.stockPreparationXlsxExport = xlsxExport
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, auditAppends, xlsxExport }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    sentBuffer: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    setHeader(name, value) { this.headers[name] = value; return this },
    send(payload) { this.sentBuffer = payload; return this },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  return res
}

const EXPORT_PATH = '/api/integration/stock-preparation/prep-lines/export'

const OPERATOR = Object.freeze({ id: 'u_op', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const READ_ONLY = Object.freeze({ id: 'u_read', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ] })
const INTEGRATION_WRITER = Object.freeze({ id: 'u_writer', tenantId: TENANT_ID, permissions: ['integration:write'] })

function decodedBody(res) {
  assert.ok(Buffer.isBuffer(res.sentBuffer), 'a workbook buffer was sent')
  return JSON.parse(res.sentBuffer.toString('utf8'))
}

async function routeReturnsExactColumnsForSeededProject() {
  const { routes } = mount()
  const res = await call(routes, 'GET', EXPORT_PATH, { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.match(res.headers['Content-Disposition'], /^attachment; filename="stock-prep-PRJ-A-\d{8}T\d{6}Z\.xlsx"$/)
  assert.equal(res.headers['X-Stock-Prep-Export-Row-Count'], '2')
  const built = decodedBody(res)
  assert.deepEqual(built.headers, EXPORT_COLUMNS.map((c) => c.label), 'R1: the workbook the route built carries exactly the agreed columns')
  assert.equal(built.rows.length, 2)
}

async function routeScopingProofOtherProjectRowsNeverAppear() {
  const { routes } = mount()
  const res = await call(routes, 'GET', EXPORT_PATH, { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
  const built = decodedBody(res)
  const flat = JSON.stringify(built.rows)
  assert.ok(!flat.includes('DWG-B1'), 'R2: PROJECT_B never appears in a PROJECT_A route response')
  assert.ok(!flat.includes('B项目部件一'), 'R2: PROJECT_B content never appears in a PROJECT_A route response')
}

async function routeRefusesUnderPrivilegedPrincipals() {
  for (const user of [undefined, READ_ONLY, INTEGRATION_WRITER]) {
    const { routes, xlsxExport } = mount()
    const res = await call(routes, 'GET', EXPORT_PATH, { user, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
    assert.ok([401, 403].includes(res.statusCode), `R3: ${user ? user.id : 'anonymous'} is refused (got ${res.statusCode})`)
    assert.ok(['UNAUTHENTICATED', 'FORBIDDEN'].includes(res.body.error.code), `R3: refused by the GATE, not by something downstream`)
    assert.equal(xlsxExport.calls.length, 0, 'R3: a refused caller never reaches the xlsx builder')
  }
}

async function routeZeroActiveRowsYieldsHeadersOnlyNotAnError() {
  const { routes } = mount()
  const res = await call(routes, 'GET', EXPORT_PATH, { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_EMPTY } })
  assert.equal(res.statusCode, 200, 'R4: zero active rows is a 200, not a 500')
  assert.equal(res.headers['X-Stock-Prep-Export-Row-Count'], '0')
  const built = decodedBody(res)
  assert.deepEqual(built.headers, EXPORT_COLUMNS.map((c) => c.label))
  assert.deepEqual(built.rows, [])
}

async function routeUnknownProjectIsTheFamiliarNotFoundShape() {
  const { routes } = mount()
  const res = await call(routes, 'GET', EXPORT_PATH, { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_UNKNOWN } })
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'PREP_LINE_EXPORT_PROJECT_NOT_FOUND')
  assert.equal(res.body.error.details.projectNo, PROJECT_UNKNOWN)
}

async function routeAuditEntryIsValuesFree() {
  const { routes, auditAppends } = mount()
  const res = await call(routes, 'GET', EXPORT_PATH, { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
  assert.equal(res.statusCode, 200)
  assert.equal(auditAppends.length, 1, 'R5: exactly one audit entry for the export')
  const entry = auditAppends[0]
  assert.equal(entry.action, 'prep_line_export')
  assert.equal(entry.tenantId, TENANT_ID)
  assert.equal(entry.projectId, PROJECT_A, 'the project HANDLE may cross — it is a navigation id, not a material value')
  assert.equal(entry.detail.totalRowCount, 3)
  assert.equal(entry.detail.activeRowCount, 2)
  const flat = JSON.stringify(entry)
  for (const forbidden of ['DWG-A1', 'DWG-A2', 'A项目部件一', 'A项目部件二', 'Q235B', 'DN100']) {
    assert.ok(!flat.includes(forbidden), `R5: audit entry must not carry ${forbidden}`)
  }
}

async function routeRefusedCallerAppendsNoAuditRow() {
  const { routes, auditAppends } = mount()
  await call(routes, 'GET', EXPORT_PATH, { user: READ_ONLY, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
  assert.deepEqual(auditAppends, [], 'a gate-refused caller never reaches the audit store')
}

async function main() {
  await moduleReturnsExactAgreedColumnsForASeededProject()
  await moduleNeverLeaksOtherProjectsRows()
  await moduleRefusesNonAdminInternalPermission()
  await moduleZeroActiveRowsYieldsHeadersOnly()
  await moduleUnknownProjectIsNotFound()
  await moduleUnprovisionedSheetIsAlsoNotFound()

  await routeReturnsExactColumnsForSeededProject()
  await routeScopingProofOtherProjectRowsNeverAppear()
  await routeRefusesUnderPrivilegedPrincipals()
  await routeZeroActiveRowsYieldsHeadersOnlyNotAnError()
  await routeUnknownProjectIsTheFamiliarNotFoundShape()
  await routeAuditEntryIsValuesFree()
  await routeRefusedCallerAppendsNoAuditRow()

  console.log('stock-preparation-prep-line-export (按项目导出物料 Excel): all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
