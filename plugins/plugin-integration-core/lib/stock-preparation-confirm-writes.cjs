'use strict'

// #3751 stock-prep MVP — HUMAN CONFIRM writes for the two confirmation tables
// (plm_stock_preparation_material_mapping / plm_stock_preparation_unit_conversion_rule), plus the
// system candidate-sync that FEEDS the mapping review queue. These are the MVP's first
// human-in-the-loop writes, so the safety invariants below are load-bearing.
//
// HARD boundary (mirrors stock-preparation-sync-run-persist.cjs):
//   - admin-gated + fail-closed: assertAdminPermission runs BEFORE any provisioning / records access.
//   - internal-only: every read/write goes through a scoped API bound to a resolved MVP sheet whose
//     objectId is in the frozen 9-table set (createTargetScopedRecordsApi) — a bug can NEVER address
//     a foreign sheet. There is NO external ERP / K3 / PLM write, NO apply-writer import, NO raw SQL,
//     and NO fetch / live HTTP I/O of any kind.
//   - server-stamped confirmation: confirmedBy is the route-derived operator identity and confirmedAt
//     is stamped HERE at confirm time — neither is EVER body-sourced (the route allowlists reject
//     body confirmedBy / confirmedAt outright).
//   - candidate-sync never touches human fields: the R5 sync path is CREATE-ONLY for NEW mappingIds
//     and structurally strips confirmedBy / confirmedAt / notes from every row it creates. A confirmed
//     row is never auto-unconfirmed, patched, or re-created by any system write (human_preserved).
//   - unit-rule candidates are COMPUTED, never bulk-persisted: an unconfirmed persisted material-scope
//     rule would SHADOW a confirmed generic rule in the generation selector (scope priority sorts
//     before the confirmation check) — so the only unit rule this module ever writes is a row the
//     human explicitly confirmed (fingerprint-confirm of the engine's 1:1 candidate, or a fully
//     user-entered manual rule). OD3/OD4 honored: no server-invented factors beyond the 1:1 candidate.
//   - idempotent: replays of confirm / create / retire resolve to skipped_* modes with ZERO writes.
//   - values-free evidence: counts / statuses / modes / field-key NAMES / public objectId constants /
//     booleans / sha16 handles only — never a drawing number, unit symbol, or row payload.
//
// W4a EXTENSION (carry wiring — execution-plan W4a, adjudication Layer 3): applyCarryViaConfirm is
// the ONE additional write face, and the ONE place this module addresses the CANONICAL
// stock-preparation sheet — via a scoped API pinned to exactly that single objectId, resolved
// through provisioning under the same staging project. It patches ONLY human-preserved fields whose
// target cells are blank, copying them from an INACTIVE predecessor row the human confirmed — the
// K2-style server-signed carry the carry-policy module was built for. carriedBy is the route-derived
// operator identity and carriedAt is stamped HERE; neither is ever body- or decision-sourced. It
// never overwrites a non-blank cell, never creates or deactivates a row, and never goes anywhere
// near the plan apply path (which refuses carry decisions outright as unsupported).
// (Every boundary token named above appears ONLY in this prose header — never as code.)

const crypto = require('node:crypto')

const {
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
} = require('./stock-preparation-templates.cjs')
// W4a (execution-plan general-prep-execution-plan-20260722.md:111-127): the ONE
// sanctioned consumer of a CARRY_VIA_CONFIRM decision. The shape assert and the
// k2_confirm marker come from the carry module itself, so this executor and the
// policy that produced the decision can never disagree about what one means.
const {
  CARRY_DECISIONS,
  CARRY_WRITE_VIA,
  StockPreparationCarryPolicyError,
  __internals: { assertCarryViaConfirmShape },
} = require('./stock-preparation-carry-policy.cjs')
const { createTargetScopedRecordsApi } = require('./stock-preparation-table-actions.cjs')
const {
  generateMaterialMappingCandidates,
  MATCH_STATUSES,
  __internals: { mappingIdFor },
} = require('./stock-preparation-material-match.cjs')
const { generateUnitConversionRuleCandidates, RULE_OUTCOMES } = require('./stock-preparation-unit-rule-match.cjs')
const { VERSION_POLICIES, IMPLEMENTED_VERSION_POLICIES } = require('./stock-preparation-mvp-generation.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')

const REQUIRED_PERMISSION = 'admin'

// Bounded pagination for the internal reads (parity with stock-preparation-snapshot-reads.cjs).
const READ_PAGE_LIMIT = 500
const READ_MAX_PAGES = 50

// Closed vocabularies THIS module validates before any write. The select option-sets on the frozen
// templates are admin-supplied at option-sync time, so the fail-closed contract lives here.
// OD2 round-1 hardening: version policies are validated against the IMPLEMENTED set, not the full
// vocabulary — category_rule stays a reserved enum name with NO matcher branch, so accepting it
// would plant rows that silently degrade to the tail heuristic. Any value outside the implemented
// set (reserved OR junk — the guard is allowlist-shaped) is refused 422 with the field NAME only.
const IMPLEMENTED_VERSION_POLICY_SET = IMPLEMENTED_VERSION_POLICIES
const ROUNDING_RULES = Object.freeze(['none', 'ceil', 'floor', 'nearest', 'pack_size'])
const ROUNDING_RULE_SET = new Set(ROUNDING_RULES)
const SCOPE_TYPES = Object.freeze(['material', 'category', 'generic'])
const SCOPE_TYPE_SET = new Set(SCOPE_TYPES)
// Manual-confirm provenance markers (informational to the engines — selection keys off matchStatus /
// confirmation stamps, never off these literals).
const MANUAL_CONFIRM_MATCH_METHOD = 'manual_confirm'
const MANUAL_RULE_SOURCE = 'manual'
const SYSTEM_CANDIDATE_RULE_SOURCE = 'system_candidate'

// Closed create-mode allowlists (unknown keys are rejected with the offending field NAME only).
const MAPPING_CREATE_ALLOWED_KEYS = Object.freeze([
  'plmDrawingNo', 'plmVersion', 'plmMaterialName', 'plmSpec',
  'erpMaterialCode', 'erpMaterialInternalId', 'erpMaterialName', 'erpSpec',
  'versionPolicy', 'notes',
])
const RULE_CREATE_ALLOWED_KEYS = Object.freeze([
  'plmUnit', 'erpIssueUnit', 'conversionFactor', 'scopeType', 'scopeKey',
  'lossRate', 'roundingRule', 'minimumIssueQty', 'effectiveFrom', 'effectiveTo',
])

class StockPreparationConfirmWriteError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationConfirmWriteError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function templateByRole(role) {
  const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.role === role)
  if (!template) {
    throw new StockPreparationConfirmWriteError(500, 'CONFIRM_TEMPLATE_MISSING', `frozen MVP template for role ${role} is missing`, { role })
  }
  return template
}

