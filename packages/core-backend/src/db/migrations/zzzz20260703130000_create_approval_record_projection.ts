/**
 * Migration: `approval_record_projection` — T3-6 approval read-model side mapping table.
 *
 * T3-6 materializes each approval instance as ONE row in a system-managed multitable sheet so
 * 飞书-grade reporting / dashboards / views / formulas come for free over the existing multitable
 * analytics. This side table is the instance↔record link (design-lock §4): keyed on the approval
 * instance id, it maps to the provisioned base/sheet/record and carries the monotonic
 * `projected_version` used to make the projection idempotent under at-least-once event redelivery
 * (a re-projection whose source version is not newer is a no-op — never a duplicate row).
 *
 * We deliberately do NOT add a column to every `meta_records` row (design-lock §4, Q5) — the mapping
 * lives here, off the hot record table. `last_projected_at` / `last_error` make a best-effort lost
 * write observable so the §6b reconcile sweep can self-heal it. No FK to `meta_sheets`/`meta_records`:
 * a dropped projected record (simulating a lost write) must leave the mapping healable by reconcile,
 * not cascade-deleted out from under it.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS approval_record_projection (
      instance_id text PRIMARY KEY,
      base_id text NOT NULL,
      sheet_id text NOT NULL,
      record_id text NOT NULL,
      projected_version integer NOT NULL,
      last_projected_at timestamptz NOT NULL DEFAULT now(),
      last_error text
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_record_projection_sheet
    ON approval_record_projection (sheet_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS approval_record_projection`.execute(db)
}
