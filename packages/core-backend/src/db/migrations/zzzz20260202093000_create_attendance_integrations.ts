import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const integrationsExists = await checkTableExists(db, 'attendance_integrations')
  if (!integrationsExists) {
    await db.schema
      .createTable('attendance_integrations')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('type', 'text', col => col.notNull())
      .addColumn('status', 'text', col => col.notNull().defaultTo('active'))
      .addColumn('config', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('last_sync_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_integrations_org', 'attendance_integrations', 'org_id')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_integrations_org_name
    ON attendance_integrations(org_id, name)
  `.execute(db)

  const runsExists = await checkTableExists(db, 'attendance_integration_runs')
  if (!runsExists) {
    await db.schema
      .createTable('attendance_integration_runs')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('integration_id', 'uuid', col => col.notNull())
      .addColumn('status', 'text', col => col.notNull().defaultTo('running'))
      .addColumn('message', 'text')
      .addColumn('meta', 'jsonb', col => col.defaultTo(sql`'{}'::jsonb`))
      .addColumn('started_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addColumn('finished_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_integration_runs_org', 'attendance_integration_runs', 'org_id')
  await createIndexIfNotExists(
    db,
    'idx_attendance_integration_runs_integration',
    'attendance_integration_runs',
    'integration_id'
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('attendance_integration_runs').ifExists().cascade().execute()
  await db.schema.dropTable('attendance_integrations').ifExists().cascade().execute()
}
