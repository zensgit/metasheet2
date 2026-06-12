import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'
const TABLE = 'attendance_shift_swap_requests'

const REQUEST_TYPES = [
  'missed_check_in',
  'missed_check_out',
  'time_correction',
  'leave',
  'overtime',
  'outdoor_punch',
  'shift_swap',
]

const PRIOR_REQUEST_TYPES = [
  'missed_check_in',
  'missed_check_out',
  'time_correction',
  'leave',
  'overtime',
  'outdoor_punch',
]

async function setRequestTypeCheck(db: Kysely<unknown>, types: string[]): Promise<void> {
  const list = types.map(type => `'${type}'`).join(', ')
  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT IF EXISTS attendance_requests_type_check`.execute(db)
  await sql`
    ALTER TABLE attendance_requests ADD CONSTRAINT attendance_requests_type_check
    CHECK (request_type IN (${sql.raw(list)}))
  `.execute(db)
}

// Shift-swap SW1 (design-lock attendance-shift-swap-design-lock-20260612).
// Latent schema only: the generic requests API still rejects shift_swap, and no
// final-approval schedule writer is wired in this slice.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const requestsExists = await checkTableExists(db, 'attendance_requests')
  const assignmentsExists = await checkTableExists(db, 'attendance_shift_assignments')
  if (!requestsExists || !assignmentsExists) return

  await setRequestTypeCheck(db, REQUEST_TYPES)

  const exists = await checkTableExists(db, TABLE)
  if (!exists) {
    await db.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn('request_id', 'uuid', col => col.primaryKey().references('attendance_requests.id').onDelete('cascade'))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('requester_user_id', 'text', col => col.notNull())
      .addColumn('counterparty_user_id', 'text', col => col.notNull())
      .addColumn('counterparty_status', 'text', col => col.notNull().defaultTo('pending'))
      .addColumn('requester_assignment_id', 'uuid', col => col.notNull().references('attendance_shift_assignments.id'))
      .addColumn('counterparty_assignment_id', 'uuid', col => col.notNull().references('attendance_shift_assignments.id'))
      .addColumn('requester_replacement_assignment_id', 'uuid', col => col.references('attendance_shift_assignments.id'))
      .addColumn('counterparty_replacement_assignment_id', 'uuid', col => col.references('attendance_shift_assignments.id'))
      .addColumn('requester_work_date', 'date', col => col.notNull())
      .addColumn('counterparty_work_date', 'date', col => col.notNull())
      .addColumn('requester_shift_id', 'uuid', col => col.notNull())
      .addColumn('counterparty_shift_id', 'uuid', col => col.notNull())
      .addColumn('requester_slot_index', 'smallint', col => col.notNull().defaultTo(0))
      .addColumn('counterparty_slot_index', 'smallint', col => col.notNull().defaultTo(0))
      .addColumn('requester_start_date', 'date', col => col.notNull())
      .addColumn('requester_end_date', 'date', col => col.notNull())
      .addColumn('counterparty_start_date', 'date', col => col.notNull())
      .addColumn('counterparty_end_date', 'date', col => col.notNull())
      .addColumn('requester_publish_status', 'text', col => col.notNull())
      .addColumn('counterparty_publish_status', 'text', col => col.notNull())
      .addColumn('requester_producer_type', 'text')
      .addColumn('counterparty_producer_type', 'text')
      .addColumn('requester_assignment_kind', 'text', col => col.notNull())
      .addColumn('counterparty_assignment_kind', 'text', col => col.notNull())
      .addColumn('source_key', 'text', col => col.notNull())
      .addColumn('counterparty_responded_at', 'timestamptz')
      .addColumn('finalized_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addCheckConstraint('chk_attendance_shift_swap_counterparty_status', sql`counterparty_status IN ('pending', 'accepted', 'rejected')`)
      .addCheckConstraint('chk_attendance_shift_swap_two_users', sql`requester_user_id <> counterparty_user_id`)
      .addCheckConstraint('chk_attendance_shift_swap_two_assignments', sql`requester_assignment_id <> counterparty_assignment_id`)
      .addCheckConstraint('chk_attendance_shift_swap_slot_index', sql`requester_slot_index BETWEEN 0 AND 2 AND counterparty_slot_index BETWEEN 0 AND 2`)
      .addCheckConstraint(
        'chk_attendance_shift_swap_single_day',
        sql`requester_start_date = requester_end_date AND requester_work_date = requester_start_date AND counterparty_start_date = counterparty_end_date AND counterparty_work_date = counterparty_start_date`,
      )
      .addCheckConstraint('chk_attendance_shift_swap_published', sql`requester_publish_status = 'published' AND counterparty_publish_status = 'published'`)
      .addCheckConstraint('chk_attendance_shift_swap_regular', sql`requester_assignment_kind = 'regular' AND counterparty_assignment_kind = 'regular'`)
      .addCheckConstraint('chk_attendance_shift_swap_manual', sql`requester_producer_type IS NULL AND counterparty_producer_type IS NULL`)
      .execute()
  }

  await createIndexIfNotExists(db, 'uq_attendance_shift_swap_requests_source_key', TABLE, ['org_id', 'source_key'], { unique: true })
  await createIndexIfNotExists(db, 'idx_attendance_shift_swap_requests_requester', TABLE, ['org_id', 'requester_user_id'])
  await createIndexIfNotExists(db, 'idx_attendance_shift_swap_requests_counterparty', TABLE, ['org_id', 'counterparty_user_id', 'counterparty_status'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).ifExists().execute()
  if (await checkTableExists(db, 'attendance_requests')) {
    await setRequestTypeCheck(db, PRIOR_REQUEST_TYPES)
  }
}
