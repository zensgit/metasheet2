'use strict'

// 人工补充行 B1 (ADR adr-stock-prep-manual-rows-20261030 §6, §8 「B1 插件」 4) — the export:
//
//   ME-01 PURE PLM IS BYTE-IDENTICAL: the result object of a sheet without a person's row equals, byte for byte (JSON),
//         the one main's own module (d5bc16c55, before B1) produced for the same records — with and without 沿用说明.
//   ME-02 THE PROBE'S THREE DEDUPE CASES (每种都会丢行 on main): a prefix row copying root R (R without a sort number)
//         swallowed R and its subtree; with a sort number on R the prefix row was swallowed; an orphan and a prefix row
//         with one display key lost one of them. Now every prefix row stays out of the tree and the dedupe and is
//         appended after it: nothing is lost, the PLM tree prints exactly as without the prefix row, an unbound prefix
//         row is treated the same way.
//   ME-03 来源 — the three values (人工补充 / 人工（非补充） / PLM), the 31st column, after 仓库确认; with 沿用说明 the
//         32nd column is 沿用说明 (it stays last); the result's values-free counts.
//   ME-04 来源 appears only for PRINTED non-PLM rows: a person-created PLM-key row the dedupe collapsed adds no column.
//   ME-05 an explicit-map target: 来源 is never field-resolved and never in `unresolvedColumns`.
//   ME-06 an env target (not a project sheet): its `manual:` rows are 人工（非补充） — the column appears there too.
//   ME-07 through the mounted route: the workbook carries 来源 and the audit row's columnCount is 31 (30 without a
//         person's row) — no new audit key.
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const prepLineExport = require(path.join(LIB, 'stock-preparation-prep-line-export.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { createInMemoryProjectWriteLock } = require('./support/stock-preparation-project-write-lock-kit.cjs')
const { withRefreshGovernance } = require('./support/stock-preparation-refresh-governance-wiring.cjs')
const { makeFakeProvisioning } = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))
const F = require('./support/stock-preparation-manual-rows-export-fixtures.cjs')

const { EXPORT_COLUMNS, EXPORT_SOURCE_FIELD_IDS, exportStockPreparationPrepLines, __internals: exportInternals } = prepLineExport

const tests = []
const test = (name, fn) => tests.push([name, fn])

const CODE = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
const SOURCE_AT = EXPORT_COLUMNS.length // the 31st column (index 30)

function exportOf(records, extra = {}) {
  return exportStockPreparationPrepLines({ recordsApi: F.recordsApiOver(records), target: F.target(), projectNo: F.PROJECT_NO, permission: 'admin', ...extra })
}
const codes = (result) => result.rows.map((row) => row[CODE])
const sourceCells = (result) => result.rows.map((row) => row[SOURCE_AT])

// Captured from main d5bc16c55's OWN stock-preparation-prep-line-export.cjs over F.plmTree() (and with
// F.continuationFor()), before any B1 change — the JSON of the whole result object.
const HEADERS_30 = '["父组件图号","父组件名称","图号","名称","规格","材料","总数量","备料情况","需求日期","领料节点","备料日期","毛胚长度","自制/外购","采购完成","采购回复日期","仓库完成","实际到货日期","生产编号","名称及规格","材料类型","毛胚类型","备注","交接工段","提前周期(天)","毛胚宽度","毛胚厚度","毛胚数量","毛胚质量","采购回复","仓库确认"'
const TAIL_BLANKS = 'null,null,null,null,null,null,null,null,null,null,null,null'
const GOLDEN_PURE_PLM = `{"projectNo":"SYN-MR-EXP","totalRowCount":6,"activeRowCount":5,"headers":${HEADERS_30}],"rows":[["SYN-X","Gone parent","SYN-O","Orphan",null,"SYN-MAT",4,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS}],[null,null,"SYN-R","Root",null,"SYN-MAT",1,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS}],["SYN-R","Root","SYN-C1","Child one",null,"SYN-MAT",2,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS}],["SYN-R","Root","SYN-C2","Child two",null,"SYN-MAT",3,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS}]],"collapsedRowCount":1,"treeOrdered":true,"treeIdentity":"path","treeDegraded":false,"unresolvedColumns":[]}`
const GOLDEN_PURE_PLM_CONTINUATION = `{"projectNo":"SYN-MR-EXP","totalRowCount":6,"activeRowCount":5,"headers":${HEADERS_30},"沿用说明"],"rows":[["SYN-X","Gone parent","SYN-O","Orphan",null,"SYN-MAT",4,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS},"由 SYN-R 沿用（父边用量 2，关系 ort_0001）"],[null,null,"SYN-R","Root",null,"SYN-MAT",1,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS},""],["SYN-R","Root","SYN-C1","Child one",null,"SYN-MAT",2,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS},""],["SYN-R","Root","SYN-C2","Child two",null,"SYN-MAT",3,null,null,null,null,null,null,null,null,null,null,"SYN-MR-EXP",${TAIL_BLANKS},""]],"continuationColumn":true,"continuedRowCount":1,"collapsedRowCount":1,"treeOrdered":true,"treeIdentity":"path","treeDegraded":false,"unresolvedColumns":[]}`

