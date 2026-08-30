/**
 * #4196 §5/V5 — independent evidence that a retry lineage has already consumed its first retry.
 *
 * The Class-A applied ledger is retention swept, so an empty ledger is safe only for a genuinely first retry.
 * `first_retry_attempted_at` is claimed on the lineage root before dispatch. A later retry must find Class-A
 * evidence or fail closed. The partial index keeps the legacy-child check bounded during flag rollout.
 */
import { sql, type Kysely } from 'kysely'

import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'multitable_automation_executions'))) return

  await sql`
    ALTER TABLE multitable_automation_executions
      ADD COLUMN IF NOT EXISTS first_retry_attempted_at timestamptz
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_executions_rerun_parent
      ON multitable_automation_executions (rerun_of_execution_id)
      WHERE rerun_of_execution_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_action_applied_applied_at
      ON meta_automation_action_applied (applied_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'multitable_automation_executions'))) return

  await sql`DROP INDEX IF EXISTS idx_automation_action_applied_applied_at`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_automation_executions_rerun_parent`.execute(db)
  await sql`
    ALTER TABLE multitable_automation_executions
      DROP COLUMN IF EXISTS first_retry_attempted_at
  `.execute(db)
}
