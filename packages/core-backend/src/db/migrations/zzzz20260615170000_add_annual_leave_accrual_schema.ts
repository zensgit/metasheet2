import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'
const RUNS = 'attendance_leave_accrual_runs'
const RUN_ITEMS = 'attendance_leave_accrual_run_items'

// 年假/法定假 L2a (design-lock #2622). LATENT accrual provenance schema — nothing reads or writes these
// yet (L2b accrual engine + L2c manual adjustment wire the runtime). Three DDL changes:
//   - users.cumulative_service_start_date : the 累计工龄 anchor for tenureMode='cumulative_service'.
//       hire_date is本单位入职日 only (insufficient for statutory cumulative service), so a missing value
//       makes the engine SKIP with a visible reason — it never falls back to hire_date. Parallel to the
//       existing users HR-profile columns (employee_no/department/position/hire_date).
//   - attendance_leave_accrual_runs       : one row per accrual execution, snapshotting the policy inputs
//       actually used (tenure_mode/timezone/standard_day_minutes/tiers/policy_version) so a snapshot-口径
//       grant stays auditable even as工龄/policy drift later. dry_run marks preview executions.
//   - attendance_leave_accrual_run_items  : per-user computed entitlement + status/skip_reason. A granted
//       lot's source_id points HERE (run_item.id) — the audit back-link. UNIQUE(run_id,user_id,leave_type_code)
//       so one run computes a given user once.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  // (1) users HR anchor for cumulative service (idempotent; parallel to hire_date).
  const usersExists = await checkTableExists(db, 'users')
  if (usersExists) {
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS cumulative_service_start_date DATE`.execute(db)
  }

  // (2) accrual run header.
  const runsExists = await checkTableExists(db, RUNS)
  if (!runsExists) {
    await db.schema
      .createTable(RUNS)
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('period_key', 'text', col => col.notNull())
      .addColumn('leave_type_code', 'text', col => col.notNull())
      .addColumn('policy_version', 'text', col => col.notNull())
      .addColumn('tenure_mode', 'text', col => col.notNull())
      .addColumn('timezone', 'text', col => col.notNull())
      .addColumn('standard_day_minutes', 'integer', col => col.notNull())
      .addColumn('tiers', 'jsonb', col => col.notNull())
      .addColumn('triggered_by', 'text', col => col.notNull())
      .addColumn('dry_run', 'boolean', col => col.notNull().defaultTo(false))
      .addColumn('occurred_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addCheckConstraint('chk_attendance_leave_accrual_runs_tenure_mode', sql`tenure_mode IN ('cumulative_service', 'company_tenure')`)
      .addCheckConstraint('chk_attendance_leave_accrual_runs_standard_day', sql`standard_day_minutes > 0`)
      .addCheckConstraint('chk_attendance_leave_accrual_runs_triggered_by', sql`triggered_by IN ('manual', 'scheduler')`)
      .execute()
  }
  await createIndexIfNotExists(db, 'idx_attendance_leave_accrual_runs_org_period', RUNS, ['org_id', 'period_key'])

  // (3) per-user run items — the provenance a granted lot's source_id points to.
  const runItemsExists = await checkTableExists(db, RUN_ITEMS)
  if (!runItemsExists) {
    await db.schema
      .createTable(RUN_ITEMS)
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('run_id', 'uuid', col => col.notNull().references(`${RUNS}.id`).onDelete('cascade'))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('leave_type_code', 'text', col => col.notNull())
      .addColumn('tenure_years', 'numeric')
      .addColumn('tier_days', 'integer')
      .addColumn('proration_factor', 'numeric')
      .addColumn('entitlement_minutes', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('status', 'text', col => col.notNull())
      .addColumn('skip_reason', 'text')
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      // status enum + the granted⇔no-reason / skipped⇔reason invariant: a row can't claim 'granted' while
      // carrying a skip reason, nor 'skipped' with no reason — the provenance must always say why it skipped.
      .addCheckConstraint('chk_attendance_leave_accrual_run_items_status', sql`status IN ('granted', 'skipped')`)
      .addCheckConstraint('chk_attendance_leave_accrual_run_items_entitlement', sql`entitlement_minutes >= 0`)
      .addCheckConstraint('chk_attendance_leave_accrual_run_items_reason', sql`(status = 'granted' AND skip_reason IS NULL) OR (status = 'skipped' AND skip_reason IS NOT NULL)`)
      .execute()
  }
  // one computed row per (run, user, leave type) — the engine writes each user once per run.
  await createIndexIfNotExists(db, 'uq_attendance_leave_accrual_run_items_run_user_type', RUN_ITEMS, ['run_id', 'user_id', 'leave_type_code'], { unique: true })
  await createIndexIfNotExists(db, 'idx_attendance_leave_accrual_run_items_run', RUN_ITEMS, ['org_id', 'run_id'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // run_items first (FK references runs); then drop the users anchor column.
  await db.schema.dropTable(RUN_ITEMS).ifExists().execute()
  await db.schema.dropTable(RUNS).ifExists().execute()
  const usersExists = await checkTableExists(db, 'users')
  if (usersExists) {
    await sql`ALTER TABLE users DROP COLUMN IF EXISTS cumulative_service_start_date`.execute(db)
  }
}
