import { sql, type Kysely } from 'kysely'

/**
 * W0-1 Lane L4 — durable per-sheet writer-blocking state.
 *
 * Design authority: `docs/development/multitable-w0-1-v36-unified-revision-design-lock-20260715.md` §4
 * (all-writer canonical fence), aligned forward to the v3.7 lock §2 (L4 canonical sheet-state fence). This
 * migration changes SCHEMA ONLY — it adds a nullable column and a CHECK constraint. No runtime behaviour
 * changes: the column is written/read ONLY when `MULTITABLE_ENABLE_WRITER_FENCE` is on (default OFF), and a
 * recovery only ever sets it while ALSO behind its own default-off recovery flag
 * (`MULTITABLE_ENABLE_SHEET_REVERT` / `MULTITABLE_ENABLE_PIT_RESET`).
 *
 * WHY DURABLE (not just the advisory fence): `pg_advisory_xact_lock` releases at COMMIT/ROLLBACK. A recovery
 * that mutates across MORE THAN ONE transaction (e.g. revert-execute's per-record patch loop) does not hold
 * the advisory fence continuously between those transactions, so a concurrent writer could slip in. The
 * recovery therefore commits a DURABLE block (`recovery_writer_state='applying'`) under the fence in a claim
 * transaction and releases the advisory fence; every writer that later acquires the fence observes the
 * committed state and refuses/parks until the recovery clears it. See `canonical-sheet-fence.ts`.
 *
 * States (CHECK-enforced): NULL (no block) | 'fencing' | 'applying' | 'paused_retryable'. The set is closed
 * so a typo/foreign value can never masquerade as a valid block, and — critically — so 'paused_retryable' is
 * a KNOWN, recoverable state (a re-run/operator clear resolves it), never a silently-invented stuck value
 * ([[feedback_state_machine_no_stuck_absorbing_state]]).
 *
 * zzzz-ordering ([[feedback_migration_zzzz_ordering]]): `meta_sheets` is created in
 * `zzz20251231_create_meta_schema.ts` (three z's — sorts BEFORE any four-z `zzzz` migration), so this ALTER
 * always runs after the table exists. Timestamped 170000 to sort AFTER L3's 160000 chain-seq migration and
 * leave room BELOW L5. Proven on a FRESH-DB full migrate (up/down/replay).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS recovery_writer_state text`.execute(db)
  // Closed value set (NULL allowed). IF NOT EXISTS on the constraint keeps the migration idempotent on replay.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_meta_sheets_recovery_writer_state'
      ) THEN
        ALTER TABLE meta_sheets
          ADD CONSTRAINT chk_meta_sheets_recovery_writer_state
          CHECK (recovery_writer_state IS NULL
                 OR recovery_writer_state IN ('fencing', 'applying', 'paused_retryable'));
      END IF;
    END $$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_sheets DROP CONSTRAINT IF EXISTS chk_meta_sheets_recovery_writer_state`.execute(db)
  await sql`ALTER TABLE meta_sheets DROP COLUMN IF EXISTS recovery_writer_state`.execute(db)
}
