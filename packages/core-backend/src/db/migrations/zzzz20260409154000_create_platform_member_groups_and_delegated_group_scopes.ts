import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const memberGroupsExists = await checkTableExists(db, 'platform_member_groups')
  if (!memberGroupsExists) {
    await db.schema
      .createTable('platform_member_groups')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
      .addColumn('updated_by', 'text', (col) => col.references('users.id').onDelete('set null'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_member_groups_name
    ON platform_member_groups(name)
  `.execute(db)

  const groupMembersExists = await checkTableExists(db, 'platform_member_group_members')
  if (!groupMembersExists) {
    await db.schema
      .createTable('platform_member_group_members')
      .ifNotExists()
      .addColumn('group_id', 'uuid', (col) => col.notNull().references('platform_member_groups.id').onDelete('cascade'))
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'platform_member_group_members_pkey'
          AND conrelid = 'platform_member_group_members'::regclass
      ) THEN
        ALTER TABLE platform_member_group_members
        ADD PRIMARY KEY (group_id, user_id);
      END IF;
    END $$;
  `.execute(db)

  await createIndexIfNotExists(
    db,
    'idx_platform_member_group_members_user_id',
    'platform_member_group_members',
    'user_id',
  )

  const delegatedGroupScopesExists = await checkTableExists(db, 'delegated_role_admin_member_groups')
  if (!delegatedGroupScopesExists) {
    await db.schema
      .createTable('delegated_role_admin_member_groups')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('admin_user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('namespace', 'text', (col) => col.notNull())
      .addColumn('group_id', 'uuid', (col) => col.notNull().references('platform_member_groups.id').onDelete('cascade'))
      .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegated_role_admin_member_groups_unique
    ON delegated_role_admin_member_groups(admin_user_id, namespace, group_id)
  `.execute(db)

  await createIndexIfNotExists(
    db,
    'idx_delegated_role_admin_member_groups_group_id',
    'delegated_role_admin_member_groups',
    'group_id',
  )

  const templateGroupsExists = await checkTableExists(db, 'delegated_role_scope_template_member_groups')
  if (!templateGroupsExists) {
    await db.schema
      .createTable('delegated_role_scope_template_member_groups')
      .ifNotExists()
      .addColumn('template_id', 'uuid', (col) => col.notNull().references('delegated_role_scope_templates.id').onDelete('cascade'))
      .addColumn('group_id', 'uuid', (col) => col.notNull().references('platform_member_groups.id').onDelete('cascade'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'delegated_role_scope_template_member_groups_pkey'
          AND conrelid = 'delegated_role_scope_template_member_groups'::regclass
      ) THEN
        ALTER TABLE delegated_role_scope_template_member_groups
        ADD PRIMARY KEY (template_id, group_id);
      END IF;
    END $$;
  `.execute(db)

  await createIndexIfNotExists(
    db,
    'idx_delegated_role_scope_template_member_groups_group_id',
    'delegated_role_scope_template_member_groups',
    'group_id',
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('delegated_role_scope_template_member_groups').ifExists().cascade().execute()
  await db.schema.dropTable('delegated_role_admin_member_groups').ifExists().cascade().execute()
  await db.schema.dropTable('platform_member_group_members').ifExists().cascade().execute()
  await db.schema.dropTable('platform_member_groups').ifExists().cascade().execute()
}
