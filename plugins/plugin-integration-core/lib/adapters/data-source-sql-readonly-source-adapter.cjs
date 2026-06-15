'use strict'

// `data-source:sql-readonly` — a Data Factory **source** adapter that reads a generic,
// read-only `data_sources`-registered SQL connection (Postgres / SQL Server) through the host
// facade `context.api.dataSources`. It is the thin, additive bridge for the import-source →
// multitable-hub direction; it copies no credentials, writes nothing, and never touches the K3
// channel. Design:
// docs/development/data-factory-sql-data-source-readonly-source-bridge-design-20260601.md
//
// It mirrors metasheet-staging-source-adapter.cjs (offset-cursor pagination over an injected host
// capability), swapping the read backend from multitable records to the data-source facade.

const {
  AdapterValidationError,
  normalizeExternalSystemForAdapter,
  normalizeReadRequest,
  createReadResult,
  unsupportedAdapterOperation,
} = require('../contracts.cjs')
const { getPath, isBlank } = require('../transform-engine.cjs')

const ADAPTER_KIND = 'data-source:sql-readonly'
const WATERMARK_CURSOR_PREFIX = 'dswm1:'
const WATERMARK_TYPES = new Set(['updated_at', 'monotonic_id'])

// `requiredString` / `optionalString` are kept local (contracts.cjs only exposes them under
// `__internals`); mirrors the staging adapter's approach.
function requiredString(value, field) {
  if (value === undefined || value === null || value === '') {
    throw new AdapterValidationError(`${field} is required`, { field })
  }
  if (typeof value !== 'string') {
    throw new AdapterValidationError(`${field} must be a string`, { field })
  }
  return value
}

function optionalString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasOwnKeys(value) {
  return isPlainObject(value) && Object.keys(value).length > 0
}

function isScalarQueryValue(value) {
  return value === null ||
    value instanceof Date ||
    ['string', 'number', 'boolean'].includes(typeof value)
}

function normalizeEqualityFilters(filters = {}) {
  if (!hasOwnKeys(filters)) return undefined
  const out = {}
  for (const [key, value] of Object.entries(filters)) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new AdapterValidationError('filters keys must be non-empty strings', { field: 'filters' })
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new AdapterValidationError('data-source:sql-readonly filters support equality primitives only', {
        field: `filters.${key}`,
      })
    }
    out[key] = value
  }
  return out
}

// Fail-closed guard: the host injects the read-only data-source facade as
// `context.api.dataSources`. If it is absent (e.g. the plugin allowlist key drifted), surface a
// clear error instead of a confusing `undefined` access. Mirrors the staging adapter's
// getRecordsApi guard.
function getDataSourcesApi(context) {
  const api = context && context.api && context.api.dataSources
  if (
    !api ||
    typeof api.test !== 'function' ||
    typeof api.getSchema !== 'function' ||
    typeof api.getTableInfo !== 'function' ||
    typeof api.select !== 'function'
  ) {
    throw new AdapterValidationError(
      'data-source:sql-readonly source requires the host read-only facade context.api.dataSources; it is not available',
      { field: 'context.api.dataSources' }
    )
  }
  return api
}

function parseOffsetCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return 0
  if (typeof cursor === 'string' && cursor.startsWith(WATERMARK_CURSOR_PREFIX)) {
    throw new AdapterValidationError('watermark cursor cannot be used for offset reads', { field: 'cursor' })
  }
  const numeric = Number(cursor)
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new AdapterValidationError('cursor must be a non-negative offset', { field: 'cursor' })
  }
  return numeric
}

