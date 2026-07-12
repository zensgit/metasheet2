'use strict'

// #3751 stock-prep MVP — READONLY confirmation-state reads backing FE views 3 + 4 (material-mapping
// confirmation / unit-conversion confirmation): table summaries, the mapping review queue, and the
// COMPUTED unit-rule candidate list.
//
// This module is structurally READ-ONLY (mirror of stock-preparation-snapshot-reads.cjs):
//   - it calls ONLY recordsApi.queryRecords — never createRecord / patchRecord / delete (the guard
//     requires nothing else, and tests prove no write method is ever invoked);
//   - it never reads PLM and never touches K3 / ERP / any external system / SQL / fetch / HTTP;
//   - every read target objectId is asserted to be a member of the FROZEN MVP object-id set;
//   - admin-gated (fail-closed) with bounded pagination;
//   - VALUES-FREE: counts / status enums / booleans / sha16 handles (mappingId / conversionRuleId /
//     contextFingerprint / snapshotBatchId) only — never a drawing number, material name, spec, ERP
//     code, unit symbol, conversion factor, loss rate, or minimum quantity.
// (The forbidden tokens above appear ONLY in this prose header — never as code.)
//
// UNIT CANDIDATES ARE COMPUTED, NEVER PERSISTED (load-bearing asymmetry, shared with the confirm-
// writes module): a persisted-but-unconfirmed material-scope rule would SHADOW a confirmed generic
// rule in the generation selector (scope priority sorts before the confirmation check). So R9
// re-evaluates the engine per read and the ONLY rule rows that ever exist are human-confirmed ones.

const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
} = require('./stock-preparation-templates.cjs')
const {
  generateUnitConversionRuleCandidates,
  RULE_OUTCOMES,
  HELD_REASONS,
} = require('./stock-preparation-unit-rule-match.cjs')
const { MATCH_STATUSES, MATCH_METHODS, VERSION_POLICIES: MATCH_VERSION_POLICIES } = require('./stock-preparation-material-match.cjs')
const { VERSION_POLICIES, EXCEPTION_TYPES, PREP_STATUSES, UNIT_STATUSES } = require('./stock-preparation-mvp-generation.cjs')
const { createTargetScopedRecordsApi } = require('./stock-preparation-table-actions.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')

const REQUIRED_PERMISSION = 'admin'
const READ_PAGE_LIMIT = 500
const READ_MAX_PAGES = 50
const MAX_LIST_ROWS = 2000

// Enum vocabularies for the zero-filled count maps (FE renders fixed whitelists — every known key is
// always present, junk stored values fold into `unknown` and the junk string itself never crosses).
const MATCH_STATUS_VALUES = Object.freeze(Object.values(MATCH_STATUSES))
// matchMethod vocabulary = engine methods + the confirm-writes manual marker (same fold-to-unknown
// discipline as matchStatus/versionPolicy — a junk stored string never crosses the wire).
const MATCH_METHOD_VALUES = Object.freeze([...Object.values(MATCH_METHODS), 'manual_confirm'])
const VERSION_POLICY_VALUES = Object.freeze([...new Set([...Object.values(VERSION_POLICIES), ...Object.values(MATCH_VERSION_POLICIES)])])
const SCOPE_TYPE_VALUES = Object.freeze(['material', 'category', 'generic'])
// W5 queue-read vocabularies (engine + design §8 closed sets; same fold-to-unknown discipline).
const EXCEPTION_TYPE_VALUES = Object.freeze(Object.values(EXCEPTION_TYPES))
const EXCEPTION_SEVERITY_VALUES = Object.freeze(['info', 'warning', 'blocking'])
const EXCEPTION_STATUS_VALUES = Object.freeze(['open', 'resolved', 'ignored', 'deferred'])
const RESOLUTION_ACTION_VALUES = Object.freeze(['mapping_confirmed', 'unit_rule_confirmed', 'accepted_change', 'manual_hold'])
const PREP_STATUS_VALUES = Object.freeze(Object.values(PREP_STATUSES))
const UNIT_STATUS_VALUES = Object.freeze(Object.values(UNIT_STATUSES))
const ROUNDING_RULE_VALUES = Object.freeze(['none', 'ceil', 'floor', 'nearest', 'pack_size'])
// A mapping row awaits a human decision when it is ACTIVE and in any non-matched status.
const PENDING_CONFIRM_STATUSES = Object.freeze([
  MATCH_STATUSES.PENDING_CONFIRM,
  MATCH_STATUSES.MULTI_CANDIDATE,
  MATCH_STATUSES.VERSION_CONFLICT,
  MATCH_STATUSES.NOT_FOUND,
])
// R8's pending-unit-line reasons: the held reasons an operator resolves IN VIEW 4 (unit-side gaps).
// Mapping-side helds (missing_mapping / missing_material) belong to view 3 and are EXCLUDED.
const PENDING_UNIT_REASONS = Object.freeze([
  HELD_REASONS.RULE_MISSING,
  HELD_REASONS.RULE_CONFLICT,
  HELD_REASONS.MISSING_DESIGN_UNIT,
  HELD_REASONS.MISSING_ISSUE_UNIT,
])

