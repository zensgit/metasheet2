import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE dingtalk_group_destinations
    ADD COLUMN IF NOT EXISTS sheet_id text
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_dingtalk_group_destinations_sheet_id
    ON dingtalk_group_destinations(sheet_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_dingtalk_group_destinations_sheet_id
  `.execute(db)

  await sql`
    ALTER TABLE dingtalk_group_destinations
    DROP COLUMN IF EXISTS sheet_id
  `.execute(db)
}
