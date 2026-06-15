import type { DataSourceManager } from './DataSourceManager'
import type { DbValue, QueryOptions, QueryResult, SchemaInfo, TableInfo } from './BaseAdapter'

/**
 * Narrow, READ-ONLY data-source surface handed to the integration plugin so the Data
 * Factory can consume a `data_sources`-registered SQL connection as an import **source**
 * (the `data-source:sql-readonly` bridge — see
 * docs/development/data-factory-sql-data-source-readonly-source-bridge-design-20260601.md).
 *
 * Two invariants make this safe to hand across the host→plugin boundary:
 *  - **Read-only by construction.** There is NO create/update/delete/credential/rotate/connect
 *    method here, so a plugin holding this facade can neither mutate data sources nor read
 *    their secrets. (The locked acceptance test asserts the returned object exposes no such key.)
 *  - **Principal-gated, fail-closed.** Every method requires an owner principal and forwards it
 *    to `DataSourceManager.assertAccess`, so a caller reaches only sources its principal owns.
 *    A missing principal throws — we NEVER substitute a default / system / tenant / admin
 *    identity (that would bypass per-source ownership).
 */
export interface DataSourceReadOnlyFacadeTestResult {
  success: boolean
}

export interface DataSourceReadOnlyFacade {
  test(dataSourceId: string, principal: string | undefined): Promise<DataSourceReadOnlyFacadeTestResult>
  getSchema(dataSourceId: string, principal: string | undefined, schema?: string): Promise<SchemaInfo>
  getTableInfo(
    dataSourceId: string,
    object: string,
    principal: string | undefined,
    schema?: string
  ): Promise<TableInfo>
  select(
    dataSourceId: string,
    table: string,
    options: Pick<QueryOptions, 'limit' | 'offset' | 'where' | 'orderBy'>,
    principal: string | undefined
  ): Promise<QueryResult<Record<string, DbValue>>>
}

export const MISSING_PRINCIPAL_MESSAGE = 'data source read requires an owner principal (none provided)'
export const DATA_SOURCE_PRINCIPAL_REQUIRED_CODE = 'DATA_SOURCE_PRINCIPAL_REQUIRED'
export const DATA_SOURCE_NOT_FOUND_CODE = 'DATA_SOURCE_NOT_FOUND'
export const DATA_SOURCE_NOT_READ_ONLY_CODE = 'DATA_SOURCE_NOT_READ_ONLY'
export const DATA_SOURCE_QUERY_INVALID_CODE = 'DATA_SOURCE_QUERY_INVALID'

export function writableSourceMessage(dataSourceId: string): string {
  return `data source '${dataSourceId}' is writable; the read-only bridge refuses a writable binding`
}

/**
 * A bound data source is dangling / not visible to the principal — i.e. `assertAccess` or
 * `getDataSource` rejected because the row was deleted OR is not owned by the caller. This is a
 * **config** error (the external-system row points at a source that isn't there for this caller),
 * not a server fault, so it must surface as a clean 4xx rather than a 500.
 *
 * It is a HTTP-agnostic *domain* error (it carries no status) — the integration plugin's central
 * `inferHttpStatus` maps the name to 422 DATA_SOURCE_UNAVAILABLE. We deliberately do NOT name it
 * `*NotFoundError`: the route URL's `:id` addresses the external system (which exists); a 404 there
 * would falsely read as "no such external system" and collide with the genuine system-missing 404.
 *
 * **No-existence-leak invariant preserved.** `assertAccess` throws the SAME uniform "not found"
 * wording for "deleted" and "not yours" so a non-owner cannot learn a source exists; this wrapper
 * re-raises that message **verbatim** (it adds a name/type only, never altering the message), so the
 * deleted-vs-not-mine cases stay indistinguishable to the caller.
 */
export class DataSourceBridgeConfigError extends Error {
  status = 422
  code: string

  constructor(code: string, message: string, name = 'DataSourceBridgeConfigError') {
    super(message)
    this.name = name
    this.code = code
  }
}

export class DataSourceUnavailableError extends DataSourceBridgeConfigError {
  constructor(message: string) {
    super(DATA_SOURCE_NOT_FOUND_CODE, message)
    this.name = 'DataSourceUnavailableError'
  }
}

function requirePrincipal(principal: string | undefined): string {
  // Fail-closed: a read MUST carry an owner principal. We deliberately do NOT fall back to a
  // default / system / tenant / admin identity — that would bypass per-source ownership.
  if (typeof principal !== 'string' || principal.trim() === '') {
    throw new DataSourceBridgeConfigError(
      DATA_SOURCE_PRINCIPAL_REQUIRED_CODE,
      MISSING_PRINCIPAL_MESSAGE,
      'DataSourcePrincipalRequiredError'
    )
  }
  return principal
}

