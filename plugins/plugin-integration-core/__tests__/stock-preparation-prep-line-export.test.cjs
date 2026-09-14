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
// PLUS (反馈2「导出的层级乱了」) the deterministic row order:
//   R16 rows come out in 父组件图号 → 明细排序号 → 图号 → 唯一键 → 名称 → 物理记录 id order, blank
//       parent last, identical whatever order the records scan returned them in — the export used to
//       inherit the records service's `ORDER BY id ASC` over random UUID ids, i.e. no order at all.
//       Each key has its OWN witness (the seeds are deliberately cross-ordered so no two keys agree
//       on any pair): deleting any one of the six turns one of these four cases red.
//       R16d rows with NO 唯一键 (hand-added, or a target that binds none — the template's
//            `required: true` is plugin metadata the multitable layer does not enforce) are still
//            totally ordered, by 名称 then by record id, and two scans that differ only in order
//            produce byte-identical workbooks.
//       R16e a target that binds NEITHER `parentComponentCode` NOR `ext_parentDrawingNo` (an install
//            predating that column, before the repair verb heals it) does not throw: key 1 is blank
//            for every row, the workbook degrades to a pure 图号 order — deterministic but NOT
//            hierarchical — and says so through unresolvedColumns.
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
  __internals: exportInternals,
} = require(path.join(LIB, 'stock-preparation-prep-line-export.cjs'))
// The expander's OWN path encoder (`makePath`): the tree fixtures below carry `path` exactly as the
// apply path writes it, and R23c pins the export's re-encoder to it so the two cannot drift.
const { __internals: bomExpansionInternals } = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const bomPath = (...tokens) => bomExpansionInternals.makePath(tokens)
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
// A project seeded DELIBERATELY OUT OF ORDER, for R16: two 父组件图号 groups, a pack-only parent, a
// parentless row, and two rows agreeing on both parent and 图号 (one component, two BOM paths).
const PROJECT_ORDER = 'PRJ-ORDER'
// The same question for 明细排序号 — the column the frozen template does not carry yet.
const PROJECT_SORTNO = 'PRJ-SORTNO'
// Rows WITHOUT a 唯一键 — the shape a hand-added grid row has (the template's `required: true` is
// plugin metadata; the multitable layer enforces nothing of the sort), and the shape any row has on
// a target whose fieldIdMap does not bind idempotencyKey. Two of them are identical in every key a
// reader can see, so ONLY the record id can separate them.
const PROJECT_MANUAL = 'PRJ-MANUAL-ROWS'

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
  const row = { ...base, ...overrides }
  // 唯一键 is `required: true, key: true` on the main TEMPLATE, so every row the apply path wrote
  // through a target that binds it has one and it is distinct — a seed without it would make that
  // tiebreak look optional where in those sheets it is not. It is NOT a multitable-layer constraint
  // though (provisioning does not enforce `required`), so a row can legitimately carry none: pass
  // `idempotencyKey: null` explicitly for that shape — see PROJECT_MANUAL.
  if (row.idempotencyKey === undefined) row.idempotencyKey = `idk-${projectNo}-${row.componentCode}`
  return physicalRow(STAGING, MAIN_OBJECT_ID, row, id)
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

    // R16 ORDER SEEDS, in an order no comparator would produce (this is the random-UUID scan the
    // export used to inherit verbatim). Their expected order is spelled out in the R16 tests.
    mainRow(PROJECT_ORDER, { componentCode: 'DWG-9', componentName: 'B组第一件', parentComponentCode: 'TZ-B', parentComponentName: 'B主体', ext_parentDrawingNo: 'TZ-B', ext_parentName: 'B主体' }, 'rec_o1'),
    // No parent at all — neither the native column nor the pack one.
    mainRow(PROJECT_ORDER, {
      componentCode: 'DWG-1', componentName: '无父件行',
      parentComponentCode: undefined, parentComponentName: undefined,
      ext_parentDrawingNo: undefined, ext_parentName: undefined,
    }, 'rec_o2'),
    // Same component, same parent, two BOM paths: only 唯一键 separates them. Their 名称 is ordered
    // AGAINST their 唯一键 on purpose (键 p1 → 名称 Z, 键 p2 → 名称 A): 名称 is itself an order key
    // (the one below 唯一键), so if the two agreed, deleting the 唯一键 comparison would leave the
    // output unchanged and this pair would stop being evidence for it.
    mainRow(PROJECT_ORDER, { componentCode: 'DWG-2', componentName: '二号路径Z', idempotencyKey: 'idk-o-p1', parentComponentCode: 'TZ-A', parentComponentName: 'A主体', ext_parentDrawingNo: 'TZ-A', ext_parentName: 'A主体' }, 'rec_o3'),
    // 唯一键 idk-o-aaa / idk-o-zzz on these two rows run AGAINST their 图号 order (DWG-1 gets aaa,
    // DWG-0 gets zzz) for the same reason: the real key is projectNo+componentSourceId+parentSourceId
    // +pathTokens and has no relationship to 图号, so a seed whose fallback key happens to agree with
    // 图号 would make the 图号 comparison dead code that no assertion could ever catch.
    mainRow(PROJECT_ORDER, { componentCode: 'DWG-1', componentName: 'A组一号件', idempotencyKey: 'idk-o-aaa', parentComponentCode: 'TZ-A', parentComponentName: 'A主体', ext_parentDrawingNo: 'TZ-A', ext_parentName: 'A主体' }, 'rec_o4'),
    mainRow(PROJECT_ORDER, { componentCode: 'DWG-2', componentName: '二号路径A', idempotencyKey: 'idk-o-p2', parentComponentCode: 'TZ-A', parentComponentName: 'A主体', ext_parentDrawingNo: 'TZ-A', ext_parentName: 'A主体' }, 'rec_o5'),
    // A pack-only parent: the printed 父组件图号 comes from ext_parentDrawingNo, so it must sort
    // into the TZ-A group rather than into the blank band.
    mainRow(PROJECT_ORDER, {
      componentCode: 'DWG-0', componentName: 'A组零号件', idempotencyKey: 'idk-o-zzz',
      parentComponentCode: undefined, parentComponentName: undefined,
      ext_parentDrawingNo: 'TZ-A', ext_parentName: 'A主体(包列)',
    }, 'rec_o6'),

    // 明细排序号 seeds: the 图号 order (S1, S5, S9) and the 明细栏 order (S9, S1, then the row with
    // no number) disagree on purpose, so which key won is never ambiguous.
    mainRow(PROJECT_SORTNO, { componentCode: 'DWG-S1', componentName: 'S组明细二', componentSortNo: 20, parentComponentCode: 'TZ-S', parentComponentName: 'S主体', ext_parentDrawingNo: 'TZ-S', ext_parentName: 'S主体' }, 'rec_s1'),
    mainRow(PROJECT_SORTNO, { componentCode: 'DWG-S9', componentName: 'S组明细一', componentSortNo: 10, parentComponentCode: 'TZ-S', parentComponentName: 'S主体', ext_parentDrawingNo: 'TZ-S', ext_parentName: 'S主体' }, 'rec_s2'),
    mainRow(PROJECT_SORTNO, { componentCode: 'DWG-S5', componentName: 'S组无排序号', parentComponentCode: 'TZ-S', parentComponentName: 'S主体', ext_parentDrawingNo: 'TZ-S', ext_parentName: 'S主体' }, 'rec_s3'),

    // 唯一键-LESS seeds (R16d). All three agree on 父组件图号 and 图号 and carry NO 唯一键, so the
    // first four keys tie outright; 名称 then the record id are all that is left. rec_h2 / rec_h3
    // agree on 名称 too — nothing a reader can see tells them apart — which is exactly the pair the
    // record-id key exists for. 名称 runs against the record ids (h1 is the Z) so the 名称 key has a
    // witness of its own.
    mainRow(PROJECT_MANUAL, {
      componentCode: 'DWG-H1', componentName: '手工补录Z', idempotencyKey: null, material: 'Q235B',
      parentComponentCode: 'TZ-H', parentComponentName: 'H主体', ext_parentDrawingNo: 'TZ-H', ext_parentName: 'H主体',
    }, 'rec_h1'),
    mainRow(PROJECT_MANUAL, {
      componentCode: 'DWG-H1', componentName: '手工补录A', idempotencyKey: null, material: 'Q345B',
      parentComponentCode: 'TZ-H', parentComponentName: 'H主体', ext_parentDrawingNo: 'TZ-H', ext_parentName: 'H主体',
    }, 'rec_h2'),
    mainRow(PROJECT_MANUAL, {
      componentCode: 'DWG-H1', componentName: '手工补录A', idempotencyKey: null, material: 'S30408',
      parentComponentCode: 'TZ-H', parentComponentName: 'H主体', ext_parentDrawingNo: 'TZ-H', ext_parentName: 'H主体',
    }, 'rec_h3'),
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
// F1c 追加了六个包列(名称及规格/交接工段/毛胚宽度/厚度/数量/质量)和 当前组件排序号 —— 一个装了
// 客户包的部署这些列本来就在,所以「全量 provisioned」的 target 也要绑它们。
const PACK_FIELD_IDS = Object.freeze([
  'ext_parentDrawingNo', 'ext_parentName', 'ext_spec', 'ext_pickingNode', 'ext_stockPrepDate', 'ext_blankLength',
  'ext_nameAndSpec', 'ext_handoverSection', 'ext_blankWidth', 'ext_blankThickness', 'ext_blankQuantity', 'ext_blankMass',
  'ext_componentSortNo', 'ext_parentSortNo',
])

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
// `seedOrder` re-orders the seeds before they reach the substrate — the ONE thing a random-UUID scan
// varies between two deployments holding the same rows (R16).
function moduleSubstrate({ boundSheet = SANDBOX_SHEET, seedOrder = (rows) => rows } = {}) {
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [MAIN_SHEET]: MAIN_OBJECT_ID, [SANDBOX_SHEET]: MAIN_OBJECT_ID },
    rowsBySheet: {
      [MAIN_SHEET]: boundSheet === MAIN_SHEET ? seedOrder(seededRows()) : decoyRows(),
      [SANDBOX_SHEET]: boundSheet === SANDBOX_SHEET ? seedOrder(seededRows()) : decoyRows(),
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
  assert.equal(result.headers.length, 28, 'R1/R12: 28 columns (#5447 的五列之后,F1c 又补了老系统 23 列里缺的十一列)')
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

// F1c: the original 17 (UNMOVED — 老列顺序是约定) followed by the eleven 老系统 23 列里补齐的列.
const EXPORT_HEADERS_IN_ORDER = Object.freeze([
  '父组件图号', '父组件名称', '图号', '名称', '规格', '材料', '总数量',
  '备料情况', '需求日期', '领料节点', '备料日期', '毛胚长度',
  '自制/外购', '采购完成', '采购回复日期', '仓库完成', '实际到货日期',
  '生产编号', '名称及规格', '材料类型', '毛胚类型', '备注', '交接工段',
  '提前周期(天)', '毛胚宽度', '毛胚厚度', '毛胚数量', '毛胚质量',
])

async function moduleExactSeventeenColumnHeaderOrder() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_A,
    permission: 'admin',
  })
  assert.deepEqual(result.headers, EXPORT_HEADERS_IN_ORDER, 'R12: the exact 28 headers, in the agreed order')
  assert.deepEqual(EXPORT_COLUMNS.map((c) => c.label), EXPORT_HEADERS_IN_ORDER, 'R12: EXPORT_COLUMNS itself matches the literal agreed order')
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
  assert.deepEqual(result.headers, EXPORT_HEADERS_IN_ORDER, 'R15: the header set never shrinks — all 28 headers still appear')
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

