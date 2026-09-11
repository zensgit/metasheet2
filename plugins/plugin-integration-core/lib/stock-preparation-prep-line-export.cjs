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
const SORT_FIELD_IDS = Object.freeze(['componentSortNo', 'idempotencyKey'])

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
    const bySortNo = compareOrderNumber(orderNumber(left.componentSortNo), orderNumber(right.componentSortNo))
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
  })
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
  const fieldIds = [...EXPORT_SOURCE_FIELD_IDS, ...SCOPE_FIELD_IDS]
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
  // Deterministic hierarchy order BEFORE the projection — see sortExportRows. Without it the row
  // order is the records service's `ORDER BY id ASC` over random UUIDs.
  const orderedRows = sortExportRows(activeRows)
  const rows = orderedRows.map((data) => EXPORT_COLUMNS.map((column) => formatCellForColumn(column, columnSourceValue(data, column))))
  return {
    projectNo: scopedProjectNo,
    totalRowCount: allRows.length,
    activeRowCount: activeRows.length,
    headers,
    rows,
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
    unmapRow,
    READ_PAGE_LIMIT,
    READ_MAX_PAGES,
    ROW_IDENTITY_KEY,
    SCOPE_FIELD_IDS,
    SORT_FIELD_IDS,
  },
}
