import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS spreadsheet_permissions (
      sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      perm_code text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (sheet_id, user_id, perm_code)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_spreadsheet_permissions_user
    ON spreadsheet_permissions(user_id, sheet_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_spreadsheet_permissions_sheet
    ON spreadsheet_permissions(sheet_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_spreadsheet_permissions_sheet`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_spreadsheet_permissions_user`.execute(db)
  await sql`DROP TABLE IF EXISTS spreadsheet_permissions`.execute(db)
}
