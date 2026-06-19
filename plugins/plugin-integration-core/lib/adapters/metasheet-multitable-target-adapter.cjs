'use strict'

// ---------------------------------------------------------------------------
// MetaSheet multitable target adapter - plugin-integration-core
//
// Writes cleaned pipeline records into plugin-scoped MetaSheet multitables.
// This is intentionally target-only: another adapter may read staging sheets,
// while this one lets Data Factory materialize cleansed outputs into a second
// table without calling an external ERP/CRM/PLM endpoint.
// ---------------------------------------------------------------------------

const {
  AdapterValidationError,
  createUpsertResult,
  normalizeExternalSystemForAdapter,
  normalizeUpsertRequest,
  unsupportedAdapterOperation,
} = require('../contracts.cjs')

const INTERNAL_FIELD_PREFIX = '_integration_'

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdapterValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeStringArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new AdapterValidationError(`${field} must be an array`, { field })
  }
  return value.map((item, index) => requiredString(item, `${field}[${index}]`))
}

function normalizeFieldIdMap(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new AdapterValidationError(`${field} must be an object`, { field })
  }
  const normalized = {}
  for (const [logicalField, physicalField] of Object.entries(value)) {
    const logical = optionalString(logicalField)
    const physical = optionalString(physicalField)
    if (logical && physical) normalized[logical] = physical
  }
  return normalized
}

function normalizeField(field) {
  if (typeof field === 'string') {
    return { name: field, label: field, type: 'string' }
  }
  if (!isPlainObject(field)) {
    throw new AdapterValidationError('multitable target field must be a string or object', {
      field: 'config.objects[].fields[]',
    })
  }
  const name = requiredString(field.id || field.name, 'field.name')
  return {
    name,
    label: optionalString(field.name) || optionalString(field.label) || name,
    type: optionalString(field.type) || 'string',
    ...(Array.isArray(field.options) ? { options: field.options.map(String) } : {}),
  }
}

function normalizeFields(config = {}) {
  const detailed = Array.isArray(config.fieldDetails) ? config.fieldDetails : null
  const fields = detailed || (Array.isArray(config.fields) ? config.fields : [])
  return fields.map(normalizeField)
}

function normalizeWriteMode(value, field) {
  const normalized = optionalString(value) || 'upsert'
  if (!['append', 'upsert'].includes(normalized)) {
    throw new AdapterValidationError(`${field} must be append or upsert`, { field })
  }
  return normalized
}

function normalizeObjects(config = {}) {
  const rawObjects = isPlainObject(config.objects) ? config.objects : {}
  const objects = {}
  const configProjectId = optionalString(config.projectId)
  for (const [objectId, objectConfig] of Object.entries(rawObjects)) {
    if (!isPlainObject(objectConfig)) {
      throw new AdapterValidationError(`config.objects.${objectId} must be an object`, {
        field: `config.objects.${objectId}`,
      })
    }
    const fields = normalizeFields(objectConfig)
    const keyFields = [
      ...normalizeStringArray(objectConfig.keyFields, `config.objects.${objectId}.keyFields`),
      ...(optionalString(objectConfig.keyField) ? [optionalString(objectConfig.keyField)] : []),
    ]
    const name = optionalString(objectConfig.name) || optionalString(objectConfig.label) || objectId
    objects[objectId] = {
      objectId,
      name,
      label: optionalString(objectConfig.label) || name,
      sheetId: requiredString(objectConfig.sheetId, `config.objects.${objectId}.sheetId`),
      viewId: optionalString(objectConfig.viewId),
      baseId: optionalString(objectConfig.baseId),
      openLink: optionalString(objectConfig.openLink),
      projectId: optionalString(objectConfig.projectId) || configProjectId,
      fields,
      fieldNames: new Set(fields.map((field) => field.name)),
      fieldIdMap: normalizeFieldIdMap(objectConfig.fieldIdMap, `config.objects.${objectId}.fieldIdMap`),
      keyFields: Array.from(new Set(keyFields)),
      includeInternalFields: objectConfig.includeInternalFields === true,
      mode: normalizeWriteMode(objectConfig.mode, `config.objects.${objectId}.mode`),
    }
  }
  return objects
}

