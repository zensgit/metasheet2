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
const CONSTRAINT_NAME = 'chk_attendance_shift_assignments_temporary_metadata'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, TABLE_NAME)
  if (!exists) return

  await addColumnIfNotExists(db, TABLE_NAME, 'assignment_kind', 'text', {
    notNull: true,
    defaultTo: 'regular',
  })
  await addColumnIfNotExists(db, TABLE_NAME, 'temporary_mode', 'text')
  await addColumnIfNotExists(db, TABLE_NAME, 'temporary_replaces_kind', 'text')
  await addColumnIfNotExists(db, TABLE_NAME, 'temporary_replaces_assignment_id', 'uuid')
  await addColumnIfNotExists(db, TABLE_NAME, 'temporary_reason', 'text')
  await addColumnIfNotExists(db, TABLE_NAME, 'temporary_created_by', 'text')
  await addColumnIfNotExists(db, TABLE_NAME, 'temporary_created_at', 'timestamptz')

  await sql.raw(`ALTER TABLE ${TABLE_NAME} DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME}`).execute(db)
  await sql.raw(`
    ALTER TABLE ${TABLE_NAME}
    ADD CONSTRAINT ${CONSTRAINT_NAME}
    CHECK (
      (
        assignment_kind = 'regular'
        AND temporary_mode IS NULL
        AND temporary_replaces_kind IS NULL
        AND temporary_replaces_assignment_id IS NULL
        AND temporary_reason IS NULL
        AND temporary_created_by IS NULL
        AND temporary_created_at IS NULL
      )
      OR
      (
        assignment_kind = 'temporary'
        AND end_date IS NOT NULL
        AND start_date = end_date
        AND temporary_mode IS NOT NULL
        AND temporary_mode = 'replace'
        AND temporary_replaces_kind IS NOT NULL
        AND temporary_replaces_kind IN ('shift', 'rule')
        AND temporary_created_by IS NOT NULL
        AND temporary_created_at IS NOT NULL
        AND (
          (temporary_replaces_kind = 'shift' AND temporary_replaces_assignment_id IS NOT NULL)
          OR
          (temporary_replaces_kind = 'rule' AND temporary_replaces_assignment_id IS NULL)
        )
      )
    ) NOT VALID
  `).execute(db)

  await createIndexIfNotExists(
    db,
    'idx_attendance_shift_assignments_temporary_effective',
    TABLE_NAME,
    ['org_id', 'user_id', 'assignment_kind', 'slot_index', 'is_active', 'start_date', 'end_date'],
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, TABLE_NAME)
  if (!exists) return

  await sql.raw(`ALTER TABLE ${TABLE_NAME} DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME}`).execute(db)
  await dropIndexIfExists(db, 'idx_attendance_shift_assignments_temporary_effective')
  await dropColumnIfExists(db, TABLE_NAME, 'temporary_created_at')
  await dropColumnIfExists(db, TABLE_NAME, 'temporary_created_by')
  await dropColumnIfExists(db, TABLE_NAME, 'temporary_reason')
  await dropColumnIfExists(db, TABLE_NAME, 'temporary_replaces_assignment_id')
  await dropColumnIfExists(db, TABLE_NAME, 'temporary_replaces_kind')
  await dropColumnIfExists(db, TABLE_NAME, 'temporary_mode')
  await dropColumnIfExists(db, TABLE_NAME, 'assignment_kind')
}
