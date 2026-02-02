import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const tableExists = await checkTableExists(db, 'attendance_rule_template_library')
  if (!tableExists) {
    await db.schema
      .createTable('attendance_rule_template_library')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('description', 'text')
      .addColumn('template', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(
    db,
    'idx_attendance_rule_template_library_org',
    'attendance_rule_template_library',
    'org_id'
  )
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_rule_template_library_org_name
    ON attendance_rule_template_library(org_id, name)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_rule_template_library').ifExists().cascade().execute()
}
