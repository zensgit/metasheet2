import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const rulesExists = await checkTableExists(db, 'attendance_rules')
  if (!rulesExists) {
    await db.schema
      .createTable('attendance_rules')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('timezone', 'varchar(64)', col => col.notNull().defaultTo('UTC'))
      .addColumn('work_start_time', 'time', col => col.notNull().defaultTo('09:00'))
      .addColumn('work_end_time', 'time', col => col.notNull().defaultTo('18:00'))
      .addColumn('late_grace_minutes', 'integer', col => col.notNull().defaultTo(10))
      .addColumn('early_grace_minutes', 'integer', col => col.notNull().defaultTo(10))
      .addColumn('rounding_minutes', 'integer', col => col.notNull().defaultTo(5))
      .addColumn('working_days', 'jsonb', col => col.notNull().defaultTo(sql`'[1,2,3,4,5]'::jsonb`))
      .addColumn('is_default', 'boolean', col => col.notNull().defaultTo(false))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  const eventsExists = await checkTableExists(db, 'attendance_events')
  if (!eventsExists) {
    await db.schema
      .createTable('attendance_events')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('work_date', 'date', col => col.notNull())
      .addColumn('occurred_at', 'timestamptz', col => col.notNull())
      .addColumn('event_type', 'varchar(20)', col => col.notNull())
      .addColumn('source', 'varchar(50)', col => col.notNull().defaultTo('manual'))
      .addColumn('timezone', 'varchar(64)', col => col.notNull().defaultTo('UTC'))
      .addColumn('location', 'jsonb', col => col.defaultTo(sql`'{}'::jsonb`))
      .addColumn('meta', 'jsonb', col => col.defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()

    await sql`
      ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_type_check
      CHECK (event_type IN ('check_in', 'check_out', 'adjustment'))
    `.execute(db)
  }

  const recordsExists = await checkTableExists(db, 'attendance_records')
  if (!recordsExists) {
    await db.schema
      .createTable('attendance_records')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('work_date', 'date', col => col.notNull())
      .addColumn('timezone', 'varchar(64)', col => col.notNull().defaultTo('UTC'))
      .addColumn('first_in_at', 'timestamptz')
      .addColumn('last_out_at', 'timestamptz')
      .addColumn('work_minutes', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('late_minutes', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('early_leave_minutes', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('status', 'varchar(20)', col => col.notNull().defaultTo('normal'))
      .addColumn('meta', 'jsonb', col => col.defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()

    await sql`
      ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_status_check
      CHECK (status IN ('normal', 'late', 'early_leave', 'late_early', 'partial', 'absent', 'adjusted'))
    `.execute(db)
  }

  const requestsExists = await checkTableExists(db, 'attendance_requests')
  if (!requestsExists) {
    await db.schema
      .createTable('attendance_requests')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('work_date', 'date', col => col.notNull())
      .addColumn('request_type', 'varchar(30)', col => col.notNull())
      .addColumn('requested_in_at', 'timestamptz')
      .addColumn('requested_out_at', 'timestamptz')
      .addColumn('reason', 'text')
      .addColumn('status', 'varchar(20)', col => col.notNull().defaultTo('pending'))
      .addColumn('approval_instance_id', 'text')
      .addColumn('resolved_by', 'text')
      .addColumn('resolved_at', 'timestamptz')
      .addColumn('metadata', 'jsonb', col => col.defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()

    await sql`
      ALTER TABLE attendance_requests ADD CONSTRAINT attendance_requests_type_check
      CHECK (request_type IN ('missed_check_in', 'missed_check_out', 'time_correction'))
    `.execute(db)

    await sql`
      ALTER TABLE attendance_requests ADD CONSTRAINT attendance_requests_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
    `.execute(db)
  }

  await sql`CREATE INDEX IF NOT EXISTS idx_attendance_events_user_time ON attendance_events(user_id, occurred_at DESC)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_attendance_events_work_date ON attendance_events(work_date)`.execute(db)
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_records_user_date ON attendance_records(user_id, work_date)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_attendance_records_work_date ON attendance_records(work_date)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_attendance_requests_user_date ON attendance_requests(user_id, work_date)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_attendance_requests_status ON attendance_requests(status)`.execute(db)
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_rules_default ON attendance_rules(is_default) WHERE is_default = TRUE`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_requests').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_records').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_events').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_rules').ifExists().cascade().execute()
}
