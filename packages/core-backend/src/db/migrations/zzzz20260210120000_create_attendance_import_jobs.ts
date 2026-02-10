import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'

/**
 * Async attendance import commits (50k+ rows) need a durable job record so the client
 * can poll status/progress without holding an HTTP request open.
 *
 * This table stores the validated import payload (typically CSV text + mapping info)
 * and a stable batch_id that will be created/committed by the background worker.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, 'attendance_import_jobs')
  if (!exists) {
    await db.schema
      .createTable('attendance_import_jobs')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', (col) => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('batch_id', 'uuid', (col) => col.notNull())
      .addColumn('created_by', 'text', (col) => col.notNull())
      .addColumn('idempotency_key', 'text')
      .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('queued'))
      .addColumn('progress', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('total', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('error', 'text')
      // NOTE: payload can be large (csvText). It is TOASTed by Postgres automatically.
      .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('started_at', 'timestamptz')
      .addColumn('finished_at', 'timestamptz')
      .execute()
  }

  await createIndexIfNotExists(db, 'idx_attendance_import_jobs_org_status', 'attendance_import_jobs', ['org_id', 'status'])
  await createIndexIfNotExists(db, 'idx_attendance_import_jobs_batch', 'attendance_import_jobs', ['org_id', 'batch_id'])

  // Deduplicate client/network retries via idempotencyKey.
  // We can't express a partial unique index via the helper cleanly; use raw SQL.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_import_jobs_idempotency
    ON attendance_import_jobs(org_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_attendance_import_jobs_idempotency`.execute(db)
  await db.schema.dropTable('attendance_import_jobs').ifExists().cascade().execute()
}

