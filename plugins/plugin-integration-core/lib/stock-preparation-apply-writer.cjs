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
const { DECISIONS } = require('./stock-preparation-conflict-planner.cjs')

const APPLY_PERMISSIONS = Object.freeze(['write', 'admin'])

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

function mapFieldName(field, fieldIdMap = {}) {
  return fieldIdMap[field] || field
}

function mapRecordFields(record, fieldIdMap = {}) {
  const out = {}
  for (const [field, value] of Object.entries(record || {})) {
    out[mapFieldName(field, fieldIdMap)] = value
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

async function findExistingRecord(recordsApi, target, key) {
  const physicalKey = mapFieldName(target.keyField, target.fieldIdMap)
  const records = await recordsApi.queryRecords({
    sheetId: target.sheetId,
    filters: { [physicalKey]: key },
    limit: 2,
    offset: 0,
  })
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

async function applyAddDecision({ recordsApi, target, decision, humanFields }) {
  const key = decisionKey(decision, target)
  const record = copyPayload(decision.record, 'decision.record')
  if (!Object.prototype.hasOwnProperty.call(record, target.keyField)) record[target.keyField] = key
  assertNoHumanFields(record, 'add record', humanFields)

  const existing = await findExistingRecord(recordsApi, target, key)
  if (existing && existing.id) {
    const updated = await recordsApi.patchRecord({
      sheetId: target.sheetId,
      recordId: existing.id,
      changes: mapRecordFields(record, target.fieldIdMap),
    })
    return { status: 'updated', recordId: updated && updated.id ? updated.id : existing.id }
  }

  const created = await recordsApi.createRecord({
    sheetId: target.sheetId,
    data: mapRecordFields(record, target.fieldIdMap),
  })
  return { status: 'created', recordId: created && created.id }
}

async function applyPatchDecision({ recordsApi, target, decision, humanFields }) {
  const key = decisionKey(decision, target)
  const patch = copyPayload(decision.patch, 'decision.patch')
  assertNoHumanFields(patch, `${decision.decision} patch`, humanFields)

  const existing = await findExistingRecord(recordsApi, target, key)
  if (!existing || !existing.id) {
    throw new StockPreparationApplyWriterError(`${decision.decision} target row not found`, {
      code: 'target_row_not_found',
      decision: decision.decision,
    })
  }

  const updated = await recordsApi.patchRecord({
    sheetId: target.sheetId,
    recordId: existing.id,
    changes: mapRecordFields(patch, target.fieldIdMap),
  })
  return { status: 'updated', recordId: updated && updated.id ? updated.id : existing.id }
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
    : error && error.name
      ? error.name
      : 'apply_failed'
}

function applyStatus(counts, written) {
  if (counts.failed > 0) return written > 0 ? 'partial' : 'failed'
  if (counts.held > 0) return written > 0 ? 'partial' : 'held'
  return 'succeeded'
}

async function applyStockPreparationPlan(input = {}) {
  const permission = requireApplyPermission(input.permission)
  const plan = normalizePlan(input.plan)
  const target = normalizeTarget(input.target)
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const recordsApi = getRecordsApi(input.recordsApi)
  const humanFields = template.fields.filter((field) => field.ownership === 'human_preserved').map((field) => field.id)
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
        const applied = await applyAddDecision({ recordsApi, target, decision, humanFields })
        incrementCounts(counts, decision.decision, applied.status)
        results.push({ index, decision: decision.decision, idempotencyKey: decisionKey(decision, target), ...applied })
        continue
      }
      if (decision.decision === DECISIONS.UPDATE || decision.decision === DECISIONS.INACTIVE) {
        const applied = await applyPatchDecision({ recordsApi, target, decision, humanFields })
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
      errors.push({
        index,
        decision: decision.decision || null,
        code,
        message: error && error.message ? error.message : String(error),
      })
      results.push({
        index,
        decision: decision.decision || null,
        status: 'failed',
        code,
      })
    }
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
  return {
    ok: result.ok === true,
    status: optionalString(result.status) || 'unknown',
    written: Number(result.written || 0),
    counts: isPlainObject(result.counts) ? { ...result.counts } : {},
    resultStatuses: Array.isArray(result.results)
      ? Array.from(new Set(result.results.map((entry) => entry.status).filter(Boolean))).sort()
      : [],
    errorCodes: Array.isArray(result.errors)
      ? Array.from(new Set(result.errors.map((entry) => entry.code).filter(Boolean))).sort()
      : [],
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
    mapRecordFields,
    normalizeTarget,
    requireApplyPermission,
  },
}
