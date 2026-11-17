'use strict'

// ---------------------------------------------------------------------------
// ERP feedback writeback - plugin-integration-core
//
// Normalizes target adapter responses into user-visible staging fields. The
// write layer is deliberately injected so tests and non-multitable deployments
// can exercise the same semantics without coupling this module to K3 WISE or a
// live multitable runtime.
// ---------------------------------------------------------------------------

const {
  GOVERNED_SHEET_WRITE_CODES,
  StockPreparationGovernedSheetWriteError,
  assertProbeWiredFor,
  isStockPreparationNamespaceObjectId,
} = require('./stock-preparation-governed-sheet-probe.cjs')
const { MACHINE_WRITEBACK_FIELD_IDS } = require('./stock-preparation-templates.cjs')
const {
  MACHINE_COLUMN_WRITE_CODES,
  assertNoMachineKeyField,
  fenceVersionOf,
  isHostVersionConflict,
  machineColumnKeySet,
  omitMachineColumns,
  resolveRegisteredSheetMachineColumns,
} = require('./generic-writer-machine-columns.cjs')

// D2 (switch-on precondition for the YiDa issue-confirm write-back, register R-96): on a STOCK-PREP TARGET (a
// provisioning object id in the stock-prep namespace, or a sheet the governed-sheet probe reports as registered) the
// feedback writer never sends a machine write-back column (MACHINE_WRITEBACK_FIELD_IDS) — not on an update, not on a
// create (round 2, F1) — and the strip set includes the physical ids the REGISTERED sheet binds (round 2, F0;
// lib/generic-writer-machine-columns.cjs; an unresolvable binding refuses the write by its own reason). Each update
// carries `expectedVersion` (the version read). On the host's VERSION_CONFLICT the row is re-read by key and the
// stripped patch re-sent with the fresh version, at most FEEDBACK_FENCED_ATTEMPTS times in all (round 2, F2: an
// incremental pipeline advances its watermark past this run, so no later run is guaranteed to feed the row again);
// a row still conflicted after that is reported by the closed, retryable reason below. A row read without a usable
// version is its own, NOT retryable reason (round 2, F5). Every other target is byte-identical to before.
const ERP_FEEDBACK_VERSION_CONFLICT = 'ERP_FEEDBACK_VERSION_CONFLICT'
const ERP_FEEDBACK_VERSION_UNREADABLE = 'ERP_FEEDBACK_VERSION_UNREADABLE'
const ERP_FEEDBACK_MACHINE_COLUMNS_UNRESOLVED = 'ERP_FEEDBACK_MACHINE_COLUMNS_UNRESOLVED'
const FEEDBACK_FENCED_ATTEMPTS = 3

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

const TRUE_BOOLEAN_TEXT = new Set(['true', '1', 'yes', 'y', 'on', '是', '启用', '开启'])
const FALSE_BOOLEAN_TEXT = new Set(['false', '0', 'no', 'n', 'off', '否', '禁用', '关闭'])

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

function normalizeOptionalBoolean(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw new ErpFeedbackError(`${field} must be a boolean-like value`, { field, value })
    }
    if (value === 1) return true
    if (value === 0) return false
    throw new ErpFeedbackError(`${field} must be a boolean-like value`, { field, value })
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '') return undefined
    if (TRUE_BOOLEAN_TEXT.has(normalized)) return true
    if (FALSE_BOOLEAN_TEXT.has(normalized)) return false
  }
  throw new ErpFeedbackError(`${field} must be a boolean-like value`, { field, value })
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
  if (normalizeOptionalBoolean(normalizedOptions.enabled, 'erpFeedback.enabled') === false) return []
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

// Batch-refresh step 4 PR-6 (design §7.1 row 18, D-21; F-6): the feedback writer writes whatever sheet the
// provisioning resolves for the configured (projectId, objectId) — a stock-prep project sheet included. A sheet
// GOVERNED by the stock-preparation batch refresh is refused here, AFTER the sheet is resolved and BEFORE the field
// resolve and any records IO (one probe per writeBack). `governedSheetProbe` is injected by index.cjs, never
// request-supplied. Built WITHOUT a probe: an object id in the stock-prep namespace is refused 501 (the not-wired
// backstop), every other object writes exactly as before. No resolved sheet: nothing can be governed and the host
// refuses a write to no sheet on its own, so the probe is not asked (byte-identical to before PR-6).
// Returns the probe's answer for a sheet that is not governed (null when no probe was asked) — D2 reads its
// `registry.present` to recognise a registered stock-prep project sheet.
async function assertFeedbackSheetWritable({ governedSheetProbe, sheetId, tenantId, objectId }) {
  if (!assertProbeWiredFor({ governedSheetProbe, surface: 'erp_feedback', objectId })) return null
  if (sheetId === undefined || sheetId === null || sheetId === '') return null
  const answer = await governedSheetProbe.assertSheetWritable({ sheetId: String(sheetId), tenantId, surface: 'erp_feedback', objectId })
  return answer === undefined ? null : answer
}

