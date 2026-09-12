'use strict'

// 按项目导出物料 Excel — the project-scoped materials export 仓库/采购 take after the approval chain
// completes ("导出涉及的物料信息为 excel 到本地处理"). An audit found no export route and no export
// button anywhere in the stock-prep surface; the only working export was the generic whole-sheet
// Multitable workbench export (no project filter, no material-column projection). This module is the
// READ half of the fix: it projects the ACTIVE plm_stock_preparation_main rows of ONE business
// project onto the agreed column set. The route handler (http-routes.cjs) builds the xlsx buffer and
// streams it; this module never touches xlsx.
//
// THE COLUMN PROJECTION is not invented here. It previously existed ONLY as test/demo data —
// __tests__/stock-preparation-demo-runner.cjs, "THE EXPORT the warehouse/purchasing takes." — and is
// copied verbatim (ids, labels, ORDER) as EXPORT_COLUMNS below. Column order is part of the agreement;
// do not resort it.
//
// STRUCTURALLY READ-ONLY (mirror of stock-preparation-confirm-reads.cjs / -project-reads.cjs): it
// calls ONLY recordsApi.queryRecords — never createRecord / patchRecord / delete — and never reads
// PLM/K3/ERP/any external system/SQL/fetch.
//
// IT READS THE TARGET THE APPLY PATH WROTE — not a table id of its own choosing.
//
// The first cut of this module (#5437) located its sheet by hardcoding the CANONICAL objectId
// `plm_stock_preparation_main` and resolving it through provisioning. That is the wrong table on the
// deployments customers actually run: apply is sandbox-only unless an owner has configured a
// time-boxed production policy, and `assertStockPrepApplySandboxAllowed` (stock-preparation-table-
// actions.cjs) REJECTS the canonical objectId outright on that path — so a default install's rows
// land in the sandbox twin (`plm_stock_preparation_sandbox*`, the same template restamped) and the
// canonical table stays empty forever. Every project therefore answered 404
// PREP_LINE_EXPORT_PROJECT_NOT_FOUND: an export that could only ever work on a deployment nobody has.
//
// The fix is not a second table lookup with a smarter rule — it is to stop having a rule at all. The
// bound table action already carries the ONE authoritative answer to "which sheet do stock-prep rows
// live in", because it is the same `target` the writer writes through (apply-writer.cjs
// normalizeTarget / mapFieldName) and the same one the dry-run's own read uses
// (readExistingStockPreparationRows). This module now takes that `target` and nothing else, so the
// read side cannot diverge from the write side: if apply can write it, the export can read it, and
// if the deployment moves its target the export moves with it.
//
// `projectNo` FILTERS the rows within that sheet — not the confirm-reads family's `projectId`: the
// stock-prep main template carries no `projectId` field (its business-project column is `projectNo`),
// the same field the confirmation-decision ledger scopes on, which is this route's actual neighbour.
//
// FIELD-ID TRANSLATION rides the target's own `fieldIdMap`, exactly as the writer's `mapFieldName`
// does — the same two modes, read off the same object: an EMPTY map means the target is addressed by
// logical id and every key passes through; a map with bindings is the explicit mode, where a key
// absent from the map is a HOLE. Deliberately NOT createTargetScopedRecordsApi's MVP-only
// translation: that registry is keyed by objectId (MVP_TEMPLATE_BY_OBJECT_ID) and a sandbox twin's
// restamped objectId is not in it, which is a second way of saying this module must not be in the
// business of knowing which objectId it is talking to.
//
// UNKNOWN PROJECT vs ZERO ACTIVE ROWS (deliberately distinguished, self-contained — no dependency on
// the separate MVP project ledger, which answers a different question about a different table set):
//   - literally ZERO rows (of ANY active status — never synced) for this projectNo -> NOT FOUND (404)
//   - rows exist but every one is inactive (active === false)                     -> a VALID, EMPTY
//     export: headers only, never a 500. The two must not be conflated: a PLM refresh marking every
//     component of a real project inactive is a legitimate state, not an unknown project.

const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')

// `permission` is the SERVER's own capability toward the managed table, asserted here as an internal
// invariant. It is NOT the caller's tier and cannot be: the route passes a literal 'admin', so this
// check can never refuse a real principal. THE ENFORCEMENT POINT IS THE ROUTE —
// requireAccess(req, STOCK_PREP_OPERATE), the first statement of the handler, before any host IO.
// This check is defence in depth against a future second caller wiring the module in with a weaker
// capability; read it as an assertion, never as the gate.
const REQUIRED_PERMISSION = 'admin'
const READ_PAGE_LIMIT = 500
const READ_MAX_PAGES = 100
// An export is a bulk pull, deliberately more generous than the UI-list caps (2000) elsewhere in this
// family: "this project's materials" is expected to legitimately run into the thousands for a large
// BOM (see stock-preparation-large-bom-jobs.cjs). Still bounded, fail-closed.
const MAX_EXPORT_ROWS = 20000

