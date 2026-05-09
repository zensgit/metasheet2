import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_records ADD COLUMN IF NOT EXISTS modified_by text`.execute(db)
  await sql`
    UPDATE meta_records
    SET modified_by = created_by
    WHERE modified_by IS NULL AND created_by IS NOT NULL
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_records_modified_by
    ON meta_records(modified_by)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_meta_records_modified_by`.execute(db)
  await sql`ALTER TABLE meta_records DROP COLUMN IF EXISTS modified_by`.execute(db)
}
