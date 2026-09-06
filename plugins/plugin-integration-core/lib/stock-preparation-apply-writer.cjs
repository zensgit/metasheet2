'use strict'

// #2253 C4: apply a reviewed stock-preparation conflict plan to one MetaSheet
// main table. This helper is intentionally narrow: it writes only through an
// injected MetaSheet records API, never reads PLM, never writes an external DB,
// and never touches K3.

const {
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const {
  DECISIONS,
  derivePackAwarePlmWritableFields,
} = require('./stock-preparation-conflict-planner.cjs')
const { isTenantExtensionField } = require('./stock-preparation-extension-namespace.cjs')

const APPLY_PERMISSIONS = Object.freeze(['write', 'admin'])
const KNOWN_TARGET_WRITE_ERROR_CODES = Object.freeze(new Set([
  'create_record_failed',
  'duplicate_target_key',
  'field_mapping_failed',
  'missing_required_field',
  'patch_record_failed',
  'select_option_not_found',
  'target_field_type_mismatch',
  'target_record_validation_failed',
  'target_row_not_found',
  'target_scope_violation',
  // An `ext_` logical id reached the records-API boundary with no physical id
  // bound for it. Raised by `mapFieldName` — see the comment there for why this
  // is a refusal and not a fallback.
  'unmapped_extension_field',
  'unsupported_decision',
]))

class StockPreparationApplyWriterError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationApplyWriterError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StockPreparationApplyWriterError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeFieldIdMap(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new StockPreparationApplyWriterError(`${field} must be an object`, { field })
  }
  const out = {}
  for (const [logical, physical] of Object.entries(value)) {
    const logicalName = optionalString(logical)
    const physicalName = optionalString(physical)
    if (logicalName && physicalName) out[logicalName] = physicalName
  }
  return out
}

function normalizeTarget(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationApplyWriterError('target must be an object', { field: 'target' })
  }
  return {
    sheetId: requiredString(input.sheetId, 'target.sheetId'),
    objectId: optionalString(input.objectId) || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    keyField: optionalString(input.keyField) || 'idempotencyKey',
    fieldIdMap: normalizeFieldIdMap(input.fieldIdMap, 'target.fieldIdMap'),
  }
}

function requireApplyPermission(permission) {
  if (!APPLY_PERMISSIONS.includes(permission)) {
    throw new StockPreparationApplyWriterError('apply requires Data Factory write/admin permission', {
      field: 'permission',
      permission,
    })
  }
  return permission
}

function normalizePlan(plan) {
  if (!isPlainObject(plan) || !Array.isArray(plan.decisions)) {
    throw new StockPreparationApplyWriterError('plan.decisions must be an array', { field: 'plan.decisions' })
  }
  return plan
}

function getRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function' || typeof recordsApi.createRecord !== 'function' || typeof recordsApi.patchRecord !== 'function') {
    throw new StockPreparationApplyWriterError('C4 apply requires queryRecords/createRecord/patchRecord records API', {
      field: 'recordsApi',
    })
  }
  return recordsApi
}

// "Does this target bind logical ids to physical ids AT ALL?" — the same
// predicate the table-action completeness gate uses
// (stock-preparation-table-actions.cjs `targetFieldMapHasExplicitBindings`).
// An EMPTY map is a legitimate mode: the target is addressed by logical id and
// every key passes through untranslated. A map with at least one binding is the
// explicit mode, where a key that is absent from the map is a HOLE, not a
// pass-through.
function fieldIdMapHasExplicitBindings(fieldIdMap = {}) {
  for (const key of Object.keys(fieldIdMap || {})) {
    if (typeof fieldIdMap[key] === 'string' && fieldIdMap[key].trim()) return true
  }
  return false
}

