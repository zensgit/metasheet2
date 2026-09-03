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
// PLUS (W2-3 / #5447 follow-up) the five departmental completion columns 采购完成/采购回复日期/
// 仓库完成/实际到货日期/自制外购, appended after the original twelve:
//   R12 the workbook carries all SEVENTEEN columns, in the agreed order, for a seeded project
//   R13 procurementDone/warehouseDone render 是/否 text, never a native boolean, and an unset flag
//       is a blank cell rather than 否
//   R14 procurementReplyDate/actualArrivalDate pass through unchanged, exactly like the pre-existing
//       demandDate column
//   R15 a sheet whose target predates #5447 (no bindings for the five columns) still exports the
//       original twelve, with the five reported in unresolvedColumns — never a 500
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

const { createStockPreparationAuditStore } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
// The ONE stock-prep table action every route in this family defaults to — the same constant the
// dry-run / apply / mvp-persist handlers use to reach their target.
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  EXPORT_COLUMNS,
  EXPORT_SOURCE_FIELD_IDS,
  StockPreparationPrepLineExportError,
  exportStockPreparationPrepLines,
} = require(path.join(LIB, 'stock-preparation-prep-line-export.cjs'))
const {
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const TENANT_ID = 'tenant-export'
const STAGING = `${TENANT_ID}:integration-core`
const MAIN_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const MAIN_SHEET = 'sheet_main'

const PROJECT_A = 'PRJ-A'
const PROJECT_FREE_TEXT = '注射水缓冲罐 / RY2-2023'
const PROJECT_B = 'PRJ-B'
const PROJECT_EMPTY = 'PRJ-EMPTY-ACTIVE'
const PROJECT_UNKNOWN = 'PRJ-NEVER-SYNCED'
// A sheet caught mid-migration: one row written by the current apply path (native columns), one
// written before this change (pack columns only), one whose native cell is an empty string.
const PROJECT_MIXED = 'PRJ-MIXED-SOURCES'

// One row's worth of every export column + the two scope-only fields, so a seed reads like the real
// sheet. Values are synthetic and structurally shaped (never a real customer string).
function mainRow(projectNo, overrides = {}, id) {
  const base = {
    projectNo,
    active: true,
    // The three PLM columns 备料主表 gained (父组件图号 / 父组件名称 / 规格) AND the customer-pack
    // ext_ columns that carried the same data until now — a real sheet on a pack-carrying
    // deployment holds both bands, so the seed does too.
    parentComponentCode: 'TZ-A0',
    parentComponentName: 'A项目主体',
    componentSpec: 'DN100',
    componentCode: 'DWG-0001',
    componentName: '示例部件',
    ext_parentDrawingNo: 'TZ-A0',
    ext_parentName: 'A项目主体',
    ext_spec: 'DN100',
    material: 'Q235B',
    totalQuantity: 4,
    stockPreparationStatus: '20 - 已下单',
    demandDate: '2026-09-10',
    ext_pickingNode: '10 - 示例节点一',
    ext_stockPrepDate: '2026-09-02',
    ext_blankLength: 1250,
    // The five #5447 human_preserved completion columns (W2-3). Booleans and dates so R12-R14 have
    // real typed values to assert formatting on, not just presence.
    makeOrBuy: '外购',
    procurementDone: true,
    procurementReplyDate: '2026-09-05',
    warehouseDone: false,
    actualArrivalDate: '2026-09-12',
  }
  return physicalRow(STAGING, MAIN_OBJECT_ID, { ...base, ...overrides }, id)
}

function seededRows() {
  return [
    // A project whose NUMBER is free text — Chinese, a space and a slash, i.e. outside the audit
    // store's enum/handle pattern. It has real rows, so the export reaches its audit append: this is
    // the row that turns a shape gate on `project_id` into a refused workbook (R5b).
    mainRow(PROJECT_FREE_TEXT, { componentCode: 'DWG-F1', componentName: '自由文本项目部件', totalQuantity: 1 }, 'rec_f1'),
    mainRow(PROJECT_A, { componentCode: 'DWG-A1', componentName: 'A项目部件一', totalQuantity: 3 }, 'rec_a1'),
    // rec_a2 deliberately leaves the two completion flags UNSET (never assigned, not merely false) —
    // R13's blank-cell witness: a flag nobody has touched must render as an empty cell, never 否.
    mainRow(PROJECT_A, {
      componentCode: 'DWG-A2', componentName: 'A项目部件二', totalQuantity: 5,
      procurementDone: undefined, warehouseDone: undefined,
    }, 'rec_a2'),
    // A's own inactive row: must be excluded from the active projection but still counts toward "this
    // project is known" (totalRowCount) so it never masquerades as PROJECT_UNKNOWN.
    mainRow(PROJECT_A, { componentCode: 'DWG-A3-OLD', componentName: 'A项目部件三(已停用)', active: false }, 'rec_a3'),
    // B's row — must NEVER appear in an A export (scoping proof) or vice versa.
    mainRow(PROJECT_B, { componentCode: 'DWG-B1', componentName: 'B项目部件一', totalQuantity: 9 }, 'rec_b1'),
    // An empty-but-known project: rows exist, none active.
    mainRow(PROJECT_EMPTY, { componentCode: 'DWG-E1', componentName: '已停用部件', active: false }, 'rec_e1'),
    mainRow(PROJECT_EMPTY, { componentCode: 'DWG-E2', componentName: '已停用部件二', active: false }, 'rec_e2'),
    // NATIVE-vs-PACK. Row 1 carries both bands, disagreeing — the native column is the one the pull
    // maintains, so it must win. Row 2 is every row that exists on the day this ships: pack only.
    // Row 3 pins that an EMPTY native cell is blank, not a value that shadows the pack column.
    mainRow(PROJECT_MIXED, {
      componentCode: 'DWG-M-NATIVE',
      parentComponentCode: 'TZ-NATIVE', parentComponentName: '主体-NATIVE', componentSpec: 'DN200-NATIVE',
      ext_parentDrawingNo: 'TZ-PACK-STALE', ext_parentName: '主体-PACK-STALE', ext_spec: 'DN200-PACK-STALE',
    }, 'rec_m1'),
    mainRow(PROJECT_MIXED, {
      componentCode: 'DWG-M-LEGACY',
      parentComponentCode: undefined, parentComponentName: undefined, componentSpec: undefined,
      ext_parentDrawingNo: 'TZ-PACK', ext_parentName: '主体-PACK', ext_spec: 'DN300-PACK',
    }, 'rec_m2'),
    mainRow(PROJECT_MIXED, {
      componentCode: 'DWG-M-BLANK',
      parentComponentCode: '', parentComponentName: '   ', componentSpec: '',
      ext_parentDrawingNo: 'TZ-PACK2', ext_parentName: '主体-PACK2', ext_spec: 'DN400-PACK',
    }, 'rec_m3'),
  ]
}

// THE TARGET THE APPLY PATH WRITES — the whole point of the read-side fix.
//
// The export used to locate its sheet by hardcoding the canonical objectId and resolving it through
// provisioning. On a default install that is the WRONG TABLE and it is always empty: apply is
// sandbox-only unless an owner configured a production policy, and the sandbox gate rejects the
// canonical objectId outright, so the rows are in the sandbox twin. The export now takes the bound
// table action's `target` — the same `{ sheetId, fieldIdMap }` the writer writes through.
//
// Both sheets below are seeded, always, with DIFFERENT content: whichever one the target does not
// name is a DECOY. A regression that reintroduces a hardcoded table therefore cannot pass by
// accident — it returns the decoy's rows, or 404, and the assertion names which.
//
// FIXTURE LIMITATION, stated rather than hidden: makeStrictRecordsApi validates physical field ids
// against a FROZEN template looked up by objectId, and a real sandbox twin's restamped objectId has
// no entry in that registry. So both sheets are registered under the canonical objectId here. That
// is faithful on the point under test — the twin IS the canonical template restamped, and the thing
// that differs between the two deployments is the SHEET the action is bound to, which is exactly
// what `target.sheetId` selects and exactly what the defect got wrong.
const SANDBOX_SHEET = 'sheet_stock_prep_sandbox_twin'

// A target as real provisioning builds it: EVERY template column bound, plus the pack's ext_ ones.
// (The deploy-time completeness gate — assertTargetFieldMapCompleteness — independently REQUIRES an
// explicit map to bind the whole plm_system band + declared extension ids, so a route-level mount
// with anything less is refused before the export module is ever reached. The module's own
// tolerance for an unbound DISPLAY column is therefore defence in depth, exercised directly at the
// module level below.)
const PACK_FIELD_IDS = Object.freeze(['ext_parentDrawingNo', 'ext_parentName', 'ext_spec', 'ext_pickingNode', 'ext_stockPrepDate', 'ext_blankLength'])

function targetFor(sheetId) {
  const fieldIds = [
    ...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id),
    ...PACK_FIELD_IDS,
  ]
  return {
    sheetId,
    fieldIdMap: Object.fromEntries(fieldIds.map((fieldId) => [fieldId, physicalFieldId(STAGING, MAIN_OBJECT_ID, fieldId)])),
  }
}

