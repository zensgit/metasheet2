/**
 * FWB-3 — `approval_node_decision_values`: approver-confirmed decision field values frozen
 * inside the dispatchAction instance-lock transaction (#4203 §6).
 *
 * Keyed (instance_id, node_key, entry_epoch, field_id). A re-entered node (new entry_epoch)
 * freezes a NEW set; an old epoch's values are never reused for writeback. transfer / jump /
 * timeout leave a node WITHOUT writing rows here — writeback then fails closed (no half-write).
 *
 * Additive only. Values are freeze-at-decision-time snapshots; writeback reads them and NEVER
 * re-reads the request payload.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS approval_node_decision_values (
      id              text PRIMARY KEY,
      instance_id     text NOT NULL
                        CONSTRAINT approval_node_decision_values_instance_nonblank CHECK (instance_id ~ '[!-~]'),
      node_key        text NOT NULL
                        CONSTRAINT approval_node_decision_values_node_nonblank CHECK (node_key ~ '[!-~]'),
      entry_epoch     int  NOT NULL
                        CONSTRAINT approval_node_decision_values_epoch_pos CHECK (entry_epoch >= 1),
      assignment_id   text,
      field_id        text NOT NULL
                        CONSTRAINT approval_node_decision_values_field_nonblank CHECK (field_id ~ '[!-~]'),
      value           jsonb NOT NULL,
      actor_id        text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_approval_node_decision_values_identity
        UNIQUE (instance_id, node_key, entry_epoch, field_id)
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_node_decision_values_instance_node
    ON approval_node_decision_values (instance_id, node_key, entry_epoch DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS approval_node_decision_values`.execute(db)
}