// D2: a stock-prep target = a namespace object id, or a sheet the probe answered as registered.
function isStockPreparationMachineColumnTarget(objectId, answer) {
  if (isStockPreparationNamespaceObjectId(objectId)) return true
  return Boolean(answer && answer.registry && answer.registry.present === true)
}

/**
 * D2 round 2 (F2): the fenced update of one feedback row with a BOUNDED re-read. Sends the stripped patch with the
 * version read; on the host's VERSION_CONFLICT re-reads the row by its key and re-sends the SAME stripped patch with
 * the fresh version — safe, because the patch never carries a machine column — at most FEEDBACK_FENCED_ATTEMPTS times
 * in all. Answers 'patched' | 'conflicted' (still moving, or gone on the re-read: never created) | 'unreadable'.
 */
async function patchFeedbackRowFenced({ recordsApi, sheetId, physicalKeyField, key, existing, changes }) {
  let current = existing
  for (let attempt = 1; ; attempt += 1) {
    const expectedVersion = fenceVersionOf(current)
    if (expectedVersion === null) return 'unreadable'
    try {
      await recordsApi.patchRecord({ sheetId, recordId: current.id, changes, expectedVersion })
      return 'patched'
    } catch (error) {
      if (!isHostVersionConflict(error)) throw error
      if (attempt >= FEEDBACK_FENCED_ATTEMPTS) return 'conflicted'
    }
    current = await findRecordByKey(recordsApi, sheetId, physicalKeyField, key)
    if (!current || !current.id) return 'conflicted'
  }
}

// The feedback result's reason for a governance refusal (409 governed / 501 not wired) or a governance read that
// failed (503 / 501 store unavailable / 422); null for every other error (reported as before).
function governanceFeedbackReasonOf(error) {
  const typed = error instanceof StockPreparationGovernedSheetWriteError || (error && error.name === 'StockPreparationGovernedSheetWriteError')
  if (!typed || typeof error.code !== 'string') return null
  if (error.code === GOVERNED_SHEET_WRITE_CODES.REFUSED || error.code === GOVERNED_SHEET_WRITE_CODES.PROBE_UNWIRED) {
    return { reason: 'ERP_FEEDBACK_GOVERNED_SHEET_REFUSED', code: error.code }
  }
  return { reason: 'ERP_FEEDBACK_GOVERNANCE_UNREADABLE', code: error.code }
}

// D2 round 2 (F0): a stock-prep target whose machine columns could not be resolved, or whose lookup key IS one —
// refused before any records IO; reported by its own reason and the closed code.
function machineColumnFeedbackReasonOf(error) {
  if (!error || error.name !== 'GenericWriterMachineColumnError' || typeof error.code !== 'string') return null
  if (error.code === MACHINE_COLUMN_WRITE_CODES.UNRESOLVED || error.code === MACHINE_COLUMN_WRITE_CODES.KEY_REFUSED) {
    return { reason: ERP_FEEDBACK_MACHINE_COLUMNS_UNRESOLVED, code: error.code }
  }
  return null
}

