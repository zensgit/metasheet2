import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * T3-2 — business/work-day calendar wired to approval SLA.
 *
 * Additive, nullable columns on approval_metrics for the calendar-typed SLA path, plus a NEW partial
 * index for the calendar overdue scan. The legacy `sla_hours` branch and its scan index
 * (`idx_approval_metrics_sla_scan`) are LEFT UNTOUCHED — a template carrying only `sla_hours` stays
 * byte-identical to today's UTC wall-clock SLA (opt-in; §8). No backfill for historical rows (§5/Q7).
 *
 *   - sla_calendar_org_id : the calendar org resolved from the requester/org snapshot at instance start.
 *   - sla_timezone        : the resolved timezone the deadline was computed in (audit; provider tz →
 *                           APP_TIMEZONE → UTC).
 *   - sla_due_at          : the absolute business-time due instant computed at node activation.
 *   - sla_unit            : SLA-unit discriminator — 'wall_clock' (legacy elapsed) or 'business' (calendar).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'approval_metrics')
  if (!exists) return

  await sql`ALTER TABLE approval_metrics ADD COLUMN IF NOT EXISTS sla_calendar_org_id TEXT`.execute(db)
  await sql`ALTER TABLE approval_metrics ADD COLUMN IF NOT EXISTS sla_timezone TEXT`.execute(db)
  await sql`ALTER TABLE approval_metrics ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ`.execute(db)
  await sql`ALTER TABLE approval_metrics ADD COLUMN IF NOT EXISTS sla_unit TEXT`.execute(db)

  await sql`
    ALTER TABLE approval_metrics
      DROP CONSTRAINT IF EXISTS approval_metrics_sla_unit_check
  `.execute(db)
  await sql`
    ALTER TABLE approval_metrics
      ADD CONSTRAINT approval_metrics_sla_unit_check
      CHECK (sla_unit IS NULL OR sla_unit IN ('wall_clock', 'business'))
  `.execute(db)

  // New partial index for the calendar overdue scan. Mirrors the shape of idx_approval_metrics_sla_scan
  // (kept as-is for the legacy path) but keys on the absolute due instant.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_metrics_sla_due_scan
      ON approval_metrics(sla_due_at)
      WHERE terminal_at IS NULL AND sla_due_at IS NOT NULL AND sla_breached = FALSE
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'approval_metrics')
  if (!exists) return
  await sql`DROP INDEX IF EXISTS idx_approval_metrics_sla_due_scan`.execute(db)
  await sql`ALTER TABLE approval_metrics DROP CONSTRAINT IF EXISTS approval_metrics_sla_unit_check`.execute(db)
  await sql`ALTER TABLE approval_metrics DROP COLUMN IF EXISTS sla_unit`.execute(db)
  await sql`ALTER TABLE approval_metrics DROP COLUMN IF EXISTS sla_due_at`.execute(db)
  await sql`ALTER TABLE approval_metrics DROP COLUMN IF EXISTS sla_timezone`.execute(db)
  await sql`ALTER TABLE approval_metrics DROP COLUMN IF EXISTS sla_calendar_org_id`.execute(db)
}
