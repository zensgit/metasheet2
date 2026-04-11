/**
 * Create meta_view_permissions table for per-view scoped access control.
 *
 * This is separate from the legacy `view_permissions` table (which references `views.id`)
 * because the multitable system uses `meta_views` exclusively.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_view_permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      view_id text NOT NULL,
      subject_type text NOT NULL CHECK (subject_type IN ('user', 'role')),
      subject_id text NOT NULL,
      permission text NOT NULL CHECK (permission IN ('read', 'write', 'admin')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT meta_view_permissions_unique UNIQUE(view_id, subject_type, subject_id)
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_meta_view_permissions_view ON meta_view_permissions(view_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_view_permissions_subject ON meta_view_permissions(subject_type, subject_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_view_permissions CASCADE`.execute(db)
}