/** Rows that must NEVER reach a workbook: they live in whichever sheet the action is not bound to. */
function decoyRows() {
  return [
    mainRow(PROJECT_A, { componentCode: 'DWG-DECOY-1', componentName: '错误表里的行', totalQuantity: 999 }, 'rec_decoy1'),
    mainRow(PROJECT_B, { componentCode: 'DWG-DECOY-2', componentName: '错误表里的行二' }, 'rec_decoy2'),
  ]
}

// `boundSheet` is the sheet the deployment's table action points at: SANDBOX_SHEET models a default
// install (apply wrote the twin), MAIN_SHEET models an owner-configured production one.
function moduleSubstrate({ boundSheet = SANDBOX_SHEET } = {}) {
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [MAIN_SHEET]: MAIN_OBJECT_ID, [SANDBOX_SHEET]: MAIN_OBJECT_ID },
    rowsBySheet: {
      [MAIN_SHEET]: boundSheet === MAIN_SHEET ? seededRows() : decoyRows(),
      [SANDBOX_SHEET]: boundSheet === SANDBOX_SHEET ? seededRows() : decoyRows(),
    },
  })
  return { records, target: targetFor(boundSheet) }
}

/** A target that does not bind the named logical ids (an unhealed / packless deployment). */
function targetWithout(target, absentFieldIds) {
  const fieldIdMap = { ...target.fieldIdMap }
  for (const fieldId of absentFieldIds) delete fieldIdMap[fieldId]
  return { ...target, fieldIdMap }
}

// ---------------------------------------------------------------------------
// module-level suite (no HTTP)
// ---------------------------------------------------------------------------

