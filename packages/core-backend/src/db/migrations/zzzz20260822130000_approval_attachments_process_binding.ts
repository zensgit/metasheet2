/**
 * Lock-9 (approver process attachments) — the relaxation migration (OD-L9-2(a)).
 *
 * Reference: docs/development/approval-lock9-handler-process-attachments-20260819.md, RATIFIED
 * 2026-08-21 with the §4.1 amendment. This migration is the OD-L9-2 "DEPLOY PRECONDITION": the
 * process-upload/bind code paths this slice ships INSERT/UPDATE `approval_attachments` rows with
 * `bind_kind='process'` and a NULL `field_id` — a write that fails closed with a hard NOT NULL
 * violation until this migration has run. `APPROVAL_ATTACHMENTS_ENABLED` must never be turned ON
 * in an environment that has not applied this migration.
 *
 * ONE-WAY ONCE THE FLAG HAS BEEN ON: once any `bind_kind='process'` row exists, `down` REFUSES
 * (see below) — genuine rollback requires purging every process row first, a decision this
 * migration does not make unilaterally (G-14).
 *
 * ADDS (pure, legacy-inert — every existing row becomes `bind_kind='form_field'` by the column
 * DEFAULT, so this block alone changes nothing observable):
 *   - `bind_kind` ('form_field' | 'process'), NOT NULL DEFAULT 'form_field'
 *   - `node_key` — the node the approver was acting at when they uploaded (process rows only)
 *   - `action_record_id bigint` — the `approval_records.id` the upload was bound to at commit.
 *     bigint, NO FK: OD-L9-2's literal text says "action_record_id text (FK to approval_records)"
 *     — `approval_records.id` is actually BIGSERIAL (20250924105000_create_approval_tables.ts:18),
 *     so a `text` column referencing it is a lock-text erratum. This migration ships `bigint`, no
 *     FK, mirroring the in-repo precedent `approval_form_field_revisions.audit_record_id BIGINT
 *     NOT NULL` (zzzz20260817130000_create_approval_form_field_revisions.ts:32), which also
 *     carries no FK. DISCLOSED DEVIATION from OD-L9-2's literal text — recorded again in the PR
 *     body per feedback_implementation_is_not_the_ratified_contract.
 *   - `staged_instance_id` — the upload-time TARGET instance, deliberately separate from
 *     `instance_id` (which continues to mean "committed to a submission" for BOTH kinds, OD-L9-5).
 *     No FK: a staged row whose target instance is deleted before commit should TTL-sweep like any
 *     other unbound row, not cascade-vanish out from under a still-uploading approver.
 *
 * MUTATES (NOT additive — the deploy-precondition half of OD-L9-2):
 *   `field_id` goes from NOT NULL + `CHECK (field_id ~ '[!-~]')` to nullable, re-guarded by
 *   `CHECK (bind_kind = 'process' OR (field_id IS NOT NULL AND field_id ~ '[!-~]'))`.
 *
 *   DISCLOSED SECOND DEVIATION from OD-L9-2's literal CHECK text: the ratified expression is
 *   written `CHECK (bind_kind='process' OR field_id ~ '[!-~]')`. Once `field_id` is nullable, that
 *   literal expression admits a THIRD, unintended state under SQL three-valued logic — a
 *   `bind_kind='form_field'` row with `field_id IS NULL` evaluates `FALSE OR NULL` = NULL, and
 *   PostgreSQL treats a NULL CHECK result as satisfied (accepted), not rejected. That defeats half
 *   of G-2 ("a form_field row with NULL field_id is REJECTED by the same CHECK"). This migration
 *   ships the NULL-safe equivalent `CHECK (bind_kind = 'process' OR (field_id IS NOT NULL AND
 *   field_id ~ '[!-~]'))`, which preserves OD-L9-2's ratified INTENT (process rows exempt,
 *   form_field rows still non-blank) while making the rejection leg real. Recorded in the PR body
 *   as a second literal-text deviation, same disclosure discipline as the action_record_id type.
 *
 * `down` — G-14: REFUSES while any `bind_kind='process'` row exists (values-free: existence only,
 * no id/count in the message), then drops the four added columns and restores the original
 * NOT NULL + CHECK shape.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_attachments ADD COLUMN IF NOT EXISTS bind_kind text NOT NULL DEFAULT 'form_field'`.execute(db)
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_att_bind_kind_valid') THEN
        ALTER TABLE approval_attachments
          ADD CONSTRAINT approval_att_bind_kind_valid CHECK (bind_kind IN ('form_field','process'));
      END IF;
    END $$;
  `.execute(db)

  await sql`ALTER TABLE approval_attachments ADD COLUMN IF NOT EXISTS node_key text`.execute(db)
  // bigint, no FK — see the module docblock (D-2 erratum disclosure).
  await sql`ALTER TABLE approval_attachments ADD COLUMN IF NOT EXISTS action_record_id bigint`.execute(db)
  // separate from instance_id by design (OD-L9-5); no FK (see module docblock).
  await sql`ALTER TABLE approval_attachments ADD COLUMN IF NOT EXISTS staged_instance_id text`.execute(db)

  // The constraint mutation — DEPLOY PRECONDITION, ONE-WAY once the flag has been ON.
  await sql`ALTER TABLE approval_attachments ALTER COLUMN field_id DROP NOT NULL`.execute(db)
  await sql`ALTER TABLE approval_attachments DROP CONSTRAINT IF EXISTS approval_att_field_nonblank`.execute(db)
  // NULL-safe re-expression — see the module docblock's second disclosed deviation.
  await sql`
    ALTER TABLE approval_attachments ADD CONSTRAINT approval_att_field_nonblank
      CHECK (bind_kind = 'process' OR (field_id IS NOT NULL AND field_id ~ '[!-~]'))
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_att_process_staged
    ON approval_attachments (staged_instance_id, uploader_id)
    WHERE bind_kind = 'process'
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // G-14: refuse while any process row exists — values-free (existence only, no id/count).
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM approval_attachments WHERE bind_kind = 'process') THEN
        RAISE EXCEPTION 'approval_attachments process rows exist — purge them before rolling back this migration';
      END IF;
    END $$;
  `.execute(db)

  await sql`DROP INDEX IF EXISTS idx_approval_att_process_staged`.execute(db)

  await sql`ALTER TABLE approval_attachments DROP CONSTRAINT IF EXISTS approval_att_field_nonblank`.execute(db)
  await sql`ALTER TABLE approval_attachments ALTER COLUMN field_id SET NOT NULL`.execute(db)
  await sql`
    ALTER TABLE approval_attachments ADD CONSTRAINT approval_att_field_nonblank
      CHECK (field_id ~ '[!-~]')
  `.execute(db)

  await sql`ALTER TABLE approval_attachments DROP COLUMN IF EXISTS staged_instance_id`.execute(db)
  await sql`ALTER TABLE approval_attachments DROP COLUMN IF EXISTS action_record_id`.execute(db)
  await sql`ALTER TABLE approval_attachments DROP COLUMN IF EXISTS node_key`.execute(db)
  await sql`ALTER TABLE approval_attachments DROP CONSTRAINT IF EXISTS approval_att_bind_kind_valid`.execute(db)
  await sql`ALTER TABLE approval_attachments DROP COLUMN IF EXISTS bind_kind`.execute(db)
}
