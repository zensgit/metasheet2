/**
 * Migration: B1-S1 D0-A §6 — at-most-once dedup marker for side-effecting button
 * runs (send_notification).
 *
 * A side-effecting button REQUIRES a requestId. The dedup key
 * (actor + sheet + record + field + requestId) is persisted BEFORE the
 * notification write via `INSERT ... ON CONFLICT (dedup_key) DO NOTHING`; a
 * replay collapses to a no-op (single effect). The UNIQUE constraint is the
 * atomic guard (no read-then-write race).
 *
 * `record_click` (inert) does NOT require a requestId and is never recorded here.
 */

import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS multitable_button_run_dedup (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      dedup_key text NOT NULL UNIQUE,
      actor_id text NOT NULL,
      sheet_id text NOT NULL,
      record_id text NOT NULL,
      field_id text NOT NULL,
      request_id text NOT NULL,
      execution_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  // Retention sweep anchor (the cleanup job prunes old markers by age).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_button_run_dedup_created
    ON multitable_button_run_dedup(created_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_multitable_button_run_dedup_created`.execute(db)
  await sql`DROP TABLE IF EXISTS multitable_button_run_dedup`.execute(db)
}
