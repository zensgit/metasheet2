/**
 * Migration: A6-2 suspend/resume — durable suspension state (admin-gated v1)
 *
 * Purpose: a `wait_for_callback` action in an opted-in rule
 *   (`automation_rules.execution_mode = 'workflow_job_v1'`) suspends the execution;
 *   this table persists exactly what an admin resume needs to re-enter at the next
 *   step — keyed by a single-use `resume_token`. The suspended state itself is
 *   tracked OUT-OF-BAND (design D2): the legacy execution stays `running`; the C1
 *   `multitable_automation_jobs` wait row carries `status='suspended'`. This table
 *   holds the resume capability (token) + the re-derive inputs, never unredacted
 *   record data (the stored `trigger_event` is A1-redacted, like the execution row).
 * Tables: multitable_automation_suspensions (new)
 * Breaking: No — new table only.
 *
 * See docs/development/multitable-automation-a6-2-suspend-resume-design-20260603.md
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'multitable_automation_suspensions')
  if (exists) return

  await sql`
    CREATE TABLE IF NOT EXISTS multitable_automation_suspensions (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      sheet_id TEXT,
      record_id TEXT,
      -- Resume continues AFTER this action index (the wait_for_callback step).
      step_index INTEGER NOT NULL,
      -- Single-use capability nonce presented to resume (D5 admin-gated; D8 single-use).
      resume_token TEXT NOT NULL UNIQUE,
      -- v1: always 'external_event' (delay/manual_task are red-lined out).
      reason TEXT NOT NULL,
      -- D4b rule-drift guard: { count, hash } of the suspend-time action types.
      action_fingerprint JSONB NOT NULL,
      -- A1-redacted trigger event (re-derive uses current rule + re-fetched record; this only
      -- supplies fields not on the record). Never unredacted recordData (no new secret plane).
      trigger_event JSONB,
      -- pending → resumed | cancelled. The transactional claim flips pending→resumed (D8).
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resumed_at TIMESTAMPTZ
    )
  `.execute(db)

  // Resume looks the row up by token (UNIQUE already indexes it); detail reads by execution.
  await sql`CREATE INDEX IF NOT EXISTS idx_mt_auto_suspensions_execution_id ON multitable_automation_suspensions (execution_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS multitable_automation_suspensions`.execute(db)
}
