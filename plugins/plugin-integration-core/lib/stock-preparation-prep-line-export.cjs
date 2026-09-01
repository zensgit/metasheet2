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
// TWO PROJECT IDENTIFIERS, same split the rest of this family uses (see stock-preparation-snapshot-
// reads.cjs header): `targetProjectId` LOCATES the provisioned plm_stock_preparation_main sheet (the
// tenant's ONE staging project — resolveIntegrationStagingProjectId); `projectNo` FILTERS the rows
// within it. `projectNo`, not the confirm-reads family's `projectId`: plm_stock_preparation_main
// carries no `projectId` field (stock-preparation-templates.cjs — its own business-project column is
// `projectNo`), the same field the confirmation-decision ledger scopes on
// (stock-preparation-confirmation-decisions.cjs), which is this route's actual neighbour.
//
// plm_stock_preparation_main is NOT one of the frozen 9-table MVP object set (nor the confirmation-
// decision ledger), so it cannot ride createTargetScopedRecordsApi's MVP-only field-id translation
// (stock-preparation-table-actions.cjs MVP_TEMPLATE_BY_OBJECT_ID) — this module resolves the small,
// EXPLICIT field-id set it needs (the ten export columns + projectNo + active) directly via
// provisioning.resolveFieldIds, mirroring how stock-preparation-apply-writer's own caller
// (readExistingStockPreparationRows in stock-preparation-table-actions.cjs) reads the same table.
//
// UNKNOWN PROJECT vs ZERO ACTIVE ROWS (deliberately distinguished, self-contained — no dependency on
// the separate MVP project ledger, which answers a different question about a different table set):
//   - literally ZERO rows (of ANY active status — never synced) for this projectNo -> NOT FOUND (404)
//   - rows exist but every one is inactive (active === false)                     -> a VALID, EMPTY
//     export: headers only, never a 500. The two must not be conflated: a PLM refresh marking every
//     component of a real project inactive is a legitimate state, not an unknown project.

const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require('./stock-preparation-templates.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')

const MAIN_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const REQUIRED_PERMISSION = 'admin'
const READ_PAGE_LIMIT = 500
const READ_MAX_PAGES = 100
// An export is a bulk pull, deliberately more generous than the UI-list caps (2000) elsewhere in this
// family: "this project's materials" is expected to legitimately run into the thousands for a large
// BOM (see stock-preparation-large-bom-jobs.cjs). Still bounded, fail-closed.
const MAX_EXPORT_ROWS = 20000

// The agreed column projection — verbatim source: plugins/plugin-integration-core/__tests__/
// stock-preparation-demo-runner.cjs (search EXPORT_COLUMNS). Ten columns: six frozen canonical fields
// (stock-preparation-templates.cjs) and four factory-a pack extension fields (lib/customer-packs/
// factory-a.rehearsal.cjs) that the demo proved are the ones a real deployment's pack carries too.
const EXPORT_COLUMNS = Object.freeze([
  Object.freeze({ id: 'componentCode', label: '图号' }),
  Object.freeze({ id: 'componentName', label: '名称' }),
  Object.freeze({ id: 'ext_spec', label: '规格' }),
  Object.freeze({ id: 'material', label: '材料' }),
  Object.freeze({ id: 'totalQuantity', label: '总数量' }),
  Object.freeze({ id: 'stockPreparationStatus', label: '备料情况' }),
  Object.freeze({ id: 'demandDate', label: '需求日期' }),
  Object.freeze({ id: 'ext_pickingNode', label: '领料节点' }),
  Object.freeze({ id: 'ext_stockPrepDate', label: '备料日期' }),
  Object.freeze({ id: 'ext_blankLength', label: '毛胚长度' }),
])
const EXPORT_COLUMN_IDS = Object.freeze(EXPORT_COLUMNS.map((column) => column.id))
// Resolved alongside the projected columns for filtering/scoping ONLY — never projected into a cell.
const SCOPE_FIELD_IDS = Object.freeze(['projectNo', 'active'])

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

function ensureProvisioningApi(provisioning) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function' || typeof provisioning.resolveFieldIds !== 'function') {
    throw new StockPreparationPrepLineExportError(
      501,
      'PREP_LINE_EXPORT_PROVISIONING_API_UNAVAILABLE',
      'stock-preparation export requires multitable.provisioning findObjectSheet/resolveFieldIds',
      { requiredMethods: ['findObjectSheet', 'resolveFieldIds'] },
    )
  }
  return provisioning
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

async function resolveMainSheet(provisioning, targetProjectId) {
  const sheet = await provisioning.findObjectSheet({ projectId: targetProjectId, objectId: MAIN_OBJECT_ID })
  const sheetId = optionalString(sheet && sheet.id)
  return sheetId ? { id: sheetId } : null
}

async function resolveExportFieldIdMap(provisioning, targetProjectId) {
  const fieldIds = [...EXPORT_COLUMN_IDS, ...SCOPE_FIELD_IDS]
  const resolved = await provisioning.resolveFieldIds({ projectId: targetProjectId, objectId: MAIN_OBJECT_ID, fieldIds })
  const map = {}
  const missing = []
  for (const fieldId of fieldIds) {
    const physical = optionalString(isPlainObject(resolved) ? resolved[fieldId] : null)
    if (physical) map[fieldId] = physical
    else missing.push(fieldId)
  }
  if (missing.length > 0) {
    throw new StockPreparationPrepLineExportError(
      500,
      'PREP_LINE_EXPORT_FIELD_IDS_UNRESOLVED',
      'stock-preparation export could not resolve every declared field id',
      { objectId: MAIN_OBJECT_ID, missingFields: missing },
    )
  }
  return map
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
 * Read the ACTIVE plm_stock_preparation_main rows for one business project, projected to the agreed
 * EXPORT_COLUMNS (`{ headers, rows }`, both ready for buildXlsxBuffer). `permission` mirrors the rest
 * of this module family: it is the SERVER's own capability toward the managed table (checked here as
 * an internal invariant), not the caller's HTTP-level tier — the route gates the real caller with
 * requireAccess(req, STOCK_PREP_OPERATE) before ever reaching this function.
 */
async function exportStockPreparationPrepLines({ recordsApi, provisioning, targetProjectId, projectNo, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  const scopedProjectNo = requiredString(projectNo, 'projectNo')

  const sheet = await resolveMainSheet(prov, stagingProjectId)
  const allRows = sheet
    ? await queryAllMainRows(api, sheet.id, await resolveExportFieldIdMap(prov, stagingProjectId), scopedProjectNo)
    : []
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
  const rows = activeRows.map((data) => EXPORT_COLUMNS.map((column) => exportCellValue(data[column.id])))
  return {
    projectNo: scopedProjectNo,
    totalRowCount: allRows.length,
    activeRowCount: activeRows.length,
    headers,
    rows,
  }
}

module.exports = {
  EXPORT_COLUMNS,
  EXPORT_COLUMN_IDS,
  MAIN_OBJECT_ID,
  MAX_EXPORT_ROWS,
  REQUIRED_PERMISSION,
  StockPreparationPrepLineExportError,
  exportStockPreparationPrepLines,
  __internals: {
    assertAdminPermission,
    ensureReadOnlyRecordsApi,
    ensureProvisioningApi,
    exportCellValue,
    queryAllMainRows,
    resolveExportFieldIdMap,
    resolveMainSheet,
    unmapRow,
    READ_PAGE_LIMIT,
    READ_MAX_PAGES,
    SCOPE_FIELD_IDS,
  },
}
