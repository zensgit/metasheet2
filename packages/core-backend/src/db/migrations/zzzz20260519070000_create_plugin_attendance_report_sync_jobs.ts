import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

/**
 * Operational cursor/progress state for attendance report multitable sync jobs.
 *
 * This table is not an attendance fact source and is not read by attendance
 * query/export paths. It only lets the attendance plugin resume/cancel paged
 * syncs into private report multitable objects.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, 'plugin_attendance_report_sync_jobs')
  if (!exists) {
    await db.schema
      .createTable('plugin_attendance_report_sync_jobs')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', (col) => col.notNull())
      .addColumn('kind', 'varchar(32)', (col) => col.notNull())
      .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('queued'))
      .addColumn('mode', 'varchar(20)', (col) => col.notNull().defaultTo('manual_step'))
      .addColumn('created_by', 'text')
      .addColumn('period_source', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('user_selection', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('cursor', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('totals', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('last_result', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('error', 'text')
      .addColumn('idempotency_key', 'text')
      .addColumn('locked_at', 'timestamptz')
      .addColumn('started_at', 'timestamptz')
      .addColumn('finished_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addCheckConstraint(
        'chk_plugin_attendance_report_sync_jobs_kind',
        sql`kind IN ('daily_records', 'period_summaries')`,
      )
      .addCheckConstraint(
        'chk_plugin_attendance_report_sync_jobs_status',
        sql`status IN ('queued', 'running', 'paused', 'completed', 'failed', 'canceled')`,
      )
      .addCheckConstraint(
        'chk_plugin_attendance_report_sync_jobs_mode',
        sql`mode IN ('manual_step', 'enqueue')`,
      )
      .execute()
  }

  await createIndexIfNotExists(
    db,
    'idx_plugin_attendance_report_sync_jobs_org_status_updated',
    'plugin_attendance_report_sync_jobs',
    ['org_id', 'status', 'updated_at'],
  )
  await createIndexIfNotExists(
    db,
    'idx_plugin_attendance_report_sync_jobs_org_created',
    'plugin_attendance_report_sync_jobs',
    ['org_id', 'created_at'],
  )

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_attendance_report_sync_jobs_idempotency
    ON plugin_attendance_report_sync_jobs(org_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_plugin_attendance_report_sync_jobs_idempotency`.execute(db)
  await db.schema.dropTable('plugin_attendance_report_sync_jobs').ifExists().cascade().execute()
}
