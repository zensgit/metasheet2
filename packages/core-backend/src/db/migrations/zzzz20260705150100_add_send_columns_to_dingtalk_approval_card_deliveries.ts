/**
 * Migration: send-tracking columns for the approval-card ledger (A-2b, one-tap lock #3594).
 * The owner-ratified spec requires a traceable ledger state/error when the send fails:
 * `send_status` pending → sent | failed (card lifecycle `card_state` stays orthogonal — a card is
 * only actionable while card_state='sent' AND send_status='sent'), `send_error` carries the reason.
 * Unbound recipients never get a ledger row (nothing to anchor); their skip is recorded on the
 * existing dingtalk_person_deliveries telemetry instead.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE dingtalk_approval_card_deliveries
    ADD COLUMN IF NOT EXISTS send_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (send_status IN ('pending', 'sent', 'failed')),
    ADD COLUMN IF NOT EXISTS send_error TEXT
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE dingtalk_approval_card_deliveries
    DROP COLUMN IF EXISTS send_error,
    DROP COLUMN IF EXISTS send_status
  `.execute(db)
}
