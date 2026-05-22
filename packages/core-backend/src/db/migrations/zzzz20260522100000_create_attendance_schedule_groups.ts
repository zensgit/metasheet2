import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const scheduleGroupsExists = await checkTableExists(db, 'attendance_schedule_groups')
  if (!scheduleGroupsExists) {
    await db.schema
      .createTable('attendance_schedule_groups')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('code', 'text')
      .addColumn('description', 'text')
      .addColumn('attendance_group_id', 'uuid', col => col.references('attendance_groups.id').onDelete('set null'))
      .addColumn('parent_id', 'uuid', col => col.references('attendance_schedule_groups.id').onDelete('set null'))
      .addColumn('department_ref', 'text')
      .addColumn('source', 'text', col => col.notNull().defaultTo('manual'))
      .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('created_by', 'text')
      .addColumn('updated_by', 'text')
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_schedule_groups_org', 'attendance_schedule_groups', 'org_id')
  await createIndexIfNotExists(db, 'idx_attendance_schedule_groups_attendance_group', 'attendance_schedule_groups', 'attendance_group_id')
  await createIndexIfNotExists(db, 'idx_attendance_schedule_groups_parent', 'attendance_schedule_groups', 'parent_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_schedule_groups_org_name_active
    ON attendance_schedule_groups(org_id, name)
    WHERE is_active = true
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_schedule_groups_org_code
    ON attendance_schedule_groups(org_id, code)
    WHERE code IS NOT NULL
  `.execute(db)

  const membersExists = await checkTableExists(db, 'attendance_schedule_group_members')
  if (!membersExists) {
    await db.schema
      .createTable('attendance_schedule_group_members')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('schedule_group_id', 'uuid', col => col.notNull().references('attendance_schedule_groups.id').onDelete('cascade'))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('effective_from', 'date')
      .addColumn('effective_to', 'date')
      .addColumn('role', 'text')
      .addColumn('source', 'text', col => col.notNull().defaultTo('manual'))
      .addColumn('created_by', 'text')
      .addColumn('updated_by', 'text')
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_schedule_group_members_org', 'attendance_schedule_group_members', 'org_id')
  await createIndexIfNotExists(db, 'idx_attendance_schedule_group_members_group', 'attendance_schedule_group_members', 'schedule_group_id')
  await createIndexIfNotExists(db, 'idx_attendance_schedule_group_members_user', 'attendance_schedule_group_members', 'user_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_schedule_group_members_exact_window
    ON attendance_schedule_group_members(
      org_id,
      schedule_group_id,
      user_id,
      COALESCE(effective_from, DATE '0001-01-01'),
      COALESCE(effective_to, DATE '9999-12-31')
    )
  `.execute(db)
  await sql`
    ALTER TABLE attendance_schedule_group_members
    ADD CONSTRAINT attendance_schedule_group_members_window_check
    CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from)
  `.execute(db).catch((error) => {
    if (error?.code !== '42710') throw error
  })

  const scopesExists = await checkTableExists(db, 'attendance_scheduler_scopes')
  if (!scopesExists) {
    await db.schema
      .createTable('attendance_scheduler_scopes')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('subject_type', 'text', col => col.notNull())
      .addColumn('subject_ref', 'text', col => col.notNull())
      .addColumn('actions', sql`text[]`, col => col.notNull())
      .addColumn('scope', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('created_by', 'text')
      .addColumn('updated_by', 'text')
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_scheduler_scopes_org', 'attendance_scheduler_scopes', 'org_id')
  await createIndexIfNotExists(db, 'idx_attendance_scheduler_scopes_subject', 'attendance_scheduler_scopes', 'subject_ref')
  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_scheduler_scopes_active_subject
    ON attendance_scheduler_scopes(org_id, subject_type, subject_ref)
    WHERE is_active = true
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_scheduler_scopes').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_schedule_group_members').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_schedule_groups').ifExists().cascade().execute()
}