// Object ids / field ids come straight from the FROZEN templates — nothing is invented here.
const MVP_OBJECT_ID_SET = new Set(STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS)
const MAPPING_TEMPLATE = templateByRole('material_mapping')
const RULE_TEMPLATE = templateByRole('unit_conversion_rule')
const BATCH_TEMPLATE = templateByRole('bom_snapshot_batch')
const LINE_TEMPLATE = templateByRole('bom_snapshot_line')
const RUN_TEMPLATE = templateByRole('run_record')
const MATERIAL_TEMPLATE = templateByRole('erp_material_master')
const MAPPING_OBJECT_ID = MAPPING_TEMPLATE.objectId
const RULE_OBJECT_ID = RULE_TEMPLATE.objectId
const BATCH_OBJECT_ID = BATCH_TEMPLATE.objectId
const LINE_OBJECT_ID = LINE_TEMPLATE.objectId
const RUN_OBJECT_ID = RUN_TEMPLATE.objectId
const MATERIAL_OBJECT_ID = MATERIAL_TEMPLATE.objectId
const MAPPING_KEY_FIELD = MAPPING_TEMPLATE.keyFields[0] // 'mappingId'
const RULE_KEY_FIELD = RULE_TEMPLATE.keyFields[0] // 'conversionRuleId'
const MAPPING_FIELD_IDS = MAPPING_TEMPLATE.fields.map((field) => field.id)
const RULE_FIELD_IDS = RULE_TEMPLATE.fields.map((field) => field.id)
// The human_preserved trio the candidate-sync path must NEVER write.
const MAPPING_HUMAN_FIELD_IDS = Object.freeze(['confirmedBy', 'confirmedAt', 'notes'])

function assertAdminPermission(permission) {
  if (permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationConfirmWriteError(
      403,
      'CONFIRM_PERMISSION_DENIED',
      'stock-preparation confirm writes require admin permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
}

// #4160: resolveFieldIds is REQUIRED — the scoped records API resolves the frozen template's
// logical->physical fieldId map through it (the records service accepts physical ids only).
function ensureProvisioning(provisioning) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function' || typeof provisioning.resolveFieldIds !== 'function') {
    throw new StockPreparationConfirmWriteError(
      503,
      'CONFIRM_PROVISIONING_API_UNAVAILABLE',
      'stock-preparation confirm writes require multitable.provisioning findObjectSheet/resolveFieldIds',
      { requiredMethods: ['findObjectSheet', 'resolveFieldIds'] },
    )
  }
  return provisioning
}

function ensureRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function' ||
    typeof recordsApi.createRecord !== 'function' || typeof recordsApi.patchRecord !== 'function') {
    throw new StockPreparationConfirmWriteError(
      501,
      'CONFIRM_RECORDS_API_INVALID',
      'stock-preparation confirm writes require multitable.records queryRecords/createRecord/patchRecord',
      { requiredMethods: ['queryRecords', 'createRecord', 'patchRecord'] },
    )
  }
  return recordsApi
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

// Manual unit-rule id: FULL-content hash (unlike the engine's scope-only id) so retire-then-recreate
// with a different factor mints a fresh id while an exact replay skips idempotently.
function manualConversionRuleIdFor(rule) {
  return `stockprep_unit_rule_${stableHash([
    rule.plmUnit, rule.erpIssueUnit, rule.scopeType, rule.scopeKey || '',
    rule.conversionFactor, rule.lossRate, rule.roundingRule, rule.minimumIssueQty,
    rule.effectiveFrom || '', rule.effectiveTo || '',
  ].join('|'))}`
}

