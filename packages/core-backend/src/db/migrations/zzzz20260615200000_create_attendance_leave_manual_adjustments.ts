import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'
const TABLE = 'attendance_leave_manual_adjustments'

// 年假/法定假 L2c (design-lock #2622 §3.2 [P1] + dev-verification report #2659). The manual-adjustment
// REGISTRY — the v1-required correction outlet for the snapshot accrual model. A registry row is the
// who/why/when audit the events table (no free-form reason) cannot carry: every manual ± to a user's
// annual balance writes one row here, and the actual balance change goes through LOTS (positive → a new
// annual_manual_adjustment lot + grant event; negative → FIFO-deduct active lots + deduct event), never
// event-only. source_key (UNIQUE per org) is the idempotency backstop so a replay re-applies nothing.
// run_id optionally links the adjustment to the accrual run it corrects — but it NEVER overwrites that
// run's run_item snapshot (纠偏 ≠ 抹证据).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, TABLE)
  if (!exists) {
    await db.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('leave_type_code', 'text', col => col.notNull())
      .addColumn('delta_minutes', 'integer', col => col.notNull())
      .addColumn('reason', 'text', col => col.notNull())
      .addColumn('created_by', 'text')
      .addColumn('run_id', 'uuid')
      .addColumn('source_key', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      // a manual adjustment is a non-zero signed delta (positive = grant, negative = deduct); 0 is a no-op
      // and must never persist as an "adjustment".
      .addCheckConstraint('chk_attendance_leave_manual_adjustments_delta', sql`delta_minutes <> 0`)
      .execute()
  }
  // idempotency: same (org_id, source_key) replayed → unique violation → the endpoint treats it as an
  // already-applied no-op (the registry row + its lot/events are written once).
  await createIndexIfNotExists(db, 'uq_attendance_leave_manual_adjustments_org_source_key', TABLE, ['org_id', 'source_key'], { unique: true })
  await createIndexIfNotExists(db, 'idx_attendance_leave_manual_adjustments_user_type', TABLE, ['org_id', 'user_id', 'leave_type_code'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).ifExists().execute()
}
