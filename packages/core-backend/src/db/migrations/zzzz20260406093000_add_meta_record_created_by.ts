import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE meta_records
    ADD COLUMN IF NOT EXISTS created_by text
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_records_created_by
    ON meta_records(sheet_id, created_by)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_records_created_by`.execute(db)
  await sql`
    ALTER TABLE meta_records
    DROP COLUMN IF EXISTS created_by
  `.execute(db)
}
