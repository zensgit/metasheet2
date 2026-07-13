'use strict'

// #4163 audit gap T1 — READONLY, values-free PROJECT list (backs FE view 1, the project workspace /
// selector: apps/web/src/services/integration/stockPreparation/projectWorkspace.ts +
// StockPreparationProjectWorkspaceView.vue). Before this module GET /api/integration/stock-preparation/
// projects had no server route, so the FE project selector was a dead link and the in-UI deep chain
// (view1 -> view2..6) had no entry point of its own (only a manual `?projectId=` deep link worked).
//
// Structurally READ-ONLY (mirror of stock-preparation-snapshot-reads.cjs / -confirm-reads.cjs):
//   - it calls ONLY recordsApi.queryRecords — never createRecord / patchRecord / delete;
//   - it never reads PLM and never touches K3 / ERP / any external system / SQL / fetch / HTTP;
//   - every read target objectId is asserted to be a member of the FROZEN MVP object-id set.
//
// VALUES-FREE HARD BOUNDARY (load-bearing, OD-W3-1 gated — NOT opened by this slice): the project
// template's `sourceProjectNo` and `projectName` are human-readable business values (a value-bearing
// operator read), so they NEVER cross this route — only the `projectId` handle (a navigation key, the
// same class of "handle" as snapshotBatchId elsewhere in this module family), a CLOSED projectStatus
// enum (an unrecognized stored value folds to 'unknown' — the junk string itself never crosses), the
// `lastSyncRunId` handle, and per-project COUNTS/booleans computed over the other MVP tables. The
// response shape is exactly the FE's StockPreparationWorkspaceOverview / StockPreparationProjectSummary
// contract, which was ALREADY values-free by construction — this module fills it in, it does not widen
// it. (The forbidden tokens named above appear ONLY here, in prose, to document the boundary — never as
// code.)
//
// permission is 'read' (not 'admin' like the rest of this admin-gated MVP module): the project
// selector is the entry point any integration:read/write/admin caller needs to light up views 2-6, so
// the route gate is deliberately broader here (see the HTTP route's requireAccess(req, 'read')).

const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
} = require('./stock-preparation-templates.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')
const { createTargetScopedRecordsApi } = require('./stock-preparation-table-actions.cjs')

const REQUIRED_PERMISSION = 'read'
const READ_PAGE_LIMIT = 500
const READ_MAX_PAGES = 50
const MAX_LIST_ROWS = 2000

// The project_status vocabulary this route echoes: the FE's declared union (StockPreparationProjectStatus
// = 'active' | 'paused' | 'closed' | 'archived') plus 'completed' (the value the option-sync smoke fixture
// declares for the field's own select-option vocabulary). Any OTHER stored value folds to 'unknown'.
const PROJECT_STATUS_VALUES = Object.freeze(['active', 'paused', 'closed', 'archived', 'completed'])
// Stock-preparation line prepStatus vocabulary is CURRENTLY {draft, held} only (stock-preparation-mvp-
// generation.cjs PREP_STATUSES) — the design doc's aspirational 'ready'/'confirmed'/'cancelled' are not
// implemented by any writer yet. This route maps the real vocabulary onto the FE's ready/held naming
// WITHOUT inventing a status: 'held' -> heldLineCount; every other (real) row, i.e. 'draft', -> readyLineCount.
const PREP_STATUS_HELD = 'held'

class StockPreparationProjectReadsError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationProjectReadsError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function templateByRole(role) {
  const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.role === role)
  if (!template) {
    throw new StockPreparationProjectReadsError(500, 'PROJECT_READS_TEMPLATE_MISSING', `frozen MVP template for role ${role} is missing`, { role })
  }
  return template
}

const MVP_OBJECT_ID_SET = new Set(STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS)
const PROJECT_OBJECT_ID = templateByRole('project').objectId
const BATCH_OBJECT_ID = templateByRole('bom_snapshot_batch').objectId
const EXCEPTION_OBJECT_ID = templateByRole('exception_confirmation').objectId
const PREP_LINE_OBJECT_ID = templateByRole('stock_preparation_line').objectId