function getProvisioningApi(context) {
  return context && context.api && context.api.multitable && context.api.multitable.provisioning
    ? context.api.multitable.provisioning
    : null
}

function getRecordsApi(context) {
  const recordsApi = context && context.api && context.api.multitable && context.api.multitable.records
  if (!recordsApi || typeof recordsApi.createRecord !== 'function') {
    throw new AdapterValidationError('MetaSheet multitable target requires context.api.multitable.records.createRecord()', {
      field: 'context.api.multitable.records.createRecord',
    })
  }
  return recordsApi
}

function getObjectConfig(objects, object) {
  const objectConfig = objects[object]
  if (!objectConfig) {
    throw new AdapterValidationError(`MetaSheet multitable target object is not configured: ${object}`, { object })
  }
  return objectConfig
}

function shouldWriteField(field, objectConfig) {
  if (!objectConfig.includeInternalFields && field.startsWith(INTERNAL_FIELD_PREFIX)) return false
  if (objectConfig.fieldNames.size === 0) return true
  return objectConfig.fieldNames.has(field)
}

function projectRecordForWrite(record, objectConfig) {
  const data = {}
  for (const [field, value] of Object.entries(record)) {
    if (shouldWriteField(field, objectConfig)) data[field] = value
  }
  return data
}

function logicalFieldNames(objectConfig) {
  const fields = new Set()
  for (const field of objectConfig.fields || []) {
    const name = optionalString(field && field.name)
    if (name) fields.add(name)
  }
  for (const keyField of objectConfig.keyFields || []) {
    const name = optionalString(keyField)
    if (name) fields.add(name)
  }
  return Array.from(fields)
}

async function resolveProvisionedFieldIdMap(context, objectConfig) {
  const projectId = optionalString(objectConfig.projectId)
  const fieldIds = logicalFieldNames(objectConfig)
  if (!projectId || fieldIds.length === 0) return {}
  const provisioning = getProvisioningApi(context)
  if (!provisioning) return {}

  if (typeof provisioning.resolveFieldIds === 'function') {
    return provisioning.resolveFieldIds({
      projectId,
      objectId: objectConfig.objectId,
      fieldIds,
    })
  }

  if (typeof provisioning.getFieldId === 'function') {
    const resolved = {}
    for (const fieldId of fieldIds) {
      const physical = provisioning.getFieldId(projectId, objectConfig.objectId, fieldId)
      if (physical) resolved[fieldId] = physical
    }
    return resolved
  }

  return {}
}

function mapLogicalFieldName(field, logicalToPhysical = {}) {
  return logicalToPhysical[field] || field
}

function mapRecordFieldsForWrite(record, logicalToPhysical = {}) {
  const mapped = {}
  for (const [field, value] of Object.entries(record)) {
    mapped[mapLogicalFieldName(field, logicalToPhysical)] = value
  }
  return mapped
}

function resolvedKeyFields(request, objectConfig) {
  const configured = objectConfig.keyFields.filter((field) => shouldWriteField(field, objectConfig))
  if (configured.length > 0) return configured
  return request.keyFields.filter((field) => shouldWriteField(field, objectConfig))
}

function keyForRecord(record, keyFields) {
  if (keyFields.length === 0) return null
  return keyFields.map((field) => `${field}=${String(record[field] ?? '')}`).join('|')
}

function assertKeyValues(record, keyFields, index) {
  for (const field of keyFields) {
    if (record[field] === undefined || record[field] === null || record[field] === '') {
      throw new AdapterValidationError(`records[${index}].${field} is required for multitable upsert`, {
        field,
        index,
      })
    }
  }
}

