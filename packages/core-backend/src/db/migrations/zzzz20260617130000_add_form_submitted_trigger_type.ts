/**
 * Migration: #22 form.submitted automation trigger — widen the trigger_type CHECK constraint.
 *
 * The `form.submitted` trigger was added to the application's VALID_TRIGGER_TYPES (automation-service +
 * automation-triggers), but the DB CHECK constraint `chk_automation_trigger_type` on `automation_rules`
 * predates it — so persisting a rule with trigger_type='form.submitted' was rejected by Postgres (23514).
 * This adds 'form.submitted' to the allowed set, preserving every existing value. (Caught by the real-DB
 * form-submit-trigger integration test — the unit tests don't hit the constraint.)
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
      'schedule.cron', 'schedule.interval',
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
      'webhook.received'
    ))
  `.execute(db)
}
