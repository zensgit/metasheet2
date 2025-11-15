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
      try { await client.query('ROLLBACK') } catch {}
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
      max: parseInt(process.env.DB_POOL_MAX || '20', 10),
      idleTimeoutMillis: 30000,
      slowQueryMs: parseInt(process.env.DB_SLOW_MS || '500', 10),
      name: 'main'
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
}

export const poolManager = new PoolManager()
export type { ConnectionPool }

