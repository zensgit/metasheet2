import type { DataSourceManager } from './DataSourceManager'
import type { DataSourceScopeKind } from './DataSourceManager'
import {
  isC6WriteTargetConfig,
  isGenericQueryDisabledConfig,
} from './DataSourceManager'
import type { DataSourceConfig, DbValue, QueryOptions, QueryResult, SchemaInfo, TableInfo } from './BaseAdapter'
import { parseSqlServerEndpoint } from '@metasheet/mssql-readonly-utils'

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

/**
 * The DISPLAY descriptor of one data source: what an operator needs to recognize a connection on
 * a summary screen, and nothing else.
 *
 * Exactly four fields, and none of them is a connection detail: no host, port, database, schema,
 * username, connection string, options or credential state. `status` is the LIVE connection state
 * (`adapter.isConnected()`), not the `data_sources.status` column — the column is written once at
 * creation and does not track reality.
 */
export interface DataSourceDescriptor {
  id: string
  name: string
  type: string
  status: 'connected' | 'disconnected'
}

/** Values-free registration metadata used by the integration binding resolver. */
export interface DataSourceConnectionRegistration {
  id: string
  type: string
  tenantId: string | null
  scopeKind: DataSourceScopeKind
}

export interface ResolveConnectionRegistrationOptions {
  tenantId: string
  workspaceId?: string | null
  principal: string | undefined
  runAs?: 'user' | 'owner' | 'service'
}

/** The only connection material the sealed SQL Server snapshot runtime may receive. */
export interface DataSourceSealedSnapshotConnection {
  connection: {
    database: string
    encrypt: boolean
    instanceName: string | null
    port: number
    server: string
    trustServerCertificate: boolean
  }
  credentials: {
    password: string
    user: string
  }
}

/** Separate from DataSourceReadOnlyFacade because this surface carries secrets. */
export interface DataSourceSealedSnapshotConnectionFacade {
  resolveSqlServerConnection(
    dataSourceId: string,
    options: ResolveConnectionRegistrationOptions
  ): Promise<DataSourceSealedSnapshotConnection>
}

export interface DataSourceReadOnlyFacade {
  /**
   * Resolve canonical connection registration metadata without opening the
   * adapter or touching its config/credentials. This is owner-only and exact
   * tenant scoped; legacy tenantless rows are usable only by a user/owner run.
   */
  resolveConnectionRegistration(
    dataSourceId: string,
    options: ResolveConnectionRegistrationOptions
  ): Promise<DataSourceConnectionRegistration>
  /**
   * Resolve a data source id to its display descriptor, for the 对接总览 hub screen.
   *
   * AUTHORITY (aligned with #5401's visibility model): OWNER-ONLY. `principal` is passed to
   * `assertAccess` as a bare user-id string, which `normalizeActor` treats as the DATA-PLANE shape
   * — strictly owner-scoped, NO platform-admin bypass. This is deliberate and load-bearing: the
   * overview shows a NON-admin the connection name a system points at, and #5401 made non-admin
   * data-plane access owner-only, so `describe` must NOT become a side channel that reveals a
   * connection name the same non-admin could not see on `/data-sources`. A non-owner (admin or not)
   * gets the uniform DataSourceUnavailableError — deleted vs not-yours indistinguishable, no
   * existence leak — and the hub card renders 连接:已配置(他人管理) instead of a name. Management
   * visibility (an admin listing every source) stays on the management routes, never here.
   *
   * Read-only in the strongest sense available: it does NOT connect (no `connectDataSource`), does
   * NOT decrypt, and never touches `adapter.getConfig()` — the only object in this layer that
   * carries `connection` and `credentials`. Returns only {id, name, type, status}.
   */
  describe(dataSourceId: string, principal: string | undefined): Promise<DataSourceDescriptor>
  /**
   * BIND-TIME ownership probe (referential-delete guard, P2-A): asserts that
   * `principal` may reference this data source in a persisted binding
   * (integration_external_systems.config.dataSourceId) — i.e. the source
   * exists AND the principal OWNS it, the exact authorization every later
   * read through this facade enforces at runtime. Throws the facade's uniform
   * DataSourceUnavailableError (deleted vs not-yours indistinguishable — no
   * existence leak). Deliberately does NOT connect, and does NOT require the
   * source to be read-only: write-gated target bindings reference writable
   * sources.
   */
  assertReferenceable(dataSourceId: string, principal: string | undefined): Promise<void>
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
    principal: string | undefined,
    // W-5: OMITTED (or false) is byte-identical to this parameter never having existed — every
    // caller that predates it, and every caller that never passes it, behaves exactly as before.
    // `true` is a per-call, B2a-agnostic request for this facade's own hardened-read floors (see
    // `authorize`/`select` below): refuse a sqlserver source configured with requestTimeoutMs=0
    // before opening any connection, and force the existing (#5243) strict-offset-ordering check on
    // for this one read. The facade decides nothing about WHO gets to ask for `true` — that policy
    // lives at the integration-core seam that resolves an armed B2a read's source config.
    strict?: boolean
  ): Promise<QueryResult<Record<string, DbValue>>>
}