// The agreed column projection. Its base was verbatim from plugins/plugin-integration-core/__tests__/
// stock-preparation-demo-runner.cjs (search EXPORT_COLUMNS). Column order is part of the agreement;
// do not resort it.
//
// THE SEVEN FIELDS A 备料 PULL MUST CARRY (owner spec) now all appear, in the owner's own order:
// 父组件图号 / 父组件名称 / 图号 / 名称 / 规格 / 材料 / 总数量, followed by the human band the
// warehouse fills in. Two of them are NEW headers — 父组件图号 and 父组件名称 were not projected
// before — and they are ADDED IN FRONT, so every column that already existed keeps its relative
// order.
//
// NATIVE FIRST, PACK COLUMN AS PER-ROW FALLBACK, for the three columns this change made native
// (父组件图号 / 父组件名称 / 规格). Until now those three reached the working sheet ONLY through a
// customer pack — the shipped pack owns `ext_parentDrawingNo`, `ext_parentName` and `ext_spec`
// (lib/customer-packs/factory-a.rehearsal.cjs) — and 规格 was projected here from `ext_spec` alone.
//   WHY A FALLBACK AND NOT A REPLACEMENT. On the day this ships, every row already in a customer's
//   sheet has an empty native column (it did not exist) and, on a pack-carrying deployment, a
//   POPULATED ext_ one — the same PLM datum arriving by the only route there was. Sourcing the
//   native column alone would blank three columns that work today, for every existing row, until a
//   re-pull. Sourcing the pack column alone would leave the export pack-dependent forever, which is
//   the gap this change exists to close.
//   WHY NATIVE WINS WHERE BOTH ARE PRESENT. The native column is written by the apply path itself
//   from the read plan's declared slots; the ext_ column is the same datum reached through a
//   per-deployment field mapping. When they disagree, the one the pull maintains is the current one.
//   The fallback is per ROW, not per deployment, so a half-migrated sheet (old rows pack-only, new
//   rows native) exports one complete column instead of a striped one.
//   WHEN THE FALLBACK RETIRES. It is dead weight the moment a deployment has re-pulled every
//   project and dropped the pack columns; it is not load-bearing for correctness, only for
//   continuity, and it can be deleted by a later change that says so.
// THE FIVE DEPARTMENTAL COMPLETION COLUMNS (#5447 / W2-3), appended AFTER the twelve above —
// nothing above moves. #5447 added five human_preserved columns to the main template
// (stock-preparation-templates.cjs HUMAN_PRESERVED_FIELD_IDS: makeOrBuy, procurementDone,
// procurementReplyDate, warehouseDone, actualArrivalDate) but this projection was not updated, so
// the warehouse/purchasing workbook was missing exactly the completion markers just shipped for
// them.
//
// ORDER CHOSEN: the template's own declaration order (makeOrBuy, then the procurement pair, then
// the warehouse pair) rather than grouping by department first. The template's own comment explains
// why makeOrBuy leads the band: it is "the fork that makes 采购跟进 and 仓库跟进 separable," so
// putting it first in the export mirrors the one place this order is already an agreement, and a
// reader who diffs the template against this file sees the same sequence rather than two
// independently-invented ones.
//
// `type: 'boolean'` marks the two completion flags for exportCellValue: they render as 是/否 text
// (the customer-facing convention for a checkbox column in this workbook) rather than a native
// boolean cell. The two dates carry no `type` and therefore no special formatting — exactly how the
// existing `demandDate` column above behaves today (its stored value passes through unchanged), so a
// pre-existing date column and these two new ones render identically.
const EXPORT_COLUMNS = Object.freeze([
  Object.freeze({ id: 'parentComponentCode', label: '父组件图号', fallbackId: 'ext_parentDrawingNo' }),
  Object.freeze({ id: 'parentComponentName', label: '父组件名称', fallbackId: 'ext_parentName' }),
  Object.freeze({ id: 'componentCode', label: '图号' }),
  Object.freeze({ id: 'componentName', label: '名称' }),
  Object.freeze({ id: 'componentSpec', label: '规格', fallbackId: 'ext_spec' }),
  Object.freeze({ id: 'material', label: '材料' }),
  Object.freeze({ id: 'totalQuantity', label: '总数量' }),
  Object.freeze({ id: 'stockPreparationStatus', label: '备料情况' }),
  Object.freeze({ id: 'demandDate', label: '需求日期' }),
  Object.freeze({ id: 'ext_pickingNode', label: '领料节点' }),
  Object.freeze({ id: 'ext_stockPrepDate', label: '备料日期' }),
  Object.freeze({ id: 'ext_blankLength', label: '毛胚长度' }),
  Object.freeze({ id: 'makeOrBuy', label: '自制/外购' }),
  Object.freeze({ id: 'procurementDone', label: '采购完成', type: 'boolean' }),
  Object.freeze({ id: 'procurementReplyDate', label: '采购回复日期' }),
  Object.freeze({ id: 'warehouseDone', label: '仓库完成', type: 'boolean' }),
  Object.freeze({ id: 'actualArrivalDate', label: '实际到货日期' }),
  // ── F1c: 老系统 23 列里这张表还缺的那些,APPENDED AT THE END ──────────────────────────────
  //
  // 老系统 `exportExcel` 1536-1560 写死 23 个中文表头。上面 17 列里已经有 13 个同义列;剩下的
  // 列补在末尾,一个都不插队 —— 模块头那句「列序是约定,不要重排」对已有列继续有效,客户手上
  // 那张表打开后前 17 列还在原位。
  //
  // 映射来源分两类,并且没有第三类(没有列的不编一个出来):
  //   * 主表模板本来就有的列:生产编号(projectNo,老系统的 productCode)/材料类型/毛胚类型/
  //     备注/提前周期(天)。
  //   * 只在客户包里存在的列(ext_):名称及规格/交接工段/毛胚宽度/厚度/数量/质量。没装包的
  //     部署这些列解析不出绑定 -> 单元格空 + 进 `unresolvedColumns`(既有规则,没有放宽)。
  //
  // 仍然缺的那一列是 **序号**:它是老系统导出时现编的行号(`rowNum-1`),不是任何一列的值。
  // 补在末尾的「序号」会和它的含义打架(它只在第一列才读得通),而第一列不能动 —— 所以它留在
  // PR 的缺列清单里交 owner,而不是在这里发明一列。
  Object.freeze({ id: 'projectNo', label: '生产编号' }),
  Object.freeze({ id: 'ext_nameAndSpec', label: '名称及规格' }),
  Object.freeze({ id: 'materialType', label: '材料类型' }),
  Object.freeze({ id: 'blankType', label: '毛胚类型' }),
  Object.freeze({ id: 'notes', label: '备注' }),
  Object.freeze({ id: 'ext_handoverSection', label: '交接工段' }),
  Object.freeze({ id: 'leadTimeDays', label: '提前周期(天)' }),
  Object.freeze({ id: 'ext_blankWidth', label: '毛胚宽度' }),
  Object.freeze({ id: 'ext_blankThickness', label: '毛胚厚度' }),
  Object.freeze({ id: 'ext_blankQuantity', label: '毛胚数量' }),
  Object.freeze({ id: 'ext_blankMass', label: '毛胚质量' }),
])
const EXPORT_COLUMN_IDS = Object.freeze(EXPORT_COLUMNS.map((column) => column.id))
// Every logical id the projection reads, including the fallback sources (which are never headers).
const EXPORT_SOURCE_FIELD_IDS = Object.freeze([
  ...EXPORT_COLUMN_IDS,
  ...EXPORT_COLUMNS.map((column) => column.fallbackId).filter(Boolean),
])
// Resolved alongside the projected columns for filtering/scoping ONLY — never projected into a cell.
const SCOPE_FIELD_IDS = Object.freeze(['projectNo', 'active'])

// Resolved alongside the projected columns for ORDERING ONLY — never projected into a cell, never
// reported as an unresolved column (they are not columns: an unbound one costs a tiebreak, not a
// blank cell the reader would go looking for). See sortExportRows for what each one does.
//
// `componentSortNo` is deliberately a key for a column that DOES NOT EXIST YET: the frozen main
// template carries no 明细排序号 (the PLM 明细栏 `sort_id` is read by the expander —
// stock-preparation-bom-expansion.cjs `sortLine` — and has nowhere to land), and adding it is an
// owner-gated template change. Keying it now means the day that column ships the workbook follows
// the customer's own 明细栏 sequence with no second edit here; until then every row is missing it
// and the key falls through.
//
// F1c ADDS FOUR MORE ORDER-ONLY IDS, for the same reason and under the same rule (never a column,
// never an `unresolvedColumns` entry): `path` is the ROW's identity in the BOM tree (the node the
// expander wrote, `makePath(pathTokens)` — see orderRowsAsBomTree for why the tree hangs off the
// row path and not off the part id), `componentSourceId` + `parentSourceId` are the DEGRADED
// identity a row without a `path` falls back to, and `ext_componentSortNo` is where 明细排序号
// actually lands — the frozen template still has no 排序号 column, the customer pack has had one
// (当前组件排序号) all along, and F1c is what finally writes it.
const SORT_FIELD_IDS = Object.freeze([
  'componentSortNo',
  'ext_componentSortNo',
  'path',
  'componentSourceId',
  'parentSourceId',
  // 单层用量:不是排序键,是展示层去重键的第五项(见 displayDedupeKey)。和 SORT_FIELD_IDS 里
  // 其它 id 一样,它是「解析出来供比较用」的,从不投影成单元格、也从不报进 unresolvedColumns。
  'rawQuantity',
  'idempotencyKey',
])

