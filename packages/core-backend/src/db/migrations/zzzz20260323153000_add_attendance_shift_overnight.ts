import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { addColumnIfNotExists, dropColumnIfExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await addColumnIfNotExists(db, 'attendance_shifts', 'is_overnight', 'boolean', {
    notNull: true,
    defaultTo: false,
  })

  await sql`
    UPDATE attendance_shifts
       SET is_overnight = true
     WHERE work_start_time > work_end_time
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await dropColumnIfExists(db, 'attendance_shifts', 'is_overnight')
}