export interface DataSourceWriteFieldPolicy {
  keyFields: string[]
  writableFields: string[]
}

export interface DataSourceWriteFacadeTestResult {
  success: boolean
  capabilityState: {
    readOnly: boolean
    c6WriteTarget: boolean
    genericQueryDisabled: boolean
  }
}

export interface DataSourceWriteOperationResult {
  rowCount: number
  results: Array<QueryResult<Record<string, DbValue>>>
}

export interface DataSourceWriteFacade {
  test(dataSourceId: string, principal: string | undefined): Promise<DataSourceWriteFacadeTestResult>
  getSchema(dataSourceId: string, principal: string | undefined, schema?: string): Promise<SchemaInfo>
  getTableInfo(
    dataSourceId: string,
    object: string,
    principal: string | undefined,
    schema?: string
  ): Promise<TableInfo>
  lookupByKey(
    dataSourceId: string,
    object: string,
    key: Record<string, DbValue>,
    policy: DataSourceWriteFieldPolicy,
    principal: string | undefined
  ): Promise<QueryResult<Record<string, DbValue>>>
  insertRows(
    dataSourceId: string,
    object: string,
    rows: Array<Record<string, DbValue>>,
    policy: DataSourceWriteFieldPolicy,
    principal: string | undefined
  ): Promise<QueryResult<Record<string, DbValue>>>
  updateRows(
    dataSourceId: string,
    object: string,
    rows: Array<Record<string, DbValue>>,
    policy: DataSourceWriteFieldPolicy,
    principal: string | undefined
  ): Promise<DataSourceWriteOperationResult>
}

export const MISSING_PRINCIPAL_MESSAGE = 'data source read requires an owner principal (none provided)'
export const DATA_SOURCE_PRINCIPAL_REQUIRED_CODE = 'DATA_SOURCE_PRINCIPAL_REQUIRED'
export const DATA_SOURCE_NOT_FOUND_CODE = 'DATA_SOURCE_NOT_FOUND'
export const DATA_SOURCE_NOT_READ_ONLY_CODE = 'DATA_SOURCE_NOT_READ_ONLY'
export const DATA_SOURCE_NOT_WRITABLE_CODE = 'DATA_SOURCE_NOT_WRITABLE'
export const DATA_SOURCE_NOT_C6_WRITE_TARGET_CODE = 'DATA_SOURCE_NOT_C6_WRITE_TARGET'
export const DATA_SOURCE_QUERY_INVALID_CODE = 'DATA_SOURCE_QUERY_INVALID'
export const DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE =
  'DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID'
// W-5: thrown only when a caller opts into `select(..., strict=true)` (see `DataSourceReadOnlyFacade`
// above) AND the resolved source is a `sqlserver` data source configured with
// `connection.requestTimeoutMs=0` ("no timeout" — a legitimate, deliberate mssql convention for the
// general adapter; MSSQLAdapter.ts's `?? 30000` deliberately does not override an explicit 0). This
// facade stays B2a-agnostic: it knows only "a caller demanded a bounded-timeout read and this source
// cannot give it one", never why. The integration-core seam that sets `strict=true` is the one that
// maps this generic code onto its own fixed B2a error vocabulary.
export const DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE = 'DATA_SOURCE_REQUEST_TIMEOUT_DISABLED'