// Resolve ONE MVP objectId to a scoped, sheet-bound records API (mirror of the persist committer).
// The scoped API also binds the logical->physical fieldId map for this objectId under the SAME staging
// projectId (#4160), so this module keeps speaking the frozen templates' logical keys throughout.
async function resolveScopedTarget(recordsApi, provisioning, targetProjectId, objectId) {
  if (!MVP_OBJECT_ID_SET.has(objectId)) {
    throw new StockPreparationConfirmWriteError(
      500,
      'CONFIRM_TARGET_OBJECT_ID_INVALID',
      'confirm-write target objectId is not a stock-preparation MVP table',
      { objectId },
    )
  }
  const sheet = await provisioning.findObjectSheet({ projectId: targetProjectId, objectId })
  const sheetId = optionalString(sheet && sheet.id)
  if (!sheetId) {
    throw new StockPreparationConfirmWriteError(
      409,
      'CONFIRM_TARGET_NOT_PROVISIONED',
      'stock-preparation MVP target table is not provisioned; provision the MVP tables first',
      { objectId },
    )
  }
  const scoped = await createTargetScopedRecordsApi(recordsApi, { sheetId, objectId }, { provisioning, projectId: targetProjectId })
  return { objectId, sheetId, scoped }
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

// Bounded scan (parity with snapshot-reads): page until a short page or fail closed on the bound.
async function queryAllRecords(scoped, filters) {
  const rows = []
  for (let page = 0; page < READ_MAX_PAGES; page += 1) {
    const pageRows = await scoped.queryRecords({ filters, limit: READ_PAGE_LIMIT, offset: page * READ_PAGE_LIMIT })
    if (!Array.isArray(pageRows)) {
      throw new StockPreparationConfirmWriteError(500, 'CONFIRM_RECORDS_API_INVALID', 'queryRecords must return an array')
    }
    rows.push(...pageRows)
    if (pageRows.length < READ_PAGE_LIMIT) return rows
  }
  throw new StockPreparationConfirmWriteError(422, 'CONFIRM_READS_RESULT_TOO_LARGE', 'stock-preparation confirm read exceeded the page bound', { maxPages: READ_MAX_PAGES })
}

// Exactly-one row by key field: 0 -> notFoundCode (404); 2+ -> key ambiguity (500 — the key field is
// the idempotency invariant, two rows mean the substrate is corrupt; fail closed, never pick one).
async function findByKeyField(scoped, keyField, keyValue, notFoundCode, subject) {
  const rows = await scoped.queryRecords({ filters: { [keyField]: keyValue }, limit: 2, offset: 0 })
  if (!Array.isArray(rows)) {
    throw new StockPreparationConfirmWriteError(500, 'CONFIRM_RECORDS_API_INVALID', 'queryRecords must return an array')
  }
  if (rows.length === 0) {
    throw new StockPreparationConfirmWriteError(404, notFoundCode, `${subject} was not found`, { [keyField]: keyValue })
  }
  if (rows.length > 1) {
    throw new StockPreparationConfirmWriteError(500, 'CONFIRM_KEY_AMBIGUOUS', `${subject} key matched more than one row`, { [keyField]: keyValue })
  }
  return rows[0]
}

// Ground a row to ONLY the frozen template field ids, dropping null / undefined (records service
// rejects unknown fieldIds). `excludeFields` structurally strips e.g. the human_preserved trio.
function groundRow(fieldIds, row, excludeFields = []) {
  const excluded = new Set(excludeFields)
  const out = {}
  for (const key of fieldIds) {
    if (excluded.has(key)) continue
    const value = row ? row[key] : undefined
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

function isStamped(data) {
  return Boolean(optionalString(data.confirmedBy) || optionalString(data.confirmedAt))
}

// ── batch context (shared by candidate-sync + fingerprint-confirm) ────────────────────────────────
// Resolve the working snapshot batch: an EXPLICIT snapshotBatchId must exist, belong to the business
// project, and be COMPLETE (run row present AND lines non-empty — #4002's completeness predicate:
// an orphaned mid-commit batch must never feed candidates). Without an explicit id, pick the LATEST
// complete batch (highest snapshotVersion) of the business project.
async function resolveCompleteBatchLines(api, prov, targetProjectId, projectId, snapshotBatchId) {
  const batchTarget = await resolveScopedTarget(api, prov, targetProjectId, BATCH_OBJECT_ID)
  const lineTarget = await resolveScopedTarget(api, prov, targetProjectId, LINE_OBJECT_ID)
  const runTarget = await resolveScopedTarget(api, prov, targetProjectId, RUN_OBJECT_ID)

  async function runPresent(batchRow) {
    const syncRunId = optionalString(readCell(batchRow, 'syncRunId'))
    if (!syncRunId) return false
    const runRows = await queryAllRecords(runTarget.scoped, { runId: syncRunId })
    return runRows.length > 0
  }

  if (snapshotBatchId) {
    const rows = await queryAllRecords(batchTarget.scoped, { snapshotBatchId })
    const batchRow = rows[0]
    if (!batchRow || optionalString(readCell(batchRow, 'projectId')) !== projectId) {
      throw new StockPreparationConfirmWriteError(404, 'CONFIRM_BATCH_NOT_FOUND', 'snapshot batch was not found for this project', { snapshotBatchId })
    }
    if (!(await runPresent(batchRow))) {
      throw new StockPreparationConfirmWriteError(409, 'CONFIRM_BATCH_INCOMPLETE', 'snapshot batch is incomplete (no run record)', { snapshotBatchId })
    }
    const lines = await queryAllRecords(lineTarget.scoped, { snapshotBatchId })
    if (lines.length === 0) {
      throw new StockPreparationConfirmWriteError(409, 'CONFIRM_BATCH_INCOMPLETE', 'snapshot batch is incomplete (no lines)', { snapshotBatchId })
    }
    return { snapshotBatchId, lines: lines.map(recordData) }
  }

  const projectBatches = await queryAllRecords(batchTarget.scoped, { projectId })
  const ordered = projectBatches
    .map((row) => ({ row, id: optionalString(readCell(row, 'snapshotBatchId')), version: toNumber(readCell(row, 'snapshotVersion')) || 0 }))
    .filter((entry) => entry.id)
    .sort((left, right) => (right.version - left.version) || String(left.id).localeCompare(String(right.id)))
  for (const entry of ordered) {
    if (!(await runPresent(entry.row))) continue
    const lines = await queryAllRecords(lineTarget.scoped, { snapshotBatchId: entry.id })
    if (lines.length === 0) continue
    return { snapshotBatchId: entry.id, lines: lines.map(recordData) }
  }
  throw new StockPreparationConfirmWriteError(404, 'CONFIRM_BATCH_NOT_FOUND', 'no complete snapshot batch exists for this project', { projectId })
}

// ── R5: material-mapping candidate sync ───────────────────────────────────────────────────────────
// Feed the review queue: run the landed candidate ladder over the batch lines + ERP master + existing
// mappings, then CREATE-ONLY-persist rows whose mappingId is new. Existing ids (including historical
// matched re-emits) are SKIPPED — this path never patches and never writes a human_preserved field.
async function syncMaterialMappingCandidates(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CONFIG_INVALID', 'input must be an object')
  }
  const { permission, recordsApi, provisioning: provisioningInput, context } = input
  assertAdminPermission(permission)
  const prov = ensureProvisioning(
    provisioningInput || (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const api = ensureRecordsApi(recordsApi)
  const targetProjectId = requiredString(input.targetProjectId, 'targetProjectId')
  const projectId = requiredString(input.projectId, 'projectId')
  const snapshotBatchId = optionalString(input.snapshotBatchId)
  const defaultVersionPolicy = optionalString(input.defaultVersionPolicy)
  // OD2: there is NO server default — absence is an error, per request.
  if (!defaultVersionPolicy) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_VERSION_POLICY_INVALID', 'defaultVersionPolicy is required', { field: 'defaultVersionPolicy' })
  }
  // OD2 round-1 hardening: only IMPLEMENTED policies are accepted (allowlist-shaped — reserved
  // vocabulary values without a matcher branch and junk values are refused identically).
  if (!IMPLEMENTED_VERSION_POLICY_SET.has(defaultVersionPolicy)) {
    throw new StockPreparationConfirmWriteError(422, 'STOCK_PREPARATION_VERSION_POLICY_UNSUPPORTED', 'defaultVersionPolicy is not an implemented version policy', { field: 'defaultVersionPolicy' })
  }

  const batchContext = await resolveCompleteBatchLines(api, prov, targetProjectId, projectId, snapshotBatchId)
  const materialTarget = await resolveScopedTarget(api, prov, targetProjectId, MATERIAL_OBJECT_ID)
  const mappingTarget = await resolveScopedTarget(api, prov, targetProjectId, MAPPING_OBJECT_ID)

  const erpMaterials = (await queryAllRecords(materialTarget.scoped, {})).map(recordData)
  const existingMappingRows = (await queryAllRecords(mappingTarget.scoped, {})).map(recordData)
  const existingIds = new Set(existingMappingRows.map((row) => optionalString(row[MAPPING_KEY_FIELD])).filter(Boolean))

  const generated = generateMaterialMappingCandidates({
    plmBomLines: batchContext.lines,
    erpMaterials,
    confirmedMappings: existingMappingRows,
    defaultVersionPolicy,
  })

  let created = 0
  let skippedExisting = 0
  let skippedMatched = 0
  for (const row of generated.mappingRows) {
    const mappingId = optionalString(row[MAPPING_KEY_FIELD])
    if (!mappingId || existingIds.has(mappingId)) {
      skippedExisting += 1
      continue
    }
    // Defense-in-depth: the sync path never creates a CONFIRMED row (historical re-emits carry
    // human stamps and an existing id, so they land in the skip above; this guard survives drift).
    if (row.matchStatus === MATCH_STATUSES.MATCHED) {
      skippedMatched += 1
      continue
    }
    await mappingTarget.scoped.createRecord({ data: groundRow(MAPPING_FIELD_IDS, row, MAPPING_HUMAN_FIELD_IDS) })
    existingIds.add(mappingId)
    created += 1
  }

  const counts = { created, skippedExisting, skippedMatched }
  return {
    persisted: created > 0,
    mode: created > 0 ? 'created' : 'skipped_existing',
    created: { mappings: created },
    skipped: { existing: skippedExisting, matched: skippedMatched },
    status: generated.status,
    snapshotBatchId: batchContext.snapshotBatchId,
    evidence: {
      ...generated.evidence,
      persistence: { ...counts, target: { objectId: MAPPING_OBJECT_ID, fieldKeys: MAPPING_FIELD_IDS.filter((key) => !MAPPING_HUMAN_FIELD_IDS.includes(key)) } },
      valuesFree: true,
    },
  }
}

// ── R6: material-mapping confirm ──────────────────────────────────────────────────────────────────
// XOR modes: `mappingId` stamps an EXISTING candidate row matched; `mapping` creates a fully
// operator-specified confirmed row. confirmedBy is route-derived; confirmedAt is stamped here.
async function confirmMaterialMapping(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CONFIG_INVALID', 'input must be an object')
  }
  const { permission, recordsApi, provisioning: provisioningInput, context } = input
  assertAdminPermission(permission)
  const prov = ensureProvisioning(
    provisioningInput || (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const api = ensureRecordsApi(recordsApi)
  const targetProjectId = requiredString(input.targetProjectId, 'targetProjectId')
  const confirmedBy = requiredString(input.confirmedBy, 'confirmedBy')
  const notes = optionalString(input.notes)

  const hasMappingId = optionalString(input.mappingId) !== null
  const hasMapping = input.mapping !== undefined && input.mapping !== null
  if (hasMappingId === hasMapping) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_MODE_AMBIGUOUS', 'exactly one of mappingId (confirm existing) or mapping (create confirmed) is required', { fields: ['mappingId', 'mapping'] })
  }

  const mappingTarget = await resolveScopedTarget(api, prov, targetProjectId, MAPPING_OBJECT_ID)
  const confirmedAt = new Date().toISOString()

  if (hasMappingId) {
    const mappingId = requiredString(input.mappingId, 'mappingId')
    const record = await findByKeyField(mappingTarget.scoped, MAPPING_KEY_FIELD, mappingId, 'CONFIRM_MAPPING_NOT_FOUND', 'material mapping')
    const data = recordData(record)
    if (data.isActive === false) {
      throw new StockPreparationConfirmWriteError(409, 'CONFIRM_MAPPING_INACTIVE', 'material mapping is retired; re-create it to confirm', { mappingId })
    }
    // OD2 round-2 hardening: a STORED candidate carrying an unimplemented versionPolicy (the
    // reserved category_rule or junk — absence folds to manual and stays confirmable) must not be
    // stamped matched: the match engines will never select it, so confirming it would plant exactly
    // the 'dead confirmed row' class this function refuses elsewhere. Retire/re-create instead.
    const storedVersionPolicy = optionalString(data.versionPolicy)
    if (storedVersionPolicy && !IMPLEMENTED_VERSION_POLICY_SET.has(storedVersionPolicy)) {
      throw new StockPreparationConfirmWriteError(422, 'STOCK_PREPARATION_VERSION_POLICY_UNSUPPORTED', 'material mapping carries an unimplemented version policy; retire and re-create it', { field: 'versionPolicy' })
    }
    if (data.matchStatus === MATCH_STATUSES.MATCHED && isStamped(data)) {
      return { persisted: false, mode: 'skipped_already_confirmed', mappingId, evidence: buildConfirmEvidence('mapping', 'skipped_already_confirmed') }
    }
    // A candidate without BOTH ERP identifiers is permanently unusable to the engines (their mapping
    // selectors require both) — confirming it would plant a poisoned `matched` row. Operator must use
    // create-mode with an explicit ERP identity instead.
    if (!optionalString(data.erpMaterialCode) || !optionalString(data.erpMaterialInternalId)) {
      throw new StockPreparationConfirmWriteError(409, 'CONFIRM_MAPPING_TARGET_INCOMPLETE', 'material mapping lacks a full ERP identity; confirm via create with explicit ERP identifiers', { mappingId })
    }
    const changes = { matchStatus: MATCH_STATUSES.MATCHED, confirmedBy, confirmedAt }
    if (notes) changes.notes = notes
    await mappingTarget.scoped.patchRecord({ recordId: record.id, changes })
    return { persisted: true, mode: 'confirmed', mappingId, evidence: buildConfirmEvidence('mapping', 'confirmed') }
  }

  // create-confirmed mode
  const mapping = input.mapping
  if (!isPlainObject(mapping)) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_MAPPING_FIELDS_INVALID', 'mapping must be an object', { field: 'mapping' })
  }
  for (const key of Object.keys(mapping)) {
    if (!MAPPING_CREATE_ALLOWED_KEYS.includes(key)) {
      throw new StockPreparationConfirmWriteError(400, 'CONFIRM_MAPPING_FIELDS_INVALID', `unsupported mapping field: ${key}`, { field: key })
    }
  }
  const plmDrawingNo = optionalString(mapping.plmDrawingNo)
  const erpMaterialCode = optionalString(mapping.erpMaterialCode)
  const erpMaterialInternalId = optionalString(mapping.erpMaterialInternalId)
  const versionPolicy = optionalString(mapping.versionPolicy)
  const plmVersion = optionalString(mapping.plmVersion)
  if (!plmDrawingNo) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_MAPPING_FIELDS_INVALID', 'plmDrawingNo is required', { field: 'plmDrawingNo' })
  }
  // BOTH ERP identifiers are required: the engines' selectors need both, so a row missing either
  // would be a permanently unusable confirmed mapping.
  if (!erpMaterialCode) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_MAPPING_FIELDS_INVALID', 'erpMaterialCode is required', { field: 'erpMaterialCode' })
  }
  if (!erpMaterialInternalId) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_MAPPING_FIELDS_INVALID', 'erpMaterialInternalId is required', { field: 'erpMaterialInternalId' })
  }
  if (!versionPolicy) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_MAPPING_FIELDS_INVALID', 'versionPolicy is required', { field: 'versionPolicy' })
  }
  // OD2 round-1 hardening: only IMPLEMENTED policies are accepted (allowlist-shaped — reserved
  // vocabulary values without a matcher branch and junk values are refused identically).
  if (!IMPLEMENTED_VERSION_POLICY_SET.has(versionPolicy)) {
    throw new StockPreparationConfirmWriteError(422, 'STOCK_PREPARATION_VERSION_POLICY_UNSUPPORTED', 'versionPolicy is not an implemented version policy', { field: 'versionPolicy' })
  }
  // Under drawing_and_version a version-less row could NEVER match a line (the matcher requires a
  // version on both sides) — reject rather than create a dead confirmed row.
  if (versionPolicy === VERSION_POLICIES.DRAWING_AND_VERSION && !plmVersion) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_MAPPING_FIELDS_INVALID', 'plmVersion is required under the drawing_and_version policy', { field: 'plmVersion' })
  }

  const mappingId = mappingIdFor(plmDrawingNo, plmVersion, MANUAL_CONFIRM_MATCH_METHOD, erpMaterialInternalId)
  const existing = await mappingTarget.scoped.queryRecords({ filters: { [MAPPING_KEY_FIELD]: mappingId }, limit: 2, offset: 0 })
  if (!Array.isArray(existing)) {
    throw new StockPreparationConfirmWriteError(500, 'CONFIRM_RECORDS_API_INVALID', 'queryRecords must return an array')
  }
  if (existing.length > 0) {
    return { persisted: false, mode: 'skipped_existing', mappingId, evidence: buildConfirmEvidence('mapping', 'skipped_existing') }
  }
  const row = {
    ...mapping,
    mappingId,
    // Top-level `notes` is honored when the mapping object carries none (both arrive through the
    // same closed allowlists; the sub-object wins when both are present).
    notes: optionalString(mapping.notes) || notes || undefined,
    matchStatus: MATCH_STATUSES.MATCHED,
    matchMethod: MANUAL_CONFIRM_MATCH_METHOD,
    confidence: 1,
    isActive: true,
    confirmedBy,
    confirmedAt,
  }
  await mappingTarget.scoped.createRecord({ data: groundRow(MAPPING_FIELD_IDS, row) })
  return { persisted: true, mode: 'created', mappingId, evidence: buildConfirmEvidence('mapping', 'created') }
}

