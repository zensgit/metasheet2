/**
 * Migration: `integration.run_finished` automation trigger (R-69 1c; ADR adr-automation-pipeline-bridge-20261103
 * §2 ⑧ / Bridge 2; design baseline v2.3 §10.2.4 1c row) — widen the trigger_type CHECK constraint.
 *
 * Pure DDL, additive; the same shape as zzzz20260705140000_add_approval_task_created_trigger_type.ts (base = that
 * migration's set). R-69 is OPEN: the trigger is dry-run only and its dispatch is gated by the default-OFF
 * INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED; this migration only lets the row exist.
 *
 * down() restores the prior set. It REFUSES while any rule still carries the new type (re-adding the narrower
 * CHECK would fail on those rows anyway, with a less legible error): a deployment that never saved such a rule
 * rolls back cleanly; one that did must delete or retype those rules first (ADR §8: the rollback is the switch,
 * not this migration).
 */
import { sql, type Kysely } from 'kysely'

export const AUTOMATION_TRIGGER_TYPES_BEFORE_INTEGRATION_RUN_FINISHED = [
  'record.created', 'record.updated', 'record.deleted',
  'field.changed', 'field.value_changed',
  'schedule.cron', 'schedule.interval', 'schedule.date_field',
  'webhook.received', 'form.submitted', 'approval.completed',
  'approval.task_created',
] as const

export const AUTOMATION_TRIGGER_TYPES_WITH_INTEGRATION_RUN_FINISHED = [
  ...AUTOMATION_TRIGGER_TYPES_BEFORE_INTEGRATION_RUN_FINISHED,
  'integration.run_finished',
] as const

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_trigger_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_trigger_type
    CHECK (trigger_type IN (${quoted(AUTOMATION_TRIGGER_TYPES_WITH_INTEGRATION_RUN_FINISHED)}))
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const remaining = await sql<{ count: number }>`
    SELECT COUNT(*)::int AS count FROM automation_rules WHERE trigger_type = 'integration.run_finished'
  `.execute(db)
  const count = Number(remaining.rows[0]?.count ?? 0)
  if (count > 0) {
    throw new Error(
      `zzzz20261106111500 down: ${count} automation rule(s) still use trigger_type 'integration.run_finished'; delete or retype them before rolling back`,
    )
  }
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_trigger_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_trigger_type
    CHECK (trigger_type IN (${quoted(AUTOMATION_TRIGGER_TYPES_BEFORE_INTEGRATION_RUN_FINISHED)}))
  `).execute(db)
}
