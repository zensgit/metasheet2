/**
 * Migration: `write_approval_form_values` automation action (FWB activation, FWB0 design lock
 * `approval-form-writeback-fwb0-designlock-20260712.md` D11) — widen the action_type CHECK constraint.
 * A dedicated restricted action (NOT reusing create_record — lock §1): save-allowed only on
 * approval.completed rules; execution flag-gated (APPROVAL_FWB_WRITEBACK_ENABLED, default OFF) and
 * riding the durable outbox + the FWB instance-scoped ledger (`meta_fwb_action_applied`). Pure DDL;
 * idempotent; mirrors the send_dingtalk_approval_card widening pattern.
 */
import { sql, type Kysely } from 'kysely'

export const AUTOMATION_ACTION_TYPES_BEFORE_FWB = [
  'notify', 'update_field', 'update_record', 'create_record', 'delete_record',
  'send_webhook', 'send_notification', 'send_email',
  'send_dingtalk_group_message', 'send_dingtalk_person_message',
  'lock_record', 'wait_for_callback', 'condition_branch', 'start_approval',
  'parallel_branch', 'record_click', 'send_dingtalk_approval_card',
] as const

export const AUTOMATION_ACTION_TYPES_WITH_FWB = [
  ...AUTOMATION_ACTION_TYPES_BEFORE_FWB,
  'write_approval_form_values',
] as const

function quoted(actions: readonly string[]): string {
  return actions.map((action) => `'${action}'`).join(', ')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (${quoted(AUTOMATION_ACTION_TYPES_WITH_FWB)}))
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (${quoted(AUTOMATION_ACTION_TYPES_BEFORE_FWB)}))
  `).execute(db)
}
