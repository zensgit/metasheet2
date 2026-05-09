import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_record_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      record_id text NOT NULL,
      version integer NOT NULL,
      action text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
      source text NOT NULL DEFAULT 'rest',
      actor_id text,
      changed_field_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
      patch jsonb NOT NULL DEFAULT '{}'::jsonb,
      snapshot jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_sheet_record_version
    ON meta_record_revisions(sheet_id, record_id, version DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_record_created_at
    ON meta_record_revisions(record_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_actor_created_at
    ON meta_record_revisions(actor_id, created_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_record_revisions_actor_created_at`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_record_revisions_record_created_at`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_record_revisions_sheet_record_version`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_record_revisions`.execute(db)
}
