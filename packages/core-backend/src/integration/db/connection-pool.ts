import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { Pool } from 'pg'
import { Logger } from '../../core/logger'
import { secretManager } from '../../security/SecretManager'

export interface QueryOptions {
  timeoutMs?: number
  readOnly?: boolean
}

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
  readonly name: string

  constructor(opts: ConnectionPoolOptions) {
    this.pool = new Pool(opts)
    this.slowMs = opts.slowQueryMs || parseInt(process.env.DB_SLOW_MS || '500', 10)
    this.name = opts.name || 'main'
    this.logger = new Logger(`ConnectionPool:${this.name}`)
  }

  async healthCheck(): Promise<void> {
    await this.pool.query('SELECT 1')
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
    _options?: QueryOptions
  ): Promise<QueryResult<T>> {
    const start = Date.now()
    const res = await this.pool.query<T>(sql, params)
    const ms = Date.now() - start
    if (ms > this.slowMs) {
      this.logger.warn(`Slow query: ${ms}ms - ${sql.slice(0, 160)}`)
    }
    return res
  }

  async transaction<T>(handler: (client: { query: PoolClient['query'] }) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await handler({ query: client.query.bind(client) })
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
          await pool.getInternalPool().end()
        } catch (error) {
          this.logger.error('Error closing pool', error instanceof Error ? error : undefined)
        }
      })
    )
  }
}

export const poolManager = new PoolManager()
export type { ConnectionPool }
