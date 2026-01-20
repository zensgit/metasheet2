import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, 'attendance_overtime_rules')
  if (!exists) {
    await db.schema
      .createTable('attendance_overtime_rules')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('min_minutes', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('rounding_minutes', 'integer', col => col.notNull().defaultTo(15))
      .addColumn('max_minutes_per_day', 'integer', col => col.notNull().defaultTo(600))
      .addColumn('requires_approval', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_overtime_rules_org', 'attendance_overtime_rules', 'org_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_overtime_rules_org_name
    ON attendance_overtime_rules(org_id, name)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_overtime_rules').ifExists().cascade().execute()
}
