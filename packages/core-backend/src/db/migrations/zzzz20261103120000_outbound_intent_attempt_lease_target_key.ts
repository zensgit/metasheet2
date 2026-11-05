/**
 * Migration: `meta_automation_outbound_intent` — attempt token, lease and per-target key for the #4196
 * Class-B two-phase intent/outcome ledger (`multitable/automation-outbound-intent.ts`).
 *
 * Why (ledger correctness, S0-c):
 *   - `attempt_token` (nullable text): the opaque token the claim mints for the ONE attempt it authorizes.
 *     The terminal write is fenced `status='pending' AND attempt_token = <mine>`, so only the attempt that
 *     was authorized can confirm its own result, and a replay's crash-flip names the attempt it observed.
 *   - `lease_expires_at` (nullable timestamptz): a `pending` row with a LIVE lease is an attempt still in
 *     flight on another worker; a replay must neither send nor declare it dead. Only an EXPIRED lease may be
 *     flipped to `outcome_unknown`. Rows written before this migration have NULL = never live (the pre-lease
 *     crash-flip behaviour is preserved for them).
 *   - `target_key` (text NOT NULL DEFAULT '', #4450 §2.1/§2.2): the resolved recipient's stable identity for
 *     fan-out actions; '' (the column default) is the whole-action sentinel every single-send action writes,
 *     so every pre-existing row keeps its identity unchanged. NOT NULL (not nullable) on purpose: Postgres 14
 *     treats NULLs as distinct in a UNIQUE index, so a nullable segment would let two whole-action rows of the
 *     same action coexist and break at-most-once. CHECK `outbound_intent_target_key_shape`: '' or 16..64 hex.
 *   - the identity index `uq_outbound_intent_identity` is widened to (kind, root_execution_id, action_key,
 *     target_key). For sentinel rows this is exactly the old constraint (§2.2). The primitive's ON CONFLICT
 *     target names this column set, so this migration and the primitive ship in the same slice (§2.2 lockstep).
 *
 * Additive on a possibly non-empty table: no backfill, no rewrite (the default is catalog-only on PG 11+).
 *
 * `down()` works on a non-empty table and stays fail-closed: per-target rows cannot be represented under the
 * narrow identity, so each fan-out action collapses into ONE whole-action sentinel row — `outcome_unknown`
 * if ANY target was sent / unknown / still pending (never a resend of the whole action under old code), or
 * `failed` only if every target was a definite non-delivery — then the per-target rows are removed, the
 * narrow index is restored and the three columns are dropped. On-prem R-line migrations are one-way in
 * practice (R-line release notes); `down()` exists for the reviewed rollback path and its real-DB golden.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_automation_outbound_intent
      ADD COLUMN IF NOT EXISTS attempt_token    text,
      ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS target_key       text NOT NULL DEFAULT ''
  `.execute(db)
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'outbound_intent_target_key_shape'
           AND conrelid = 'meta_automation_outbound_intent'::regclass
      ) THEN
        ALTER TABLE meta_automation_outbound_intent
          ADD CONSTRAINT outbound_intent_target_key_shape
          CHECK (target_key = '' OR target_key ~ '^[0-9a-f]{16,64}$');
      END IF;
    END
    $$
  `.execute(db)
  await sql`DROP INDEX IF EXISTS uq_outbound_intent_identity`.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_intent_identity
    ON meta_automation_outbound_intent (kind, root_execution_id, action_key, target_key)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 1. Collapse every fan-out action's per-target rows into one fail-closed whole-action sentinel row.
  await sql`
    WITH fanout AS (
      SELECT kind, root_execution_id, action_key,
             CASE WHEN bool_or(status <> 'failed') THEN 'outcome_unknown' ELSE 'failed' END AS status,
             max(attempts) AS attempts
        FROM meta_automation_outbound_intent
       WHERE target_key <> ''
       GROUP BY kind, root_execution_id, action_key
    )
    INSERT INTO meta_automation_outbound_intent
      (kind, root_execution_id, action_key, target_key, status, attempts, last_error)
    SELECT kind, root_execution_id, action_key, '', status, attempts, 'rollback_collapsed_fanout'
      FROM fanout
    ON CONFLICT (kind, root_execution_id, action_key, target_key) DO UPDATE
       SET status = CASE
                      WHEN meta_automation_outbound_intent.status IN ('sent', 'outcome_unknown')
                        THEN meta_automation_outbound_intent.status
                      WHEN EXCLUDED.status = 'outcome_unknown' THEN 'outcome_unknown'
                      ELSE meta_automation_outbound_intent.status
                    END,
           last_error = 'rollback_collapsed_fanout',
           updated_at = now()
  `.execute(db)
  await sql`DELETE FROM meta_automation_outbound_intent WHERE target_key <> ''`.execute(db)
  // 2. Restore the narrow identity index (every remaining row is a sentinel row, so it is unique again).
  await sql`DROP INDEX IF EXISTS uq_outbound_intent_identity`.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_intent_identity
    ON meta_automation_outbound_intent (kind, root_execution_id, action_key)
  `.execute(db)
  // 3. Drop the additive columns.
  await sql`
    ALTER TABLE meta_automation_outbound_intent
      DROP CONSTRAINT IF EXISTS outbound_intent_target_key_shape
  `.execute(db)
  await sql`
    ALTER TABLE meta_automation_outbound_intent
      DROP COLUMN IF EXISTS target_key,
      DROP COLUMN IF EXISTS lease_expires_at,
      DROP COLUMN IF EXISTS attempt_token
  `.execute(db)
}