// WHICH BINDINGS ARE LOAD-BEARING. Only the two SCOPE fields are: without `projectNo` the export
// cannot scope and would hand one project's workbook the whole table, and without `active` it cannot
// exclude retired rows and would silently ship components a PLM refresh removed. Both are plm_system
// columns, so an explicit target map is REQUIRED to bind them
// (assertTargetFieldMapCompleteness covers exactly the plm_system band + declared extension ids) —
// an unbound one means the config is broken, and a broken scope is a refusal, never a best effort.
//
// Every PROJECTED column is a display column whose presence is a per-deployment fact, so an unbound
// one is absence rather than a server fault:
//   - `ext_`* — whether a tenant's customer pack declares an extension column is a property of that
//     deployment. Before this change ALL FOUR ext_ columns were hard-required, so a deployment with
//     no pack (or a differently-shaped one) got a 500 from its own export rather than a workbook.
//   - `parentComponentCode` / `parentComponentName` / `componentSpec` — canonical, but ADDED BY THIS
//     CHANGE. An install provisioned before it has no such column until the additive repair verb
//     (repairStockPreparationCanonicalTarget) heals it and its action target is rebound; an export
//     must not 500 in the window between the two.
//   - the human band (`stockPreparationStatus` / `demandDate`) — the completeness gate deliberately
//     does NOT require human columns in the map (apply never writes them), so a legal config may
//     leave them unbound. Requiring them here would turn a legal config into a 500.
//
// An unbound projected id yields empty cells and is REPORTED (`unresolvedColumns` — logical field
// ids, which are config identifiers, never values) so a genuinely misprovisioned column is visible
// instead of silently blank.
const REQUIRED_EXPORT_FIELD_IDS = Object.freeze(['projectNo', 'active'])

class StockPreparationPrepLineExportError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationPrepLineExportError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function assertAdminPermission(permission) {
  if (permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationPrepLineExportError(
      403,
      'PREP_LINE_EXPORT_PERMISSION_DENIED',
      'stock-preparation export requires admin permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
}

function ensureReadOnlyRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') {
    throw new StockPreparationPrepLineExportError(
      501,
      'PREP_LINE_EXPORT_RECORDS_API_UNAVAILABLE',
      'stock-preparation export requires multitable.records.queryRecords',
      { requiredMethods: ['queryRecords'] },
    )
  }
  return recordsApi
}

