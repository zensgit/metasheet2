import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

const connectionString = process.env.DATABASE_URL || ''

const max = parseInt(process.env.PGPOOL_MAX || '10', 10)
const idleTimeoutMillis = parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10)
const connectionTimeoutMillis = parseInt(process.env.PG_CONN_TIMEOUT_MS || '5000', 10)

export const pool = connectionString
  ? new Pool({ connectionString, max, idleTimeoutMillis, connectionTimeoutMillis })
  : undefined

export async function query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  if (!pool) throw new Error('DATABASE_URL not configured')
  return pool.query<T>(text, params)
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('DATABASE_URL not configured')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export function getPoolStats(): { total: number; idle: number; waiting: number } | null {
  if (!pool) return null
  // @ts-ignore - pg types don't expose these counts in d.ts
  return { total: (pool as any).totalCount || 0, idle: (pool as any).idleCount || 0, waiting: (pool as any).waitingCount || 0 }
}