function normalizeOrderBy(orderBy: QueryOptions['orderBy'] | undefined): QueryOptions['orderBy'] | undefined {
  if (orderBy === undefined) return undefined
  if (!Array.isArray(orderBy)) {
    throw new DataSourceBridgeConfigError(
      DATA_SOURCE_QUERY_INVALID_CODE,
      'data source read orderBy must be an array',
      'DataSourceQueryInvalidError'
    )
  }
  if (orderBy.length === 0) return undefined

  return orderBy.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_QUERY_INVALID_CODE,
        `data source read orderBy[${index}] must be an object`,
        'DataSourceQueryInvalidError'
      )
    }
    const column = (entry as { column?: unknown }).column
    const rawDirection = (entry as { direction?: unknown }).direction
    const direction = typeof rawDirection === 'string' ? rawDirection.toLowerCase() : ''
    if (typeof column !== 'string' || column.trim() === '') {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_QUERY_INVALID_CODE,
        `data source read orderBy[${index}].column must be a non-empty string`,
        'DataSourceQueryInvalidError'
      )
    }
    if (direction !== 'asc' && direction !== 'desc') {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_QUERY_INVALID_CODE,
        `data source read orderBy[${index}].direction must be asc or desc`,
        'DataSourceQueryInvalidError'
      )
    }
    return { column, direction }
  })
}

/**
 * Build the read-only facade over the shared DataSourceManager singleton. `getManager` is
 * resolved **lazily inside each call** — the plugin api surface is assembled early in startup,
 * before the db-backed manager singleton is necessarily initialized, so we must not capture the
 * manager at construction time.
 */
export function createDataSourcePluginFacade(
  getManager: () => DataSourceManager
): DataSourceReadOnlyFacade {
  async function authorize(dataSourceId: string, principal: string | undefined) {
    const owner = requirePrincipal(principal)
    const manager = getManager()
    // A dangling / not-visible binding (deleted row OR owner mismatch) is a CONFIG error, not a
    // server fault. assertAccess + getDataSource each have exactly one throw — the uniform
    // "not found" — so wrap just these two and re-raise the message VERBATIM as a named domain
    // error the integration host maps to a clean 4xx (422). Preserving the message keeps the
    // deleted-vs-not-yours cases indistinguishable: no existence leak.
    let adapter
    try {
      // Throws the uniform "not found" on owner mismatch — no existence leak.
      manager.assertAccess(dataSourceId, owner)
      adapter = manager.getDataSource(dataSourceId)
    } catch (err) {
      throw new DataSourceUnavailableError(err instanceof Error ? err.message : String(err))
    }
    // Read-only-source guard at the choke point: EVERY read method routes through authorize, so a
    // writable data source fails closed here — on getSchema/getTableInfo/select/test alike, not only
    // when testConnection happens to run first. Checked before connecting (it is a config flag).
    if (!adapter.isReadOnly()) {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_NOT_READ_ONLY_CODE,
        writableSourceMessage(dataSourceId),
        'DataSourceNotReadOnlyError'
      )
    }
    if (!adapter.isConnected()) {
      await manager.connectDataSource(dataSourceId)
    }
    return { manager, adapter }
  }

  return {
    async test(dataSourceId, principal) {
      const { adapter } = await authorize(dataSourceId, principal)
      const healthy = await adapter.testConnection()
      // A writable source already failed closed in authorize(); reaching here means read-only.
      return { success: healthy === true }
    },
    async getSchema(dataSourceId, principal, schema) {
      const { adapter } = await authorize(dataSourceId, principal)
      return adapter.getSchema(schema)
    },
    async getTableInfo(dataSourceId, object, principal, schema) {
      const { adapter } = await authorize(dataSourceId, principal)
      return adapter.getTableInfo(object, schema)
    },
    async select(dataSourceId, table, options, principal) {
      const { manager } = await authorize(dataSourceId, principal)
      // manager.select enforces the A5 row caps and is read-only; no write path is reachable here.
      const queryOptions: QueryOptions = {
        limit: options.limit,
        offset: options.offset,
      }
      if (options.where && Object.keys(options.where).length > 0) {
        queryOptions.where = options.where
      }
      const orderBy = normalizeOrderBy(options.orderBy)
      if (orderBy) {
        queryOptions.orderBy = orderBy
      }
      return manager.select<Record<string, DbValue>>(dataSourceId, table, queryOptions)
    },
  }
}