// THE BOUND TARGET, normalized exactly as the writer normalizes it (apply-writer.cjs
// normalizeTarget): a required `sheetId`, and a `fieldIdMap` that is either empty (logical mode) or
// carries explicit logical -> physical bindings. Nothing else is read off it — in particular NOT the
// objectId, which is the whole point: canonical and sandbox twin differ in objectId and not in
// anything this module needs.
function normalizeExportTarget(input) {
  if (!isPlainObject(input)) {
    throw new StockPreparationPrepLineExportError(422, 'PREP_LINE_EXPORT_CONFIG_INVALID', 'target is required', { field: 'target' })
  }
  const fieldIdMap = {}
  if (isPlainObject(input.fieldIdMap)) {
    for (const [logical, physical] of Object.entries(input.fieldIdMap)) {
      const logicalName = optionalString(logical)
      const physicalName = optionalString(physical)
      if (logicalName && physicalName) fieldIdMap[logicalName] = physicalName
    }
  }
  return {
    sheetId: requiredString(input.sheetId, 'target.sheetId'),
    objectId: optionalString(input.objectId) || null,
    fieldIdMap,
  }
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationPrepLineExportError(422, 'PREP_LINE_EXPORT_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function recordData(record) {
  if (isPlainObject(record) && isPlainObject(record.data)) return record.data
  return isPlainObject(record) ? record : {}
}

// buildXlsxBuffer (packages/core-backend/src/multitable/xlsx-service.ts) accepts string | number |
// boolean | null | undefined cells; numbers/booleans are kept as their native type (not stringified)
// so the workbook a factory opens is numeric/sortable where the source column is, e.g. 总数量/毛胚长度.
function exportCellValue(value) {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  return String(value)
}

// A column-aware wrapper around exportCellValue. Only `type: 'boolean'` columns (采购完成 /
// 仓库完成) get special treatment: they render the customer-facing 是/否 text a checkbox column
// uses in this workbook, rather than a native TRUE/FALSE cell. A blank cell (undefined/null — an
// unbound column, or a row that predates #5447 and never got a value) stays blank, exactly like
// every other column; it must never render as 否, which would assert "not done" about a row nobody
// has touched. Any non-boolean stray value falls through to the default formatting rather than
// being coerced, since the field's declared type already guarantees booleans in practice.
function formatCellForColumn(column, value) {
  if (column.type === 'boolean') {
    if (value === undefined || value === null) return null
    if (value === true) return '是'
    if (value === false) return '否'
  }
  return exportCellValue(value)
}

// PER-ROW source selection for a column that declares a `fallbackId` (today: 规格 only). The native
// column wins wherever it carries a value; a row that has none falls back to the pack column. Blank
// means undefined / null / empty-or-whitespace string — a legitimately 0 or `false` cell is a value
// and is never overridden (no such column today, but the rule must not depend on that).
function isBlankCell(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function columnSourceValue(data, column) {
  const primary = data[column.id]
  if (!column.fallbackId || !isBlankCell(primary)) return primary
  return data[column.fallbackId]
}

// DETERMINISTIC ROW ORDER — 反馈2「导出的层级乱了」.
//
// Until this change the workbook came out in whatever order `queryRecords` happened to return, and
// that order is not a business order at all: this module issues the query with NO `orderBy`, the
// records service then falls back to `ORDER BY id ASC`
// (packages/core-backend/src/multitable/query-service.ts), and a record id is
// `rec_${randomUUID()}` (packages/core-backend/src/multitable/records.ts). So the rows were sorted
// by a random UUID — unrelated to the BOM, unrelated to the order the apply path wrote them, and
// not even stable for one sheet across a re-pull that re-creates a row under a new id. "层级乱了"
// was not a lost sort; there was never a sort.
//
// THE ORDER IS IMPOSED HERE, on the read side, rather than by asking the query for it: the
// comparator must see the same per-row pack fallback the projection uses (a pack-only row's
// 父组件图号 lives in `ext_parentDrawingNo`, which no single ORDER BY column can express), and this
// module keeps its single-verb contract with the records API — queryRecords and nothing else.
//
// THE KEY, outermost first:
//   1. 父组件图号 `parentComponentCode` (pack fallback applied) — every child sits under its parent,
//      which is what 层级 means in this workbook. BLANK LAST: a row with no parent is a top-level
//      or orphan row and belongs after the grouped ones, never interleaved between two groups.
//   2. 明细排序号 `componentSortNo` — numeric, and OPTIONAL by design (see SORT_FIELD_IDS: no such
//      column exists in the frozen template today, so today this key never fires). Rows carrying a
//      number come before rows that do not, blank-last like every other key.
//   3. 图号 `componentCode` — the order a reader expects inside one parent, and the one the legacy
//      system's own query used alongside the parent code.
//   4. 唯一键 `idempotencyKey` — TIEBREAK, not a business key. Two rows can legitimately agree on
//      everything above: the same component reached through two BOM paths under the same parent is
//      exactly the duplication 反馈1 is about, and THIS change does not fix that. Without this key
//      those rows would keep the scan order, i.e. the workbook would still be UUID-ordered precisely
//      where the duplicates are.
//      SCOPE OF THIS KEY, stated rather than assumed: `idempotencyKey` is `required: true,
//      key: true` in the main table TEMPLATE, and that is plugin template metadata — the multitable
//      layer does not enforce `required` on writes (packages/core-backend/src/multitable
//      /provisioning.ts never reads it). So it is present and distinct on every row THE APPLY PATH
//      WROTE THROUGH A TARGET THAT BINDS IT, and on those rows alone. A row typed in by hand in the
//      grid, or any row on a target whose fieldIdMap has no `idempotencyKey` binding, carries none —
//      which is why keys 5 and 6 exist.
//   5. 名称 `componentName` — the last key a reader can SEE. It only decides rows that already agree
//      on parent, 明细排序号, 图号 and 唯一键, i.e. in practice hand-added rows; ordering those by
//      name beats ordering them by an opaque id.
//   6. 物理记录 id (ROW_IDENTITY_KEY) — THE key that makes the order total, and the only one that can
//      be: it is unique per row within a sheet by construction (`rec_${randomUUID()}`). With it the
//      output is a function of the ROW SET alone — the same rows scanned in any order produce the
//      same workbook, including the two rows above that a template-metadata `required` does not in
//      fact guarantee apart. Note what it is NOT: it carries no business meaning, so it is the
//      bottom of the key list, never a substitute for one of the five above.
//
// PRECONDITION ON KEY 1 — say it out loud, because a deployment can silently fail it. 父组件图号 is
// only a 层级 on a sheet whose target actually binds `parentComponentCode` (or a pack carrying
// `ext_parentDrawingNo`). An install provisioned before that column shipped binds NEITHER until the
// additive repair verb heals it and its action target is rebound (see REQUIRED_EXPORT_FIELD_IDS
// above): every row then reads blank on key 1, the whole table lands in one blank band, and the
// workbook degrades to a pure 图号 order. That is deterministic and repeatable — this change's
// actual guarantee — but it is NOT hierarchical, and on such a deployment the hierarchy 反馈2 asks
// for arrives only after the repair, not from this module. `parentComponentCode` shows up in
// `unresolvedColumns` exactly so an operator can tell that case from "this project has no parents".
//
// TEXT COMPARISON IS LOCALE-FREE BY CONSTRUCTION. `<` / `>` on strings is UTF-16 code-unit order,
// identical in a zh-CN runtime and an en-US CI one. `localeCompare` / `Intl.Collator` is
// deliberately NOT used: a collator reads the host locale, so the same sheet would order one way on
// the customer's server and another way in CI — a locale trap this repo has already paid for in its
// PG guards, and one that would make an ordering test green while the customer's workbook is not.
// (For the BMP text these columns hold — 图号/名称 — code-unit order and code-point order coincide.)
const PARENT_CODE_ORDER_COLUMN = EXPORT_COLUMNS.find((column) => column.id === 'parentComponentCode')
const COMPONENT_CODE_ORDER_COLUMN = EXPORT_COLUMNS.find((column) => column.id === 'componentCode')
const COMPONENT_NAME_ORDER_COLUMN = EXPORT_COLUMNS.find((column) => column.id === 'componentName')
// 规格 — only ever read by the display dedupe key below (never by the comparator), and read through
// `columnSourceValue` so a pack-only row's `ext_spec` counts exactly like a native one.
const COMPONENT_SPEC_ORDER_COLUMN = EXPORT_COLUMNS.find((column) => column.id === 'componentSpec')

// Where `unmapRow` parks the row's PHYSICAL record id so the comparator can reach it. Deliberately
// not a logical field id and deliberately not projected: no EXPORT_COLUMN reads it, so it can never
// reach a cell, and the double underscore keeps it out of any collision with a mapped column key.
const ROW_IDENTITY_KEY = '__prepLineRecordId'

// Blank (absent / null / whitespace-only) collapses to '' — the same blankness the projection's own
// fallback uses (isBlankCell), so a cell that prints empty also sorts as empty.
function orderText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function compareOrderText(left, right) {
  if (left === right) return 0
  if (left === '') return 1 // blank last
  if (right === '') return -1
  return left < right ? -1 : 1
}

function orderNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function compareOrderNumber(left, right) {
  if (left === right) return 0
  if (left === null) return 1 // no 明细排序号 sorts after every row that has one
  if (right === null) return -1
  return left < right ? -1 : 1
}

/**
 * The export's row order. Pure and non-mutating: returns a new array, and its result depends only on
 * the row CONTENT (including each row's physical record id — see ROW_IDENTITY_KEY), never on the
 * order the rows arrived in.
 */
function sortExportRows(rows) {
  return rows.slice().sort((left, right) => {
    const byParent = compareOrderText(
      orderText(columnSourceValue(left, PARENT_CODE_ORDER_COLUMN)),
      orderText(columnSourceValue(right, PARENT_CODE_ORDER_COLUMN)),
    )
    if (byParent !== 0) return byParent
    return compareSiblingRows(left, right)
  })
}

// 明细排序号, per row. The frozen template has no such column; the customer pack's
// 当前组件排序号 (`ext_componentSortNo`) is where F1c writes it. Native id first for the day a
// template column exists, pack id second — the same native-first/pack-fallback rule the
// projection uses for 父组件图号/父组件名称/规格.
function rowSortNo(row) {
  const native = orderNumber(row && row.componentSortNo)
  if (native !== null) return native
  return orderNumber(row && row.ext_componentSortNo)
}

/**
 * Keys 2..6 of the agreed order — everything below 父组件图号. Split out of `sortExportRows` so the
 * flat comparator and the tree's SIBLING comparator can never drift apart: inside one parent, the
 * two are the same order by construction.
 */
function compareSiblingRows(left, right) {
  const bySortNo = compareOrderNumber(rowSortNo(left), rowSortNo(right))
  if (bySortNo !== 0) return bySortNo
  const byCode = compareOrderText(
    orderText(columnSourceValue(left, COMPONENT_CODE_ORDER_COLUMN)),
    orderText(columnSourceValue(right, COMPONENT_CODE_ORDER_COLUMN)),
  )
  if (byCode !== 0) return byCode
  const byKey = compareOrderText(orderText(left.idempotencyKey), orderText(right.idempotencyKey))
  if (byKey !== 0) return byKey
  const byName = compareOrderText(
    orderText(columnSourceValue(left, COMPONENT_NAME_ORDER_COLUMN)),
    orderText(columnSourceValue(right, COMPONENT_NAME_ORDER_COLUMN)),
  )
  if (byName !== 0) return byName
  return compareOrderText(orderText(left[ROW_IDENTITY_KEY]), orderText(right[ROW_IDENTITY_KEY]))
}

// 老系统 `iterHandle` 686-693 的去重键第三项 `nameAndStandard` 在这条管线上的还原 —— 这是本模块
// 最容易出错的一处,因为 F1c **自己**改了 名称 列的含义:名称 从 F1c 起只装 identityName 的
// **首段**(`createRow` 的 `splitNameAndSpec`,bom-expansion.cjs),而展开层的 `siblingDedupeKey`
// 比的是**未切分**的全串。展示层要么还原出同一把键,要么就别合并 —— 不许在还原不出来的时候
// 拿一把**更粗**的键去合并,那会把两个合法的不同标准件并成一行,并且连被合并那条的整棵子树
// 一起不打印(`collapseSubtree`)。导出少行是本模块最贵的错误。
//
// 三种形状,只有前两种可证:
//   1. 客户包列 `ext_nameAndSpec` 有值:它装的就是未切分的全串,与展开层键逐字同源(两边都
//      来自 PLM identityName)。**可证**。
//   2. 规格 列为空:规格 为空只可能是因为名称里没有空格 —— 声明了 `readPlan.part.specField` 的
//      部署里源行 Spec 为空时会退回派生(bom-expansion createRow),派生出空 ⇔ 无空格 ⇔ 名称就是
//      全串。所以键 = 名称本身,与源串逐字相同。**可证**。
//   3. 规格 有值而包列为空:规格 **可能**是名称的尾巴(派生;`splitNameAndSpec` 的尾段是 verbatim
//      的 slice,拼回去逐字相同),**也可能**是部署自己声明的 规格 列的值 —— dn-pdm-family.preset
//      把 规格 描述成 a part-side dictionary assignment,字典值天生粗:两行 identityName 分别是
//      「螺栓 M8x30」「螺栓 M10x40」、规格 列却同为「碳钢」时,拼出来的键会撞。行上没有任何东西
//      能把这两种来源区分开(名称永远是首段,两种来源都不含空格)。**不可证 ⇒ 返回 null**,
//      `walk` 见 null 就不比较也不登记,这一行照打,它的子树照打。
//
// 代价说清楚:装了包却没在 `extensionFieldIds` 里声明 名称及规格、同时又有 规格 值的部署,展示层
// 兜底去重就此失效(`collapsedRowCount` 为 0)。这是有意的:**展开层**(bom-expansion
// `siblingDedupeKey`)才是去重的权威点,它拿得到未切分的源串;展示层这一层只是给 F1c 之前
// 写进表里的老行兜底。兜不住时宁可多打印一行,也不丢一棵子树。
//
// 单层用量在键里,是为了和展开层 **同一把键**:展开层多带用量,是为了不把「同父同件但用量不
// 一致」这种数据缺陷从 duplicate_expanded_key 的 fail-closed 挂起里偷走。展示层如果少带这一项,
// 就会在打印时把展开层特意留下的那两行又合并掉 —— 触发口径和边界口径不同量。
//
// 形状 2 的前提是「规格 为空」是一个**测得到**的事实:行上得有 规格 这一列(模板列 `componentSpec`
// 或包列 `ext_spec` 至少绑了一个)、而且它的单元格是空的。两个键都**不在行上**(target 没绑这一列,
// unmapRow 之后连键都没有)时,「空」只是「看不见」—— 首段同名的两个标准件会因此并成一行。所以
// 键缺失判不可证;只有键在、值为空,才走「名称无空格」这一支。
function rowCarriesSpecColumn(row) {
  return Object.prototype.hasOwnProperty.call(row, COMPONENT_SPEC_ORDER_COLUMN.id)
    || Object.prototype.hasOwnProperty.call(row, COMPONENT_SPEC_ORDER_COLUMN.fallbackId)
}

function nameAndSpecDisplayKey(row) {
  const packed = orderText(row.ext_nameAndSpec)
  if (packed !== '') return { text: packed, provable: true }
  const name = orderText(columnSourceValue(row, COMPONENT_NAME_ORDER_COLUMN))
  if (!rowCarriesSpecColumn(row)) return { text: name, provable: false }
  const spec = orderText(columnSourceValue(row, COMPONENT_SPEC_ORDER_COLUMN))
  if (spec === '') return { text: name, provable: true }
  return { text: `${name} ${spec}`, provable: false }
}

/**
 * 展示层去重键,或 `null` —— null 的意思是「这一行的 名称及规格 还原不出来,不许拿它跟任何行
 * 比」,不是「键为空」。调用方(`walk`)必须把 null 当作「永不合并」,而不是当作一个可以互相
 * 撞的普通键值。
 */
function displayDedupeKey(row) {
  const nameAndSpec = nameAndSpecDisplayKey(row)
  if (!nameAndSpec.provable) return null
  return JSON.stringify([
    orderText(columnSourceValue(row, PARENT_CODE_ORDER_COLUMN)),
    orderText(columnSourceValue(row, COMPONENT_CODE_ORDER_COLUMN)),
    nameAndSpec.text,
    orderText(row.material),
    orderText(row.rawQuantity),
  ])
}

// ── 树节点的身份 = 行路径,不是部件 id ──────────────────────────────────────────────────────
//
// 老系统 `iterHandle`(StockInfoController.java:683)取子级用的是
// `filter(val -> Objects.equals(val.getParentId(), stockInfo.getId()))` —— 父指针指向
// 父**行**的 id,而一行就是 BOM 树上的一个节点(`iterSave*` 对每个节点各 `addOne` 一行:同一个
// 部件 P 挂在 X 和 Y 之下就是两行 P@X、P@Y,各自有自己的子行)。这条管线上行的身份是**路径**:
// 幂等键含 `pathTokens`,模板必列 `path` 装的就是展开层 `makePath(pathTokens)` 写下的那串
// (bom-expansion.cjs:`JSON.stringify(pathTokens)`,tokens = 从根到本行的 componentSourceId 序列)。
//
// 为什么不能用 `componentSourceId` / `parentSourceId`(部件 id)建父子:共用子装配(老系统所谓
// 「通用组件」—— StockInfoController.java:507 挂在 `curBatchInDb.stream().filter(val ->
// Objects.equals(preStockInfo.getPliObjId(), val.getPliObjId()))` 上的那条注释「这里可能有多个,
// 因为有可能是通用组件(零件)」:同一 pliObjId 多行)会让同一个部件 P 出现两行,
// 两行的子行 C@P@X、C@P@Y 都写着 `parentSourceId = P`。按部件 id 挂,`childrenByParent.get(P)`
// 把两支子行合成一个兄弟集合,走到 P@X 时一次全走完:C@P@Y 与 C@P@X 同键被 `collapseSubtree`
// 整棵吞掉,P@Y 打印成空壳 —— 导出少行;不开去重时也是错的(两支子行都挂在 P@X 下,P@Y 无子)。
// 展开层的兄弟集合是「同一父**行**之下」(`expandChildren(parentRow, …)` 一次调用一套
// `siblingKeys`),展示层必须和它同量,否则「触发口径和边界口径不同量」。
//
// 编码器和展开层同一个:tokens 解析出来之后**重新** `JSON.stringify`,父 = 去掉最后一段 tokens 后
// 再编码。这样节点身份与父身份都是规范串,不依赖存进表里那一串的空白/转义细节。
// 这里不 require bom-expansion.cjs(本模块只依赖 common.cjs,见模块头「结构上只读」),
// 而是由用例把两边的编码器钉在一起(prep-line-export.test.cjs:encodeBomPath === makePath)。
function encodeBomPath(tokens) {
  return JSON.stringify(tokens)
}

// 行路径 -> tokens;不是「非空 JSON 数组」的一律 null(没绑 `path` 列的老 target、手工行、脏值)。
function bomPathTokensOf(row) {
  const raw = row && row.path
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (_err) {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  return parsed
}

// 主方案:行路径。根 = tokens 只有一段(父为 null),或父路径不在批内(由调用方判定)。
function pathIdentityOf(row) {
  const tokens = bomPathTokensOf(row)
  if (tokens === null) return null
  return {
    self: encodeBomPath(tokens),
    parent: tokens.length > 1 ? encodeBomPath(tokens.slice(0, -1)) : null,
  }
}

// 降级方案:部件 id。只在整批**没有一行**带可解析 `path` 时才用(见 orderRowsAsBomTree),
// 它带着上面说的共用子装配缺陷,所以返回值把它标成 `treeDegraded: true`。
// 自指(parentSourceId === componentSourceId)当根,和改前一样。
function componentIdentityOf(row) {
  const self = orderText(row && row.componentSourceId)
  if (self === '') return null
  const parent = orderText(row && row.parentSourceId)
  return { self, parent: parent === '' || parent === self ? null : parent }
}

// 三个 values-free 的方案标记:行路径 / 部件 id(降级) / 认不出身份(平序)。
const TREE_IDENTITY_PATH = 'path'
const TREE_IDENTITY_COMPONENT = 'componentSourceId'

/**
 * 深度优先的 BOM 树序 —— 老系统 `iterHandle` 669-700 / `exportExcel` 1526-1530 的形状。
 *
 * 节点身份 = 行路径(`path`,见上面那段)。根 = 路径只有一段、或父路径不在这批行里(孤儿行:
 * 它的父行被标无效、或这一批就是被筛过的)。孤儿当根而不是丢掉 —— 导出从不少行,这是这个函数
 * 最要紧的一条性质。「父路径不在批内 ⇒ 当根」这一子句由 R17(孤儿带子行)与 R24a 钉住:孤儿的
 * 子树按树位置打印、父在子前;把这一子句拿掉,孤儿及其子行会掉进末尾的 stranded 追加,按平比较器
 * 排成子先于父(行数不少,但树序错了)。
 * 兄弟按 `compareSiblingRows`(排序号 -> 图号 -> 幂等键 -> 名称 -> 记录 id),深度优先,同一父**行**
 * 之下按老系统那把键去重(首条胜出,被去重的那条连它的子树一起不打印,和老系统一样),但**只在
 * 这把键还原得出来的时候**去重 —— 还原不出来就一行不并(displayDedupeKey 返回 null)。
 * 去重的作用域是**一次 walk = 一个父行的子集合**,与展开层 `expandChildren` 的 `siblingKeys`
 * 同量;不跨父行合并 —— 共用子装配在两个父行下各出现一次,两次都打印。
 *
 * 身份方案按整批选,不逐行混用(两套身份空间混在一棵树里父子对不上):
 *   * 批内任一行带可解析 `path`  ⇒ 行路径方案(`treeIdentity: 'path'`)。没有 `path` 的那几行
 *     (手工行)认不出父,当根打印 —— 和它们在改前的待遇一样,一行不少。
 *   * 一行 `path` 都没有,但有 `componentSourceId` ⇒ 退回部件 id 方案(改前的形状),返回值标
 *     `treeDegraded: true` / `treeIdentity: 'componentSourceId'`:老 target 没绑 `path` 列时拿到的
 *     还是树,但共用子装配会少行,调用方看得见这是降级。
 *   * 两样都没有 ⇒ F1b 的平比较器(`treeOrdered: false`)。
 *
 * 三条防线,各自有「拿掉就红」的用例(R24b / R20 / R18;R24b 在 fix r4 实证,R18 的红来自 fix r2 的 M5 变异,R20 见 r2 变异表):
 *   1. 环 / 不可达:`visited` 保证每行最多打印一次;走完之后没被访问到的行(stranded)按 F1b 的
 *      平比较器追加在末尾。构不成树的数据会得到一个难看但完整的工作簿,而不是一个少了几行的
 *      工作簿。**行路径方案下这条不可达**:父路径恒比子路径短一段,任何父链都终于单段根或
 *      「父不在批内」的根,不会有两行互为父子;只有降级(部件 id)方案的环(A.parentSourceId = B
 *      且 B.parentSourceId = A)会让两行同时非根、永不被 walk 到。用例 R24b 钉的就是这一支:
 *      拿掉 stranded 追加,环上的两行整行消失。
 *   2. 没有身份列的部署(老 target 既没绑 `path` 也没绑 `componentSourceId`):整批一行也认不出
 *      身份时直接退回 F1b 的平比较器,而不是把每一行都当根 —— 那会连「按父组件分组」都丢掉,
 *      比改之前更差(R20)。
 *   3. 去重计数如实上报(`collapsedRowCount`),**模块返回值里**能看见「这张表按老系统合并掉了
 *      几行」—— 注意它到此为止:导出路由与审计记录今天都不读它(见函数尾部那段 REACH 说明)(R18)。
 *
 * 与老系统的两处已知偏离(写进 PR 正文,不在这里悄悄改):根这一层也过同一把去重键(老系统只对
 * childList 去重,顶层 collect 不去重);幸存者是排序后的首条(老系统按 DB 顺序首条胜出)。
 *
 * PURE:不改入参,结果只取决于行内容(含记录 id),与扫描顺序无关。
 */
function orderRowsAsBomTree(rows) {
  let identityOf = null
  let treeIdentity = null
  if (rows.some((row) => pathIdentityOf(row) !== null)) {
    identityOf = pathIdentityOf
    treeIdentity = TREE_IDENTITY_PATH
  } else if (rows.some((row) => componentIdentityOf(row) !== null)) {
    identityOf = componentIdentityOf
    treeIdentity = TREE_IDENTITY_COMPONENT
  }
  if (identityOf === null) {
    return { rows: sortExportRows(rows), collapsedRowCount: 0, treeOrdered: false, treeIdentity: null, treeDegraded: false }
  }
  const identities = new Map()
  const knownIdentities = new Set()
  for (const row of rows) {
    const identity = identityOf(row)
    identities.set(row, identity)
    if (identity !== null) knownIdentities.add(identity.self)
  }
  const childrenByParent = new Map()
  const roots = []
  for (const row of rows) {
    const identity = identities.get(row)
    const parentIdentity = identity === null ? null : identity.parent
    if (parentIdentity === null || !knownIdentities.has(parentIdentity)) {
      roots.push(row)
      continue
    }
    if (!childrenByParent.has(parentIdentity)) childrenByParent.set(parentIdentity, [])
    childrenByParent.get(parentIdentity).push(row)
  }
  const childrenOf = (row) => {
    const identity = identities.get(row)
    return identity === null ? [] : (childrenByParent.get(identity.self) || [])
  }

  const ordered = []
  const visited = new Set()
  let collapsedRowCount = 0
  // A collapsed twin takes its WHOLE subtree with it (老系统 never visits the dropped node, so its
  // children never reach the workbook either) — marked visited rather than left behind, or the
  // stranded-row sweep below would print exactly the duplicate band this key exists to remove.
  const collapseSubtree = (row) => {
    if (visited.has(row)) return
    visited.add(row)
    collapsedRowCount += 1
    for (const child of childrenOf(row)) collapseSubtree(child)
  }
  // ONE `seenKeys` PER CALL, i.e. per parent ROW's child set (and one for the root band). It must
  // not be hoisted out of `walk`: a set shared across parents would collapse the second occurrence
  // of a shared sub-assembly's child under its OTHER parent — the exact row this identity scheme
  // exists to keep.
  const walk = (siblings) => {
    const seenKeys = new Set()
    for (const row of siblings.slice().sort(compareSiblingRows)) {
      if (visited.has(row)) continue
      // null = 这一行的 名称及规格 还原不出来(见 displayDedupeKey)。既不比较也不登记 ⇒ 它
      // 既不会被别人合并掉,也不会把别人合并掉。把 null 当普通键值丢进 Set 的写法会让所有
      // 不可证的行互相撞成一行 —— 正好是这把键要挡的那个错,方向还反了。
      const key = displayDedupeKey(row)
      if (key !== null) {
        if (seenKeys.has(key)) {
          collapseSubtree(row)
          continue
        }
        seenKeys.add(key)
      }
      visited.add(row)
      ordered.push(row)
      walk(childrenOf(row))
    }
  }
  walk(roots)
  const stranded = rows.filter((row) => !visited.has(row))
  if (stranded.length > 0) ordered.push(...sortExportRows(stranded))
  return {
    rows: ordered,
    collapsedRowCount,
    treeOrdered: true,
    treeIdentity,
    treeDegraded: treeIdentity === TREE_IDENTITY_COMPONENT,
  }
}

// "Does this target bind logical ids to physical ids AT ALL?" — the writer's own predicate
// (apply-writer.cjs fieldIdMapHasExplicitBindings), restated on the read side so the two modes are
// decided by the same question. An EMPTY map is a legitimate mode: the target is addressed by
// logical id and every key passes through untranslated, so nothing can be "unbound". A map with at
// least one binding is the explicit mode, where an id absent from the map is a HOLE.
function fieldIdMapHasExplicitBindings(fieldIdMap) {
  return Object.keys(fieldIdMap).length > 0
}

function resolveExportFieldBindings(target) {
  // DE-DUPLICATED since F1c: 生产编号 made `projectNo` both a PROJECTED column and a SCOPE field,
  // and a repeated id would be reported twice in `missingFields` / `unresolvedColumns` — the same
  // hole named twice reads as two holes.
  const fieldIds = Array.from(new Set([...EXPORT_SOURCE_FIELD_IDS, ...SCOPE_FIELD_IDS]))
  const explicit = fieldIdMapHasExplicitBindings(target.fieldIdMap)
  const map = {}
  const missing = []
  const unbound = []
  for (const fieldId of fieldIds) {
    const physical = target.fieldIdMap[fieldId]
    if (physical) map[fieldId] = physical
    else if (!explicit) map[fieldId] = fieldId // logical mode: the raw id addresses the column
    else if (REQUIRED_EXPORT_FIELD_IDS.includes(fieldId)) missing.push(fieldId)
    else unbound.push(fieldId)
  }
  // ORDER-ONLY ids, resolved so `unmapRow` hands the comparator a logical key. Kept OUT of the
  // loop above on purpose: an explicit map that does not bind one of these is not a hole to report —
  // `componentSortNo` has no column to bind on any deployment today, and putting it in
  // `unresolvedColumns` would tell the operator a COLUMN of their workbook came out blank, which is
  // false. An unbound order key simply does not participate (sortExportRows treats it as absent).
  for (const fieldId of SORT_FIELD_IDS) {
    const physical = target.fieldIdMap[fieldId]
    if (physical) map[fieldId] = physical
    else if (!explicit) map[fieldId] = fieldId
  }
  if (missing.length > 0) {
    throw new StockPreparationPrepLineExportError(
      500,
      'PREP_LINE_EXPORT_FIELD_IDS_UNRESOLVED',
      'stock-preparation export target does not bind the fields the export scopes on',
      { objectId: target.objectId, missingFields: missing },
    )
  }
  return { map, unbound }
}

function unmapRow(row, fieldIdMap) {
  const data = recordData(row)
  const inverse = {}
  for (const [logical, physical] of Object.entries(fieldIdMap)) inverse[physical] = logical
  const out = {}
  for (const [key, value] of Object.entries(data)) out[inverse[key] || key] = value
  // The record's own id, carried alongside the cells for ONE purpose: the export's last order key
  // (sortExportRows). `queryRecords` returns it as a top-level `id` (LoadedMultitableRecord), i.e.
  // outside `data`, so it is not a cell and unmapping cannot have translated it. Only taken when the
  // record is the `{ id, data }` shape — when `recordData` fell back to treating the record itself
  // as the data bag there is no record id to speak of, and the key simply stays absent.
  if (data !== row && typeof row?.id === 'string' && row.id !== '') out[ROW_IDENTITY_KEY] = row.id
  return out
}

async function queryAllMainRows(recordsApi, sheetId, fieldIdMap, projectNo) {
  const physicalProjectNoKey = fieldIdMap.projectNo
  const rows = []
  for (let page = 0; page < READ_MAX_PAGES; page += 1) {
    const pageRows = await recordsApi.queryRecords({
      sheetId,
      filters: { [physicalProjectNoKey]: projectNo },
      limit: READ_PAGE_LIMIT,
      offset: page * READ_PAGE_LIMIT,
    })
    if (!Array.isArray(pageRows)) {
      throw new StockPreparationPrepLineExportError(500, 'PREP_LINE_EXPORT_RECORDS_API_INVALID', 'queryRecords must return an array', { sheetId })
    }
    rows.push(...pageRows.map((row) => unmapRow(row, fieldIdMap)))
    if (pageRows.length < READ_PAGE_LIMIT) return rows
  }
  throw new StockPreparationPrepLineExportError(422, 'PREP_LINE_EXPORT_RESULT_TOO_LARGE', 'stock-preparation export exceeded the page bound', { maxPages: READ_MAX_PAGES })
}

/**
 * Read the ACTIVE stock-preparation rows for one business project out of the table the apply path
 * writes, projected to the agreed EXPORT_COLUMNS (`{ headers, rows }`, both ready for
 * buildXlsxBuffer).
 *
 * `target` is the bound table action's own target (`{ sheetId, fieldIdMap }` — the same object
 * apply-writer writes through), so canonical and sandbox deployments are the same code path with a
 * different binding, and neither is named here.
 *
 * `permission` is NOT the caller's HTTP tier and cannot be — the route passes a literal 'admin'.
 * The real gate is requireAccess(req, STOCK_PREP_OPERATE), the first statement of the route handler,
 * before any host IO. See REQUIRED_PERMISSION above.
 */
async function exportStockPreparationPrepLines({ recordsApi, target, projectNo, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const boundTarget = normalizeExportTarget(target)
  const scopedProjectNo = requiredString(projectNo, 'projectNo')

  const resolution = resolveExportFieldBindings(boundTarget)
  const allRows = await queryAllMainRows(api, boundTarget.sheetId, resolution.map, scopedProjectNo)
  if (allRows.length === 0) {
    throw new StockPreparationPrepLineExportError(
      404,
      'PREP_LINE_EXPORT_PROJECT_NOT_FOUND',
      'no stock-preparation rows exist for this project',
      { projectNo: scopedProjectNo },
    )
  }
  const activeRows = allRows.filter((data) => data.active !== false)
  if (activeRows.length > MAX_EXPORT_ROWS) {
    throw new StockPreparationPrepLineExportError(422, 'PREP_LINE_EXPORT_ROWS_TOO_LARGE', 'stock-preparation export exceeded the row bound', { maxRows: MAX_EXPORT_ROWS })
  }
  const headers = EXPORT_COLUMNS.map((column) => column.label)
  // Deterministic hierarchy order BEFORE the projection — since F1c the DEPTH-FIRST BOM TREE
  // (orderRowsAsBomTree), 老系统 iterHandle 的形状,而不再只是「按父组件图号分带」。身份列认不出
  // 来的老部署自动退回 F1b 的平比较器,所以没有任何一种部署会比改之前更乱。
  const ordering = orderRowsAsBomTree(activeRows)
  const rows = ordering.rows.map((data) => EXPORT_COLUMNS.map((column) => formatCellForColumn(column, columnSourceValue(data, column))))
  return {
    projectNo: scopedProjectNo,
    totalRowCount: allRows.length,
    activeRowCount: activeRows.length,
    headers,
    rows,
    // Values-free ordering facts. `collapsedRowCount` is the ONE number that explains a workbook
    // with fewer lines than the sheet has rows (同父同键的重复行按老系统合并),so it travels with
    // the result instead of being a silent drop; `treeOrdered: false` says this deployment's rows
    // carry neither a `path` nor a 部件源ID binding and got the flat order; `treeIdentity` names
    // which identity scheme built the tree ('path' — the row path, the correct one — or
    // 'componentSourceId', the DEGRADED part-id scheme a batch with no `path` falls back to), and
    // `treeDegraded` is that second case spelled out as a boolean: the workbook is a tree, but a
    // shared sub-assembly's second occurrence prints without its children (see orderRowsAsBomTree).
    //
    // REACH, stated so nobody reads more into it than is true: today these are MODULE RETURN
    // VALUES ONLY. The HTTP export route (`http-routes.cjs`, frozen in this change) writes its
    // audit detail from `totalRowCount` / `activeRowCount` / `headers.length` and never reads
    // any of these keys — so an operator whose workbook came out short cannot yet see this number
    // anywhere. Wiring it into the audit detail is the next hand's job; until then "有据可查"
    // applies to the module, not to the product.
    collapsedRowCount: ordering.collapsedRowCount,
    treeOrdered: ordering.treeOrdered,
    treeIdentity: ordering.treeIdentity,
    treeDegraded: ordering.treeDegraded,
    // Values-free: logical field ids the bound target does not bind, so an export that came out
    // blank in a column can be told apart from a deployment that never had that column.
    unresolvedColumns: resolution.unbound.slice(),
  }
}

/**
 * Does this business project have ANY stock-preparation row in the bound target?
 *
 * The cheap half of `exportStockPreparationPrepLines`' own unknown-project rule, split out so a
 * route that is not exporting anything can still ask the question before it writes. 通知下一步 needs
 * exactly this: an advance names a `projectNo` that reaches an append-only audit row, a durable
 * cursor row and a DingTalk body, and "a project number nobody has ever heard of" must be a 404
 * BEFORE any of those, not a handoff chain quietly started for a typo.
 *
 * READ-ONLY and single-page by construction: `limit: 1` because existence is a yes/no and paging
 * through a real project's material list to answer it would be a waste at best and a timeout at
 * worst. Same `target` + `fieldIdMap` discipline as the export — the read side cannot pick a
 * different sheet from the write side.
 */
async function stockPreparationProjectHasMainRows({ recordsApi, target, projectNo, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const boundTarget = normalizeExportTarget(target)
  const scopedProjectNo = requiredString(projectNo, 'projectNo')
  const resolution = resolveExportFieldBindings(boundTarget)
  const rows = await api.queryRecords({
    sheetId: boundTarget.sheetId,
    filters: { [resolution.map.projectNo]: scopedProjectNo },
    limit: 1,
    offset: 0,
  })
  if (!Array.isArray(rows)) {
    throw new StockPreparationPrepLineExportError(500, 'PREP_LINE_EXPORT_RECORDS_API_INVALID', 'queryRecords must return an array', { sheetId: boundTarget.sheetId })
  }
  return rows.length > 0
}

module.exports = {
  EXPORT_COLUMNS,
  EXPORT_COLUMN_IDS,
  EXPORT_SOURCE_FIELD_IDS,
  REQUIRED_EXPORT_FIELD_IDS,
  MAX_EXPORT_ROWS,
  REQUIRED_PERMISSION,
  StockPreparationPrepLineExportError,
  exportStockPreparationPrepLines,
  stockPreparationProjectHasMainRows,
  __internals: {
    assertAdminPermission,
    columnSourceValue,
    ensureReadOnlyRecordsApi,
    exportCellValue,
    formatCellForColumn,
    fieldIdMapHasExplicitBindings,
    isBlankCell,
    normalizeExportTarget,
    queryAllMainRows,
    resolveExportFieldBindings,
    sortExportRows,
    compareSiblingRows,
    displayDedupeKey,
    nameAndSpecDisplayKey,
    rowCarriesSpecColumn,
    orderRowsAsBomTree,
    encodeBomPath,
    bomPathTokensOf,
    pathIdentityOf,
    componentIdentityOf,
    rowSortNo,
    unmapRow,
    READ_PAGE_LIMIT,
    READ_MAX_PAGES,
    ROW_IDENTITY_KEY,
    SCOPE_FIELD_IDS,
    SORT_FIELD_IDS,
  },
}