export function writableSourceMessage(dataSourceId: string): string {
  return `data source '${dataSourceId}' is writable; the read-only bridge refuses a writable binding`
}

export function requestTimeoutDisabledMessage(dataSourceId: string): string {
  return (
    `data source '${dataSourceId}' has connection.requestTimeoutMs=0 (no timeout); ` +
    'this read requires a bounded request timeout and refuses to connect'
  )
}

export function writeTargetReadOnlyMessage(dataSourceId: string): string {
  return `data source '${dataSourceId}' is read-only; the C6 write-gated target requires options.readOnly=false`
}

export function writeTargetNotC6Message(dataSourceId: string): string {
  return `data source '${dataSourceId}' is not a C6 write-gated target; c6WriteTarget and genericQueryDisabled must both be true`
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeObjectName(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DataSourceBridgeConfigError(
      DATA_SOURCE_QUERY_INVALID_CODE,
      `${field} must be a non-empty string`,
      'DataSourceQueryInvalidError'
    )
  }
  return value.trim()
}

function normalizeFieldList(fields: string[], field: string): string[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new DataSourceBridgeConfigError(
      DATA_SOURCE_QUERY_INVALID_CODE,
      `${field} must be a non-empty array`,
      'DataSourceQueryInvalidError'
    )
  }
  const seen = new Set<string>()
  const normalized: string[] = []
  fields.forEach((candidate, index) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_QUERY_INVALID_CODE,
        `${field}[${index}] must be a non-empty string`,
        'DataSourceQueryInvalidError'
      )
    }
    const name = candidate.trim()
    if (seen.has(name)) {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_QUERY_INVALID_CODE,
        `${field} must not contain duplicate fields`,
        'DataSourceQueryInvalidError'
      )
    }
    seen.add(name)
    normalized.push(name)
  })
  return normalized
}

function normalizeWritePolicy(policy: DataSourceWriteFieldPolicy): { keyFields: string[]; writableFields: string[]; allowed: Set<string> } {
  if (!isPlainObject(policy)) {
    throw new DataSourceBridgeConfigError(
      DATA_SOURCE_QUERY_INVALID_CODE,
      'field policy must be an object',
      'DataSourceQueryInvalidError'
    )
  }
  const keyFields = normalizeFieldList(policy.keyFields, 'keyFields')
  const writableFields = normalizeFieldList(policy.writableFields, 'writableFields')
  const overlap = keyFields.find((field) => writableFields.includes(field))
  if (overlap) {
    throw new DataSourceBridgeConfigError(
      DATA_SOURCE_QUERY_INVALID_CODE,
      `keyFields and writableFields must not overlap (${overlap})`,
      'DataSourceQueryInvalidError'
    )
  }
  return { keyFields, writableFields, allowed: new Set([...keyFields, ...writableFields]) }
}

function normalizeKey(
  key: Record<string, DbValue>,
  policy: ReturnType<typeof normalizeWritePolicy>
): Record<string, DbValue> {
  if (!isPlainObject(key)) {
    throw new DataSourceBridgeConfigError(
      DATA_SOURCE_QUERY_INVALID_CODE,
      'key must be an object',
      'DataSourceQueryInvalidError'
    )
  }
  const out: Record<string, DbValue> = {}
  for (const field of policy.keyFields) {
    if (!Object.prototype.hasOwnProperty.call(key, field)) {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_QUERY_INVALID_CODE,
        `key.${field} is required`,
        'DataSourceQueryInvalidError'
      )
    }
    out[field] = key[field]
  }
  for (const field of Object.keys(key)) {
    if (!policy.keyFields.includes(field)) {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_QUERY_INVALID_CODE,
        `key.${field} is not allowed`,
        'DataSourceQueryInvalidError'
      )
    }
  }
  return out
}

