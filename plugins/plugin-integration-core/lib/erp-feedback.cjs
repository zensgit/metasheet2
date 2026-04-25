'use strict'

// ---------------------------------------------------------------------------
// ERP feedback writeback - plugin-integration-core
//
// Normalizes target adapter responses into user-visible staging fields. The
// write layer is deliberately injected so tests and non-multitable deployments
// can exercise the same semantics without coupling this module to K3 WISE or a
// live multitable runtime.
// ---------------------------------------------------------------------------

const DEFAULT_FIELD_MAP = Object.freeze({
  status: 'erpSyncStatus',
  externalId: 'erpExternalId',
  billNo: 'erpBillNo',
  responseCode: 'erpResponseCode',
  responseMessage: 'erpResponseMessage',
  syncedAt: 'lastSyncedAt',
})

const DEFAULT_OBJECT_BY_TARGET = Object.freeze({
  material: 'standard_materials',
  materials: 'standard_materials',
  bd_material: 'standard_materials',
  k3_material: 'standard_materials',
  bom: 'bom_cleanse',
  bd_bom: 'bom_cleanse',
  k3_bom: 'bom_cleanse',
})

class ErpFeedbackError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ErpFeedbackError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function objectOrEmpty(value) {
  return isPlainObject(value) ? { ...value } : {}
}

function normalizeString(value) {
  if (value === undefined || value === null || value === '') return null
  return String(value)
}

function nowIso(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value).toISOString()
  return String(value)
}

