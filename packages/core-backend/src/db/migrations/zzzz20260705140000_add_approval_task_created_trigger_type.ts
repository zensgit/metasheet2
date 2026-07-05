/**
 * Migration: `approval.task_created` automation trigger (A-2a, one-tap lock #3594 implementation
 * decision) — widen the trigger_type CHECK constraint.
 *
 * The pending-task trigger is added to the application's VALID_TRIGGER_TYPES (automation-service +
 * automation-triggers). The DB CHECK constraint `chk_automation_trigger_type` on `automation_rules`
 * predates it, so persisting a rule with trigger_type='approval.task_created' would be rejected
 * (23514). This widens the allowed set, preserving every existing value (base = the latest
 * constraint from the approval.completed migration). Pure DDL; idempotent via DROP CONSTRAINT
 * IF EXISTS.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_trigger_type`.execute(db)
  await sql`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_trigger_type
    CHECK (trigger_type IN (
      'record.created', 'record.updated', 'record.deleted',
      'field.changed', 'field.value_changed',
      'schedule.cron', 'schedule.interval', 'schedule.date_field',
      'webhook.received', 'form.submitted', 'approval.completed',
      'approval.task_created'
    ))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_trigger_type`.execute(db)
  await sql`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_trigger_type
    CHECK (trigger_type IN (
      'record.created', 'record.updated', 'record.deleted',
      'field.changed', 'field.value_changed',
      'schedule.cron', 'schedule.interval', 'schedule.date_field',
      'webhook.received', 'form.submitted', 'approval.completed'
    ))
  `.execute(db)
}