// ── R7: material-mapping retire ───────────────────────────────────────────────────────────────────
// The recovery path for a wrong confirm (a bad `matched` row otherwise blocks generation forever).
// Patch is EXACTLY { isActive: false } — stamps and history stay untouched. Audit trail = Wave-5.
async function retireMaterialMapping(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CONFIG_INVALID', 'input must be an object')
  }
  const { permission, recordsApi, provisioning: provisioningInput, context } = input
  assertAdminPermission(permission)
  const prov = ensureProvisioning(
    provisioningInput || (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const api = ensureRecordsApi(recordsApi)
  const targetProjectId = requiredString(input.targetProjectId, 'targetProjectId')
  const mappingId = requiredString(input.mappingId, 'mappingId')

  const mappingTarget = await resolveScopedTarget(api, prov, targetProjectId, MAPPING_OBJECT_ID)
  const record = await findByKeyField(mappingTarget.scoped, MAPPING_KEY_FIELD, mappingId, 'CONFIRM_MAPPING_NOT_FOUND', 'material mapping')
  if (recordData(record).isActive === false) {
    return { persisted: false, mode: 'skipped_inactive', mappingId, evidence: buildConfirmEvidence('mapping', 'skipped_inactive') }
  }
  await mappingTarget.scoped.patchRecord({ recordId: record.id, changes: { isActive: false } })
  return { persisted: true, mode: 'retired', mappingId, evidence: buildConfirmEvidence('mapping', 'retired') }
}

// ── R10: unit-conversion-rule confirm ─────────────────────────────────────────────────────────────
// Tri-XOR modes:
//   a. `conversionRuleId`   — stamp an EXISTING (manual-provenance) row.
//   b. `contextFingerprint` — recompute the engine candidates for the batch context and persist the
//      SERVER-DERIVED 1:1 candidate the human just confirmed (values never cross the wire).
//   c. `rule`               — fully user-entered rule (OD3/OD4: users enter values, we never invent).
async function confirmUnitConversionRule(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CONFIG_INVALID', 'input must be an object')
  }
  const { permission, recordsApi, provisioning: provisioningInput, context } = input
  assertAdminPermission(permission)
  const prov = ensureProvisioning(
    provisioningInput || (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const api = ensureRecordsApi(recordsApi)
  const targetProjectId = requiredString(input.targetProjectId, 'targetProjectId')
  const confirmedBy = requiredString(input.confirmedBy, 'confirmedBy')

  const hasRuleId = optionalString(input.conversionRuleId) !== null
  const hasFingerprint = optionalString(input.contextFingerprint) !== null
  const hasRule = input.rule !== undefined && input.rule !== null
  if ((hasRuleId ? 1 : 0) + (hasFingerprint ? 1 : 0) + (hasRule ? 1 : 0) !== 1) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_MODE_AMBIGUOUS', 'exactly one of conversionRuleId, contextFingerprint, or rule is required', { fields: ['conversionRuleId', 'contextFingerprint', 'rule'] })
  }

  const ruleTarget = await resolveScopedTarget(api, prov, targetProjectId, RULE_OBJECT_ID)
  const confirmedAt = new Date().toISOString()

  if (hasRuleId) {
    const conversionRuleId = requiredString(input.conversionRuleId, 'conversionRuleId')
    const record = await findByKeyField(ruleTarget.scoped, RULE_KEY_FIELD, conversionRuleId, 'CONFIRM_UNIT_RULE_NOT_FOUND', 'unit conversion rule')
    const data = recordData(record)
    if (data.isActive === false) {
      throw new StockPreparationConfirmWriteError(409, 'CONFIRM_UNIT_RULE_INACTIVE', 'unit conversion rule is retired; re-create it to confirm', { conversionRuleId })
    }
    if (isStamped(data)) {
      return { persisted: false, mode: 'skipped_already_confirmed', conversionRuleId, evidence: buildConfirmEvidence('unit_rule', 'skipped_already_confirmed') }
    }
    // An UNSTAMPED system_candidate row did not come from our confirm paths (fingerprint-confirm
    // stamps at create) — its factor provenance is unverifiable, so stamping it is refused.
    if (optionalString(data.source) === SYSTEM_CANDIDATE_RULE_SOURCE) {
      throw new StockPreparationConfirmWriteError(409, 'CONFIRM_UNIT_RULE_SOURCE_UNCONFIRMABLE', 'system-candidate rules are confirmed via contextFingerprint, not by direct stamp', { conversionRuleId })
    }
    await ruleTarget.scoped.patchRecord({ recordId: record.id, changes: { confirmedBy, confirmedAt } })
    return { persisted: true, mode: 'confirmed', conversionRuleId, evidence: buildConfirmEvidence('unit_rule', 'confirmed') }
  }

  if (hasFingerprint) {
    const contextFingerprint = requiredString(input.contextFingerprint, 'contextFingerprint')
    const projectId = requiredString(input.projectId, 'projectId')
    const snapshotBatchId = optionalString(input.snapshotBatchId)
    const batchContext = await resolveCompleteBatchLines(api, prov, targetProjectId, projectId, snapshotBatchId)
    const materialTarget = await resolveScopedTarget(api, prov, targetProjectId, MATERIAL_OBJECT_ID)
    const mappingTarget = await resolveScopedTarget(api, prov, targetProjectId, MAPPING_OBJECT_ID)

    const generated = generateUnitConversionRuleCandidates({
      bomSnapshotLines: batchContext.lines,
      materialMappings: (await queryAllRecords(mappingTarget.scoped, {})).map(recordData),
      erpMaterials: (await queryAllRecords(materialTarget.scoped, {})).map(recordData),
      unitConversionRules: (await queryAllRecords(ruleTarget.scoped, {})).map(recordData),
    })
    const outcome = generated.outcomes.find((entry) => entry.contextFingerprint === contextFingerprint && entry.outcome === RULE_OUTCOMES.CANDIDATE)
    if (!outcome || !outcome.candidateRule) {
      // Stale view: the fingerprint no longer resolves to a live candidate (snapshot changed, rule
      // landed meanwhile, or the context is held) — the operator must re-read before confirming.
      throw new StockPreparationConfirmWriteError(409, 'CONFIRM_UNIT_CANDIDATE_NOT_FOUND', 'contextFingerprint does not resolve to a current unit-rule candidate', { contextFingerprint })
    }
    const candidate = outcome.candidateRule
    const conversionRuleId = optionalString(candidate.conversionRuleId)
    const existing = await ruleTarget.scoped.queryRecords({ filters: { [RULE_KEY_FIELD]: conversionRuleId }, limit: 2, offset: 0 })
    if (!Array.isArray(existing)) {
      throw new StockPreparationConfirmWriteError(500, 'CONFIRM_RECORDS_API_INVALID', 'queryRecords must return an array')
    }
    if (existing.length > 0) {
      return { persisted: false, mode: 'skipped_existing', conversionRuleId, evidence: buildConfirmEvidence('unit_rule', 'skipped_existing') }
    }
    await ruleTarget.scoped.createRecord({ data: groundRow(RULE_FIELD_IDS, { ...candidate, confirmedBy, confirmedAt }) })
    return { persisted: true, mode: 'created', conversionRuleId, evidence: buildConfirmEvidence('unit_rule', 'created') }
  }

  // mode c: fully user-entered rule
  const rule = input.rule
  if (!isPlainObject(rule)) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'rule must be an object', { field: 'rule' })
  }
  for (const key of Object.keys(rule)) {
    if (!RULE_CREATE_ALLOWED_KEYS.includes(key)) {
      throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', `unsupported rule field: ${key}`, { field: key })
    }
  }
  const plmUnit = optionalString(rule.plmUnit)
  const erpIssueUnit = optionalString(rule.erpIssueUnit)
  const scopeType = optionalString(rule.scopeType)
  const scopeKey = optionalString(rule.scopeKey)
  if (!plmUnit) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'plmUnit is required', { field: 'plmUnit' })
  }
  if (!erpIssueUnit) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'erpIssueUnit is required', { field: 'erpIssueUnit' })
  }
  const conversionFactor = toNumber(rule.conversionFactor)
  if (conversionFactor === null || conversionFactor <= 0) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'conversionFactor must be a finite number greater than zero', { field: 'conversionFactor' })
  }
  const lossRate = rule.lossRate === undefined ? 0 : toNumber(rule.lossRate)
  if (lossRate === null || lossRate < 0) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'lossRate must be a finite number of at least zero', { field: 'lossRate' })
  }
  const minimumIssueQty = rule.minimumIssueQty === undefined ? 0 : toNumber(rule.minimumIssueQty)
  if (minimumIssueQty === null || minimumIssueQty < 0) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'minimumIssueQty must be a finite number of at least zero', { field: 'minimumIssueQty' })
  }
  // The generation engine silently no-ops an unknown rounding rule — the gate must reject instead.
  const roundingRule = rule.roundingRule === undefined ? 'none' : optionalString(rule.roundingRule)
  if (!roundingRule || !ROUNDING_RULE_SET.has(roundingRule)) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'roundingRule must be one of the rounding-rule vocabulary', { field: 'roundingRule' })
  }
  if (!scopeType || !SCOPE_TYPE_SET.has(scopeType)) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'scopeType must be one of material, category, generic', { field: 'scopeType' })
  }
  if ((scopeType === 'material' || scopeType === 'category') && !scopeKey) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', `scopeKey is required for the ${scopeType} scope`, { field: 'scopeKey' })
  }
  if (scopeType === 'generic' && scopeKey) {
    throw new StockPreparationConfirmWriteError(400, 'CONFIRM_UNIT_RULE_FIELDS_INVALID', 'scopeKey is forbidden for the generic scope', { field: 'scopeKey' })
  }
  const effectiveFrom = optionalString(rule.effectiveFrom)
  const effectiveTo = optionalString(rule.effectiveTo)

  const normalizedRule = {
    plmUnit,
    erpIssueUnit,
    conversionFactor,
    scopeType,
    scopeKey: scopeKey || undefined,
    lossRate,
    roundingRule,
    minimumIssueQty,
    effectiveFrom: effectiveFrom || undefined,
    effectiveTo: effectiveTo || undefined,
  }
  const conversionRuleId = manualConversionRuleIdFor(normalizedRule)
  const existing = await ruleTarget.scoped.queryRecords({ filters: { [RULE_KEY_FIELD]: conversionRuleId }, limit: 2, offset: 0 })
  if (!Array.isArray(existing)) {
    throw new StockPreparationConfirmWriteError(500, 'CONFIRM_RECORDS_API_INVALID', 'queryRecords must return an array')
  }
  if (existing.length > 0) {
    return { persisted: false, mode: 'skipped_existing', conversionRuleId, evidence: buildConfirmEvidence('unit_rule', 'skipped_existing') }
  }
  const row = {
    ...normalizedRule,
    conversionRuleId,
    source: MANUAL_RULE_SOURCE,
    requiresConfirmation: true,
    isActive: true,
    confirmedBy,
    confirmedAt,
  }
  await ruleTarget.scoped.createRecord({ data: groundRow(RULE_FIELD_IDS, row) })
  return { persisted: true, mode: 'created', conversionRuleId, evidence: buildConfirmEvidence('unit_rule', 'created') }
}