// ---------------------------------------------------------------------------
// R16 层级序 — the workbook's ROW ORDER is a function of the rows, not of the scan
// ---------------------------------------------------------------------------
//
// 反馈2「导出的层级乱了」. The export never sorted: it projected rows in `queryRecords` order, which
// with no `orderBy` is the records service's `ORDER BY id ASC` over `rec_${randomUUID()}` ids — a
// random order that also changes whenever a re-pull re-creates a row. These three witnesses pin the
// replacement order (父组件图号 → 明细排序号 → 图号 → 唯一键) at the MODULE level, where the route
// and the xlsx builder both inherit it.

/** [父组件图号, 图号, 名称] per exported row — the three cells the order is visible in. */
function orderedTriples(result) {
  return result.rows.map((cells) => [
    cells[columnIndex('parentComponentCode')],
    cells[columnIndex('componentCode')],
    cells[columnIndex('componentName')],
  ])
}

async function moduleExportOrderIsTheAgreedHierarchyOrder() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_ORDER,
    permission: 'admin',
  })
  assert.deepEqual(
    orderedTriples(result),
    [
      // TZ-A first (码点序: 'TZ-A' < 'TZ-B'), and the PACK-ONLY row joins its group: its native
      // 父组件图号 is empty and the value the workbook prints comes from ext_parentDrawingNo, so the
      // comparator must read the same fallback the projection does — sorting on the native column
      // alone would exile this row to the blank band.
      // 图号 decides these two, and it has to: their 唯一键 runs the other way (DWG-0 → idk-o-zzz,
      // DWG-1 → idk-o-aaa), so a comparator that lost the 图号 key would emit DWG-1 first.
      ['TZ-A', 'DWG-0', 'A组零号件'],
      ['TZ-A', 'DWG-1', 'A组一号件'],
      // Same parent AND same 图号 (one component reached through two BOM paths — the 反馈1 shape
      // this change does NOT fix): ordered by 唯一键 (idk-o-p1 before idk-o-p2), never by scan order,
      // and not by 名称 either — the names run the other way.
      ['TZ-A', 'DWG-2', '二号路径Z'],
      ['TZ-A', 'DWG-2', '二号路径A'],
      ['TZ-B', 'DWG-9', 'B组第一件'],
      // BLANK PARENT LAST — a row with no parent trails the grouped ones instead of sitting between
      // two groups (code-unit order would otherwise put '' first and split the workbook's head).
      [null, 'DWG-1', '无父件行'],
    ],
    'R16: 父组件图号 → 图号 → 唯一键 → 名称, blank parent last, pack fallback inside its own group',
  )
  assert.deepEqual(result.unresolvedColumns, [], 'R16: the order-only ids never surface as unresolved COLUMNS')
}

async function moduleExportOrderIsIndependentOfTheScanOrder() {
  // The same rows, handed to the module in the opposite order — the one thing a random-UUID scan
  // varies. A byte-identical projection is the proof the workbook is a function of the row set.
  const forward = moduleSubstrate()
  const reversed = moduleSubstrate({ seedOrder: (rows) => rows.slice().reverse() })
  const args = { projectNo: PROJECT_ORDER, permission: 'admin' }
  const first = await exportStockPreparationPrepLines({ recordsApi: forward.records, target: forward.target, ...args })
  const second = await exportStockPreparationPrepLines({ recordsApi: reversed.records, target: reversed.target, ...args })
  assert.deepEqual(second.rows, first.rows, 'R16: reversing the scan order changes nothing in the workbook')
  assert.equal(
    JSON.stringify(second.rows),
    JSON.stringify(first.rows),
    'R16: byte-identical — including the two rows that agree on parent and 图号 (唯一键 breaks the tie both times)',
  )
  // And a second export off the same substrate repeats itself (no hidden dependence on call count).
  const again = await exportStockPreparationPrepLines({ recordsApi: forward.records, target: forward.target, ...args })
  assert.equal(JSON.stringify(again.rows), JSON.stringify(first.rows), 'R16: two exports of an unchanged sheet are identical')
}

async function moduleExportOrderPrefersComponentSortNoWhereTheColumnExists() {
  // 明细排序号 is keyed for a column the frozen template does not have yet (SORT_FIELD_IDS explains
  // why). This drives BOTH deployments through the same seeds:
  //   - a target that BINDS `componentSortNo` (the shape the day that owner-gated column ships) —
  //     the 明细栏 sequence wins over 图号;
  //   - a target that does NOT (every deployment today) — the key is simply absent, the order falls
  //     through to 图号, and nothing is reported as unresolved.
  const { records, target } = moduleSubstrate()
  const withSortNo = {
    ...target,
    fieldIdMap: { ...target.fieldIdMap, componentSortNo: physicalFieldId(STAGING, MAIN_OBJECT_ID, 'componentSortNo') },
  }
  const sorted = await exportStockPreparationPrepLines({
    recordsApi: records,
    target: withSortNo,
    projectNo: PROJECT_SORTNO,
    permission: 'admin',
  })
  assert.deepEqual(
    sorted.rows.map((cells) => cells[columnIndex('componentCode')]),
    ['DWG-S9', 'DWG-S1', 'DWG-S5'],
    'R16: 明细排序号 10 before 20, and the row without one comes last — 图号 order would have been S1, S5, S9',
  )
  assert.deepEqual(sorted.unresolvedColumns, [], 'R16: a BOUND order-only id is not a column either')

  const today = await exportStockPreparationPrepLines({
    recordsApi: records,
    target,
    projectNo: PROJECT_SORTNO,
    permission: 'admin',
  })
  assert.deepEqual(
    today.rows.map((cells) => cells[columnIndex('componentCode')]),
    ['DWG-S1', 'DWG-S5', 'DWG-S9'],
    'R16: an unbound 明细排序号 does not participate — 图号 orders the group, deterministically',
  )
  assert.deepEqual(
    today.unresolvedColumns,
    [],
    'R16: an UNBOUND order-only id must NOT be reported as an unresolved column (it is not a column; reporting it would claim a blank cell that does not exist)',
  )
}

