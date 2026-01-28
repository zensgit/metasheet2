import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const ruleSetsExists = await checkTableExists(db, 'attendance_rule_sets')
  if (!ruleSetsExists) {
    await db.schema
      .createTable('attendance_rule_sets')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('description', 'text')
      .addColumn('version', 'integer', col => col.notNull().defaultTo(1))
      .addColumn('scope', 'varchar(32)', col => col.notNull().defaultTo('org'))
      .addColumn('config', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('is_default', 'boolean', col => col.notNull().defaultTo(false))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_rule_sets_org', 'attendance_rule_sets', 'org_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_rule_sets_org_name
    ON attendance_rule_sets(org_id, name)
  `.execute(db)

  const payrollTemplatesExists = await checkTableExists(db, 'attendance_payroll_templates')
  if (!payrollTemplatesExists) {
    await db.schema
      .createTable('attendance_payroll_templates')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('timezone', 'varchar(64)', col => col.notNull().defaultTo('UTC'))
      .addColumn('start_day', 'integer', col => col.notNull().defaultTo(1))
      .addColumn('end_day', 'integer', col => col.notNull().defaultTo(30))
      .addColumn('end_month_offset', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('auto_generate', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('config', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('is_default', 'boolean', col => col.notNull().defaultTo(false))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()

    await sql`
      ALTER TABLE attendance_payroll_templates ADD CONSTRAINT attendance_payroll_templates_start_day_check
      CHECK (start_day BETWEEN 1 AND 31)
    `.execute(db)
    await sql`
      ALTER TABLE attendance_payroll_templates ADD CONSTRAINT attendance_payroll_templates_end_day_check
      CHECK (end_day BETWEEN 1 AND 31)
    `.execute(db)
    await sql`
      ALTER TABLE attendance_payroll_templates ADD CONSTRAINT attendance_payroll_templates_offset_check
      CHECK (end_month_offset IN (0, 1))
    `.execute(db)
  }

  await createIndexIfNotExists(db, 'idx_attendance_payroll_templates_org', 'attendance_payroll_templates', 'org_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_payroll_templates_org_name
    ON attendance_payroll_templates(org_id, name)
  `.execute(db)

  const payrollCyclesExists = await checkTableExists(db, 'attendance_payroll_cycles')
  if (!payrollCyclesExists) {
    await db.schema
      .createTable('attendance_payroll_cycles')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('template_id', 'uuid', col => col.references('attendance_payroll_templates.id').onDelete('set null'))
      .addColumn('name', 'text')
      .addColumn('start_date', 'date', col => col.notNull())
      .addColumn('end_date', 'date', col => col.notNull())
      .addColumn('status', 'varchar(20)', col => col.notNull().defaultTo('open'))
      .addColumn('metadata', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()

    await sql`
      ALTER TABLE attendance_payroll_cycles ADD CONSTRAINT attendance_payroll_cycles_status_check
      CHECK (status IN ('open', 'closed', 'archived'))
    `.execute(db)
  }

  await createIndexIfNotExists(db, 'idx_attendance_payroll_cycles_org', 'attendance_payroll_cycles', 'org_id')
  await createIndexIfNotExists(
    db,
    'idx_attendance_payroll_cycles_org_dates',
    'attendance_payroll_cycles',
    ['org_id', 'start_date', 'end_date']
  )
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_payroll_cycles_org_range
    ON attendance_payroll_cycles(org_id, start_date, end_date)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_payroll_cycles').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_payroll_templates').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_rule_sets').ifExists().cascade().execute()
}