class StockPreparationConfirmReadError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationConfirmReadError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function templateByRole(role) {
  const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.role === role)
  if (!template) {
    throw new StockPreparationConfirmReadError(500, 'CONFIRM_READS_TEMPLATE_MISSING', `frozen MVP template for role ${role} is missing`, { role })
  }
  return template
}

const MVP_OBJECT_ID_SET = new Set(STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS)
const MAPPING_OBJECT_ID = templateByRole('material_mapping').objectId
const RULE_OBJECT_ID = templateByRole('unit_conversion_rule').objectId
const BATCH_OBJECT_ID = templateByRole('bom_snapshot_batch').objectId
const LINE_OBJECT_ID = templateByRole('bom_snapshot_line').objectId
const RUN_OBJECT_ID = templateByRole('run_record').objectId
const MATERIAL_OBJECT_ID = templateByRole('erp_material_master').objectId
const EXCEPTION_OBJECT_ID = templateByRole('exception_confirmation').objectId
const PREP_LINE_OBJECT_ID = templateByRole('stock_preparation_line').objectId

function assertAdminPermission(permission) {
  if (permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationConfirmReadError(
      403,
      'CONFIRM_READS_PERMISSION_DENIED',
      'stock-preparation confirm reads require admin permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
}

// READONLY guard: only queryRecords is required — this module never needs a write method.
function ensureReadOnlyRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') {
    throw new StockPreparationConfirmReadError(
      501,
      'CONFIRM_READS_RECORDS_API_UNAVAILABLE',
      'stock-preparation confirm reads require multitable.records.queryRecords',
      { requiredMethods: ['queryRecords'] },
    )
  }
  return recordsApi
}

// #4160: resolveFieldIds is REQUIRED — a read is as fieldId-bound as a write. The records service
// rejects a logical filter key ('Unknown fieldId') and returns rows keyed by PHYSICAL fieldId, so a
// read that skips the translation silently reports every cell as undefined.
function ensureProvisioningApi(provisioning) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function' || typeof provisioning.resolveFieldIds !== 'function') {
    throw new StockPreparationConfirmReadError(
      501,
      'CONFIRM_READS_PROVISIONING_API_UNAVAILABLE',
      'stock-preparation confirm reads require multitable.provisioning findObjectSheet/resolveFieldIds',
      { requiredMethods: ['findObjectSheet', 'resolveFieldIds'] },
    )
  }
  return provisioning
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationConfirmReadError(422, 'CONFIRM_READS_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function recordData(record) {
  if (isPlainObject(record) && isPlainObject(record.data)) return record.data
  return isPlainObject(record) ? record : {}
}

