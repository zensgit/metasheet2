import { sql } from 'kysely'
import type { Kysely } from 'kysely'

// Lock-7 OD-L7-6(a) — the append-only per-field revision ledger for handler-node form edits.
//
// A handler field write UPDATEs `approval_instances.form_snapshot` IN PLACE (Lock-7 creates the
// first mutation of that column) inside Lock-3 §3's handle transaction. Every mutated field also
// appends ONE row here carrying before/after, the actor, the node key and the node-entry epoch, plus
// `audit_record_id` = the `approval_records.id` of the `action:'handle'` row the same transaction
// inserted. Two consumers read this table:
//   - the mask-aware revision read surface (OD-L7-7 / G-8): before/after VALUES live here, never on
//     the broadly-scoped audit/history surface, so a hidden field's value cannot leak past its
//     intended audience.
//   - the 内容变更 dedup invalidation (OD-L7-11(a) / G-16): `MAX(audit_record_id)` is the latest
//     content-edit ordinal in `approval_records.id` space (BIGSERIAL), so a prior approval whose
//     audit ordinal precedes it is excluded from the auto-approval history. This is a NEW per-edit
//     marker — NOT a `nodeEntryEpoch` reuse (a field edit is a same-round mutation and MUST NOT bump
//     the node epoch, or the in-flight quorum tally is voided — Lock-3 G-12).
//
// DDL is owner-gated but mergeable (runs in the CI test DB). No data migration; additive table.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS approval_form_field_revisions (
      id BIGSERIAL PRIMARY KEY,
      instance_id TEXT NOT NULL,
      node_key TEXT NOT NULL,
      field_id TEXT NOT NULL,
      before_value JSONB,
      after_value JSONB,
      actor_id TEXT NOT NULL,
      node_entry_epoch INTEGER,
      audit_record_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  // Dedup MAX(audit_record_id) lookups and the mask-aware read both scope by instance.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_form_field_revisions_instance
    ON approval_form_field_revisions(instance_id, id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_approval_form_field_revisions_instance`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_form_field_revisions`.execute(db)
}
