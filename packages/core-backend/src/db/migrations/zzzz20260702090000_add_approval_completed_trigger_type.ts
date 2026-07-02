/**
 * Migration: `approval.completed` automation trigger (T1-3) — widen the trigger_type CHECK constraint.
 *
 * The approval-completion trigger (first-batch ballot 2026-07-01) is added to the application's
 * VALID_TRIGGER_TYPES (automation-service + automation-triggers). The DB CHECK constraint
 * `chk_automation_trigger_type` on `automation_rules` predates it, so persisting a rule with
 * trigger_type='approval.completed' would be rejected (23514). This widens the allowed set, preserving
 * every existing value (base = the latest constraint from the schedule.date_field migration). Pure DDL;
 * idempotent via DROP CONSTRAINT IF EXISTS. (Caught by the real-DB approval-completed-trigger integration
 * test — unit-level validation does not hit the constraint.)
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
      'webhook.received', 'form.submitted', 'approval.completed'
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
      'webhook.received', 'form.submitted'
    ))
  `.execute(db)
}
