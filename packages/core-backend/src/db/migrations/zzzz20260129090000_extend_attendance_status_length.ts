import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE attendance_records
    ALTER COLUMN status TYPE varchar(64)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE attendance_records
    ALTER COLUMN status TYPE varchar(20)
  `.execute(db)
}
