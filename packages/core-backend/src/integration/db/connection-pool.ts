import type { PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { Pool } from 'pg'
import { Logger } from '../../core/logger'
import { secretManager } from '../../security/SecretManager'
import { coreMetrics } from '../metrics/metrics'

export interface QueryOptions {
  timeoutMs?: number
  readOnly?: boolean
}

interface QueryConfig {
  text: string
  values?: unknown[]
  query_timeout?: number
  statement_timeout?: number
}

type TransactionQuery = <T extends QueryResultRow = QueryResultRow>(
  sql: string | QueryConfig,
  params?: unknown[],
  options?: QueryOptions
) => Promise<QueryResult<T>>

export interface ConnectionPoolOptions extends PoolConfig {
  slowQueryMs?: number
  name?: string
}

// Type guard to check if pool has internal statistics
interface PoolWithStats {
  totalCount?: number
  idleCount?: number
  waitingCount?: number
}

// Type for pool statistics
interface PoolStats {
  name: string
  status: 'healthy' | 'unhealthy'
  totalConnections: number
  idleConnections: number
  waitingClients: number
  error?: string
}

class ConnectionPool {
  private pool: Pool
  private slowMs: number
  private logger: Logger
  private metricsTimer?: NodeJS.Timeout
  private queryCount = 0
  private queryErrorCount = 0
  readonly name: string

  constructor(opts: ConnectionPoolOptions) {
    this.pool = new Pool(opts)
    this.slowMs = opts.slowQueryMs || parseInt(process.env.DB_SLOW_MS || '500', 10)
    this.name = opts.name || 'main'
    this.logger = new Logger(`ConnectionPool:${this.name}`)

    // Start metrics collection
    this.startMetricsCollection()
  }

  /**
   * Start periodic metrics collection for Prometheus
   * Sprint 5 Day 3: Prometheus metrics integration
   */
  private startMetricsCollection(): void {
    // Collect metrics every 5 seconds
    this.metricsTimer = setInterval(() => {
      this.collectPoolMetrics()
    }, 5000)

    // Don't prevent process from exiting
    if (this.metricsTimer.unref) {
      this.metricsTimer.unref()
    }
  }

  /**
   * Collect and report pool metrics
   */
  private collectPoolMetrics(): void {
    const pool = this.pool as unknown as PoolWithStats
    const poolName = this.name

    // Report pool connection metrics
    coreMetrics.gauge(`db_pool_total_connections`, pool.totalCount || 0, { pool: poolName })
    coreMetrics.gauge(`db_pool_idle_connections`, pool.idleCount || 0, { pool: poolName })
    coreMetrics.gauge(`db_pool_waiting_clients`, pool.waitingCount || 0, { pool: poolName })
    coreMetrics.gauge(`db_pool_active_connections`, (pool.totalCount || 0) - (pool.idleCount || 0), { pool: poolName })

    // Report query metrics
    coreMetrics.gauge(`db_pool_query_total`, this.queryCount, { pool: poolName })
    coreMetrics.gauge(`db_pool_query_errors_total`, this.queryErrorCount, { pool: poolName })
  }

  /**
   * Stop metrics collection
   */
  stopMetricsCollection(): void {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer)
      this.metricsTimer = undefined
    }
  }

  private buildQueryConfig(sql: string, params?: unknown[], options?: QueryOptions): QueryConfig {
    const timeoutMs = Number(options?.timeoutMs ?? 0)
    const queryConfig: QueryConfig = {
      text: sql,
      values: params,
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      queryConfig.query_timeout = Math.floor(timeoutMs)
      queryConfig.statement_timeout = Math.floor(timeoutMs)
    }
    return queryConfig
  }

  async healthCheck(): Promise<void> {
    await this.pool.query('SELECT 1')
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
    options?: QueryOptions
  ): Promise<QueryResult<T>> {
    const start = Date.now()
    try {
      const queryConfig = this.buildQueryConfig(sql, params, options)
      const res = await this.pool.query<T>(queryConfig)
      const ms = Date.now() - start

      // Track query metrics
      this.queryCount++
      coreMetrics.histogram('db_query_duration_ms', ms, { pool: this.name })

      if (ms > this.slowMs) {
        this.logger.warn(`Slow query: ${ms}ms - ${sql.slice(0, 160)}`)
        coreMetrics.increment('db_slow_queries_total', { pool: this.name })
      }

      return res
    } catch (error) {
      this.queryErrorCount++
      coreMetrics.increment('db_query_errors_total', { pool: this.name })
      throw error
    }
  }

  async transaction<T>(handler: (client: { query: TransactionQuery }) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const query: TransactionQuery = async <R extends QueryResultRow = QueryResultRow>(
        sqlOrConfig: string | QueryConfig,
        params?: unknown[],
        options?: QueryOptions
      ): Promise<QueryResult<R>> => {
        if (typeof sqlOrConfig === 'string') {
          const queryConfig = this.buildQueryConfig(sqlOrConfig, params, options)
          return client.query<R>(queryConfig)
        }
        return client.query<R>(sqlOrConfig)
      }
      const result = await handler({ query })
      await client.query('COMMIT')
      return result
    } catch (e) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        this.logger.error('ROLLBACK failed', rollbackErr instanceof Error ? rollbackErr : undefined)
      }
      throw e
    } finally {
      client.release()
    }
  }

  /**
   * Get internal pool statistics (if available)
   * @internal
   */
  getInternalPool(): Pool {
    return this.pool
  }
}

