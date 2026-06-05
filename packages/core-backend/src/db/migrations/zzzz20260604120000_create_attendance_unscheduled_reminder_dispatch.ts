import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'
const TABLE = 'attendance_unscheduled_reminder_dispatch'

// ⑤ Unscheduled-shift reminder dispatch ledger + dedup (design-lock
// attendance-unscheduled-reminder-design-lock-20260604). One row per
// (org_id, user_id, target_date, reminder_type) reminder the scan claimed. The UNIQUE index doubles as
// the AT-MOST-ONCE guard: the reminder job does INSERT ... ON CONFLICT DO NOTHING RETURNING, so a
// repeated / concurrent scheduler tick re-claims nothing (mirrors ④'s status-claim idempotency). v1 has
// NO external delivery (AttendanceNotifier ships no channels), so this row IS the internal reminder
// record; a real channel behind an explicit env is a later (C5) follow-up.
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
      .addColumn('target_date', 'date', col => col.notNull())
      .addColumn('reminder_type', 'text', col => col.notNull().defaultTo('unscheduled'))
      .addColumn('dispatched_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .execute()
  }
  // The at-most-once backstop — a unique INDEX (not just a constraint) so the job can use
  // INSERT ... ON CONFLICT (org_id, user_id, target_date, reminder_type) DO NOTHING.
  await createIndexIfNotExists(
    db,
    'uq_attendance_unsched_reminder_dispatch',
    TABLE,
    ['org_id', 'user_id', 'target_date', 'reminder_type'],
    { unique: true },
  )
  await createIndexIfNotExists(
    db,
    'idx_attendance_unsched_reminder_dispatch_date',
    TABLE,
    ['org_id', 'target_date'],
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).ifExists().execute()
}
