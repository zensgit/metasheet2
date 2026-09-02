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
])
const EXPORT_COLUMN_IDS = Object.freeze(EXPORT_COLUMNS.map((column) => column.id))
// Every logical id the projection reads, including the fallback sources (which are never headers).
const EXPORT_SOURCE_FIELD_IDS = Object.freeze([
  ...EXPORT_COLUMN_IDS,
  ...EXPORT_COLUMNS.map((column) => column.fallbackId).filter(Boolean),
])
// Resolved alongside the projected columns for filtering/scoping ONLY — never projected into a cell.
const SCOPE_FIELD_IDS = Object.freeze(['projectNo', 'active'])

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
  const rows = activeRows.map((data) => EXPORT_COLUMNS.map((column) => exportCellValue(columnSourceValue(data, column))))
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
    fieldIdMapHasExplicitBindings,
    isBlankCell,
    normalizeExportTarget,
    queryAllMainRows,
    resolveExportFieldBindings,
    unmapRow,
    READ_PAGE_LIMIT,
    READ_MAX_PAGES,
    SCOPE_FIELD_IDS,
  },
}
