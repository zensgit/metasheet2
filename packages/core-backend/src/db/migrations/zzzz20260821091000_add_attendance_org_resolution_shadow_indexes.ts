import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Adds the two read-pattern indexes for `attendance_org_resolution_shadow`
 * (zzzz20260821090000_create_attendance_org_resolution_shadow.ts) as a SEPARATE migration,
 * deliberately, rather than folded into that table's own `up()`: any persistent dev/CI database
 * that already ran the create-table migration by name before these indexes existed would never
 * receive them from an edit to that file — kysely tracks migrations by name and never re-runs
 * one it has already recorded. A new, independently-tracked migration applies to every database
 * regardless of when it first created the table (idempotent `IF NOT EXISTS` either way).
 *
 * Supports the read patterns an operator/analyst actually needs once `shadow` is on anywhere
 * (chronological scan; per-user chronological scan) — not exercised by the plugin itself, which
 * never reads this table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_org_resolution_shadow_created_at
      ON attendance_org_resolution_shadow (created_at)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_org_resolution_shadow_user_id_created_at
      ON attendance_org_resolution_shadow (user_id, created_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_attendance_org_resolution_shadow_user_id_created_at`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_attendance_org_resolution_shadow_created_at`.execute(db)
}
