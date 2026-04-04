import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_fields (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
      name text NOT NULL,
      type text NOT NULL,
      property jsonb DEFAULT '{}'::jsonb,
      "order" integer NOT NULL DEFAULT 0,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_records (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_links (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      field_id text NOT NULL REFERENCES meta_fields(id) ON DELETE CASCADE,
      record_id text NOT NULL REFERENCES meta_records(id) ON DELETE CASCADE,
      foreign_record_id text NOT NULL,
      created_at timestamptz DEFAULT now()
    )
  `.execute(db)

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

  await sql`CREATE INDEX IF NOT EXISTS idx_meta_fields_sheet ON meta_fields(sheet_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_fields_sheet_order ON meta_fields(sheet_id, "order")`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_records_sheet ON meta_records(sheet_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_records_created ON meta_records(sheet_id, created_at)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_links_field ON meta_links(field_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_links_record ON meta_links(record_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_links_foreign ON meta_links(foreign_record_id)`.execute(db)
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
  void db
}