function normalizeWriteRows(
  rows: Array<Record<string, DbValue>>,
  policy: ReturnType<typeof normalizeWritePolicy>
): Array<{ key: Record<string, DbValue>; row: Record<string, DbValue>; data: Record<string, DbValue> }> {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DataSourceBridgeConfigError(
      DATA_SOURCE_QUERY_INVALID_CODE,
      'rows must be a non-empty array',
      'DataSourceQueryInvalidError'
    )
  }
  return rows.map((row, index) => {
    if (!isPlainObject(row)) {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_QUERY_INVALID_CODE,
        `rows[${index}] must be an object`,
        'DataSourceQueryInvalidError'
      )
    }
    for (const field of Object.keys(row)) {
      if (!policy.allowed.has(field)) {
        throw new DataSourceBridgeConfigError(
          DATA_SOURCE_QUERY_INVALID_CODE,
          `rows[${index}].${field} is not in keyFields or writableFields`,
          'DataSourceQueryInvalidError'
        )
      }
    }
    const key: Record<string, DbValue> = {}
    for (const field of policy.keyFields) {
      if (!Object.prototype.hasOwnProperty.call(row, field)) {
        throw new DataSourceBridgeConfigError(
          DATA_SOURCE_QUERY_INVALID_CODE,
          `rows[${index}].${field} is required`,
          'DataSourceQueryInvalidError'
        )
      }
      key[field] = row[field] as DbValue
    }
    const data: Record<string, DbValue> = {}
    for (const field of policy.writableFields) {
      if (Object.prototype.hasOwnProperty.call(row, field)) {
        data[field] = row[field] as DbValue
      }
    }
    if (Object.keys(data).length === 0) {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_QUERY_INVALID_CODE,
        `rows[${index}] must include at least one writable field`,
        'DataSourceQueryInvalidError'
      )
    }
    return { key, row: { ...key, ...data }, data }
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
  async function resolveRegistration(
    dataSourceId: string,
    options: ResolveConnectionRegistrationOptions | undefined
  ) {
    const principal = requirePrincipal(options?.principal)
    const requestedTenant = typeof options?.tenantId === 'string' ? options.tenantId.trim() : ''
    if (!requestedTenant) {
      throw new DataSourceUnavailableError(`Data source with id '${dataSourceId}' not found`)
    }
    const runAs = options?.runAs ?? 'service'
    if (runAs !== 'user' && runAs !== 'owner' && runAs !== 'service') {
      throw new DataSourceUnavailableError(`Data source with id '${dataSourceId}' not found`)
    }
    const manager = getManager()
    let scope
    let adapter
    try {
      manager.assertAccess(dataSourceId, principal)
      scope = manager.getScope(dataSourceId)
      adapter = manager.getDataSource(dataSourceId)
    } catch (err) {
      throw new DataSourceUnavailableError(err instanceof Error ? err.message : String(err))
    }
    if (!scope) {
      throw new DataSourceUnavailableError(`Data source with id '${dataSourceId}' not found`)
    }
    if (scope.tenantId !== null && scope.tenantId !== requestedTenant) {
      throw new DataSourceUnavailableError(`Data source with id '${dataSourceId}' not found`)
    }
    if (scope.tenantId === null && scope.scopeKind !== 'legacy_private') {
      throw new DataSourceUnavailableError(`Data source with id '${dataSourceId}' not found`)
    }
    if (scope.tenantId === null && runAs === 'service') {
      throw new DataSourceUnavailableError(`Data source with id '${dataSourceId}' not found`)
    }
    return { adapter, manager, scope }
  }

  async function authorize(dataSourceId: string, principal: string | undefined, strict = false) {
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
    // W-5 floor 1, `strict` only (default false — byte-identical to before this parameter existed):
    // a sqlserver source with requestTimeoutMs=0 refuses BEFORE the connect a few lines below, so no
    // connection is ever opened for a read that demanded a bounded timeout and cannot get one. Scoped
    // to `type === 'sqlserver'` — MSSQLAdapter's `?? 30000` no-override-on-0 convention is the only
    // place this exposure exists; every other dialect is unaffected regardless of `strict`.
    if (strict) {
      const config = adapter.getConfig()
      if (config.type === 'sqlserver') {
        const requestTimeoutMs = config.connection?.requestTimeoutMs
        if (requestTimeoutMs === 0 || requestTimeoutMs === '0') {
          throw new DataSourceBridgeConfigError(
            DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE,
            requestTimeoutDisabledMessage(dataSourceId),
            'DataSourceRequestTimeoutDisabledError'
          )
        }
      }
    }
    if (!adapter.isConnected()) {
      await manager.connectDataSource(dataSourceId)
    }
    return { manager, adapter }
  }

  return {
    async resolveConnectionRegistration(dataSourceId, options) {
      const { adapter, scope } = await resolveRegistration(dataSourceId, options)
      return {
        id: dataSourceId,
        type: adapter.getType(),
        tenantId: scope.tenantId,
        scopeKind: scope.scopeKind,
      }
    },
    async describe(dataSourceId, principal) {
      // OWNER-ONLY (see the interface doc): `owner` is a bare principal string, so #5401's
      // normalizeActor treats this as the data-plane shape — no platform-admin bypass. A non-owner
      // gets the uniform not-found and the hub renders 已配置(他人管理); describe is never a side
      // channel for a connection name the caller could not see on /data-sources.
      //
      // Deliberately NOT routed through `authorize`: that helper connects the adapter and enforces
      // the read-only-source guard, both of which are wrong here. Describing a connection must not
      // open one (a summary screen listing ten bridges would otherwise dial ten databases), and a
      // WRITABLE data source bound to a `data-source:sql-write-gated` target is a legitimate thing
      // for that screen to name — refusing it would blank out exactly the row an operator most
      // needs to see. Ownership is still enforced, by the same assertAccess every read uses.
      const owner = requirePrincipal(principal)
      const manager = getManager()
      let adapter
      try {
        manager.assertAccess(dataSourceId, owner)
        adapter = manager.getDataSource(dataSourceId)
      } catch (err) {
        throw new DataSourceUnavailableError(err instanceof Error ? err.message : String(err))
      }
      return {
        id: dataSourceId,
        name: adapter.getName(),
        type: adapter.getType(),
        status: adapter.isConnected() ? 'connected' : 'disconnected',
      }
    },
    async assertReferenceable(dataSourceId, principal) {
      // Existence + ownership ONLY — the same two throws authorize() wraps, with the same uniform
      // message. No read-only requirement (write-gated target bindings use writable sources), no
      // connect (binding metadata must not dial the customer system).
      const owner = requirePrincipal(principal)
      const manager = getManager()
      try {
        manager.assertAccess(dataSourceId, owner)
        manager.getDataSource(dataSourceId)
      } catch (err) {
        throw new DataSourceUnavailableError(err instanceof Error ? err.message : String(err))
      }
    },
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
    async select(dataSourceId, table, options, principal, strict) {
      const { manager } = await authorize(dataSourceId, principal, strict === true)
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
      // W-5 floor 2, `strict` only: forces MSSQLAdapter's own (#5243) strict-offset-ordering check
      // on for this one call, regardless of what connection.strictOffsetOrdering is configured to.
      // A no-op for every other dialect (nothing else reads this field) and a no-op whenever orderBy
      // is already set or offset is absent/0 — it only ever narrows an offset>0, no-orderBy read.
      if (strict === true) {
        queryOptions.strictOffsetOrdering = true
      }
      return manager.select<Record<string, DbValue>>(dataSourceId, table, queryOptions)
    },
  }
}