async function moduleExportOrderIsTotalEvenForRowsWithNoIdempotencyKey() {
  // R16d. 唯一键 being `required: true, key: true` is TEMPLATE metadata — the multitable layer never
  // reads it (provisioning.ts has no notion of `required`), so "every row has a distinct 唯一键" is
  // true of rows the apply path wrote through a binding target and of nothing else. A row typed into
  // the grid by hand has none. Three such rows here tie on all four business keys; two of them tie
  // on 名称 as well. Without the last two keys the comparator would return 0 for every pair and V8's
  // stable sort would hand back the scan order verbatim — i.e. these rows would still be
  // UUID-ordered, and two scans of one sheet could still produce two different workbooks.
  const forward = moduleSubstrate()
  const args = { projectNo: PROJECT_MANUAL, permission: 'admin' }
  const result = await exportStockPreparationPrepLines({ recordsApi: forward.records, target: forward.target, ...args })
  const nameAndMaterial = (r) => r.rows.map((cells) => [cells[columnIndex('componentName')], cells[columnIndex('material')]])
  assert.deepEqual(
    nameAndMaterial(result),
    [
      // 名称 first (A before Z), and within the two rows that share it the record id decides —
      // rec_h2 before rec_h3 — which is the only thing left that can.
      ['手工补录A', 'Q345B'],
      ['手工补录A', 'S30408'],
      ['手工补录Z', 'Q235B'],
    ],
    'R16d: rows with no 唯一键 are still ordered by 名称 then by record id, not left in scan order',
  )
  // The record id is an ORDER key, never a cell: it must not appear anywhere in the workbook.
  const cells = result.rows.flat().map((cell) => (cell === null ? '' : String(cell)))
  for (const recordId of ['rec_h1', 'rec_h2', 'rec_h3']) {
    assert.equal(cells.includes(recordId), false, `R16d: the physical record id ${recordId} is never projected into a cell`)
  }
  // And the proof it is an order at all rather than an accident of this scan: reverse the scan.
  const reversed = moduleSubstrate({ seedOrder: (rows) => rows.slice().reverse() })
  const second = await exportStockPreparationPrepLines({ recordsApi: reversed.records, target: reversed.target, ...args })
  assert.equal(
    JSON.stringify(second.rows),
    JSON.stringify(result.rows),
    'R16d: byte-identical under a reversed scan — including the two rows nothing a reader can see tells apart',
  )
}

async function moduleExportWithoutAnyParentBindingDegradesToDrawingOrder() {
  // R16e — the PRECONDITION on the first key, made a test rather than an assumption. An install
  // provisioned before 父组件图号 shipped binds neither the canonical column nor a pack one until the
  // additive repair verb heals it and the action target is rebound. Then key 1 is blank for EVERY
  // row: the workbook is still deterministic (this change's actual guarantee) but it is a flat 图号
  // list, not the 层级 反馈2 asked for — which is a deployment fact an operator has to be able to
  // see, not a silent degradation.
  const { records, target } = moduleSubstrate()
  const unhealed = targetWithout(target, ['parentComponentCode', 'ext_parentDrawingNo'])
  const result = await exportStockPreparationPrepLines({
    recordsApi: records,
    target: unhealed,
    projectNo: PROJECT_ORDER,
    permission: 'admin',
  })
  assert.deepEqual(result.headers, EXPORT_HEADERS_IN_ORDER, 'R16e: the header set never shrinks')
  assert.deepEqual(
    result.rows.map((cells) => cells[columnIndex('parentComponentCode')]),
    [null, null, null, null, null, null],
    'R16e: with neither binding every 父组件图号 cell is blank — there is no band to group by',
  )
  assert.deepEqual(
    result.rows.map((cells) => [cells[columnIndex('componentCode')], cells[columnIndex('componentName')]]),
    [
      ['DWG-0', 'A组零号件'],
      // Two DWG-1 rows: 唯一键 orders them ('idk-PRJ-ORDER-DWG-1' < 'idk-o-aaa' in code units).
      ['DWG-1', '无父件行'],
      ['DWG-1', 'A组一号件'],
      ['DWG-2', '二号路径Z'],
      ['DWG-2', '二号路径A'],
      ['DWG-9', 'B组第一件'],
    ],
    'R16e: degrades to a pure 图号 order — deterministic, but NOT hierarchical',
  )
  assert.deepEqual(
    result.unresolvedColumns.slice().sort(),
    ['ext_parentDrawingNo', 'parentComponentCode'],
    'R16e: the missing hierarchy source is REPORTED, so "no parents bound" is distinguishable from "this project has no parents"',
  )
}

// ---------------------------------------------------------------------------
// F1c — 深度优先 BOM 树序 + 老系统的同父去重(展示层兜底) + 补齐的老系统 23 列
//
// R17 打乱顺序喂进来 => 根 -> 子 -> 孙 的树序,兄弟按 明细排序号(客户包列 ext_componentSortNo)。
// R18 同父同键的重复行按老系统合并,合并条数如实上报(collapsedRowCount),重复行的子树跟着走。
//    这批行带 ext_nameAndSpec(名称及规格):展示层只在这把键**还原得出来**的时候才合并 ——
//    包列有值是三种可证形状里的第一种(见 displayDedupeKey);第三种(规格 有值、包列为空)
//    不可证,一行不并,那是 R22。
// R19 孤儿行(父路径不在这批里)当根打印,一行都不少;孤儿自己的子行紧跟在它后面(父在子前),
//    不是被平比较器扫到末尾。「父路径不在批内 ⇒ 当根」这一子句的判别用例就是 R17 里孤儿带子行的
//    那两行(子行的 父组件图号 按平比较器排在孤儿的前面 —— 子句拿掉,顺序断言必红)+ R24a。
// R20 没有 部件源ID 的老部署退回 F1b 的平比较器(treeOrdered: false),不比改之前更乱。
// ---------------------------------------------------------------------------

const PROJECT_TREE = 'PRJ-TREE'

// `withPath: false` models the sheet an OLD target produced — `path` never bound, so the rows carry
// 部件源ID but no row path (R23d: the degraded identity scheme).
function treeRows({ withPath = true } = {}) {
  const shared = {
    parentComponentCode: 'TZ-T0',
    parentComponentName: 'T主体',
    ext_parentDrawingNo: 'TZ-T0',
    ext_parentName: 'T主体',
    material: 'Q235B',
  }
  const pathOf = (...tokens) => (withPath ? bomPath(...tokens) : undefined)
  return [
    // 打乱:孙 -> 孤儿的子件 -> 重复兄弟 -> 兄弟B -> 孤儿 -> 根 -> 兄弟A。没有任何一个比较器会产出这个顺序。
    mainRow(PROJECT_TREE, {
      ...shared, componentCode: 'DWG-T-A1', componentName: 'A的子件',
      ext_nameAndSpec: 'A的子件',
      componentSourceId: 'P-A', parentSourceId: 'P-A0', ext_componentSortNo: 10,
      path: pathOf('P-ROOT', 'P-A0', 'P-A'),
      idempotencyKey: 'idk-t-a1',
    }, 'rec_t_a1'),
    // 孤儿的子件:父路径 ["P-GONE","P-X"] 在批内(就是下面那个孤儿),所以它挂在孤儿之下,不是再当
    // 一个根。故意排在孤儿**前面**喂进来,而且它的 父组件图号(DWG-T-X)按平比较器排在孤儿的
    // (TZ-T0)前面:「父路径不在批内 ⇒ 当根」这一子句一旦拿掉,孤儿和它都掉进末尾的 stranded
    // 追加、被平比较器排成子先于父 —— R17 的顺序断言就红(行数不少,树序错)。
    mainRow(PROJECT_TREE, {
      ...shared, componentCode: 'DWG-T-XC', componentName: '孤儿的子件',
      ext_nameAndSpec: '孤儿的子件',
      parentComponentCode: 'DWG-T-X', parentComponentName: '孤儿件',
      ext_parentDrawingNo: 'DWG-T-X', ext_parentName: '孤儿件',
      componentSourceId: 'P-X-C', parentSourceId: 'P-X', ext_componentSortNo: 1,
      path: pathOf('P-GONE', 'P-X', 'P-X-C'),
      idempotencyKey: 'idk-t-xc',
    }, 'rec_t_xc'),
    mainRow(PROJECT_TREE, {
      ...shared, componentCode: 'DWG-T-B', componentName: 'B件',
      ext_nameAndSpec: 'B件',
      componentSourceId: 'P-B-DUP', parentSourceId: 'P-ROOT', ext_componentSortNo: 20,
      path: pathOf('P-ROOT', 'P-B-DUP'),
      idempotencyKey: 'idk-t-b-dup',
    }, 'rec_t_bdup'),
    mainRow(PROJECT_TREE, {
      ...shared, componentCode: 'DWG-T-B', componentName: 'B件',
      ext_nameAndSpec: 'B件',
      componentSourceId: 'P-B', parentSourceId: 'P-ROOT', ext_componentSortNo: 20,
      path: pathOf('P-ROOT', 'P-B'),
      idempotencyKey: 'idk-t-b',
    }, 'rec_t_b'),
    // 孤儿:父路径 ["P-GONE"] 不在这批里 => 当根。排序号 15 故意小于兄弟 B 的 20:根这一层的排序
    // 号只在根之间比,ROOT 的整棵子树(含 B)先打印完,孤儿才作为下一个根出现 —— 不会插到 B 前面。
    mainRow(PROJECT_TREE, {
      ...shared, componentCode: 'DWG-T-X', componentName: '孤儿件',
      ext_nameAndSpec: '孤儿件',
      componentSourceId: 'P-X', parentSourceId: 'P-GONE', ext_componentSortNo: 15,
      path: pathOf('P-GONE', 'P-X'),
      idempotencyKey: 'idk-t-x',
    }, 'rec_t_x'),
    mainRow(PROJECT_TREE, {
      ...shared, componentCode: 'DWG-T-ROOT', componentName: '根件',
      ext_nameAndSpec: '根件',
      parentComponentCode: undefined, parentComponentName: undefined,
      ext_parentDrawingNo: undefined, ext_parentName: undefined,
      componentSourceId: 'P-ROOT', parentSourceId: undefined, ext_componentSortNo: 1,
      path: pathOf('P-ROOT'),
      idempotencyKey: 'idk-t-root',
    }, 'rec_t_root'),
    mainRow(PROJECT_TREE, {
      ...shared, componentCode: 'DWG-T-A0', componentName: 'A件',
      ext_nameAndSpec: 'A件',
      componentSourceId: 'P-A0', parentSourceId: 'P-ROOT', ext_componentSortNo: 5,
      path: pathOf('P-ROOT', 'P-A0'),
      idempotencyKey: 'idk-t-a0',
    }, 'rec_t_a0'),
  ]
}

