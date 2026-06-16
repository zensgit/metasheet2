'use strict'

// `data-source:sql-write-gated` — latent C6 target adapter. It exposes only
// target discovery/test shape today; actual external writes remain behind the
// future C6 token-bound apply route. The host write facade is still added in
// C6-1 so C6-2/C6-3 can use a narrow structured surface instead of
// DataSourceManager/raw SQL.

const {
  AdapterValidationError,
  normalizeExternalSystemForAdapter,
  unsupportedAdapterOperation,
} = require('../contracts.cjs')

const ADAPTER_KIND = 'data-source:sql-write-gated'

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdapterValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function getDataSourceWritesApi(context) {
  const api = context && context.api && context.api.dataSourceWrites
  if (
    !api ||
    typeof api.test !== 'function' ||
    typeof api.getSchema !== 'function' ||
    typeof api.getTableInfo !== 'function' ||
    typeof api.lookupByKey !== 'function' ||
    typeof api.insertRows !== 'function' ||
    typeof api.updateRows !== 'function'
  ) {
    throw new AdapterValidationError(
      'data-source:sql-write-gated target requires the host write facade context.api.dataSourceWrites; it is not available',
      { field: 'context.api.dataSourceWrites' }
    )
  }
  return api
}

function normalizeFieldList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AdapterValidationError(`${field} must be a non-empty array`, { field })
  }
  const seen = new Set()
  return value.map((entry, index) => {
    const text = requiredString(entry, `${field}[${index}]`)
    if (seen.has(text)) {
      throw new AdapterValidationError(`${field} must not contain duplicates`, { field })
    }
    seen.add(text)
    return text
  })
}

function normalizeConfig(system) {
  const config = system.config || {}
  return {
    dataSourceId: requiredString(config.dataSourceId, 'config.dataSourceId'),
    object: requiredString(config.object, 'config.object'),
    keyFields: normalizeFieldList(config.keyFields, 'config.keyFields'),
    writableFields: normalizeFieldList(config.writableFields, 'config.writableFields'),
  }
}

function createDataSourceSqlWriteGatedTargetAdapter({ system, context, principal } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const config = normalizeConfig(normalizedSystem)

  async function testConnection() {
    return getDataSourceWritesApi(context).test(config.dataSourceId, principal)
  }

  async function listObjects() {
    // C6 target binding is server-owned and single-object in v1. Do not expose
    // the whole writable data-source schema as a broad target picker here.
    return [{
      name: config.object,
      label: config.object,
      operations: [],
      schema: [],
    }]
  }

  async function getSchema(input = {}) {
    const requested = optionalString(input.object) || config.object
    if (requested !== config.object) {
      throw new AdapterValidationError('object must match the configured C6 target object', { field: 'object' })
    }
    const schema = await getDataSourceWritesApi(context).getTableInfo(
      config.dataSourceId,
      config.object,
      principal,
      optionalString(input.schema)
    )
    return {
      object: config.object,
      fields: Array.isArray(schema.columns) ? schema.columns : [],
      keyFields: config.keyFields.slice(),
      writableFields: config.writableFields.slice(),
    }
  }

  return {
    system: normalizedSystem,
    testConnection,
    listObjects,
    getSchema,
    read: unsupportedAdapterOperation(normalizedSystem.kind, 'read'),
    upsert: unsupportedAdapterOperation(normalizedSystem.kind, 'upsert until C6 token-bound apply is implemented'),
  }
}

function createDataSourceSqlWriteGatedTargetAdapterFactory({ context } = {}) {
  return ({ system, principal }) => createDataSourceSqlWriteGatedTargetAdapter({ system, context, principal })
}

module.exports = {
  ADAPTER_KIND,
  createDataSourceSqlWriteGatedTargetAdapter,
  createDataSourceSqlWriteGatedTargetAdapterFactory,
}
