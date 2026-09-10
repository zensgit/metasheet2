/**
 * #4196 V5: persist the first retry attempt on the lineage root before dispatch.
 *
 * Ledger absence alone cannot distinguish a genuine first retry from lost evidence. This marker is
 * independent of both Class-A and Class-B ledgers and is claimed with one compare-and-set update. Existing
 * lineages are backfilled from their first persisted retry child so a direct second retry of the root cannot
 * be misclassified as attempt one after rollout.
 */
import { sql, type Kysely } from 'kysely'

import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'multitable_automation_executions'))) return

  await sql`
    ALTER TABLE multitable_automation_executions
      ADD COLUMN IF NOT EXISTS first_retry_attempted_at TIMESTAMPTZ
  `.execute(db)

  await sql`
    UPDATE multitable_automation_executions AS root
       SET first_retry_attempted_at = prior.first_retry_attempted_at
      FROM (
        SELECT rerun_of_execution_id AS root_execution_id,
               MIN(triggered_at) AS first_retry_attempted_at
          FROM multitable_automation_executions
         WHERE rerun_of_execution_id IS NOT NULL
         GROUP BY rerun_of_execution_id
      ) AS prior
     WHERE root.id = prior.root_execution_id
       AND root.first_retry_attempted_at IS NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await checkTableExists(db, 'multitable_automation_executions'))) return
  await sql`
    ALTER TABLE multitable_automation_executions
      DROP COLUMN IF EXISTS first_retry_attempted_at
  `.execute(db)
}
