/**
 * Create record_permissions table for per-record (row-level) scoped access control.
 *
 * Allows granting different access levels (read/write/admin) per user or role
 * on individual records, layered on top of sheet-level capabilities.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS record_permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      record_id text NOT NULL,
      subject_type text NOT NULL CHECK (subject_type IN ('user', 'role')),
      subject_id text NOT NULL,
      access_level text NOT NULL CHECK (access_level IN ('read', 'write', 'admin')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT record_permissions_unique UNIQUE(record_id, subject_type, subject_id)
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_record_permissions_sheet_record ON record_permissions(sheet_id, record_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_record_permissions_subject ON record_permissions(subject_type, subject_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS record_permissions CASCADE`.execute(db)
}
