#!/usr/bin/env tsx
/**
 * Phase 5: Snapshot Migration Runner (dev helper)
 * Ensures snapshot tables (snapshots, snapshot_items, snapshot_restore_log) exist.
 * Usage:
 *   DATABASE_URL=postgres://user:pass@host:5432/db \
 *   npx tsx packages/core-backend/scripts/run-snapshot-migration.ts
 */
import { db } from '../src/db/db'
import { up as snapshotUp } from '../src/db/migrations/20251116120000_create_snapshot_tables'

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set')
  }
  if (!db) throw new Error('Database not initialized')
  console.log('[Phase5] Running snapshot migration...')
  await snapshotUp(db)
  console.log('[Phase5] Snapshot migration complete.')
}

main().catch(err => { console.error('[Phase5] Migration failed:', err); process.exit(1) })

