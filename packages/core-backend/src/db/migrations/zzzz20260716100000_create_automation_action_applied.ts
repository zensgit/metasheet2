/**
 * Migration: `meta_automation_action_applied` — the #4196 EXECUTION-SCOPED retry/test-run applied ledger.
 *
 * Row shape is the #4196 §2.2 LOCKED contract, verbatim:
 *   - `kind` is the NON-OPTIONAL namespace discriminator: 'execution' (a real retry lineage) | 'test_run'
 *     (a real_fire test-run, §6.1). It is PART OF the claim key, so a test-run row and a real-execution row
 *     can NEVER be the same claim even if their root_execution_id strings were identical — the structural
 *     disjointness §6.1 guarantees against client-supplied testRunOperationId values.
 *   - `root_execution_id`: kind='execution' → the original execution's lineage root; kind='test_run' → the
 *     SERVER-DERIVED scoped root (§6.1) — never the raw caller value.
 *   - `action_key`: the §2.1 ordered triple { structuralPath, action.type, canonicalConfig } — the same
 *     injectively-encoded identity `deriveActionKey` (automation-action-idempotency.ts) produces; the
 *     action's type participates in the key INSIDE this value.
 *   - `action_type` is NULLABLE audit metadata only — §2's claim INSERT supplies exactly the three key
 *     columns and must stay valid without it.
 *   - `UNIQUE (kind, root_execution_id, action_key)` is the exact target of §2's
 *     `INSERT ... ON CONFLICT DO NOTHING` — the whole class-A exactly-once-effective guarantee rests on it.
 *
 * Class-A protocol (§2): BEGIN → claim INSERT → 0 rows ⇒ ROLLBACK + report `already_applied`; 1 row ⇒ perform
 * the meta_records mutation → COMMIT. A crash at ANY point before COMMIT leaves NEITHER the ledger row NOR the
 * mutation durable; after COMMIT, BOTH. No window where one is durable and the other is not.
 *
 * DISTINCT from `meta_fwb_action_applied` (the FWB approval-instance/node-scoped ledger) — the two tables
 * coexist; see the cross-ledger golden in the spec.
 *
 * Additive only; the executor wiring that WRITES this ledger ships behind its own reviewed slice.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_automation_action_applied (
      kind               text NOT NULL
                           CONSTRAINT automation_action_applied_kind_valid CHECK (kind IN ('execution','test_run')),
      root_execution_id  text NOT NULL
                           CONSTRAINT automation_action_applied_root_nonblank CHECK (root_execution_id ~ '[!-~]'),
      action_key         text NOT NULL
                           CONSTRAINT automation_action_applied_action_key_nonblank CHECK (action_key ~ '[!-~]'),
      action_type        text,
      applied_at         timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_action_applied_claim
    ON meta_automation_action_applied (kind, root_execution_id, action_key)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_automation_action_applied`.execute(db)
}
