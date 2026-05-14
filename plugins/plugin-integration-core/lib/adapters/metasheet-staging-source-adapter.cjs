'use strict'

// ---------------------------------------------------------------------------
// MetaSheet staging source adapter - plugin-integration-core
//
// Reads rows from plugin-owned staging multitable sheets through the host
// multitable records API. This lets Data Factory dry-run `staging -> target`
// pipelines before an external PLM/SQL source is fully connected.
// ---------------------------------------------------------------------------

const {
  AdapterValidationError,
  createReadResult,
  normalizeExternalSystemForAdapter,
  normalizeReadRequest,
  unsupportedAdapterOperation,
} = require('../contracts.cjs')

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

function normalizeField(field) {
  if (typeof field === 'string') {
    return { name: field, label: field, type: 'string' }
  }
  if (!isPlainObject(field)) {
    throw new AdapterValidationError('staging field must be a string or object', { field: 'config.objects[].fields[]' })
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

function targetArrayToObjects(targets) {
  const objects = {}
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!isPlainObject(target)) continue
    const id = optionalString(target.id)
    const sheetId = optionalString(target.sheetId)
    if (!id || !sheetId) continue
    objects[id] = {
      name: optionalString(target.name) || id,
      sheetId,
      viewId: optionalString(target.viewId),
      baseId: optionalString(target.baseId),
      openLink: optionalString(target.openLink),
      fields: Array.isArray(target.fields) ? target.fields : [],
      fieldDetails: Array.isArray(target.fieldDetails) ? target.fieldDetails : undefined,
    }
  }
  return objects
}

function normalizeObjects(config = {}) {
  const rawObjects = isPlainObject(config.objects) ? config.objects : targetArrayToObjects(config.targets)
  const objects = {}
  for (const [objectId, objectConfig] of Object.entries(rawObjects)) {
    if (!isPlainObject(objectConfig)) {
      throw new AdapterValidationError(`config.objects.${objectId} must be an object`, {
        field: `config.objects.${objectId}`,
      })
    }
    const sheetId = requiredString(objectConfig.sheetId, `config.objects.${objectId}.sheetId`)
    const name = optionalString(objectConfig.name) || optionalString(objectConfig.label) || objectId
    objects[objectId] = {
      objectId,
      name,
      label: optionalString(objectConfig.label) || name,
      sheetId,
      viewId: optionalString(objectConfig.viewId),
      baseId: optionalString(objectConfig.baseId),
      openLink: optionalString(objectConfig.openLink),
      fields: normalizeFields(objectConfig),
    }
  }
  return objects
}

function getRecordsApi(context) {
  const recordsApi = context && context.api && context.api.multitable && context.api.multitable.records
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') {
    throw new AdapterValidationError('MetaSheet staging source requires context.api.multitable.records.queryRecords()', {
      field: 'context.api.multitable.records.queryRecords',
    })
  }
  return recordsApi
}

function parseOffsetCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return 0
  const numeric = Number(cursor)
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new AdapterValidationError('cursor must be a non-negative offset', { field: 'cursor' })
  }
  return numeric
}

function recordData(row, sheetId) {
  if (isPlainObject(row && row.data)) {
    return {
      ...row.data,
      _metaRecordId: row.id || null,
      _metaRecordVersion: Number.isInteger(row.version) ? row.version : null,
      _metaSheetId: row.sheetId || sheetId,
    }
  }
  if (isPlainObject(row)) return { ...row }
  return row
}

function createMetaSheetStagingSourceAdapter({ system, context } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const objects = normalizeObjects(normalizedSystem.config)

  function getObjectConfig(object) {
    const objectConfig = objects[object]
    if (!objectConfig) {
      throw new AdapterValidationError(`MetaSheet staging object is not configured: ${object}`, { object })
    }
    return objectConfig
  }

  return {
    async testConnection() {
      getRecordsApi(context)
      const objectCount = Object.keys(objects).length
      return {
        ok: objectCount > 0,
        status: objectCount > 0 ? 'connected' : 'misconfigured',
        connected: objectCount > 0,
        message: objectCount > 0
          ? `MetaSheet staging source ready (${objectCount} object${objectCount === 1 ? '' : 's'})`
          : 'MetaSheet staging source has no configured objects',
      }
    },

    async listObjects() {
      return Object.values(objects).map((objectConfig) => ({
        name: objectConfig.objectId,
        label: objectConfig.label,
        operations: ['read'],
        source: 'metasheet:staging',
        schema: objectConfig.fields,
        openLink: objectConfig.openLink || undefined,
      }))
    },

    async getSchema(input = {}) {
      const object = requiredString(input.object, 'object')
      const objectConfig = getObjectConfig(object)
      return {
        object,
        fields: objectConfig.fields,
        raw: {
          sheetId: objectConfig.sheetId,
          viewId: objectConfig.viewId,
          baseId: objectConfig.baseId,
          openLink: objectConfig.openLink,
        },
      }
    },

    async read(input = {}) {
      const request = normalizeReadRequest(input)
      const objectConfig = getObjectConfig(request.object)
      const recordsApi = getRecordsApi(context)
      const offset = parseOffsetCursor(request.cursor)
      const rows = await recordsApi.queryRecords({
        sheetId: objectConfig.sheetId,
        filters: request.filters,
        limit: request.limit,
        offset,
      })
      const records = Array.isArray(rows) ? rows.map((row) => recordData(row, objectConfig.sheetId)) : []
      const nextOffset = offset + records.length
      return createReadResult({
        records,
        nextCursor: records.length >= request.limit ? String(nextOffset) : null,
        done: records.length < request.limit,
        metadata: {
          object: request.object,
          sheetId: objectConfig.sheetId,
          offset,
          count: records.length,
        },
      })
    },

    upsert: unsupportedAdapterOperation(normalizedSystem.kind, 'upsert'),
  }
}

function createMetaSheetStagingSourceAdapterFactory({ context } = {}) {
  return ({ system }) => createMetaSheetStagingSourceAdapter({ system, context })
}

module.exports = {
  createMetaSheetStagingSourceAdapter,
  createMetaSheetStagingSourceAdapterFactory,
  __internals: {
    normalizeObjects,
    normalizeFields,
    parseOffsetCursor,
    recordData,
  },
}
