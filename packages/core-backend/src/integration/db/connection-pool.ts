import { Pool, PoolClient, PoolConfig } from 'pg'

export interface QueryOptions {
  timeoutMs?: number
  readOnly?: boolean
}

export interface ConnectionPoolOptions extends PoolConfig {
  slowQueryMs?: number
  name?: string
}

class ConnectionPool {
  private pool: Pool
  private slowMs: number
  readonly name: string

  constructor(opts: ConnectionPoolOptions) {
    this.pool = new Pool(opts)
    this.slowMs = opts.slowQueryMs || parseInt(process.env.DB_SLOW_MS || '500', 10)
    this.name = opts.name || 'main'
  }

  async healthCheck(): Promise<void> {
    await this.pool.query('SELECT 1')
  }

  async query<T = any>(sql: string, params?: any[], _options?: QueryOptions): Promise<{ rows: T[] }> {
    const start = Date.now()
    const res = await this.pool.query(sql, params)
    const ms = Date.now() - start
    if (ms > this.slowMs) {
      // eslint-disable-next-line no-console
      console.warn('[db][slow]', { name: this.name, ms, sql: sql.slice(0, 160) })
    }
    return res as any
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
        console.error('[ConnectionPool] ROLLBACK failed:', rollbackErr)
      }
      throw e
    } finally {
      client.release()
    }
  }
}

class PoolManager {
  private main: ConnectionPool
  private readonly pools: Map<string, ConnectionPool> = new Map()

  constructor() {
    this.main = this.createPool('main', {
      connectionString: process.env.DATABASE_URL,

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
    })
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
  async getPoolStats() {
    try {
      const stats = await Promise.all(
        Array.from(this.pools.entries()).map(async ([name, pool]) => {
          try {
            await pool.healthCheck()
            return {
              name,
              status: 'healthy',
              totalConnections: (pool as any).pool?.totalCount || 0,
              idleConnections: (pool as any).pool?.idleCount || 0,
              waitingClients: (pool as any).pool?.waitingCount || 0
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
      console.error('Failed to get pool stats:', error)
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
          await (pool as any).pool?.end()
        } catch (error) {
          console.error('Error closing pool:', error)
        }
      })
    )
  }
}

export const poolManager = new PoolManager()
export type { ConnectionPool }

