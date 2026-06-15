/**
 * Migration: Phase C2 — widen the automation action-type CHECK constraint to
 * include `delete_record` (cross-base record delete; same-base delete too).
 *
 * Keeps `chk_automation_action_type` aligned with the app-level
 * `ALL_ACTION_TYPES`. NULL-safe: only the enum widens; no table or column is
 * added in this slice.
 */

import { sql, type Kysely } from 'kysely'

export const AUTOMATION_ACTION_TYPES_WITH_DELETE_RECORD = [
  'notify',
  'update_field',
  'update_record',
  'create_record',
  'delete_record',
  'send_webhook',
  'send_notification',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'lock_record',
  'wait_for_callback',
  'condition_branch',
  'start_approval',
  'parallel_branch',
] as const

export const AUTOMATION_ACTION_TYPES_BEFORE_DELETE_RECORD = [
  'notify',
  'update_field',
  'update_record',
  'create_record',
  'send_webhook',
  'send_notification',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'lock_record',
  'wait_for_callback',
  'condition_branch',
  'start_approval',
  'parallel_branch',
] as const

function quotedActions(actions: readonly string[]): string {
  return actions.map((action) => `'${action}'`).join(', ')
}

async function replaceAutomationActionTypeConstraint(
  db: Kysely<unknown>,
  actions: readonly string[],
): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (${quotedActions(actions)}))
  `).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await replaceAutomationActionTypeConstraint(db, AUTOMATION_ACTION_TYPES_WITH_DELETE_RECORD)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await replaceAutomationActionTypeConstraint(db, AUTOMATION_ACTION_TYPES_BEFORE_DELETE_RECORD)
}
