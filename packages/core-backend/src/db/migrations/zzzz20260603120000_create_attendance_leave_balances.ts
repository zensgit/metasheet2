import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

const DEFAULT_ORG_ID = 'default'
const BALANCES = 'attendance_leave_balances'
const EVENTS = 'attendance_leave_balance_events'

// ④ C1 (design-lock #2230). LATENT ledger schema only — no approve/expire hook reads or writes these
// yet (C2+ wire the runtime accounting). Two tables:
//   - attendance_leave_balances    : grant-LOT ledger (one row per grant; remaining_minutes is the fast
//                                     read). Idempotency backstop = source_key NOT NULL + UNIQUE
//                                     (org_id, source_key) — NOT source_id (a nullable back-link; a
//                                     UNIQUE on source_id would let null manual/accrual grants double-
//                                     credit, since Postgres allows many NULLs).
//   - attendance_leave_balance_events : REQUIRED audit ledger — one +/- row per mutation (grant/deduct/
//                                     expire/revoke). Created here (not an optional later slice) so every
//                                     future mutation can record the fact a remaining_minutes change alone
//                                     would lose (which leave request drew from which lot / what expired).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const balancesExists = await checkTableExists(db, BALANCES)
  if (!balancesExists) {
    await db.schema
      .createTable(BALANCES)
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('leave_type_code', 'text', col => col.notNull())
      .addColumn('amount_minutes', 'integer', col => col.notNull())
      .addColumn('remaining_minutes', 'integer', col => col.notNull())
      .addColumn('source_type', 'text', col => col.notNull())
      .addColumn('source_id', 'text')
      .addColumn('source_key', 'text', col => col.notNull())
      .addColumn('granted_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addColumn('expires_at', 'timestamptz')
      .addColumn('status', 'text', col => col.notNull().defaultTo('active'))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      // DB-level balance invariants (design-lock #2230: 0 ≤ remaining ≤ amount) so no future code bug
      // can persist an impossible balance (negative grant / negative or over-grant remaining).
      .addCheckConstraint('chk_attendance_leave_balances_amount_positive', sql`amount_minutes > 0`)
      .addCheckConstraint('chk_attendance_leave_balances_remaining_range', sql`remaining_minutes >= 0 AND remaining_minutes <= amount_minutes`)
      .addCheckConstraint('chk_attendance_leave_balances_status', sql`status IN ('active', 'exhausted', 'expired', 'revoked')`)
      .execute()
  }
  // The double-credit backstop. A unique INDEX (not just a constraint) so C2 can use
  // INSERT ... ON CONFLICT (org_id, source_key) DO NOTHING for idempotent crediting.
  await createIndexIfNotExists(db, 'uq_attendance_leave_balances_org_source_key', BALANCES, ['org_id', 'source_key'], { unique: true })
  await createIndexIfNotExists(db, 'idx_attendance_leave_balances_user_type', BALANCES, ['org_id', 'user_id', 'leave_type_code'])
  await createIndexIfNotExists(db, 'idx_attendance_leave_balances_active_expiry', BALANCES, ['org_id', 'status', 'expires_at'])

  const eventsExists = await checkTableExists(db, EVENTS)
  if (!eventsExists) {
    await db.schema
      .createTable(EVENTS)
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', col => col.notNull().defaultTo(DEFAULT_ORG_ID))
      .addColumn('user_id', 'text', col => col.notNull())
      .addColumn('balance_id', 'uuid', col => col.notNull().references(`${BALANCES}.id`).onDelete('cascade'))
      .addColumn('event_type', 'text', col => col.notNull())
      .addColumn('delta_minutes', 'integer', col => col.notNull())
      .addColumn('source_type', 'text')
      .addColumn('source_id', 'text')
      .addColumn('occurred_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
      .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
      // events are the +/- audit truth (design-lock #2230): event_type enum + the locked sign per type
      // (grant > 0; deduct/expire/revoke < 0). The sign check also forbids delta_minutes = 0.
      .addCheckConstraint('chk_attendance_leave_balance_events_event_type', sql`event_type IN ('grant', 'deduct', 'expire', 'revoke')`)
      .addCheckConstraint('chk_attendance_leave_balance_events_delta_sign', sql`(event_type = 'grant' AND delta_minutes > 0) OR (event_type IN ('deduct', 'expire', 'revoke') AND delta_minutes < 0)`)
      .execute()
  }
  await createIndexIfNotExists(db, 'idx_attendance_leave_balance_events_balance', EVENTS, ['org_id', 'balance_id'])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // events first (FK references balances)
  await db.schema.dropTable(EVENTS).ifExists().execute()
  await db.schema.dropTable(BALANCES).ifExists().execute()
}
