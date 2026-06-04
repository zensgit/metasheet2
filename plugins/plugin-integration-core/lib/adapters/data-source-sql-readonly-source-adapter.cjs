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

const ADAPTER_KIND = 'data-source:sql-readonly'

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
  const numeric = Number(cursor)
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new AdapterValidationError('cursor must be a non-negative offset', { field: 'cursor' })
  }
  return numeric
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
      const offset = parseOffsetCursor(request.cursor)
      const selectOptions = { limit: request.limit, offset }
      const where = normalizeEqualityFilters(request.filters)
      if (where) selectOptions.where = where
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
      const nextOffset = offset + records.length
      return createReadResult({
        records,
        // Offset paging: a full page implies "maybe more"; a short page is terminal (done).
        nextCursor: records.length >= request.limit ? String(nextOffset) : null,
        done: records.length < request.limit,
        metadata: {
          object: request.object,
          dataSourceId,
          offset,
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
