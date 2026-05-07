'use strict'

// ---------------------------------------------------------------------------
// Adapter contracts - plugin-integration-core
//
// Internal PLM/ERP/DB adapters use this narrow shape so the pipeline runner can
// work with source and target systems without depending on each vendor module.
// This is intentionally plugin-local for M1; wider platform exposure can come
// later after the K3 WISE PoC proves the shape.
// ---------------------------------------------------------------------------

const REQUIRED_ADAPTER_METHODS = ['testConnection', 'listObjects', 'getSchema', 'read', 'upsert']
const DEFAULT_READ_LIMIT = 1000
const MAX_READ_LIMIT = 10000

class AdapterContractError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'AdapterContractError'
    this.details = details
  }
}

class AdapterValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'AdapterValidationError'
    this.details = details
  }
}

class UnsupportedAdapterOperationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'UnsupportedAdapterOperationError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdapterValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new AdapterValidationError(`${field} must be a string`, { field })
  }
  return value.trim() || null
}

function objectOrEmpty(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new AdapterValidationError(`${field} must be an object`, { field })
  }
  return { ...value }
}

function normalizeExternalSystemForAdapter(system) {
  if (!isPlainObject(system)) {
    throw new AdapterValidationError('system must be an object', { field: 'system' })
  }
  return {
    id: optionalString(system.id, 'system.id'),
    name: optionalString(system.name, 'system.name') || requiredString(system.kind, 'system.kind'),
    kind: requiredString(system.kind, 'system.kind'),
    role: optionalString(system.role, 'system.role') || 'bidirectional',
    config: objectOrEmpty(system.config, 'system.config'),
    capabilities: objectOrEmpty(system.capabilities, 'system.capabilities'),
    credentials: system.credentials === undefined ? undefined : system.credentials,
  }
}

function normalizeLimit(limit, { defaultValue = DEFAULT_READ_LIMIT, max = MAX_READ_LIMIT } = {}) {
  if (limit === undefined || limit === null) return defaultValue
  const numeric = Number(limit)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new AdapterValidationError('limit must be a positive integer', { field: 'limit' })
  }
  return Math.min(numeric, max)
}

function normalizeReadRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new AdapterValidationError('read input must be an object')
  }
  return {
    object: requiredString(input.object, 'object'),
    limit: normalizeLimit(input.limit),
    cursor: optionalString(input.cursor, 'cursor'),
    filters: objectOrEmpty(input.filters, 'filters'),
    watermark: objectOrEmpty(input.watermark, 'watermark'),
    options: objectOrEmpty(input.options, 'options'),
  }
}

function normalizeUpsertRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new AdapterValidationError('upsert input must be an object')
  }
  if (!Array.isArray(input.records)) {
    throw new AdapterValidationError('records must be an array', { field: 'records' })
  }
  return {
    object: requiredString(input.object, 'object'),
    records: input.records.map((record, index) => {
      if (!isPlainObject(record)) {
        throw new AdapterValidationError(`records[${index}] must be an object`, { field: 'records' })
      }
      return { ...record }
    }),
    keyFields: Array.isArray(input.keyFields) ? input.keyFields.map((field) => requiredString(field, 'keyFields[]')) : [],
    mode: optionalString(input.mode, 'mode') || 'upsert',
    options: objectOrEmpty(input.options, 'options'),
  }
}

function createReadResult({ records, nextCursor = null, done, raw = undefined, metadata = {} } = {}) {
  if (!Array.isArray(records)) {
    throw new AdapterContractError('read result records must be an array', { field: 'records' })
  }
  const safeNextCursor = nextCursor === undefined || nextCursor === null ? null : String(nextCursor)
  return {
    records,
    nextCursor: safeNextCursor,
    done: done === undefined ? safeNextCursor === null : Boolean(done),
    raw,
    metadata: objectOrEmpty(metadata, 'metadata'),
  }
}

function normalizeResultCount(value, field) {
  if (value === undefined || value === null || value === '') return 0
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new AdapterContractError(`${field} must be a non-negative integer`, { field, value })
  }
  return numeric
}

function createUpsertResult({ written = 0, skipped = 0, failed = 0, results = [], errors = [], raw = undefined, metadata = {} } = {}) {
  if (!Array.isArray(results)) {
    throw new AdapterContractError('upsert result results must be an array', { field: 'results' })
  }
  if (!Array.isArray(errors)) {
    throw new AdapterContractError('upsert result errors must be an array', { field: 'errors' })
  }
  return {
    written: normalizeResultCount(written, 'written'),
    skipped: normalizeResultCount(skipped, 'skipped'),
    failed: normalizeResultCount(failed, 'failed'),
    results,
    errors,
    raw,
    metadata: objectOrEmpty(metadata, 'metadata'),
  }
}

function unsupportedAdapterOperation(kind, operation) {
  return async () => {
    throw new UnsupportedAdapterOperationError(`${kind} adapter does not support ${operation}`, {
      kind,
      operation,
    })
  }
}

function assertAdapterContract(adapter, kind = 'unknown') {
  if (!isPlainObject(adapter)) {
    throw new AdapterContractError(`${kind} adapter factory must return an object`, { kind })
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new AdapterContractError(`${kind} adapter missing ${method}()`, { kind, method })
    }
  }
  return adapter
}

function createAdapterRegistry({ logger } = {}) {
  const factories = new Map()

  function registerAdapter(kind, factory, { replace = false } = {}) {
    const normalizedKind = requiredString(kind, 'kind')
    if (typeof factory !== 'function') {
      throw new AdapterValidationError('adapter factory must be a function', { kind: normalizedKind })
    }
    if (factories.has(normalizedKind) && !replace) {
      throw new AdapterValidationError(`adapter already registered: ${normalizedKind}`, { kind: normalizedKind })
    }
    factories.set(normalizedKind, factory)
    if (logger && typeof logger.info === 'function') {
      logger.info(`[plugin-integration-core] adapter registered: ${normalizedKind}`)
    }
    return registry
  }

  function listAdapterKinds() {
    return Array.from(factories.keys()).sort()
  }

  function createAdapter(system, deps = {}) {
    const normalizedSystem = normalizeExternalSystemForAdapter(system)
    const factory = factories.get(normalizedSystem.kind)
    if (!factory) {
      throw new UnsupportedAdapterOperationError(`adapter not registered: ${normalizedSystem.kind}`, {
        kind: normalizedSystem.kind,
      })
    }
    const adapter = factory({
      ...deps,
      system: normalizedSystem,
      logger,
    })
    return assertAdapterContract(adapter, normalizedSystem.kind)
  }

  const registry = {
    registerAdapter,
    listAdapterKinds,
    createAdapter,
  }
  return registry
}

module.exports = {
  REQUIRED_ADAPTER_METHODS,
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  AdapterContractError,
  AdapterValidationError,
  UnsupportedAdapterOperationError,
  assertAdapterContract,
  createAdapterRegistry,
  createReadResult,
  createUpsertResult,
  normalizeExternalSystemForAdapter,
  normalizeReadRequest,
  normalizeUpsertRequest,
  unsupportedAdapterOperation,
  __internals: {
    isPlainObject,
    requiredString,
    optionalString,
    objectOrEmpty,
    normalizeLimit,
    normalizeResultCount,
  },
}
