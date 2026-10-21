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
// E4 / G-4 (HG v1.2 §10) — this transport is the SECOND K3 kind covered by the permanent fence.
// Layers 3 and 4 of its four live in this file; layers 1 and 2 are the shared route/C6 call sites,
// which match this kind through the fence's own widened predicate. READS are untouched.
const {
  K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND,
  K3_WISE_EXTERNAL_WRITE_DISABLED,
  refuseK3ExternalWritePermanently,
} = require('../k3-external-write-permanent-fence.cjs')

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
  const sharedTables = normalizeIdentifierList(config.allowedTables, 'config.allowedTables')
  return {
    read: new Set([
      ...sharedTables,
      ...normalizeIdentifierList(config.readTables, 'config.readTables'),
    ]),
    write: new Set([
      ...sharedTables,
      ...normalizeIdentifierList(config.writeTables, 'config.writeTables'),
    ]),
  }
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

// SUPERSEDED, and kept only as inert depth. This was the channel's ENTIRE write guard before E4
// covered this kind, and it was config-bypassable by construction: `allowDirectTableWrite: true`
// on an object config returned early and authorised a direct write into a live K3 business table.
// It is now unreachable — every caller is refused by the permanent fence in `upsert` several
// statements earlier — and it is NOT the guard any more. Left in place rather than deleted so
// that if a future edit removes the fence line, this still refuses the default-config case
// instead of leaving nothing at all behind it.
function assertNoDirectK3Write(table, objectConfig) {
  if (objectConfig.allowDirectTableWrite === true) return
  if (objectConfig.writeMode !== 'middle-table') {
    throw new UnsupportedAdapterOperationError('K3 WISE SQL Server channel only writes to configured middle tables', {
      table,
      writeMode: objectConfig.writeMode || null,
    })
  }
}

// The refusal both layers in this file throw. Same closed token, same 403, same fixed message as
// every WebAPI layer — the two kinds are indistinguishable in a response body on purpose.
// `code`/`status` ride alongside `details` exactly as the WebAPI layers do, so the fixed token
// survives every reader (valuesFreeErrorCode, the HTTP error mapper, C6 row evidence).
function refuseK3SqlServerExternalWrite() {
  refuseK3ExternalWritePermanently(
    (status, code, message, details) => Object.assign(
      new AdapterValidationError(message, details), { code, status },
    ),
    K3_EXTERNAL_WRITE_SQLSERVER_TARGET_KIND,
  )
}

// ===== E4 LAYER 4 of FOUR for `erp:k3-wise-sqlserver` — THE EXECUTOR SEAM =================
// The deepest fence, and the one that closes the actual gap. The channel issues no SQL itself: a
// deployment INJECTS a `queryExecutor`, and the write capability therefore arrives from outside
// this package. Until now the only thing stopping a K3 SQL write was that the wired default
// executor happens to be read-only — swap in a write-capable one and a K3 write re-opened with no
// edit to any fence. So the seam itself is fenced: whatever executor is injected, its
// `insertMany` is replaced by an unconditional refusal before the channel can ever hold a
// reference to the real one.
//
// Everything else is forwarded untouched — `testConnection` and `select` are the READ path and
// must keep working (a blanket deny that killed reads would be a FAIL, not a pass, under §15.2
// E4-05). Real methods are bound to the underlying executor so a class-based deployment executor
// keeps its own `this` and any private state.
async function refusedInsertMany() {
  refuseK3SqlServerExternalWrite()
}

