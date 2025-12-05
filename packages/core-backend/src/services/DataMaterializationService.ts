/**
 * Data Materialization Service with CDC Support
 * Handles data synchronization between external sources and local tables
 */

import { EventEmitter } from 'events'
import { db } from '../db/kysely'
import { sql } from 'kysely'
import { Logger } from '../core/logger'
// Note: Selectable and ExternalTablesTable types are available for future use
// import type { Selectable } from 'kysely'
// import type { ExternalTablesTable } from '../db/types'

// CronJob type for optional dependency
interface CronJobLike {
  start(): void
  stop(): void
}

// Dynamic import for optional cron dependency
let CronJob: (new (pattern: string, callback: () => void) => CronJobLike) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const cron = require('cron')
  CronJob = cron.CronJob
} catch {
  // cron not installed - scheduled syncs will be disabled
}

// Type for adapter configuration
interface AdapterConfig {
  host?: string
  port?: number
  database?: string
  username?: string
  password?: string
  url?: string
  [key: string]: unknown
}

// Type for query where clauses
interface QueryWhereClause {
  [field: string]: unknown | { $gt: Date | string | number } | { $lt: Date | string | number }
}

// Adapter interface for CDC support
interface DataSourceAdapter {
  getChanges?(options: { table: string; schema?: string; since?: Date }): Promise<ChangeEvent[]>
  subscribeToCDC?(options: { table: string; schema?: string; callback: (change: ChangeEvent) => Promise<void> }): Promise<{ unsubscribe: () => Promise<void> }>
  query(options: { table: string; schema?: string; where?: QueryWhereClause; orderBy?: string }): Promise<Record<string, unknown>[]>
  connect(): Promise<void>
  disconnect(): Promise<void>
}

// Dynamic adapter imports - soft dependencies
let PostgresAdapter: (new (config: AdapterConfig) => DataSourceAdapter) | null = null
let MySQLAdapter: (new (config: AdapterConfig) => DataSourceAdapter) | null = null
let MongoDBAdapter: (new (config: AdapterConfig) => DataSourceAdapter) | null = null
let HTTPAdapter: (new (config: AdapterConfig) => DataSourceAdapter) | null = null

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  PostgresAdapter = require('../data-adapters/PostgresAdapter').PostgresAdapter
} catch { /* optional */ }
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  MySQLAdapter = require('../data-adapters/MySQLAdapter').MySQLAdapter
} catch { /* optional */ }
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  MongoDBAdapter = require('../data-adapters/MongoDBAdapter').MongoDBAdapter
} catch { /* optional */ }
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  HTTPAdapter = require('../data-adapters/HTTPAdapter').HTTPAdapter
} catch { /* optional */ }

// Sync mode types - application-level sync modes
export type SyncMode = 'FULL' | 'INCREMENTAL' | 'CDC' | 'UPSERT' | 'LAZY' | 'EAGER' | 'SCHEDULED' | 'REALTIME'

// Database sync mode - stored in sync_config JSON field
type DbSyncMode = 'LAZY' | 'EAGER' | 'SCHEDULED' | 'REALTIME'

// Sync config structure as stored in database JSON field
interface SyncConfigJson {
  schema?: string
  primaryKey?: string
  mode?: DbSyncMode
  interval?: number
  fieldMappings?: Record<string, string>
  transformRules?: TransformRule[]
  [key: string]: unknown
}

// CDC event types
export type CDCEvent = 'INSERT' | 'UPDATE' | 'DELETE'

// Materialization configuration
export interface MaterializationConfig {
  id?: string
  name: string
  sourceId: string
  targetTableId: string
  syncMode: SyncMode
  syncInterval?: number // seconds

  // Source configuration
  sourceSchema?: string
  sourceTable: string
  sourceQuery?: string // Custom query instead of table

  // Field mapping
  fieldMappings: Record<string, string>
  transformRules?: TransformRule[]

  // Sync options
  batchSize?: number
  cdcEnabled?: boolean
  cdcColumn?: string // Timestamp column for CDC
  primaryKey?: string

  // Conflict resolution
  conflictResolution?: 'OVERWRITE' | 'MERGE' | 'SKIP' | 'ERROR'
  mergeFields?: string[]
}

