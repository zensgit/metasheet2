'use strict'

const crypto = require('node:crypto')

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
    watermarkConfig: objectOrEmpty(input.watermarkConfig, 'watermarkConfig'),
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

// ---------------------------------------------------------------------------
// OPTIONAL target-write lifecycle capability (S1a — design-lock 2026-06-18 §6.1)
//
// LOCK: "Target lookup/apply is an optional capability extension, not a
// replacement for or expansion of the required 5-method adapter contract.
// REQUIRED_ADAPTER_METHODS remains unchanged. Non-opt-in adapters must continue
// to pass unchanged."
//
// A target adapter MAY expose `targetWriteLifecycle = { lookup, apply }` to opt
// into the generalized C6 dry-run -> apply safe-write lifecycle (lifting it off
// `data-source:sql-write-gated`). This is a SHAPE contract only — no runtime wire
// here; S1b+ wires real targets. Opting in is all-or-nothing (a partial lifecycle
// is a contract error). Result builders are allow-list projections so a target's
// submitted row VALUES can never leak into a lookup/apply result (values-free).
// ---------------------------------------------------------------------------

const TARGET_WRITE_LIFECYCLE_METHODS = ['lookup', 'apply']
const APPLY_ROW_STATUSES = ['written', 'updated', 'skipped', 'failed', 'held']

function hasTargetWriteLifecycle(adapter) {
  return Boolean(adapter && isPlainObject(adapter.targetWriteLifecycle))
}

// Validate the OPTIONAL capability ONLY when an adapter opts in. Not opted in =>
// returns null (nothing to assert). Opted in => the whole lifecycle must exist.
function assertTargetWriteLifecycle(adapter, kind = 'unknown') {
  if (!hasTargetWriteLifecycle(adapter)) return null
  const lifecycle = adapter.targetWriteLifecycle
  for (const method of TARGET_WRITE_LIFECYCLE_METHODS) {
    if (typeof lifecycle[method] !== 'function') {
      throw new AdapterContractError(`${kind} targetWriteLifecycle missing ${method}()`, { kind, method })
    }
  }
  return lifecycle
}

// lookup = keyed existence/revision probe before apply. VALUES-FREE: returns key
// identity + existence + opaque revision only, never the target row's column data.
function normalizeLookupRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new AdapterValidationError('lookup input must be an object')
  }
  if (!Array.isArray(input.keys)) {
    throw new AdapterValidationError('keys must be an array', { field: 'keys' })
  }
  return {
    object: requiredString(input.object, 'object'),
    keyFields: Array.isArray(input.keyFields)
      ? input.keyFields.map((field) => requiredString(field, 'keyFields[]'))
      : [],
    keys: input.keys.map((key, index) => {
      if (!isPlainObject(key)) {
        throw new AdapterValidationError(`keys[${index}] must be an object`, { field: 'keys' })
      }
      return { ...key }
    }),
    options: objectOrEmpty(input.options, 'options'),
  }
}

// VALUES-FREE helpers for the two lifecycle builders. This is the values-free LOCK at the
// contract layer (design-lock §5/§6.1). A lifecycle result flows to UI / issue evidence, so
// it must never carry a raw row value. The STRUCTURAL guarantees are: opaque keyHash (a
// natural key can itself be PII — email/phone), opaque revisionHash, no free-text error, and
// number|boolean|null-only metadata (a string could hide a row value). errorCode is gated to
// a CODE charset as DEFENSE-IN-DEPTH + a canary anchor — NOT a hard guarantee (an uppercase
// product name like WIDGET or a numeric id like 123456 also pass); the contract still relies
// on adapters passing a stable constant there, and the sanitized human-readable reason lives
// in dead-letter (sanitizeIntegrationPayload), not in this result.

// keyHash / revisionHash mirror external-write-dry-run.cjs's keyFromRecord + hashJson.
function hashKey(key, keyFields) {
  const source = Array.isArray(keyFields) && keyFields.length > 0
    ? keyFields.reduce((acc, field) => {
        if (isPlainObject(key) && Object.prototype.hasOwnProperty.call(key, field)) acc[field] = key[field]
        return acc
      }, {})
    : (isPlainObject(key) ? key : {})
  return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex')
}

// Opaque revision: sha256 preserves EQUALITY (so the dry-run→apply revision-fence still
// detects drift) while a stuffed row value is high-entropy and non-reversible.
function hashRevision(revision) {
  if (revision === undefined || revision === null) return null
  return crypto.createHash('sha256').update(String(revision)).digest('hex')
}

// A stable adapter-defined code (e.g. Postgres SQLSTATE `42501`/`23505`, or `C6_ROW_FAILED`).
// Charset gate is defense-in-depth: it rejects emails / part numbers / free text, anchoring
// the values-free canary. Codes may be all-digit, so no leading-letter requirement.
const CODE_PATTERN = /^[A-Z0-9_]{1,64}$/