function treeSubstrate() {
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [SANDBOX_SHEET]: MAIN_OBJECT_ID },
    rowsBySheet: { [SANDBOX_SHEET]: treeRows() },
  })
  return { records, target: targetFor(SANDBOX_SHEET) }
}

async function moduleExportOrderIsTheBomTreeNotAFlatBand() {
  const { records, target } = treeSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records, target, projectNo: PROJECT_TREE, permission: 'admin',
  })
  const codeColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
  const codes = result.rows.map((row) => row[codeColumn])
  assert.deepEqual(
    codes,
    ['DWG-T-ROOT', 'DWG-T-A0', 'DWG-T-A1', 'DWG-T-B', 'DWG-T-X', 'DWG-T-XC'],
    'R17: 根 -> (排序号 5)A件 -> A件的子件 -> (排序号 20)B件;孤儿(排序号 15)在根的整棵子树之后当根打印,孤儿的子件紧跟在它后面',
  )
  // R19: 「父路径不在批内 ⇒ 当根」这一子句有它自己的判别 —— 孤儿的子行必须紧跟在孤儿之后(父在
  // 子前)。子句拿掉,孤儿与子行都掉进末尾的 stranded 追加,平比较器按 父组件图号 排出
  // DWG-T-XC(父 DWG-T-X)先于 DWG-T-X(父 TZ-T0):子先于父。行数一样,顺序不一样。
  assert.ok(
    codes.indexOf('DWG-T-X') === codes.indexOf('DWG-T-XC') - 1,
    'R19: 孤儿按树位置当根打印、它的子件紧跟其后 —— 不是被平比较器扫到末尾排成子先于父',
  )
  // R18: 同父同键的那条重复行被合并,并且合并条数如实上报。
  assert.equal(result.collapsedRowCount, 1, 'R18: 一条同父同键的重复行被合并')
  assert.equal(result.activeRowCount, 7, 'R18: 合并是打印层的事,行数统计仍是表里的真实行数')
  assert.equal(result.rows.length, 6)
  assert.equal(result.treeOrdered, true)
}

async function moduleExportWithoutSourceIdentityKeepsTheFlatOrder() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records, target, projectNo: PROJECT_ORDER, permission: 'admin',
  })
  // 这批行一个 部件源ID 都没有(老部署 / 手工行),树建不起来 => 退回 F1b 的平比较器,
  // 也就是 R16 已经钉住的那个顺序,而不是把每一行都当根从而丢掉按父组件分带。
  assert.equal(result.treeOrdered, false, 'R20: 认不出身份就明说,而不是假装排了树序')
  assert.equal(result.collapsedRowCount, 0)
  const codeColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
  assert.deepEqual(
    result.rows.map((row) => row[codeColumn]),
    ['DWG-0', 'DWG-1', 'DWG-2', 'DWG-2', 'DWG-9', 'DWG-1'],
    'R20: F1b 的顺序原样保留(TZ-A 组 -> TZ-B 组 -> 无父件行)',
  )
}

async function moduleLegacyTwentyThreeColumnsAreProjected() {
  const { records, target } = moduleSubstrate()
  const result = await exportStockPreparationPrepLines({
    recordsApi: records, target, projectNo: PROJECT_A, permission: 'admin',
  })
  // 老系统 exportExcel 1536-1560 的 23 个表头里,这张工作簿现在能给出的那些(逐个点名,
  // 而不是只数个数)。缺的那一个是「序号」—— 它是导出时现编的行号,不是任何一列的值。
  const labels = result.headers
  for (const label of ['备料日期', '生产编号', '父组件图号', '父组件名称', '名称及规格', '规格',
    '材料', '总数量', '材料类型', '毛胚类型', '备注', '领料节点', '交接工段', '需求日期',
    '提前周期(天)', '备料情况', '毛胚长度', '毛胚宽度', '毛胚厚度', '毛胚数量', '毛胚质量']) {
    assert.ok(labels.includes(label), `老系统这一列在导出里有对应表头: ${label}`)
  }
  assert.equal(labels.includes('序号'), false, '「序号」是行号不是列值,留在 PR 的缺列清单里交 owner')
  // 老列没挪窝:前 17 列仍是 #5447 之后那一版的顺序。
  assert.deepEqual(labels.slice(0, 17), EXPORT_HEADERS_IN_ORDER.slice(0, 17))
  // 生产编号 真的有值(它同时是作用域列,取的是同一个绑定)。
  const projectColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'projectNo')
  assert.equal(result.rows[0][projectColumn], PROJECT_A)
}

// ---------------------------------------------------------------------------
// R21 — 同图号、不同规格的两个标准件,两行都要打印(老系统 iterHandle 686-693 的注释明说,加
// 名称/材质进键就是为了不把同图号的标准件合并掉)。
//
// 这条钉的是展示层去重键在**最弱的那种部署**上的强度:没装客户包(或装了包但动作没在
// extensionFieldIds 里声明 名称及规格),所以 ext_nameAndSpec 恒空;而 F1c 之后 名称 列只装
// identityName 的**首段**(bom-expansion createRow 用 splitNameAndSpec 切过)。此时键的第三项
// 若只取 名称,两条 螺栓 就会撞成同一个键 —— 并且被合并那条连它的整棵子树一起不打印。
// 去掉 nameAndSpecDisplayKey 里的 规格 退回一项,这个用例必红。
// ---------------------------------------------------------------------------

const PROJECT_STANDARD_PARTS = 'PRJ-STD'

function standardPartRows() {
  const shared = {
    parentComponentCode: 'TZ-S0',
    parentComponentName: 'S主体',
    // 无包部署:两个包列都不存在。名称及规格 因此恒空,规格 只能从模板列取。
    ext_parentDrawingNo: undefined,
    ext_parentName: undefined,
    ext_spec: undefined,
    ext_nameAndSpec: undefined,
    material: 'Q235B',
    totalQuantity: 4,
  }
  return [
    mainRow(PROJECT_STANDARD_PARTS, {
      ...shared,
      parentComponentCode: undefined, parentComponentName: undefined,
      componentCode: 'TZ-S0', componentName: 'S主体', componentSpec: undefined,
      componentSourceId: 'P-S0', parentSourceId: undefined, ext_componentSortNo: 1,
      path: bomPath('P-S0'),
      idempotencyKey: 'idk-s0',
    }, 'rec_s0'),
    mainRow(PROJECT_STANDARD_PARTS, {
      ...shared,
      componentCode: 'GB/T5783', componentName: '螺栓', componentSpec: 'M8x30',
      componentSourceId: 'P-S1', parentSourceId: 'P-S0', ext_componentSortNo: 10,
      path: bomPath('P-S0', 'P-S1'),
      idempotencyKey: 'idk-s1',
    }, 'rec_s1'),
    mainRow(PROJECT_STANDARD_PARTS, {
      ...shared,
      componentCode: 'GB/T5783', componentName: '螺栓', componentSpec: 'M10x40',
      componentSourceId: 'P-S2', parentSourceId: 'P-S0', ext_componentSortNo: 20,
      path: bomPath('P-S0', 'P-S2'),
      idempotencyKey: 'idk-s2',
    }, 'rec_s2'),
    // 挂在第二个标准件下的子件 —— 合并会把整棵子树一起吞掉,所以它是「被吞了」最直接的证据。
    mainRow(PROJECT_STANDARD_PARTS, {
      ...shared,
      parentComponentCode: 'GB/T5783', parentComponentName: '螺栓',
      componentCode: 'WASHER-1', componentName: '垫圈', componentSpec: 'D10',
      componentSourceId: 'P-S2-C', parentSourceId: 'P-S2', ext_componentSortNo: 5,
      path: bomPath('P-S0', 'P-S2', 'P-S2-C'),
      idempotencyKey: 'idk-s2c',
    }, 'rec_s2c'),
  ]
}

