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
      fields,
      fieldNames: new Set(fields.map((field) => field.name)),
      keyFields: Array.from(new Set(keyFields)),
      includeInternalFields: objectConfig.includeInternalFields === true,
      mode: normalizeWriteMode(objectConfig.mode, `config.objects.${objectId}.mode`),
    }
  }
  return objects
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

async function writeOne({ recordsApi, objectConfig, request, record, index }) {
  const data = projectRecordForWrite(record, objectConfig)
  const keyFields = resolvedKeyFields(request, objectConfig)
  const mode = objectConfig.mode === 'append' || keyFields.length === 0 ? 'append' : 'upsert'
  const key = keyForRecord(data, keyFields) || keyForRecord(record, request.keyFields) || String(index)

  if (mode === 'upsert') assertKeyValues(data, keyFields, index)

  if (mode === 'upsert') {
    if (typeof recordsApi.queryRecords !== 'function' || typeof recordsApi.patchRecord !== 'function') {
      throw new AdapterValidationError('MetaSheet multitable keyed upsert requires queryRecords() and patchRecord()', {
        field: 'context.api.multitable.records',
      })
    }
    const existing = await findExistingRecord(recordsApi, objectConfig, data, keyFields)
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

module.exports = {
  createMetaSheetMultitableTargetAdapter,
  createMetaSheetMultitableTargetAdapterFactory,
  __internals: {
    normalizeObjects,
    normalizeFields,
    projectRecordForWrite,
    resolvedKeyFields,
  },
}