function assertErrorCode(value, field) {
  const code = requiredString(value, field)
  if (!CODE_PATTERN.test(code)) {
    throw new AdapterContractError(`${field} must be a stable code matching [A-Z0-9_]{1,64} (values-free)`, { field })
  }
  return code
}

// metadata carries only counts/flags. STRUCTURAL values-free guarantee: number | boolean |
// null only. Strings are rejected outright (a row value could ride out as a metadata string)
// and nested objects can never hide row data.
function valuesFreeMetadata(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new AdapterContractError(`${field} must be an object`, { field })
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) {
      out[key] = null
      continue
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) {
        throw new AdapterContractError(`${field}.${key} must be a finite number (values-free)`, { field, key })
      }
      out[key] = entry
      continue
    }
    if (typeof entry === 'boolean') {
      out[key] = entry
      continue
    }
    throw new AdapterContractError(`${field}.${key} must be number|boolean|null (values-free)`, { field, key })
  }
  return out
}

function createLookupResult({ matches = [], keyFields = [], metadata = {} } = {}) {
  if (!Array.isArray(matches)) {
    throw new AdapterContractError('lookup result matches must be an array', { field: 'matches' })
  }
  return {
    matches: matches.map((match, index) => {
      if (!isPlainObject(match)) {
        throw new AdapterContractError(`matches[${index}] must be an object`, { field: 'matches' })
      }
      // VALUES-FREE: index + opaque keyHash + existence + opaque revisionHash — never the
      // raw key and never a raw revision token.
      return {
        index: normalizeResultCount(match.index === undefined ? index : match.index, `matches[${index}].index`),
        keyHash: hashKey(match.key, keyFields),
        exists: Boolean(match.exists),
        revisionHash: hashRevision(match.revision),
      }
    }),
    metadata: valuesFreeMetadata(metadata, 'metadata'),
  }
}

function normalizeApplyRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new AdapterValidationError('apply input must be an object')
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
    keyFields: Array.isArray(input.keyFields)
      ? input.keyFields.map((field) => requiredString(field, 'keyFields[]'))
      : [],
    // Single-use dry-run token carried opaquely; the contract layer does not
    // interpret it — the S1b runtime binds it to the dry-run plan.
    dryRunToken: optionalString(input.dryRunToken, 'dryRunToken'),
    options: objectOrEmpty(input.options, 'options'),
  }
}

// Per-row apply result: ENUM-STRICT status + VALUES-FREE (allow-list projection of
// index/keyHash/status/errorCode — the submitted row values are never carried, and the
// free-text error is intentionally NOT in the result; sanitized detail goes to dead-letter).
function createApplyResult({ rows = [], keyFields = [], written = 0, updated = 0, skipped = 0, failed = 0, held = 0, metadata = {} } = {}) {
  if (!Array.isArray(rows)) {
    throw new AdapterContractError('apply result rows must be an array', { field: 'rows' })
  }
  const normalizedRows = rows.map((row, index) => {
    if (!isPlainObject(row)) {
      throw new AdapterContractError(`rows[${index}] must be an object`, { field: 'rows' })
    }
    const status = optionalString(row.status, `rows[${index}].status`)
    if (!status || !APPLY_ROW_STATUSES.includes(status)) {
      throw new AdapterContractError(
        `rows[${index}].status must be one of ${APPLY_ROW_STATUSES.join('|')}`,
        { field: 'rows', index, value: row.status, allowed: APPLY_ROW_STATUSES },
      )
    }
    // VALUES-FREE: index + opaque keyHash + enum-strict status + code-only errorCode. No raw
    // key, no free-text error (that leaks DB/row values — it belongs in dead-letter).
    return {
      index: normalizeResultCount(row.index === undefined ? index : row.index, `rows[${index}].index`),
      keyHash: hashKey(row.key, keyFields),
      status,
      ...(row.errorCode === undefined || row.errorCode === null
        ? {}
        : { errorCode: assertErrorCode(row.errorCode, `rows[${index}].errorCode`) }),
    }
  })
  return {
    rows: normalizedRows,
    written: normalizeResultCount(written, 'written'),
    updated: normalizeResultCount(updated, 'updated'),
    skipped: normalizeResultCount(skipped, 'skipped'),
    failed: normalizeResultCount(failed, 'failed'),
    held: normalizeResultCount(held, 'held'),
    metadata: valuesFreeMetadata(metadata, 'metadata'),
  }
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
  // S1a — OPTIONAL target-write lifecycle capability (not part of the required 5-method contract)
  TARGET_WRITE_LIFECYCLE_METHODS,
  APPLY_ROW_STATUSES,
  hasTargetWriteLifecycle,
  assertTargetWriteLifecycle,
  normalizeLookupRequest,
  createLookupResult,
  normalizeApplyRequest,
  createApplyResult,
  __internals: {
    isPlainObject,
    requiredString,
    optionalString,
    objectOrEmpty,
    normalizeLimit,
    normalizeResultCount,
  },
}