async function findExistingRecord(recordsApi, objectConfig, data, keyFields) {
  if (keyFields.length === 0 || typeof recordsApi.queryRecords !== 'function') return null
  const filters = {}
  for (const field of keyFields) filters[field] = data[field]
  const records = await recordsApi.queryRecords({
    sheetId: objectConfig.sheetId,
    filters,
    limit: 1,
    offset: 0,
  })
  return Array.isArray(records) && records.length > 0 ? records[0] : null
}

async function writeOne({ recordsApi, objectConfig, request, record, index, logicalToPhysical }) {
  const logicalData = projectRecordForWrite(record, objectConfig)
  const keyFields = resolvedKeyFields(request, objectConfig)
  const mode = objectConfig.mode === 'append' || keyFields.length === 0 ? 'append' : 'upsert'
  const key = keyForRecord(logicalData, keyFields) || keyForRecord(record, request.keyFields) || String(index)

  if (mode === 'upsert') assertKeyValues(logicalData, keyFields, index)
  const data = mapRecordFieldsForWrite(logicalData, logicalToPhysical)
  const physicalKeyFields = keyFields.map((field) => mapLogicalFieldName(field, logicalToPhysical))

  if (mode === 'upsert') {
    if (typeof recordsApi.queryRecords !== 'function' || typeof recordsApi.patchRecord !== 'function') {
      throw new AdapterValidationError('MetaSheet multitable keyed upsert requires queryRecords() and patchRecord()', {
        field: 'context.api.multitable.records',
      })
    }
    const existing = await findExistingRecord(recordsApi, objectConfig, data, physicalKeyFields)
    if (existing && existing.id) {
      const updated = await recordsApi.patchRecord({
        sheetId: objectConfig.sheetId,
        recordId: existing.id,
        changes: data,
      })
      return {
        index,
        status: 'updated',
        key,
        externalId: updated.id,
        recordId: updated.id,
        version: updated.version,
      }
    }
  }

  const created = await recordsApi.createRecord({
    sheetId: objectConfig.sheetId,
    data,
  })
  return {
    index,
    status: 'created',
    key,
    externalId: created.id,
    recordId: created.id,
    version: created.version,
  }
}

function createMetaSheetMultitableTargetAdapter({ system, context } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const objects = normalizeObjects(normalizedSystem.config)
  const fieldMapCache = new Map()

  async function fieldMapForObject(objectConfig) {
    if (fieldMapCache.has(objectConfig.objectId)) return fieldMapCache.get(objectConfig.objectId)
    const resolved = {
      ...objectConfig.fieldIdMap,
      ...await resolveProvisionedFieldIdMap(context, objectConfig),
    }
    fieldMapCache.set(objectConfig.objectId, resolved)
    return resolved
  }

  return {
    async testConnection() {
      const recordsApi = getRecordsApi(context)
      const objectCount = Object.keys(objects).length
      const supportsPatch = typeof recordsApi.patchRecord === 'function'
      const supportsQuery = typeof recordsApi.queryRecords === 'function'
      return {
        ok: objectCount > 0,
        status: objectCount > 0 ? 'connected' : 'misconfigured',
        connected: objectCount > 0,
        message: objectCount > 0
          ? `MetaSheet multitable target ready (${objectCount} object${objectCount === 1 ? '' : 's'})`
          : 'MetaSheet multitable target has no configured objects',
        capabilities: {
          createRecord: true,
          patchRecord: supportsPatch,
          queryRecords: supportsQuery,
        },
      }
    },

    async listObjects() {
      return Object.values(objects).map((objectConfig) => ({
        name: objectConfig.objectId,
        label: objectConfig.label,
        operations: ['upsert'],
        target: 'metasheet:multitable',
        schema: objectConfig.fields,
        openLink: objectConfig.openLink || undefined,
      }))
    },

    async getSchema(input = {}) {
      const object = requiredString(input.object, 'object')
      const objectConfig = getObjectConfig(objects, object)
      return {
        object,
        fields: objectConfig.fields,
        raw: {
          sheetId: objectConfig.sheetId,
          viewId: objectConfig.viewId,
          baseId: objectConfig.baseId,
          openLink: objectConfig.openLink,
          keyFields: objectConfig.keyFields,
          mode: objectConfig.mode,
        },
      }
    },

    read: unsupportedAdapterOperation(normalizedSystem.kind, 'read'),

    async previewUpsert(input = {}) {
      const request = normalizeUpsertRequest(input)
      const objectConfig = getObjectConfig(objects, request.object)
      const keyFields = resolvedKeyFields(request, objectConfig)
      return {
        records: request.records.map((record, index) => ({
          index,
          operation: objectConfig.mode === 'append' || keyFields.length === 0 ? 'create' : 'upsert',
          method: 'MULTITABLE',
          path: `/multitable/${objectConfig.sheetId}`,
          body: projectRecordForWrite(record, objectConfig),
          query: {},
        })),
      }
    },

    async upsert(input = {}) {
      const request = normalizeUpsertRequest(input)
      const objectConfig = getObjectConfig(objects, request.object)
      const recordsApi = getRecordsApi(context)
      const logicalToPhysical = await fieldMapForObject(objectConfig)
      const results = []
      const errors = []

      for (let index = 0; index < request.records.length; index += 1) {
        try {
          results.push(await writeOne({
            recordsApi,
            objectConfig,
            request,
            record: request.records[index],
            index,
            logicalToPhysical,
          }))
        } catch (error) {
          errors.push({
            index,
            code: error && error.name === 'AdapterValidationError'
              ? 'METASHEET_MULTITABLE_VALIDATION_FAILED'
              : 'METASHEET_MULTITABLE_WRITE_FAILED',
            message: error && error.message ? error.message : String(error),
            record: projectRecordForWrite(request.records[index], objectConfig),
          })
        }
      }

      return createUpsertResult({
        written: results.length,
        failed: errors.length,
        results,
        errors,
        metadata: {
          object: request.object,
          sheetId: objectConfig.sheetId,
          mode: objectConfig.mode,
        },
      })
    },
  }
}