const SEALED_SQL_CONNECTION_FIELDS = new Set([
  'database',
  'encrypt',
  'host',
  'instanceName',
  'port',
  'server',
  'trustServerCertificate',
])
const SEALED_SQL_CREDENTIAL_FIELDS = new Set(['password', 'username'])

function sealedSnapshotConnectionInvalid(field: string): never {
  throw new DataSourceBridgeConfigError(
    DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE,
    `data source sealed snapshot SQL Server connection field '${field}' is not representable`,
    'DataSourceSealedSnapshotConnectionError'
  )
}

function requiredSealedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') sealedSnapshotConnectionInvalid(field)
  // Match BaseAdapter/getStringConfig: preserve the configured string verbatim. The trim above
  // is only an emptiness check; in particular, credentials may intentionally contain whitespace.
  return value
}

function projectSealedSnapshotConnection(config: DataSourceConfig): DataSourceSealedSnapshotConnection {
  if (!isPlainObject(config)) sealedSnapshotConnectionInvalid('config')
  if (!isPlainObject(config.connection)) sealedSnapshotConnectionInvalid('connection')
  if (!isPlainObject(config.credentials)) sealedSnapshotConnectionInvalid('credentials')
  for (const field of Object.keys(config.connection)) {
    if (!SEALED_SQL_CONNECTION_FIELDS.has(field)) sealedSnapshotConnectionInvalid(`connection.${field}`)
  }
  for (const field of Object.keys(config.credentials)) {
    if (!SEALED_SQL_CREDENTIAL_FIELDS.has(field)) sealedSnapshotConnectionInvalid(`credentials.${field}`)
  }

  const connection = config.connection as Record<string, unknown>
  const credentials = config.credentials as Record<string, unknown>
  const database = requiredSealedString(connection.database, 'connection.database')
  const username = requiredSealedString(credentials.username, 'credentials.username')
  const password = requiredSealedString(credentials.password, 'credentials.password')
  if (connection.encrypt !== undefined && typeof connection.encrypt !== 'boolean') {
    sealedSnapshotConnectionInvalid('connection.encrypt')
  }
  if (
    connection.trustServerCertificate !== undefined
    && typeof connection.trustServerCertificate !== 'boolean'
  ) {
    sealedSnapshotConnectionInvalid('connection.trustServerCertificate')
  }
  // MSSQLAdapter does not consume instanceName when it builds its actual pool endpoint. Returning
  // one here would therefore describe a different server than the adapter uses, so fail closed.
  if (
    Object.prototype.hasOwnProperty.call(connection, 'instanceName')
    && connection.instanceName !== null
    && connection.instanceName !== undefined
  ) {
    sealedSnapshotConnectionInvalid('connection.instanceName')
  }
  const instanceName = null

  // Match MSSQLAdapter/getNumberConfig exactly. The shared endpoint parser deliberately coerces
  // numeric strings, but the real adapter ignores them; accepting one here could make sealed and
  // ordinary reads use different ports.
  if (
    Object.prototype.hasOwnProperty.call(connection, 'port')
    && connection.port !== undefined
    && typeof connection.port !== 'number'
  ) {
    sealedSnapshotConnectionInvalid('connection.port')
  }

  let endpoint: { server: string; port?: number }
  try {
    endpoint = parseSqlServerEndpoint({
      host: connection.host,
      server: connection.server,
      port: connection.port,
    })
  } catch {
    sealedSnapshotConnectionInvalid('connection.server/port')
  }
  // A named instance may also be encoded directly in the server string (host\\instance).
  // MSSQLAdapter leaves that form to the driver, while the sealed runtime requires an explicit
  // port-or-instance projection. Defaulting it to TCP 1433 could therefore target a different
  // endpoint, so keep the two paths equivalent by refusing the ambiguous form.
  if (endpoint.server.includes('\\')) {
    sealedSnapshotConnectionInvalid('connection.server')
  }
  const port = endpoint.port ?? 1433
  return Object.freeze({
    connection: Object.freeze({
      database,
      encrypt: connection.encrypt === undefined ? true : connection.encrypt as boolean,
      instanceName,
      port,
      server: endpoint.server,
      trustServerCertificate:
        connection.trustServerCertificate === undefined
          ? true
          : connection.trustServerCertificate as boolean,
    }),
    credentials: Object.freeze({ password, user: username }),
  })
}

