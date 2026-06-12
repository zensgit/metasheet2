import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'
const TABLE = 'attendance_schedule_dispatch_requests'

const REQUEST_TYPES = [
  'missed_check_in',
  'missed_check_out',
  'time_correction',
  'leave',
  'overtime',
  'outdoor_punch',
  'shift_swap',
  'schedule_dispatch',
]

const PRIOR_REQUEST_TYPES = [
  'missed_check_in',
  'missed_check_out',
  'time_correction',
  'leave',
  'overtime',
  'outdoor_punch',
  'shift_swap',
]

async function setRequestTypeCheck(db: Kysely<unknown>, types: string[]): Promise<void> {
  const list = types.map(type => `'${type}'`).join(', ')
  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT IF EXISTS attendance_requests_type_check`.execute(db)
  await sql`
    ALTER TABLE attendance_requests ADD CONSTRAINT attendance_requests_type_check
    CHECK (request_type IN (${sql.raw(list)}))
  `.execute(db)
}

// Dispatch/multisite D1 (design-lock attendance-dispatch-multisite-design-lock-20260612).
// Latent schema only: the generic requests API still rejects schedule_dispatch, and no
// dedicated create route or final-approval schedule writer is wired in this slice.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const requestsExists = await checkTableExists(db, 'attendance_requests')
  const scheduleGroupsExists = await checkTableExists(db, 'attendance_schedule_groups')
  const scheduleGroupMembersExists = await checkTableExists(db, 'attendance_schedule_group_members')
  const attendanceGroupsExists = await checkTableExists(db, 'attendance_groups')
  const shiftsExists = await checkTableExists(db, 'attendance_shifts')
  if (!requestsExists || !scheduleGroupsExists || !scheduleGroupMembersExists || !attendanceGroupsExists || !shiftsExists) return

  await setRequestTypeCheck(db, REQUEST_TYPES)

  const exists = await checkTableExists(db, TABLE)
  if (!exists) {
    await db.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn('request_id', 'uuid', col => col.primaryKey().references('attendance_requests.id').onDelete('cascade'))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('dispatch_type', 'text', col => col.notNull().defaultTo('daily'))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('target_schedule_group_id', 'uuid', col => col.notNull().references('attendance_schedule_groups.id'))
      .addColumn('target_attendance_group_id', 'uuid', col => col.references('attendance_groups.id'))
      .addColumn('target_department_ref', 'text')
      .addColumn('target_shift_id', 'uuid', col => col.notNull().references('attendance_shifts.id'))
      .addColumn('slot_index', 'smallint', col => col.notNull().defaultTo(0))
      .addColumn('start_date', 'date', col => col.notNull())
      .addColumn('end_date', 'date', col => col.notNull())
      .addColumn('publish_status', 'text', col => col.notNull().defaultTo('pending'))
      .addColumn('source_key', 'text', col => col.notNull())
      .addColumn('assignment_ids', sql`uuid[]`, col => col.notNull().defaultTo(sql`'{}'::uuid[]`))
      .addColumn('membership_id', 'uuid', col => col.references('attendance_schedule_group_members.id'))
      .addColumn('finalized_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addCheckConstraint('chk_attendance_schedule_dispatch_type', sql`dispatch_type IN ('daily')`)
      .addCheckConstraint('chk_attendance_schedule_dispatch_slot_index', sql`slot_index BETWEEN 0 AND 2`)
      .addCheckConstraint('chk_attendance_schedule_dispatch_publish_status', sql`publish_status IN ('pending', 'published', 'cancelled')`)
      .addCheckConstraint('chk_attendance_schedule_dispatch_date_window', sql`start_date <= end_date`)
      .execute()
  }

  await createIndexIfNotExists(db, 'uq_attendance_schedule_dispatch_requests_source_key', TABLE, ['org_id', 'source_key'], { unique: true })
  await createIndexIfNotExists(db, 'idx_attendance_schedule_dispatch_requests_user_window', TABLE, ['org_id', 'user_id', 'start_date', 'end_date'])
  await createIndexIfNotExists(db, 'idx_attendance_schedule_dispatch_requests_target_group_window', TABLE, ['org_id', 'target_schedule_group_id', 'start_date', 'end_date'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).ifExists().execute()
  if (await checkTableExists(db, 'attendance_requests')) {
    await setRequestTypeCheck(db, PRIOR_REQUEST_TYPES)
  }
}
