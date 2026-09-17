/**
 * Approval change-request design lock v5.9 §4 — first-slice DDL, table 1 of 3.
 *
 * `approval_rounds` tracks a cancel/amend ATTEMPT against a business document that already has
 * an `approval_instances` row (`document_id`). First slice only ever writes `kind = 'cancel'`
 * (amend is a later phase, §7). `engine_instance_id` is the id of the dedicated cancel-round
 * runtime instance this attempt drives (see `createCancelRoundInstance`, ApprovalProductService.ts) —
 * nullable because a future `kind` might not need an engine instance at all.
 *
 * The partial unique index `uq_approval_rounds_pending_document` is I3 (§5): at most one round in
 * flight per document. C-3 (§3) is the ONLY thing allowed to move a round's `outcome` off
 * `'pending'` — that release is what lets a new round be opened.
 *
 * `policy_snapshot_at_create` is NOT NULL (every round freezes the policy that governed its
 * creation); `policy_snapshot_at_decision` is written once, at final evaluation (deferred to the
 * second slice — this slice never populates it).
 *
 * Non-blank CHECKs use the repo's dominant unanchored form `col ~ '[!-~]'` (contains at least one
 * printable non-space character), matching e.g. `approval_att_org_nonblank`
 * (`zzzz20260715210000_create_approval_attachments.ts:24`) and
 * `automation_outbox_event_id_nonblank` (`zzzz20260715120000_create_automation_outbox.ts:78`) —
 * NOT the anchored `^[!-~]+$` form used by the (minority) directory corp-scope migration. The
 * anchored form additionally rejects any non-ASCII byte anywhere in the string, which would make a
 * directory-sourced `requested_by` unwritable if it ever carries a non-ASCII user id; the lock
 * (§4, lock:141) names the unanchored predicate verbatim.
 *
 * Two indexes below (`idx_approval_rounds_engine_instance`, `idx_approval_rounds_document_started`)
 * are NOT named in lock §4 — they are additive-beyond-lock convenience indexes for lookups this
 * slice's services will need (engine-instance → round reverse lookup; per-document history scan).
 * Flagged here for the DDL-gate reviewer; drop them if the lock is read as an exhaustive DDL list.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS approval_rounds (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES approval_instances(id),
    kind TEXT NOT NULL CHECK (kind IN ('cancel')),
    engine_instance_id TEXT NULL REFERENCES approval_instances(id),
    requested_by TEXT NOT NULL,
    reason TEXT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ NULL,
    outcome TEXT NOT NULL DEFAULT 'pending'
      CHECK (outcome IN ('pending', 'applied', 'rejected', 'withdrawn', 'expired', 'blocked')),
    block_reason TEXT NULL,
    policy_snapshot_at_create JSONB NOT NULL,
    policy_snapshot_at_decision JSONB NULL,
    CONSTRAINT chk_approval_rounds_id_nonblank CHECK (id ~ '[!-~]'),
    CONSTRAINT chk_approval_rounds_document_id_nonblank CHECK (document_id ~ '[!-~]'),
    CONSTRAINT chk_approval_rounds_requested_by_nonblank CHECK (requested_by ~ '[!-~]')
  )`.execute(db)

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_rounds_pending_document
    ON approval_rounds (document_id)
    WHERE outcome = 'pending'`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_approval_rounds_engine_instance
    ON approval_rounds (engine_instance_id)
    WHERE engine_instance_id IS NOT NULL`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_approval_rounds_document_started
    ON approval_rounds (document_id, started_at DESC)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS approval_rounds CASCADE`.execute(db)
}
