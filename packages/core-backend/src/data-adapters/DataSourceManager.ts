import { EventEmitter } from 'eventemitter3'
import type { Kysely } from 'kysely'
import type { BaseDataAdapter, DataSourceConfig, QueryOptions, QueryResult, DbValue, WhereValue, ConnectionConfig, Credentials, AdapterOptions } from './BaseAdapter'
import { PostgresAdapter } from './PostgresAdapter'
import { HTTPAdapter } from './HTTPAdapter'
import { MSSQLAdapter } from './MSSQLAdapter'
import { encryptStoredSecretValue, decryptStoredSecretValue, isEncryptedSecretValue } from '../security/encrypted-secrets'

// Credential fields that hold secrets and are encrypted at rest. Identifiers
// like `username` are left as-is (matching the codebase's encrypt-secrets-only
// convention).
const SENSITIVE_CREDENTIAL_KEYS = ['password', 'apiKey', 'token']
export const SUPPORTED_DATA_SOURCE_TYPES = ['postgresql', 'postgres', 'http', 'sqlserver'] as const

type AdapterConstructor = new (config: DataSourceConfig) => BaseDataAdapter

// Database record types
interface DataSourceRecord {
  id: string
  name: string
  type: string
  description: string | null
  config: unknown // JSONB
  status: string
  last_connected_at: Date | null
  last_error: string | null
  owner_id: string
  workspace_id: string | null
  is_active: boolean
  auto_connect: boolean
  metadata: unknown | null
  tags: unknown | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export interface DataSourceManagerOptions {
  db?: Kysely<unknown>
  autoLoadFromDb?: boolean
}

export class DataSourceManager extends EventEmitter {
  private adapters: Map<string, BaseDataAdapter> = new Map()
  private adapterTypes: Map<string, AdapterConstructor> = new Map()
  private connectionPool: Map<string, Promise<void>> = new Map()
  // Per-source ownership for scope enforcement (A0.1). Owner is the enforced
  // boundary this slice; workspace is stored for a future workspace-shared model.
  private scopes: Map<string, { ownerId: string; workspaceId: string | null }> = new Map()
  private db?: Kysely<unknown>
  private initialized = false

  constructor(options: DataSourceManagerOptions = {}) {
    super()
    this.db = options.db
    this.registerDefaultAdapters()

    // Auto-load from database if db is provided
    if (options.autoLoadFromDb && this.db) {
      this.loadFromDatabase().catch((err) => {
        console.error('[DataSourceManager] Failed to auto-load from database:', err)
      })
    }
  }

  /**
   * Initialize with database connection (for late binding)
   */
  async initialize(db: Kysely<unknown>): Promise<void> {
    this.db = db
    await this.loadFromDatabase()
    this.initialized = true
  }

  /**
   * Load all active data sources from database
   */
  async loadFromDatabase(): Promise<void> {
    if (!this.db) {
      console.warn('[DataSourceManager] No database connection, skipping load')
      return
    }

    try {
      const records = await this.db
        .selectFrom('data_sources' as never)
        .selectAll()
        .where('is_active' as never, '=', true as never)
        .where('deleted_at' as never, 'is', null as never)
        .execute() as DataSourceRecord[]

      let loadedCount = 0
      for (const record of records) {
        try {
          if (!this.adapterTypes.has(record.type.toLowerCase())) {
            throw new Error(`Unsupported persisted data source type: ${record.type}`)
          }
          const config = this.recordToConfig(record)
          await this.addDataSourceInternal(config, false) // Don't persist again
          // Ownership lives on the DB record, not in config (recordToConfig strips it)
          this.scopes.set(record.id, {
            ownerId: record.owner_id,
            workspaceId: record.workspace_id ?? null
          })

          if (record.auto_connect) {
            await this.connectDataSource(config.id).catch((err) => {
              console.error(`[DataSourceManager] Auto-connect failed for ${config.id}:`, err)
            })
          }
          loadedCount += 1
        } catch (err) {
          console.error(`[DataSourceManager] Failed to load data source ${record.id}:`, err)
        }
      }

      const skippedCount = records.length - loadedCount
      console.log(`[DataSourceManager] Loaded ${loadedCount} data sources from database${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}`)
    } catch (err) {
      // Table might not exist yet
      console.warn('[DataSourceManager] Could not load from database:', err)
    }
  }