test('ME-01 a pure-PLM sheet exports byte-identically to main (with and without 沿用说明)', async () => {
  assert.equal(JSON.stringify(await exportOf(F.plmTree())), GOLDEN_PURE_PLM)
  assert.equal(JSON.stringify(await exportOf(F.plmTree(), { continuation: F.continuationFor() })), GOLDEN_PURE_PLM_CONTINUATION)
  // An env target and an explicit-map target answer the same pure-PLM bytes for the cells (objectId is not an input to
  // a PLM row's projection).
  const env = await exportStockPreparationPrepLines({ recordsApi: F.recordsApiOver(F.plmTree()), target: F.target(F.ENV_OBJECT_ID), projectNo: F.PROJECT_NO, permission: 'admin' })
  assert.equal(JSON.stringify(env), GOLDEN_PURE_PLM)
})

test('ME-02 the probe\'s three dedupe cases: nothing is swallowed any more, prefix rows are appended after the tree', async () => {
  const tree = codes(await exportOf(F.plmTree()))
  assert.deepEqual(tree, ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2'])
  // Case 1 — a prefix row copies root R (R has no sort number). Main printed ['SYN-O', 'SYN-R'(the copy)] and lost R,
  // C1 and C2 (collapsedRowCount 4). The same for an unbound prefix row (no creator).
  for (const copy of [F.rootCopy('rec_1_manual'), F.rootCopy('rec_3_unbound', { createdBy: null })]) {
    const result = await exportOf([...F.plmTree(), copy])
    assert.deepEqual(codes(result), [...tree, 'SYN-R'], `case 1 (${copy.id}): the PLM tree whole, the copy appended`)
    assert.equal(result.collapsedRowCount, 1, 'only the pure-PLM twin collapses, as before')
    assert.equal(result.rows.length, 5)
    assert.equal(result.rows[4][EXPORT_COLUMNS.findIndex((column) => column.id === 'totalQuantity')], 7, 'the appended row is the copy')
  }
  // Case 2 — R carries a sort number. Main printed the tree and lost the prefix row (collapsedRowCount 2).
  const sorted = await exportOf([...F.plmTree({ rootSortNo: 1 }), F.rootCopy('rec_1_manual')])
  assert.deepEqual(codes(sorted), ['SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-O', 'SYN-R'])
  assert.equal(sorted.collapsedRowCount, 1)
  // Case 3 — an orphan and a prefix row share one display key. Main printed one 'SYN-O' (the prefix row) and lost the
  // PLM orphan (collapsedRowCount 2).
  const orphan = await exportOf([...F.plmTree(), F.orphanCopy('rec_2_manual')])
  assert.deepEqual(codes(orphan), [...tree, 'SYN-O'])
  assert.equal(orphan.collapsedRowCount, 1)
  assert.equal(orphan.rows[0][EXPORT_COLUMNS.findIndex((column) => column.id === 'totalQuantity')], 4, 'the PLM orphan prints in its tree slot')
  // Several prefix rows: appended in the flat comparator's order (父组件图号 blank last, then 图号 ...).
  const many = await exportOf([...F.plmTree(), F.rootCopy('rec_1_manual'), F.orphanCopy('rec_2_manual'), F.person('rec_4_free', { componentCode: 'SYN-A-FREE', componentName: 'Free' })])
  assert.deepEqual(codes(many), [...tree, 'SYN-O', 'SYN-A-FREE', 'SYN-R'])
  // A prefix row WITH a PLM path (a hand-edited key) adopts no child: its former children become orphans and still print.
  const edited = F.plmTree()
  edited[0].data.idempotencyKey = 'manual:v1:rec_5_root'
  edited[0].createdBy = F.PERSON
  const adopted = await exportOf(edited)
  assert.deepEqual(codes(adopted).slice().sort(), ['SYN-C1', 'SYN-C2', 'SYN-O', 'SYN-R'])
  assert.equal(codes(adopted)[codes(adopted).length - 1], 'SYN-R', 'the prefix row is appended last')
})

test('ME-03 来源: three values in the 31st column; with 沿用说明 that is the 32nd and last; the values-free counts', async () => {
  const records = [
    ...F.plmTree(),
    F.person('rec_1_manual', { componentCode: 'SYN-M1', componentName: 'Manual one' }),
    F.person('rec_2_unbound', { componentCode: 'SYN-M2', componentName: 'Unbound' }, { createdBy: null }),
    F.person('rec_3_other_id', { componentCode: 'SYN-M3', componentName: 'Other id' }, { key: 'manual:v1:rec_someone_else' }),
  ]
  // A person-created row with a PLM key (a pre-#6598 right-click copy): not a prefix row, but 人工（非补充）.
  const copied = F.plm('rec_b_copy', ['P-R', 'P-C3'], { parentComponentCode: 'SYN-R', componentCode: 'SYN-C3', componentName: 'Copied' })
  copied.createdBy = F.PERSON
  records.push(copied)
  const result = await exportOf(records)
  assert.equal(result.headers.length, 31)
  assert.equal(result.headers[30], '来源')
  assert.equal(result.headers[29], '仓库确认', '来源 follows the 30th column')
  const byCode = Object.fromEntries(result.rows.map((row) => [row[CODE], row[SOURCE_AT]]))
  assert.deepEqual(byCode, {
    'SYN-O': 'PLM', 'SYN-R': 'PLM', 'SYN-C1': 'PLM', 'SYN-C2': 'PLM', 'SYN-C3': '人工（非补充）',
    'SYN-M1': '人工补充', 'SYN-M2': '人工（非补充）', 'SYN-M3': '人工（非补充）',
  })
  assert.equal(result.sourceColumn, true)
  assert.equal(result.manualSupplementRowCount, 1)
  assert.equal(result.manualOtherRowCount, 3)
  assert.ok(result.rows.every((row) => row.length === 31))
  // With a live 沿用关系: 来源 is the 31st column and 沿用说明 the 32nd.
  const continued = await exportOf(records, { continuation: F.continuationFor() })
  assert.equal(continued.headers.length, 32)
  assert.deepEqual(continued.headers.slice(29), ['仓库确认', '来源', '沿用说明'])
  const orphanRow = continued.rows.find((row) => row[CODE] === 'SYN-O')
  assert.equal(orphanRow[30], 'PLM')
  assert.equal(orphanRow[31], '由 SYN-R 沿用（父边用量 2，关系 ort_0001）')
  assert.equal(continued.continuedRowCount, 1)
  // The labels are the ADR's, byte for byte (the full-width parentheses included).
  assert.deepEqual(exportInternals.SOURCE_LABELS, { manual_supplement: '人工补充', manual_other: '人工（非补充）', plm: 'PLM' })
  assert.equal(Buffer.from('人工（非补充）', 'utf8').toString('hex'), 'e4babae5b7a5efbc88e99d9ee8a1a5e58585efbc89')
})

test('ME-04 来源 counts PRINTED rows only: a person-created PLM-key row the dedupe collapsed adds no column', async () => {
  // A display twin of C1 under R, created by a person, sorting AFTER C1 (its key is later) => collapsed, not printed.
  const twin = F.plm('rec_c_twin', ['P-R', 'P-C1Z'], { parentComponentCode: 'SYN-R', parentComponentName: 'Root', componentCode: 'SYN-C1', componentName: 'Child one', totalQuantity: 2 })
  twin.createdBy = F.PERSON
  const result = await exportOf([...F.plmTree(), twin])
  assert.equal(result.collapsedRowCount, 2, 'the person\'s twin collapsed like any twin')
  assert.equal(result.headers.length, 30, 'no printed non-PLM row => no 来源')
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'sourceColumn'), false)
})