async function moduleReturnsExactAgreedColumnsForASeededProject() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  assert.deepEqual(result.headers, EXPORT_COLUMNS.map((c) => c.label), 'R1: headers are exactly EXPORT_COLUMNS, in order')
  assert.equal(result.headers.length, 17, 'R1/R12: seventeen columns (#5447 added five completion columns after the original twelve)')
  assert.equal(result.totalRowCount, 3, 'PROJECT_A has 3 rows total (2 active + 1 inactive)')
  assert.equal(result.activeRowCount, 2, 'PROJECT_A has 2 active rows')
  assert.equal(result.rows.length, 2)
  // Column order in each row matches EXPORT_COLUMNS order: the two parent columns come first,
  // so 图号 is no longer column 0 — read it by its declared position rather than by a literal index.
  const codeColumn = EXPORT_COLUMNS.findIndex((c) => c.id === 'componentCode')
  assert.equal(codeColumn, 2, 'R1: 父组件图号 / 父组件名称 precede 图号, in the owner-spec order')
  const componentCodes = result.rows.map((row) => row[codeColumn]).sort()
  assert.deepEqual(componentCodes, ['DWG-A1', 'DWG-A2'], 'R1: exactly the two active PROJECT_A rows, nothing else')
  // Numeric column stays a NUMBER, not a stringified one (buildXlsxBuffer keeps native types).
  const totalQuantityColumn = EXPORT_COLUMNS.findIndex((c) => c.id === 'totalQuantity')
  for (const row of result.rows) assert.equal(typeof row[totalQuantityColumn], 'number')
}

async function moduleNeverLeaksOtherProjectsRows() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  const flat = JSON.stringify(result.rows)
  assert.ok(!flat.includes('DWG-B1'), 'R2: PROJECT_B row id never appears in a PROJECT_A export')
  assert.ok(!flat.includes('B项目部件一'), 'R2: PROJECT_B row content never appears in a PROJECT_A export')

  const resultB = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_B,
    permission: 'admin',
  })
  assert.equal(resultB.rows.length, 1)
  assert.equal(resultB.rows[0][EXPORT_COLUMNS.findIndex((c) => c.id === 'componentCode')], 'DWG-B1')
}

