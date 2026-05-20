import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'attendance_holidays')
  if (!exists) return

  await sql`
    ALTER TABLE attendance_holidays
    ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual'
  `.execute(db)

  await sql`
    ALTER TABLE attendance_holidays
    DROP CONSTRAINT IF EXISTS attendance_holidays_origin_check
  `.execute(db)

  await sql`
    ALTER TABLE attendance_holidays
    ADD CONSTRAINT attendance_holidays_origin_check
    CHECK (origin IN ('national', 'manual'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'attendance_holidays')
  if (!exists) return

  await sql`
    ALTER TABLE attendance_holidays
    DROP CONSTRAINT IF EXISTS attendance_holidays_origin_check
  `.execute(db)

  await sql`
    ALTER TABLE attendance_holidays
    DROP COLUMN IF EXISTS origin
  `.execute(db)
}
