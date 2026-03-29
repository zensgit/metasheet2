import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const templateCentersExists = await checkTableExists(db, 'directory_template_centers')
  if (!templateCentersExists) {
    await db.schema
      .createTable('directory_template_centers')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('integration_id', 'uuid', (col) => col.notNull().references('directory_integrations.id').onDelete('cascade'))
      .addColumn('team_templates', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('import_history', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('import_presets', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_by', 'text')
      .addColumn('updated_by', 'text')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_template_centers_integration
    ON directory_template_centers(integration_id)
  `.execute(db)

  const templateCenterVersionsExists = await checkTableExists(db, 'directory_template_center_versions')
  if (!templateCenterVersionsExists) {
    await db.schema
      .createTable('directory_template_center_versions')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('center_id', 'uuid', (col) => col.notNull().references('directory_template_centers.id').onDelete('cascade'))
      .addColumn('integration_id', 'uuid', (col) => col.notNull().references('directory_integrations.id').onDelete('cascade'))
      .addColumn('snapshot', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('change_reason', 'text', (col) => col.notNull().defaultTo('manual_update'))
      .addColumn('created_by', 'text')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }
  await createIndexIfNotExists(db, 'idx_directory_template_center_versions_center', 'directory_template_center_versions', 'center_id')
  await createIndexIfNotExists(db, 'idx_directory_template_center_versions_integration', 'directory_template_center_versions', 'integration_id')

  const syncAlertsExists = await checkTableExists(db, 'directory_sync_alerts')
  if (!syncAlertsExists) {
    await db.schema
      .createTable('directory_sync_alerts')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('integration_id', 'uuid', (col) => col.notNull().references('directory_integrations.id').onDelete('cascade'))
      .addColumn('run_id', 'uuid', (col) => col.references('directory_sync_runs.id').onDelete('set null'))
      .addColumn('level', 'text', (col) => col.notNull().defaultTo('error'))
      .addColumn('code', 'text', (col) => col.notNull())
      .addColumn('message', 'text', (col) => col.notNull())
      .addColumn('details', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('sent_to_webhook', 'boolean', (col) => col.notNull().defaultTo(false))
      .addColumn('acknowledged_at', 'timestamptz')
      .addColumn('acknowledged_by', 'text')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }
  await createIndexIfNotExists(db, 'idx_directory_sync_alerts_integration', 'directory_sync_alerts', 'integration_id')
  await createIndexIfNotExists(db, 'idx_directory_sync_alerts_run', 'directory_sync_alerts', 'run_id')
  await createIndexIfNotExists(db, 'idx_directory_sync_alerts_acknowledged', 'directory_sync_alerts', 'acknowledged_at')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('directory_sync_alerts').ifExists().cascade().execute()
  await db.schema.dropTable('directory_template_center_versions').ifExists().cascade().execute()
  await db.schema.dropTable('directory_template_centers').ifExists().cascade().execute()
}
