import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const tableExists = await checkTableExists(db, 'plm_workbench_team_views')
  if (tableExists) return

  await db.schema
    .createTable('plm_workbench_team_views')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('owner_user_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('scope', 'varchar(32)', (col) => col.notNull().defaultTo('team'))
    .addColumn('kind', 'varchar(32)', (col) => col.notNull())
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('name_key', 'varchar(255)', (col) => col.notNull())
    .addColumn('is_default', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('state', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint('plm_workbench_team_views_owner_name_unique', ['tenant_id', 'owner_user_id', 'scope', 'kind', 'name_key'])
    .execute()

  await db.schema
    .createIndex('idx_plm_workbench_team_views_tenant_kind_updated_at')
    .ifNotExists()
    .on('plm_workbench_team_views')
    .columns(['tenant_id', 'kind', 'updated_at'])
    .execute()

  await db.schema
    .createIndex('idx_plm_workbench_team_views_owner_updated_at')
    .ifNotExists()
    .on('plm_workbench_team_views')
    .columns(['owner_user_id', 'updated_at'])
    .execute()

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_plm_workbench_team_views_default
    ON plm_workbench_team_views(tenant_id, scope, kind)
    WHERE is_default = true
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_plm_workbench_team_views_default`.execute(db)
  await db.schema.dropTable('plm_workbench_team_views').ifExists().execute()
}
