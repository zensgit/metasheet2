/**
 * Migration: `meta_automation_outbound_intent` — the #4196 Class-B two-phase intent/outcome table
 * (design-lock `approval-automation-retry-action-classification-designlock-20260712.md` §3).
 *
 * SEPARATE from the class-A `meta_automation_action_applied` claim table: the class-A table stays TERMINAL
 * (a UNIQUE claim row, no status transitions); class-B needs a two-phase state machine because its effect
 * leaves the process and cannot sit inside a transaction (§0). The row is keyed by the SAME identity family
 * as the class-A ledger — (kind, root_execution_id, action_key), same `kind` namespace discriminator (§2.2)
 * so a real_fire test-run's outbound intent is disjoint from any real execution's — but this is its own
 * table with its own lifecycle:
 *
 *   pending → sent            (the attempt got a definite 2xx)
 *           → failed          (DEFINITE pre-dispatch non-delivery — DNS/conn-refused/TLS; eligible to retry)
 *           → outcome_unknown (TERMINAL: timeout / reset / ANY HTTP status incl every 4xx §8 Q-B —
 *                              the send MAY have happened; NEVER auto-resend)
 *
 * VALUES-FREE: only the identity (a sha256 action_key), a status, an attempt count, and a BOUNDED redacted
 * reason class in `last_error` — never a payload, URL, or token.
 *
 * Additive, new table; `down()` drops it.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_automation_outbound_intent (
      id                 bigserial PRIMARY KEY,
      kind               text NOT NULL
                           CONSTRAINT outbound_intent_kind_valid CHECK (kind IN ('execution','test_run')),
      root_execution_id  text NOT NULL
                           CONSTRAINT outbound_intent_root_nonblank CHECK (root_execution_id ~ '[!-~]'),
      action_key         text NOT NULL
                           CONSTRAINT outbound_intent_action_key_nonblank CHECK (action_key ~ '[!-~]'),
      status             text NOT NULL DEFAULT 'pending'
                           CONSTRAINT outbound_intent_status_valid
                             CHECK (status IN ('pending','sent','failed','outcome_unknown')),
      attempts           int  NOT NULL DEFAULT 0
                           CONSTRAINT outbound_intent_attempts_nonneg CHECK (attempts >= 0),
      last_error         text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_intent_identity
    ON meta_automation_outbound_intent (kind, root_execution_id, action_key)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_automation_outbound_intent`.execute(db)
}
