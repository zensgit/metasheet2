/**
 * Migration: AI bulk-fill async job (B-4 Slice 1, BJ-1 of
 * docs/development/multitable-ai-bulk-fill-b4-async-job-designlock-20260622.md).
 *
 * Two tables persist a resumable whole-column AI fill so review / progress /
 * commit survive crash, cancel, and quota-pause:
 *
 *  - multitable_ai_bulk_job — the job HEADER (mirrors multitable_automation_jobs):
 *    one row per started job, carrying the workflow-job-contract `status`
 *    vocabulary (no new enum), the BJ-7 active-job key (actor + sheet + field +
 *    scope_fingerprint), running progress counters, the durable aggregate commit
 *    outcome (JSONB), and quota_paused.
 *
 *  - multitable_ai_bulk_job_rows — the DURABLE per-row state store (BJ-9, the
 *    keystone). One row per in-scope record, written AS EACH ROW RESOLVES so a
 *    crashed/cancelled/quota-paused job loses no work. It is a SUPERSET of the
 *    inline `multitable_ai_bulk_preview_cache` (which holds only confirmable
 *    outputs and cannot back review-at-scale): it also stores `current_value`
 *    (the truthful diff "before"), the row `state`, and skip/failure `reason`.
 *    PK (job_id, record_id); index (job_id, ordinal) for the paginated review.
 *
 * The inline ≤200 path is UNCHANGED — it still uses multitable_ai_bulk_preview_cache.
 * The CHARGE for a generated row is booked in multitable_ai_usage_ledger at
 * generation time, INDEPENDENT of these tables (charge-on-generation, never
 * released); GC'ing an expired job via expires_at NEVER un-charges it.
 *
 * Structural template: multitable_automation_jobs + multitable_ai_bulk_preview_cache
 * (TEXT ids, JSONB aggregate, NUMERIC(12,6) cost, indexes for the hot reads).
 *
 * Tables: multitable_ai_bulk_job, multitable_ai_bulk_job_rows
 * Breaking: No
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const HEADER_TABLE = 'multitable_ai_bulk_job'
const ROWS_TABLE = 'multitable_ai_bulk_job_rows'

export async function up(db: Kysely<unknown>): Promise<void> {
  const headerExists = await checkTableExists(db, HEADER_TABLE)
  if (!headerExists) {
    console.log(`[Migration] Creating table: ${HEADER_TABLE}`)
    await sql`
      CREATE TABLE IF NOT EXISTS multitable_ai_bulk_job (
        job_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        sheet_id TEXT NOT NULL,
        field_id TEXT NOT NULL,
        scope_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        suspend_reason TEXT,
        total INTEGER NOT NULL DEFAULT 0,
        generated INTEGER NOT NULL DEFAULT 0,
        settled_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
        quota_paused BOOLEAN NOT NULL DEFAULT false,
        aggregate JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `.execute(db)
  } else {
    console.log(`[Migration] Table ${HEADER_TABLE} already exists, skipping`)
  }
  // BJ-7 ENFORCEMENT: at most ONE active (queued/running/suspended) job per
  // (actor, sheet, field). A partial UNIQUE index makes a concurrent double-start
  // a catchable constraint violation, not a race — the route then reads the
  // existing row and returns its jobId (same fingerprint) or 409 (different one).
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mt_ai_bulk_job_active
      ON multitable_ai_bulk_job (actor_id, sheet_id, field_id)
      WHERE status IN ('queued', 'running', 'suspended')
  `.execute(db)
  // The aging sweep scans expires_at.
  await sql`CREATE INDEX IF NOT EXISTS idx_mt_ai_bulk_job_expires ON multitable_ai_bulk_job (expires_at)`.execute(db)

  const rowsExists = await checkTableExists(db, ROWS_TABLE)
  if (!rowsExists) {
    console.log(`[Migration] Creating table: ${ROWS_TABLE}`)
    await sql`
      CREATE TABLE IF NOT EXISTS multitable_ai_bulk_job_rows (
        job_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        state TEXT NOT NULL,
        current_value TEXT,
        preview_version INTEGER,
        proposed_value TEXT,
        masked BOOLEAN NOT NULL DEFAULT false,
        reason TEXT,
        usage_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (job_id, record_id)
      )
    `.execute(db)
  } else {
    console.log(`[Migration] Table ${ROWS_TABLE} already exists, skipping`)
  }
  // Paginated review reads by (job_id, ordinal); progress counts scan by (job_id, state).
  await sql`CREATE INDEX IF NOT EXISTS idx_mt_ai_bulk_job_rows_ordinal ON multitable_ai_bulk_job_rows (job_id, ordinal)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_mt_ai_bulk_job_rows_ordinal`.execute(db)
  await sql`DROP TABLE IF EXISTS multitable_ai_bulk_job_rows`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_mt_ai_bulk_job_active`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_mt_ai_bulk_job_expires`.execute(db)
  await sql`DROP TABLE IF EXISTS multitable_ai_bulk_job`.execute(db)
}
