/**
 * Migration: Add A1 run-governance snapshot fields to automation executions
 *
 * Purpose: Persist an execution-time snapshot (sheet, trigger event, rule
 *   snapshot, finish time, schema version) so automation runs become
 *   observable / auditable / diagnosable. Read path maps these via the C1
 *   WorkflowJob contract at the boundary (no storage status change here).
 * Table: multitable_automation_executions
 * Breaking: No — all columns nullable (or defaulted); old rows map safely.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'multitable_automation_executions')
  if (!exists) return

  await sql`
    ALTER TABLE multitable_automation_executions
      ADD COLUMN IF NOT EXISTS sheet_id TEXT,
      ADD COLUMN IF NOT EXISTS trigger_event JSONB,
      ADD COLUMN IF NOT EXISTS rule_snapshot JSONB,
      ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'multitable_automation_executions')
  if (!exists) return

  await sql`
    ALTER TABLE multitable_automation_executions
      DROP COLUMN IF EXISTS sheet_id,
      DROP COLUMN IF EXISTS trigger_event,
      DROP COLUMN IF EXISTS rule_snapshot,
      DROP COLUMN IF EXISTS finished_at,
      DROP COLUMN IF EXISTS schema_version
  `.execute(db)
}