test('ME-05 an explicit-map target: 来源 is not field-resolved and never in unresolvedColumns', async () => {
  // Bind the scope + key + identity columns only: every other projected column is unbound (reported), 来源 is not.
  const fieldIdMap = {
    projectNo: 'fld_project', active: 'fld_active', idempotencyKey: 'fld_key', componentCode: 'fld_code', path: 'fld_path',
    componentSourceId: 'fld_part', parentSourceId: 'fld_parent',
  }
  const physical = (records) => records.map((record) => {
    const data = {}
    for (const [logical, value] of Object.entries(record.data)) data[fieldIdMap[logical] || `fld_unbound_${logical}`] = value
    return { ...record, data }
  })
  const recordsApi = {
    async queryRecords(input) {
      return F.recordsApiOver(physical([...F.plmTree(), F.person('rec_1_manual', { componentCode: 'SYN-M1' })])).queryRecords(input)
    },
  }
  const result = await exportStockPreparationPrepLines({ recordsApi, target: F.target(F.PROJECT_OBJECT_ID, fieldIdMap), projectNo: F.PROJECT_NO, permission: 'admin' })
  assert.equal(result.headers[30], '来源')
  assert.equal(result.rows.find((row) => row[CODE] === 'SYN-M1')[30], '人工补充')
  assert.ok(result.unresolvedColumns.length > 0, 'the explicit map leaves columns unbound (the check is not vacuous)')
  for (const entry of result.unresolvedColumns) {
    assert.notEqual(entry, exportInternals.SOURCE_COLUMN.id)
    assert.notEqual(entry, '来源')
  }
  assert.equal(EXPORT_SOURCE_FIELD_IDS.includes(exportInternals.SOURCE_COLUMN.id), false)
  assert.equal(EXPORT_COLUMNS.some((column) => column.id === exportInternals.SOURCE_COLUMN.id || column.label === '来源'), false)
})

