/**
 * Lock and statement bounds for a migration, shared by the migrations that need them.
 *
 * Kysely runs every pending PostgreSQL migration of one run in a single transaction, so a setting made
 * with `set_config(..., true)` in one migration would stay in force for every later migration of the
 * same run. A migration therefore reads the current values, sets its own, runs, and puts the values it
 * read back. On failure the enclosing transaction rolls the settings back with everything else.
 *
 * The bounds are 5 seconds for `lock_timeout` and 5 minutes for `statement_timeout`, the same values
 * as zzzz20260725130000_expand_directory_identity_corp_scope.ts. `lock_timeout` limits the wait to
 * acquire a lock, not how long one is held.
 */
import { sql, type Kysely } from 'kysely'

export const MIGRATION_LOCK_TIMEOUT = '5s'
export const MIGRATION_STATEMENT_TIMEOUT = '5min'

export type MigrationTimeouts = { lock_timeout: string; statement_timeout: string }

export async function readMigrationTimeouts(db: Kysely<unknown>): Promise<MigrationTimeouts> {
  const result = await sql<MigrationTimeouts>`
    SELECT
      current_setting('lock_timeout') AS lock_timeout,
      current_setting('statement_timeout') AS statement_timeout
  `.execute(db)
  return result.rows[0] ?? { lock_timeout: '0', statement_timeout: '0' }
}

export async function applyMigrationTimeouts(db: Kysely<unknown>): Promise<void> {
  await sql`
    SELECT
      set_config('lock_timeout', ${MIGRATION_LOCK_TIMEOUT}, true),
      set_config('statement_timeout', ${MIGRATION_STATEMENT_TIMEOUT}, true)
  `.execute(db)
}

export async function restoreMigrationTimeouts(db: Kysely<unknown>, previous: MigrationTimeouts): Promise<void> {
  await sql`
    SELECT
      set_config('lock_timeout', ${previous.lock_timeout}, true),
      set_config('statement_timeout', ${previous.statement_timeout}, true)
  `.execute(db)
}
