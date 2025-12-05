import { Kysely, PostgresDialect } from 'kysely'
import { poolManager } from '../integration/db/connection-pool'
import type { Database } from './types'

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: poolManager.get().getInternalPool()
  })
})