function createMetaSheetMultitableTargetAdapterFactory({ context } = {}) {
  return ({ system }) => createMetaSheetMultitableTargetAdapter({ system, context })
}

// ---------------------------------------------------------------------------
// S1b-2: raw inward write-source + profile for the C6 safe-write lifecycle
//
// The C6 planner (external-write-dry-run.cjs) drives the FULL dry-run -> apply ->
// token -> revision-fence -> per-row -> dead-letter lifecycle and consumes a raw
// write-source (test/lookupByKey/insertRows/updateRows) + a target-write profile
// (the S1b-1 seam). This lets the OWN metasheet:multitable target ride the SAME
// safe lifecycle as data-source:sql-write-gated, writing ONLY to own plugin-scoped
// sheets (zero external write).
//
// NOTE: this write-source + profile ARE S1a's write contract. The earlier adapter-level
// `targetWriteLifecycle` (lookup/apply) method surface was RETIRED (S1a-retire) as
// orphaned — the C6 planner consumes the profile + raw source and produces its own
// values-free evidence, never an adapter `targetWriteLifecycle`. This file intentionally
// does NOT expose one: a write-performing apply outside the C6 lifecycle would be an
// ungated bypass of the token/revision gate.
// ---------------------------------------------------------------------------
const MULTITABLE_WRITE_TARGET_KIND = 'metasheet:multitable'

const MULTITABLE_WRITE_PROFILE = {
  kind: MULTITABLE_WRITE_TARGET_KIND,
  normalizeCapabilityState(result) {
    const state = result && result.capabilityState
    if (
      !state || typeof state !== 'object' ||
      typeof state.ownSheetTarget !== 'boolean' ||
      typeof state.externalWrite !== 'boolean'
    ) {
      throw new AdapterValidationError('metasheet:multitable write target capability state is unavailable', {
        field: 'capabilityState',
      })
    }
    return {
      success: result.success === true,
      ownSheetTarget: state.ownSheetTarget,
      externalWrite: state.externalWrite,
    }
  },
  assertSafeCapabilityState(state) {
    // Real safety property (not a rubber stamp): writes are scoped to OWN plugin sheets and
    // never reach an external system. A misconfigured target fails closed.
    if (state.ownSheetTarget !== true || state.externalWrite !== false) {
      throw new AdapterValidationError('metasheet:multitable write target is not own-sheet scoped', {
        field: 'capabilityState',
      })
    }
  },
}