  /**
   * Encrypt secret credential fields for storage (A1). Uses
   * encryptStoredSecretValue (NOT normalize) so secret values are not trimmed —
   * a trailing space in a password is significant. ALWAYS encrypts: it does NOT
   * use the enc: prefix to detect "already encrypted", because a real plaintext
   * secret can legitimately start with "enc:". Callers always pass plaintext
   * credentials — user input on create, and the preserved or freshly-decrypted
   * value on update/load — so there is nothing already-encrypted to skip.
   */
  private encryptCredentials(creds?: Credentials): Credentials | undefined {
    if (!creds) return creds
    const out: Credentials = { ...creds }
    for (const key of SENSITIVE_CREDENTIAL_KEYS) {
      const v = out[key]
      if (typeof v === 'string' && v.length > 0) {
        out[key] = encryptStoredSecretValue(v)
      }
    }
    return out
  }

  /**
   * Decrypt secret credential fields after load (A1). Encrypted values are
   * decrypted and FAIL LOUD on a key mismatch (a ciphertext is never passed
   * through to the adapter). Legacy plaintext passes through unchanged — lazy
   * migration: it is re-encrypted on the next persist.
   */
  private decryptCredentials(creds?: Credentials): Credentials | undefined {
    if (!creds) return creds
    const out: Credentials = { ...creds }
    for (const key of SENSITIVE_CREDENTIAL_KEYS) {
      const v = out[key]
      if (typeof v === 'string' && isEncryptedSecretValue(v)) {
        try {
          out[key] = decryptStoredSecretValue(v)
        } catch (err) {
          throw new Error(
            `Failed to decrypt credential '${key}' (ENCRYPTION_KEY may have changed): ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    }
    return out
  }

  private recordToConfig(record: DataSourceRecord): DataSourceConfig {
    const configData = record.config as Record<string, unknown>
    return {
      id: record.id,
      name: record.name,
      type: record.type,
      connection: (configData.connection || {}) as ConnectionConfig,
      credentials: this.decryptCredentials(configData.credentials as Credentials | undefined),
      options: configData.options as AdapterOptions | undefined,
      poolConfig: configData.poolConfig as DataSourceConfig['poolConfig']
    }
  }

  private configToRecord(
    config: DataSourceConfig,
    ownerId: string,
    workspaceId?: string
  ): Omit<DataSourceRecord, 'created_at' | 'updated_at' | 'deleted_at' | 'last_connected_at' | 'last_error'> {
    return {
      id: config.id,
      name: config.name,
      type: config.type,
      description: null,
      config: {
        connection: config.connection,
        credentials: this.encryptCredentials(config.credentials),
        options: config.options,
        poolConfig: config.poolConfig
      },
      status: 'disconnected',
      owner_id: ownerId,
      workspace_id: workspaceId || null,
      is_active: true,
      auto_connect: config.options?.autoConnect === true,
      metadata: null,
      tags: null
    }
  }

  private registerDefaultAdapters(): void {
    // A4: public support is intentionally narrowed to the verified runtime set.
    this.registerAdapterType('postgresql', PostgresAdapter as unknown as AdapterConstructor)
    this.registerAdapterType('postgres', PostgresAdapter as unknown as AdapterConstructor)
    this.registerAdapterType('http', HTTPAdapter as unknown as AdapterConstructor)
    this.registerAdapterType('sqlserver', MSSQLAdapter as unknown as AdapterConstructor)
  }

  registerAdapterType(type: string, adapterClass: AdapterConstructor): void {
    this.adapterTypes.set(type.toLowerCase(), adapterClass)
  }

  /**
   * Add a new data source (with optional persistence)
   */
  async addDataSource(
    config: DataSourceConfig,
    options?: { ownerId?: string; workspaceId?: string; persist?: boolean }
  ): Promise<BaseDataAdapter> {
    // Reject duplicates BEFORE persisting — otherwise a create that will be
    // rejected still runs the upsert and overwrites the existing row's config
    // and owner. Use updateDataSource() to change an existing source.
    if (this.adapters.has(config.id)) {
      throw new Error(`Data source with id '${config.id}' already exists`)
    }

    const persist = options?.persist !== false && this.db !== undefined
    const ownerId = options?.ownerId || 'system'
    const workspaceId = options?.workspaceId

    // Persist to database first (if enabled)
    if (persist && this.db) {
      await this.persistDataSource(config, ownerId, workspaceId)
    }

    const adapter = await this.addDataSourceInternal(config, false)
    this.scopes.set(config.id, { ownerId, workspaceId: workspaceId ?? null })
    return adapter
  }

  /**
   * Atomically update an existing data source. Persists the new config first
   * (the only failure-prone step); the live adapter is swapped only after that
   * succeeds. A failed update therefore leaves the original source intact —
   * unlike a removeDataSource()+addDataSource() sequence, which soft-deletes
   * the row and drops the adapter before the re-add can fail.
   */
  async updateDataSource(
    id: string,
    config: DataSourceConfig,
    options?: { ownerId?: string; workspaceId?: string }
  ): Promise<BaseDataAdapter> {
    const existing = this.adapters.get(id)
    if (!existing) {
      throw new Error(`Data source with id '${id}' not found`)
    }
    const priorScope = this.scopes.get(id)
    const ownerId = options?.ownerId ?? priorScope?.ownerId ?? 'system'
    const workspaceId = options?.workspaceId ?? priorScope?.workspaceId ?? undefined

    // Validate the target type before touching anything live.
    if (!this.adapterTypes.get(config.type.toLowerCase())) {
      throw new Error(`Unsupported data source type: ${config.type}`)
    }

    // Persist first — if this throws, the live source is untouched.
    if (this.db !== undefined) {
      await this.persistDataSource(config, ownerId, workspaceId)
    }

    // Persist succeeded: swap the in-memory adapter (no further failure-prone I/O).
    try {
      if (existing.isConnected()) {
        await existing.disconnect()
      }
    } catch {
      // best-effort teardown of the previous adapter
    }
    existing.removeAllListeners()
    this.adapters.delete(id)
    this.connectionPool.delete(id)

    const adapter = await this.addDataSourceInternal(config, false)
    this.scopes.set(id, { ownerId, workspaceId: workspaceId ?? null })
    return adapter
  }

  /**
   * Assert the requester owns this data source (A0.1 scope enforcement).
   * Throws the same "not found" wording as getDataSource so callers return a
   * uniform 404 — a non-owner must not learn that someone else's source exists.
   */
  assertAccess(id: string, ownerId: string | undefined): void {
    const scope = this.scopes.get(id)
    if (!this.adapters.has(id) || !scope || scope.ownerId !== ownerId) {
      throw new Error(`Data source with id '${id}' not found`)
    }
  }

  /** Stored ownership scope for a data source, if present. */
  getScope(id: string): { ownerId: string; workspaceId: string | null } | undefined {
    return this.scopes.get(id)
  }

  /**
   * Internal method to add data source to memory
   */
  private async addDataSourceInternal(
    config: DataSourceConfig,
    autoConnect = true
  ): Promise<BaseDataAdapter> {
    if (this.adapters.has(config.id)) {
      throw new Error(`Data source with id '${config.id}' already exists`)
    }

    const AdapterClass = this.adapterTypes.get(config.type.toLowerCase())
    if (!AdapterClass) {
      throw new Error(`Unsupported data source type: ${config.type}`)
    }

    const adapter = new AdapterClass(config)

    // Set up event forwarding
    adapter.on('connected', (data) => {
      this.emit('adapter:connected', { ...data, id: config.id })
      this.updateStatus(config.id, 'connected').catch(() => {})
    })
    adapter.on('disconnected', (data) => {
      this.emit('adapter:disconnected', { ...data, id: config.id })
      this.updateStatus(config.id, 'disconnected').catch(() => {})
    })
    adapter.on('error', (data) => {
      this.emit('adapter:error', { ...data, id: config.id })
      this.updateStatus(config.id, 'error', (data as { error?: string }).error).catch(() => {})
    })

    this.adapters.set(config.id, adapter)

    // Auto-connect if specified
    if (autoConnect && config.options?.autoConnect !== false) {
      await this.connectDataSource(config.id)
    }

    return adapter
  }

  /**
   * Persist data source to database
   */
  private async persistDataSource(
    config: DataSourceConfig,
    ownerId: string,
    workspaceId?: string
  ): Promise<void> {
    if (!this.db) return

    const record = this.configToRecord(config, ownerId, workspaceId)

    await this.db
      .insertInto('data_sources' as never)
      .values(record as never)
      .onConflict((oc) =>
        oc.column('id' as never).doUpdateSet({
          name: record.name,
          type: record.type,
          config: record.config,
          owner_id: record.owner_id,
          workspace_id: record.workspace_id,
          status: record.status,
          auto_connect: record.auto_connect,
          // Revive a previously soft-deleted row (remove() sets these) so an
          // updated or recreated-with-same-id source survives a restart.
          is_active: true,
          deleted_at: null,
          updated_at: new Date()
        } as never)
      )
      .execute()
  }

  /**
   * Update data source status in database
   */
  private async updateStatus(
    id: string,
    status: string,
    error?: string
  ): Promise<void> {
    if (!this.db) return

    try {
      const updateData: Record<string, unknown> = {
        status,
        updated_at: new Date()
      }

      if (status === 'connected') {
        updateData.last_connected_at = new Date()
        updateData.last_error = null
      } else if (status === 'error' && error) {
        updateData.last_error = error
      }

      await this.db
        .updateTable('data_sources' as never)
        .set(updateData as never)
        .where('id' as never, '=', id as never)
        .execute()
    } catch (err) {
      // Non-critical, log and continue
      console.warn(`[DataSourceManager] Failed to update status for ${id}:`, err)
    }
  }

  async removeDataSource(id: string, options?: { hardDelete?: boolean }): Promise<void> {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      throw new Error(`Data source with id '${id}' not found`)
    }

    if (adapter.isConnected()) {
      await adapter.disconnect()
    }

    adapter.removeAllListeners()
    this.adapters.delete(id)
    this.connectionPool.delete(id)
    this.scopes.delete(id)

    // Soft delete from database (or hard delete if specified)
    if (this.db) {
      try {
        if (options?.hardDelete) {
          await this.db
            .deleteFrom('data_sources' as never)
            .where('id' as never, '=', id as never)
            .execute()
        } else {
          await this.db
            .updateTable('data_sources' as never)
            .set({
              deleted_at: new Date(),
              is_active: false,
              updated_at: new Date()
            } as never)
            .where('id' as never, '=', id as never)
            .execute()
        }
      } catch (err) {
        console.warn(`[DataSourceManager] Failed to delete from database: ${id}`, err)
      }
    }
  }

  getDataSource(id: string): BaseDataAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      throw new Error(`Data source with id '${id}' not found`)
    }
    return adapter
  }

  async connectDataSource(id: string): Promise<void> {
    const adapter = this.getDataSource(id)

    // Reuse existing connection promise if connecting
    let connectionPromise = this.connectionPool.get(id)
    if (connectionPromise) {
      return connectionPromise
    }

    connectionPromise = adapter.connect()
    this.connectionPool.set(id, connectionPromise)

    try {
      await connectionPromise
    } finally {
      this.connectionPool.delete(id)
    }
  }

  async disconnectDataSource(id: string): Promise<void> {
    const adapter = this.getDataSource(id)
    await adapter.disconnect()
  }

  // A3: returns success + the redacted failure cause. Ensures a connection is attempted (so the
  // operator learns WHY it fails), then probes. The adapter stays Promise<boolean>; it records the
  // redacted cause in `connectionError` (via onError) which we aggregate here.
  async testConnection(id: string): Promise<{ success: boolean; error?: string }> {
    const adapter = this.getDataSource(id)
    try {
      if (!adapter.isConnected()) {
        await adapter.connect() // throws on failure; onError has recorded the redacted cause
      }
    } catch {
      return { success: false, error: adapter.connectionError ?? undefined }
    }
    const ok = await adapter.testConnection()
    return ok ? { success: true } : { success: false, error: adapter.connectionError ?? undefined }
  }

  // Query routing methods
  async query<T = Record<string, DbValue>>(
    dataSourceId: string,
    sql: string,
    params?: DbValue[]
  ): Promise<QueryResult<T>> {
    const adapter = this.getDataSource(dataSourceId)

    if (!adapter.isConnected()) {
      await this.connectDataSource(dataSourceId)
    }

    return adapter.query<T>(sql, params)
  }

  async select<T = Record<string, DbValue>>(
    dataSourceId: string,
    table: string,
    options?: QueryOptions
  ): Promise<QueryResult<T>> {
    const adapter = this.getDataSource(dataSourceId)

    if (!adapter.isConnected()) {
      await this.connectDataSource(dataSourceId)
    }

    return adapter.select<T>(table, options)
  }

  async insert<T = Record<string, DbValue>>(
    dataSourceId: string,
    table: string,
    data: Record<string, DbValue> | Record<string, DbValue>[]
  ): Promise<QueryResult<T>> {
    const adapter = this.getDataSource(dataSourceId)
    adapter.assertWritable() // defense-in-depth: reject mutations on a read-only source

    if (!adapter.isConnected()) {
      await this.connectDataSource(dataSourceId)
    }

    return adapter.insert<T>(table, data)
  }

  async update<T = Record<string, DbValue>>(
    dataSourceId: string,
    table: string,
    data: Record<string, DbValue>,
    where: Record<string, WhereValue>
  ): Promise<QueryResult<T>> {
    const adapter = this.getDataSource(dataSourceId)
    adapter.assertWritable() // defense-in-depth: reject mutations on a read-only source

    if (!adapter.isConnected()) {
      await this.connectDataSource(dataSourceId)
    }

    return adapter.update<T>(table, data, where)
  }

  async delete<T = Record<string, DbValue>>(
    dataSourceId: string,
    table: string,
    where: Record<string, WhereValue>
  ): Promise<QueryResult<T>> {
    const adapter = this.getDataSource(dataSourceId)
    adapter.assertWritable() // defense-in-depth: reject mutations on a read-only source

    if (!adapter.isConnected()) {
      await this.connectDataSource(dataSourceId)
    }

    return adapter.delete<T>(table, where)
  }

  // Cross-database operations
  async copyData(
    sourceId: string,
    sourceTable: string,
    targetId: string,
    targetTable: string,
    options?: {
      where?: Record<string, WhereValue>
      batchSize?: number
      transform?: (row: Record<string, DbValue>) => Record<string, DbValue>
    }
  ): Promise<{ totalRows: number; duration: number }> {
    const startTime = Date.now()
    const sourceAdapter = this.getDataSource(sourceId)
    const targetAdapter = this.getDataSource(targetId)

    if (!sourceAdapter.isConnected()) {
      await this.connectDataSource(sourceId)
    }
    if (!targetAdapter.isConnected()) {
      await this.connectDataSource(targetId)
    }

    const batchSize = options?.batchSize || 1000
    let offset = 0
    let totalRows = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await sourceAdapter.select(sourceTable, {
        where: options?.where,
        limit: batchSize,
        offset
      })

      if (result.data.length === 0) {
        break
      }

      let data = result.data
      if (options?.transform) {
        data = data.map(options.transform)
      }

      await targetAdapter.insert(targetTable, data)
      totalRows += data.length
      offset += batchSize

      this.emit('copy:progress', {
        sourceId,
        targetId,
        totalRows,
        currentBatch: data.length
      })
    }

    const duration = Date.now() - startTime
    return { totalRows, duration }
  }

  // Federation query (simple JOIN across databases)
  async federatedQuery<T = Record<string, DbValue>>(
    queries: Array<{
      dataSourceId: string
      sql: string
      params?: DbValue[]
      alias: string
    }>,
    joinLogic?: (results: Map<string, Record<string, DbValue>[]>) => T[]
  ): Promise<T[]> {
    const results = new Map<string, Record<string, DbValue>[]>()

    // Execute queries in parallel
    const promises = queries.map(async ({ dataSourceId, sql, params, alias }) => {
      const adapter = this.getDataSource(dataSourceId)

      if (!adapter.isConnected()) {
        await this.connectDataSource(dataSourceId)
      }

      const result = await adapter.query(sql, params)
      results.set(alias, result.data)
    })

    await Promise.all(promises)

    // Apply join logic if provided, otherwise return concatenated results
    if (joinLogic) {
      return joinLogic(results)
    }

    // Default: concatenate all results
    const allResults: T[] = []
    for (const data of results.values()) {
      allResults.push(...(data as T[]))
    }
    return allResults
  }

  // Management methods
  listDataSources(filter?: { ownerId?: string }): Array<{
    id: string
    name: string
    type: string
    connected: boolean
  }> {
    const sources: Array<{
      id: string
      name: string
      type: string
      connected: boolean
    }> = []

    for (const [id, adapter] of this.adapters) {
      // A0.1: when an owner filter is supplied, only that owner's sources are listed
      if (filter?.ownerId !== undefined) {
        const scope = this.scopes.get(id)
        if (!scope || scope.ownerId !== filter.ownerId) {
          continue
        }
      }
      sources.push({
        id,
        name: adapter.getName(),
        type: adapter.getType(),
        connected: adapter.isConnected()
      })
    }

    return sources
  }

  async healthCheck(): Promise<Map<string, {
    connected: boolean
    responsive: boolean
    latency?: number
  }>> {
    const health = new Map<string, {
      connected: boolean
      responsive: boolean
      latency?: number
    }>()

    for (const [id, adapter] of this.adapters) {
      const startTime = Date.now()
      const connected = adapter.isConnected()
      let responsive = false

      if (connected) {
        try {
          responsive = await adapter.testConnection()
        } catch {
          responsive = false
        }
      }

      health.set(id, {
        connected,
        responsive,
        latency: connected ? Date.now() - startTime : undefined
      })
    }

    return health
  }

  async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = []

    for (const [_id, adapter] of this.adapters) {
      if (adapter.isConnected()) {
        promises.push(adapter.disconnect())
      }
    }

    await Promise.all(promises)
  }

  async dispose(): Promise<void> {
    await this.disconnectAll()
    this.adapters.clear()
    this.adapterTypes.clear()
    this.connectionPool.clear()
    this.scopes.clear()
    this.removeAllListeners()
  }
}
