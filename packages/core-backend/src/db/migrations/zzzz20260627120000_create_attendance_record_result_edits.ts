import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'
const TABLE = 'attendance_record_result_edits'

// AE-1 (design-lock attendance-anomaly-result-edit-guard-design-lock-20260626 §4.1, RATIFIED 2026-06-27).
// The IMMUTABLE before/after audit row for a manual "correct a confirmed attendance anomaly result" action.
// Every edit writes exactly one row here keyed by the client-supplied idempotencyKey; the record update goes
// through applyAttendanceResultEdit (statusOverride + §3.5a normalized overrideMetrics — never a naked status
// UPDATE), and this row is the who/why/when + before/after fact the attendance_records row itself cannot carry.
//
// Immutability discipline:
//   - NO FK on record_id: a deleted/re-keyed attendance_records row must NEVER cascade-delete its correction
//     audit (the audit outlives the record it corrects). record_id is a soft reference; the (org_id, record_id)
//     index serves history lookups.
//   - idempotency_key is NOT NULL + UNIQUE(org_id, idempotency_key): same key+same payload replays to
//     alreadyApplied (no second write); same key+different payload → 409. NOT NULL avoids Postgres'
//     nullable-unique bypass (NULLs compare non-equal), so the idempotency key can never be NULL-evaded.
//   - before_snapshot / after_snapshot are NOT NULL jsonb: every edit persists the full before/after record
//     fact regardless of policy (reason is also always written, even when requireReason is later disabled).
//
// notification_delivery_id / notification_skipped_reason are added NOW but stay NULL: AE-1 builds NO notifier.
// AE-2's C5 producer fills exactly one of them (delivery id on enqueue, skipped reason on policy_disabled /
// recipient_not_active) without needing a follow-up migration.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const exists = await checkTableExists(db, TABLE)
  if (!exists) {
    await db.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('record_id', 'uuid', col => col.notNull())
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('work_date', 'date', col => col.notNull())
      .addColumn('before_status', 'text', col => col.notNull())
      .addColumn('after_status', 'text', col => col.notNull())
      .addColumn('before_snapshot', 'jsonb', col => col.notNull())
      .addColumn('after_snapshot', 'jsonb', col => col.notNull())
      .addColumn('reason', 'text', col => col.notNull())
      .addColumn('evidence', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('actor_user_id', 'text', col => col.notNull())
      // idempotency_key is the client-supplied key; the route NEVER generates one. NOT NULL so the
      // UNIQUE(org_id, idempotency_key) below cannot be NULL-bypassed.
      .addColumn('idempotency_key', 'text', col => col.notNull())
      // AE-2 fills exactly one of these; AE-1 leaves both NULL (no notifier built).
      .addColumn('notification_delivery_id', 'uuid')
      .addColumn('notification_skipped_reason', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  // Idempotency backstop: same (org_id, idempotency_key) → unique violation → compare-then-409 / alreadyApplied.
  await createIndexIfNotExists(db, 'uq_attendance_record_result_edits_org_idempotency_key', TABLE, ['org_id', 'idempotency_key'], { unique: true })
  // History lookups by record (record drawer / future AE-3 surfaces).
  await createIndexIfNotExists(db, 'idx_attendance_record_result_edits_org_record', TABLE, ['org_id', 'record_id'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).ifExists().execute()
}
