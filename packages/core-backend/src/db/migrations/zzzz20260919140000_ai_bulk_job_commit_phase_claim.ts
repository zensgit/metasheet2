/**
 * Migration: the AI bulk-fill job's COMMIT PHASE gets its own status and an identity-bearing
 * claim (#5842). Two changes to multitable_ai_bulk_job, both on the header table only.
 *
 * 1) uq_mt_ai_bulk_job_active must also cover `committing`.
 *    zzzz20260622120000_create_multitable_ai_bulk_job.ts created
 *      uq_mt_ai_bulk_job_active ON multitable_ai_bulk_job (actor_id, sheet_id, field_id)
 *        WHERE status IN ('queued', 'running', 'suspended')
 *    which enforces BJ-7: at most ONE active job per (actor, sheet, field). The commit phase used
 *    to re-use the `running` status, so a job being committed was inside that predicate. #5842
 *    gives the commit phase its OWN status, `committing` (the worker generates only in
 *    `running`), so the predicate must be widened by exactly that one status — otherwise a commit
 *    in flight would leave the slot free and a second whole-column AI fill could start (and
 *    charge) against the same target while the first one is still writing.
 *    `findActiveBulkJob` (services/ai-bulk-job-service.ts) reads the SAME four statuses.
 *
 * 2) commit_claim_id TEXT — WHICH commit request holds the `committing` claim.
 *    A commit is an in-REQUEST phase, so a pod restart / OOM between the claim and the finish
 *    leaves the header `committing` with nobody to release it. The service therefore reclaims a
 *    claim that has stopped heartbeating (BULK_JOB_COMMIT_CLAIM_STALE_MS), which means TWO
 *    requests can believe they hold it. Guarding the finish / release / heartbeat on
 *    `status = 'committing' AND commit_claim_id = $me` is what keeps a reclaimed request from
 *    resolving — or flipping to `errored` — a claim that now belongs to someone else.
 *    NULL for every job outside the commit phase (and cleared on resolve / release / cancel /
 *    orphan reconcile), so no backfill is needed: a pre-existing row is simply not mid-commit.
 *
 * Idempotent (migration-replay runs the stream twice): the column add is guarded by
 * addColumnIfNotExists, and the index is DROP … IF EXISTS then CREATE … IF NOT EXISTS. Widening
 * the predicate cannot fail on existing data — `committing` is a new status no database has yet
 * written, so no new duplicate can be brought into the index.
 *
 * Tables: multitable_ai_bulk_job (one nullable column + one index predicate)
 * Breaking: No
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { addColumnIfNotExists, checkTableExists } from './_patterns'

const TABLE = 'multitable_ai_bulk_job'

export async function up(db: Kysely<unknown>): Promise<void> {
  // The table is created by zzzz20260622120000; a lane that skipped that migration has no index
  // to widen (and CREATE INDEX would error on the missing relation) — same skip shape that
  // migration uses for its own table.
  if (!(await checkTableExists(db, TABLE))) {
    console.log(`[Migration] Table ${TABLE} does not exist, skipping the commit-phase changes`)
    return
  }
  console.log('[Migration] Adding multitable_ai_bulk_job.commit_claim_id (#5842)')
  await addColumnIfNotExists(db, TABLE, 'commit_claim_id', 'text')
  console.log('[Migration] Widening uq_mt_ai_bulk_job_active to include the committing phase (#5842)')
  await sql`DROP INDEX IF EXISTS uq_mt_ai_bulk_job_active`.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mt_ai_bulk_job_active
      ON multitable_ai_bulk_job (actor_id, sheet_id, field_id)
      WHERE status IN ('queued', 'running', 'suspended', 'committing')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, TABLE))) return
  await sql`DROP INDEX IF EXISTS uq_mt_ai_bulk_job_active`.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mt_ai_bulk_job_active
      ON multitable_ai_bulk_job (actor_id, sheet_id, field_id)
      WHERE status IN ('queued', 'running', 'suspended')
  `.execute(db)
  await sql`ALTER TABLE multitable_ai_bulk_job DROP COLUMN IF EXISTS commit_claim_id`.execute(db)
}
