import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const groupsExists = await checkTableExists(db, 'attendance_groups')
  if (!groupsExists) return

  const managersExists = await checkTableExists(db, 'attendance_group_managers')
  if (!managersExists) {
    await db.schema
      .createTable('attendance_group_managers')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('group_id', 'uuid', col => col.notNull().references('attendance_groups.id').onDelete('cascade'))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('role', 'text', col => col.notNull())
      .addColumn('created_by', 'text')
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    ALTER TABLE attendance_group_managers
    DROP CONSTRAINT IF EXISTS attendance_group_managers_role_check
  `.execute(db)
  await sql`
    ALTER TABLE attendance_group_managers
    ADD CONSTRAINT attendance_group_managers_role_check
    CHECK (role IN ('owner', 'sub_owner'))
  `.execute(db)

  await createIndexIfNotExists(db, 'idx_attendance_group_managers_org', 'attendance_group_managers', 'org_id')
  await createIndexIfNotExists(db, 'idx_attendance_group_managers_group', 'attendance_group_managers', 'group_id')
  await createIndexIfNotExists(db, 'idx_attendance_group_managers_user', 'attendance_group_managers', 'user_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_group_managers_unique
    ON attendance_group_managers(org_id, group_id, user_id, role)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_group_managers').ifExists().cascade().execute()
}
