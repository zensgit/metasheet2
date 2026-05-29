import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import {
  addColumnIfNotExists,
  checkTableExists,
  createIndexIfNotExists,
  dropColumnIfExists,
  dropIndexIfExists,
} from './_patterns'

const TABLE_NAME = 'attendance_shift_assignments'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, TABLE_NAME)
  if (!exists) return

  await addColumnIfNotExists(db, TABLE_NAME, 'producer_type', 'text')
  await addColumnIfNotExists(db, TABLE_NAME, 'producer_ref_id', 'uuid')
  await addColumnIfNotExists(db, TABLE_NAME, 'producer_key', 'text')
  await addColumnIfNotExists(db, TABLE_NAME, 'producer_run_id', 'uuid')

  await sql`ALTER TABLE attendance_shift_assignments DROP CONSTRAINT IF EXISTS chk_attendance_shift_assignments_producer_metadata`.execute(db)
  await sql`
    ALTER TABLE attendance_shift_assignments
    ADD CONSTRAINT chk_attendance_shift_assignments_producer_metadata
    CHECK (
      (
        producer_type IS NULL
        AND producer_ref_id IS NULL
        AND producer_key IS NULL
        AND producer_run_id IS NULL
      )
      OR
      (
        producer_type IS NOT NULL
        AND producer_ref_id IS NOT NULL
        AND producer_key IS NOT NULL
        AND producer_run_id IS NOT NULL
      )
    )
  `.execute(db)

  await createIndexIfNotExists(
    db,
    'idx_attendance_shift_assignments_producer_key',
    TABLE_NAME,
    ['org_id', 'producer_type', 'producer_key'],
  )
  await createIndexIfNotExists(
    db,
    'idx_attendance_shift_assignments_producer_ref',
    TABLE_NAME,
    ['org_id', 'producer_type', 'producer_ref_id'],
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, TABLE_NAME)
  if (!exists) return

  await sql`ALTER TABLE attendance_shift_assignments DROP CONSTRAINT IF EXISTS chk_attendance_shift_assignments_producer_metadata`.execute(db)
  await dropIndexIfExists(db, 'idx_attendance_shift_assignments_producer_ref')
  await dropIndexIfExists(db, 'idx_attendance_shift_assignments_producer_key')
  await dropColumnIfExists(db, TABLE_NAME, 'producer_run_id')
  await dropColumnIfExists(db, TABLE_NAME, 'producer_key')
  await dropColumnIfExists(db, TABLE_NAME, 'producer_ref_id')
  await dropColumnIfExists(db, TABLE_NAME, 'producer_type')
}
