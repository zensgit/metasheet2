/**
 * Create field_permissions table for per-field scoped access control.
 *
 * Allows granting different field visibility and readOnly per user or role,
 * layered on top of the coarse MetaCapabilities + field property defaults.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS field_permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      field_id text NOT NULL,
      subject_type text NOT NULL CHECK (subject_type IN ('user', 'role')),
      subject_id text NOT NULL,
      visible boolean NOT NULL DEFAULT true,
      read_only boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT field_permissions_unique UNIQUE(sheet_id, field_id, subject_type, subject_id)
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_field_permissions_sheet ON field_permissions(sheet_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_field_permissions_subject ON field_permissions(subject_type, subject_id, sheet_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS field_permissions CASCADE`.execute(db)
}
