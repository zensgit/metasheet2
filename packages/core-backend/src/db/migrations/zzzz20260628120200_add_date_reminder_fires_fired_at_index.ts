/**
 * Add the retention-sweep index for the date-reminder idempotency ledger.
 *
 * The daily 365-day aging path deletes rows by `fired_at < cutoff`; existing deployments already have the
 * table from `zzzz20260628120100_create_date_reminder_fires`, so this must be a new migration rather than an
 * edit to the shipped table migration.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_date_reminder_fires_fired_at
    ON meta_automation_date_reminder_fires (fired_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_date_reminder_fires_fired_at`.execute(db)
}
