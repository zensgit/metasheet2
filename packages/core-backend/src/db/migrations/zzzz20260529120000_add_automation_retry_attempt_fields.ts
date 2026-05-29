/**
 * Migration: Add A5 whole-execution retry provenance fields to automation executions
 *
 * Purpose: A5 lets an admin re-run a failed/skipped automation execution (current
 *   enabled rule + the original stored trigger_event). The NEW execution records
 *   which run it re-ran (`rerun_of_execution_id`) and who triggered it
 *   (`initiated_by`). These are plain identifiers (an execution id / a user id),
 *   not free-form secret channels — no redaction.
 * Table: multitable_automation_executions
 * Breaking: No — both columns nullable; pre-A5 rows and normal (non-retry) runs
 *   leave them NULL.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'multitable_automation_executions')
  if (!exists) return

  await sql`
    ALTER TABLE multitable_automation_executions
      ADD COLUMN IF NOT EXISTS rerun_of_execution_id TEXT,
      ADD COLUMN IF NOT EXISTS initiated_by TEXT
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'multitable_automation_executions')
  if (!exists) return

  await sql`
    ALTER TABLE multitable_automation_executions
      DROP COLUMN IF EXISTS rerun_of_execution_id,
      DROP COLUMN IF EXISTS initiated_by
  `.execute(db)
}
