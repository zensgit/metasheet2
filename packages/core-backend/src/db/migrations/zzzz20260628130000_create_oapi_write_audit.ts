/**
 * Migration: `oapi_write_audit` — the OAPI-2a token-write audit ledger.
 *
 * Design-lock `docs/development/multitable-oapi2-write-designlock-20260628.md` §6 / §10.7 (RATIFIED).
 * Every token-authenticated write attempt is audited with its final outcome:
 *   - `committed` rows are inserted **inside the mutation transaction** (RecordService / RecordWriteService /
 *     CommentService), so an audit-insert failure rolls the write back (fail-closed). They carry the real
 *     written result (`record_ids` / `batch_count`).
 *   - `denied` / `error` / `rate_limited` rows are written best-effort at the route boundary (no mutation txn
 *     to join) with mandatory alerting on write failure.
 *
 * Purpose-built + UNPARTITIONED on purpose: the general `audit_logs` table is range-partitioned by month, so a
 * missing partition would make the same-txn committed INSERT fail and roll back EVERY token write — an
 * unacceptable coupling for a fail-closed path. It also types `user_id` as INTEGER, while our actor ids are
 * strings. Value-scrub (F1) is applied to `detail` by the caller before persisting. Pure DDL; idempotent.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS oapi_write_audit (
      id bigserial PRIMARY KEY,
      token_id text NOT NULL,
      actor_id text NOT NULL,
      operation text NOT NULL CHECK (operation IN ('create', 'update', 'upsert', 'delete')),
      scope text NOT NULL,
      sheet_id text,
      record_ids text[],
      batch_count integer,
      outcome text NOT NULL CHECK (outcome IN ('committed', 'denied', 'error', 'rate_limited')),
      status_code integer,
      request_id text,
      detail jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_oapi_write_audit_token ON oapi_write_audit (token_id, created_at DESC)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_oapi_write_audit_actor ON oapi_write_audit (actor_id, created_at DESC)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_oapi_write_audit_outcome ON oapi_write_audit (outcome, created_at DESC)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS oapi_write_audit`.execute(db)
}