function assertReadPermission(permission) {
  if (permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationProjectReadsError(
      403,
      'PROJECT_READS_PERMISSION_DENIED',
      'stock-preparation project list requires read permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
}

function ensureReadOnlyRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') {
    throw new StockPreparationProjectReadsError(
      501,
      'PROJECT_READS_RECORDS_API_UNAVAILABLE',
      'stock-preparation project reads require multitable.records.queryRecords',
      { requiredMethods: ['queryRecords'] },
    )
  }
  return recordsApi
}

// #4160: resolveFieldIds is REQUIRED — a read is as fieldId-bound as a write (see stock-preparation-
// table-actions.cjs). The records service rejects a logical filter key and returns rows keyed by
// PHYSICAL fieldId, so a read that skips the translation silently reports every cell as undefined.
function ensureProvisioningApi(provisioning) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function' || typeof provisioning.resolveFieldIds !== 'function') {
    throw new StockPreparationProjectReadsError(
      501,
      'PROJECT_READS_PROVISIONING_API_UNAVAILABLE',
      'stock-preparation project reads require multitable.provisioning findObjectSheet/resolveFieldIds',
      { requiredMethods: ['findObjectSheet', 'resolveFieldIds'] },
    )
  }
  return provisioning
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationProjectReadsError(422, 'PROJECT_READS_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function recordData(record) {
  if (isPlainObject(record) && isPlainObject(record.data)) return record.data
  return isPlainObject(record) ? record : {}
}

// Returns a READ-ONLY target-scoped records API bound to the resolved sheet AND to its logical->physical
// fieldId map, or null when the internal table is not provisioned yet (callers degrade gracefully to an
// empty/zero shape rather than failing the whole list).
async function findMvpSheet(recordsApi, provisioning, targetProjectId, objectId) {
  if (!MVP_OBJECT_ID_SET.has(objectId)) {
    throw new StockPreparationProjectReadsError(
      500,
      'PROJECT_READS_OBJECT_ID_NOT_MVP',
      'project read target objectId is not a frozen stock-preparation MVP table',
      { objectId },
    )
  }
  const sheet = await provisioning.findObjectSheet({ projectId: targetProjectId, objectId })
  const sheetId = sheet && sheet.id ? sheet.id : null
  if (!sheetId) return null
  const scoped = await createTargetScopedRecordsApi(recordsApi, { sheetId, objectId }, {
    provisioning,
    projectId: targetProjectId,
    readOnly: true,
  })
  return { id: sheetId, scoped }
}

async function queryAllRecords(target, filters) {
  const rows = []
  for (let page = 0; page < READ_MAX_PAGES; page += 1) {
    const pageRows = await target.scoped.queryRecords({ filters, limit: READ_PAGE_LIMIT, offset: page * READ_PAGE_LIMIT })
    if (!Array.isArray(pageRows)) {
      throw new StockPreparationProjectReadsError(500, 'PROJECT_READS_RECORDS_API_INVALID', 'queryRecords must return an array', { sheetId: target.id })
    }
    rows.push(...pageRows)
    if (pageRows.length < READ_PAGE_LIMIT) return rows
  }
  throw new StockPreparationProjectReadsError(422, 'PROJECT_READS_ROWS_TOO_LARGE', 'stock-preparation project read exceeded the page bound', { maxPages: READ_MAX_PAGES })
}

function foldEnum(value, enumValues) {
  const normalized = optionalString(value)
  if (!normalized) return 'unknown'
  return enumValues.includes(normalized) ? normalized : 'unknown'
}

