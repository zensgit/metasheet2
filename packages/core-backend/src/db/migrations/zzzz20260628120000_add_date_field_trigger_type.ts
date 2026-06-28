/**
 * Migration: `schedule.date_field` automation trigger — widen the trigger_type CHECK constraint.
 *
 * The date-reminder trigger (fire N days before/after a record's date field) is added to the application's
 * VALID_TRIGGER_TYPES (automation-service + automation-triggers). The DB CHECK constraint
 * `chk_automation_trigger_type` on `automation_rules` predates it, so persisting a rule with
 * trigger_type='schedule.date_field' would be rejected (23514). This widens the allowed set, preserving every
 * existing value (base = the latest constraint from #22 form.submitted, which carries both the legacy
 * `field.changed` and `field.value_changed`). Pure DDL; idempotent via DROP CONSTRAINT IF EXISTS.
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
      'webhook.received', 'form.submitted'
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
      'schedule.cron', 'schedule.interval',
      'webhook.received', 'form.submitted'
    ))
  `.execute(db)
}
