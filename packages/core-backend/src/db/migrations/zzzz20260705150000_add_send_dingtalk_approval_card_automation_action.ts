/**
 * Migration: `send_dingtalk_approval_card` automation action (A-2b, one-tap lock #3594) — widen the
 * action_type CHECK constraint. A dedicated action (NOT reusing send_dingtalk_person_message):
 * it writes the dingtalk_approval_card_deliveries ledger, generates the signed decision deep link,
 * and later carries the Slice-B interactive-card outTrackId. Pure DDL; idempotent.
 */
import { sql, type Kysely } from 'kysely'

export const AUTOMATION_ACTION_TYPES_BEFORE_APPROVAL_CARD = [
  'notify', 'update_field', 'update_record', 'create_record', 'delete_record',
  'send_webhook', 'send_notification', 'send_email',
  'send_dingtalk_group_message', 'send_dingtalk_person_message',
  'lock_record', 'wait_for_callback', 'condition_branch', 'start_approval',
  'parallel_branch', 'record_click',
] as const

export const AUTOMATION_ACTION_TYPES_WITH_APPROVAL_CARD = [
  ...AUTOMATION_ACTION_TYPES_BEFORE_APPROVAL_CARD,
  'send_dingtalk_approval_card',
] as const

function quoted(actions: readonly string[]): string {
  return actions.map((action) => `'${action}'`).join(', ')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (${quoted(AUTOMATION_ACTION_TYPES_WITH_APPROVAL_CARD)}))
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (${quoted(AUTOMATION_ACTION_TYPES_BEFORE_APPROVAL_CARD)}))
  `).execute(db)
}