async function moduleSameDrawingDifferentSpecIsNotCollapsed() {
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [SANDBOX_SHEET]: MAIN_OBJECT_ID },
    rowsBySheet: { [SANDBOX_SHEET]: standardPartRows() },
  })
  const result = await exportStockPreparationPrepLines({
    recordsApi: records, target: targetFor(SANDBOX_SHEET), projectNo: PROJECT_STANDARD_PARTS, permission: 'admin',
  })
  const codeColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
  const specColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentSpec')
  assert.deepEqual(
    result.rows.map((row) => [row[codeColumn], row[specColumn]]),
    [['TZ-S0', null], ['GB/T5783', 'M8x30'], ['GB/T5783', 'M10x40'], ['WASHER-1', 'D10']],
    'R21: 同图号不同规格的两个标准件都要打印,第二个的子件跟着打印',
  )
  assert.equal(result.collapsedRowCount, 0, 'R21: 一行都没被合并 —— 它们不是重复行')
  assert.equal(result.treeOrdered, true)
}

// ---------------------------------------------------------------------------
// R22 — 部署自己声明了 规格 列(readPlan.part.specField)时,展示层拼不回老系统那一串,
// 于是**一行不并**。
//
// 声明了 specField 的部署上(dn-pdm-family.preset 把 规格 叫做 a part-side dictionary
// assignment),规格 是 part 侧的字典值,不是 identityName 的尾巴;而 F1c 之后 名称 列只装
// 首段。两行 identityName 分别是「螺栓 M8x30」「螺栓 M10x40」、规格 列却同为「碳钢」时,
// 名称 + 规格 拼出来的串对这两行**完全相同** —— 比展开层那把键(比未切分全串)更**粗**。
// 照拼就会把两个合法的不同标准件并成一行,还连第二件的子件一起吞掉(collapseSubtree)。
//
// 拿掉 walk 里的 `key !== null` 守卫(或让 displayDedupeKey 的不可证分支照拼)⇒ 本用例必红:
// 打印 2 行而不是 4 行,collapsedRowCount 从 0 变 2。R21 盖不住这个形状 —— R21 那两行的 规格
// 是不同值。
// ---------------------------------------------------------------------------

const PROJECT_DECLARED_SPEC = 'PRJ-DECL-SPEC'

function declaredSpecColumnRows({ packNameAndSpec } = {}) {
  const shared = {
    // 无包(或包列未声明):名称及规格 恒空 —— 展示层唯一可证的那条路被关掉。
    ext_parentDrawingNo: undefined,
    ext_parentName: undefined,
    ext_spec: undefined,
    ext_nameAndSpec: undefined,
    parentComponentCode: 'TZ-D0',
    parentComponentName: 'D主体',
    material: '碳钢',
    totalQuantity: 2,
  }
  return [
    mainRow(PROJECT_DECLARED_SPEC, {
      ...shared,
      parentComponentCode: undefined, parentComponentName: undefined,
      componentCode: 'J100-00', componentName: 'D主体', componentSpec: undefined,
      componentSourceId: 'P-D0', parentSourceId: undefined, ext_componentSortNo: 1,
      path: bomPath('P-D0'),
      idempotencyKey: 'idk-d0',
    }, 'rec_d0'),
    // 两个标准件:图号/名称(首段)/材质/用量全同,规格 列同为字典值「碳钢」。
    // 它们的源串(identityName)是「螺栓 M8x30」「螺栓 M10x40」—— 合法的两行。
    mainRow(PROJECT_DECLARED_SPEC, {
      ...shared,
      componentCode: 'GB/T5783', componentName: '螺栓', componentSpec: '碳钢',
      componentSourceId: 'P-D1', parentSourceId: 'P-D0', ext_componentSortNo: 10,
      path: bomPath('P-D0', 'P-D1'),
      ext_nameAndSpec: packNameAndSpec,
      idempotencyKey: 'idk-d1',
    }, 'rec_d1'),
    mainRow(PROJECT_DECLARED_SPEC, {
      ...shared,
      componentCode: 'GB/T5783', componentName: '螺栓', componentSpec: '碳钢',
      componentSourceId: 'P-D2', parentSourceId: 'P-D0', ext_componentSortNo: 20,
      path: bomPath('P-D0', 'P-D2'),
      ext_nameAndSpec: packNameAndSpec,
      idempotencyKey: 'idk-d2',
    }, 'rec_d2'),
    mainRow(PROJECT_DECLARED_SPEC, {
      ...shared,
      parentComponentCode: 'GB/T5783', parentComponentName: '螺栓 M10x40',
      componentCode: 'WASHER-9', componentName: '垫圈', componentSpec: '碳钢',
      componentSourceId: 'P-D2-C', parentSourceId: 'P-D2', ext_componentSortNo: 5,
      path: bomPath('P-D0', 'P-D2', 'P-D2-C'),
      idempotencyKey: 'idk-d2c',
    }, 'rec_d2c'),
  ]
}

async function moduleDeclaredSpecColumnNeverCollapsesTwoDifferentStandardParts() {
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [SANDBOX_SHEET]: MAIN_OBJECT_ID },
    rowsBySheet: { [SANDBOX_SHEET]: declaredSpecColumnRows() },
  })
  const result = await exportStockPreparationPrepLines({
    recordsApi: records, target: targetFor(SANDBOX_SHEET), projectNo: PROJECT_DECLARED_SPEC, permission: 'admin',
  })
  const codeColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
  assert.deepEqual(
    result.rows.map((row) => row[codeColumn]),
    ['J100-00', 'GB/T5783', 'GB/T5783', 'WASHER-9'],
    'R22: 声明了 规格 列时,名称+规格 拼出的串撞了也不许合并 —— 两个标准件都打印,第二件的子件跟着打印',
  )
  assert.equal(result.collapsedRowCount, 0, 'R22: 一行都没被合并')
  assert.equal(result.treeOrdered, true, 'R22: 树序照给 —— 放弃的是兜底去重,不是树序')
  // 正控:同一个形状,只要 名称及规格 包列有值(可证的那一支),这两行就**该**被合并 —— 证明
  // R22 放弃的是不可证的那一支,不是整把键塌了。
  const packedRecords = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [SANDBOX_SHEET]: MAIN_OBJECT_ID },
    rowsBySheet: { [SANDBOX_SHEET]: declaredSpecColumnRows({ packNameAndSpec: '螺栓 M8x30' }) },
  })
  const packed = await exportStockPreparationPrepLines({
    recordsApi: packedRecords, target: targetFor(SANDBOX_SHEET), projectNo: PROJECT_DECLARED_SPEC, permission: 'admin',
  })
  assert.deepEqual(
    packed.rows.map((row) => row[codeColumn]),
    ['J100-00', 'GB/T5783'],
    'R22 正控:名称及规格 可证且相同 ⇒ 第二件连同它的子件一起被合并(老系统 iterHandle 的行为)',
  )
  assert.equal(packed.collapsedRowCount, 2, 'R22 正控:合并条数含被吞掉的子树')
}

// ---------------------------------------------------------------------------
// R23 — 树节点的身份是**行路径**,不是部件 id(终审 r1 blocker 1)。
//
// 老系统 `iterHandle` 682-684 按 `parentId == 父行 id` 取子级:一行 = 一个节点,共用子装配(「通用
// 组件」)挂在两个父件下就是两行,各带自己的子行。按 `componentSourceId`/`parentSourceId`(部件 id)
// 建树会把两支子行合成一个兄弟集合,第二支同键的子行被 collapseSubtree 整棵吞掉 —— 导出少行。
//
// R23a 共用子装配:同一 componentSourceId 挂两个父件、各带同键子件 ⇒ 6 行全打印、collapsedRowCount
//      = 0、顺序 = 老系统 iterHandle(kX > kP@X > kC@X > kY > kP@Y > kC@Y)。
//      变异 M-A「父身份换回 componentSourceId」⇒ 红(5 行、collapsed 1)。
// R23b 去重作用域 = 同一父**行**:P@X 之下两条真重复兄弟并成一条,P@Y 之下的同键子件照打。
//      变异 M-B「seenKeys 提到 walk 外(全局)」⇒ 红(collapsed 从 1 变 2)。
// R23c 编码器钉死:导出侧 encodeBomPath ≡ 展开侧 makePath;父 = 去掉最后一段再编码;根 = 单段。
// R23d 没有 path 的老 target 退回部件 id 方案,返回值标 treeDegraded(不是悄悄降级)。
// R23e 规格 列未绑(行上既无 componentSpec 也无 ext_spec 键)时展示层键不可证 —— 不并。
// R24a 根判定的「父路径不在批内 ⇒ 当根」子句:孤儿带子行,直接喂 orderRowsAsBomTree 看幂等键序列。
//      变异 M-F「根判定只认 parent === null」⇒ 孤儿与子行掉进 stranded 追加、平比较器排成子先于父 ⇒ 红。
// R24b 降级方案的环(两行无 path、componentSourceId/parentSourceId 互指):两行都不是根、永不被 walk
//      到,只有末尾的 stranded 追加能把它们打印出来;treeDegraded 必为 true。行路径方案下这条不可达
//      (父路径恒比子路径短一段)。变异 M-J「删掉 stranded 追加」⇒ 两行整行消失 ⇒ 红。
// ---------------------------------------------------------------------------