function readCell(record, key) {
  return recordData(record)[key]
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// Returns a READ-ONLY target-scoped records API bound to the resolved sheet AND to its
// logical->physical fieldId map (#4160 — the one translating entry point), or null when the internal
// table is not provisioned yet (callers degrade gracefully).
async function findMvpSheet(recordsApi, provisioning, targetProjectId, objectId) {
  if (!MVP_OBJECT_ID_SET.has(objectId)) {
    throw new StockPreparationConfirmReadError(
      500,
      'CONFIRM_READS_OBJECT_ID_NOT_MVP',
      'confirm read target objectId is not a frozen stock-preparation MVP table',
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

// `target` is a findMvpSheet result — the scoped, field-mapped API; filters/rows stay logical.
async function queryAllRecords(target, filters) {
  const rows = []
  for (let page = 0; page < READ_MAX_PAGES; page += 1) {
    const pageRows = await target.scoped.queryRecords({ filters, limit: READ_PAGE_LIMIT, offset: page * READ_PAGE_LIMIT })
    if (!Array.isArray(pageRows)) {
      throw new StockPreparationConfirmReadError(500, 'CONFIRM_READS_RECORDS_API_INVALID', 'queryRecords must return an array', { sheetId: target.id })
    }
    rows.push(...pageRows)
    if (pageRows.length < READ_PAGE_LIMIT) return rows
  }
  throw new StockPreparationConfirmReadError(422, 'CONFIRM_READS_RESULT_TOO_LARGE', 'stock-preparation confirm read exceeded the page bound', { maxPages: READ_MAX_PAGES })
}

function isActiveRow(data) {
  return data.isActive !== false
}

function isStamped(data) {
  return Boolean(optionalString(data.confirmedBy) || optionalString(data.confirmedAt))
}

// Zero-filled enum count map: every known enum key is ALWAYS present (FE fixed-whitelist rendering),
// and a non-enum stored value folds into `unknown` — the junk string itself never crosses the wire.
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

// Latest COMPLETE batch (run row present AND lines non-empty) of the business project — the same
// completeness predicate as the #4002 list / confirm-writes sync (an orphaned mid-commit batch must
// never feed a pending computation). Returns null when none qualifies.
async function resolveLatestCompleteBatchLines(api, prov, targetProjectId, projectId, snapshotBatchId) {
  const batchSheet = await findMvpSheet(api, prov, targetProjectId, BATCH_OBJECT_ID)
  const lineSheet = await findMvpSheet(api, prov, targetProjectId, LINE_OBJECT_ID)
  const runSheet = await findMvpSheet(api, prov, targetProjectId, RUN_OBJECT_ID)
  if (!batchSheet || !lineSheet) return null

  async function runPresent(batchRow) {
    if (!runSheet) return false
    const syncRunId = optionalString(readCell(batchRow, 'syncRunId'))
    if (!syncRunId) return false
    const runRows = await queryAllRecords(runSheet, { runId: syncRunId })
    return runRows.length > 0
  }

  if (snapshotBatchId) {
    const rows = await queryAllRecords(batchSheet, { snapshotBatchId })
    const batchRow = rows[0]
    if (!batchRow || optionalString(readCell(batchRow, 'projectId')) !== projectId) return null
    if (!(await runPresent(batchRow))) return null
    const lines = await queryAllRecords(lineSheet, { snapshotBatchId })
    if (lines.length === 0) return null
    return { snapshotBatchId, lines: lines.map(recordData) }
  }

  const projectBatches = await queryAllRecords(batchSheet, { projectId })
  const ordered = projectBatches
    .map((row) => ({ row, id: optionalString(readCell(row, 'snapshotBatchId')), version: toNumber(readCell(row, 'snapshotVersion')) || 0 }))
    .filter((entry) => entry.id)
    .sort((left, right) => (right.version - left.version) || String(left.id).localeCompare(String(right.id)))
  for (const entry of ordered) {
    if (!(await runPresent(entry.row))) continue
    const lines = await queryAllRecords(lineSheet, { snapshotBatchId: entry.id })
    if (lines.length === 0) continue
    return { snapshotBatchId: entry.id, lines: lines.map(recordData) }
  }
  return null
}

// Shared unit-candidate computation for R8's pending count + R9's row list.
async function computeUnitCandidates(api, prov, targetProjectId, projectId, snapshotBatchId) {
  const batchContext = await resolveLatestCompleteBatchLines(api, prov, targetProjectId, projectId, snapshotBatchId)
  if (!batchContext) return null
  const mappingSheet = await findMvpSheet(api, prov, targetProjectId, MAPPING_OBJECT_ID)
  const materialSheet = await findMvpSheet(api, prov, targetProjectId, MATERIAL_OBJECT_ID)
  const ruleSheet = await findMvpSheet(api, prov, targetProjectId, RULE_OBJECT_ID)
  const generated = generateUnitConversionRuleCandidates({
    bomSnapshotLines: batchContext.lines,
    materialMappings: mappingSheet ? (await queryAllRecords(mappingSheet, {})).map(recordData) : [],
    erpMaterials: materialSheet ? (await queryAllRecords(materialSheet, {})).map(recordData) : [],
    unitConversionRules: ruleSheet ? (await queryAllRecords(ruleSheet, {})).map(recordData) : [],
  })
  return { snapshotBatchId: batchContext.snapshotBatchId, generated }
}

function pendingUnitOutcome(outcome) {
  if (outcome.outcome === RULE_OUTCOMES.CANDIDATE) return true
  return outcome.outcome === RULE_OUTCOMES.HELD && PENDING_UNIT_REASONS.includes(outcome.reason)
}

// ── R3: material-mapping summary ──────────────────────────────────────────────────────────────────
// Counts over the (tenant-level) mapping table — the template carries no projectId field, so the
// summary is deliberately tenant-scoped; `projectId` is required at the ROUTE for FE parity but the
// mapping table itself is the cross-project reuse asset.
async function getMaterialMappingSummary({ recordsApi, provisioning, targetProjectId, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')

  const mappingSheet = await findMvpSheet(api, prov, stagingProjectId, MAPPING_OBJECT_ID)
  const rows = mappingSheet ? (await queryAllRecords(mappingSheet, {})).map(recordData) : []
  const activeRows = rows.filter(isActiveRow)
  return {
    totalMappingCount: rows.length,
    activeMappingCount: activeRows.length,
    matchStatusCounts: enumCounts(activeRows, 'matchStatus', MATCH_STATUS_VALUES),
    versionPolicyCounts: enumCounts(activeRows, 'versionPolicy', VERSION_POLICY_VALUES),
    pendingConfirmCount: activeRows.filter((data) => PENDING_CONFIRM_STATUSES.includes(optionalString(data.matchStatus))).length,
  }
}

// ── R4: material-mapping review queue ─────────────────────────────────────────────────────────────
// Table-backed candidate list. VALUES-FREE rows: handle + enums + booleans + confidence score only —
// no drawing number / name / spec / ERP identifiers ever cross.
async function listMaterialMappingCandidates({ recordsApi, provisioning, targetProjectId, matchStatus, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  const matchStatusFilter = optionalString(matchStatus)
  if (matchStatusFilter && !MATCH_STATUS_VALUES.includes(matchStatusFilter)) {
    throw new StockPreparationConfirmReadError(422, 'CONFIRM_READS_CONFIG_INVALID', 'matchStatus must be one of the match-status vocabulary', { field: 'matchStatus' })
  }

  const mappingSheet = await findMvpSheet(api, prov, stagingProjectId, MAPPING_OBJECT_ID)
  let rows = mappingSheet ? (await queryAllRecords(mappingSheet, {})).map(recordData) : []
  rows = rows.filter(isActiveRow)
  if (matchStatusFilter) rows = rows.filter((data) => optionalString(data.matchStatus) === matchStatusFilter)
  if (rows.length > MAX_LIST_ROWS) {
    throw new StockPreparationConfirmReadError(422, 'CONFIRM_READS_ROWS_TOO_LARGE', 'material-mapping candidate read exceeded the row bound', { maxRows: MAX_LIST_ROWS })
  }
  const projected = rows.map((data) => ({
    mappingId: optionalString(data.mappingId),
    matchStatus: MATCH_STATUS_VALUES.includes(optionalString(data.matchStatus)) ? optionalString(data.matchStatus) : 'unknown',
    matchMethod: MATCH_METHOD_VALUES.includes(optionalString(data.matchMethod)) ? optionalString(data.matchMethod) : (optionalString(data.matchMethod) ? 'unknown' : undefined),
    versionPolicy: VERSION_POLICY_VALUES.includes(optionalString(data.versionPolicy)) ? optionalString(data.versionPolicy) : 'unknown',
    confidence: toNumber(data.confidence),
    isActive: data.isActive !== false,
    confirmed: isStamped(data),
    hasErpTarget: Boolean(optionalString(data.erpMaterialCode) && optionalString(data.erpMaterialInternalId)),
    plmVersionPresent: optionalString(data.plmVersion) !== null,
  }))
  return {
    rowCount: projected.length,
    byMatchStatus: enumCounts(rows, 'matchStatus', MATCH_STATUS_VALUES),
    rows: projected,
  }
}

// ── R8: unit-conversion summary ───────────────────────────────────────────────────────────────────
// Rule counts are tenant-level (no projectId on the template); `pendingUnitLineCount` is COMPUTED
// over the latest complete batch of the given business project — no complete batch => 0 (the FE
// shape stays lockstep; no extra keys).
async function getUnitConversionSummary({ recordsApi, provisioning, targetProjectId, projectId, snapshotBatchId, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  const businessProjectId = requiredString(projectId, 'projectId')

  const ruleSheet = await findMvpSheet(api, prov, stagingProjectId, RULE_OBJECT_ID)
  const rows = ruleSheet ? (await queryAllRecords(ruleSheet, {})).map(recordData) : []
  const activeRows = rows.filter(isActiveRow)

  let pendingUnitLineCount = 0
  const computed = await computeUnitCandidates(api, prov, stagingProjectId, businessProjectId, optionalString(snapshotBatchId))
  if (computed) {
    pendingUnitLineCount = computed.generated.outcomes.filter(pendingUnitOutcome).length
  }

  return {
    totalRuleCount: rows.length,
    activeRuleCount: activeRows.length,
    requiresConfirmationCount: activeRows.filter((data) => data.requiresConfirmation === true && !isStamped(data)).length,
    scopeTypeCounts: enumCounts(activeRows, 'scopeType', SCOPE_TYPE_VALUES),
    roundingRuleCounts: enumCounts(activeRows, 'roundingRule', ROUNDING_RULE_VALUES),
    pendingUnitLineCount,
  }
}

// ── R9: unit-rule candidate list (COMPUTED) ───────────────────────────────────────────────────────
// Recomputes the engine per read (see the header asymmetry note). `candidateRule` VALUES (unit
// symbols / factor) are STRIPPED — only `hasCandidate` crosses; a row is confirmable via the
// confirm-writes fingerprint mode.
async function listUnitConversionCandidates({ recordsApi, provisioning, targetProjectId, projectId, snapshotBatchId, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  const businessProjectId = requiredString(projectId, 'projectId')

  const computed = await computeUnitCandidates(api, prov, stagingProjectId, businessProjectId, optionalString(snapshotBatchId))
  if (!computed) {
    throw new StockPreparationConfirmReadError(404, 'CONFIRM_READS_BATCH_NOT_FOUND', 'no complete snapshot batch exists for this project', { projectId: businessProjectId })
  }
  const outcomes = computed.generated.outcomes
  if (outcomes.length > MAX_LIST_ROWS) {
    throw new StockPreparationConfirmReadError(422, 'CONFIRM_READS_ROWS_TOO_LARGE', 'unit-conversion candidate read exceeded the row bound', { maxRows: MAX_LIST_ROWS })
  }
  const byOutcome = {}
  const byReason = {}
  for (const outcome of outcomes) {
    const outcomeKey = optionalString(outcome.outcome) || 'unknown'
    byOutcome[outcomeKey] = (byOutcome[outcomeKey] || 0) + 1
    const reasonKey = optionalString(outcome.reason) || 'unknown'
    byReason[reasonKey] = (byReason[reasonKey] || 0) + 1
  }
  return {
    status: computed.generated.status,
    snapshotBatchId: computed.snapshotBatchId,
    rowCount: outcomes.length,
    byOutcome,
    byReason,
    rows: outcomes.map((outcome) => ({
      contextFingerprint: optionalString(outcome.contextFingerprint),
      outcome: optionalString(outcome.outcome),
      reason: optionalString(outcome.reason) || undefined,
      conversionRuleId: optionalString(outcome.conversionRuleId) || undefined,
      hasCandidate: Boolean(outcome.candidateRule),
    })),
  }
}

// helper: validate an optional enum filter (422 with the field NAME only).
function optionalEnumFilter(value, enumValues, field) {
  const normalized = optionalString(value)
  if (normalized && !enumValues.includes(normalized)) {
    throw new StockPreparationConfirmReadError(422, 'CONFIRM_READS_CONFIG_INVALID', `${field} must be one of the ${field} vocabulary`, { field })
  }
  return normalized
}

function foldEnum(value, enumValues) {
  const normalized = optionalString(value)
  if (!normalized) return undefined
  return enumValues.includes(normalized) ? normalized : 'unknown'
}

// ── W5: exception queue list (FE view 6) ──────────────────────────────────────────────────────────
// VALUES-FREE rows: handles + enums + booleans only — the `message` cell (human-readable business
// text) NEVER crosses; resolver identity surfaces as a presence boolean.
async function listStockPreparationExceptions({ recordsApi, provisioning, targetProjectId, projectId, snapshotBatchId, status, exceptionType, severity, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  const businessProjectId = requiredString(projectId, 'projectId')
  const statusFilter = optionalEnumFilter(status, EXCEPTION_STATUS_VALUES, 'status')
  const typeFilter = optionalEnumFilter(exceptionType, EXCEPTION_TYPE_VALUES, 'exceptionType')
  const severityFilter = optionalEnumFilter(severity, EXCEPTION_SEVERITY_VALUES, 'severity')
  const batchFilter = optionalString(snapshotBatchId)

  const exceptionSheet = await findMvpSheet(api, prov, stagingProjectId, EXCEPTION_OBJECT_ID)
  let rows = exceptionSheet
    ? (await queryAllRecords(exceptionSheet, batchFilter
        ? { projectId: businessProjectId, snapshotBatchId: batchFilter }
        : { projectId: businessProjectId })).map(recordData)
    : []
  if (statusFilter) rows = rows.filter((data) => optionalString(data.status) === statusFilter)
  if (typeFilter) rows = rows.filter((data) => optionalString(data.exceptionType) === typeFilter)
  if (severityFilter) rows = rows.filter((data) => optionalString(data.severity) === severityFilter)
  if (rows.length > MAX_LIST_ROWS) {
    throw new StockPreparationConfirmReadError(422, 'CONFIRM_READS_ROWS_TOO_LARGE', 'exception queue read exceeded the row bound', { maxRows: MAX_LIST_ROWS })
  }
  // Count scope follows the ACTIVE filters (post-filter subset): it equals the W4a ready-invariant
  // count only for a batch-scoped, unfiltered read — display context, never the enforcement point
  // (enforcement lives in the generation run route).
  const unresolvedBlockingCount = rows.filter((data) => optionalString(data.severity) === 'blocking' && optionalString(data.status) !== 'resolved').length
  return {
    rowCount: rows.length,
    unresolvedBlockingCount,
    byType: enumCounts(rows, 'exceptionType', EXCEPTION_TYPE_VALUES),
    byStatus: enumCounts(rows, 'status', EXCEPTION_STATUS_VALUES),
    bySeverity: enumCounts(rows, 'severity', EXCEPTION_SEVERITY_VALUES),
    rows: rows.map((data) => ({
      exceptionId: optionalString(data.exceptionId),
      snapshotBatchId: optionalString(data.snapshotBatchId) || undefined,
      snapshotLineId: optionalString(data.snapshotLineId) || undefined,
      stockPrepLineId: optionalString(data.stockPrepLineId) || undefined,
      exceptionType: foldEnum(data.exceptionType, EXCEPTION_TYPE_VALUES),
      severity: foldEnum(data.severity, EXCEPTION_SEVERITY_VALUES),
      status: foldEnum(data.status, EXCEPTION_STATUS_VALUES),
      resolutionAction: foldEnum(data.resolutionAction, RESOLUTION_ACTION_VALUES),
      resolved: optionalString(data.status) === 'resolved',
      resolvedByPresent: optionalString(data.resolvedBy) !== null,
    })),
  }
}

// ── W5: prep-line list (FE view 5) ────────────────────────────────────────────────────────────────
// VALUES-FREE summary rows: handles + status enums + counts + presence booleans. Drawing numbers,
// quantities, and unit symbols are value-bearing operator reads — OWNER-GATED (OD-W3-1), not served.
async function listStockPreparationPrepLines({ recordsApi, provisioning, targetProjectId, projectId, snapshotBatchId, prepStatus, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  const businessProjectId = requiredString(projectId, 'projectId')
  const prepStatusFilter = optionalEnumFilter(prepStatus, PREP_STATUS_VALUES, 'prepStatus')
  const batchFilter = optionalString(snapshotBatchId)

  const prepLineSheet = await findMvpSheet(api, prov, stagingProjectId, PREP_LINE_OBJECT_ID)
  let rows = prepLineSheet
    ? (await queryAllRecords(prepLineSheet, batchFilter
        ? { projectId: businessProjectId, snapshotBatchId: batchFilter }
        : { projectId: businessProjectId })).map(recordData)
    : []
  if (prepStatusFilter) rows = rows.filter((data) => optionalString(data.prepStatus) === prepStatusFilter)
  if (rows.length > MAX_LIST_ROWS) {
    throw new StockPreparationConfirmReadError(422, 'CONFIRM_READS_ROWS_TOO_LARGE', 'prep-line read exceeded the row bound', { maxRows: MAX_LIST_ROWS })
  }
  return {
    rowCount: rows.length,
    byPrepStatus: enumCounts(rows, 'prepStatus', PREP_STATUS_VALUES),
    byMappingStatus: enumCounts(rows, 'mappingStatus', MATCH_STATUS_VALUES),
    byUnitStatus: enumCounts(rows, 'unitStatus', UNIT_STATUS_VALUES),
    rows: rows.map((data) => ({
      stockPrepLineId: optionalString(data.stockPrepLineId),
      snapshotBatchId: optionalString(data.snapshotBatchId) || undefined,
      snapshotLineId: optionalString(data.snapshotLineId) || undefined,
      prepStatus: foldEnum(data.prepStatus, PREP_STATUS_VALUES),
      mappingStatus: foldEnum(data.mappingStatus, MATCH_STATUS_VALUES),
      unitStatus: foldEnum(data.unitStatus, UNIT_STATUS_VALUES),
      exceptionCount: toNumber(data.exceptionCount) || 0,
      hasIssueQty: toNumber(data.issueQtyFinal) !== null,
      hasErpTarget: Boolean(optionalString(data.erpMaterialCode) && optionalString(data.erpMaterialInternalId)),
      createdFromRunId: optionalString(data.createdFromRunId) || undefined,
    })),
  }
}

module.exports = {
  REQUIRED_PERMISSION,
  MAPPING_OBJECT_ID,
  RULE_OBJECT_ID,
  StockPreparationConfirmReadError,
  getMaterialMappingSummary,
  listMaterialMappingCandidates,
  getUnitConversionSummary,
  listUnitConversionCandidates,
  listStockPreparationExceptions,
  listStockPreparationPrepLines,
  __internals: {
    assertAdminPermission,
    ensureReadOnlyRecordsApi,
    ensureProvisioningApi,
    queryAllRecords,
    enumCounts,
    resolveLatestCompleteBatchLines,
    computeUnitCandidates,
    pendingUnitOutcome,
    MATCH_STATUS_VALUES,
    VERSION_POLICY_VALUES,
    PENDING_CONFIRM_STATUSES,
    PENDING_UNIT_REASONS,
    MAX_LIST_ROWS,
    READ_PAGE_LIMIT,
    READ_MAX_PAGES,
  },
}
