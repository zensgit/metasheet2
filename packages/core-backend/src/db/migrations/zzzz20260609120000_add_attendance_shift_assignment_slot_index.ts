import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import {
  addColumnIfNotExists,
  checkTableExists,
  dropColumnIfExists,
} from './_patterns'

const TABLE_NAME = 'attendance_shift_assignments'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, TABLE_NAME)
  if (!exists) return

  await addColumnIfNotExists(db, TABLE_NAME, 'slot_index', 'smallint', {
    notNull: true,
    defaultTo: 0,
  })

  await sql`ALTER TABLE attendance_shift_assignments DROP CONSTRAINT IF EXISTS chk_attendance_shift_assignments_slot_index`.execute(db)
  await sql`
    ALTER TABLE attendance_shift_assignments
    ADD CONSTRAINT chk_attendance_shift_assignments_slot_index
    CHECK (slot_index BETWEEN 0 AND 2) NOT VALID
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, TABLE_NAME)
  if (!exists) return

  await sql`ALTER TABLE attendance_shift_assignments DROP CONSTRAINT IF EXISTS chk_attendance_shift_assignments_slot_index`.execute(db)
  await dropColumnIfExists(db, TABLE_NAME, 'slot_index')
}
