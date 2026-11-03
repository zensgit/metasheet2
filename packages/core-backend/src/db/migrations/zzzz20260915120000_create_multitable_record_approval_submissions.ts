/**
 * Migration: multitable × approval phase 2 — RECORD-LEVEL submit-for-approval link table.
 *
 * Purpose: a multitable record can be submitted to ONE approval template at a time, WITHOUT an
 * automation rule. `approval_instances` has no "source record" column (only `source_system` /
 * `external_approval_id`, reserved for the PLM mirror, and a caller-unsettable `business_key`), and
 * `GET /api/approvals` is scoped to requester/approver/cc/admin — so the RECORD side must own its own
 * table. Design: docs/development/takeover-beiliao-20260821/
 * multitable-approval-phase2-record-submit-design-20260915.md §3.
 *
 * Tables: multitable_record_approval_submissions (new). Breaking: No — new table only.
 *
 * THE TWO LOAD-BEARING INDEXES
 *   1. `uniq_mt_record_approval_in_flight` — PARTIAL UNIQUE on (sheet_id, record_id, template_id)
 *      WHERE status IN ('creating','pending'). This IS the "one in-flight submission per
 *      (record, template)" rule. It is an INDEX and not a lock on purpose: `createApproval` opens its
 *      OWN connection + transaction and ends by taking `pg_advisory_xact_lock('record-link:row-auth:…')`
 *      on (sheet, record), so a route-held advisory lock across the createApproval call would invert the
 *      lock order. Two concurrent submits both INSERT 'creating'; exactly one wins, the loser gets
 *      SQLSTATE 23505 on this index name and is answered 409 RECORD_APPROVAL_IN_FLIGHT. PARTIAL is the
 *      point: a terminal ('approved'/'rejected'/'revoked'/'cancelled'/'failed') row must NOT block the
 *      next submission of the same (record, template) — drop the WHERE clause and re-submitting after a
 *      rejection becomes impossible.
 *      The predicate literal is mirrored in code by `RECORD_APPROVAL_IN_FLIGHT_STATUSES`
 *      (multitable/record-approval-submission-service.ts); the unit spec cross-checks the two so neither
 *      side can drift alone.
 *   2. `uniq_mt_record_approval_instance` — UNIQUE (approval_instance_id) WHERE NOT NULL. The completion
 *      consumer locates the submission BY INSTANCE id; two rows for one instance would double-notify.
 *
 * `record_snapshot` stores the record `data` as it was at submit time (drift anchor together with
 * `record_version_at_submit` = `meta_records.version`). `meta_record_revisions.snapshot` is only written
 * when the caller passes one and is subject to retention cleanup, so it cannot be relied on here. The
 * snapshot is NEVER returned raw by the read path — the drift response carries field IDS ONLY, masked by
 * the caller's own field-permission read mask.
 *
 * Idempotent: information_schema guard around the CREATE TABLE (the zzzz20260610150000 automation-bridge
 * migration's shape), every index `IF NOT EXISTS`, every constraint DROP-then-ADD.
 */

import { sql, type Kysely } from 'kysely'
import { checkTableExists } from './_patterns'

export const MULTITABLE_RECORD_APPROVAL_SUBMISSIONS_TABLE = 'multitable_record_approval_submissions'

/** The exact status values the in-flight partial unique index covers (mirrored in the service). */
export const MULTITABLE_RECORD_APPROVAL_IN_FLIGHT_STATUSES = ['creating', 'pending'] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, MULTITABLE_RECORD_APPROVAL_SUBMISSIONS_TABLE)
  if (!exists) {
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
    await sql`
      CREATE TABLE IF NOT EXISTS multitable_record_approval_submissions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sheet_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        approval_instance_id TEXT,
        approval_request_no TEXT,
        status TEXT NOT NULL,
        outcome TEXT,
        submitted_by TEXT NOT NULL,
        record_version_at_submit INTEGER NOT NULL,
        record_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `.execute(db)
  }

  // §3 index 1 — in-flight uniqueness. PARTIAL: terminal rows never block a re-submission.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_mt_record_approval_in_flight
      ON multitable_record_approval_submissions (sheet_id, record_id, template_id)
      WHERE status IN ('creating', 'pending')
  `.execute(db)

  // §3 index 2 — the completion consumer's lookup key; one submission per approval instance.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_mt_record_approval_instance
      ON multitable_record_approval_submissions (approval_instance_id)
      WHERE approval_instance_id IS NOT NULL
  `.execute(db)

  // §3 index 3 — the record drawer's list (newest first).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_mt_record_approval_record_created
      ON multitable_record_approval_submissions (sheet_id, record_id, created_at DESC)
  `.execute(db)

  await sql`
    ALTER TABLE multitable_record_approval_submissions
    DROP CONSTRAINT IF EXISTS chk_mt_record_approval_status
  `.execute(db)
  await sql`
    ALTER TABLE multitable_record_approval_submissions
    ADD CONSTRAINT chk_mt_record_approval_status
    CHECK (status IN ('creating', 'pending', 'approved', 'rejected', 'revoked', 'cancelled', 'failed'))
  `.execute(db)
  await sql`
    ALTER TABLE multitable_record_approval_submissions
    DROP CONSTRAINT IF EXISTS chk_mt_record_approval_outcome
  `.execute(db)
  await sql`
    ALTER TABLE multitable_record_approval_submissions
    ADD CONSTRAINT chk_mt_record_approval_outcome
    CHECK (outcome IS NULL OR outcome IN ('approved', 'rejected', 'revoked', 'cancelled'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_mt_record_approval_record_created`.execute(db)
  await sql`DROP INDEX IF EXISTS uniq_mt_record_approval_instance`.execute(db)
  await sql`DROP INDEX IF EXISTS uniq_mt_record_approval_in_flight`.execute(db)
  await sql`DROP TABLE IF EXISTS multitable_record_approval_submissions`.execute(db)
}
