/**
 * Migration: `multitable_automation_executions.rule_action_fingerprint` — the #4196 §4 retry rule-change guard.
 *
 * A retry must be refused if the rule's actions CHANGED since the original execution (a config-only edit
 * included), because the applied-ledger `action_key`s were computed against the OLD rule. The comparison uses
 * the §2.1 action-set fingerprint over the RAW config (`deriveRuleActionSetFingerprint`) — the SAME identity
 * the Class-A claim keys on, so the two never diverge. It CANNOT be re-derived from the persisted
 * `rule_snapshot` because that column is REDACTED (secret-shaped values masked), which would diverge from the
 * raw-config claim identity. So the RAW fingerprint is captured at execution time and stored here (it is a
 * one-way sha256 of the action identities — no business values, safe to store un-redacted).
 *
 * Nullable: executions that ran BEFORE this column existed have none; for them the retry guard is SKIPPED
 * (rollout-safe / non-regressing) — a missing fingerprint means "cannot check", NOT a refusal, so every
 * pre-column execution stays retryable. The guard only fires when a fingerprint IS present and differs.
 * Additive only; nothing reads it until the executor/retry wiring lands with it.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE multitable_automation_executions ADD COLUMN IF NOT EXISTS rule_action_fingerprint text`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE multitable_automation_executions DROP COLUMN IF EXISTS rule_action_fingerprint`.execute(db)
}
