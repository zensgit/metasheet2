/**
 * Migration: Create the multitable AI usage ledger (A2 §2.5)
 *
 * Purpose: persist per-attempt AI shortcut usage (tokens / 估算 cost / status)
 * for quota enforcement (Q-1/Q-2 per-user tokens, Q-4 instance USD) and audit.
 * Structural template: multitable_automation_executions
 * (zzzz20260414100001_create_automation_executions_and_dashboard_charts.ts).
 *
 * Never stores prompt or completion text; `error` is redacted before insert
 * (services/ai-usage-ledger.ts). Retention/aging is a DELETE policy (NOT a
 * schema change) shipped in ladder #9: sweepAiUsageLedgerRetention +
 * LedgerRetentionScheduler delete rows past the retention window (default 90d,
 * env-overridable, floored at 7d so a sweep never crosses a quota window). The
 * (occurred_at DESC) index keeps that sweep cheap (NiFi benchmark #1880 GAP).
 *
 * Tables: multitable_ai_usage_ledger
 * Breaking: No
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const TABLE = 'multitable_ai_usage_ledger'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, TABLE)
  if (!exists) {
    console.log(`[Migration] Creating table: ${TABLE}`)

    await sql`
      CREATE TABLE IF NOT EXISTS multitable_ai_usage_ledger (
        id TEXT PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        subject_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        sheet_id TEXT NOT NULL,
        field_id TEXT,
        record_id TEXT,
        action TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        error TEXT
      )
    `.execute(db)
  } else {
    console.log(`[Migration] Table ${TABLE} already exists, skipping`)
  }

  // Quota aggregation path: (subject_key, occurred_at); audit/archival path: (occurred_at DESC).
  await sql`CREATE INDEX IF NOT EXISTS idx_mt_ai_usage_subject_occurred ON multitable_ai_usage_ledger (subject_key, occurred_at)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_mt_ai_usage_occurred_desc ON multitable_ai_usage_ledger (occurred_at DESC)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_mt_ai_usage_subject_occurred`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_mt_ai_usage_occurred_desc`.execute(db)
  await sql`DROP TABLE IF EXISTS multitable_ai_usage_ledger`.execute(db)
}