// ── R11: unit-conversion-rule retire ──────────────────────────────────────────────────────────────
// Required before re-creating a same-scope rule with a different factor: two ACTIVE same-scope rules
// tie in the selector and fail closed as a conflict — retire-then-create is the sanctioned sequence.
async function retireUnitConversionRule(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CONFIG_INVALID', 'input must be an object')
  }
  const { permission, recordsApi, provisioning: provisioningInput, context } = input
  assertAdminPermission(permission)
  const prov = ensureProvisioning(
    provisioningInput || (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const api = ensureRecordsApi(recordsApi)
  const targetProjectId = requiredString(input.targetProjectId, 'targetProjectId')
  const conversionRuleId = requiredString(input.conversionRuleId, 'conversionRuleId')

  const ruleTarget = await resolveScopedTarget(api, prov, targetProjectId, RULE_OBJECT_ID)
  const record = await findByKeyField(ruleTarget.scoped, RULE_KEY_FIELD, conversionRuleId, 'CONFIRM_UNIT_RULE_NOT_FOUND', 'unit conversion rule')
  if (recordData(record).isActive === false) {
    return { persisted: false, mode: 'skipped_inactive', conversionRuleId, evidence: buildConfirmEvidence('unit_rule', 'skipped_inactive') }
  }
  await ruleTarget.scoped.patchRecord({ recordId: record.id, changes: { isActive: false } })
  return { persisted: true, mode: 'retired', conversionRuleId, evidence: buildConfirmEvidence('unit_rule', 'retired') }
}

// ── W4a: applyCarryViaConfirm ─────────────────────────────────────────────────────────────────────
// The locked 6-step consumer of a CARRY_VIA_CONFIRM decision (execution-plan W4a):
//   1. assertAdminPermission BEFORE any provisioning/records access;
//   2. assertCarryViaConfirmShape (the carry module's own fail-closed shape wall);
//   3. carryFields ⊆ HUMAN_PRESERVED whitelist + writeVia === k2_confirm (re-asserted HERE so a
//      mutated shape assert upstream still cannot widen this executor);
//   4. source row by sourceIdempotencyKey MUST be active === false (a live row is never a carry
//      source); target row by idempotencyKey (findByKeyField: 404 absent / 500 ambiguous);
//   5. ONE recordsApi patch of exactly the carried fields; carriedBy = route identity,
//      carriedAt = module clock — the decision/body cannot carry either (closed key allowlist);
//   6. no-overwrite idempotency: a non-blank target cell is NEVER clobbered — equal ⇒ counted
//      already-carried (full replay ⇒ skipped_already_carried no-op), different ⇒ closed 409
//      refusal naming field NAMES only, and then NOTHING is written (not even the clean fields:
//      a half-carried row would misreport as done).

const CANONICAL_TEMPLATE = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE
const CANONICAL_OBJECT_ID = CANONICAL_TEMPLATE.objectId
const CANONICAL_KEY_FIELD = CANONICAL_TEMPLATE.keyFields[0] // 'idempotencyKey'

// The FULL closed key set of a carry decision — exactly what the carry module's builder emits.
// Anything else (a smuggled carriedBy/confirmedAt, a human-field value, a record) is refused by
// NAME before any IO.
const CARRY_DECISION_ALLOWED_KEYS = Object.freeze([
  'decision', 'idempotencyKey', 'sourceIdempotencyKey', 'componentSourceId',
  'carryKey', 'manualRowReattach', 'carryFields', 'writeVia', 'requiresConfirm', 'carry',
])

function isBlankCell(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

// The records service's optimistic-concurrency refusal (multitable/record-errors.ts
// MultitableRecordVersionConflictError: `code = 'VERSION_CONFLICT'`, name set in its constructor).
// Matched on BOTH handles so neither a code rename nor a name rename silently turns a refused write
// into an unhandled 500 — and so that a host which surfaces only one of them is still recognised.
function isRecordVersionConflict(error) {
  if (!error) return false
  return error.code === 'VERSION_CONFLICT' || error.name === 'MultitableRecordVersionConflictError'
}

function assertCarryDecision(decision) {
  if (!isPlainObject(decision)) {
    throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CARRY_DECISION_INVALID', 'decision must be a carry_via_confirm decision object', { field: 'decision' })
  }
  for (const key of Object.keys(decision)) {
    if (!CARRY_DECISION_ALLOWED_KEYS.includes(key)) {
      throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CARRY_DECISION_INVALID', `unsupported decision field: ${key}`, { field: key })
    }
  }
  // Step 2: the carry module's own shape wall (closed vocabulary, no ADD-shaped record, no
  // human-field values, carryFields ⊆ whitelist). Its typed error is wrapped into this module's
  // closed code with the REASON token only — never a value.
  try {
    assertCarryViaConfirmShape(decision)
  } catch (error) {
    if (error instanceof StockPreparationCarryPolicyError) {
      throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CARRY_DECISION_INVALID', 'decision failed the carry_via_confirm shape wall', {
        field: 'decision',
        carryPolicyReason: error.reason,
      })
    }
    throw error
  }
  // Step 3, re-asserted locally (defense in depth — see the header of this block).
  if (decision.decision !== CARRY_DECISIONS.CARRY_VIA_CONFIRM || decision.writeVia !== CARRY_WRITE_VIA) {
    throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CARRY_DECISION_INVALID', 'decision must be a k2_confirm carry_via_confirm decision', { field: 'decision' })
  }
  if (!Array.isArray(decision.carryFields) || decision.carryFields.length === 0
    || decision.carryFields.some((field) => !HUMAN_PRESERVED_FIELD_IDS.includes(field))) {
    throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CARRY_DECISION_INVALID', 'carryFields must be a non-empty subset of the human-preserved whitelist', { field: 'carryFields' })
  }
  return decision
}

