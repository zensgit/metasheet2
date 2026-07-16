/**
 * Migration: `meta_automation_action_applied` — the ACTION-LEVEL idempotency ledger (FWB prerequisite).
 *
 * #4203 §2.3 ruling: a bare `approval_instance_id UNIQUE` would block a second rule/action forever, so the
 * business-level claim key is the composite below. Two dedup layers stack: the EVENT level (`event_fires` /
 * outbox per-consumer rows) stops "the same event redelivered"; THIS ledger stops "the same instance's same
 * action re-applied" across retries/redeliveries/zombie double-sends — the Class-A same-DB write claim is
 * INSERTed in the SAME transaction as the record write + revision + outbox row (§3 D9), so a zombie's
 * duplicate write collides on the UNIQUE key and rolls back (natural fencing for same-DB effects).
 *
 *   - `action_key` = the #4196-C4 corrected triple identity {structuralPath, action.type, canonicalConfig
 *     hash} — stable across fence tokens and attempts (the outbound-idempotency seed for Class-B).
 *   - FWB-1/FWB-2 uniqueness = (instance_id, rule_id, action_key) with node_key='' AND entry_epoch=0
 *     (sentinel: non-node-scoped). FWB-3 adds real (node_key, entry_epoch) — 退回/跳转 re-entry gets a new
 *     epoch, and an old epoch's values are never reused (§6). One UNIQUE index covers both via sentinels.
 *   - `application_mode` separates test-run/dry-run isolation from real applies ('apply' | 'test_run'):
 *     a test run claims in mode 'test_run' and NEVER blocks (or is blocked by) a real apply.
 *   - Class-B outbound effects don't get exactly-once from this table — they carry the derived idempotency
 *     key to the endpoint and record `outcome_unknown` without auto-resend when the endpoint can't dedup.
 *   - `result_ref` stores only IDENTIFIERS (record id / revision id), never business values (values-free).
 *
 * Additive only; nothing reads or writes this table until the FWB runtime lands behind its own gate.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_automation_action_applied (
      id               text PRIMARY KEY,
      instance_id      text NOT NULL
                         CONSTRAINT action_applied_instance_nonblank CHECK (instance_id ~ '[!-~]'),
      rule_id          text NOT NULL
                         CONSTRAINT action_applied_rule_nonblank CHECK (rule_id ~ '[!-~]'),
      action_key       text NOT NULL
                         CONSTRAINT action_applied_action_key_nonblank CHECK (action_key ~ '[!-~]'),
      node_key         text NOT NULL DEFAULT '',
      entry_epoch      int  NOT NULL DEFAULT 0
                         CONSTRAINT action_applied_epoch_nonneg CHECK (entry_epoch >= 0),
      application_mode text NOT NULL DEFAULT 'apply'
                         CONSTRAINT action_applied_mode_valid CHECK (application_mode IN ('apply','test_run')),
      result_ref       text,
      applied_at       timestamptz NOT NULL DEFAULT now(),
      -- node_key and entry_epoch must move together: BOTH the non-node sentinel ('', 0) OR BOTH a real
      -- FWB-3 node scope (non-blank node_key, epoch >= 1). Without this, ('', 7) and ('node_A', 0) are
      -- accepted and can split one idempotency identity into two rows (#4340 review P2).
      CONSTRAINT action_applied_node_epoch_paired
        CHECK ((node_key = '' AND entry_epoch = 0) OR (node_key <> '' AND entry_epoch >= 1))
    )
  `.execute(db)
  // the single business-claim key: sentinels (node_key='', entry_epoch=0) cover FWB-1/2; FWB-3 uses real values.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_action_applied_business_claim
    ON meta_automation_action_applied (instance_id, rule_id, action_key, node_key, entry_epoch, application_mode)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_automation_action_applied`.execute(db)
}
