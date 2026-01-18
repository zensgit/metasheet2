import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { addColumnIfNotExists, checkTableExists, createIndexIfNotExists, dropColumnIfExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const shiftsExists = await checkTableExists(db, 'attendance_shifts')
  if (!shiftsExists) {
    await db.schema
      .createTable('attendance_shifts')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('timezone', 'varchar(64)', col => col.notNull().defaultTo('UTC'))
      .addColumn('work_start_time', 'time', col => col.notNull().defaultTo('09:00'))
      .addColumn('work_end_time', 'time', col => col.notNull().defaultTo('18:00'))
      .addColumn('late_grace_minutes', 'integer', col => col.notNull().defaultTo(10))
      .addColumn('early_grace_minutes', 'integer', col => col.notNull().defaultTo(10))
      .addColumn('rounding_minutes', 'integer', col => col.notNull().defaultTo(5))
      .addColumn('working_days', 'jsonb', col => col.notNull().defaultTo(sql`'[1,2,3,4,5]'::jsonb`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_shifts_org', 'attendance_shifts', 'org_id')

  const assignmentsExists = await checkTableExists(db, 'attendance_shift_assignments')
  if (!assignmentsExists) {
    await db.schema
      .createTable('attendance_shift_assignments')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('shift_id', 'uuid', col =>
        col.notNull().references('attendance_shifts.id').onDelete('cascade')
      )
      .addColumn('start_date', 'date', col => col.notNull())
      .addColumn('end_date', 'date')
      .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_shift_assignments_org', 'attendance_shift_assignments', 'org_id')
  await createIndexIfNotExists(db, 'idx_attendance_shift_assignments_user_org', 'attendance_shift_assignments', ['user_id', 'org_id'])

  const holidaysExists = await checkTableExists(db, 'attendance_holidays')
  if (!holidaysExists) {
    await db.schema
      .createTable('attendance_holidays')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('holiday_date', 'date', col => col.notNull())
      .addColumn('name', 'text')
      .addColumn('is_working_day', 'boolean', col => col.notNull().defaultTo(false))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_holidays_org', 'attendance_holidays', 'org_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_holidays_org_date
    ON attendance_holidays(org_id, holiday_date)
  `.execute(db)

  const recordsExists = await checkTableExists(db, 'attendance_records')
  if (recordsExists) {
    await addColumnIfNotExists(db, 'attendance_records', 'is_workday', 'boolean', {
      notNull: true,
      defaultTo: true,
    })

    await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_status_check`.execute(db)
    await sql`
      ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_status_check
      CHECK (status IN ('normal', 'late', 'early_leave', 'late_early', 'partial', 'absent', 'adjusted', 'off'))
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const recordsExists = await checkTableExists(db, 'attendance_records')
  if (recordsExists) {
    await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_status_check`.execute(db)
    await sql`
      ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_status_check
      CHECK (status IN ('normal', 'late', 'early_leave', 'late_early', 'partial', 'absent', 'adjusted'))
    `.execute(db)
    await dropColumnIfExists(db, 'attendance_records', 'is_workday')
  }

  await db.schema.dropTable('attendance_holidays').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_shift_assignments').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_shifts').ifExists().cascade().execute()
}