// Transform config types for different rule types
interface RenameConfig {
  newName: string
}

interface CastConfig {
  type: 'string' | 'number' | 'boolean' | 'date' | 'json'
}

interface FormulaConfig {
  formula: string
}

interface LookupConfig {
  table: string
  key: string
  value: string
}

interface AggregateConfig {
  function: 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT' | 'CONCAT'
  fields: string[]
}

// Union type for all transform configs
type TransformConfig = RenameConfig | CastConfig | FormulaConfig | LookupConfig | AggregateConfig

// Transform rule for data transformation
export interface TransformRule {
  field: string
  type: 'RENAME' | 'CAST' | 'FORMULA' | 'LOOKUP' | 'AGGREGATE'
  config: TransformConfig
}

// CDC change event
export interface ChangeEvent {
  type: CDCEvent
  table: string
  primaryKey: unknown
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  timestamp: Date
}

// Sync result
export interface SyncResult {
  success: boolean
  recordsProcessed: number
  recordsInserted: number
  recordsUpdated: number
  recordsDeleted: number
  errors: string[]
  duration: number
  nextSync?: Date
}

// CDC Listener interface
interface CDCListener {
  unsubscribe: () => Promise<void>
}

// Extended external table config with parsed JSON fields
// These fields are stored in sync_config JSON but code expects them at top level
interface MaterializationDbConfig {
  id: string
  data_source_id: string
  table_id: string | null
  external_table: string
  external_schema: string | null
  external_primary_key: string | null
  sync_mode: DbSyncMode
  sync_interval: number | null
  field_mappings: Record<string, string>
  transform_rules: TransformRule[]
  last_sync: Date | null
}

/**
 * Data Materialization Service
 */
export class DataMaterializationService extends EventEmitter {
  private adapters: Map<string, DataSourceAdapter> = new Map()
  private syncJobs: Map<string, CronJobLike> = new Map()
  private cdcListeners: Map<string, CDCListener> = new Map()
  private syncInProgress: Set<string> = new Set()
  private logger = new Logger('DataMaterializationService')

  constructor() {
    super()
    this.initialize()
  }

