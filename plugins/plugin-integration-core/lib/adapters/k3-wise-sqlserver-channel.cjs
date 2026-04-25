'use strict'

// ---------------------------------------------------------------------------
// K3 WISE SQL Server channel - plugin-integration-core
//
// PoC-level database channel for K3 WISE deployments where the customer exposes
// read-only business tables or an integration middle database. This module does
// not import a SQL Server driver and does not accept raw SQL. Runtime code must
// inject a constrained queryExecutor when the customer channel is provisioned.
// ---------------------------------------------------------------------------

const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
  createReadResult,
  createUpsertResult,
  normalizeExternalSystemForAdapter,
  normalizeReadRequest,
  normalizeUpsertRequest,
} = require('../contracts.cjs')

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/

const DEFAULT_OBJECTS = {
  material: {
    label: 'K3 WISE Material table',
    table: 't_ICItem',
    operations: ['read'],
    keyField: 'FNumber',
    schema: [
      { name: 'FItemID', label: 'K3 item id', type: 'number' },
      { name: 'FNumber', label: 'Material code', type: 'string', required: true },
      { name: 'FName', label: 'Material name', type: 'string' },
      { name: 'FModel', label: 'Specification', type: 'string' },
    ],
  },
  bom: {
    label: 'K3 WISE BOM header table',
    table: 't_ICBOM',
    operations: ['read'],
    keyField: 'FBOMNumber',
    schema: [
      { name: 'FBOMInterID', label: 'K3 BOM id', type: 'number' },
      { name: 'FBOMNumber', label: 'BOM code', type: 'string' },
      { name: 'FItemID', label: 'Parent material id', type: 'number' },
    ],
  },
  bom_child: {
    label: 'K3 WISE BOM child table',
    table: 't_ICBomChild',
    operations: ['read'],
    keyField: 'FBOMInterID',
    schema: [
      { name: 'FBOMInterID', label: 'K3 BOM id', type: 'number' },
      { name: 'FItemID', label: 'Child material id', type: 'number' },
      { name: 'FQty', label: 'Quantity', type: 'number' },
    ],
  },
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function toPlainObject(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new AdapterValidationError(`${field} must be an object`, { field })
  }
  return { ...value }
}

function normalizeIdentifier(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdapterValidationError(`${field} is required`, { field })
  }
  const trimmed = value.trim()
  if (!IDENTIFIER_PATTERN.test(trimmed)) {
    throw new AdapterValidationError(`${field} must be a simple table identifier`, { field })
  }
  return trimmed
}

function normalizeIdentifierList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new AdapterValidationError(`${field} must be an array`, { field })
  }
  return value.map((item, index) => normalizeIdentifier(item, `${field}[${index}]`))
}

function normalizeObjects(config) {
  const configured = toPlainObject(config.objects, 'config.objects')
  const normalized = {}
  for (const [name, defaults] of Object.entries(DEFAULT_OBJECTS)) {
    normalized[name] = { ...defaults, ...(isPlainObject(configured[name]) ? configured[name] : {}) }
  }
  for (const [name, value] of Object.entries(configured)) {
    if (normalized[name]) continue
    if (!isPlainObject(value)) {
      throw new AdapterValidationError(`config.objects.${name} must be an object`, {
        field: `config.objects.${name}`,
      })
    }
    normalized[name] = { operations: ['read'], ...value }
  }

  for (const [name, objectConfig] of Object.entries(normalized)) {
    if (objectConfig.table) {
      objectConfig.table = normalizeIdentifier(objectConfig.table, `config.objects.${name}.table`)
    }
    if (Array.isArray(objectConfig.columns)) {
      objectConfig.columns = objectConfig.columns.map((column, index) => normalizeIdentifier(column, `config.objects.${name}.columns[${index}]`))
    }
  }
  return normalized
}

function assertObjectConfigured(objects, object) {
  const objectConfig = objects[object]
  if (!objectConfig) {
    throw new AdapterValidationError(`K3 WISE SQL Server object is not configured: ${object}`, { object })
  }
  return objectConfig
}

function ensureOperation(kind, object, objectConfig, operation) {
  const operations = Array.isArray(objectConfig.operations) ? objectConfig.operations : ['read']
  if (!operations.includes(operation)) {
    throw new UnsupportedAdapterOperationError(`${kind} object ${object} does not support ${operation}`, {
      kind,
      object,
      operation,
    })
  }
}

function normalizeTableSet(config) {
  const allowedTables = new Set([
    ...normalizeIdentifierList(config.allowedTables, 'config.allowedTables'),
    ...normalizeIdentifierList(config.readTables, 'config.readTables'),
    ...normalizeIdentifierList(config.writeTables, 'config.writeTables'),
  ])
  return allowedTables
}

function assertAllowedTable(table, allowedTables, field) {
  const normalized = normalizeIdentifier(table, field)
  if (!allowedTables.has(normalized)) {
    throw new AdapterValidationError(`${field} is not in the configured allowlist`, {
      field,
      table: normalized,
    })
  }
  return normalized
}

function assertNoDirectK3Write(table, objectConfig) {
  if (objectConfig.allowDirectTableWrite === true) return
  if (objectConfig.writeMode !== 'middle-table') {
    throw new UnsupportedAdapterOperationError('K3 WISE SQL Server channel only writes to configured middle tables', {
      table,
      writeMode: objectConfig.writeMode || null,
    })
  }
}

