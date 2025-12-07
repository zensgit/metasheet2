/**
 * Sharded Pool Manager
 * Sprint 6 Day 1: Multi-tenant database sharding with physical routing
 *
 * Extends PoolManager to support dynamic management of multiple ConnectionPools,
 * one per database shard. Integrates with ShardingStrategy for tenant-based routing.
 */

import type { PoolConfig, QueryResult, QueryResultRow } from 'pg'
import { Pool } from 'pg'
import { Logger } from '../../core/logger'
import { coreMetrics } from '../../integration/metrics/metrics'
import type { ShardInfo, ShardingStrategy, ShardKeyResult } from './types'
import { TenantHashShardingStrategy } from './hash-sharding-strategy'

/**
 * Configuration for a single shard's connection pool
 */
export interface ShardPoolConfig extends Partial<PoolConfig> {
  /** Slow query threshold in milliseconds */
  slowQueryMs?: number
}

/**
 * Configuration for the sharded pool manager
 */
export interface ShardedPoolManagerConfig {
  /** Sharding strategy to use (defaults to TenantHashShardingStrategy) */
  strategy?: ShardingStrategy
  /** Default pool configuration applied to all shards */
  defaultPoolConfig?: ShardPoolConfig
  /** Per-shard pool configuration overrides */
  shardConfigs?: Record<string, ShardPoolConfig>
  /** Enable automatic health checks */
  enableHealthChecks?: boolean
  /** Health check interval in milliseconds */
  healthCheckIntervalMs?: number
}

/**
 * Shard connection status
 */
export interface ShardStatus {
  shardId: string
  status: 'healthy' | 'unhealthy' | 'initializing'
  totalConnections: number
  idleConnections: number
  waitingClients: number
  lastHealthCheck?: Date
  error?: string
}

/**
 * Type guard for pool statistics
 */
interface PoolWithStats {
  totalCount?: number
  idleCount?: number
  waitingCount?: number
}

/**
 * Internal representation of a shard's connection pool
 */
interface ShardPool {
  pool: Pool
  info: ShardInfo
  status: 'healthy' | 'unhealthy' | 'initializing'
  lastHealthCheck?: Date
  queryCount: number
  errorCount: number
}

/**
 * ShardedPoolManager manages multiple database connection pools,
 * one per shard, with automatic routing based on tenant ID.
 */
export class ShardedPoolManager {
  private readonly shards: Map<string, ShardPool> = new Map()
  private readonly strategy: ShardingStrategy
  private readonly config: Required<ShardedPoolManagerConfig>
  private readonly logger = new Logger('ShardedPoolManager')
  private healthCheckTimer?: NodeJS.Timeout
  private initialized = false

  constructor(config: ShardedPoolManagerConfig = {}) {
    this.strategy = config.strategy ?? new TenantHashShardingStrategy()
    this.config = {
      strategy: this.strategy,
      defaultPoolConfig: config.defaultPoolConfig ?? {
        max: 10,
        min: 2,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        slowQueryMs: 500
      },
      shardConfigs: config.shardConfigs ?? {},
      enableHealthChecks: config.enableHealthChecks ?? true,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 30000
    }
  }

  /**
   * Initialize the pool manager with shard configurations
   * Can be called with an array of ShardInfo or loaded from environment/config
   */
  async initialize(shards?: ShardInfo[]): Promise<void> {
    if (this.initialized) {
      this.logger.warn('ShardedPoolManager already initialized')
      return
    }

    // If no shards provided, try to load from environment
    const shardInfos = shards ?? this.loadShardsFromEnvironment()

    if (shardInfos.length === 0) {
      this.logger.warn('No shards configured; ShardedPoolManager will operate in degraded mode')
      this.initialized = true
      return
    }

    this.logger.info(`Initializing ${shardInfos.length} database shards`)

    // Create connection pools for each shard
    for (const shardInfo of shardInfos) {
      await this.addShard(shardInfo)
    }

    // Start health checks if enabled
    if (this.config.enableHealthChecks) {
      this.startHealthChecks()
    }

    this.initialized = true
    this.logger.info(`ShardedPoolManager initialized with ${this.shards.size} shards`)
  }

  /**
   * Load shard configuration from environment variables
   * Expected format: SHARD_0_URL, SHARD_1_URL, etc.
   */
  private loadShardsFromEnvironment(): ShardInfo[] {
    const shards: ShardInfo[] = []
    let index = 0

    // eslint-disable-next-line no-constant-condition -- intentional infinite loop with break condition
    while (true) {
      const envKey = `SHARD_${index}_URL`
      const connectionUrl = process.env[envKey]

      if (!connectionUrl) {
        break
      }

      const regionKey = `SHARD_${index}_REGION`
      const readOnlyKey = `SHARD_${index}_READONLY`

      shards.push({
        shardId: `shard-${index}`,
        connectionUrl,
        region: process.env[regionKey],
        readOnly: process.env[readOnlyKey] === 'true'
      })

      index++
    }

    if (shards.length > 0) {
      this.logger.info(`Loaded ${shards.length} shards from environment`)
    }

    return shards
  }

