import { sql, type Kysely } from 'kysely'
import type { Database } from '../../src/db/types'
import type { ApiTokenIssuanceCredential } from '../../src/multitable/api-token-issuance'

/**
 * Issuance input for fixture tokens minted outside an HTTP request: the user's current access
 * generation and a session issued at the database clock now, without a sid. A token issued
 * later than every session watermark of the user passes the issuance fence.
 */
export async function fixtureIssuanceCredential(db: Kysely<Database>, userId: string): Promise<ApiTokenIssuanceCredential> {
  const row = await db
    .selectFrom('users')
    .select([
      sql<string | number | null>`access_generation`.as('access_generation'),
      sql<string | number>`extract(epoch FROM clock_timestamp())::float8`.as('now'),
    ])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (!row) throw new Error('fixture issuance credential: user row is missing')
  return {
    expectedAccessGeneration: Number(row.access_generation ?? 0),
    sessionId: null,
    issuedAt: Number(row.now),
  }
}
