import { EventEmitter } from 'eventemitter3'
import type { BaseDataAdapter, DataSourceConfig, QueryOptions, QueryResult, DbValue, WhereValue } from './BaseAdapter'
import { PostgresAdapter } from './PostgresAdapter'
import { MySQLAdapter } from './MySQLAdapter'
import { HTTPAdapter } from './HTTPAdapter'
import { MongoDBAdapter } from './MongoDBAdapter'

type AdapterConstructor = new (config: DataSourceConfig) => BaseDataAdapter

export class DataSourceManager extends EventEmitter {
  private adapters: Map<string, BaseDataAdapter> = new Map()
  private adapterTypes: Map<string, AdapterConstructor> = new Map()
  private connectionPool: Map<string, Promise<void>> = new Map()

  constructor() {
    super()
    this.registerDefaultAdapters()
  }

  private registerDefaultAdapters(): void {
    // Cast adapters to AdapterConstructor - their pool property visibility differs but functionality is identical
    this.registerAdapterType('postgresql', PostgresAdapter as unknown as AdapterConstructor)
    this.registerAdapterType('postgres', PostgresAdapter as unknown as AdapterConstructor)
    this.registerAdapterType('mysql', MySQLAdapter as unknown as AdapterConstructor)
    this.registerAdapterType('http', HTTPAdapter as unknown as AdapterConstructor)
    this.registerAdapterType('mongodb', MongoDBAdapter as unknown as AdapterConstructor)
  }

  registerAdapterType(type: string, adapterClass: AdapterConstructor): void {
    this.adapterTypes.set(type.toLowerCase(), adapterClass)
  }

  async addDataSource(config: DataSourceConfig): Promise<BaseDataAdapter> {
    if (this.adapters.has(config.id)) {
      throw new Error(`Data source with id '${config.id}' already exists`)
    }

    const AdapterClass = this.adapterTypes.get(config.type.toLowerCase())
    if (!AdapterClass) {
      throw new Error(`Unsupported data source type: ${config.type}`)
    }

    const adapter = new AdapterClass(config)

    // Set up event forwarding
    adapter.on('connected', (data) => this.emit('adapter:connected', { ...data, id: config.id }))
    adapter.on('disconnected', (data) => this.emit('adapter:disconnected', { ...data, id: config.id }))
    adapter.on('error', (data) => this.emit('adapter:error', { ...data, id: config.id }))

    this.adapters.set(config.id, adapter)

    // Auto-connect if specified
    if (config.options?.autoConnect !== false) {
      await this.connectDataSource(config.id)
    }

    return adapter
  }

  async removeDataSource(id: string): Promise<void> {
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

  async testConnection(id: string): Promise<boolean> {
    const adapter = this.getDataSource(id)
    return adapter.testConnection()
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
  listDataSources(): Array<{
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
    this.removeAllListeners()
  }
}
