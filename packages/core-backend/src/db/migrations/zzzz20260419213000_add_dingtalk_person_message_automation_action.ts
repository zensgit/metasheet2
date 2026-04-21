import { sql, type Kysely } from 'kysely'

const ACTIONS = [
  'notify',
  'update_field',
  'update_record',
  'create_record',
  'send_webhook',
  'send_notification',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'lock_record',
] as const

function quotedActions(): string {
  return ACTIONS.map((action) => `'${action}'`).join(', ')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (${quotedActions()}))
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (
      'notify',
      'update_field',
      'update_record',
      'create_record',
      'send_webhook',
      'send_notification',
      'send_dingtalk_group_message',
      'lock_record'
    ))
  `).execute(db)
}