/**
 * Translate ONE logical field id to its physical id.
 *
 * The raw-id fallback (`fieldIdMap[field] || field`) is kept for CANONICAL ids —
 * removing it would break the empty-map mode and every existing caller. It is
 * REFUSED for a tenant `ext_` id under an explicit map, and that refusal is the
 * point of this function.
 *
 * An `ext_` logical id has no meaning to the records API: the physical id is
 * `stableMetaId('fld', projectId, objectId, fieldId)`
 * (packages/core-backend/src/multitable/provisioning.ts:130-136, :146-148), so a
 * fallback would send a string that addresses NO column. Before this guard that
 * produced a silent write to a wrong/nonexistent field id, surfacing (if at all)
 * as an opaque host error at the very end of an apply. Now the hole is named at
 * the boundary, with the logical id that is missing from the map.
 */
function mapFieldName(field, fieldIdMap = {}, explicit = fieldIdMapHasExplicitBindings(fieldIdMap)) {
  const physical = fieldIdMap[field]
  if (physical) return physical
  if (explicit && isTenantExtensionField(field)) {
    throw new StockPreparationApplyWriterError(
      'target.fieldIdMap has no physical id for an extension field; refusing to fall back to the raw logical id',
      {
        code: 'unmapped_extension_field',
        reason: 'unmapped_extension_field',
        field,
      },
    )
  }
  return field
}

function mapRecordFields(record, fieldIdMap = {}) {
  // Computed ONCE per payload: the mode is a property of the map, not of the key.
  const explicit = fieldIdMapHasExplicitBindings(fieldIdMap)
  const out = {}
  for (const [field, value] of Object.entries(record || {})) {
    out[mapFieldName(field, fieldIdMap, explicit)] = value
  }
  return out
}

function fieldMapForTemplate(template) {
  return new Map((template.fields || []).map((field) => [field.id, field]))
}

function typeMismatch(field, expectedType) {
  return new StockPreparationApplyWriterError('target field value does not match the stock-preparation template type', {
    code: 'target_field_type_mismatch',
    field,
    expectedType,
    reason: 'type_mismatch',
  })
}

function normalizeValueForTemplateField(value, field) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!field || !field.type) return value

  if (field.type === 'string' || field.type === 'date' || field.type === 'select') {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    throw typeMismatch(field.id, field.type)
  }

  if (field.type === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
    throw typeMismatch(field.id, field.type)
  }

  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (normalized === 'true') return true
      if (normalized === 'false') return false
    }
    throw typeMismatch(field.id, field.type)
  }

  return value
}

function normalizePayloadForTemplate(payload, templateFields) {
  const out = {}
  for (const [field, value] of Object.entries(payload || {})) {
    out[field] = normalizeValueForTemplateField(value, templateFields.get(field))
  }
  return out
}

function decisionKey(decision, target) {
  const key = decision && typeof decision.idempotencyKey === 'string' && decision.idempotencyKey.trim()
    ? decision.idempotencyKey.trim()
    : decision && decision.record && typeof decision.record[target.keyField] === 'string'
      ? decision.record[target.keyField].trim()
      : decision && decision.patch && typeof decision.patch[target.keyField] === 'string'
        ? decision.patch[target.keyField].trim()
        : ''
  if (!key) {
    throw new StockPreparationApplyWriterError('decision.idempotencyKey is required for apply', {
      field: 'decision.idempotencyKey',
    })
  }
  return key
}

function assertNoHumanFields(payload, context, humanFields = HUMAN_PRESERVED_FIELD_IDS) {
  for (const field of humanFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new StockPreparationApplyWriterError(`${context} must not include human-preserved field ${field}`, {
        field,
        context,
      })
    }
  }
}

// The per-row lookup, unchanged: ONE key, `LIMIT 2` so that "more than one row carries this key"
// is detectable without reading the whole match set.
async function queryRecordsForKey(recordsApi, target, key) {
  const physicalKey = mapFieldName(target.keyField, target.fieldIdMap)
  return callRecordsApi('queryRecords', () => recordsApi.queryRecords({
    sheetId: target.sheetId,
    filters: { [physicalKey]: key },
    limit: 2,
    offset: 0,
  }))
}

