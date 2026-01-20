import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, 'attendance_leave_types')
  if (!exists) {
    await db.schema
      .createTable('attendance_leave_types')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('code', 'text', col => col.notNull())
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('requires_approval', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('requires_attachment', 'boolean', col => col.notNull().defaultTo(false))
      .addColumn('default_minutes_per_day', 'integer', col => col.notNull().defaultTo(480))
      .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_leave_types_org', 'attendance_leave_types', 'org_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_leave_types_org_code
    ON attendance_leave_types(org_id, code)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_leave_types').ifExists().cascade().execute()
}
