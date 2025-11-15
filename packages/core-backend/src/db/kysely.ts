/**
 * Unified Kysely Database Configuration
 * Central database connection and type-safe query builder
 */

import { Kysely, PostgresDialect, CamelCasePlugin } from 'kysely'
import { Pool } from 'pg'
import type { Database } from './types'

// Environment configuration
const config = {
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'metasheet',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    connectionString: process.env.DATABASE_URL,
    // Connection pool settings
    min: parseInt(process.env.DB_POOL_MIN || '2'),
    max: parseInt(process.env.DB_POOL_MAX || '10'),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '5000'),
  }
}

// Create connection pool
let pool: Pool | undefined

if (config.database.connectionString) {
  pool = new Pool({
    connectionString: config.database.connectionString,
    min: config.database.min,
    max: config.database.max,
    idleTimeoutMillis: config.database.idleTimeoutMillis,
    connectionTimeoutMillis: config.database.connectionTimeoutMillis,
  })
} else if (config.database.host) {
  pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    password: config.database.password,
    min: config.database.min,
    max: config.database.max,
    idleTimeoutMillis: config.database.idleTimeoutMillis,
    connectionTimeoutMillis: config.database.connectionTimeoutMillis,
  })
}

// Create Kysely instance
export const db = pool
  ? new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      plugins: [new CamelCasePlugin()], // Convert snake_case to camelCase
    })
  : undefined

// Export typed instance
export type KyselyDB = typeof db

/**
 * Transaction helper
 */
export async function transaction<T>(
  callback: (trx: Kysely<Database>) => Promise<T>
): Promise<T> {
  if (!db) {
    throw new Error('Database not configured')
  }
  return await db.transaction().execute(callback)
}

/**
 * Database health check
 */
export async function checkHealth(): Promise<{
  connected: boolean
  pool?: {
    total: number
    idle: number
    waiting: number
  }
  error?: string
}> {
  if (!db || !pool) {
    return {
      connected: false,
      error: 'Database not configured'
    }
  }

  try {
    // Simple connectivity test
    await db.selectFrom('users').select('id').limit(1).execute()

    // Get pool statistics
    const poolStats = {
      // @ts-ignore - accessing internal pool properties (Node-Postgres)
      total: (pool as any).totalCount || 0,
      // @ts-ignore
      idle: (pool as any).idleCount || 0,
      // @ts-ignore
      waiting: (pool as any).waitingCount || 0,
    }

    return {
      connected: true,
      pool: poolStats,
    }
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Graceful shutdown
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end()
  }
}

/**
 * Query builder helpers
 */
export const qb = {
  /**
   * Build a dynamic where clause
   */
  dynamicWhere<T extends keyof Database>(
    query: any,
    conditions: Record<string, any>
  ) {
    let result = query
    for (const [key, value] of Object.entries(conditions)) {
      if (value !== undefined && value !== null) {
        result = result.where(key, '=', value)
      }
    }
    return result
  },

  /**
   * Apply pagination
   */
  paginate<T extends keyof Database>(
    query: any,
    page: number = 1,
    limit: number = 20
  ) {
    const offset = (page - 1) * limit
    return query.limit(limit).offset(offset)
  },

  /**
   * Apply sorting
   */
  orderBy<T extends keyof Database>(
    query: any,
    sortBy: string = 'created_at',
    order: 'asc' | 'desc' = 'desc'
  ) {
    return query.orderBy(sortBy, order)
  },
}

// Export everything needed
export default db
export type { Database } from './types'