const PROJECT_SHARED = 'PRJ-SHARED-SUBASSEMBLY'

// 逻辑行(直接喂 orderRowsAsBomTree 用,能看见幂等键),以及经 mainRow 落到表里的物理行。
// `withDuplicateUnderX` 给 P@X 再加一条与 C@X 同键的真重复兄弟(R23b)。
function sharedSubassemblyLogicalRows({ withDuplicateUnderX = false } = {}) {
  const rows = [
    // 打乱:C@Y -> P@Y -> X -> C@X -> Y -> P@X。
    {
      componentCode: 'DWG-C', componentName: '共用子件', ext_nameAndSpec: '共用子件', material: 'Q235B', rawQuantity: 1,
      parentComponentCode: 'DWG-P', parentComponentName: '共用组件',
      componentSourceId: 'P-C', parentSourceId: 'P-SHARED', path: bomPath('P-Y', 'P-SHARED', 'P-C'),
      ext_componentSortNo: 5, idempotencyKey: 'idk-c-at-y', __id: 'rec_sh_c_y',
    },
    {
      componentCode: 'DWG-P', componentName: '共用组件', ext_nameAndSpec: '共用组件', material: 'Q235B', rawQuantity: 1,
      parentComponentCode: 'DWG-Y', parentComponentName: 'Y总成',
      componentSourceId: 'P-SHARED', parentSourceId: 'P-Y', path: bomPath('P-Y', 'P-SHARED'),
      ext_componentSortNo: 10, idempotencyKey: 'idk-p-at-y', __id: 'rec_sh_p_y',
    },
    {
      componentCode: 'DWG-X', componentName: 'X总成', ext_nameAndSpec: 'X总成', material: 'Q235B', rawQuantity: 1,
      parentComponentCode: undefined, parentComponentName: undefined,
      componentSourceId: 'P-X', parentSourceId: undefined, path: bomPath('P-X'),
      ext_componentSortNo: 1, idempotencyKey: 'idk-x', __id: 'rec_sh_x',
    },
    {
      componentCode: 'DWG-C', componentName: '共用子件', ext_nameAndSpec: '共用子件', material: 'Q235B', rawQuantity: 1,
      parentComponentCode: 'DWG-P', parentComponentName: '共用组件',
      componentSourceId: 'P-C', parentSourceId: 'P-SHARED', path: bomPath('P-X', 'P-SHARED', 'P-C'),
      ext_componentSortNo: 5, idempotencyKey: 'idk-c-at-x', __id: 'rec_sh_c_x',
    },
    {
      componentCode: 'DWG-Y', componentName: 'Y总成', ext_nameAndSpec: 'Y总成', material: 'Q235B', rawQuantity: 1,
      parentComponentCode: undefined, parentComponentName: undefined,
      componentSourceId: 'P-Y', parentSourceId: undefined, path: bomPath('P-Y'),
      ext_componentSortNo: 2, idempotencyKey: 'idk-y', __id: 'rec_sh_y',
    },
    {
      componentCode: 'DWG-P', componentName: '共用组件', ext_nameAndSpec: '共用组件', material: 'Q235B', rawQuantity: 1,
      parentComponentCode: 'DWG-X', parentComponentName: 'X总成',
      componentSourceId: 'P-SHARED', parentSourceId: 'P-X', path: bomPath('P-X', 'P-SHARED'),
      ext_componentSortNo: 10, idempotencyKey: 'idk-p-at-x', __id: 'rec_sh_p_x',
    },
  ]
  if (withDuplicateUnderX) {
    // 与 C@X 同一父行、同一把键(父图号/图号/名称及规格/材质/用量全同)—— 两条 active bomHead
    // 指着同一条明细那种真重复。幂等键排在 C@X 之后,所以被并的是它。
    rows.push({
      componentCode: 'DWG-C', componentName: '共用子件', ext_nameAndSpec: '共用子件', material: 'Q235B', rawQuantity: 1,
      parentComponentCode: 'DWG-P', parentComponentName: '共用组件',
      componentSourceId: 'P-C-DUP', parentSourceId: 'P-SHARED', path: bomPath('P-X', 'P-SHARED', 'P-C-DUP'),
      ext_componentSortNo: 5, idempotencyKey: 'idk-c-at-x-dup', __id: 'rec_sh_c_x_dup',
    })
  }
  return rows
}

function sharedSubassemblyPhysicalRows(options) {
  return sharedSubassemblyLogicalRows(options).map(({ __id, ...row }) => mainRow(PROJECT_SHARED, {
    ...row,
    ext_parentDrawingNo: row.parentComponentCode,
    ext_parentName: row.parentComponentName,
  }, __id))
}

async function exportSharedSubassembly(options) {
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [SANDBOX_SHEET]: MAIN_OBJECT_ID },
    rowsBySheet: { [SANDBOX_SHEET]: sharedSubassemblyPhysicalRows(options) },
  })
  return exportStockPreparationPrepLines({
    recordsApi: records, target: targetFor(SANDBOX_SHEET), projectNo: PROJECT_SHARED, permission: 'admin',
  })
}

async function moduleSharedSubassemblyPrintsUnderEveryParentRow() {
  const codeColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
  const parentColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'parentComponentCode')
  const result = await exportSharedSubassembly()
  assert.deepEqual(
    result.rows.map((row) => [row[codeColumn], row[parentColumn]]),
    [['DWG-X', null], ['DWG-P', 'DWG-X'], ['DWG-C', 'DWG-P'], ['DWG-Y', null], ['DWG-P', 'DWG-Y'], ['DWG-C', 'DWG-P']],
    'R23a: 共用组件在 X、Y 之下各打印一次,各自的子件跟着各自的父行 —— 老系统 iterHandle 的顺序',
  )
  assert.equal(result.rows.length, 6, 'R23a: 6 行一行不少')
  assert.equal(result.collapsedRowCount, 0, 'R23a: 跨父行的同键子件不是重复行,一行都不并')
  assert.equal(result.treeOrdered, true)
  assert.equal(result.treeIdentity, 'path', 'R23a: 树是按行路径建的')
  assert.equal(result.treeDegraded, false)
  // 直接看幂等键序列:两条 C 在投影里长得一样,这里把「哪条 C 跟着哪个父行」钉死。
  const ordering = exportInternals.orderRowsAsBomTree(sharedSubassemblyLogicalRows())
  assert.deepEqual(
    ordering.rows.map((row) => row.idempotencyKey),
    ['idk-x', 'idk-p-at-x', 'idk-c-at-x', 'idk-y', 'idk-p-at-y', 'idk-c-at-y'],
    'R23a: kX > kP@X > kC@X > kY > kP@Y > kC@Y',
  )
  assert.equal(ordering.collapsedRowCount, 0)
}

async function moduleDedupeScopeIsTheParentRowNotTheParentPart() {
  const result = await exportSharedSubassembly({ withDuplicateUnderX: true })
  assert.equal(result.activeRowCount, 7)
  assert.equal(result.rows.length, 6, 'R23b: P@X 之下的真重复兄弟并成一条,P@Y 之下的同键子件照打')
  assert.equal(result.collapsedRowCount, 1, 'R23b: 恰好并掉一条 —— 作用域是同一父行,不是同一父部件、更不是全局')
  const ordering = exportInternals.orderRowsAsBomTree(sharedSubassemblyLogicalRows({ withDuplicateUnderX: true }))
  assert.deepEqual(
    ordering.rows.map((row) => row.idempotencyKey),
    ['idk-x', 'idk-p-at-x', 'idk-c-at-x', 'idk-y', 'idk-p-at-y', 'idk-c-at-y'],
    'R23b: 被并的是 P@X 之下幂等键靠后的那条(idk-c-at-x-dup),C@Y 不受影响',
  )
  assert.equal(ordering.collapsedRowCount, 1)
}

