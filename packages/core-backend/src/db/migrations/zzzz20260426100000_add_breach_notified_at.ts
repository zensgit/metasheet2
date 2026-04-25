import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Wave 2 WP5 follow-up — persistent SLA breach notification dedupe.
 *
 * Adds `breach_notified_at TIMESTAMPTZ` to `approval_metrics` so the
 * notifier can mark per-channel success durably. The companion partial
 * index makes the "list pending notifications" query a fast index scan
 * even when the bulk of breached rows have already been notified.
 *
 * Decoupling "marked as breached" from "successfully notified" upgrades
 * the notifier semantics from best-effort to at-least-once: rows where
 * every channel failed (or the leader crashed mid-dispatch) stay in the
 * `breach_notified_at IS NULL` set and the next scheduler tick retries.
 *
 * Idempotent — `IF NOT EXISTS` on both column and index — so existing
 * deployments that already partially populated breach state apply this
 * cleanly without duplicating work.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE approval_metrics
      ADD COLUMN IF NOT EXISTS breach_notified_at TIMESTAMPTZ
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS approval_metrics_breach_pending_idx
      ON approval_metrics (sla_breached_at NULLS FIRST, started_at)
      WHERE sla_breached = TRUE AND breach_notified_at IS NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS approval_metrics_breach_pending_idx`.execute(db)
  await sql`ALTER TABLE approval_metrics DROP COLUMN IF EXISTS breach_notified_at`.execute(db)
}
