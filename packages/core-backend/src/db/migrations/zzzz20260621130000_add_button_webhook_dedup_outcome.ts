/**
 * Migration: send_webhook B1-S2 — durable per-run OUTCOME on the button dedup marker.
 *
 * The B1-S1 dedup marker recorded only that a side-effecting run was CLAIMED, not how it
 * ended. For send_webhook (real external egress) that is unsafe: a replay of a claimed-but-
 * failed / never-completed run would otherwise be reported as success. This adds a nullable
 * `outcome` (+ http_status / result_message / completed_at) so a replay returns the TRUE
 * stored outcome, and a never-completed run stays non-success (at-most-once; `pending` is
 * terminal by design — never expired or requeued, which would reintroduce a double-fire).
 *
 * Nullable + CHECK (NOT a PG enum): existing send_notification / update_record rows leave
 * these columns NULL and are completely untouched (no enum-migration / rollback risk). NULL
 * is interpreted as "unknown/pending" ONLY by the send_webhook branch.
 */

import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE multitable_button_run_dedup
      ADD COLUMN IF NOT EXISTS outcome text,
      ADD COLUMN IF NOT EXISTS http_status integer,
      ADD COLUMN IF NOT EXISTS result_message text,
      ADD COLUMN IF NOT EXISTS completed_at timestamptz
  `.execute(db)

  // Constrain the small closed set WITHOUT a PG enum (nullable; NULL = legacy/non-webhook row).
  await sql`
    ALTER TABLE multitable_button_run_dedup
      DROP CONSTRAINT IF EXISTS chk_button_run_dedup_outcome
  `.execute(db)
  await sql`
    ALTER TABLE multitable_button_run_dedup
      ADD CONSTRAINT chk_button_run_dedup_outcome
      CHECK (outcome IS NULL OR outcome IN ('pending', 'succeeded', 'failed'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE multitable_button_run_dedup DROP CONSTRAINT IF EXISTS chk_button_run_dedup_outcome`.execute(db)
  await sql`
    ALTER TABLE multitable_button_run_dedup
      DROP COLUMN IF EXISTS completed_at,
      DROP COLUMN IF EXISTS result_message,
      DROP COLUMN IF EXISTS http_status,
      DROP COLUMN IF EXISTS outcome
  `.execute(db)
}