function moduleBomPathEncoderIsTheExpandersOwn() {
  const tokens = ['P-ROOT', 'P-A0', 'P-A']
  assert.equal(
    exportInternals.encodeBomPath(tokens),
    bomExpansionInternals.makePath(tokens),
    'R23c: 导出侧的路径编码器与展开侧 makePath 逐字相同 —— 两边漂了这条就红',
  )
  assert.deepEqual(
    exportInternals.pathIdentityOf({ path: bomPath('P-ROOT', 'P-A0', 'P-A') }),
    { self: bomPath('P-ROOT', 'P-A0', 'P-A'), parent: bomPath('P-ROOT', 'P-A0') },
    'R23c: 父 = 去掉最后一段 tokens 再用同一编码器',
  )
  assert.deepEqual(
    exportInternals.pathIdentityOf({ path: bomPath('P-ROOT') }),
    { self: bomPath('P-ROOT'), parent: null },
    'R23c: 单段路径 = 根',
  )
  // 存进表里的串多了空白也归一到规范串 —— 身份比较的是 tokens,不是字节。
  assert.deepEqual(
    exportInternals.pathIdentityOf({ path: ' ["P-ROOT", "P-A0"] ' }),
    { self: bomPath('P-ROOT', 'P-A0'), parent: bomPath('P-ROOT') },
  )
  for (const bad of [undefined, null, '', '   ', 'not json', '{}', '[]', '"P-ROOT"', 42]) {
    assert.equal(exportInternals.pathIdentityOf({ path: bad }), null, `R23c: 不是非空 JSON 数组的一律认不出身份: ${JSON.stringify(bad)}`)
  }
  assert.equal(exportInternals.pathIdentityOf({}), null)
  assert.ok(exportInternals.SORT_FIELD_IDS.includes('path'), 'R23c: path 是解析出来供建树用的 id(不投影、不报 unresolvedColumns)')
  assert.equal(EXPORT_COLUMNS.some((column) => column.id === 'path'), false, 'R23c: path 从不成为一列')
}

async function moduleRowsWithoutAPathDegradeToThePartIdentityAndSaySo() {
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [SANDBOX_SHEET]: MAIN_OBJECT_ID },
    rowsBySheet: { [SANDBOX_SHEET]: treeRows({ withPath: false }) },
  })
  const result = await exportStockPreparationPrepLines({
    recordsApi: records, target: targetFor(SANDBOX_SHEET), projectNo: PROJECT_TREE, permission: 'admin',
  })
  const codeColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
  assert.deepEqual(
    result.rows.map((row) => row[codeColumn]),
    ['DWG-T-ROOT', 'DWG-T-A0', 'DWG-T-A1', 'DWG-T-B', 'DWG-T-X', 'DWG-T-XC'],
    'R23d: 没有 path 的老 target 仍拿到树序(没有共用子装配时和行路径方案同序,孤儿子树也一样)',
  )
  assert.equal(result.treeOrdered, true)
  assert.equal(result.treeIdentity, 'componentSourceId', 'R23d: 用的是部件 id 方案')
  assert.equal(result.treeDegraded, true, 'R23d: 降级要标出来,不许悄悄地退')
  assert.equal(result.collapsedRowCount, 1)
  // 正控:同一批行带上 path 就是主方案。
  const withPath = await (async () => {
    const { records: pathRecords, target } = treeSubstrate()
    return exportStockPreparationPrepLines({ recordsApi: pathRecords, target, projectNo: PROJECT_TREE, permission: 'admin' })
  })()
  assert.equal(withPath.treeIdentity, 'path')
  assert.equal(withPath.treeDegraded, false)
  // 混批:哪怕只有一行带 path,也走行路径方案;没 path 的那行认不出父,当根打印,一行不少。
  const mixed = exportInternals.orderRowsAsBomTree([
    { componentCode: 'R', componentSourceId: 'P-R', path: bomPath('P-R'), idempotencyKey: 'idk-r', ext_componentSortNo: 1 },
    { componentCode: 'K', componentSourceId: 'P-K', parentSourceId: 'P-R', path: bomPath('P-R', 'P-K'), idempotencyKey: 'idk-k' },
    { componentCode: 'H', componentSourceId: 'P-H', parentSourceId: 'P-R', idempotencyKey: 'idk-h', ext_componentSortNo: 2 },
  ])
  assert.equal(mixed.treeIdentity, 'path')
  assert.equal(mixed.treeDegraded, false)
  assert.deepEqual(mixed.rows.map((row) => row.idempotencyKey), ['idk-r', 'idk-k', 'idk-h'], 'R23d: 手工行(无 path)当根排在后面,不丢')
}

// R24a 「父路径不在批内 ⇒ 当根」的判别用例。R(排序 1)> K(排序 5);孤儿 O(排序 2,父路径 ["P-GONE"]
// 不在批内)带子行 OC(排序 1)。修后 [idk-r, idk-k, idk-o, idk-oc]。把根判定改成只认 parent === null
// (变异 M-F),O 与 OC 都不是根、也没人 walk 到它们,掉进末尾的 stranded 追加;平比较器先比 父组件图号
// (OC 的 DWG-O < O 的 ZZ-GONE),再比排序号(OC 的 1 < O 的 2)—— 两个键都把子排到父前面:
// [idk-r, idk-k, idk-oc, idk-o]。行数一样,树序错。
function moduleOrphanSubtreeIsRootedInPlaceNotStrandedAtTheEnd() {
  const result = exportInternals.orderRowsAsBomTree([
    // 打乱:孤儿的子行 -> K -> 孤儿 -> R。
    {
      componentCode: 'OC', parentComponentCode: 'DWG-O', componentSourceId: 'P-OC', parentSourceId: 'P-O',
      path: bomPath('P-GONE', 'P-O', 'P-OC'), idempotencyKey: 'idk-oc', ext_componentSortNo: 1,
    },
    {
      componentCode: 'K', parentComponentCode: 'DWG-R', componentSourceId: 'P-K', parentSourceId: 'P-R',
      path: bomPath('P-R', 'P-K'), idempotencyKey: 'idk-k', ext_componentSortNo: 5,
    },
    {
      componentCode: 'O', parentComponentCode: 'ZZ-GONE', componentSourceId: 'P-O', parentSourceId: 'P-GONE',
      path: bomPath('P-GONE', 'P-O'), idempotencyKey: 'idk-o', ext_componentSortNo: 2,
    },
    { componentCode: 'R', componentSourceId: 'P-R', path: bomPath('P-R'), idempotencyKey: 'idk-r', ext_componentSortNo: 1 },
  ])
  assert.equal(result.treeIdentity, 'path')
  assert.equal(result.treeDegraded, false)
  assert.equal(result.collapsedRowCount, 0)
  assert.deepEqual(
    result.rows.map((row) => row.idempotencyKey),
    ['idk-r', 'idk-k', 'idk-o', 'idk-oc'],
    'R24a: 孤儿当根、按树位置打印,它的子行紧跟其后 —— 不是掉到末尾被平比较器排成子先于父',
  )
}

const PROJECT_CYCLE = 'PRJ-DEGRADED-CYCLE'

// R24b 降级方案的环。两行无 path、componentSourceId/parentSourceId 互指(A.parent = B, B.parent = A):
// 两行都不是根,也永远不会从任何根 walk 到 ⇒ 只有末尾的 stranded 追加能把它们打印出来。删掉那一句
// (变异 M-J),两行整行消失 —— 这是 orderRowsAsBomTree 三条防线里的第 1 条,此前从无用例。
// 行路径方案下这条不可达(父路径恒比子路径短一段,任何父链都终于单段根或「父不在批内」的根),
// 所以这一批必须是降级的:treeDegraded 为 true 既是断言,也是「这个用例只对降级方案有意义」的证明。
async function moduleDegradedSchemeCycleRowsAreStrandedAtTheEndNotDropped() {
  // 直接喂逻辑行:能看见幂等键。
  const direct = exportInternals.orderRowsAsBomTree([
    {
      componentCode: 'DWG-CY-A', parentComponentCode: 'DWG-CY-B', componentSourceId: 'P-CY-A', parentSourceId: 'P-CY-B',
      idempotencyKey: 'idk-cy-a', ext_componentSortNo: 2,
    },
    { componentCode: 'DWG-CY-R', componentSourceId: 'P-CY-R', idempotencyKey: 'idk-cy-r', ext_componentSortNo: 1 },
    {
      componentCode: 'DWG-CY-B', parentComponentCode: 'DWG-CY-A', componentSourceId: 'P-CY-B', parentSourceId: 'P-CY-A',
      idempotencyKey: 'idk-cy-b', ext_componentSortNo: 3,
    },
  ])
  assert.equal(direct.treeIdentity, 'componentSourceId', 'R24b: 没有一行带 path ⇒ 部件 id 方案')
  assert.equal(direct.treeDegraded, true, 'R24b: 环只在降级方案上可达,这一批必须标成降级')
  assert.equal(direct.treeOrdered, true)
  assert.equal(direct.collapsedRowCount, 0)
  assert.equal(direct.rows.length, 3, 'R24b: 环上的两行不丢 —— stranded 追加是唯一能打印它们的路径')
  assert.deepEqual(
    direct.rows.map((row) => row.idempotencyKey),
    ['idk-cy-r', 'idk-cy-b', 'idk-cy-a'],
    'R24b: 根先打印;环上的两行按 F1b 平比较器(父组件图号 优先:B 的父 DWG-CY-A < A 的父 DWG-CY-B)追加在末尾',
  )
  // 走一遍真实导出:同一形状经 mainRow 落到表里、由 exportStockPreparationPrepLines 读回并投影。
  const cycleRows = [
    mainRow(PROJECT_CYCLE, {
      componentCode: 'DWG-CY-A', componentName: '环A', ext_nameAndSpec: '环A',
      parentComponentCode: 'DWG-CY-B', parentComponentName: '环B',
      ext_parentDrawingNo: 'DWG-CY-B', ext_parentName: '环B',
      componentSourceId: 'P-CY-A', parentSourceId: 'P-CY-B', ext_componentSortNo: 2,
      idempotencyKey: 'idk-cy-a',
    }, 'rec_cy_a'),
    mainRow(PROJECT_CYCLE, {
      componentCode: 'DWG-CY-R', componentName: '环外的根', ext_nameAndSpec: '环外的根',
      parentComponentCode: undefined, parentComponentName: undefined,
      ext_parentDrawingNo: undefined, ext_parentName: undefined,
      componentSourceId: 'P-CY-R', parentSourceId: undefined, ext_componentSortNo: 1,
      idempotencyKey: 'idk-cy-r',
    }, 'rec_cy_r'),
    mainRow(PROJECT_CYCLE, {
      componentCode: 'DWG-CY-B', componentName: '环B', ext_nameAndSpec: '环B',
      parentComponentCode: 'DWG-CY-A', parentComponentName: '环A',
      ext_parentDrawingNo: 'DWG-CY-A', ext_parentName: '环A',
      componentSourceId: 'P-CY-B', parentSourceId: 'P-CY-A', ext_componentSortNo: 3,
      idempotencyKey: 'idk-cy-b',
    }, 'rec_cy_b'),
  ]
  const records = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [SANDBOX_SHEET]: MAIN_OBJECT_ID },
    rowsBySheet: { [SANDBOX_SHEET]: cycleRows },
  })
  const result = await exportStockPreparationPrepLines({
    recordsApi: records, target: targetFor(SANDBOX_SHEET), projectNo: PROJECT_CYCLE, permission: 'admin',
  })
  const codeColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
  assert.deepEqual(
    result.rows.map((row) => row[codeColumn]),
    ['DWG-CY-R', 'DWG-CY-B', 'DWG-CY-A'],
    'R24b: 导出层同样三行全打印,环上的两行在末尾',
  )
  assert.equal(result.activeRowCount, 3)
  assert.equal(result.treeDegraded, true)
  assert.equal(result.collapsedRowCount, 0)
}

