/**
 * Migration: `outcome_unknown` status for the three DingTalk send ledgers (PR #4046 Phase B,
 * roadmap §7.2 send-tier semantics).
 *
 * Owner-ratified doctrine: a side-effect send whose outcome is unknowable (network error /
 * timeout / 5xx / malformed 2xx — the client saw no usable response, DingTalk may well have
 * delivered) is recorded as `outcome_unknown` and NEVER auto-resent. It is a DISTINCT terminal
 * state, not a plain failure: reconciliation is manual/ops (DingTalk's async-send result query
 * by task_id only helps when a task_id exists — a lost response has none, so it cannot be an
 * idempotency key).
 *
 * Three persistence surfaces get the widened vocabulary:
 *  - dingtalk_approval_card_deliveries.send_status  (approval-card ledger, one-tap lock #3594)
 *  - dingtalk_person_deliveries.status              (automation person-message + rule-creator telemetry)
 *  - attendance_notification_deliveries.status      (C5 outbox — worker terminal state, not re-claimed)
 *
 * Each table is guarded by checkTableExists so partial-schema test harnesses (isolated-schema
 * suites that run only the migrations they need) can apply this migration too. down() maps
 * existing outcome_unknown rows to 'failed' BEFORE re-tightening each constraint — a down()
 * that fails on live rows is broken.
 */
import { sql, type Kysely } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'dingtalk_approval_card_deliveries')) {
    // The original send_status CHECK was added inline by
    // zzzz20260705150100_add_send_columns_to_dingtalk_approval_card_deliveries (auto-named by
    // Postgres). Drop whatever CHECK constrains send_status, then add a named, widened one.
    await sql`
      DO $$
      DECLARE con RECORD;
      BEGIN
        FOR con IN
          SELECT conname
            FROM pg_constraint
           WHERE conrelid = 'dingtalk_approval_card_deliveries'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%send_status%'
        LOOP
          EXECUTE format('ALTER TABLE dingtalk_approval_card_deliveries DROP CONSTRAINT %I', con.conname);
        END LOOP;
      END $$;
    `.execute(db)
    await sql`
      ALTER TABLE dingtalk_approval_card_deliveries
      ADD CONSTRAINT chk_dingtalk_approval_card_deliveries_send_status
      CHECK (send_status IN ('pending', 'sent', 'failed', 'outcome_unknown'))
    `.execute(db)
  }

  if (await checkTableExists(db, 'dingtalk_person_deliveries')) {
    await sql`
      ALTER TABLE dingtalk_person_deliveries
      DROP CONSTRAINT IF EXISTS chk_dingtalk_person_deliveries_status
    `.execute(db)
    await sql`
      ALTER TABLE dingtalk_person_deliveries
      ADD CONSTRAINT chk_dingtalk_person_deliveries_status
      CHECK (status IN ('success', 'failed', 'skipped', 'outcome_unknown'))
    `.execute(db)
  }

  if (await checkTableExists(db, 'attendance_notification_deliveries')) {
    await sql`
      ALTER TABLE attendance_notification_deliveries
      DROP CONSTRAINT IF EXISTS chk_attendance_notification_deliveries_status
    `.execute(db)
    // NOTE: chk_attendance_notification_deliveries_delivered_status (delivered_at only when
    // status='sent') is untouched — outcome_unknown rows never carry delivered_at.
    await sql`
      ALTER TABLE attendance_notification_deliveries
      ADD CONSTRAINT chk_attendance_notification_deliveries_status
      CHECK (status IN ('pending', 'sending', 'sent', 'retrying', 'failed', 'skipped', 'outcome_unknown'))
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'dingtalk_approval_card_deliveries')) {
    // Map live outcome_unknown rows to 'failed' BEFORE tightening the constraint back. This is
    // lossy by design (the down path has no outcome_unknown vocabulary to keep); send_error
    // retains the original failure text.
    await sql`
      UPDATE dingtalk_approval_card_deliveries
         SET send_status = 'failed'
       WHERE send_status = 'outcome_unknown'
    `.execute(db)
    await sql`
      ALTER TABLE dingtalk_approval_card_deliveries
      DROP CONSTRAINT IF EXISTS chk_dingtalk_approval_card_deliveries_send_status
    `.execute(db)
    await sql`
      ALTER TABLE dingtalk_approval_card_deliveries
      ADD CONSTRAINT chk_dingtalk_approval_card_deliveries_send_status
      CHECK (send_status IN ('pending', 'sent', 'failed'))
    `.execute(db)
  }

  if (await checkTableExists(db, 'dingtalk_person_deliveries')) {
    await sql`
      UPDATE dingtalk_person_deliveries
         SET status = 'failed'
       WHERE status = 'outcome_unknown'
    `.execute(db)
    await sql`
      ALTER TABLE dingtalk_person_deliveries
      DROP CONSTRAINT IF EXISTS chk_dingtalk_person_deliveries_status
    `.execute(db)
    await sql`
      ALTER TABLE dingtalk_person_deliveries
      ADD CONSTRAINT chk_dingtalk_person_deliveries_status
      CHECK (status IN ('success', 'failed', 'skipped'))
    `.execute(db)
  }

  if (await checkTableExists(db, 'attendance_notification_deliveries')) {
    await sql`
      UPDATE attendance_notification_deliveries
         SET status = 'failed'
       WHERE status = 'outcome_unknown'
    `.execute(db)
    await sql`
      ALTER TABLE attendance_notification_deliveries
      DROP CONSTRAINT IF EXISTS chk_attendance_notification_deliveries_status
    `.execute(db)
    await sql`
      ALTER TABLE attendance_notification_deliveries
      ADD CONSTRAINT chk_attendance_notification_deliveries_status
      CHECK (status IN ('pending', 'sending', 'sent', 'retrying', 'failed', 'skipped'))
    `.execute(db)
  }
}
