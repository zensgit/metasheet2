/**
 * Migration: Create automation execution logs and dashboard/chart tables
 *
 * Purpose: Persist automation execution logs, chart configs, and dashboard configs to PostgreSQL
 * Tables: multitable_automation_executions, multitable_charts, multitable_dashboards
 * Breaking: No
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── multitable_automation_executions ────────────────────────────────────
  const execExists = await checkTableExists(db, 'multitable_automation_executions')
  if (!execExists) {
    console.log('[Migration] Creating table: multitable_automation_executions')

    await sql`
      CREATE TABLE IF NOT EXISTS multitable_automation_executions (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        triggered_by TEXT NOT NULL DEFAULT 'event',
        triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'running',
        steps JSONB NOT NULL DEFAULT '[]'::jsonb,
        error TEXT,
        duration INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db)

    await sql`CREATE INDEX IF NOT EXISTS idx_mt_auto_exec_rule_id ON multitable_automation_executions (rule_id)`.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_mt_auto_exec_status ON multitable_automation_executions (status)`.execute(db)
    await sql`CREATE INDEX IF NOT EXISTS idx_mt_auto_exec_created_at ON multitable_automation_executions (created_at DESC)`.execute(db)
  } else {
    console.log('[Migration] Table multitable_automation_executions already exists, skipping')
  }

  // ── multitable_charts ──────────────────────────────────────────────────
  const chartsExists = await checkTableExists(db, 'multitable_charts')
  if (!chartsExists) {
    console.log('[Migration] Creating table: multitable_charts')

    await sql`
      CREATE TABLE IF NOT EXISTS multitable_charts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        sheet_id TEXT NOT NULL,
        view_id TEXT,
        data_source JSONB NOT NULL DEFAULT '{}'::jsonb,
        display JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db)

    await sql`CREATE INDEX IF NOT EXISTS idx_mt_charts_sheet_id ON multitable_charts (sheet_id)`.execute(db)
  } else {
    console.log('[Migration] Table multitable_charts already exists, skipping')
  }

  // ── multitable_dashboards ──────────────────────────────────────────────
  const dashExists = await checkTableExists(db, 'multitable_dashboards')
  if (!dashExists) {
    console.log('[Migration] Creating table: multitable_dashboards')

    await sql`
      CREATE TABLE IF NOT EXISTS multitable_dashboards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sheet_id TEXT NOT NULL,
        panels JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db)

    await sql`CREATE INDEX IF NOT EXISTS idx_mt_dashboards_sheet_id ON multitable_dashboards (sheet_id)`.execute(db)
  } else {
    console.log('[Migration] Table multitable_dashboards already exists, skipping')
  }

  console.log('[Migration] Migration completed successfully')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  console.log('[Migration] Rolling back: dropping multitable_automation_executions, multitable_charts, multitable_dashboards')

  await db.schema.dropTable('multitable_automation_executions').ifExists().execute()
  await db.schema.dropTable('multitable_charts').ifExists().execute()
  await db.schema.dropTable('multitable_dashboards').ifExists().execute()

  console.log('[Migration] Rollback completed successfully')
}