  /**
   * Add a new shard to the pool manager
   */
  async addShard(shardInfo: ShardInfo): Promise<void> {
    if (this.shards.has(shardInfo.shardId)) {
      this.logger.warn(`Shard ${shardInfo.shardId} already exists; skipping`)
      return
    }

    // Merge default config with shard-specific config
    const shardConfig = {
      ...this.config.defaultPoolConfig,
      ...this.config.shardConfigs[shardInfo.shardId]
    }

    // Create connection pool
    const pool = new Pool({
      connectionString: shardInfo.connectionUrl,
      max: shardConfig.max,
      min: shardConfig.min,
      idleTimeoutMillis: shardConfig.idleTimeoutMillis,
      connectionTimeoutMillis: shardConfig.connectionTimeoutMillis,
      application_name: `metasheet-${shardInfo.shardId}`
    })

    // Register error handler
    pool.on('error', (err) => {
      this.logger.error(`Pool error on shard ${shardInfo.shardId}:`, err)
      const shardPool = this.shards.get(shardInfo.shardId)
      if (shardPool) {
        shardPool.status = 'unhealthy'
        shardPool.errorCount++
      }
      coreMetrics.increment('db_shard_pool_errors_total', { shard: shardInfo.shardId })
    })

    const shardPool: ShardPool = {
      pool,
      info: shardInfo,
      status: 'initializing',
      queryCount: 0,
      errorCount: 0
    }

    this.shards.set(shardInfo.shardId, shardPool)

    // Register with sharding strategy
    this.strategy.addShard(shardInfo)

    // Perform initial health check
    try {
      await pool.query('SELECT 1')
      shardPool.status = 'healthy'
      shardPool.lastHealthCheck = new Date()
      this.logger.info(`Shard ${shardInfo.shardId} initialized successfully`)
    } catch (error) {
      shardPool.status = 'unhealthy'
      this.logger.error(`Shard ${shardInfo.shardId} health check failed:`, error as Error)
    }

    coreMetrics.gauge('db_shards_total', this.shards.size)
  }

  /**
   * Remove a shard from the pool manager
   */
  async removeShard(shardId: string): Promise<boolean> {
    const shardPool = this.shards.get(shardId)
    if (!shardPool) {
      return false
    }

    try {
      await shardPool.pool.end()
      this.shards.delete(shardId)
      this.strategy.removeShard(shardId)
      this.logger.info(`Shard ${shardId} removed`)
      coreMetrics.gauge('db_shards_total', this.shards.size)
      return true
    } catch (error) {
      this.logger.error(`Error removing shard ${shardId}:`, error as Error)
      return false
    }
  }

  /**
   * Get the connection pool for a specific tenant
   * This is the main routing method for database operations
   */
  getPoolForTenant(tenantId: string): Pool {
    if (!this.strategy.canHandle(tenantId)) {
      throw new Error(`Cannot route tenant ${tenantId}: no shards configured`)
    }

    const result = this.strategy.getShardKey(tenantId)
    return this.getPoolByShardId(result.shardId)
  }

  /**
   * Get the shard routing result for a tenant
   */
  getShardForTenant(tenantId: string): ShardKeyResult {
    return this.strategy.getShardKey(tenantId)
  }

  /**
   * Get the connection pool by shard ID
   */
  getPoolByShardId(shardId: string): Pool {
    const shardPool = this.shards.get(shardId)
    if (!shardPool) {
      throw new Error(`Shard ${shardId} not found`)
    }

    if (shardPool.status === 'unhealthy') {
      this.logger.warn(`Returning pool for unhealthy shard ${shardId}`)
      coreMetrics.increment('db_shard_unhealthy_access', { shard: shardId })
    }

    return shardPool.pool
  }

  /**
   * Execute a query on the appropriate shard for a tenant
   */
  async queryForTenant<T extends QueryResultRow = QueryResultRow>(
    tenantId: string,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const startTime = Date.now()
    const result = this.strategy.getShardKey(tenantId)
    const shardPool = this.shards.get(result.shardId)

    if (!shardPool) {
      throw new Error(`Shard ${result.shardId} not found for tenant ${tenantId}`)
    }

    try {
      const queryResult = await shardPool.pool.query<T>(sql, params)
      const duration = Date.now() - startTime

      shardPool.queryCount++
      coreMetrics.histogram('db_shard_query_duration_ms', duration, { shard: result.shardId })

      if (duration > (this.config.defaultPoolConfig.slowQueryMs ?? 500)) {
        this.logger.warn(`Slow query on shard ${result.shardId}: ${duration}ms - ${sql.slice(0, 100)}`)
        coreMetrics.increment('db_shard_slow_queries_total', { shard: result.shardId })
      }

      return queryResult
    } catch (error) {
      shardPool.errorCount++
      coreMetrics.increment('db_shard_query_errors_total', { shard: result.shardId })
      throw error
    }
  }

