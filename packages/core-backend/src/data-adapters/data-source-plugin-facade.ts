import type { DataSourceManager } from './DataSourceManager'
import type { DbValue, QueryResult, SchemaInfo, TableInfo } from './BaseAdapter'

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
    options: { limit?: number; offset?: number },
    principal: string | undefined
  ): Promise<QueryResult<Record<string, DbValue>>>
}

export const MISSING_PRINCIPAL_MESSAGE = 'data source read requires an owner principal (none provided)'

export function writableSourceMessage(dataSourceId: string): string {
  return `data source '${dataSourceId}' is writable; the read-only bridge refuses a writable binding`
}

function requirePrincipal(principal: string | undefined): string {
  // Fail-closed: a read MUST carry an owner principal. We deliberately do NOT fall back to a
  // default / system / tenant / admin identity — that would bypass per-source ownership.
  if (typeof principal !== 'string' || principal.trim() === '') {
    throw new Error(MISSING_PRINCIPAL_MESSAGE)
  }
  return principal
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
    // Throws the uniform "not found" on owner mismatch — no existence leak.
    manager.assertAccess(dataSourceId, owner)
    const adapter = manager.getDataSource(dataSourceId)
    // Read-only-source guard at the choke point: EVERY read method routes through authorize, so a
    // writable data source fails closed here — on getSchema/getTableInfo/select/test alike, not only
    // when testConnection happens to run first. Checked before connecting (it is a config flag).
    if (!adapter.isReadOnly()) {
      throw new Error(writableSourceMessage(dataSourceId))
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
      return manager.select<Record<string, DbValue>>(dataSourceId, table, {
        limit: options.limit,
        offset: options.offset,
      })
    },
  }
}
