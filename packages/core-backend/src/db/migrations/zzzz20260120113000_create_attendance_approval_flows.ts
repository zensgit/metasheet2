import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, 'attendance_approval_flows')
  if (!exists) {
    await db.schema
      .createTable('attendance_approval_flows')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('request_type', 'text', col => col.notNull())
      .addColumn('steps', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_approval_flows_org', 'attendance_approval_flows', 'org_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_approval_flows_org_type_name
    ON attendance_approval_flows(org_id, request_type, name)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_approval_flows').ifExists().cascade().execute()
}
