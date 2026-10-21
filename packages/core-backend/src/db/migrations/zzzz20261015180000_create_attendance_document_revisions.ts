import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Append-only revision identity for an approved attendance document.
 * The reversal idempotency key is (document_id, revision_id, operation_id).
 * Additive. `down` refuses while rows exist, then drops the table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_document_revisions (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      document_id text NOT NULL,
      revision_id text NOT NULL,
      operation_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'withdrawn', 'expired', 'blocked')),
      fingerprint text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (document_id, revision_id, operation_id)
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.attendance_document_revisions') IS NOT NULL
         AND EXISTS (SELECT 1 FROM attendance_document_revisions) THEN
        RAISE EXCEPTION 'attendance_document_revisions is not empty';
      END IF;
    END $$
  `.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_document_revisions`.execute(db)
}