// Resolve the CANONICAL sheet — pinned to the single canonical objectId, never a caller-chosen one.
async function resolveScopedCanonicalTarget(recordsApi, provisioning, targetProjectId) {
  const sheet = await provisioning.findObjectSheet({ projectId: targetProjectId, objectId: CANONICAL_OBJECT_ID })
  const sheetId = optionalString(sheet && sheet.id)
  if (!sheetId) {
    throw new StockPreparationConfirmWriteError(
      409,
      'CONFIRM_CARRY_TARGET_NOT_PROVISIONED',
      'the canonical stock-preparation table is not provisioned under this project; carry requires the provisioning-managed canonical target',
      { objectId: CANONICAL_OBJECT_ID },
    )
  }
  const scoped = await createTargetScopedRecordsApi(recordsApi, { sheetId, objectId: CANONICAL_OBJECT_ID }, { provisioning, projectId: targetProjectId })
  return { objectId: CANONICAL_OBJECT_ID, sheetId, scoped }
}

async function applyCarryViaConfirm(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationConfirmWriteError(422, 'CONFIRM_CONFIG_INVALID', 'input must be an object')
  }
  const { permission, recordsApi, provisioning: provisioningInput, context } = input
  // Step 1 — before ANY provisioning / records access.
  assertAdminPermission(permission)
  // Steps 2+3 — pure decision validation, still before any IO.
  const decision = assertCarryDecision(input.decision)
  const prov = ensureProvisioning(
    provisioningInput || (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const api = ensureRecordsApi(recordsApi)
  const targetProjectId = requiredString(input.targetProjectId, 'targetProjectId')
  const confirmedBy = requiredString(input.confirmedBy, 'confirmedBy')

  const target = await resolveScopedCanonicalTarget(api, prov, targetProjectId)

  // Step 4 — the source row must exist and be INACTIVE (carry-policy's precondition, re-checked at
  // write time so a row that came back to life between plan and confirm refuses).
  const sourceRecord = await findByKeyField(target.scoped, CANONICAL_KEY_FIELD, decision.sourceIdempotencyKey, 'CONFIRM_CARRY_SOURCE_NOT_FOUND', 'carry source row')
  const sourceData = recordData(sourceRecord)
  if (sourceData.active !== false) {
    throw new StockPreparationConfirmWriteError(409, 'CONFIRM_CARRY_SOURCE_ACTIVE', 'the carry source row is active; only an inactive predecessor can be a carry source', {})
  }
  const targetRecord = await findByKeyField(target.scoped, CANONICAL_KEY_FIELD, decision.idempotencyKey, 'CONFIRM_CARRY_TARGET_NOT_FOUND', 'carry target row')
  const targetData = recordData(targetRecord)
  if (targetData.active === false) {
    throw new StockPreparationConfirmWriteError(409, 'CONFIRM_CARRY_TARGET_INACTIVE', 'the carry target row is inactive; a carry onto a removed row is refused', {})
  }
  // Anti-forgery, axis 1 — COMPONENT: the decision claims both rows share ONE componentSourceId —
  // verify against BOTH stored rows, so a hand-crafted decision cannot reattach across unrelated
  // components.
  const claimed = optionalString(String(decision.componentSourceId))
  if (optionalString(isBlankCell(sourceData.componentSourceId) ? null : String(sourceData.componentSourceId)) !== claimed
    || optionalString(isBlankCell(targetData.componentSourceId) ? null : String(targetData.componentSourceId)) !== claimed) {
    throw new StockPreparationConfirmWriteError(409, 'CONFIRM_CARRY_COMPONENT_SOURCE_MISMATCH', 'decision, source row and target row must agree on the component source id', { field: 'componentSourceId' })
  }
  // Anti-forgery, axis 2 — PROJECT. The component check alone is NOT a scope: two different projects
  // routinely share one PLM component, and such a pair satisfies it, which would let one project's
  // human band be copied onto another project's row. The planner's carry source pool is drawn from
  // ONE project's existing rows, so this re-asserts at write time the scope the plan already assumed.
  const sourceProject = optionalString(isBlankCell(sourceData.projectNo) ? null : String(sourceData.projectNo))
  const targetProject = optionalString(isBlankCell(targetData.projectNo) ? null : String(targetData.projectNo))
  if (!sourceProject || !targetProject || sourceProject !== targetProject) {
    throw new StockPreparationConfirmWriteError(409, 'CONFIRM_CARRY_PROJECT_MISMATCH', 'source row and target row must belong to the same project', { field: 'projectNo' })
  }
  // ...and since a real idempotencyKey EMBEDS its projectNo (bom-expansion makeIdempotencyKey), both
  // keys must agree with the rows they addressed. A key that does not parse as that shape skips this
  // leg — the stored-row check above is the load-bearing one and already stands.
  for (const [key, field] of [[decision.idempotencyKey, 'idempotencyKey'], [decision.sourceIdempotencyKey, 'sourceIdempotencyKey']]) {
    let parsed = null
    try {
      parsed = JSON.parse(key)
    } catch (error) {
      parsed = null
    }
    if (!isPlainObject(parsed) || parsed.projectNo === undefined) continue
    if (optionalString(String(parsed.projectNo)) !== targetProject) {
      throw new StockPreparationConfirmWriteError(409, 'CONFIRM_CARRY_PROJECT_MISMATCH', 'a carry key names a different project than the rows it addresses', { field })
    }
  }

  // Steps 5+6 — classify per carried field. Field NAMES only in every refusal.
  const changes = {}
  const carriedFields = []
  const alreadyCarriedFields = []
  const conflictedFields = []
  const missingSourceFields = []
  for (const field of decision.carryFields) {
    const sourceValue = sourceData[field]
    if (isBlankCell(sourceValue)) {
      missingSourceFields.push(field)
      continue
    }
    const targetValue = targetData[field]
    if (isBlankCell(targetValue)) {
      changes[field] = sourceValue
      carriedFields.push(field)
      continue
    }
    if (String(targetValue) === String(sourceValue)) {
      alreadyCarriedFields.push(field)
      continue
    }
    conflictedFields.push(field)
  }
  if (missingSourceFields.length > 0) {
    // The proposal is stale: the source no longer holds the human context it named at plan time.
    throw new StockPreparationConfirmWriteError(409, 'CONFIRM_CARRY_SOURCE_CONTEXT_MISSING', 'the carry source row no longer carries a value for every proposed field', { fields: missingSourceFields })
  }
  if (conflictedFields.length > 0) {
    // NEVER overwrite (P4 frozen semantics). And never half-carry around the conflict either.
    throw new StockPreparationConfirmWriteError(409, 'CONFIRM_CARRY_TARGET_ALREADY_SET', 'a carry target human field already holds a different value; carry never overwrites', { fields: conflictedFields })
  }

  // Step 5 stamps — module-side, NEVER decision/body-sourced (the allowlist above refused those).
  const carriedAt = new Date().toISOString()
  const evidenceBase = {
    subject: 'carry',
    target: { objectId: CANONICAL_OBJECT_ID, keyField: CANONICAL_KEY_FIELD },
    carriedFields: carriedFields.slice(),
    alreadyCarriedFields: alreadyCarriedFields.slice(),
    carriedByPresent: true,
    carriedAtPresent: true,
    valuesFree: true,
  }
  if (carriedFields.length === 0) {
    // Step 6: full replay (every field already carried with the same content) — no-op, no patch.
    return {
      persisted: false,
      mode: 'skipped_already_carried',
      idempotencyKey: decision.idempotencyKey,
      sourceIdempotencyKey: decision.sourceIdempotencyKey,
      carriedBy: confirmedBy,
      carriedAt,
      carriedFields: [],
      alreadyCarriedFields: alreadyCarriedFields.slice(),
      evidence: { ...evidenceBase, mode: 'skipped_already_carried' },
    }
  }
  // Step 6, ENFORCED rather than merely decided. The no-overwrite verdict above was computed from a
  // `targetData` READ; without optimistic concurrency the promise would only be as strong as the
  // read-write window, and a human edit landing inside it would be silently clobbered — exactly what
  // step 6 says can never happen. `expectedVersion` closes the window at the substrate: the records
  // service checks it in code AND pins it in the UPDATE's SQL predicate, so a row that moved since
  // the read fails the write instead of overwriting it.
  try {
    await target.scoped.patchRecord({ recordId: targetRecord.id, changes, expectedVersion: targetRecord.version })
  } catch (error) {
    if (isRecordVersionConflict(error)) {
      throw new StockPreparationConfirmWriteError(
        409,
        'CONFIRM_CARRY_TARGET_VERSION_CONFLICT',
        'the carry target row changed while this carry was being decided; re-read and confirm again',
        { fields: carriedFields.slice() },
      )
    }
    throw error
  }
  return {
    persisted: true,
    mode: 'carried',
    idempotencyKey: decision.idempotencyKey,
    sourceIdempotencyKey: decision.sourceIdempotencyKey,
    carriedBy: confirmedBy,
    carriedAt,
    carriedFields: carriedFields.slice(),
    alreadyCarriedFields: alreadyCarriedFields.slice(),
    evidence: { ...evidenceBase, mode: 'carried' },
  }
}

// Values-free per-op evidence: subject kind + mode + target identity (objectId / key-field NAME).
function buildConfirmEvidence(subject, mode) {
  const target = subject === 'mapping'
    ? { objectId: MAPPING_OBJECT_ID, keyField: MAPPING_KEY_FIELD }
    : { objectId: RULE_OBJECT_ID, keyField: RULE_KEY_FIELD }
  return { subject, mode, target, valuesFree: true }
}

module.exports = {
  REQUIRED_PERMISSION,
  MAPPING_OBJECT_ID,
  RULE_OBJECT_ID,
  MAPPING_KEY_FIELD,
  RULE_KEY_FIELD,
  ROUNDING_RULES,
  SCOPE_TYPES,
  MANUAL_CONFIRM_MATCH_METHOD,
  MANUAL_RULE_SOURCE,
  StockPreparationConfirmWriteError,
  syncMaterialMappingCandidates,
  confirmMaterialMapping,
  retireMaterialMapping,
  confirmUnitConversionRule,
  retireUnitConversionRule,
  applyCarryViaConfirm,
  __internals: {
    assertAdminPermission,
    ensureProvisioning,
    ensureRecordsApi,
    resolveScopedTarget,
    resolveCompleteBatchLines,
    queryAllRecords,
    findByKeyField,
    groundRow,
    manualConversionRuleIdFor,
    stableHash,
    isStamped,
    MVP_OBJECT_ID_SET,
    MAPPING_FIELD_IDS,
    RULE_FIELD_IDS,
    MAPPING_HUMAN_FIELD_IDS,
    READ_PAGE_LIMIT,
    READ_MAX_PAGES,
  },
}
