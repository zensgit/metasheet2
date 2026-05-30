/**
 * Migration: A6-1 persistent WorkflowJob runtime — opt-in linear job plane
 *
 * Purpose: persist one C1-shaped job row per automation action for explicitly
 *   opted-in rules (`automation_rules.execution_mode = 'workflow_job_v1'`), while
 *   existing rules stay on the legacy `multitable_automation_executions.steps`
 *   path by default. Jobs are an ADDITIVE detail plane; A2 detail prefers them
 *   when present and falls back to legacy steps.
 * Tables: multitable_automation_jobs (new); automation_rules (+ execution_mode)
 * Breaking: No — new table; execution_mode nullable (NULL = legacy).
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const jobsExists = await checkTableExists(db, 'multitable_automation_jobs')
  if (!jobsExists) {
    await sql`
      CREATE TABLE IF NOT EXISTS multitable_automation_jobs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        sheet_id TEXT,
        step_index INTEGER NOT NULL,
        step_key TEXT NOT NULL,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL,
        upstream_job_id TEXT,
        result JSONB,
        error TEXT,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        duration_ms INTEGER,
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db)
    // A2 detail reads jobs by execution_id (scout: index required).
    await sql`CREATE INDEX IF NOT EXISTS idx_mt_auto_jobs_execution_id ON multitable_automation_jobs (execution_id)`.execute(db)
  }

  const rulesExists = await checkTableExists(db, 'automation_rules')
  if (rulesExists) {
    // Opt-in flag — NULL/'legacy' = current path (no job rows); 'workflow_job_v1' = write jobs.
    await sql`ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS execution_mode TEXT`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS multitable_automation_jobs`.execute(db)
  const rulesExists = await checkTableExists(db, 'automation_rules')
  if (rulesExists) {
    await sql`ALTER TABLE automation_rules DROP COLUMN IF EXISTS execution_mode`.execute(db)
  }
}
