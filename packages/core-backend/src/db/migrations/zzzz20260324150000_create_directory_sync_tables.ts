import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const integrationsExists = await checkTableExists(db, 'directory_integrations')
  if (!integrationsExists) {
    await db.schema
      .createTable('directory_integrations')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', (col) => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('provider', 'text', (col) => col.notNull().defaultTo('dingtalk'))
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
      .addColumn('corp_id', 'text', (col) => col.notNull())
      .addColumn('config', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('sync_enabled', 'boolean', (col) => col.notNull().defaultTo(false))
      .addColumn('schedule_cron', 'text')
      .addColumn('default_deprovision_policy', 'text', (col) => col.notNull().defaultTo('mark_inactive'))
      .addColumn('last_sync_at', 'timestamptz')
      .addColumn('last_success_at', 'timestamptz')
      .addColumn('last_cursor', 'jsonb')
      .addColumn('last_error', 'text')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }
  await createIndexIfNotExists(db, 'idx_directory_integrations_org', 'directory_integrations', 'org_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_integrations_org_provider_name
    ON directory_integrations(org_id, provider, name)
  `.execute(db)

  const departmentsExists = await checkTableExists(db, 'directory_departments')
  if (!departmentsExists) {
    await db.schema
      .createTable('directory_departments')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('integration_id', 'uuid', (col) => col.notNull().references('directory_integrations.id').onDelete('cascade'))
      .addColumn('provider', 'text', (col) => col.notNull().defaultTo('dingtalk'))
      .addColumn('external_department_id', 'text', (col) => col.notNull())
      .addColumn('external_parent_department_id', 'text')
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('full_path', 'text')
      .addColumn('order_index', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('raw', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_departments_integration_external
    ON directory_departments(integration_id, external_department_id)
  `.execute(db)
  await createIndexIfNotExists(db, 'idx_directory_departments_integration', 'directory_departments', 'integration_id')

  const accountsExists = await checkTableExists(db, 'directory_accounts')
  if (!accountsExists) {
    await db.schema
      .createTable('directory_accounts')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('integration_id', 'uuid', (col) => col.notNull().references('directory_integrations.id').onDelete('cascade'))
      .addColumn('provider', 'text', (col) => col.notNull().defaultTo('dingtalk'))
      .addColumn('corp_id', 'text')
      .addColumn('external_user_id', 'text', (col) => col.notNull())
      .addColumn('union_id', 'text')
      .addColumn('open_id', 'text')
      .addColumn('external_key', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('nick', 'text')
      .addColumn('email', 'text')
      .addColumn('mobile', 'text')
      .addColumn('job_number', 'text')
      .addColumn('title', 'text')
      .addColumn('avatar_url', 'text')
      .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('deprovision_policy_override', 'text')
      .addColumn('raw', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_accounts_integration_external_user
    ON directory_accounts(integration_id, external_user_id)
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_accounts_provider_external_key
    ON directory_accounts(provider, external_key)
  `.execute(db)
  await createIndexIfNotExists(db, 'idx_directory_accounts_integration', 'directory_accounts', 'integration_id')
  await createIndexIfNotExists(db, 'idx_directory_accounts_email', 'directory_accounts', 'email')
  await createIndexIfNotExists(db, 'idx_directory_accounts_mobile', 'directory_accounts', 'mobile')

  const accountDepartmentsExists = await checkTableExists(db, 'directory_account_departments')
  if (!accountDepartmentsExists) {
    await db.schema
      .createTable('directory_account_departments')
      .ifNotExists()
      .addColumn('directory_account_id', 'uuid', (col) => col.notNull().references('directory_accounts.id').onDelete('cascade'))
      .addColumn('directory_department_id', 'uuid', (col) => col.notNull().references('directory_departments.id').onDelete('cascade'))
      .addColumn('is_primary', 'boolean', (col) => col.notNull().defaultTo(false))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'directory_account_departments_pkey'
          AND conrelid = 'directory_account_departments'::regclass
      ) THEN
        ALTER TABLE directory_account_departments
        ADD PRIMARY KEY (directory_account_id, directory_department_id);
      END IF;
    END $$;
  `.execute(db)

  const linksExists = await checkTableExists(db, 'directory_account_links')
  if (!linksExists) {
    await db.schema
      .createTable('directory_account_links')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('directory_account_id', 'uuid', (col) => col.notNull().references('directory_accounts.id').onDelete('cascade'))
      .addColumn('local_user_id', 'text', (col) => col.references('users.id').onDelete('set null'))
      .addColumn('link_status', 'text', (col) => col.notNull().defaultTo('pending'))
      .addColumn('match_strategy', 'text')
      .addColumn('reviewed_by', 'text')
      .addColumn('review_note', 'text')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_account_links_account
    ON directory_account_links(directory_account_id)
  `.execute(db)
  await createIndexIfNotExists(db, 'idx_directory_account_links_user', 'directory_account_links', 'local_user_id')

  const runsExists = await checkTableExists(db, 'directory_sync_runs')
  if (!runsExists) {
    await db.schema
      .createTable('directory_sync_runs')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('integration_id', 'uuid', (col) => col.notNull().references('directory_integrations.id').onDelete('cascade'))
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('running'))
      .addColumn('started_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('finished_at', 'timestamptz')
      .addColumn('cursor_before', 'jsonb')
      .addColumn('cursor_after', 'jsonb')
      .addColumn('stats', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('error_message', 'text')
      .addColumn('meta', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('triggered_by', 'text')
      .addColumn('trigger_source', 'text', (col) => col.notNull().defaultTo('manual'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }
  await createIndexIfNotExists(db, 'idx_directory_sync_runs_integration', 'directory_sync_runs', 'integration_id')
  await createIndexIfNotExists(db, 'idx_directory_sync_runs_status', 'directory_sync_runs', 'status')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('directory_sync_runs').ifExists().cascade().execute()
  await db.schema.dropTable('directory_account_links').ifExists().cascade().execute()
  await db.schema.dropTable('directory_account_departments').ifExists().cascade().execute()
  await db.schema.dropTable('directory_accounts').ifExists().cascade().execute()
  await db.schema.dropTable('directory_departments').ifExists().cascade().execute()
  await db.schema.dropTable('directory_integrations').ifExists().cascade().execute()
}
