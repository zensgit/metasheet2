import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { addColumnIfNotExists, checkTableExists, dropColumnIfExists } from './_patterns'

const TABLE_NAME = 'attendance_groups'
const DEFAULT_ATTENDANCE_GROUP_TYPE = 'fixed_shift'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, TABLE_NAME)
  if (!exists) return

  await addColumnIfNotExists(db, TABLE_NAME, 'attendance_type', 'text', {
    notNull: true,
    defaultTo: DEFAULT_ATTENDANCE_GROUP_TYPE,
  })

  await sql`
    UPDATE attendance_groups
    SET attendance_type = ${DEFAULT_ATTENDANCE_GROUP_TYPE}
    WHERE attendance_type IS NULL
       OR attendance_type NOT IN ('fixed_shift', 'scheduled_shift', 'free_time')
  `.execute(db)

  await sql`ALTER TABLE attendance_groups DROP CONSTRAINT IF EXISTS attendance_groups_attendance_type_check`.execute(db)
  await sql`
    ALTER TABLE attendance_groups
    ADD CONSTRAINT attendance_groups_attendance_type_check
    CHECK (attendance_type IN ('fixed_shift', 'scheduled_shift', 'free_time'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, TABLE_NAME)
  if (!exists) return

  await sql`ALTER TABLE attendance_groups DROP CONSTRAINT IF EXISTS attendance_groups_attendance_type_check`.execute(db)
  await dropColumnIfExists(db, TABLE_NAME, 'attendance_type')
}