// ---------------------------------------------------------------------------
// W9: per-chunk batch idempotency-key lookup.
//
// WHY. `data ->> $k = $v` has no index, so the planner walks
// `idx_meta_records_sheet_id_id` over EVERY row of the target sheet and heap-fetches each ~1.3KB
// JSONB to evaluate the filter. Measured read-only on 222 (2026-09-07, EXPLAIN ANALYZE): 52,560
// rows removed by filter, ~114ms per lookup, and per-row apply cost rising linearly with the rows
// already in the target sheet — 47.07 / 62.72 / 82.99 ms per row at 13k / 26k / 39k existing rows
// (least squares: 1.382ms per thousand rows + 28.34ms, residuals <= 1.54ms). A new key is the worst
// case and the common one: nothing matches, so the scan always runs to the end of the table. The
// UPDATE path pays the same, because `LIMIT 2` cannot stop until it has proven there is no second
// row. #5524's metadata memo is orthogonal and does not touch this.
//
// WHAT THIS IS NOT. It is not a new behaviour and not a new predicate: one `= ANY(list)` query per
// chunk asks precisely the union of the per-row `= $key` questions this loop asks today, and the
// answers are then handed out per key. Same duplicate guard, same "first by id" winner, same
// results/counts/evidence. Everything below exists to keep that equivalence provable, and every
// case it cannot prove falls back to the per-row path rather than guessing.
//
// CONCURRENCY — stated plainly, because it does widen a window. Today a competing writer that
// inserts the same key between this lookup and this row's create loses to nothing: there is no
// unique constraint on the key and no lock, so both rows land. Prefetching moves that read to the
// top of the chunk, so the window for one row grows from "this row's own lookup" to "this chunk"
// (<= 1000 rows, typically 100). It is the SAME risk, wider — not a new class of failure, and not
// one this PR closes. Closing it takes a unique index on the key plus an upsert, which is a
// separate change (DDL, and it must pass the proven-tenant gate first).
const BATCH_KEY_LOOKUP_ENV = 'MULTITABLE_STOCK_PREP_BATCH_KEY_LOOKUP'

// Default ON. The switch exists ONLY to roll back to the per-row path in production without a
// redeploy; it is not a feature toggle for a second behaviour, because there is no second
// behaviour to choose. Any value other than `false` leaves the batch lookup on.
function batchKeyLookupDisabled(env = process.env) {
  const raw = env && env[BATCH_KEY_LOOKUP_ENV]
  return String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase() === 'false'
}

// Which key does a returned row carry? `pre_mapped` targets (both apply callers) hand the records
// API physical ids and get physical ids back; a `logical`-mode fence translates them back to the
// template's own ids. Those are the only two spellings of the SAME field. Anything else — no
// `data`, key absent, a value that is not one of the keys we asked for — is NOT attributed to a
// guess; the caller falls back to per-row lookups for the whole chunk.
function readRecordKeyValue(record, physicalKey, logicalKey) {
  const data = record && record.data
  if (!isPlainObject(data)) return null
  const candidates = physicalKey === logicalKey ? [physicalKey] : [physicalKey, logicalKey]
  for (const candidate of candidates) {
    if (!Object.prototype.hasOwnProperty.call(data, candidate)) continue
    const value = data[candidate]
    if (value === null || value === undefined) return null
    return typeof value === 'string' ? value : String(value)
  }
  return null
}