class PoolManager {
  private main: ConnectionPool
  private readonly pools: Map<string, ConnectionPool> = new Map()
  private logger = new Logger('PoolManager')

  constructor() {
    const connectionString = secretManager.get('DATABASE_URL', { required: process.env.NODE_ENV === 'production' })
    if (!connectionString) {
      this.logger.warn('DATABASE_URL not set; database pool will use driver defaults and may fail to connect')
    }

    this.main = this.createPool(
      'main',
      {
        connectionString,

        // 连接池安全配置
        max: parseInt(process.env.DB_POOL_MAX || '20', 10), // 最大连接数
        min: parseInt(process.env.DB_POOL_MIN || '2', 10),  // 最小连接数

        // 超时配置
        idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10), // 空闲连接超时
        connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '10000', 10), // 连接超时
        // Note: acquireTimeoutMillis is not a valid pg Pool option, removing to fix compilation

        // SSL配置
        ssl: process.env.NODE_ENV === 'production' ? {
          rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
          ca: process.env.DB_SSL_CA,
          cert: process.env.DB_SSL_CERT,
          key: process.env.DB_SSL_KEY,
        } : false,

        // 查询配置
        query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT || '30000', 10), // 查询超时
        statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10), // 语句超时

        // 监控配置
        slowQueryMs: parseInt(process.env.DB_SLOW_MS || '500', 10),
        name: 'main',

        // 应用名称（用于数据库连接跟踪）
        application_name: process.env.APP_NAME || 'metasheet-backend'
      }
    )
  }

  createPool(name: string, opts: ConnectionPoolOptions): ConnectionPool {
    const pool = new ConnectionPool({ ...opts, name })
    this.pools.set(name, pool)
    if (name === 'main') this.main = pool
    return pool
  }

  /**
   * Initialize shard pools from configuration
   * Sprint 6 Day 1: Multi-Pool Manager
   */
  initializeShards(shardConfigs: Array<{ id: string; config: ConnectionPoolOptions }>): void {
    for (const { id, config } of shardConfigs) {
      this.createPool(id, config)
      this.logger.info(`Initialized shard pool: ${id}`)
    }
  }

  get(name = 'main'): ConnectionPool {
    return this.pools.get(name) || this.main
  }

  async healthCheck(): Promise<void> {
    await Promise.all(Array.from(this.pools.values()).map(p => p.healthCheck()))
  }

  /**
   * 检查数据库连接状态和池统计
   */
  async getPoolStats(): Promise<PoolStats[]> {
    try {
      const stats = await Promise.all(
        Array.from(this.pools.entries()).map(async ([name, pool]): Promise<PoolStats> => {
          try {
            await pool.healthCheck()

            // Access internal pool statistics with proper typing
            const internalPool = pool.getInternalPool() as unknown as PoolWithStats

            return {
              name,
              status: 'healthy',
              totalConnections: internalPool.totalCount || 0,
              idleConnections: internalPool.idleCount || 0,
              waitingClients: internalPool.waitingCount || 0
            }
          } catch (error) {
            return {
              name,
              status: 'unhealthy',
              error: error instanceof Error ? error.message : String(error),
              totalConnections: 0,
              idleConnections: 0,
              waitingClients: 0
            }
          }
        })
      )
      return stats
    } catch (error) {
      this.logger.error('Failed to get pool stats', error instanceof Error ? error : undefined)
      return []
    }
  }

  /**
   * 优雅关闭所有连接池
   */
  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.pools.values()).map(async (pool) => {
        try {
          // Stop metrics collection before closing
          pool.stopMetricsCollection()
          await pool.getInternalPool().end()
        } catch (error) {
          this.logger.error('Error closing pool', error instanceof Error ? error : undefined)
        }
      })
    )
  }

  /**
   * Get metrics snapshot for all pools
   * Sprint 5 Day 3: Returns current metrics for Prometheus endpoint
   */
  getMetricsSnapshot(): Record<string, number> {
    const metrics: Record<string, number> = {}

    for (const [name, pool] of this.pools.entries()) {
      const internalPool = pool.getInternalPool() as unknown as PoolWithStats

      metrics[`db_pool_total_connections{pool="${name}"}`] = internalPool.totalCount || 0
      metrics[`db_pool_idle_connections{pool="${name}"}`] = internalPool.idleCount || 0
      metrics[`db_pool_waiting_clients{pool="${name}"}`] = internalPool.waitingCount || 0
      metrics[`db_pool_active_connections{pool="${name}"}`] = (internalPool.totalCount || 0) - (internalPool.idleCount || 0)
    }

    return metrics
  }
}

export const poolManager = new PoolManager()
export type { ConnectionPool }
