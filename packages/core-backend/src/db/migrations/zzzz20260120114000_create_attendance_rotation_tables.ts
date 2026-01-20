import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const rulesExists = await checkTableExists(db, 'attendance_rotation_rules')
  if (!rulesExists) {
    await db.schema
      .createTable('attendance_rotation_rules')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('timezone', 'varchar(64)', col => col.notNull().defaultTo('UTC'))
      .addColumn('shift_sequence', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_rotation_rules_org', 'attendance_rotation_rules', 'org_id')

  const assignmentsExists = await checkTableExists(db, 'attendance_rotation_assignments')
  if (!assignmentsExists) {
    await db.schema
      .createTable('attendance_rotation_assignments')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('rotation_rule_id', 'uuid', col =>
        col.notNull().references('attendance_rotation_rules.id').onDelete('cascade')
      )
      .addColumn('start_date', 'date', col => col.notNull())
      .addColumn('end_date', 'date')
      .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_rotation_assignments_org', 'attendance_rotation_assignments', 'org_id')
  await createIndexIfNotExists(db, 'idx_attendance_rotation_assignments_user_org', 'attendance_rotation_assignments', ['user_id', 'org_id'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_rotation_assignments').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_rotation_rules').ifExists().cascade().execute()
}