// Every key this chunk will look up, in decision order, de-duplicated. Only the three decisions
// that actually call `findExistingRecord`; `skip` / `manual_confirm` never do (and are not required
// to carry a key at all), and an unsupported decision throws before it gets there.
function collectLookupKeys(plan, target) {
  const keys = []
  const seen = new Set()
  for (const entry of plan.decisions) {
    const decision = entry || {}
    if (decision.decision !== DECISIONS.ADD
      && decision.decision !== DECISIONS.UPDATE
      && decision.decision !== DECISIONS.INACTIVE) continue
    let key
    try {
      key = decisionKey(decision, target)
    } catch (error) {
      // A decision with no key fails on its own row later, with its own error, exactly as today.
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

/**
 * One query for the whole chunk → `Map<key, records[]>`, or `null` meaning "use the per-row path".
 *
 * `null` is returned — never a partial or optimistic index — whenever the batch cannot be shown to
 * carry the same answer as the per-row lookups: switch off, host cannot filter by a list, the query
 * failed or returned a non-array, the row set hit its upper bound (so rows may have been cut off),
 * or a returned row cannot be attributed to a key we asked for. Falling back costs the chunk its
 * speed-up and nothing else: the per-row path then re-runs each lookup and surfaces each failure on
 * its own row, which is exactly today's behaviour.
 */
async function prefetchIdempotencyKeyIndex({ recordsApi, target, plan }) {
  if (batchKeyLookupDisabled()) return null
  if (recordsApi.supportsFilterValueLists !== true) return null
  try {
    const keys = collectLookupKeys(plan, target)
    if (keys.length === 0) return new Map()
    const logicalKey = target.keyField
    const physicalKey = mapFieldName(logicalKey, target.fieldIdMap)
    // Upper bound, never a silent truncation. Under the per-row semantics a key needs at most 2
    // rows to decide (1 = hit, >1 = duplicate), so 2 rows per key is everything this index can
    // possibly need; the `+1` makes "the host had more to give" observable instead of invisible.
    const limit = keys.length * 2 + 1
    const records = await recordsApi.queryRecords({
      sheetId: target.sheetId,
      filters: { [physicalKey]: keys },
      limit,
      offset: 0,
    })
    if (!Array.isArray(records)) return null
    if (records.length >= limit) return null
    const index = new Map(keys.map((key) => [key, []]))
    for (const record of records) {
      const value = readRecordKeyValue(record, physicalKey, logicalKey)
      if (value === null || !index.has(value)) return null
      index.get(value).push(record)
    }
    return index
  } catch (error) {
    return null
  }
}

// After a successful write the index must agree with the table, or a SECOND decision carrying the
// same key inside this same chunk would still see "no such row" and insert a duplicate. A write
// whose row id we cannot learn drops the key from the index instead of recording a lie — the next
// lookup for it then goes back to the database.
function rememberWrittenRow(keyIndex, key, recordId) {
  if (!keyIndex) return
  if (typeof recordId === 'string' && recordId.trim()) {
    keyIndex.set(key, [{ id: recordId }])
    return
  }
  keyIndex.delete(key)
}

async function findExistingRecord(recordsApi, target, key, keyIndex = null) {
  // A key missing from the index was never prefetched (or was dropped by `rememberWrittenRow`), so
  // it is asked for directly rather than assumed absent.
  const records = keyIndex && keyIndex.has(key)
    ? keyIndex.get(key)
    : await queryRecordsForKey(recordsApi, target, key)
  if (!Array.isArray(records)) {
    throw new StockPreparationApplyWriterError('queryRecords must return an array', { field: 'recordsApi.queryRecords' })
  }
  if (records.length > 1) {
    throw new StockPreparationApplyWriterError('multiple target rows match idempotency key', {
      code: 'duplicate_target_key',
    })
  }
  return records[0] || null
}

function copyPayload(value, field) {
  if (!isPlainObject(value)) {
    throw new StockPreparationApplyWriterError(`${field} must be an object`, { field })
  }
  return { ...value }
}

function errorName(error) {
  return typeof (error && error.name) === 'string' && error.name.trim()
    ? error.name.trim()
    : ''
}

function errorRawCode(error) {
  return typeof (error && error.code) === 'string' && error.code.trim()
    ? error.code.trim()
    : ''
}

function errorMessage(error) {
  return typeof (error && error.message) === 'string'
    ? error.message
    : String(error || '')
}

function messageMatches(error, pattern) {
  return pattern.test(errorMessage(error))
}

function isTypeMismatchMessage(error) {
  return messageMatches(error, /value must be|must be (a )?(string|number|boolean)|Number value must be finite|String value must be string|Boolean value must be boolean/i)
}

function classifyTargetWriteError(error, operation = 'apply') {
  const detailsCode = typeof (error && error.details && error.details.code) === 'string'
    ? error.details.code
    : ''
  if (KNOWN_TARGET_WRITE_ERROR_CODES.has(detailsCode)) return detailsCode

  const rawCode = errorRawCode(error)
  if (rawCode === 'FIELD_READONLY' || rawCode === 'FIELD_HIDDEN' || rawCode === 'TARGET_SCOPE_VIOLATION') {
    return 'target_scope_violation'
  }
  if (rawCode === 'VALIDATION_ERROR') {
    if (messageMatches(error, /invalid (multi-)?select option/i)) return 'select_option_not_found'
    if (isTypeMismatchMessage(error)) return 'target_field_type_mismatch'
    return 'target_record_validation_failed'
  }

  const name = errorName(error)
  if (name === 'StockPreparationApplyWriterError') return 'target_record_validation_failed'
  if (name === 'RecordNotFoundError' || name === 'MultitableRecordNotFoundError') return 'target_scope_violation'
  if (name === 'RecordValidationError' || name === 'MultitableRecordValidationError' || name === 'RecordValidationFailedError') {
    if (messageMatches(error, /invalid (multi-)?select option/i)) return 'select_option_not_found'
    if (isTypeMismatchMessage(error)) return 'target_field_type_mismatch'
    return 'target_record_validation_failed'
  }
  if (name === 'RecordPatchFieldValidationError') {
    if (messageMatches(error, /select/i)) return 'select_option_not_found'
    return 'target_record_validation_failed'
  }

  if (messageMatches(error, /unknown field(id)?/i)) return 'field_mapping_failed'
  if (messageMatches(error, /invalid (multi-)?select option/i)) return 'select_option_not_found'
  if (messageMatches(error, /required/i)) return 'missing_required_field'
  if (isTypeMismatchMessage(error)) return 'target_field_type_mismatch'
  if (messageMatches(error, /insufficient permissions|scope violation|not allowed|readonly|hidden/i)) return 'target_scope_violation'
  if (messageMatches(error, /validation failed|value must|field is|must be/i)) return 'target_record_validation_failed'

  return operation === 'patchRecord' ? 'patch_record_failed' : 'create_record_failed'
}

function sanitizeTargetWriteMessage(code, operation = 'apply') {
  const action = operation === 'patchRecord'
    ? 'patch target row'
    : operation === 'createRecord'
      ? 'create target row'
      : operation === 'queryRecords'
        ? 'query target rows'
        : 'apply target row'
  return `${action} failed: ${code}`
}

function wrapTargetWriteError(error, operation) {
  if (error instanceof StockPreparationApplyWriterError) return error
  const code = classifyTargetWriteError(error, operation)
  return new StockPreparationApplyWriterError(sanitizeTargetWriteMessage(code, operation), {
    code,
    operation,
  })
}

async function callRecordsApi(operation, callback) {
  try {
    return await callback()
  } catch (error) {
    throw wrapTargetWriteError(error, operation)
  }
}

async function applyAddDecision({ recordsApi, target, decision, humanFields, templateFields, keyIndex }) {
  const key = decisionKey(decision, target)
  let record = copyPayload(decision.record, 'decision.record')
  if (!Object.prototype.hasOwnProperty.call(record, target.keyField)) record[target.keyField] = key
  assertNoHumanFields(record, 'add record', humanFields)
  record = normalizePayloadForTemplate(record, templateFields)

  const existing = await findExistingRecord(recordsApi, target, key, keyIndex)
  if (existing && existing.id) {
    const updated = await callRecordsApi('patchRecord', () => recordsApi.patchRecord({
      sheetId: target.sheetId,
      recordId: existing.id,
      changes: mapRecordFields(record, target.fieldIdMap),
    }))
    const recordId = updated && updated.id ? updated.id : existing.id
    rememberWrittenRow(keyIndex, key, recordId)
    return { status: 'updated', recordId }
  }

  const created = await callRecordsApi('createRecord', () => recordsApi.createRecord({
    sheetId: target.sheetId,
    data: mapRecordFields(record, target.fieldIdMap),
  }))
  const recordId = created && created.id
  rememberWrittenRow(keyIndex, key, recordId)
  return { status: 'created', recordId }
}

async function applyPatchDecision({ recordsApi, target, decision, humanFields, templateFields, keyIndex }) {
  const key = decisionKey(decision, target)
  let patch = copyPayload(decision.patch, 'decision.patch')
  assertNoHumanFields(patch, `${decision.decision} patch`, humanFields)
  patch = normalizePayloadForTemplate(patch, templateFields)

  const existing = await findExistingRecord(recordsApi, target, key, keyIndex)
  if (!existing || !existing.id) {
    throw new StockPreparationApplyWriterError(`${decision.decision} target row not found`, {
      code: 'target_row_not_found',
      decision: decision.decision,
    })
  }

  const updated = await callRecordsApi('patchRecord', () => recordsApi.patchRecord({
    sheetId: target.sheetId,
    recordId: existing.id,
    changes: mapRecordFields(patch, target.fieldIdMap),
  }))
  const recordId = updated && updated.id ? updated.id : existing.id
  rememberWrittenRow(keyIndex, key, recordId)
  return { status: 'updated', recordId }
}

function incrementCounts(counts, decision, status) {
  if (decision === DECISIONS.ADD && status === 'created') counts.created += 1
  if (decision === DECISIONS.ADD && status === 'updated') counts.updated += 1
  if (decision === DECISIONS.UPDATE) counts.updated += 1
  if (decision === DECISIONS.INACTIVE) counts.inactive += 1
}

function errorCode(error) {
  return error && error.details && error.details.code
    ? error.details.code
    : classifyTargetWriteError(error)
}

function errorDetail(error, field) {
  return typeof (error && error.details && error.details[field]) === 'string' && error.details[field].trim()
    ? error.details[field].trim()
    : null
}

function errorOperation(error) {
  return errorDetail(error, 'operation')
}

function errorField(error) {
  return errorDetail(error, 'field')
}

function errorReason(error) {
  return errorDetail(error, 'reason')
}

function errorExpectedType(error) {
  return errorDetail(error, 'expectedType')
}

function sortedArray(set) {
  return Array.from(set).sort()
}

function valuesFreeSummarySetEntry(set) {
  const values = sortedArray(set)
  return values.length ? values : undefined
}

function compactSummary(entry) {
  const out = {
    code: entry.code,
    count: entry.count,
    decisions: sortedArray(entry.decisions),
    operations: sortedArray(entry.operations),
  }
  const fields = valuesFreeSummarySetEntry(entry.fields)
  const reasons = valuesFreeSummarySetEntry(entry.reasons)
  const expectedTypes = valuesFreeSummarySetEntry(entry.expectedTypes)
  if (fields) out.fields = fields
  if (reasons) out.reasons = reasons
  if (expectedTypes) out.expectedTypes = expectedTypes
  return out
}

function summarizeApplyErrors(errors = []) {
  const byCode = new Map()
  for (const entry of errors) {
    const code = optionalString(entry && entry.code) || 'apply_failed'
    const summary = byCode.get(code) || {
      code,
      count: 0,
      decisions: new Set(),
      operations: new Set(),
      fields: new Set(),
      reasons: new Set(),
      expectedTypes: new Set(),
    }
    summary.count += 1
    if (entry && entry.decision) summary.decisions.add(entry.decision)
    if (entry && entry.operation) summary.operations.add(entry.operation)
    if (entry && entry.field) summary.fields.add(entry.field)
    if (entry && entry.reason) summary.reasons.add(entry.reason)
    if (entry && entry.expectedType) summary.expectedTypes.add(entry.expectedType)
    byCode.set(code, summary)
  }
  return Array.from(byCode.values())
    .map(compactSummary)
    .sort((left, right) => left.code.localeCompare(right.code))
}

function applyStatus(counts, written) {
  if (counts.failed > 0) return written > 0 ? 'partial' : 'failed'
  if (counts.held > 0) return written > 0 ? 'partial' : 'held'
  return 'succeeded'
}

// SECURITY (FOS-4b-3): this is the single write chokepoint for stock-prep apply. The sandbox-only gate
// (assertStockPrepApplySandboxAllowed, sandbox-only first version) is enforced at BOTH of this function's
// callers BEFORE the write: applyStockPreparationAction (small-BOM, in-function) and the
// tableActionLargeBomApplyJobRun route (large-BOM, at the route). ANY new caller of this function MUST
// apply the same gate, or consolidate the gate here. Production apply = separate FOS-4b-3-prod owner gate.
async function applyStockPreparationPlan(input = {}) {
  const permission = requireApplyPermission(input.permission)
  const plan = normalizePlan(input.plan)
  const target = normalizeTarget(input.target)
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const recordsApi = getRecordsApi(input.recordsApi)
  // The human wall is ownership-aware (#5074 follow-up): with optional
  // installedFieldProperties it ALSO rejects a customer pack's `ext_` human columns
  // BY NAME, not merely by their absence from the frozen template. Omit the input
  // and this is byte-identical to the template-only wall it replaces. The wall only
  // ever GROWS — derivePackAwarePlmWritableFields is fail-closed, so an unclassified
  // pack column never leaves the wall and never becomes writable either.
  const humanFields = derivePackAwarePlmWritableFields({
    templateFields: template.fields,
    installedFieldProperties: input.installedFieldProperties,
  }).humanPreservedFieldIds
  const templateFields = fieldMapForTemplate(template)
  const counts = {
    created: 0,
    updated: 0,
    inactive: 0,
    skipped: 0,
    held: 0,
    failed: 0,
  }
  const results = []
  const errors = []

  // W8-4 (L1): ONE apply run = ONE metadata scope. This function is called once per chunk (the
  // large-BOM route advances exactly one chunk per HTTP request) and once per small-BOM apply, so
  // the scope opened here IS the "one apply request" boundary: inside it the host loads this
  // target sheet’s row, its field list and its plugin-scope assertion once instead of per row
  // (measured on 222: 2x `meta_fields` + 2x registry + 3x `meta_sheets` per created row, at
  // 47.07ms of server wall-clock per row). It changes NOTHING about the loop below — same order,
  // same per-row try/catch, same counts/results/errors — so `failed>0` still means "the other
  // rows were written anyway", the contract `terminalApplyStatus` folds into `partial`. The scope
  // is NOT a transaction and takes no lock; it ends when this call returns.
  const runDecisions = async () => {
    // W9: one lookup for the whole chunk instead of one per row. INSIDE the metadata scope on
    // purpose, so the batch query is served by the same memoized sheet row / field list the loop
    // uses. `null` = "index unavailable" and every lookup below goes back to the per-row query,
    // byte-identically to the code before this change.
    const keyIndex = await prefetchIdempotencyKeyIndex({ recordsApi, target, plan })
    for (let index = 0; index < plan.decisions.length; index += 1) {
      const decision = plan.decisions[index] || {}
      try {
        if (decision.decision === DECISIONS.SKIP) {
          counts.skipped += 1
          results.push({ index, decision: decision.decision, status: 'skipped' })
          continue
        }
        if (decision.decision === DECISIONS.MANUAL_CONFIRM) {
          counts.held += 1
          results.push({ index, decision: decision.decision, status: 'held' })
          continue
        }
        if (decision.decision === DECISIONS.ADD) {
          const applied = await applyAddDecision({ recordsApi, target, decision, humanFields, templateFields, keyIndex })
          incrementCounts(counts, decision.decision, applied.status)
          results.push({ index, decision: decision.decision, idempotencyKey: decisionKey(decision, target), ...applied })
          continue
        }
        if (decision.decision === DECISIONS.UPDATE || decision.decision === DECISIONS.INACTIVE) {
          const applied = await applyPatchDecision({ recordsApi, target, decision, humanFields, templateFields, keyIndex })
          incrementCounts(counts, decision.decision, applied.status)
          results.push({ index, decision: decision.decision, idempotencyKey: decisionKey(decision, target), ...applied })
          continue
        }
        throw new StockPreparationApplyWriterError(`unsupported decision: ${decision.decision}`, {
          code: 'unsupported_decision',
          decision: decision.decision,
        })
      } catch (error) {
        counts.failed += 1
        const code = errorCode(error)
        const operation = errorOperation(error)
        const field = errorField(error)
        const reason = errorReason(error)
        const expectedType = errorExpectedType(error)
        const errorEntry = {
          index,
          decision: decision.decision || null,
          code,
          operation,
          message: sanitizeTargetWriteMessage(code, operation),
        }
        if (field) errorEntry.field = field
        if (reason) errorEntry.reason = reason
        if (expectedType) errorEntry.expectedType = expectedType
        errors.push(errorEntry)
        results.push({
          index,
          decision: decision.decision || null,
          status: 'failed',
          code,
        })
      }
    }
  }

  // Absent on a host without the capability, and a no-op passthrough while the host-side flag is
  // off; either way the decisions run exactly as they did before.
  if (typeof recordsApi.withMetadataCache === 'function') {
    await recordsApi.withMetadataCache(runDecisions)
  } else {
    await runDecisions()
  }

  // The loop above now runs inside a HOST capability, so "it ran" is no longer visible from here.
  // A host whose `withMetadataCache` resolved without invoking the operation would produce
  // written=0 / errors=[] / status='succeeded', and the chunk runner would advance its checkpoint
  // past every decision in this chunk — a green lie that silently drops rows. The in-repo
  // implementation always invokes it, so this is unreachable today and costs one comparison;
  // it exists so that a future host cannot make skipping rows look like success.
  if (results.length !== plan.decisions.length) {
    throw new StockPreparationApplyWriterError(
      'metadata scope returned without running every decision',
      {
        code: 'metadata_scope_incomplete',
        expected: plan.decisions.length,
        actual: results.length,
      },
    )
  }

  const written = counts.created + counts.updated + counts.inactive
  const status = applyStatus(counts, written)
  return {
    ok: counts.failed === 0 && counts.held === 0,
    status,
    permission,
    target: {
      objectId: target.objectId,
      sheetId: target.sheetId,
      keyField: target.keyField,
    },
    written,
    counts,
    results,
    errors,
  }
}

function summarizeApplyResultForEvidence(result = {}) {
  const errors = Array.isArray(result.errors) ? result.errors : []
  return {
    ok: result.ok === true,
    status: optionalString(result.status) || 'unknown',
    written: Number(result.written || 0),
    counts: isPlainObject(result.counts) ? { ...result.counts } : {},
    resultStatuses: Array.isArray(result.results)
      ? Array.from(new Set(result.results.map((entry) => entry.status).filter(Boolean))).sort()
      : [],
    errorCodes: Array.from(new Set(errors.map((entry) => entry.code).filter(Boolean))).sort(),
    errorSummaries: summarizeApplyErrors(errors),
  }
}

module.exports = {
  APPLY_PERMISSIONS,
  StockPreparationApplyWriterError,
  applyStockPreparationPlan,
  summarizeApplyResultForEvidence,
  __internals: {
    assertNoHumanFields,
    decisionKey,
    findExistingRecord,
    applyStatus,
    classifyTargetWriteError,
    fieldIdMapHasExplicitBindings,
    mapFieldName,
    mapRecordFields,
    normalizeTarget,
    requireApplyPermission,
    summarizeApplyErrors,
  },
}
