import type { Pool as PgPool, QueryResult, QueryResultRow } from 'pg'
import { poolManager } from '../integration/db/connection-pool'

/**
 * Get the internal pg Pool instance
 */
export const pool: PgPool | null = poolManager.get().getInternalPool()

/**
 * Execute a parameterized SQL query
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return poolManager.get().query<T>(sql, params)
}

/**
 * Execute a query in a transaction
 */
export async function transaction<T>(
  handler: (client: { query: (sql: string, params?: unknown[]) => Promise<QueryResult> }) => Promise<T>
): Promise<T> {
  return poolManager.get().transaction(handler)
}

/**
 * Get pool statistics
 */
export function getPoolStats(): {
  total: number
  idle: number
  waiting: number
} {
  const p = pool
  if (!p) {
    return { total: 0, idle: 0, waiting: 0 }
  }
  return {
    total: p.totalCount,
    idle: p.idleCount,
    waiting: p.waitingCount
  }
}

export type { PgPool as Pool }