const PROJECT_UNBOUND_SPEC = 'PRJ-UNBOUND-SPEC'

// 两条同父、同图号、首段同名、同材质、同用量的标准件,名称及规格 包列为空。`withSpecKey: false`
// 把 规格 的两个键(模板列 componentSpec / 包列 ext_spec)从行上**删掉** —— target 没绑这一列时
// unmapRow 之后行上就是这个样子;`withSpecKey: true` 则键在、值为空串。
function unboundSpecRows({ withSpecKey }) {
  const shared = {
    parentComponentCode: 'TZ-U0', parentComponentName: 'U主体',
    ext_parentDrawingNo: 'TZ-U0', ext_parentName: 'U主体',
    ext_nameAndSpec: undefined, material: 'Q235B', totalQuantity: 2, rawQuantity: 2,
    componentSpec: '', ext_spec: '',
  }
  const rows = [
    mainRow(PROJECT_UNBOUND_SPEC, {
      ...shared, parentComponentCode: undefined, parentComponentName: undefined,
      ext_parentDrawingNo: undefined, ext_parentName: undefined,
      componentCode: 'TZ-U0', componentName: 'U主体',
      componentSourceId: 'P-U0', parentSourceId: undefined, path: bomPath('P-U0'), ext_componentSortNo: 1,
      idempotencyKey: 'idk-u0',
    }, 'rec_u0'),
    mainRow(PROJECT_UNBOUND_SPEC, {
      ...shared, componentCode: 'GB/T5783', componentName: '螺栓',
      componentSourceId: 'P-U1', parentSourceId: 'P-U0', path: bomPath('P-U0', 'P-U1'), ext_componentSortNo: 10,
      idempotencyKey: 'idk-u1',
    }, 'rec_u1'),
    mainRow(PROJECT_UNBOUND_SPEC, {
      ...shared, componentCode: 'GB/T5783', componentName: '螺栓',
      componentSourceId: 'P-U2', parentSourceId: 'P-U0', path: bomPath('P-U0', 'P-U2'), ext_componentSortNo: 20,
      idempotencyKey: 'idk-u2',
    }, 'rec_u2'),
  ]
  if (!withSpecKey) {
    for (const record of rows) {
      delete record.data[physicalFieldId(STAGING, MAIN_OBJECT_ID, 'componentSpec')]
      delete record.data[physicalFieldId(STAGING, MAIN_OBJECT_ID, 'ext_spec')]
    }
  }
  return rows
}

async function moduleUnboundSpecColumnMakesTheDisplayKeyUnprovable() {
  // 单元层:键缺失 ⇒ 不可证 ⇒ displayDedupeKey 为 null;键在、值空 ⇒ 可证(名称无空格那一支)。
  const bare = { parentComponentCode: 'TZ', componentCode: 'GB/T5783', componentName: '螺栓', material: 'Q235B', rawQuantity: 1 }
  assert.deepEqual(exportInternals.nameAndSpecDisplayKey(bare), { text: '螺栓', provable: false }, 'R23e: 规格 列未绑 ⇒ 不可证')
  assert.equal(exportInternals.displayDedupeKey(bare), null, 'R23e: 不可证 ⇒ 不并')
  assert.deepEqual(exportInternals.nameAndSpecDisplayKey({ ...bare, componentSpec: '' }), { text: '螺栓', provable: true }, 'R23e: 模板列在、值为空串 ⇒ 名称就是全串')
  assert.deepEqual(exportInternals.nameAndSpecDisplayKey({ ...bare, ext_spec: '' }), { text: '螺栓', provable: true }, 'R23e: 包列在、值为空串 ⇒ 同上')
  assert.deepEqual(exportInternals.nameAndSpecDisplayKey({ ...bare, componentSpec: 'M8x30' }), { text: '螺栓 M8x30', provable: false }, 'R23e: 规格 有值仍是第三种形状(不可证)')
  assert.deepEqual(exportInternals.nameAndSpecDisplayKey({ ...bare, ext_nameAndSpec: '螺栓 M8x30' }), { text: '螺栓 M8x30', provable: true }, 'R23e: 包列 名称及规格 有值仍可证')

  // 导出层:同样两条标准件,规格 列未绑 ⇒ 两行都打印;规格 列绑了且为空 ⇒ 按老系统并成一行。
  const codeColumn = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
  const run = async (withSpecKey) => {
    const records = makeStrictRecordsApi({
      stagingProjectId: STAGING,
      objectIdBySheetId: { [SANDBOX_SHEET]: MAIN_OBJECT_ID },
      rowsBySheet: { [SANDBOX_SHEET]: unboundSpecRows({ withSpecKey }) },
    })
    return exportStockPreparationPrepLines({
      recordsApi: records, target: targetFor(SANDBOX_SHEET), projectNo: PROJECT_UNBOUND_SPEC, permission: 'admin',
    })
  }
  const unbound = await run(false)
  assert.deepEqual(unbound.rows.map((row) => row[codeColumn]), ['TZ-U0', 'GB/T5783', 'GB/T5783'], 'R23e: 规格 列未绑 ⇒ 首段同名的两个标准件都打印')
  assert.equal(unbound.collapsedRowCount, 0)
  const bound = await run(true)
  assert.deepEqual(bound.rows.map((row) => row[codeColumn]), ['TZ-U0', 'GB/T5783'], 'R23e 正控:规格 列绑了且为空 ⇒ 名称就是全串,同键并成一行')
  assert.equal(bound.collapsedRowCount, 1)
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

  await moduleExportOrderIsTheAgreedHierarchyOrder()
  await moduleExportOrderIsIndependentOfTheScanOrder()
  await moduleExportOrderPrefersComponentSortNoWhereTheColumnExists()
  await moduleExportOrderIsTotalEvenForRowsWithNoIdempotencyKey()
  await moduleExportWithoutAnyParentBindingDegradesToDrawingOrder()

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

  await moduleExportOrderIsTheBomTreeNotAFlatBand()
  await moduleExportWithoutSourceIdentityKeepsTheFlatOrder()
  await moduleLegacyTwentyThreeColumnsAreProjected()
  await moduleSameDrawingDifferentSpecIsNotCollapsed()
  await moduleDeclaredSpecColumnNeverCollapsesTwoDifferentStandardParts()

  await moduleSharedSubassemblyPrintsUnderEveryParentRow()
  await moduleDedupeScopeIsTheParentRowNotTheParentPart()
  moduleBomPathEncoderIsTheExpandersOwn()
  await moduleRowsWithoutAPathDegradeToThePartIdentityAndSaySo()
  moduleOrphanSubtreeIsRootedInPlaceNotStrandedAtTheEnd()
  await moduleDegradedSchemeCycleRowsAreStrandedAtTheEndNotDropped()
  await moduleUnboundSpecColumnMakesTheDisplayKeyUnprovable()

  console.log('stock-preparation-prep-line-export (按项目导出物料 Excel): all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