  private async initialize() {
    // Load existing materialization configs
    if (!db) return

    try {
      const configs = await db
        .selectFrom('external_tables')
        .innerJoin('data_sources', 'data_sources.id', 'external_tables.data_source_id')
        .selectAll()
        .execute()

      for (const config of configs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const syncConfig = (config.sync_config || {}) as any
        const syncMode = syncConfig.mode as DbSyncMode | undefined
        const syncInterval = syncConfig.interval as number | undefined

        if (syncMode === 'SCHEDULED' && syncInterval) {
          this.scheduleSync(config.id, syncInterval)
        }

        if (syncMode === 'REALTIME') {
          await this.setupCDC(config.id)
        }
      }
    } catch (error) {
      this.logger.error('Failed to initialize materialization service', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Create a new materialization
   */
  async createMaterialization(config: MaterializationConfig): Promise<string> {
    if (!db) throw new Error('Database not configured')

    const id = config.id || crypto.randomUUID()

    // Validate data source exists
    const dataSource = await db
      .selectFrom('data_sources')
      .selectAll()
      .where('id', '=', config.sourceId)
      .executeTakeFirst()

    if (!dataSource) {
      throw new Error(`Data source ${config.sourceId} not found`)
    }

    // Determine database sync mode from config
    const dbSyncMode: DbSyncMode = config.syncMode === 'CDC' ? 'REALTIME' :
                                    config.syncInterval ? 'SCHEDULED' : 'LAZY'

    // Create external table record
    // sync_config JSON contains: mode, interval, field_mappings, transform_rules, etc.
    const syncConfig = {
      mode: dbSyncMode,
      interval: config.syncInterval ?? null,
      schema: config.sourceSchema ?? null,
      primaryKey: config.primaryKey ?? null,
      fieldMappings: config.fieldMappings,
      transformRules: config.transformRules || []
    }

    await db
      .insertInto('external_tables')
      .values({
        id,
        data_source_id: config.sourceId,
        external_name: config.sourceTable,
        local_table_id: config.targetTableId,
        schema_definition: JSON.stringify({}),
        sync_config: JSON.stringify(syncConfig)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .execute()

    // Setup sync based on mode
    if (config.syncInterval) {
      this.scheduleSync(id, config.syncInterval)
    }

    if (config.cdcEnabled) {
      await this.setupCDC(id)
    }

    // Perform initial sync
    await this.executeMaterialization(id)

    this.emit('materialization:created', id, config)
    return id
  }

  /**
   * Execute a materialization
   */
  async executeMaterialization(
    materializationId: string,
    options?: {
      fullSync?: boolean
      fromTimestamp?: Date
    }
  ): Promise<SyncResult> {
    if (this.syncInProgress.has(materializationId)) {
      return {
        success: false,
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        recordsDeleted: 0,
        errors: ['Sync already in progress'],
        duration: 0
      }
    }

    this.syncInProgress.add(materializationId)
    const startTime = Date.now()

    try {
      // Load configuration
      const config = await this.loadMaterializationConfig(materializationId)
      if (!config) {
        throw new Error(`Materialization ${materializationId} not found`)
      }

      // Get adapter
      const adapter = await this.getAdapter(config.data_source_id)

      // Determine sync mode - map database sync mode to application sync mode
      let result: SyncResult

      if (options?.fullSync) {
        result = await this.performFullSync(config, adapter)
      } else if (config.sync_mode === 'REALTIME') {
        result = await this.performCDCSync(config, adapter)
      } else if (config.sync_mode === 'SCHEDULED') {
        result = await this.performIncrementalSync(config, adapter, options?.fromTimestamp)
      } else if (config.sync_mode === 'LAZY' || config.sync_mode === 'EAGER') {
        result = await this.performLazySync(config, adapter)
      } else {
        // Fallback for any other sync mode
        result = await this.performLazySync(config, adapter)
      }

      // Update sync metadata
      // Use the columns that exist in the schema: last_sync_at, updated_at
      const now = new Date().toISOString()
      await db!
        .updateTable('external_tables')
        .set({
          last_sync_at: now,
          updated_at: now
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        .where('id', '=', materializationId)
        .execute()

      result.duration = Date.now() - startTime
      this.emit('materialization:synced', materializationId, result)
      return result

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      // Update error state - only update the columns that exist
      await db!
        .updateTable('external_tables')
        .set({
          updated_at: new Date().toISOString()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        .where('id', '=', materializationId)
        .execute()
      // Note: error tracking fields (last_error, error_count) not in current schema
      this.logger.error(`Sync error for ${materializationId}: ${errorMessage}`)

      this.emit('materialization:error', materializationId, error)

      return {
        success: false,
        recordsProcessed: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        recordsDeleted: 0,
        errors: [errorMessage],
        duration: Date.now() - startTime
      }
    } finally {
      this.syncInProgress.delete(materializationId)
    }
  }

  /**
   * Perform full sync
   */
  private async performFullSync(
    config: MaterializationDbConfig,
    adapter: DataSourceAdapter
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      recordsProcessed: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      recordsDeleted: 0,
      errors: [],
      duration: 0
    }

    try {
      // Clear existing data
      if (config.table_id) {
        // Use raw SQL for subquery due to Kysely type constraints
        await sql`
          DELETE FROM cells
          WHERE sheet_id IN (
            SELECT id FROM sheets WHERE spreadsheet_id = ${config.table_id}
          )
        `.execute(db!)
      }

      // Fetch all data from source
      const sourceData = await adapter.query({
        table: config.external_table,
        schema: config.external_schema ?? undefined
      })

      // Transform and insert data
      for (const record of sourceData) {
        const transformed = await this.transformRecord(
          record,
          config.field_mappings,
          config.transform_rules
        )

        await this.insertRecord(config.table_id, transformed)
        result.recordsInserted++
        result.recordsProcessed++
      }

    } catch (error) {
      result.success = false
      result.errors.push(error instanceof Error ? error.message : 'Unknown error')
    }

    return result
  }

  /**
   * Perform incremental sync
   */
  private async performIncrementalSync(
    config: MaterializationDbConfig,
    adapter: DataSourceAdapter,
    fromTimestamp?: Date
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      recordsProcessed: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      recordsDeleted: 0,
      errors: [],
      duration: 0
    }

    try {
      const lastSync = fromTimestamp || (config.last_sync ? new Date(config.last_sync as unknown as Date) : new Date(0))

      // Fetch changed data
      const sourceData = await adapter.query({
        table: config.external_table,
        schema: config.external_schema ?? undefined,
        where: {
          [config.external_primary_key || 'updated_at']: { $gt: lastSync }
        },
        orderBy: config.external_primary_key || 'updated_at'
      })

      // Process changes
      for (const record of sourceData) {
        const transformed = await this.transformRecord(
          record,
          config.field_mappings,
          config.transform_rules
        )

        const pkField = config.external_primary_key || 'id'
        const pkValue = record[pkField]

        const exists = await this.recordExists(
          config.table_id,
          pkField,
          pkValue
        )

        if (exists) {
          await this.updateRecord(
            config.table_id,
            pkField,
            pkValue,
            transformed
          )
          result.recordsUpdated++
        } else {
          await this.insertRecord(config.table_id, transformed)
          result.recordsInserted++
        }

        result.recordsProcessed++
      }

    } catch (error) {
      result.success = false
      result.errors.push(error instanceof Error ? error.message : 'Unknown error')
    }

    return result
  }

  /**
   * Perform CDC sync
   */
  private async performCDCSync(
    config: MaterializationDbConfig,
    adapter: DataSourceAdapter
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      recordsProcessed: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      recordsDeleted: 0,
      errors: [],
      duration: 0
    }

    try {
      // Get change events from adapter
      const changes = await adapter.getChanges?.({
        table: config.external_table,
        schema: config.external_schema ?? undefined,
        since: config.last_sync ? new Date(config.last_sync as unknown as Date) : undefined
      })

      if (!changes) {
        throw new Error('Adapter does not support CDC')
      }

      // Process each change
      for (const change of changes) {
        result.recordsProcessed++

        switch (change.type) {
          case 'INSERT':
            if (change.after) {
              const transformed = await this.transformRecord(
                change.after,
                config.field_mappings,
                config.transform_rules
              )
              await this.insertRecord(config.table_id, transformed)
              result.recordsInserted++
            }
            break

          case 'UPDATE':
            if (change.after) {
              const transformed = await this.transformRecord(
                change.after,
                config.field_mappings,
                config.transform_rules
              )
              await this.updateRecord(
                config.table_id,
                config.external_primary_key || 'id',
                change.primaryKey,
                transformed
              )
              result.recordsUpdated++
            }
            break

          case 'DELETE':
            await this.deleteRecord(
              config.table_id,
              config.external_primary_key || 'id',
              change.primaryKey
            )
            result.recordsDeleted++
            break
        }

        this.emit('cdc:event', config.id, change)
      }

    } catch (error) {
      result.success = false
      result.errors.push(error instanceof Error ? error.message : 'Unknown error')
    }

    return result
  }

  /**
   * Perform upsert sync
   */
  private async performUpsertSync(
    config: MaterializationDbConfig,
    adapter: DataSourceAdapter
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      recordsProcessed: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      recordsDeleted: 0,
      errors: [],
      duration: 0
    }

    try {
      // Fetch all source data
      const sourceData = await adapter.query({
        table: config.external_table,
        schema: config.external_schema ?? undefined
      })

      const pkField = config.external_primary_key || 'id'

      // Build source key set
      const sourceKeys = new Set(
        sourceData.map(r => r[pkField])
      )

      // Process upserts
      for (const record of sourceData) {
        const transformed = await this.transformRecord(
          record,
          config.field_mappings,
          config.transform_rules
        )

        const exists = await this.recordExists(
          config.table_id,
          pkField,
          record[pkField]
        )

        if (exists) {
          await this.updateRecord(
            config.table_id,
            pkField,
            record[pkField],
            transformed
          )
          result.recordsUpdated++
        } else {
          await this.insertRecord(config.table_id, transformed)
          result.recordsInserted++
        }

        result.recordsProcessed++
      }

      // Delete records not in source
      const targetKeys = await this.getTargetKeys(
        config.table_id,
        pkField
      )

      for (const key of targetKeys) {
        if (!sourceKeys.has(key)) {
          await this.deleteRecord(
            config.table_id,
            pkField,
            key
          )
          result.recordsDeleted++
        }
      }

    } catch (error) {
      result.success = false
      result.errors.push(error instanceof Error ? error.message : 'Unknown error')
    }

    return result
  }

  /**
   * Perform lazy sync (on-demand)
   */
  private async performLazySync(
    _config: MaterializationDbConfig,
    _adapter: DataSourceAdapter
  ): Promise<SyncResult> {
    // Lazy sync doesn't actually sync, just marks for sync
    return {
      success: true,
      recordsProcessed: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      recordsDeleted: 0,
      errors: [],
      duration: 0
    }
  }

  /**
   * Setup CDC listener
   */
  private async setupCDC(materializationId: string) {
    const config = await this.loadMaterializationConfig(materializationId)
    if (!config) return

    const adapter = await this.getAdapter(config.data_source_id)

    if (adapter.subscribeToCDC) {
      const listener = await adapter.subscribeToCDC({
        table: config.external_table,
        schema: config.external_schema ?? undefined,
        callback: async (change: ChangeEvent) => {
          await this.handleCDCEvent(materializationId, change)
        }
      })

      this.cdcListeners.set(materializationId, listener)
      this.emit('cdc:subscribed', materializationId)
    }
  }

  /**
   * Handle CDC event
   */
  private async handleCDCEvent(
    materializationId: string,
    change: ChangeEvent
  ) {
    const config = await this.loadMaterializationConfig(materializationId)
    if (!config) return

    const pkField = config.external_primary_key || 'id'

    switch (change.type) {
      case 'INSERT':
        if (change.after) {
          const transformed = await this.transformRecord(
            change.after,
            config.field_mappings,
            config.transform_rules
          )
          await this.insertRecord(config.table_id, transformed)
        }
        break

      case 'UPDATE':
        if (change.after) {
          const transformed = await this.transformRecord(
            change.after,
            config.field_mappings,
            config.transform_rules
          )
          await this.updateRecord(
            config.table_id,
            pkField,
            change.primaryKey,
            transformed
          )
        }
        break

      case 'DELETE':
        await this.deleteRecord(
          config.table_id,
          pkField,
          change.primaryKey
        )
        break
    }

    this.emit('cdc:processed', materializationId, change)
  }

  /**
   * Schedule periodic sync
   */
  private scheduleSync(materializationId: string, intervalSeconds: number) {
    if (!CronJob) {
      this.logger.warn('cron package not installed - scheduled syncs disabled')
      return
    }

    // Convert seconds to cron pattern
    const cronPattern = intervalSeconds < 60
      ? `*/${intervalSeconds} * * * * *` // Every N seconds
      : intervalSeconds < 3600
      ? `0 */${Math.floor(intervalSeconds / 60)} * * * *` // Every N minutes
      : `0 0 */${Math.floor(intervalSeconds / 3600)} * * *` // Every N hours

    const job = new CronJob(cronPattern, async () => {
      await this.executeMaterialization(materializationId)
    })

    job.start()
    this.syncJobs.set(materializationId, job)
    this.emit('sync:scheduled', materializationId, cronPattern)
  }

  /**
   * Get data source adapter
   */
  private async getAdapter(dataSourceId: string): Promise<DataSourceAdapter> {
    let adapter = this.adapters.get(dataSourceId)
    if (adapter) return adapter

    const dataSource = await db!
      .selectFrom('data_sources')
      .selectAll()
      .where('id', '=', dataSourceId)
      .executeTakeFirst()

    if (!dataSource) {
      throw new Error(`Data source ${dataSourceId} not found`)
    }

    // config field contains connection settings (parsed from JSON by Kysely)
    const connectionConfig = dataSource.config as AdapterConfig

    // Create adapter based on type
    switch (dataSource.type) {
      case 'POSTGRES':
        if (!PostgresAdapter) throw new Error('PostgresAdapter not installed')
        adapter = new PostgresAdapter(connectionConfig)
        break
      case 'MYSQL':
        if (!MySQLAdapter) throw new Error('MySQLAdapter not installed')
        adapter = new MySQLAdapter(connectionConfig)
        break
      case 'MONGODB':
        if (!MongoDBAdapter) throw new Error('MongoDBAdapter not installed')
        adapter = new MongoDBAdapter(connectionConfig)
        break
      case 'HTTP':
        if (!HTTPAdapter) throw new Error('HTTPAdapter not installed')
        adapter = new HTTPAdapter(connectionConfig)
        break
      default:
        throw new Error(`Unsupported data source type: ${dataSource.type}`)
    }

    await adapter.connect()
    this.adapters.set(dataSourceId, adapter)
    return adapter
  }

  /**
   * Load materialization configuration
   */
  private async loadMaterializationConfig(id: string): Promise<MaterializationDbConfig | undefined> {
    const config = await db!
      .selectFrom('external_tables')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()

    if (!config) return undefined

    // Parse sync_config JSON which contains all the materialization settings
    const syncConfig: SyncConfigJson = typeof config.sync_config === 'string'
      ? JSON.parse(config.sync_config) as SyncConfigJson
      : (config.sync_config || {}) as SyncConfigJson

    return {
      id: config.id,
      data_source_id: config.data_source_id,
      table_id: config.local_table_id,
      external_table: config.external_name,
      external_schema: syncConfig.schema || null,
      external_primary_key: syncConfig.primaryKey || null,
      sync_mode: syncConfig.mode || 'LAZY',
      sync_interval: syncConfig.interval || null,
      field_mappings: syncConfig.fieldMappings || {},
      transform_rules: syncConfig.transformRules || [],
      last_sync: config.last_sync_at ? new Date(config.last_sync_at as unknown as string) : null
    }
  }

  /**
   * Transform record based on rules
   */
  private async transformRecord(
    record: Record<string, unknown>,
    fieldMappings: Record<string, string>,
    rules?: TransformRule[]
  ): Promise<Record<string, unknown>> {
    let transformed: Record<string, unknown> = {}

    // Apply field mappings
    for (const [source, target] of Object.entries(fieldMappings)) {
      transformed[target] = record[source]
    }

    // Apply transform rules
    if (rules) {
      for (const rule of rules) {
        transformed = await this.applyTransformRule(transformed, rule)
      }
    }

    return transformed
  }

  /**
   * Apply a transform rule
   */
  private async applyTransformRule(
    record: Record<string, unknown>,
    rule: TransformRule
  ): Promise<Record<string, unknown>> {
    switch (rule.type) {
      case 'RENAME': {
        const config = rule.config as RenameConfig
        record[config.newName] = record[rule.field]
        delete record[rule.field]
        break
      }

      case 'CAST': {
        const config = rule.config as CastConfig
        record[rule.field] = this.castValue(record[rule.field], config.type)
        break
      }

      case 'FORMULA': {
        const config = rule.config as FormulaConfig
        record[rule.field] = await this.evaluateFormula(record, config.formula)
        break
      }

      case 'LOOKUP': {
        const config = rule.config as LookupConfig
        record[rule.field] = await this.lookupValue(
          record[rule.field],
          config.table,
          config.key,
          config.value
        )
        break
      }

      case 'AGGREGATE': {
        const config = rule.config as AggregateConfig
        record[rule.field] = await this.aggregateValue(
          record,
          config.function,
          config.fields
        )
        break
      }
    }

    return record
  }

  /**
   * Helper methods for data operations
   */
  private async recordExists(
    tableId: string | null,
    keyField: string,
    keyValue: unknown
  ): Promise<boolean> {
    if (!db || !tableId) {
      this.logger.error('Database not available')
      return false
    }

    try {
      // Query the materialized table for the key
      // local_table_id is the column name in the schema
      const result = await db
        .selectFrom('external_tables')
        .select('id')
        .where('local_table_id', '=', tableId)
        .executeTakeFirst()

      if (!result) {
        return false
      }

      // Check if record with key exists in the target table
      // Use raw SQL for dynamic table names as Kysely requires static types
      const tableName = `materialized_${tableId.replace(/-/g, '_')}`
      const exists = await sql`
        SELECT id FROM ${sql.table(tableName)}
        WHERE ${sql.ref(keyField)} = ${keyValue}
        LIMIT 1
      `.execute(db!)

      return exists.rows.length > 0
    } catch (error) {
      this.logger.error(`Error checking record existence: ${error}`)
      return false
    }
  }

  private async insertRecord(
    tableId: string | null,
    record: Record<string, unknown>
  ): Promise<void> {
    if (!db || !tableId) {
      this.logger.error('Database not available')
      return
    }

    try {
      const tableName = `materialized_${tableId.replace(/-/g, '_')}`

      // Add metadata fields
      const recordWithMeta = {
        ...record,
        _created_at: new Date(),
        _updated_at: new Date().toISOString(),
        _sync_version: 1
      }

      // Type assertion needed for dynamic table name
      await db
        .insertInto(tableName as never)
        .values(recordWithMeta as never)
        .execute()

      this.logger.info(`Inserted record into ${tableName}`)
    } catch (error) {
      this.logger.error(`Error inserting record: ${error}`)
      throw error
    }
  }

  private async updateRecord(
    tableId: string | null,
    keyField: string,
    keyValue: unknown,
    record: Record<string, unknown>
  ): Promise<void> {
    if (!db || !tableId) {
      this.logger.error('Database not available')
      return
    }

    try {
      const tableName = `materialized_${tableId.replace(/-/g, '_')}`

      // Add metadata fields
      const recordWithMeta = {
        ...record,
        _updated_at: new Date().toISOString()
      }

      // Type assertion needed for dynamic table name and SQL template
      // Increment sync version
      await db
        .updateTable(tableName as never)
        .set({
          ...recordWithMeta,
          _sync_version: sql`COALESCE(_sync_version, 0) + 1`
        } as never)
        .where(keyField as never, '=' as never, keyValue as never)
        .execute()

      this.logger.info(`Updated record in ${tableName} where ${keyField}=${keyValue}`)
    } catch (error) {
      this.logger.error(`Error updating record: ${error}`)
      throw error
    }
  }

  private async deleteRecord(
    tableId: string | null,
    keyField: string,
    keyValue: unknown
  ): Promise<void> {
    if (!db || !tableId) {
      this.logger.error('Database not available')
      return
    }

    try {
      const tableName = `materialized_${tableId.replace(/-/g, '_')}`

      // Type assertion needed for dynamic table name
      await db
        .deleteFrom(tableName as never)
        .where(keyField as never, '=' as never, keyValue as never)
        .execute()

      this.logger.info(`Deleted record from ${tableName} where ${keyField}=${keyValue}`)
    } catch (error) {
      this.logger.error(`Error deleting record: ${error}`)
      throw error
    }
  }

  private async getTargetKeys(
    tableId: string | null,
    keyField: string
  ): Promise<unknown[]> {
    if (!db || !tableId) {
      this.logger.error('Database not available')
      return []
    }

    try {
      const tableName = `materialized_${tableId.replace(/-/g, '_')}`

      // Type assertion needed for dynamic table name
      const result = await db
        .selectFrom(tableName as never)
        .select(keyField as never)
        .execute()

      return result.map((row: Record<string, unknown>) => row[keyField])
    } catch (error) {
      this.logger.error(`Error getting target keys: ${error}`)
      return []
    }
  }

  private castValue(value: unknown, type: 'string' | 'number' | 'boolean' | 'date' | 'json'): unknown {
    switch (type) {
      case 'string': return String(value)
      case 'number': return Number(value)
      case 'boolean': return Boolean(value)
      case 'date': return new Date(value as string | number | Date)
      case 'json': return JSON.parse(value as string)
      default: return value
    }
  }

  private async evaluateFormula(
    record: Record<string, unknown>,
    formula: string
  ): Promise<unknown> {
    // Safe formula evaluation - NO eval() to prevent code injection
    // Supports: field references, basic math, string concatenation
    try {
      // Sanitize formula - only allow safe characters
      const sanitized = formula.trim()

      // Check for dangerous patterns
      const dangerousPatterns = [
        /\beval\b/i,
        /\bFunction\b/i,
        /\brequire\b/i,
        /\bimport\b/i,
        /\bprocess\b/i,
        /\bglobal\b/i,
        /\b__proto__\b/i,
        /\bconstructor\b/i,
        /\bprototype\b/i,
        /[`${}]/,  // Template literals
      ]

      for (const pattern of dangerousPatterns) {
        if (pattern.test(sanitized)) {
          throw new Error(`Unsafe formula pattern detected: ${pattern}`)
        }
      }

      // Simple field reference: {{fieldName}}
      const fieldRefPattern = /\{\{(\w+)\}\}/g
      const result = sanitized.replace(fieldRefPattern, (_, field) => {
        const value = record[field]
        return value !== undefined ? String(value) : ''
      })

      // Simple arithmetic expressions (only numbers and basic operators)
      const arithmeticPattern = /^[\d\s+\-*/().]+$/
      if (arithmeticPattern.test(result)) {
        // Safe evaluation of pure arithmetic
        const safeArithmetic = (expr: string): number => {
          // Parse and evaluate simple arithmetic using a safe approach
          const tokens = expr.match(/[\d.]+|[+\-*/()]/g) || []
          let pos = 0

          const parseNumber = (): number => {
            const num = parseFloat(tokens[pos] || '0')
            pos++
            return num
          }

          const parseFactor = (): number => {
            if (tokens[pos] === '(') {
              pos++ // skip (
              const result = parseExpression()
              pos++ // skip )
              return result
            }
            return parseNumber()
          }

          const parseTerm = (): number => {
            let result = parseFactor()
            while (tokens[pos] === '*' || tokens[pos] === '/') {
              const op = tokens[pos]
              pos++
              const right = parseFactor()
              result = op === '*' ? result * right : result / right
            }
            return result
          }

          const parseExpression = (): number => {
            let result = parseTerm()
            while (tokens[pos] === '+' || tokens[pos] === '-') {
              const op = tokens[pos]
              pos++
              const right = parseTerm()
              result = op === '+' ? result + right : result - right
            }
            return result
          }

          return parseExpression()
        }

        return safeArithmetic(result)
      }

      // String concatenation: "text" + fieldValue
      const concatPattern = /^["'][^"']*["'](\s*\+\s*(["'][^"']*["']|\w+))*$/
      if (concatPattern.test(result)) {
        return result.replace(/["']/g, '').split(/\s*\+\s*/).join('')
      }

      // Return as-is if it's just a value
      return result
    } catch (error) {
      this.logger.error('Formula evaluation error', error instanceof Error ? error : undefined)
      return null
    }
  }

  private async lookupValue(
    key: unknown,
    table: string,
    keyField: string,
    valueField: string
  ): Promise<unknown> {
    // Type assertion needed for dynamic table name
    // Lookup value from another table
    const result = await db!
      .selectFrom(table as never)
      .select(valueField as never)
      .where(keyField as never, '=' as never, key as never)
      .executeTakeFirst()

    return result?.[valueField as keyof typeof result]
  }

  private async aggregateValue(
    record: Record<string, unknown>,
    func: 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT' | 'CONCAT',
    fields: string[]
  ): Promise<unknown> {
    const values = fields.map(f => record[f]).filter(v => v !== undefined) as number[]

    switch (func) {
      case 'SUM': return values.reduce((a, b) => a + b, 0)
      case 'AVG': return values.reduce((a, b) => a + b, 0) / values.length
      case 'MIN': return Math.min(...values)
      case 'MAX': return Math.max(...values)
      case 'COUNT': return values.length
      case 'CONCAT': return values.join('')
      default: return null
    }
  }

  /**
   * Cleanup and shutdown
   */
  async shutdown() {
    // Stop all sync jobs
    for (const job of this.syncJobs.values()) {
      job.stop()
    }

    // Unsubscribe from CDC
    for (const listener of this.cdcListeners.values()) {
      if (listener && listener.unsubscribe) {
        await listener.unsubscribe()
      }
    }

    // Disconnect adapters
    for (const adapter of this.adapters.values()) {
      await adapter.disconnect()
    }

    this.emit('shutdown')
  }
}

// Export singleton instance
export const dataMaterializationService = new DataMaterializationService()
