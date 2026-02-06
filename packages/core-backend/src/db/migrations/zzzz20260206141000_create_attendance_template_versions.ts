import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const tableExists = await checkTableExists(db, 'attendance_rule_template_versions')
  if (!tableExists) {
    await db.schema
      .createTable('attendance_rule_template_versions')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('version', 'integer', col => col.notNull())
      .addColumn('templates', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('created_by', 'text')
      .addColumn('source_version_id', 'uuid')
      .execute()
  }

  await createIndexIfNotExists(
    db,
    'idx_attendance_rule_template_versions_org',
    'attendance_rule_template_versions',
    'org_id'
  )
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_rule_template_versions_org_version
    ON attendance_rule_template_versions(org_id, version)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_rule_template_versions').ifExists().cascade().execute()
}