  /**
   * Execute a transaction on the appropriate shard for a tenant
   */
  async transactionForTenant<T>(
    tenantId: string,
    handler: (client: { query: Pool['query'] }) => Promise<T>
  ): Promise<T> {
    const pool = this.getPoolForTenant(tenantId)
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      const result = await handler({ query: client.query.bind(client) })
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        this.logger.error('ROLLBACK failed', rollbackErr as Error)
      }
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Get status for all shards
   */
  getShardStatuses(): ShardStatus[] {
    const statuses: ShardStatus[] = []

    for (const [shardId, shardPool] of this.shards) {
      const poolStats = shardPool.pool as unknown as PoolWithStats

      statuses.push({
        shardId,
        status: shardPool.status,
        totalConnections: poolStats.totalCount ?? 0,
        idleConnections: poolStats.idleCount ?? 0,
        waitingClients: poolStats.waitingCount ?? 0,
        lastHealthCheck: shardPool.lastHealthCheck,
        error: shardPool.status === 'unhealthy' ? 'Health check failed' : undefined
      })
    }

    return statuses
  }

  /**
   * Get the sharding strategy
   */
  getStrategy(): ShardingStrategy {
    return this.strategy
  }

  /**
   * Get all configured shard IDs
   */
  getShardIds(): string[] {
    return Array.from(this.shards.keys())
  }

  /**
   * Check if manager has any healthy shards
   */
  hasHealthyShards(): boolean {
    for (const shardPool of this.shards.values()) {
      if (shardPool.status === 'healthy') {
        return true
      }
    }
    return false
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthChecks()
    }, this.config.healthCheckIntervalMs)

    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref()
    }
  }

  /**
   * Perform health checks on all shards
   */
  private async performHealthChecks(): Promise<void> {
    const checks = Array.from(this.shards.entries()).map(
      async ([shardId, shardPool]): Promise<void> => {
        try {
          await shardPool.pool.query('SELECT 1')
          const wasUnhealthy = shardPool.status === 'unhealthy'
          shardPool.status = 'healthy'
          shardPool.lastHealthCheck = new Date()

          if (wasUnhealthy) {
            this.logger.info(`Shard ${shardId} recovered`)
            coreMetrics.increment('db_shard_recovered_total', { shard: shardId })
          }
        } catch (error) {
          shardPool.status = 'unhealthy'
          this.logger.error(`Health check failed for shard ${shardId}:`, error as Error)
          coreMetrics.increment('db_shard_health_check_failures_total', { shard: shardId })
        }
      }
    )

    await Promise.allSettled(checks)

    // Report metrics
    let healthyCount = 0
    let unhealthyCount = 0

    for (const shardPool of this.shards.values()) {
      if (shardPool.status === 'healthy') {
        healthyCount++
      } else {
        unhealthyCount++
      }
    }

    coreMetrics.gauge('db_shards_healthy', healthyCount)
    coreMetrics.gauge('db_shards_unhealthy', unhealthyCount)
  }

  /**
   * Get metrics snapshot for all shards
   */
  getMetricsSnapshot(): Record<string, number> {
    const metrics: Record<string, number> = {}

    for (const [shardId, shardPool] of this.shards) {
      const poolStats = shardPool.pool as unknown as PoolWithStats

      metrics[`db_shard_total_connections{shard="${shardId}"}`] = poolStats.totalCount ?? 0
      metrics[`db_shard_idle_connections{shard="${shardId}"}`] = poolStats.idleCount ?? 0
      metrics[`db_shard_waiting_clients{shard="${shardId}"}`] = poolStats.waitingCount ?? 0
      metrics[`db_shard_active_connections{shard="${shardId}"}`] =
        (poolStats.totalCount ?? 0) - (poolStats.idleCount ?? 0)
      metrics[`db_shard_query_count{shard="${shardId}"}`] = shardPool.queryCount
      metrics[`db_shard_error_count{shard="${shardId}"}`] = shardPool.errorCount
      metrics[`db_shard_healthy{shard="${shardId}"}`] = shardPool.status === 'healthy' ? 1 : 0
    }

    return metrics
  }

  /**
   * Gracefully close all connection pools
   */
  async close(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = undefined
    }

    const closePromises = Array.from(this.shards.values()).map(async (shardPool) => {
      try {
        await shardPool.pool.end()
      } catch (error) {
        this.logger.error(`Error closing shard ${shardPool.info.shardId}:`, error as Error)
      }
    })

    await Promise.allSettled(closePromises)
    this.shards.clear()
    this.initialized = false
    this.logger.info('ShardedPoolManager closed')
  }
}

// Singleton instance (optional - can also create per-request)
let shardedPoolManager: ShardedPoolManager | null = null

export function getShardedPoolManager(): ShardedPoolManager {
  if (!shardedPoolManager) {
    shardedPoolManager = new ShardedPoolManager()
  }
  return shardedPoolManager
}

export function resetShardedPoolManager(): void {
  if (shardedPoolManager) {
    shardedPoolManager.close().catch(() => {})
    shardedPoolManager = null
  }
}
