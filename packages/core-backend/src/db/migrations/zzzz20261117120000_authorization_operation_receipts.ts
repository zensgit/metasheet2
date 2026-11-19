import { sql, type Kysely } from 'kysely'

/** Durable idempotency and mandatory TEXT-actor evidence; no retention-based key reuse. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    CREATE TABLE authorization_operation_receipts (
      actor_id text NOT NULL,
      client_operation_id uuid NOT NULL,
      request_digest text NOT NULL,
      expected_version text NOT NULL,
      target_user_id text NOT NULL,
      action jsonb NOT NULL,
      receipt jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (actor_id, client_operation_id)
    );
    CREATE TABLE authorization_operation_audit (
      actor_id text NOT NULL,
      client_operation_id uuid NOT NULL,
      reason text,
      reason_origin text NOT NULL CHECK (reason_origin IN ('provided', 'not_required', 'legacy_unprovided')),
      impact jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (actor_id, client_operation_id),
      FOREIGN KEY (actor_id, client_operation_id)
        REFERENCES authorization_operation_receipts (actor_id, client_operation_id)
    );
  `).execute(db)
}

/** Existing evidence makes rollback destructive; stop before dropping either table. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    DO $guard$
    BEGIN
      IF EXISTS (SELECT 1 FROM authorization_operation_receipts)
         OR EXISTS (SELECT 1 FROM authorization_operation_audit) THEN
        RAISE EXCEPTION 'AUTHORIZATION_OPERATION_EVIDENCE_PRESENT' USING ERRCODE = '55000';
      END IF;
    END
    $guard$;
    DROP TABLE authorization_operation_audit;
    DROP TABLE authorization_operation_receipts;
  `).execute(db)
}
