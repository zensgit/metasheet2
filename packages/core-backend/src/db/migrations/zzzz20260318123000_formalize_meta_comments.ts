import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_comments (
      id varchar(50) PRIMARY KEY,
      spreadsheet_id varchar(50) NOT NULL,
      row_id varchar(50) NOT NULL,
      field_id varchar(50),
      target_type varchar(50) NOT NULL DEFAULT 'spreadsheet_row',
      target_id varchar(50) NOT NULL DEFAULT '',
      target_field_id varchar(50),
      container_type varchar(50) NOT NULL DEFAULT 'spreadsheet',
      container_id varchar(50) NOT NULL DEFAULT '',
      content text NOT NULL,
      author_id varchar(50) NOT NULL,
      parent_id varchar(50),
      resolved boolean DEFAULT false,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now(),
      mentions jsonb
    )
  `.execute(db)

  await sql`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS spreadsheet_id varchar(50)`.execute(db)
  await sql`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS row_id varchar(50)`.execute(db)
  await sql`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS field_id varchar(50)`.execute(db)
  await sql`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS target_type varchar(50)`.execute(db)
  await sql`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS target_id varchar(50)`.execute(db)
  await sql`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS target_field_id varchar(50)`.execute(db)
  await sql`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS container_type varchar(50)`.execute(db)
  await sql`ALTER TABLE meta_comments ADD COLUMN IF NOT EXISTS container_id varchar(50)`.execute(db)
  await sql`ALTER TABLE meta_comments ALTER COLUMN target_type SET DEFAULT 'spreadsheet_row'`.execute(db)
  await sql`ALTER TABLE meta_comments ALTER COLUMN container_type SET DEFAULT 'spreadsheet'`.execute(db)

  await sql`
    UPDATE meta_comments
    SET
      target_type = COALESCE(NULLIF(target_type, ''), 'spreadsheet_row'),
      target_id = COALESCE(NULLIF(target_id, ''), row_id),
      target_field_id = COALESCE(target_field_id, field_id),
      container_type = COALESCE(NULLIF(container_type, ''), 'spreadsheet'),
      container_id = COALESCE(NULLIF(container_id, ''), spreadsheet_id)
  `.execute(db)

  await sql`
    ALTER TABLE meta_comments
    ALTER COLUMN target_type SET NOT NULL
  `.execute(db)
  await sql`
    ALTER TABLE meta_comments
    ALTER COLUMN target_id SET NOT NULL
  `.execute(db)
  await sql`
    ALTER TABLE meta_comments
    ALTER COLUMN container_type SET NOT NULL
  `.execute(db)
  await sql`
    ALTER TABLE meta_comments
    ALTER COLUMN container_id SET NOT NULL
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_comments_sheet ON meta_comments(spreadsheet_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_comments_row ON meta_comments(row_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_comments_container ON meta_comments(container_type, container_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_comments_target ON meta_comments(target_type, target_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_comments_target_field ON meta_comments(target_field_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_comments_target_field`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_comments_target`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_comments_container`.execute(db)
}