function invertFieldMap(logicalToPhysical) {
  const out = {}
  for (const [logical, physical] of Object.entries(logicalToPhysical || {})) out[physical] = logical
  return out
}

function mapRecordFieldsToLogical(data, physicalToLogical) {
  const mapped = {}
  for (const [field, value] of Object.entries(data || {})) {
    mapped[physicalToLogical[field] || field] = value
  }
  return mapped
}

// Builds the raw inward write-source the C6 planner consumes (same shape as the host
// context.api.dataSourceWrites facade), backed by context.api.multitable.records over our
// own plugin sheets. Field names are mapped logical<->physical so the planner's value-diff
// classifier (logical) and the record store (physical) agree.
function createMetaSheetMultitableWriteSource({ system, context } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const objects = normalizeObjects(normalizedSystem.config)
  const fieldMapCache = new Map()

  async function fieldMapForObject(objectConfig) {
    if (fieldMapCache.has(objectConfig.objectId)) return fieldMapCache.get(objectConfig.objectId)
    const resolved = {
      ...objectConfig.fieldIdMap,
      ...await resolveProvisionedFieldIdMap(context, objectConfig),
    }
    fieldMapCache.set(objectConfig.objectId, resolved)
    return resolved
  }

  return {
    async test() {
      const recordsApi = context && context.api && context.api.multitable && context.api.multitable.records
      const ready = Boolean(
        recordsApi &&
        typeof recordsApi.createRecord === 'function' &&
        typeof recordsApi.queryRecords === 'function' &&
        typeof recordsApi.patchRecord === 'function' &&
        Object.keys(objects).length > 0,
      )
      // fail closed: a missing/partial records API or no configured objects -> success:false
      // -> the planner raises C6_WRITE_TARGET_TEST_FAILED before any write.
      return {
        success: ready,
        capabilityState: { ownSheetTarget: true, externalWrite: false },
      }
    },
    async lookupByKey(dataSourceId, object, key, policy, principal) {
      const recordsApi = getRecordsApi(context)
      const objectConfig = getObjectConfig(objects, object)
      const logicalToPhysical = await fieldMapForObject(objectConfig)
      const physicalToLogical = invertFieldMap(logicalToPhysical)
      const physicalKeyData = mapRecordFieldsForWrite(key || {}, logicalToPhysical)
      const physicalKeyFields = Object.keys(key || {}).map((field) => mapLogicalFieldName(field, logicalToPhysical))
      if (physicalKeyFields.length === 0 || typeof recordsApi.queryRecords !== 'function') {
        return { data: [], metadata: {} }
      }
      // IMPORTANT: fetch >1 (NOT the upsert helper's limit:1 findExistingRecord). MetaSheet
      // sheets do NOT enforce uniqueness on a logical key, so duplicate-key rows must surface
      // as multiple rows — that is what lets the C6 planner's ambiguity guard
      // (existingRows.length > 1 -> 'held'/ambiguous_target_key) fire instead of silently
      // updating one. Mirrors the SQL facade's deliberate limit:2.
      const filters = {}
      for (const field of physicalKeyFields) filters[field] = physicalKeyData[field]
      const matches = await recordsApi.queryRecords({ sheetId: objectConfig.sheetId, filters, limit: 2, offset: 0 })
      const list = Array.isArray(matches) ? matches : []
      // map each stored physical record back to logical so the planner's writableFields
      // value-diff compares like-for-like.
      return { data: list.map((record) => mapRecordFieldsToLogical(record.data || {}, physicalToLogical)), metadata: {} }
    },
    async insertRows(dataSourceId, object, rows, policy, principal) {
      const recordsApi = getRecordsApi(context)
      const objectConfig = getObjectConfig(objects, object)
      const logicalToPhysical = await fieldMapForObject(objectConfig)
      const created = []
      for (const row of rows) {
        const data = mapRecordFieldsForWrite(projectRecordForWrite(row, objectConfig), logicalToPhysical)
        created.push(await recordsApi.createRecord({ sheetId: objectConfig.sheetId, data }))
      }
      return { data: created, metadata: {} }
    },
    async updateRows(dataSourceId, object, rows, policy, principal) {
      const recordsApi = getRecordsApi(context)
      const objectConfig = getObjectConfig(objects, object)
      const logicalToPhysical = await fieldMapForObject(objectConfig)
      const keyFields = policy && Array.isArray(policy.keyFields) && policy.keyFields.length > 0
        ? policy.keyFields
        : objectConfig.keyFields
      let rowCount = 0
      for (const row of rows) {
        const physicalRow = mapRecordFieldsForWrite(projectRecordForWrite(row, objectConfig), logicalToPhysical)
        const physicalKeyFields = keyFields.map((field) => mapLogicalFieldName(field, logicalToPhysical))
        const existing = await findExistingRecord(recordsApi, objectConfig, physicalRow, physicalKeyFields)
        if (!existing || !existing.id) {
          throw new AdapterValidationError('metasheet:multitable update target row not found for key', { object })
        }
        await recordsApi.patchRecord({ sheetId: objectConfig.sheetId, recordId: existing.id, changes: physicalRow })
        rowCount += 1
      }
      return { rowCount, results: [] }
    },
  }
}