function getPath(value, path) {
  if (!path) return undefined
  return String(path).split('.').reduce((current, key) => {
    if (current === undefined || current === null) return undefined
    return current[key]
  }, value)
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function mergeFieldMap(options = {}) {
  return {
    ...DEFAULT_FIELD_MAP,
    ...objectOrEmpty(options.fieldMap),
  }
}

function resolveFeedbackObject(pipeline = {}, options = {}) {
  const explicit = firstDefined(
    options.objectId,
    options.stagingObjectId,
    pipeline.stagingObjectId,
    pipeline.options && pipeline.options.erpFeedback && pipeline.options.erpFeedback.objectId,
    pipeline.options && pipeline.options.erpFeedback && pipeline.options.erpFeedback.stagingObjectId,
  )
  if (explicit) return String(explicit)
  const targetObject = normalizeString(pipeline.targetObject)
  if (!targetObject) return null
  return DEFAULT_OBJECT_BY_TARGET[targetObject.toLowerCase()] || pipeline.stagingSheetId || null
}

function resolveProjectId(pipeline = {}, options = {}) {
  return firstDefined(
    options.projectId,
    pipeline.projectId,
    pipeline.options && pipeline.options.erpFeedback && pipeline.options.erpFeedback.projectId,
  )
}

function resolveKeyField(pipeline = {}, options = {}) {
  return normalizeString(firstDefined(
    options.keyField,
    pipeline.options && pipeline.options.erpFeedback && pipeline.options.erpFeedback.keyField,
    '_integration_idempotency_key',
  ))
}

function normalizeFeedbackOptions(pipeline = {}, options = {}) {
  const pipelineOptions = objectOrEmpty(pipeline.options && pipeline.options.erpFeedback)
  return {
    ...pipelineOptions,
    ...objectOrEmpty(options),
    fieldMap: {
      ...objectOrEmpty(pipelineOptions.fieldMap),
      ...objectOrEmpty(options.fieldMap),
    },
  }
}

function recordAt(cleanRecords, index) {
  if (!Array.isArray(cleanRecords)) return null
  if (Number.isInteger(index) && index >= 0 && index < cleanRecords.length) return cleanRecords[index]
  return null
}

function valueForField(record, field) {
  if (!isPlainObject(record) || !field) return undefined
  if (record[field] !== undefined && record[field] !== null && record[field] !== '') return record[field]
  return getPath(record, field)
}

function feedbackKey({ targetRecord = {}, outcome = {}, keyField } = {}) {
  return normalizeString(firstDefined(
    valueForField(targetRecord, keyField),
    valueForField(outcome, keyField),
    outcome.idempotencyKey,
    outcome.key,
    targetRecord._integration_idempotency_key,
    targetRecord.idempotencyKey,
    targetRecord.FNumber,
    targetRecord.code,
  ))
}

function findRecordForOutcome(cleanRecords, outcome = {}, fallbackIndex = null, keyField = null) {
  const candidates = [
    valueForField(outcome, keyField),
    outcome.idempotencyKey,
    outcome.key,
    outcome.record && outcome.record._integration_idempotency_key,
    outcome.record && outcome.record.idempotencyKey,
  ].filter((value) => value !== undefined && value !== null && value !== '')
  if (!Array.isArray(cleanRecords)) return null
  const hasExplicitIndex = Number.isInteger(outcome.index)
  const explicitIndex = hasExplicitIndex ? outcome.index : fallbackIndex
  if (candidates.length === 0) return recordAt(cleanRecords, explicitIndex)
  const byKey = cleanRecords.find((item) => {
    const target = item && item.targetRecord ? item.targetRecord : {}
    return candidates.includes(valueForField(target, keyField)) ||
      candidates.includes(target._integration_idempotency_key) ||
      candidates.includes(target.idempotencyKey) ||
      candidates.includes(target.FNumber) ||
      candidates.includes(target.code)
  })
  if (byKey) return byKey
  return hasExplicitIndex ? recordAt(cleanRecords, outcome.index) : null
}

function extractExternalId(outcome = {}, raw = undefined) {
  return normalizeString(firstDefined(
    outcome.erpMaterialId,
    outcome.erpExternalId,
    outcome.externalId,
    outcome.materialId,
    outcome.itemId,
    outcome.FItemID,
    outcome.id,
    getPath(raw, 'Result.Id'),
    getPath(raw, 'Result.ResponseStatus.SuccessEntitys.0.Id'),
  ))
}

function extractBillNo(outcome = {}, raw = undefined) {
  return normalizeString(firstDefined(
    outcome.erpBillNo,
    outcome.billNo,
    outcome.billNumber,
    outcome.number,
    outcome.FBillNo,
    getPath(raw, 'billNo'),
    getPath(raw, 'BillNo'),
    getPath(raw, 'Result.Number'),
    getPath(raw, 'Result.ResponseStatus.SuccessEntitys.0.Number'),
  ))
}

function extractResponseCode(outcome = {}, fallback) {
  return normalizeString(firstDefined(
    outcome.responseCode,
    outcome.code,
    outcome.errorCode,
    fallback,
  ))
}

function extractMessage(outcome = {}, fallback) {
  return normalizeString(firstDefined(
    outcome.responseMessage,
    outcome.message,
    outcome.errorMessage,
    outcome.status,
    fallback,
  ))
}

function buildFeedbackFields({ status, outcome = {}, raw, fieldMap, syncedAt }) {
  const fields = {}
  fields[fieldMap.status] = status
  fields[fieldMap.externalId] = status === 'synced' ? extractExternalId(outcome, raw) : null
  fields[fieldMap.billNo] = status === 'synced' ? extractBillNo(outcome, raw) : null
  fields[fieldMap.responseCode] = extractResponseCode(outcome, status === 'synced' ? 'OK' : 'ERROR')
  fields[fieldMap.responseMessage] = extractMessage(outcome, status === 'synced' ? 'ERP write succeeded' : 'ERP write failed')
  fields[fieldMap.syncedAt] = syncedAt
  return fields
}

function normalizeFeedbackItems({ writeResult = {}, cleanRecords = [], pipeline = {}, options = {}, clock } = {}) {
  const normalizedOptions = normalizeFeedbackOptions(pipeline, options)
  if (normalizedOptions.enabled === false) return []
  const fieldMap = mergeFieldMap(normalizedOptions)
  const keyField = resolveKeyField(pipeline, normalizedOptions)
  const syncedAt = normalizeString(normalizedOptions.syncedAt) || nowIso(clock)
  const items = []
  const seen = new Set()

  const successResults = Array.isArray(writeResult.results) ? writeResult.results : []
  for (let index = 0; index < successResults.length; index += 1) {
    const outcome = isPlainObject(successResults[index]) ? successResults[index] : { value: successResults[index] }
    const matched = findRecordForOutcome(cleanRecords, outcome, index, keyField)
    if (!matched && !isPlainObject(outcome.record)) continue
    const targetRecord = matched && matched.targetRecord ? matched.targetRecord : objectOrEmpty(outcome.record)
    const key = feedbackKey({ targetRecord, outcome, keyField })
    if (!key || seen.has(key)) continue
    seen.add(key)
    items.push({
      key,
      status: 'synced',
      source: 'result',
      sourceRecord: matched && matched.sourceRecord ? matched.sourceRecord : null,
      targetRecord,
      fields: buildFeedbackFields({
        status: 'synced',
        outcome,
        raw: outcome.raw || writeResult.raw,
        fieldMap,
        syncedAt,
      }),
    })
  }

  const errors = Array.isArray(writeResult.errors) ? writeResult.errors : []
  for (let index = 0; index < errors.length; index += 1) {
    const outcome = isPlainObject(errors[index]) ? errors[index] : { message: String(errors[index]) }
    const matched = findRecordForOutcome(cleanRecords, outcome, index, keyField)
    if (!matched && !isPlainObject(outcome.record)) continue
    const targetRecord = matched && matched.targetRecord ? matched.targetRecord : objectOrEmpty(outcome.record)
    const key = feedbackKey({ targetRecord, outcome, keyField })
    if (!key || seen.has(key)) continue
    seen.add(key)
    items.push({
      key,
      status: 'failed',
      source: 'error',
      sourceRecord: matched && matched.sourceRecord ? matched.sourceRecord : null,
      targetRecord,
      fields: buildFeedbackFields({
        status: 'failed',
        outcome,
        raw: outcome.raw || writeResult.raw,
        fieldMap,
        syncedAt,
      }),
    })
  }

  return items
}

async function resolveObjectSheetId(provisioning, projectId, objectId) {
  if (typeof provisioning.findObjectSheet === 'function') {
    const sheet = await provisioning.findObjectSheet({ projectId, objectId })
    if (sheet && sheet.id) return sheet.id
  }
  if (typeof provisioning.getObjectSheetId === 'function') {
    return provisioning.getObjectSheetId(projectId, objectId)
  }
  throw new ErpFeedbackError('multitable object resolver is not available', { objectId })
}

async function resolveFields(provisioning, projectId, objectId, fieldIds) {
  if (typeof provisioning.resolveFieldIds === 'function') {
    return provisioning.resolveFieldIds({ projectId, objectId, fieldIds })
  }
  if (typeof provisioning.getFieldId === 'function') {
    const resolved = {}
    for (const fieldId of fieldIds) resolved[fieldId] = provisioning.getFieldId(projectId, objectId, fieldId)
    return resolved
  }
  return Object.fromEntries(fieldIds.map((fieldId) => [fieldId, fieldId]))
}

function toPhysicalData(logicalData, fieldIdMap) {
  const physical = {}
  for (const [logicalField, value] of Object.entries(logicalData)) {
    physical[fieldIdMap[logicalField] || logicalField] = value
  }
  return physical
}

async function findRecordByKey(recordsApi, sheetId, physicalKeyField, key) {
  const records = await recordsApi.queryRecords({
    sheetId,
    filters: { [physicalKeyField]: key },
    limit: 1,
  })
  if (Array.isArray(records) && records.length > 0) return records[0]
  return null
}

function createMultitableFeedbackWriter({ context } = {}) {
  const multitable = context && context.api && context.api.multitable
  const provisioning = multitable && multitable.provisioning
  const recordsApi = multitable && multitable.records
  if (!provisioning || !recordsApi) return null
  if (
    typeof recordsApi.queryRecords !== 'function' ||
    typeof recordsApi.patchRecord !== 'function' ||
    typeof recordsApi.createRecord !== 'function'
  ) {
    return null
  }

  return {
    async updateRecords(input = {}) {
      const projectId = normalizeString(input.projectId)
      const objectId = normalizeString(input.objectId)
      const keyField = normalizeString(input.keyField)
      const updates = Array.isArray(input.updates) ? input.updates : []
      if (!projectId || !objectId || !keyField) {
        throw new ErpFeedbackError('projectId, objectId, and keyField are required for multitable feedback writeback', {
          projectId,
          objectId,
          keyField,
        })
      }

      const sheetId = await resolveObjectSheetId(provisioning, projectId, objectId)
      const fieldIds = Array.from(new Set([
        keyField,
        ...updates.flatMap((update) => Object.keys(update.fields || {})),
      ]))
      const fieldIdMap = await resolveFields(provisioning, projectId, objectId, fieldIds)
      let patched = 0
      let created = 0

      for (const update of updates) {
        const key = normalizeString(update.key)
        if (!key) continue
        const physicalKeyField = fieldIdMap[keyField] || keyField
        const physicalChanges = toPhysicalData(update.fields || {}, fieldIdMap)
        const existing = await findRecordByKey(recordsApi, sheetId, physicalKeyField, key)
        if (existing && existing.id) {
          await recordsApi.patchRecord({
            sheetId,
            recordId: existing.id,
            changes: physicalChanges,
          })
          patched += 1
        } else {
          await recordsApi.createRecord({
            sheetId,
            data: {
              [physicalKeyField]: key,
              ...physicalChanges,
            },
          })
          created += 1
        }
      }

      return {
        ok: true,
        sheetId,
        objectId,
        patched,
        created,
        written: patched + created,
      }
    },
  }
}

function createErpFeedbackWriter({ stagingWriter, context, logger, clock } = {}) {
  const resolvedWriter = stagingWriter || createMultitableFeedbackWriter({ context, logger })

  async function writeBack(input = {}) {
    const pipeline = input.pipeline || {}
    const options = normalizeFeedbackOptions(pipeline, input.options)
    if (options.enabled === false) {
      return { ok: true, skipped: true, reason: 'ERP_FEEDBACK_DISABLED', items: [] }
    }

    const items = normalizeFeedbackItems({
      writeResult: input.writeResult,
      cleanRecords: input.cleanRecords,
      pipeline,
      options,
      clock,
    })
    if (items.length === 0) {
      return { ok: true, skipped: true, reason: 'ERP_FEEDBACK_NO_ITEMS', items }
    }

    const projectId = resolveProjectId(pipeline, options)
    const objectId = resolveFeedbackObject(pipeline, options)
    const keyField = resolveKeyField(pipeline, options)
    if (!projectId || !objectId || !keyField) {
      return {
        ok: true,
        skipped: true,
        reason: 'ERP_FEEDBACK_TARGET_MISSING',
        projectId: projectId || null,
        objectId: objectId || null,
        keyField: keyField || null,
        items,
      }
    }

    if (!resolvedWriter || typeof resolvedWriter.updateRecords !== 'function') {
      return {
        ok: true,
        skipped: true,
        reason: 'ERP_FEEDBACK_WRITER_MISSING',
        projectId,
        objectId,
        keyField,
        items,
      }
    }

    try {
      const result = await resolvedWriter.updateRecords({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        pipelineId: pipeline.id,
        projectId,
        objectId,
        keyField,
        updates: items.map((item) => ({
          key: item.key,
          fields: item.fields,
          status: item.status,
          source: item.source,
        })),
      })
      return {
        ok: true,
        skipped: false,
        projectId,
        objectId,
        keyField,
        items,
        result,
      }
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[plugin-integration-core] ERP feedback writeback failed: ${error && error.message ? error.message : error}`)
      }
      if (options.failOnError === true) throw error
      return {
        ok: false,
        skipped: false,
        reason: 'ERP_FEEDBACK_WRITE_FAILED',
        projectId,
        objectId,
        keyField,
        items,
        error: error && error.message ? error.message : String(error),
      }
    }
  }

  return {
    writeBack,
    normalizeFeedbackItems,
  }
}

module.exports = {
  DEFAULT_FIELD_MAP,
  DEFAULT_OBJECT_BY_TARGET,
  ErpFeedbackError,
  createErpFeedbackWriter,
  createMultitableFeedbackWriter,
  normalizeFeedbackItems,
  __internals: {
    buildFeedbackFields,
    extractBillNo,
    extractExternalId,
    resolveFeedbackObject,
    resolveKeyField,
    resolveProjectId,
  },
}
