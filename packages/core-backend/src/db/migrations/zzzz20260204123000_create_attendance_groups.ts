import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const groupsExists = await checkTableExists(db, 'attendance_groups')
  if (!groupsExists) {
    await db.schema
      .createTable('attendance_groups')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('code', 'text')
      .addColumn('timezone', 'text', col => col.notNull().defaultTo('UTC'))
      .addColumn('rule_set_id', 'uuid')
      .addColumn('description', 'text')
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_groups_org', 'attendance_groups', 'org_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_groups_org_name
    ON attendance_groups(org_id, name)
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_groups_org_code
    ON attendance_groups(org_id, code)
    WHERE code IS NOT NULL
  `.execute(db)

  const membersExists = await checkTableExists(db, 'attendance_group_members')
  if (!membersExists) {
    await db.schema
      .createTable('attendance_group_members')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('group_id', 'uuid', col => col.notNull().references('attendance_groups.id').onDelete('cascade'))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_group_members_org', 'attendance_group_members', 'org_id')
  await createIndexIfNotExists(db, 'idx_attendance_group_members_group', 'attendance_group_members', 'group_id')
  await createIndexIfNotExists(db, 'idx_attendance_group_members_user', 'attendance_group_members', 'user_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_group_members_unique
    ON attendance_group_members(org_id, group_id, user_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_group_members').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_groups').ifExists().cascade().execute()
}