async function moduleRefusesNonAdminInternalPermission() {
  const { records, target } = moduleSubstrate()
  await assert.rejects(
    () => exportStockPreparationPrepLines({
      recordsApi: records,
      target,
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
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_EMPTY,
    permission: 'admin',
  })
  assert.equal(result.totalRowCount, 2, 'R4: the two inactive rows are seen (this project IS known)')
  assert.equal(result.activeRowCount, 0)
  assert.deepEqual(result.rows, [], 'R4: zero rows, not an error')
  assert.deepEqual(result.headers, EXPORT_COLUMNS.map((c) => c.label), 'R4: headers are still the full agreed set')
}

async function moduleUnknownProjectIsNotFound() {
  const { records, target } = moduleSubstrate()
  await assert.rejects(
    () => exportStockPreparationPrepLines({
      recordsApi: records,
      target,
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

async function moduleMissingTargetIsAConfigRefusalNotA500() {
  // The action is not configured / carries no target: a 422 config refusal, the same shape every
  // other stock-prep route gives an unconfigured deployment — never a 500 and never a silent read of
  // some other table. (The old 'sheet was never provisioned' case is gone with the provisioning
  // lookup itself: there is no sheet to discover, only a target the deployment either bound or not.)
  const { records } = moduleSubstrate()
  for (const badTarget of [undefined, {}, { sheetId: '  ' }]) {
    await assert.rejects(
      () => exportStockPreparationPrepLines({
        recordsApi: records,
        target: badTarget,
        projectNo: PROJECT_A,
        permission: 'admin',
      }),
      (error) => {
        assert.ok(error instanceof StockPreparationPrepLineExportError)
        assert.equal(error.status, 422)
        assert.equal(error.code, 'PREP_LINE_EXPORT_CONFIG_INVALID')
        return true
      },
      'an unbound target is a config refusal',
    )
  }
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

// The deploy-time table action the routes read their target off — the SAME config shape apply and
// dry-run are driven by. `boundSheet` decides which deployment this mount models:
//   SANDBOX_SHEET — a DEFAULT install: apply is sandbox-only, so the twin holds the rows.
//   MAIN_SHEET    — an owner-configured PRODUCTION install: the canonical table holds the rows.
// Neither is named inside the export module; both are the same code path with a different binding.
function tableActionConfigFor(target) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
    target: { sheetId: target.sheetId, objectId: MAIN_OBJECT_ID, fieldIdMap: target.fieldIdMap },
  }
}

function mount({ boundSheet = SANDBOX_SHEET, realAuditStore = false } = {}) {
  const { records, target } = moduleSubstrate({ boundSheet })
  const routes = new Map()
  const auditAppends = []
  const xlsxExport = fakeXlsxExport()
  // Counts every host read the handler makes, so "refused BEFORE any host IO" is an assertion rather
  // than an inference from the absence of a workbook.
  const hostReads = []
  const countingRecords = {
    ...records,
    async queryRecords(input) {
      hostReads.push({ api: 'records.queryRecords', sheetId: input && input.sheetId })
      return records.queryRecords(input)
    },
  }
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: { records: countingRecords },
    },
    storage: new Map(),
    config: { stockPreparationTableActions: [tableActionConfigFor(target)] },
  }
  const services = baseServices()
  // THE REAL STORE, OPTIONALLY. The stub below records what the route MEANT to write; it cannot see
  // what the store would REFUSE. A shape gate on a caller-supplied column is exactly the class of
  // bug a stub hides — the route looks fine and the deployment 422s — so the free-text case drives
  // the production store over an in-memory db instead.
  const auditRows = []
  services.stockPreparationAuditStore = realAuditStore
    ? createStockPreparationAuditStore({
      db: {
        async insertOne(table, row) { auditRows.push({ table, row: { ...row } }); return { ...row } },
        async select() { return [] },
      },
      idGenerator: () => `audit_${auditRows.length + 1}`,
    })
    : {
      async append(entry) {
        auditAppends.push(entry)
        return { ok: true }
      },
    }
  services.stockPreparationXlsxExport = xlsxExport
  // The HOST TENANT PRINCIPAL DIRECTORY. This export is VALUE-BEARING (material names, quantities),
  // so it now derives its tenant from `stock-preparation-operator-scope.cjs` rather than from
  // `resolveTenantId` — which on a token-without-tenant-claim deployment compared the request's
  // tenant against a `user.tenantId` the auth middleware had filled from the `x-tenant-id` HEADER.
  // The scope makes the host vouch for the (user, tenant) pairing and is NOT fail-open, so without
  // this seam every case below would 501 for a reason unrelated to what it is measuring. The
  // cross-tenant behaviour itself is asserted in stock-preparation-operator-value-read-scope.test.cjs
  // against a seam that models a REAL membership relation; here it simply admits.
  services.tenantPrincipalDirectory = {
    async verifyTenantMembership() {
      return { member: true }
    },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, auditAppends, auditRows, xlsxExport, hostReads }
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
  for (const forbidden of ['DWG-A1', 'DWG-A2', 'A项目部件一', 'A项目部件二', 'Q235B', 'DN100', 'TZ-A0', 'A项目主体']) {
    assert.ok(!flat.includes(forbidden), `R5: audit entry must not carry ${forbidden}`)
  }
}

// ---------------------------------------------------------------------------
// R5b — THE AUDIT GATE MUST NOT REFUSE THE CUSTOMER'S OWN PROJECT NUMBER
// ---------------------------------------------------------------------------
//
// This route stamps the customer's projectNo into the audit row's `project_id` deliberately — it is
// this route's subject, and the board's last-export lookup reads it back by that key. A round of
// hardening applied an enum/handle SHAPE gate to every nullable TEXT column on that table, which
// made the store refuse any project number outside [A-Za-z0-9@._:|-]. A number with a Chinese
// character, a space or a slash is ordinary in this customer's PLM; with that gate, their export
// 422s — the workbook they came for refused in order to protect the trail from a value the trail
// exists to carry.
//
// Driven against the REAL store, because the stub in every other case here cannot see a refusal.
async function routeExportsAndAuditsAFreeTextProjectNumber() {
  const { routes, auditRows } = mount({ realAuditStore: true })
  const res = await call(routes, 'GET', EXPORT_PATH, {
    user: OPERATOR,
    query: { tenantId: TENANT_ID, projectNo: PROJECT_FREE_TEXT },
  })
  assert.equal(
    res.statusCode,
    200,
    `R5b: an export whose project NUMBER is free text must still be delivered (got ${res.statusCode} ${JSON.stringify(res.body)})`,
  )
  assert.ok(res.sentBuffer, 'R5b: the workbook really was streamed')
  assert.equal(auditRows.length, 1, 'R5b: and the export really was audited')
  assert.equal(
    auditRows[0].row.project_id,
    PROJECT_FREE_TEXT,
    'R5b: the customer project number is the audit row SUBJECT and is stored verbatim',
  )

  // The ordinary shape still works against the real store too.
  const seeded = mount({ realAuditStore: true })
  const ok = await call(seeded.routes, 'GET', EXPORT_PATH, {
    user: OPERATOR,
    query: { tenantId: TENANT_ID, projectNo: PROJECT_A },
  })
  assert.equal(ok.statusCode, 200, 'R5b: the ordinary export still succeeds against the real store')
  assert.equal(seeded.auditRows.length, 1, 'R5b: and it really wrote one audit row')
  assert.equal(seeded.auditRows[0].row.project_id, PROJECT_A)
}

// ---------------------------------------------------------------------------
// R5c — `?workspaceId` IS NOT A CHANNEL ONTO THE TRAIL
// ---------------------------------------------------------------------------
//
// The board and directory routes stopped forwarding the caller's raw `?workspaceId` into
// `workspace_id`; the export did not, so the same one-parameter channel onto a values-free trail was
// still open here. There is no workspace registry in this plugin to validate one against, so the
// route selects nothing from it — the key stays accepted for shape compatibility and steers nothing.
async function routeNeverPutsTheCallersWorkspaceIdOnTheTrail() {
  const { routes, auditAppends } = mount()
  const res = await call(routes, 'GET', EXPORT_PATH, {
    user: OPERATOR,
    query: { tenantId: TENANT_ID, projectNo: PROJECT_A, workspaceId: 'DWG-A1' },
  })
  assert.equal(res.statusCode, 200, 'R5c: a caller-supplied workspaceId is still accepted, not 400')
  assert.equal(auditAppends.length, 1)
  assert.ok(
    !JSON.stringify(auditAppends[0]).includes('DWG-A1'),
    'R5c: whatever the caller puts in ?workspaceId must not reach the audit row',
  )
  assert.ok(
    auditAppends[0].workspaceId === undefined || auditAppends[0].workspaceId === null,
    'R5c: the route forwards no workspace at all',
  )
}

async function routeRefusedCallerAppendsNoAuditRow() {
  const { routes, auditAppends } = mount()
  await call(routes, 'GET', EXPORT_PATH, { user: READ_ONLY, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
  assert.deepEqual(auditAppends, [], 'a gate-refused caller never reaches the audit store')
}

// ---------------------------------------------------------------------------
// 七个字段真的进了工作簿 — the seven fields a 备料 pull must carry
//
// R6 the workbook carries ALL SEVEN PLM fields for a seeded project:
//    父组件图号 / 父组件名称 / 图号 / 名称 / 规格 / 材料 / 总数量
// R7 规格 / 父组件图号 / 父组件名称 come from the NATIVE columns, with the customer-pack ext_
//    column as a PER-ROW fallback (native wins where both are present; the pack value fills a row
//    that has no native one — the state every existing sheet is in on the day this ships)
// R8 an install that has not yet been healed by the additive repair verb (no native columns) still
//    exports: those cells are empty and the absence is REPORTED, never a 500
// R9 a deployment with no customer pack at all (no ext_ columns) also exports — the ext_ tier was
//    hard-required before, which made the export pack-dependent
// ---------------------------------------------------------------------------

const SEVEN_PLM_HEADERS = Object.freeze(['父组件图号', '父组件名称', '图号', '名称', '规格', '材料', '总数量'])

function columnIndex(id) {
  const index = EXPORT_COLUMNS.findIndex((column) => column.id === id)
  assert.notEqual(index, -1, `export projects ${id}`)
  return index
}

async function moduleCarriesAllSevenPlmFields() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  for (const header of SEVEN_PLM_HEADERS) {
    assert.ok(result.headers.includes(header), `R6: 工作簿 carries ${header}`)
  }
  const row = result.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-A1')
  assert.ok(row, 'the seeded PROJECT_A row is in the workbook')
  assert.equal(row[columnIndex('parentComponentCode')], 'TZ-A0', 'R6: 父组件图号 is a real value, not an empty cell')
  assert.equal(row[columnIndex('parentComponentName')], 'A项目主体', 'R6: 父组件名称')
  assert.equal(row[columnIndex('componentName')], 'A项目部件一', 'R6: 名称')
  assert.equal(row[columnIndex('componentSpec')], 'DN100', 'R6: 规格')
  assert.equal(row[columnIndex('material')], 'Q235B', 'R6: 材料')
  assert.equal(row[columnIndex('totalQuantity')], 3, 'R6: 总数量')
  assert.deepEqual(result.unresolvedColumns, [], 'a fully provisioned install reports no missing column')
}

async function moduleNativeWinsAndThePackColumnIsThePerRowFallback() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_MIXED,
    permission: 'admin',
  })
  const native = result.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-M-NATIVE')
  const legacy = result.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-M-LEGACY')
  assert.ok(native && legacy, 'both mixed-state rows are exported')

  // A row the current apply path wrote: BOTH sources present and disagreeing. The native column is
  // the one the pull maintains, so it wins.
  assert.equal(native[columnIndex('componentSpec')], 'DN200-NATIVE', 'R7: native 规格 wins over the pack column')
  assert.equal(native[columnIndex('parentComponentCode')], 'TZ-NATIVE', 'R7: native 父组件图号 wins')
  assert.equal(native[columnIndex('parentComponentName')], '主体-NATIVE', 'R7: native 父组件名称 wins')

  // A row written BEFORE this change: no native value at all. Without the fallback these three
  // cells would go blank on a sheet where they are populated today.
  assert.equal(legacy[columnIndex('componentSpec')], 'DN300-PACK', 'R7: the pack column fills a row with no native 规格')
  assert.equal(legacy[columnIndex('parentComponentCode')], 'TZ-PACK', 'R7: pack fallback for 父组件图号')
  assert.equal(legacy[columnIndex('parentComponentName')], '主体-PACK', 'R7: pack fallback for 父组件名称')

  // An empty-string native cell is BLANK, not a value — it must not shadow the pack column.
  const blanked = result.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-M-BLANK')
  assert.equal(blanked[columnIndex('componentSpec')], 'DN400-PACK', 'R7: an empty native cell falls back, it does not win')
}