function encodeWatermarkCursor(payload) {
  return `${WATERMARK_CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

function decodeWatermarkCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.startsWith(WATERMARK_CURSOR_PREFIX)) {
    throw new AdapterValidationError('watermark reads require a watermark cursor', { field: 'cursor' })
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor.slice(WATERMARK_CURSOR_PREFIX.length), 'base64url').toString('utf8'))
    if (!isPlainObject(decoded) || decoded.v !== 1 || typeof decoded.mode !== 'string') {
      throw new Error('invalid cursor payload')
    }
    return decoded
  } catch {
    throw new AdapterValidationError('invalid watermark cursor', { field: 'cursor' })
  }
}

function normalizeWatermarkField(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdapterValidationError(`${field} must be a non-empty string`, { field })
  }
  return value.trim()
}

function normalizeWatermarkConfigForRead(config = {}) {
  if (!hasOwnKeys(config)) {
    throw new AdapterValidationError('watermarkConfig is required for watermark reads', { field: 'watermarkConfig' })
  }
  const type = config.type || config.watermarkType
  if (!WATERMARK_TYPES.has(type)) {
    throw new AdapterValidationError('watermarkConfig.type must be updated_at or monotonic_id', {
      field: 'watermarkConfig.type',
    })
  }
  const field = normalizeWatermarkField(config.field || config.watermarkField, 'watermarkConfig.field')
  const normalized = { type, field }
  if (type === 'updated_at') {
    const tiebreaker = config.tiebreaker || config.tieBreaker || config.tiebreakerField || config.watermarkTiebreaker
    normalized.tiebreaker = normalizeWatermarkField(tiebreaker, 'watermarkConfig.tiebreaker')
    if (normalized.tiebreaker === normalized.field) {
      throw new AdapterValidationError('watermarkConfig.tiebreaker must be different from field', {
        field: 'watermarkConfig.tiebreaker',
      })
    }
  }
  return normalized
}

function normalizeWatermarkValue(type, value, field) {
  if (isBlank(value)) {
    throw new AdapterValidationError(`${field} is required for watermark reads`, { field })
  }
  if (type === 'updated_at') {
    const candidate = value instanceof Date ? value.toISOString() : String(value)
    if (Number.isNaN(Date.parse(candidate))) {
      throw new AdapterValidationError(`${field} must be a valid timestamp`, { field })
    }
    return candidate
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new AdapterValidationError(`${field} must be a safe integer or integer string`, { field })
    }
    return String(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^-?\d+$/.test(trimmed)) return trimmed
  }
  throw new AdapterValidationError(`${field} must be an integer`, { field })
}

function normalizeTiebreakerValue(value, field) {
  if (!isScalarQueryValue(value) || isBlank(value)) {
    throw new AdapterValidationError(`${field} must be a non-empty scalar`, { field })
  }
  return value instanceof Date ? value.toISOString() : value
}

function readRecordValue(record, field) {
  if (isPlainObject(record) && Object.prototype.hasOwnProperty.call(record, field)) {
    return record[field]
  }
  return getPath(record, field)
}

function modeForWatermarkConfig(config) {
  return config.type === 'monotonic_id' ? 'wm-mono' : 'wm-composite'
}

function assertCursorMatchesConfig(cursor, mode, config) {
  if (cursor.mode !== mode || cursor.type !== config.type || cursor.field !== config.field) {
    throw new AdapterValidationError('watermark cursor mode does not match the read request', { field: 'cursor' })
  }
  if (config.type === 'updated_at' && cursor.tiebreaker !== config.tiebreaker) {
    throw new AdapterValidationError('watermark cursor tiebreaker does not match the read request', { field: 'cursor' })
  }
}

function combineWhereClauses(baseWhere, watermarkWhere) {
  if (baseWhere && watermarkWhere) return { $and: [baseWhere, watermarkWhere] }
  return watermarkWhere || baseWhere
}

function buildWatermarkReadPlan(request) {
  if (!hasOwnKeys(request.watermark)) return null
  const config = normalizeWatermarkConfigForRead(request.watermarkConfig)
  const watermarkValue = normalizeWatermarkValue(
    config.type,
    request.watermark[config.field],
    `watermark.${config.field}`
  )
  const mode = modeForWatermarkConfig(config)
  const orderBy = [{ column: config.field, direction: 'asc' }]
  let cursor = null
  if (request.cursor) {
    cursor = decodeWatermarkCursor(request.cursor)
    assertCursorMatchesConfig(cursor, mode, config)
  }

  if (config.type === 'monotonic_id') {
    const cursorValue = cursor
      ? normalizeWatermarkValue(config.type, cursor.value, 'cursor.value')
      : watermarkValue
    return {
      mode,
      config,
      where: { [config.field]: { $gt: cursorValue } },
      orderBy,
    }
  }

  orderBy.push({ column: config.tiebreaker, direction: 'asc' })
  if (!cursor) {
    return {
      mode,
      config,
      // Across-run store has only the timestamp, so the first page re-reads that timestamp floor
      // and lets downstream idempotency absorb already-seen rows. In-run pages use the composite cursor.
      where: { [config.field]: { $gte: watermarkValue } },
      orderBy,
    }
  }
  const cursorValue = normalizeWatermarkValue(config.type, cursor.value, 'cursor.value')
  const cursorTiebreaker = normalizeTiebreakerValue(cursor.tiebreakerValue, 'cursor.tiebreakerValue')
  return {
    mode,
    config,
    where: {
      $or: [
        { [config.field]: { $gt: cursorValue } },
        { [config.field]: cursorValue, [config.tiebreaker]: { $gt: cursorTiebreaker } },
      ],
    },
    orderBy,
  }
}

function buildNextWatermarkCursor({ mode, config, records }) {
  if (!records.length) return null
  const last = records[records.length - 1]
  const value = normalizeWatermarkValue(
    config.type,
    readRecordValue(last, config.field),
    `record.${config.field}`
  )
  const payload = {
    v: 1,
    mode,
    type: config.type,
    field: config.field,
    value,
  }
  if (config.type === 'updated_at') {
    payload.tiebreaker = config.tiebreaker
    payload.tiebreakerValue = normalizeTiebreakerValue(
      readRecordValue(last, config.tiebreaker),
      `record.${config.tiebreaker}`
    )
  }
  return encodeWatermarkCursor(payload)
}

// getSchema/getTableInfo want a BARE table name + a SEPARATE schema, but listObjects emits (and
// read/select accept) a `schema.table` qualified name. Split a single-dot qualified object back into
// { schema, table } so getTableInfo resolves the right table instead of looking for a table literally
// named "schema.table"; a bare object keeps the connection's config-level schema (if any).
function splitQualifiedObject(object, defaultSchema) {
  const dot = object.indexOf('.')
  if (dot > 0 && dot < object.length - 1 && object.indexOf('.', dot + 1) === -1) {
    return { schema: object.slice(0, dot), table: object.slice(dot + 1) }
  }
  return { schema: defaultSchema, table: object }
}

function mapColumns(columns) {
  if (!Array.isArray(columns)) return []
  return columns.map((column) => ({
    name: column && column.name,
    type: column && column.type,
    nullable: column ? column.nullable : undefined,
  }))
}

function mapObjects(schemaInfo) {
  const tables = Array.isArray(schemaInfo && schemaInfo.tables) ? schemaInfo.tables : []
  const views = Array.isArray(schemaInfo && schemaInfo.views) ? schemaInfo.views : []
  const toEntry = (entry, kind) => {
    const name = entry && (entry.schema ? `${entry.schema}.${entry.name}` : entry.name)
    return {
      name,
      label: name,
      operations: ['read'],
      source: ADAPTER_KIND,
      kind,
      schema: mapColumns(entry && entry.columns),
    }
  }
  return [...tables.map((t) => toEntry(t, 'table')), ...views.map((v) => toEntry(v, 'view'))]
}

function createDataSourceSqlReadonlySourceAdapter({ system, context, principal } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const config = normalizedSystem.config || {}
  // The integration row carries only the reference to the data source — NEVER its credentials.
  const dataSourceId = requiredString(config.dataSourceId, 'config.dataSourceId')
  const schema = optionalString(config.schema)

  return {
    async testConnection() {
      const api = getDataSourcesApi(context)
      // The read-only-source guard lives in the host facade: a writable data source fails closed in
      // authorize() on EVERY read method (test/listObjects/getSchema/read), not just here — so the
      // dry-run / pipeline read paths that never call testConnection() are covered too.
      const result = await api.test(dataSourceId, principal)
      const ok = Boolean(result && result.success === true)
      return {
        ok,
        status: ok ? 'connected' : 'error',
        connected: ok,
        message: ok ? 'Read-only SQL data source reachable' : 'Read-only SQL data source did not respond',
      }
    },

    async listObjects() {
      const api = getDataSourcesApi(context)
      const schemaInfo = await api.getSchema(dataSourceId, principal, schema)
      return mapObjects(schemaInfo)
    },

    async getSchema(input = {}) {
      const object = requiredString(input.object, 'object')
      const api = getDataSourcesApi(context)
      // A schema-qualified object (e.g. `public.items`, as listObjects emits) is split back into
      // table + schema for getTableInfo, which takes them separately; a bare object keeps config.schema.
      const { schema: effectiveSchema, table } = splitQualifiedObject(object, schema)
      const tableInfo = await api.getTableInfo(dataSourceId, table, principal, effectiveSchema)
      return {
        object,
        fields: mapColumns(tableInfo && tableInfo.columns),
      }
    },

    async read(input = {}) {
      const request = normalizeReadRequest(input)
      const api = getDataSourcesApi(context)
      const watermarkPlan = buildWatermarkReadPlan(request)
      const offset = watermarkPlan ? null : parseOffsetCursor(request.cursor)
      const selectOptions = { limit: request.limit }
      if (offset !== null) selectOptions.offset = offset
      const where = normalizeEqualityFilters(request.filters)
      const effectiveWhere = combineWhereClauses(where, watermarkPlan && watermarkPlan.where)
      if (effectiveWhere) selectOptions.where = effectiveWhere
      if (watermarkPlan) selectOptions.orderBy = watermarkPlan.orderBy
      const result = await api.select(
        dataSourceId,
        request.object,
        selectOptions,
        principal
      )
      if (result && result.error) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error))
      }
      const rows = Array.isArray(result && result.data) ? result.data : []
      const records = rows.map((row) => (isPlainObject(row) ? { ...row } : row))
      const fullPage = records.length >= request.limit
      const nextCursor = watermarkPlan && fullPage
        ? buildNextWatermarkCursor({ mode: watermarkPlan.mode, config: watermarkPlan.config, records })
        : (!watermarkPlan && fullPage ? String(offset + records.length) : null)
      return createReadResult({
        records,
        // Full page implies "maybe more"; a short page is terminal. In incremental mode the
        // next cursor is an opaque mode-tagged keyset cursor, never an offset.
        nextCursor,
        done: !fullPage,
        metadata: {
          object: request.object,
          dataSourceId,
          ...(watermarkPlan ? {
            mode: watermarkPlan.mode,
            watermarkType: watermarkPlan.config.type,
            watermarkField: watermarkPlan.config.field,
          } : { offset }),
          count: records.length,
        },
      })
    },

    // Read-only source: writing back is not supported. A pipeline using this kind as a TARGET
    // is rejected at construction by the contract's required-method check.
    upsert: unsupportedAdapterOperation(normalizedSystem.kind, 'upsert'),
  }
}

function createDataSourceSqlReadonlySourceAdapterFactory({ context } = {}) {
  // `principal` is supplied per-run by the caller (e.g. the pipeline owner `createdBy`, wired in a
  // later slice). Absent a principal, the host facade fails closed on read — no fallback identity.
  return ({ system, principal } = {}) =>
    createDataSourceSqlReadonlySourceAdapter({ system, context, principal })
}

module.exports = {
  ADAPTER_KIND,
  createDataSourceSqlReadonlySourceAdapter,
  createDataSourceSqlReadonlySourceAdapterFactory,
}
