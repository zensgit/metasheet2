import type { Kysely } from 'kysely'
import { addColumnIfNotExists, dropColumnIfExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await addColumnIfNotExists(db, 'attendance_leave_types', 'paid', 'boolean', {
    notNull: true,
    defaultTo: true,
  })
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await dropColumnIfExists(db, 'attendance_leave_types', 'paid')
}
