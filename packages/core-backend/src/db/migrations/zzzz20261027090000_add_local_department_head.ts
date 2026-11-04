import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/** Local head authority is independent of the existing direct-manager flag; no provider backfill. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE directory_account_departments
    ADD COLUMN IF NOT EXISTS is_department_head boolean NOT NULL DEFAULT false
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_directory_account_departments_head_by_dept
    ON directory_account_departments (directory_department_id)
    WHERE is_department_head
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_directory_account_departments_head_by_dept`.execute(db)
  await sql`
    ALTER TABLE directory_account_departments
    DROP COLUMN IF EXISTS is_department_head
  `.execute(db)
}
