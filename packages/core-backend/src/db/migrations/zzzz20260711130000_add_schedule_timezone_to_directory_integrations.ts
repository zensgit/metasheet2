import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Roadmap §7.8 "Add timezone support" — a nullable per-integration IANA timezone alongside
 * `directory_integrations.schedule_cron` (same table, same column shape — `schedule_cron`
 * itself is a plain column, not JSONB `config`, so the timezone lives next to it as a column
 * too). `directory_integrations` was itself created by a zzzz migration
 * (`zzzz20260324150000_create_directory_sync_tables.ts`), so this column addition MUST also
 * be a zzzz-prefixed TS migration — an 0xx SQL migration would run before the table exists
 * and silently no-op (see the sibling `directory_sync_runs.last_heartbeat_at` precedent in
 * `zzzz20260708100000_directory_sync_run_lease.ts`, which this mirrors).
 *
 * NULL for every pre-existing row (and any row that has never configured one). NULL /
 * 'UTC' / 'Etc/UTC' are all the SAME "no configured timezone" state — the scheduler
 * (`directory-sync-scheduler.ts`) and the save-time validator (`directory-sync-timezone.ts`
 * / `admin-directory.ts`) both resolve that state to the literal 'UTC', byte-identical to
 * every pre-§7.8 caller. No backfill needed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE directory_integrations ADD COLUMN IF NOT EXISTS schedule_timezone TEXT`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE directory_integrations DROP COLUMN IF EXISTS schedule_timezone`.execute(db)
}