/**
 * Secret-bearing capability for the sealed SQL Server snapshot runtime. This is intentionally a
 * separate surface from DataSourceReadOnlyFacade: callers receive only the exact temporary
 * connection projection required by the sealed runtime, never the adapter/config object.
 */
export function createDataSourceSealedSnapshotConnectionFacade(
  getManager: () => DataSourceManager
): DataSourceSealedSnapshotConnectionFacade {
  const registrationFacade = createDataSourcePluginFacade(getManager)
  return {
    async resolveSqlServerConnection(dataSourceId, options) {
      if (options?.runAs !== 'user') sealedSnapshotConnectionInvalid('runAs')
      const registration = await registrationFacade.resolveConnectionRegistration(dataSourceId, options)
      if (typeof registration.type !== 'string' || registration.type.toLowerCase() !== 'sqlserver') {
        sealedSnapshotConnectionInvalid('type')
      }
      let adapter
      try {
        adapter = getManager().getDataSource(dataSourceId)
      } catch (err) {
        throw new DataSourceUnavailableError(err instanceof Error ? err.message : String(err))
      }
      const adapterType = adapter.getType()
      if (typeof adapterType !== 'string' || adapterType.toLowerCase() !== 'sqlserver') {
        sealedSnapshotConnectionInvalid('type')
      }
      if (!adapter.isReadOnly()) sealedSnapshotConnectionInvalid('readOnly')
      let config: DataSourceConfig
      try {
        config = adapter.getConfig()
      } catch {
        sealedSnapshotConnectionInvalid('connection')
      }
      return projectSealedSnapshotConnection(config)
    },
  }
}

