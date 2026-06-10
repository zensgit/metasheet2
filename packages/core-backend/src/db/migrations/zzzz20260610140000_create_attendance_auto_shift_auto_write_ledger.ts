import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'
const RUNS = 'attendance_auto_shift_auto_write_runs'
const ITEMS = 'attendance_auto_shift_auto_write_run_items'

// A2-2 auto-shift auto-write ledger foundation. Dormant schema only: no scheduler job and no
// assignment writes are wired here. The run table is the durable claim/audit parent; item rows record
// the per-user/day outcome so a later rollback/cleanup can target producer_run_id precisely instead of
// broad producer_type predicates.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const runsExists = await checkTableExists(db, RUNS)
  if (!runsExists) {
    await db.schema
      .createTable(RUNS)
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('source', 'text', col => col.notNull().defaultTo('scheduler'))
      .addColumn('status', 'text', col => col.notNull().defaultTo('running'))
      .addColumn('target_from', 'date', col => col.notNull())
      .addColumn('target_to', 'date', col => col.notNull())
      .addColumn('config_snapshot', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('scanned_count', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('candidate_count', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('applied_count', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('skipped_count', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('error_count', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('error_message', 'text')
      .addColumn('started_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addColumn('finished_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addCheckConstraint('chk_attendance_auto_shift_runs_status', sql`status IN ('running', 'succeeded', 'partial', 'failed')`)
      .addCheckConstraint('chk_attendance_auto_shift_runs_source_nonempty', sql`source <> ''`)
      .addCheckConstraint('chk_attendance_auto_shift_runs_window', sql`target_from <= target_to`)
      .addCheckConstraint(
        'chk_attendance_auto_shift_runs_finished_state',
        sql`(status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL)`,
      )
      .addCheckConstraint(
        'chk_attendance_auto_shift_runs_counts_nonnegative',
        sql`scanned_count >= 0 AND candidate_count >= 0 AND applied_count >= 0 AND skipped_count >= 0 AND error_count >= 0`,
      )
      .execute()
  }

  // Durable active-run claim: a later scheduler tick can INSERT a running row and let this partial
  // unique index reject an overlapping in-flight run for the same org/source/window.
  await createIndexIfNotExists(
    db,
    'uq_attendance_auto_shift_runs_active_window',
    RUNS,
    ['org_id', 'source', 'target_from', 'target_to'],
    { unique: true, where: sql`status = 'running'` },
  )
  await createIndexIfNotExists(db, 'uq_attendance_auto_shift_runs_id_org', RUNS, ['id', 'org_id'], { unique: true })
  await createIndexIfNotExists(db, 'idx_attendance_auto_shift_runs_org_started', RUNS, ['org_id', 'started_at'])
  await createIndexIfNotExists(db, 'idx_attendance_auto_shift_runs_status', RUNS, ['org_id', 'status'])

  const itemsExists = await checkTableExists(db, ITEMS)
  if (!itemsExists) {
    await db.schema
      .createTable(ITEMS)
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('run_id', 'uuid', col => col.notNull())
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('work_date', 'date', col => col.notNull())
      .addColumn('candidate_shift_id', 'uuid')
      .addColumn('confidence', 'text')
      .addColumn('status', 'text', col => col.notNull())
      .addColumn('reason', 'text')
      .addColumn('assignment_id', 'uuid')
      .addColumn('evidence_event_ids', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('error_message', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addCheckConstraint('chk_attendance_auto_shift_run_items_status', sql`status IN ('applied', 'skipped', 'error')`)
      .addCheckConstraint('chk_attendance_auto_shift_run_items_confidence', sql`confidence IS NULL OR confidence IN ('high', 'medium', 'low')`)
      .addCheckConstraint('chk_attendance_auto_shift_run_items_evidence_array', sql`jsonb_typeof(evidence_event_ids) = 'array'`)
      .addCheckConstraint('chk_attendance_auto_shift_run_items_assignment_state', sql`(status = 'applied') = (assignment_id IS NOT NULL)`)
      .addCheckConstraint(
        'chk_attendance_auto_shift_run_items_reason',
        sql`status = 'applied' OR reason IS NOT NULL OR error_message IS NOT NULL`,
      )
      .execute()
  }

  await sql`ALTER TABLE attendance_auto_shift_auto_write_run_items DROP CONSTRAINT IF EXISTS fk_attendance_auto_shift_run_items_run_org`.execute(db)
  await db.schema
    .alterTable(ITEMS)
    .addForeignKeyConstraint(
      'fk_attendance_auto_shift_run_items_run_org',
      ['run_id', 'org_id'],
      RUNS,
      ['id', 'org_id'],
    )
    .onDelete('cascade')
    .execute()

  await createIndexIfNotExists(
    db,
    'uq_attendance_auto_shift_run_items_user_day',
    ITEMS,
    ['run_id', 'user_id', 'work_date'],
    { unique: true },
  )
  await createIndexIfNotExists(db, 'idx_attendance_auto_shift_run_items_user_day', ITEMS, ['org_id', 'user_id', 'work_date'])
  await createIndexIfNotExists(db, 'idx_attendance_auto_shift_run_items_run_status', ITEMS, ['run_id', 'status'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(ITEMS).ifExists().execute()
  await db.schema.dropTable(RUNS).ifExists().execute()
}
