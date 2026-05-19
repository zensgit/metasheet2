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
const { listStagingDescriptors } = require('../staging-installer.cjs')

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

function descriptorFieldsForObject(objectId) {
  const descriptor = listStagingDescriptors().find((item) => item.id === objectId)
  if (!descriptor) return []
  return Array.isArray(descriptor.fieldDetails) && descriptor.fieldDetails.length > 0
    ? descriptor.fieldDetails
    : descriptor.fields || []
}

function normalizeFields(config = {}, objectId = null) {
  const detailed = Array.isArray(config.fieldDetails) ? config.fieldDetails : null
  const fields = detailed || (Array.isArray(config.fields) ? config.fields : [])
  const fallbackFields = fields.length > 0 ? fields : descriptorFieldsForObject(objectId)
  return fallbackFields.map(normalizeField)
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
  const configProjectId = optionalString(config.projectId)
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
      projectId: optionalString(objectConfig.projectId) || configProjectId,
      fields: normalizeFields(objectConfig, objectId),
      fieldIdMap: normalizeFieldIdMap(objectConfig.fieldIdMap, `config.objects.${objectId}.fieldIdMap`),
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

function getProvisioningApi(context) {
  return context && context.api && context.api.multitable && context.api.multitable.provisioning
    ? context.api.multitable.provisioning
    : null
}

function logicalFieldNames(objectConfig) {
  return Array.from(new Set((objectConfig.fields || [])
    .map((field) => optionalString(field && field.name))
    .filter(Boolean)))
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

function invertFieldIdMap(fieldIdMap = {}) {
  const aliases = {}
  for (const [logicalField, physicalField] of Object.entries(fieldIdMap)) {
    const logical = optionalString(logicalField)
    const physical = optionalString(physicalField)
    if (logical && physical && logical !== physical) aliases[physical] = logical
  }
  return aliases
}

function applyLogicalFieldAliases(data, physicalToLogical = {}) {
  if (!isPlainObject(data)) return data
  const normalized = { ...data }
  for (const [physicalField, logicalField] of Object.entries(physicalToLogical)) {
    if (
      Object.prototype.hasOwnProperty.call(normalized, physicalField) &&
      !Object.prototype.hasOwnProperty.call(normalized, logicalField)
    ) {
      normalized[logicalField] = normalized[physicalField]
    }
  }
  return normalized
}

function parseOffsetCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return 0
  const numeric = Number(cursor)
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new AdapterValidationError('cursor must be a non-negative offset', { field: 'cursor' })
  }
  return numeric
}

function recordData(row, sheetId, physicalToLogical = {}) {
  if (isPlainObject(row && row.data)) {
    return {
      ...applyLogicalFieldAliases(row.data, physicalToLogical),
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
  const fieldAliasCache = new Map()

  function getObjectConfig(object) {
    const objectConfig = objects[object]
    if (!objectConfig) {
      throw new AdapterValidationError(`MetaSheet staging object is not configured: ${object}`, { object })
    }
    return objectConfig
  }

  async function fieldAliasesForObject(objectConfig) {
    if (fieldAliasCache.has(objectConfig.objectId)) return fieldAliasCache.get(objectConfig.objectId)
    const resolved = {
      ...objectConfig.fieldIdMap,
      ...await resolveProvisionedFieldIdMap(context, objectConfig),
    }
    const aliases = invertFieldIdMap(resolved)
    fieldAliasCache.set(objectConfig.objectId, aliases)
    return aliases
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
      const physicalToLogical = await fieldAliasesForObject(objectConfig)
      const records = Array.isArray(rows) ? rows.map((row) => recordData(row, objectConfig.sheetId, physicalToLogical)) : []
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
    descriptorFieldsForObject,
    normalizeFieldIdMap,
    invertFieldIdMap,
    applyLogicalFieldAliases,
    parseOffsetCursor,
    recordData,
  },
}