async function moduleUnhealedInstallStillExportsAndSaysWhatIsMissing() {
  // The window between deploying this change and running the additive repair verb: the three
  // native columns do not exist on the sheet yet. The export must not 500 — and must SAY SO.
  const { records, target } = moduleSubstrate()
  const unhealed = targetWithout(target, ['parentComponentCode', 'parentComponentName', 'componentSpec'])
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target: unhealed,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  assert.deepEqual(result.headers, EXPORT_COLUMNS.map((c) => c.label), 'R8: the header set never shrinks')
  assert.deepEqual(
    result.unresolvedColumns.slice().sort(),
    ['componentSpec', 'parentComponentCode', 'parentComponentName'],
    'R8: the missing columns are named (config ids, never values)',
  )
  // ...and the three columns still come out, through the pack columns this deployment DOES have.
  // This is the continuity the fallback exists for: nothing that works today goes blank while an
  // operator gets round to running the repair verb.
  const row = result.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-A1')
  assert.equal(row[columnIndex('componentSpec')], 'DN100', 'R8: the pack fallback carries 规格 on an unhealed install')
  assert.equal(row[columnIndex('parentComponentCode')], 'TZ-A0', 'R8: and 父组件图号')
  assert.equal(row[columnIndex('parentComponentName')], 'A项目主体', 'R8: and 父组件名称')

  // The genuinely bare case — unhealed AND packless. Empty cells, a full header row, still a 200.
  const bare = await exportStockPreparationPrepLines({
    recordsApi: records,
    target: targetWithout(unhealed, ['ext_spec', 'ext_parentDrawingNo', 'ext_parentName']),
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  const bareRow = bare.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-A1')
  assert.equal(bareRow[columnIndex('parentComponentCode')], null, 'R8: with neither source the cell is empty, not an error')
  assert.equal(bareRow[columnIndex('parentComponentName')], null)
  assert.equal(bareRow[columnIndex('componentSpec')], null)
  assert.equal(bareRow[columnIndex('componentCode')], 'DWG-A1', 'R8: the rest of the workbook is unaffected')
}

async function modulePacklessDeploymentStillExports() {
  // No customer pack at all. Every ext_ column is absent — which used to be a 500, because all four
  // pack columns were hard-required. Whether a tenant's pack declares a column is a per-deployment
  // fact, so it is absence, not a server fault.
  const { records, target } = moduleSubstrate()
  const packless = targetWithout(target, ['ext_spec', 'ext_parentDrawingNo', 'ext_parentName', 'ext_pickingNode', 'ext_stockPrepDate', 'ext_blankLength'])
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target: packless,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  assert.deepEqual(result.headers, EXPORT_COLUMNS.map((c) => c.label), 'R9: headers are the full agreed set')
  const row = result.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-A1')
  // The seven PLM fields all still come out — they are native now.
  assert.equal(row[columnIndex('parentComponentCode')], 'TZ-A0')
  assert.equal(row[columnIndex('componentSpec')], 'DN100')
  assert.equal(row[columnIndex('ext_pickingNode')], null, 'R9: a pack column this deployment lacks is an empty cell')
  assert.ok(result.unresolvedColumns.includes('ext_pickingNode'), 'R9: and the absence is reported')
}

async function moduleRefusesWhenTheSCOPEFieldsAreUnbound() {
  // The tolerant tier must not swallow a target that cannot SCOPE. An unbound `projectNo` would
  // mean filtering on nothing (one project's workbook containing the whole table) and an unbound
  // `active` would mean shipping components a PLM refresh retired. Both refuse, never best effort.
  const { records, target } = moduleSubstrate()
  for (const scopeField of ['projectNo', 'active']) {
    await assert.rejects(
      () => exportStockPreparationPrepLines({
        recordsApi: records,
        target: targetWithout(target, [scopeField]),
        projectNo: PROJECT_A,
        permission: 'admin',
      }),
      (error) => {
        assert.ok(error instanceof StockPreparationPrepLineExportError)
        assert.equal(error.status, 500)
        assert.equal(error.code, 'PREP_LINE_EXPORT_FIELD_IDS_UNRESOLVED')
        assert.deepEqual(error.details.missingFields, [scopeField])
        return true
      },
      `an unbound ${scopeField} is a refusal — the export cannot scope without it`,
    )
  }
  // A DISPLAY column is the opposite: its absence is a per-deployment fact, reported not refused.
  const tolerated = await exportStockPreparationPrepLines({
    recordsApi: records,
    target: targetWithout(target, ['stockPreparationStatus']),
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  assert.ok(tolerated.unresolvedColumns.includes('stockPreparationStatus'), 'an unbound display column is reported')
  assert.equal(tolerated.rows.length, 2, 'and the workbook is still produced')
}

// ---------------------------------------------------------------------------
// R10 THE EXPORT READS THE TABLE APPLY WROTE (the #5437 defect)
//
// #5437 located the sheet by hardcoding the canonical objectId. On a DEFAULT install that table is
//永远 empty — apply is sandbox-only unless an owner configured a production policy, and the sandbox
// gate rejects the canonical objectId outright — so every project answered 404 on exactly the
// deployments customers run. Both fixtures below seed BOTH sheets, so a regression that goes back to
// a hardcoded table returns the decoy rows or a 404 rather than passing by luck.
// ---------------------------------------------------------------------------

async function routeReadsTheSandboxTwinOnADefaultInstall() {
  const { routes } = mount({ boundSheet: SANDBOX_SHEET })
  const res = await call(routes, 'GET', EXPORT_PATH, { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
  assert.equal(res.statusCode, 200, 'R10: a default (sandbox) install exports its rows — this was a 404')
  const built = decodedBody(res)
  assert.equal(built.rows.length, 2)
  const flat = JSON.stringify(built.rows)
  assert.ok(flat.includes('DWG-A1'), 'R10: the rows apply actually wrote are the ones exported')
  assert.ok(!flat.includes('DWG-DECOY'), 'R10: the canonical table is NOT read on a sandbox-bound deployment')
}

async function routeReadsTheCanonicalTableOnAProductionInstall() {
  const { routes } = mount({ boundSheet: MAIN_SHEET })
  const res = await call(routes, 'GET', EXPORT_PATH, { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
  assert.equal(res.statusCode, 200)
  const built = decodedBody(res)
  assert.equal(built.rows.length, 2)
  const flat = JSON.stringify(built.rows)
  assert.ok(flat.includes('DWG-A1'), 'R10: an owner-configured production install exports the canonical rows')
  assert.ok(!flat.includes('DWG-DECOY'), 'R10: and never the sandbox twin')
}

async function routeNeverCrossesTheTwoTargets() {
  // The decisive pair: the SAME projectNo, the SAME row ids, two deployments — and the workbook
  // differs by exactly the binding. A hardcoded table cannot produce both of these.
  const sandbox = decodedBody(await call(
    mount({ boundSheet: SANDBOX_SHEET }).routes, 'GET', EXPORT_PATH,
    { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_B } },
  ))
  const production = decodedBody(await call(
    mount({ boundSheet: MAIN_SHEET }).routes, 'GET', EXPORT_PATH,
    { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_B } },
  ))
  for (const built of [sandbox, production]) {
    const flat = JSON.stringify(built.rows)
    assert.ok(flat.includes('DWG-B1'), 'each deployment exports the rows in ITS OWN target')
    assert.ok(!flat.includes('DWG-DECOY'), 'and never the other one')
  }
}

async function routeReadsOnlyTheBoundSheet() {
  // Structural, not content-based: the handler must not touch the sheet it is not bound to at all.
  const { routes, hostReads } = mount({ boundSheet: SANDBOX_SHEET })
  await call(routes, 'GET', EXPORT_PATH, { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
  assert.ok(hostReads.length > 0, 'the handler did read')
  for (const read of hostReads) {
    assert.equal(read.sheetId, SANDBOX_SHEET, 'R10: every host read is against the BOUND sheet')
  }
}

// ---------------------------------------------------------------------------
// R11 THE ROUTE IS THE PERMISSION GATE, and it refuses BEFORE any host IO
//
// The module's `permission` argument is NOT the caller's tier and cannot be — the route passes a
// literal 'admin', so the module's assertAdminPermission can never refuse a real principal. That
// makes requireAccess(req, STOCK_PREP_OPERATE) — the handler's first statement — the ONE enforcement
// point, and this test pins it there rather than at the xlsx builder (which a refactor could reorder
// past). The module keeps its check as an internal invariant; it is not the gate.
// ---------------------------------------------------------------------------

async function routeGateRefusesBeforeAnyHostIo() {
  for (const user of [undefined, READ_ONLY, INTEGRATION_WRITER]) {
    const { routes, xlsxExport, hostReads, auditAppends } = mount()
    const res = await call(routes, 'GET', EXPORT_PATH, { user, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
    assert.ok([401, 403].includes(res.statusCode), `R11: ${user ? user.id : 'anonymous'} is refused (got ${res.statusCode})`)
    assert.ok(['UNAUTHENTICATED', 'FORBIDDEN'].includes(res.body.error.code), 'R11: refused by the GATE, not by something downstream')
    assert.deepEqual(hostReads, [], 'R11: a refused caller reaches NO host read — not the records API, not one row')
    assert.deepEqual(auditAppends, [], 'R11: and appends no audit row')
    assert.equal(xlsxExport.calls.length, 0, 'R11: and never reaches the xlsx builder')
  }
  // POSITIVE CONTROL: the same mount DOES serve an operator, so the assertions above are not passing
  // because the route is broken for everyone.
  const { routes, hostReads } = mount()
  const ok = await call(routes, 'GET', EXPORT_PATH, { user: OPERATOR, query: { tenantId: TENANT_ID, projectNo: PROJECT_A } })
  assert.equal(ok.statusCode, 200)
  assert.ok(hostReads.length > 0, 'the operator DOES reach the host — the gate is a gate, not a wall')
}

// ---------------------------------------------------------------------------
// W2-3 (#5447 follow-up): the five departmental completion columns join the export
//
// R12 the exact 17-column header set, in order, as a LITERAL array — independent of EXPORT_COLUMNS
//     itself, so a bug in the projection's own definition cannot pass by circularity.
// R13 procurementDone/warehouseDone render 是/否 text (never a native boolean); a flag nobody has
//     set yet is a blank cell, never 否.
// R14 procurementReplyDate/actualArrivalDate pass through unchanged — exactly like the pre-existing
//     demandDate column, which gets no special formatting either.
// R15 a target that predates #5447 (no bindings for the five new logical ids — the shape of a
//     deployment provisioned before this change) still exports the original twelve columns, with
//     the five reported in unresolvedColumns. Never a 500.
// ---------------------------------------------------------------------------

const SEVENTEEN_HEADERS_IN_ORDER = Object.freeze([
  '父组件图号', '父组件名称', '图号', '名称', '规格', '材料', '总数量',
  '备料情况', '需求日期', '领料节点', '备料日期', '毛胚长度',
  '自制/外购', '采购完成', '采购回复日期', '仓库完成', '实际到货日期',
])

async function moduleExactSeventeenColumnHeaderOrder() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  assert.deepEqual(result.headers, SEVENTEEN_HEADERS_IN_ORDER, 'R12: the exact 17 headers, in the agreed order')
  assert.deepEqual(EXPORT_COLUMNS.map((c) => c.label), SEVENTEEN_HEADERS_IN_ORDER, 'R12: EXPORT_COLUMNS itself matches the literal agreed order')
}

async function moduleCompletionFlagsRenderYesNoTextAndBlankWhenUnset() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  const doneRow = result.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-A1')
  const unsetRow = result.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-A2')

  assert.equal(doneRow[columnIndex('procurementDone')], '是', 'R13: procurementDone=true renders 是')
  assert.equal(doneRow[columnIndex('warehouseDone')], '否', 'R13: warehouseDone=false renders 否')
  assert.equal(typeof doneRow[columnIndex('procurementDone')], 'string', 'R13: never a native boolean cell')

  assert.equal(unsetRow[columnIndex('procurementDone')], null, 'R13: an unset flag is a blank cell, not 否')
  assert.equal(unsetRow[columnIndex('warehouseDone')], null, 'R13: an unset flag is a blank cell, not 否')
}

async function moduleDateCompletionColumnsPassThroughLikeDemandDate() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  const row = result.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-A1')
  assert.equal(row[columnIndex('procurementReplyDate')], '2026-09-05', 'R14: 采购回复日期 passes through unchanged')
  assert.equal(row[columnIndex('actualArrivalDate')], '2026-09-12', 'R14: 实际到货日期 passes through unchanged')
  // Same formatting rule as the pre-existing demandDate column: a stored string comes out untouched.
  assert.equal(row[columnIndex('demandDate')], '2026-09-10', 'R14: demandDate — the existing convention these two new date columns follow')
  assert.equal(row[columnIndex('makeOrBuy')], '外购', 'the select column (自制/外购) also passes through as its stored string')
}

async function moduleTargetPredatingPR5447StillExportsAndReportsTheFive() {
  // Models a deployment provisioned before #5447: its bound target's fieldIdMap simply has no entry
  // for the five new logical ids (the shape assertTargetFieldMapCompleteness allows — these are
  // human_preserved display columns, never required). This must NOT 500.
  const { records, target } = moduleSubstrate()
  const legacyTarget = targetWithout(target, ['makeOrBuy', 'procurementDone', 'procurementReplyDate', 'warehouseDone', 'actualArrivalDate'])
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target: legacyTarget,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  assert.deepEqual(result.headers, SEVENTEEN_HEADERS_IN_ORDER, 'R15: the header set never shrinks — all 17 headers still appear')
  assert.deepEqual(
    result.unresolvedColumns.slice().sort(),
    ['actualArrivalDate', 'makeOrBuy', 'procurementDone', 'procurementReplyDate', 'warehouseDone'],
    'R15: exactly the five new columns are reported as unresolved',
  )
  const row = result.rows.find((cells) => cells[columnIndex('componentCode')] === 'DWG-A1')
  assert.equal(row[columnIndex('procurementDone')], null, 'R15: an unbound boolean column is a blank cell, not 否')
  assert.equal(row[columnIndex('warehouseDone')], null, 'R15: an unbound boolean column is a blank cell, not 是')
  assert.equal(row[columnIndex('procurementReplyDate')], null, 'R15: an unbound date column is a blank cell')
  assert.equal(row[columnIndex('actualArrivalDate')], null, 'R15: an unbound date column is a blank cell')
  assert.equal(row[columnIndex('makeOrBuy')], null, 'R15: an unbound select column is a blank cell')
  // The original twelve are completely unaffected — the fix is additive only.
  assert.equal(row[columnIndex('componentCode')], 'DWG-A1')
  assert.equal(row[columnIndex('material')], 'Q235B')
  assert.equal(result.rows.length, 2, 'R15: the workbook is still produced (not an error)')
}

async function main() {
  await moduleReturnsExactAgreedColumnsForASeededProject()
  await moduleNeverLeaksOtherProjectsRows()
  await moduleRefusesNonAdminInternalPermission()
  await moduleZeroActiveRowsYieldsHeadersOnly()
  await moduleUnknownProjectIsNotFound()
  await moduleMissingTargetIsAConfigRefusalNotA500()
  await moduleCarriesAllSevenPlmFields()
  await moduleNativeWinsAndThePackColumnIsThePerRowFallback()
  await moduleUnhealedInstallStillExportsAndSaysWhatIsMissing()
  await modulePacklessDeploymentStillExports()
  await moduleRefusesWhenTheSCOPEFieldsAreUnbound()

  await moduleExactSeventeenColumnHeaderOrder()
  await moduleCompletionFlagsRenderYesNoTextAndBlankWhenUnset()
  await moduleDateCompletionColumnsPassThroughLikeDemandDate()
  await moduleTargetPredatingPR5447StillExportsAndReportsTheFive()

  await routeReturnsExactColumnsForSeededProject()
  await routeScopingProofOtherProjectRowsNeverAppear()
  await routeRefusesUnderPrivilegedPrincipals()
  await routeZeroActiveRowsYieldsHeadersOnlyNotAnError()
  await routeUnknownProjectIsTheFamiliarNotFoundShape()
  await routeAuditEntryIsValuesFree()
  await routeExportsAndAuditsAFreeTextProjectNumber()
  await routeNeverPutsTheCallersWorkspaceIdOnTheTrail()
  await routeRefusedCallerAppendsNoAuditRow()

  await routeReadsTheSandboxTwinOnADefaultInstall()
  await routeReadsTheCanonicalTableOnAProductionInstall()
  await routeNeverCrossesTheTwoTargets()
  await routeReadsOnlyTheBoundSheet()
  await routeGateRefusesBeforeAnyHostIo()

  console.log('stock-preparation-prep-line-export (按项目导出物料 Excel): all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
