import type { Kysely } from 'kysely'
import { db } from './db'
import type { Database } from './types'

export { db }

/**
 * Execute a callback within a database transaction
 */
export async function transaction<T>(
  callback: (trx: Kysely<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(callback)
}
