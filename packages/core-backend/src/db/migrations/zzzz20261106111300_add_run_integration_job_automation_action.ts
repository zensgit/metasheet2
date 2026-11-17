/**
 * Migration: `run_integration_job` automation action (R-69 1b-ii; ADR adr-automation-pipeline-bridge-20261103
 * §2 ⑧ / Bridge 1) — widen the action_type CHECK constraint. Pure DDL; idempotent; the same shape as
 * zzzz20260720120000_add_write_approval_form_values_automation_action.ts. R-69 is OPEN: the action is dry-run
 * only and save-gated by the default-OFF INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED; this migration only lets
 * the row exist once that gate is open. down() restores the prior set (a rule carrying the new type would then
 * violate the CHECK — rollback is a no-op on a deployment where the switch was never on, ADR §8).
 */
import { sql, type Kysely } from 'kysely'
import { AUTOMATION_ACTION_TYPES_WITH_FWB } from './zzzz20260720120000_add_write_approval_form_values_automation_action'

export const AUTOMATION_ACTION_TYPES_BEFORE_RUN_INTEGRATION_JOB = [...AUTOMATION_ACTION_TYPES_WITH_FWB] as const

export const AUTOMATION_ACTION_TYPES_WITH_RUN_INTEGRATION_JOB = [
  ...AUTOMATION_ACTION_TYPES_BEFORE_RUN_INTEGRATION_JOB,
  'run_integration_job',
] as const

function quoted(actions: readonly string[]): string {
  return actions.map((action) => `'${action}'`).join(', ')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (${quoted(AUTOMATION_ACTION_TYPES_WITH_RUN_INTEGRATION_JOB)}))
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS chk_automation_action_type`.execute(db)
  await sql.raw(`
    ALTER TABLE automation_rules
    ADD CONSTRAINT chk_automation_action_type
    CHECK (action_type IN (${quoted(AUTOMATION_ACTION_TYPES_BEFORE_RUN_INTEGRATION_JOB)}))
  `).execute(db)
}
