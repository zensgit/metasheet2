import { sql, type Kysely } from 'kysely'

/**
 * W0-1 v3.7 Lane L8 — the ANTI-REPLAY burn ledger for exact-anchor recovery tokens.
 *
 * Design authority: v3.7 lock §5 (in-fence execute) + the L6-b gate's pinned L8 deferral #3 (2026-07-16):
 * a valid exact-anchor preview identity is stateless (HS256 JWT, 10m TTL) and could otherwise be EXECUTED
 * MORE THAN ONCE within its TTL. The destructive apply burns the token's sha256 INSIDE its own single
 * transaction (INSERT into this table); a second execute of the same token hits the primary key and the
 * whole apply rolls back — at-most-once per minted preview, enforced by the database, not by app memory.
 *
 * Shape notes:
 *   - `token_sha256` (PK): hex sha256 of the FULL signed token. The raw token is never stored (it is a
 *     bearer credential); the hash is enough for the uniqueness barrier and useless to an attacker.
 *   - `sheet_id` + `burned_at` + `actor_id`: audit surface only — values-free (no anchor/scope contents).
 *   - No FK to sheets (a burn row must survive sheet deletion for audit).
 *   - Rows are tiny and bounded by real executes; a retention sweep can prune rows older than the token
 *     TTL window later (any row older than the max TTL can never match a verifiable token again).
 *
 * DEFAULT-OFF: nothing inserts here until the L8 apply is wired and its flags are enabled — the table is
 * inert schema. zzzz-timestamped ([[feedback_migration_zzzz_ordering]]); proven on a fresh-DB full migrate.
 *
 * Timestamp note (port from #4446): original stamp zzzz20260717120000 collided with
 * zzzz20260717120000_approval_bridge_lease on current main — renumbered to 20260719120000.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_recovery_token_burns (
      token_sha256 text PRIMARY KEY,
      sheet_id     text NOT NULL,
      actor_id     text,
      burned_at    timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  // Sheet-scoped audit listing (sheet_id leading).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_recovery_token_burns_sheet
    ON meta_recovery_token_burns(sheet_id, burned_at)
  `.execute(db)
  // G1 prune path: `DELETE … WHERE burned_at < …` — burned_at MUST lead the usable index.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_recovery_token_burns_burned_at
    ON meta_recovery_token_burns(burned_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_recovery_token_burns_burned_at`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_recovery_token_burns_sheet`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_recovery_token_burns`.execute(db)
}