export function createDataSourceWritePluginFacade(
  getManager: () => DataSourceManager
): DataSourceWriteFacade {
  async function authorize(dataSourceId: string, principal: string | undefined) {
    const owner = requirePrincipal(principal)
    const manager = getManager()
    let adapter
    try {
      manager.assertAccess(dataSourceId, owner)
      adapter = manager.getDataSource(dataSourceId)
    } catch (err) {
      throw new DataSourceUnavailableError(err instanceof Error ? err.message : String(err))
    }
    if (adapter.isReadOnly()) {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_NOT_WRITABLE_CODE,
        writeTargetReadOnlyMessage(dataSourceId),
        'DataSourceNotWritableError'
      )
    }
    const config = adapter.getConfig()
    if (!isC6WriteTargetConfig(config) || !isGenericQueryDisabledConfig(config)) {
      throw new DataSourceBridgeConfigError(
        DATA_SOURCE_NOT_C6_WRITE_TARGET_CODE,
        writeTargetNotC6Message(dataSourceId),
        'DataSourceNotC6WriteTargetError'
      )
    }
    if (!adapter.isConnected()) {
      await manager.connectDataSource(dataSourceId)
    }
    return {
      manager,
      adapter,
      capabilityState: {
        readOnly: adapter.isReadOnly(),
        c6WriteTarget: isC6WriteTargetConfig(config),
        genericQueryDisabled: isGenericQueryDisabledConfig(config),
      },
    }
  }

  return {
    async test(dataSourceId, principal) {
      const { adapter, capabilityState } = await authorize(dataSourceId, principal)
      const healthy = await adapter.testConnection()
      return { success: healthy === true, capabilityState }
    },
    async getSchema(dataSourceId, principal, schema) {
      const { adapter } = await authorize(dataSourceId, principal)
      return adapter.getSchema(schema)
    },
    async getTableInfo(dataSourceId, object, principal, schema) {
      const { adapter } = await authorize(dataSourceId, principal)
      return adapter.getTableInfo(object, schema)
    },
    async lookupByKey(dataSourceId, object, key, policy, principal) {
      const normalizedObject = normalizeObjectName(object, 'object')
      const normalizedPolicy = normalizeWritePolicy(policy)
      const where = normalizeKey(key, normalizedPolicy)
      const { manager } = await authorize(dataSourceId, principal)
      return manager.select<Record<string, DbValue>>(dataSourceId, normalizedObject, {
        limit: 2,
        where,
      })
    },
    async insertRows(dataSourceId, object, rows, policy, principal) {
      const normalizedObject = normalizeObjectName(object, 'object')
      const normalizedPolicy = normalizeWritePolicy(policy)
      const normalizedRows = normalizeWriteRows(rows, normalizedPolicy)
      const { manager } = await authorize(dataSourceId, principal)
      return manager.insert<Record<string, DbValue>>(
        dataSourceId,
        normalizedObject,
        normalizedRows.map((entry) => entry.row)
      )
    },
    async updateRows(dataSourceId, object, rows, policy, principal) {
      const normalizedObject = normalizeObjectName(object, 'object')
      const normalizedPolicy = normalizeWritePolicy(policy)
      const normalizedRows = normalizeWriteRows(rows, normalizedPolicy)
      const { manager } = await authorize(dataSourceId, principal)
      const results: Array<QueryResult<Record<string, DbValue>>> = []
      for (const entry of normalizedRows) {
        results.push(await manager.update<Record<string, DbValue>>(
          dataSourceId,
          normalizedObject,
          entry.data,
          entry.key
        ))
      }
      return { rowCount: normalizedRows.length, results }
    },
  }
}
