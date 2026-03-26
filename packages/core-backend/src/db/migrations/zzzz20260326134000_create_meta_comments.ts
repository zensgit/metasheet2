import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_comments (
      id text PRIMARY KEY,
      spreadsheet_id text NOT NULL,
      row_id text NOT NULL,
      field_id text,
      content text NOT NULL,
      author_id text NOT NULL,
      parent_id text,
      resolved boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      mentions jsonb NOT NULL DEFAULT '[]'::jsonb
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_comments_spreadsheet
    ON meta_comments(spreadsheet_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_comments_row
    ON meta_comments(row_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_comments_created
    ON meta_comments(created_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_comments_created`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_comments_row`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_comments_spreadsheet`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_comments`.execute(db)
}