function createMultitableFeedbackWriter({ context, governedSheetProbe } = {}) {
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
      // PR-6: a governed stock-prep sheet is refused before the field resolve and before any records IO.
      const governance = await assertFeedbackSheetWritable({ governedSheetProbe, sheetId, tenantId: normalizeString(input.tenantId), objectId })
      const machineTarget = isStockPreparationMachineColumnTarget(objectId, governance)
      const fieldIds = Array.from(new Set([
        keyField,
        ...updates.flatMap((update) => Object.keys(update.fields || {})),
        ...(machineTarget ? MACHINE_WRITEBACK_FIELD_IDS : []),
      ]))
      const fieldIdMap = await resolveFields(provisioning, projectId, objectId, fieldIds)
      // D2: the payload keys that name a machine column here — logical ids, their resolved physical ids, and (round 2,
      // F0) on a REGISTERED sheet the physical ids its registry binding resolves to (refused when it cannot be).
      let machineKeys = null
      if (machineTarget) {
        const physicalIds = MACHINE_WRITEBACK_FIELD_IDS.map((fieldId) => fieldIdMap[fieldId]).filter(Boolean)
        if (governance && governance.registry && governance.registry.present === true) {
          physicalIds.push(...await resolveRegisteredSheetMachineColumns({
            governedSheetProbe,
            provisioning,
            sheetId: String(sheetId),
            objectId,
            candidateTenantIds: [normalizeString(input.tenantId)],
            candidateProjectIds: [projectId],
          }))
        }
        machineKeys = machineColumnKeySet({ physicalIds, logicalToPhysical: fieldIdMap })
        assertNoMachineKeyField(machineKeys, [keyField], fieldIdMap, objectId)
      }
      let patched = 0
      let created = 0
      let conflicted = 0
      let unreadable = 0

      for (const update of updates) {
        const key = normalizeString(update.key)
        if (!key) continue
        const physicalKeyField = fieldIdMap[keyField] || keyField
        const physicalChanges = toPhysicalData(update.fields || {}, fieldIdMap)
        const existing = await findRecordByKey(recordsApi, sheetId, physicalKeyField, key)
        if (existing && existing.id && machineKeys) {
          const changes = omitMachineColumns(physicalChanges, machineKeys).data
          if (Object.keys(changes).length === 0) continue
          const outcome = await patchFeedbackRowFenced({ recordsApi, sheetId, physicalKeyField, key, existing, changes })
          if (outcome === 'patched') patched += 1
          else if (outcome === 'unreadable') unreadable += 1
          else conflicted += 1
          continue
        }
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
              // D2 round 2 (F1): a create on a stock-prep target carries no machine column.
              ...(machineKeys ? omitMachineColumns(physicalChanges, machineKeys).data : physicalChanges),
            },
          })
          created += 1
        }
      }

      return {
        ok: conflicted === 0 && unreadable === 0,
        sheetId,
        objectId,
        patched,
        created,
        written: patched + created,
        // D2: rows left unwritten (a stock-prep target only); absent when there were none. An unreadable version is
        // not retryable and outranks a conflict as the reason (round 2, F5).
        ...(conflicted > 0 ? { conflicted } : {}),
        ...(unreadable > 0 ? { unreadable } : {}),
        ...(unreadable > 0
          ? { reason: ERP_FEEDBACK_VERSION_UNREADABLE, retryable: false }
          : conflicted > 0 ? { reason: ERP_FEEDBACK_VERSION_CONFLICT, retryable: true } : {}),
      }
    },
  }
}

function createErpFeedbackWriter({ stagingWriter, context, logger, clock, governedSheetProbe } = {}) {
  const resolvedWriter = stagingWriter || createMultitableFeedbackWriter({ context, logger, governedSheetProbe })

  async function writeBack(input = {}) {
    const pipeline = input.pipeline || {}
    const options = normalizeFeedbackOptions(pipeline, input.options)
    const enabled = normalizeOptionalBoolean(options.enabled, 'erpFeedback.enabled')
    const failOnError = normalizeOptionalBoolean(options.failOnError, 'erpFeedback.failOnError') === true
    if (enabled === false) {
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
      // D2: rows left unwritten — a version still moving after the bounded re-read (retryable), or a version that
      // could not be read (not retryable). The runner keeps ok / reason only: an incremental run that advances its
      // watermark will NOT feed these rows again by itself (round 2, F2), so the reason is what an operator sees.
      const unreadableRows = result && Number.isInteger(result.unreadable) ? result.unreadable : 0
      const conflictedRows = result && Number.isInteger(result.conflicted) ? result.conflicted : 0
      if (unreadableRows > 0 || conflictedRows > 0) {
        const reason = unreadableRows > 0 ? ERP_FEEDBACK_VERSION_UNREADABLE : ERP_FEEDBACK_VERSION_CONFLICT
        const retryable = unreadableRows === 0
        if (failOnError) {
          throw new ErpFeedbackError(`${reason}: ${unreadableRows + conflictedRows} feedback row(s) were not written (${conflictedRows} still changing after ${FEEDBACK_FENCED_ATTEMPTS} fenced attempts, ${unreadableRows} read without a usable version)`, { reason, conflicted: conflictedRows, unreadable: unreadableRows, retryable })
        }
        return {
          ok: false,
          skipped: false,
          reason,
          retryable,
          projectId,
          objectId,
          keyField,
          items,
          result,
        }
      }
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
      if (failOnError) throw error
      // PR-6: a governance refusal / unreadable governance is reported by its own reason token and code (the
      // runner's run details carry `reason`); nothing was written. Every other failure is reported as before.
      const governance = governanceFeedbackReasonOf(error) || machineColumnFeedbackReasonOf(error)
      return {
        ok: false,
        skipped: false,
        reason: governance ? governance.reason : 'ERP_FEEDBACK_WRITE_FAILED',
        ...(governance ? { code: governance.code } : {}),
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
  ERP_FEEDBACK_VERSION_CONFLICT,
  ERP_FEEDBACK_VERSION_UNREADABLE,
  ERP_FEEDBACK_MACHINE_COLUMNS_UNRESOLVED,
  FEEDBACK_FENCED_ATTEMPTS,
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