// S1b-3: derive the FLAT planner target config (what the C6 planner's normalizeTargetConfig
// expects) from the multitable object config + the pipeline's field mappings. object/keyFields
// come from the object config; writableFields are the MAPPED non-key targetFields (the fields
// actually present in the transformed record), intersected with the object's fields — so the
// planner's value-diff classify is idempotent. (Deriving writableFields from ALL object fields
// would compare an unmapped field as undefined-vs-stored and force perpetual 'update'.)
function deriveMultitablePlannerTargetConfig({ system, object, fieldMappings = [] } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const objects = normalizeObjects(normalizedSystem.config)
  const objectId = requiredString(object, 'object')
  const objectConfig = getObjectConfig(objects, objectId)
  const keyFields = objectConfig.keyFields
  if (keyFields.length === 0) {
    throw new AdapterValidationError('metasheet:multitable C6 write requires keyFields on the target object', { object: objectId })
  }
  const keySet = new Set(keyFields)
  const fieldNameSet = objectConfig.fieldNames
  const seen = new Set()
  const writableFields = []
  for (const mapping of Array.isArray(fieldMappings) ? fieldMappings : []) {
    const target = mapping && (mapping.targetField || mapping.target)
    if (typeof target !== 'string' || target.length === 0) continue
    if (keySet.has(target) || seen.has(target)) continue
    if (fieldNameSet.size > 0 && !fieldNameSet.has(target)) continue // only real sheet fields
    seen.add(target)
    writableFields.push(target)
  }
  if (writableFields.length === 0) {
    throw new AdapterValidationError('metasheet:multitable C6 write requires at least one mapped non-key writable field', { object: objectId })
  }
  return {
    dataSourceId: normalizedSystem.id || objectId, // opaque to the multitable write-source (it resolves object -> sheetId)
    object: objectId,
    keyFields,
    writableFields,
  }
}

module.exports = {
  MULTITABLE_WRITE_TARGET_KIND,
  MULTITABLE_WRITE_PROFILE,
  createMetaSheetMultitableWriteSource,
  deriveMultitablePlannerTargetConfig,
  createMetaSheetMultitableTargetAdapter,
  createMetaSheetMultitableTargetAdapterFactory,
  __internals: {
    normalizeObjects,
    normalizeFields,
    normalizeFieldIdMap,
    projectRecordForWrite,
    mapRecordFieldsForWrite,
    resolveProvisionedFieldIdMap,
    resolvedKeyFields,
  },
}