function normalizeExecutorResult(result) {
  if (Array.isArray(result)) {
    return { records: result, nextCursor: null, raw: result }
  }
  if (isPlainObject(result)) {
    return {
      records: Array.isArray(result.records) ? result.records : [],
      nextCursor: result.nextCursor === undefined ? null : result.nextCursor,
      done: result.done,
      raw: result,
    }
  }
  return { records: [], nextCursor: null, raw: result }
}

function createK3WiseSqlServerChannel({ system, queryExecutor, logger } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const config = normalizedSystem.config
  const objects = normalizeObjects(config)
  const allowedTables = normalizeTableSet(config)
  const executor = queryExecutor || config.queryExecutor

  async function testConnection(input = {}) {
    if (!executor) {
      return {
        ok: false,
        code: 'SQLSERVER_EXECUTOR_MISSING',
        message: 'K3 WISE SQL Server channel requires an injected queryExecutor',
      }
    }
    try {
      if (typeof executor.testConnection === 'function') {
        const result = await executor.testConnection({ system: normalizedSystem, input })
        return { ok: result === undefined ? true : Boolean(result.ok !== false), raw: result }
      }
      return { ok: true }
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[plugin-integration-core] K3 WISE SQL Server channel testConnection failed')
      }
      return {
        ok: false,
        code: 'SQLSERVER_TEST_FAILED',
        message: error && error.message ? error.message : String(error),
      }
    }
  }

  async function listObjects() {
    return Object.entries(objects).map(([name, objectConfig]) => ({
      name,
      label: objectConfig.label || name,
      operations: Array.isArray(objectConfig.operations) ? [...objectConfig.operations] : ['read'],
      table: objectConfig.table,
      schema: Array.isArray(objectConfig.schema) ? objectConfig.schema.map((field) => ({ ...field })) : undefined,
    }))
  }

  async function getSchema(input = {}) {
    const object = typeof input === 'string' ? input : input.object
    const objectConfig = assertObjectConfigured(objects, object)
    return {
      object,
      table: objectConfig.table,
      fields: Array.isArray(objectConfig.schema) ? objectConfig.schema.map((field) => ({ ...field })) : [],
    }
  }

  async function read(input = {}) {
    if (!executor || typeof executor.select !== 'function') {
      throw new AdapterValidationError('K3 WISE SQL Server channel requires queryExecutor.select()', {
        field: 'queryExecutor.select',
      })
    }
    const request = normalizeReadRequest(input)
    const objectConfig = assertObjectConfigured(objects, request.object)
    ensureOperation(normalizedSystem.kind, request.object, objectConfig, 'read')
    const table = assertAllowedTable(objectConfig.table, allowedTables, `config.objects.${request.object}.table`)
    const result = normalizeExecutorResult(await executor.select({
      table,
      columns: Array.isArray(objectConfig.columns) ? [...objectConfig.columns] : undefined,
      limit: request.limit,
      cursor: request.cursor,
      filters: request.filters,
      watermark: request.watermark,
      orderBy: objectConfig.orderBy || objectConfig.keyField || undefined,
      options: request.options,
      system: normalizedSystem,
    }))
    return createReadResult({
      records: result.records,
      nextCursor: result.nextCursor,
      done: result.done,
      raw: result.raw,
      metadata: {
        object: request.object,
        table,
        mode: 'sqlserver-read',
      },
    })
  }

  async function upsert(input = {}) {
    if (!executor || typeof executor.insertMany !== 'function') {
      throw new AdapterValidationError('K3 WISE SQL Server channel requires queryExecutor.insertMany()', {
        field: 'queryExecutor.insertMany',
      })
    }
    const request = normalizeUpsertRequest(input)
    const objectConfig = assertObjectConfigured(objects, request.object)
    ensureOperation(normalizedSystem.kind, request.object, objectConfig, 'upsert')
    const table = assertAllowedTable(objectConfig.table, allowedTables, `config.objects.${request.object}.table`)
    assertNoDirectK3Write(table, objectConfig)

    const raw = await executor.insertMany({
      table,
      records: request.records,
      keyFields: request.keyFields,
      mode: request.mode,
      options: request.options,
      system: normalizedSystem,
    })
    const written = isPlainObject(raw) && Number.isFinite(Number(raw.written))
      ? Number(raw.written)
      : request.records.length
    const failed = isPlainObject(raw) && Number.isFinite(Number(raw.failed))
      ? Number(raw.failed)
      : 0
    const errors = isPlainObject(raw) && Array.isArray(raw.errors) ? raw.errors : []
    const results = isPlainObject(raw) && Array.isArray(raw.results)
      ? raw.results
      : request.records.map((record, index) => ({ index, status: 'written', key: record[objectConfig.keyField] }))

    return createUpsertResult({
      written,
      failed,
      errors,
      results,
      raw,
      metadata: {
        object: request.object,
        table,
        mode: 'sqlserver-middle-table',
      },
    })
  }

  return {
    kind: normalizedSystem.kind,
    systemId: normalizedSystem.id,
    testConnection,
    listObjects,
    getSchema,
    read,
    upsert,
  }
}

function createK3WiseSqlServerChannelFactory(defaults = {}) {
  return (input = {}) => createK3WiseSqlServerChannel({ ...defaults, ...input })
}

module.exports = {
  createK3WiseSqlServerChannel,
  createK3WiseSqlServerChannelFactory,
  __internals: {
    DEFAULT_OBJECTS,
    IDENTIFIER_PATTERN,
    normalizeIdentifier,
    normalizeObjects,
  },
}
