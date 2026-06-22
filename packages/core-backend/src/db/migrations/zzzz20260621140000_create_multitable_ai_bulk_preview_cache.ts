/**
 * Migration: Create the multitable AI bulk-preview run cache (B-1, §3 of
 * docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md).
 *
 * Purpose: persist ONE row per generated bulk-preview output, keyed by
 * (run_id, record_id), so a later confirm-write (B-2) reads the cached value —
 * NOT in-memory (a confirm survives a restart and is always explainable). The
 * `proposed_value` is the AI-generated text for that row's target field; the
 * row also carries the `preview_version` it was generated against (anti-TOCTOU:
 * B-2 rides this into patchRecords as expectedVersion) and the per-row usage /
 * cost actually settled into the usage ledger.
 *
 * The CHARGE for a generated row is booked in multitable_ai_usage_ledger at
 * preview time, INDEPENDENT of this cache. GC'ing an abandoned run via
 * expires_at NEVER un-charges it (design §4: charge-on-generation, never
 * released). This table is the cached-OUTPUT store, not the charge ledger.
 *
 * Structural template: multitable_ai_usage_ledger
 * (zzzz20260611090000_create_multitable_ai_usage_ledger.ts) — TEXT ids, a
 * NUMERIC(12,6) cost column, and an index supporting the cheap aging sweep.
 *
 * Never stores prompt or source text; only the single proposed target value.
 *
 * Tables: multitable_ai_bulk_preview_cache
 * Breaking: No
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const TABLE = 'multitable_ai_bulk_preview_cache'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, TABLE)
  if (!exists) {
    console.log(`[Migration] Creating table: ${TABLE}`)

    await sql`
      CREATE TABLE IF NOT EXISTS multitable_ai_bulk_preview_cache (
        run_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        sheet_id TEXT NOT NULL,
        field_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        proposed_value TEXT NOT NULL,
        usage_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (run_id, record_id)
      )
    `.execute(db)
  } else {
    console.log(`[Migration] Table ${TABLE} already exists, skipping`)
  }

  // B-2 commit reads by run_id; the aging sweep scans by expires_at.
  await sql`CREATE INDEX IF NOT EXISTS idx_mt_ai_bulk_cache_run ON multitable_ai_bulk_preview_cache (run_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_mt_ai_bulk_cache_expires ON multitable_ai_bulk_preview_cache (expires_at)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_mt_ai_bulk_cache_run`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_mt_ai_bulk_cache_expires`.execute(db)
  await sql`DROP TABLE IF EXISTS multitable_ai_bulk_preview_cache`.execute(db)
}
