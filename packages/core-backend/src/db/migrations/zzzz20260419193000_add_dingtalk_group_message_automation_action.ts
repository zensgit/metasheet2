import { sql, type Kysely } from 'kysely'

function addConstraint(db: Kysely<unknown>, values: string[]) {
  const quoted = values.map((value) => `'${value}'`).join(', ')
  return sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (${quoted}))
  `).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await addConstraint(db, [
    'notify',
    'update_field',
    'update_record',
    'create_record',
    'send_webhook',
    'send_notification',
    'send_dingtalk_group_message',
    'lock_record',
  ])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await addConstraint(db, [
    'notify',
    'update_field',
    'update_record',
    'create_record',
    'send_webhook',
    'send_notification',
    'lock_record',
  ])
}
