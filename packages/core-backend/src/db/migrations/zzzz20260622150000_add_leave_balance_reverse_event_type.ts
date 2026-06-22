import { Kysely, sql } from 'kysely'

const EVENTS = 'attendance_leave_balance_events'

/**
 * #7 leave cancellation / 销假 (design-lock #3034): cancelling an APPROVED leave reverses the balance
 * it deducted, via a positive `reverse` event over the originally-deducted lots. The events ledger's
 * two CHECK constraints currently forbid `reverse`:
 *   - chk_..._event_type:  event_type IN ('grant','deduct','expire','revoke')
 *   - chk_..._delta_sign:  grant→δ>0 ; deduct/expire/revoke→δ<0
 * This migration admits `reverse` with δ>0. Additive — the existing four event types are unchanged.
 * Postgres CHECK constraints are immutable, so each is dropped + re-added.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ${sql.ref(EVENTS)} DROP CONSTRAINT IF EXISTS chk_attendance_leave_balance_events_event_type`.execute(db)
  await sql`ALTER TABLE ${sql.ref(EVENTS)} ADD CONSTRAINT chk_attendance_leave_balance_events_event_type CHECK (event_type IN ('grant', 'deduct', 'expire', 'revoke', 'reverse'))`.execute(db)
  await sql`ALTER TABLE ${sql.ref(EVENTS)} DROP CONSTRAINT IF EXISTS chk_attendance_leave_balance_events_delta_sign`.execute(db)
  await sql`ALTER TABLE ${sql.ref(EVENTS)} ADD CONSTRAINT chk_attendance_leave_balance_events_delta_sign CHECK ((event_type IN ('grant', 'reverse') AND delta_minutes > 0) OR (event_type IN ('deduct', 'expire', 'revoke') AND delta_minutes < 0))`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Revert to the pre-#7 constraints (no 'reverse'). Fails if any 'reverse' events already exist —
  // intentional: a down past shipped reversals would corrupt the audit truth.
  await sql`ALTER TABLE ${sql.ref(EVENTS)} DROP CONSTRAINT IF EXISTS chk_attendance_leave_balance_events_event_type`.execute(db)
  await sql`ALTER TABLE ${sql.ref(EVENTS)} ADD CONSTRAINT chk_attendance_leave_balance_events_event_type CHECK (event_type IN ('grant', 'deduct', 'expire', 'revoke'))`.execute(db)
  await sql`ALTER TABLE ${sql.ref(EVENTS)} DROP CONSTRAINT IF EXISTS chk_attendance_leave_balance_events_delta_sign`.execute(db)
  await sql`ALTER TABLE ${sql.ref(EVENTS)} ADD CONSTRAINT chk_attendance_leave_balance_events_delta_sign CHECK ((event_type = 'grant' AND delta_minutes > 0) OR (event_type IN ('deduct', 'expire', 'revoke') AND delta_minutes < 0))`.execute(db)
}
