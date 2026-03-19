import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS multitable_attachments (
      id text PRIMARY KEY,
      sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
      record_id text REFERENCES meta_records(id) ON DELETE SET NULL,
      field_id text REFERENCES meta_fields(id) ON DELETE SET NULL,
      storage_file_id text NOT NULL,
      filename text NOT NULL,
      original_name text,
      mime_type text NOT NULL,
      size bigint NOT NULL DEFAULT 0,
      storage_path text NOT NULL,
      storage_provider text NOT NULL DEFAULT 'local',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multitable_attachments_storage_file
    ON multitable_attachments(storage_file_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_attachments_sheet
    ON multitable_attachments(sheet_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_attachments_record
    ON multitable_attachments(record_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_attachments_field
    ON multitable_attachments(field_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_attachments_created
    ON multitable_attachments(created_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_multitable_attachments_created`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_multitable_attachments_field`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_multitable_attachments_record`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_multitable_attachments_sheet`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_multitable_attachments_storage_file`.execute(db)
  await sql`DROP TABLE IF EXISTS multitable_attachments`.execute(db)
}