// Zero-filled enum count map (same discipline as stock-preparation-confirm-reads.cjs#enumCounts): every
// known enum key is always present; a non-enum stored value folds into `unknown`.
function enumCounts(rows, field, enumValues) {
  const counts = {}
  for (const value of enumValues) counts[value] = 0
  const enumSet = new Set(enumValues)
  let unknown = 0
  for (const data of rows) {
    const value = optionalString(data[field])
    if (value && enumSet.has(value)) counts[value] += 1
    else unknown += 1
  }
  if (unknown > 0) counts.unknown = unknown
  return counts
}

/**
 * List every synced stock-preparation PROJECT row as a values-free per-project summary (FE view 1).
 * Unlike the rest of this read family, this is NOT scoped to one business project — the project table
 * IS the top-level list an operator picks FROM, so every row under the resolved (staging) sheet is
 * returned, bounded fail-closed at MAX_LIST_ROWS.
 */
async function listStockPreparationProjects({ recordsApi, provisioning, targetProjectId, permission } = {}) {
  assertReadPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')

  const projectSheet = await findMvpSheet(api, prov, stagingProjectId, PROJECT_OBJECT_ID)
  const projectRows = projectSheet ? (await queryAllRecords(projectSheet, {})).map(recordData) : []
  if (projectRows.length > MAX_LIST_ROWS) {
    throw new StockPreparationProjectReadsError(422, 'PROJECT_READS_ROWS_TOO_LARGE', 'stock-preparation project list exceeded the row bound', { maxRows: MAX_LIST_ROWS })
  }

  const batchSheet = await findMvpSheet(api, prov, stagingProjectId, BATCH_OBJECT_ID)
  const exceptionSheet = await findMvpSheet(api, prov, stagingProjectId, EXCEPTION_OBJECT_ID)
  const prepLineSheet = await findMvpSheet(api, prov, stagingProjectId, PREP_LINE_OBJECT_ID)

  const projects = []
  for (const data of projectRows) {
    const projectId = optionalString(data.projectId)
    // A row without its own key field cannot be used as a navigation handle — skip rather than emit a
    // row the FE could not select (defense-in-depth; the populator always writes this key field).
    if (!projectId) continue

    const batchRows = batchSheet ? await queryAllRecords(batchSheet, { projectId }) : []
    const exceptionRows = exceptionSheet
      ? (await queryAllRecords(exceptionSheet, { projectId })).map(recordData)
      : []
    const prepLineRows = prepLineSheet
      ? (await queryAllRecords(prepLineSheet, { projectId })).map(recordData)
      : []
    const prepCounts = enumCounts(prepLineRows, 'prepStatus', [PREP_STATUS_HELD])

    projects.push({
      projectId,
      projectStatus: foldEnum(data.projectStatus, PROJECT_STATUS_VALUES),
      lastSyncRunId: optionalString(data.lastSyncRunId),
      snapshotBatchCount: batchRows.length,
      openExceptionCount: exceptionRows.filter((row) => optionalString(row.status) === 'open').length,
      heldLineCount: prepCounts[PREP_STATUS_HELD] || 0,
      readyLineCount: prepLineRows.length - (prepCounts[PREP_STATUS_HELD] || 0),
    })
  }

  return {
    projectCount: projects.length,
    statusCounts: enumCounts(projectRows, 'projectStatus', PROJECT_STATUS_VALUES),
    projects,
  }
}

module.exports = {
  REQUIRED_PERMISSION,
  PROJECT_OBJECT_ID,
  BATCH_OBJECT_ID,
  EXCEPTION_OBJECT_ID,
  PREP_LINE_OBJECT_ID,
  PROJECT_STATUS_VALUES,
  StockPreparationProjectReadsError,
  listStockPreparationProjects,
  __internals: {
    assertReadPermission,
    ensureReadOnlyRecordsApi,
    ensureProvisioningApi,
    findMvpSheet,
    queryAllRecords,
    foldEnum,
    enumCounts,
    templateByRole,
    MVP_OBJECT_ID_SET,
    MAX_LIST_ROWS,
    READ_PAGE_LIMIT,
    READ_MAX_PAGES,
    PREP_STATUS_HELD,
  },
}