function fenceExecutorExternalWrites(executor) {
  if (executor === null || executor === undefined) return executor
  if (typeof executor !== 'object' && typeof executor !== 'function') return executor
  return new Proxy(executor, {
    get(target, property) {
      // The single intercepted member. Note this also means `typeof executor.insertMany` stays
      // 'function', so the channel's own shape check cannot be turned into a way to detect —
      // or route around — the fence.
      //
      // ASYNC on purpose: a query executor's `insertMany` returns a promise, and callers may hold
      // the result before awaiting it (`.catch(...)` on the returned promise). A synchronous throw
      // from a method with that contract escapes such a caller as an uncaught exception instead of
      // a rejection. Refusing as a REJECTION keeps the refusal inside the caller's error handling.
      if (property === 'insertMany') return refusedInsertMany
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, property, value) {
      // Re-attaching a live `insertMany` from outside would be a runtime unlock. §10.1 reserves
      // none, so the assignment is refused rather than silently dropped.
      if (property === 'insertMany') refuseK3SqlServerExternalWrite()
      return Reflect.set(target, property, value)
    },
  })
}
// =========================================================================================

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
  // BOTH executor sources are fenced — the injected one AND the one a stored system config could
  // carry. `config.queryExecutor` is the more dangerous of the two precisely because it is
  // customer-editable configuration, which is the shape §10.1 rules out as an unlock.
  const executor = fenceExecutorExternalWrites(queryExecutor || config.queryExecutor)

  async function testConnection(input = {}) {
    if (!executor) {
      return {
        ok: false,
        code: 'SQLSERVER_EXECUTOR_MISSING',
        message: 'SQLSERVER_EXECUTOR_MISSING: inject queryExecutor when creating K3WiseSqlServerChannel; expected executor methods include testConnection/select/insertMany for allowlisted SQL Server access.',
      }
    }
    try {
      if (typeof executor.testConnection === 'function') {
        const result = await executor.testConnection({ system: normalizedSystem, input })
        if (isPlainObject(result)) {
          const ok = result.ok !== false
          return {
            ok,
            ...(typeof result.code === 'string' ? { code: result.code } : {}),
            ...(typeof result.message === 'string' ? { message: result.message } : {}),
            ...(result.authenticated === undefined ? {} : { authenticated: Boolean(result.authenticated) }),
            ...(result.connected === undefined ? {} : { connected: Boolean(result.connected) }),
            raw: result,
          }
        }
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
    const table = assertAllowedTable(objectConfig.table, allowedTables.read, `config.objects.${request.object}.table`)
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
    // ===== E4 LAYER 3 of FOUR for `erp:k3-wise-sqlserver` — UNCONDITIONAL (HG v1.2 §10.2.3) ====
    // The direct analogue of the WebAPI kind's layer-3 write-source refusal: no predicate, no
    // parameter, no config field and no environment read can reach past this line. It is the
    // FIRST statement of the function, ahead of the executor shape check, ahead of request
    // normalisation, ahead of the table allowlist and ahead of `assertNoDirectK3Write` — so a
    // refused call resolves no executor, normalises nothing and touches no driver.
    //
    // This is the layer that catches the pipeline runner, which calls `targetAdapter.upsert(...)`
    // directly and never passes through the C6 route or apply engine at all.
    //
    // The older middle-table rule below is deliberately LEFT reachable-in-source but dead in
    // practice: it was config-bypassable (`allowDirectTableWrite: true`), which is exactly why a
    // permanent fence had to sit in front of it rather than be tightened in place.
    //
    // READ is untouched: `read`, `listObjects`, `getSchema` and `testConnection` all still work,
    // and the read path is what this kind is actually wired for in production.
    refuseK3SqlServerExternalWrite()
    // ==========================================================================================
    if (!executor || typeof executor.insertMany !== 'function') {
      throw new AdapterValidationError('K3 WISE SQL Server channel requires queryExecutor.insertMany()', {
        field: 'queryExecutor.insertMany',
      })
    }
    const request = normalizeUpsertRequest(input)
    const objectConfig = assertObjectConfigured(objects, request.object)
    ensureOperation(normalizedSystem.kind, request.object, objectConfig, 'upsert')
    const table = assertAllowedTable(objectConfig.table, allowedTables.write, `config.objects.${request.object}.table`)
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

const K3_WISE_SQLSERVER_ADAPTER_METADATA = {
  label: 'K3 WISE SQL Server Channel',
  // `target` is retained deliberately. It is descriptive metadata only — `describeAdapterKind`
  // publishes it and nothing gates on it — and existing stored systems carry `bidirectional`.
  // Removing it here would change a published listing without adding any guarantee; the
  // guarantee is the fence, and `guardrails.write` below is where this listing states it.
  roles: ['source', 'target'],
  advanced: true,
  guardrails: {
    read: {
      requiresTableAllowlist: true,
      allowlistKeys: ['readTables', 'allowedTables'],
    },
    // E4 / G-4 (HG v1.2 §10), 20260901. This used to publish `requiresMiddleTableMode` and a
    // `middle-table` write mode — i.e. it told an integrator that configuring the channel a
    // particular way made writes work. It no longer does at any configuration: this kind's write
    // path is permanently refused at four layers with the fixed code below. The old keys are
    // REMOVED rather than kept alongside the refusal, because a listing that names both a
    // refusal and a recipe reads as a recipe.
    write: {
      permanentlyRefused: true,
      refusalCode: K3_WISE_EXTERNAL_WRITE_DISABLED,
      authority: 'E4',
    },
    ui: {
      hiddenByDefault: true,
      normalUiDirectCoreTableWrites: false,
    },
  },
}

module.exports = {
  K3_WISE_SQLSERVER_ADAPTER_METADATA,
  createK3WiseSqlServerChannel,
  createK3WiseSqlServerChannelFactory,
  __internals: {
    DEFAULT_OBJECTS,
    IDENTIFIER_PATTERN,
    // Exposed so the E4 parity suite can drive layer 4 (the executor seam) on its own, without
    // going through `upsert` — which is what makes the two layers independently witnessable.
    fenceExecutorExternalWrites,
    normalizeIdentifier,
    normalizeTableSet,
    normalizeObjects,
    refuseK3SqlServerExternalWrite,
  },
}