test('ME-06 an env target: its manual: rows are 人工（非补充） (M′ needs a project sheet), and the column appears there too', async () => {
  const records = [...F.plmTree(), F.person('rec_1_manual', { componentCode: 'SYN-M1' })]
  const result = await exportStockPreparationPrepLines({ recordsApi: F.recordsApiOver(records), target: F.target(F.ENV_OBJECT_ID), projectNo: F.PROJECT_NO, permission: 'admin' })
  assert.equal(result.headers[30], '来源')
  assert.equal(result.rows.find((row) => row[CODE] === 'SYN-M1')[30], '人工（非补充）')
  assert.equal(result.manualSupplementRowCount, 0)
  assert.equal(result.manualOtherRowCount, 1)
  assert.deepEqual(codes(result), ['SYN-O', 'SYN-R', 'SYN-C1', 'SYN-C2', 'SYN-M1'], 'still appended after the tree')
})

// ── ME-07: through the mounted route ───────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-mr-export'
const STAGING = `${TENANT_ID}:integration-core`
const OPERATOR = Object.freeze({ id: 'u_mr_export_op', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })

function inertService(methods) {
  return Object.fromEntries(methods.map((method) => [method, async () => { throw new Error(`unexpected service call: ${method}`) }]))
}

function mountExport(records) {
  const routes = new Map()
  const auditAppends = []
  const workbooks = []
  const provisioning = makeFakeProvisioning({ stagingProjectId: STAGING, sheetIdByObjectId: {}, sheetOwnerBySheetId: { [F.SHEET_ID]: STAGING } })
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { records: F.recordsApiOver(records), provisioning },
    },
    storage: new Map(),
    config: { stockPreparationTableActions: [{ actionId: PLM_STOCK_PREPARATION_ACTION_ID, source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' }, target: F.target() }] },
  }
  const services = {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem', 'listExternalSystems']),
    adapterRegistry: inertService(['createAdapter', 'listAdapterKinds']),
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    stockPreparationAuditStore: { async append(entry) { auditAppends.push(entry); return { ok: true } } },
    stockPreparationXlsxExport: { async buildWorkbookBuffer(params) { workbooks.push(params); return Buffer.from(JSON.stringify(params), 'utf8') } },
    tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
    stockPreparationProjectWriteLock: createInMemoryProjectWriteLock({ timers: 'real' }).lock,
  }
  httpRoutes.registerIntegrationRoutes({ context, services: withRefreshGovernance(services), logger: { info() {}, warn() {}, error() {} } })
  async function get() {
    const handler = routes.get('GET /api/integration/stock-preparation/prep-lines/export')
    const res = {
      statusCode: 200, body: undefined, headers: {}, sentBuffer: null,
      status(code) { this.statusCode = code; return this },
      json(body) { this.body = body; return this },
      setHeader(name, value) { this.headers[name] = value; return this },
      send(payload) { this.sentBuffer = payload; return this },
    }
    await handler({ user: OPERATOR, body: {}, query: { projectNo: F.PROJECT_NO }, params: {}, headers: {} }, res)
    return res
  }
  return { get, auditAppends, workbooks }
}

test('ME-07 the mounted route: 来源 in the workbook, audit columnCount 31 (30 without a person\'s row), no new audit key', async () => {
  const plain = mountExport(F.plmTree())
  const plainRes = await plain.get()
  assert.equal(plainRes.statusCode, 200, JSON.stringify(plainRes.body))
  assert.equal(plain.workbooks[0].headers.length, 30)
  assert.deepEqual(plain.auditAppends[0].detail, { operation: 'prep_line_export', totalRowCount: 6, activeRowCount: 5, columnCount: 30 })

  const withManual = mountExport([...F.plmTree(), F.person('rec_1_manual', { componentCode: 'SYN-M1', componentName: 'Manual one' })])
  const res = await withManual.get()
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  const workbook = withManual.workbooks[0]
  assert.equal(workbook.headers.length, 31)
  assert.equal(workbook.headers[30], '来源')
  assert.equal(workbook.rows[workbook.rows.length - 1][30], '人工补充')
  assert.deepEqual(withManual.auditAppends[0].detail, { operation: 'prep_line_export', totalRowCount: 7, activeRowCount: 6, columnCount: 31 })
  assert.equal(res.headers['X-Stock-Prep-Export-Row-Count'], '6')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-manual-rows-export.test.cjs', tests)
