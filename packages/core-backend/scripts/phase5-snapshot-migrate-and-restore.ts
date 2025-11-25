#!/usr/bin/env tsx
/**
 * Phase 5: Snapshot migrate + optional create + restore helper
 * Performs migration (idempotent), creates a snapshot if none provided, then restores it.
 * Outputs JSON result for downstream metric inspection.
 *
 * Usage examples:
 *   DATABASE_URL=postgres://user:pass@host:5432/db \
 *   npx tsx packages/core-backend/scripts/phase5-snapshot-migrate-and-restore.ts \
 *     --view view_123 --user dev-user
 *
 *   DATABASE_URL=... npx tsx packages/core-backend/scripts/phase5-snapshot-migrate-and-restore.ts \
 *     --snapshot snapshot_uuid --user dev-user
 */
import { db } from '../src/db/db'
import { up as snapshotUp } from '../src/db/migrations/20251116120000_create_snapshot_tables'
import { SnapshotService } from '../src/services/SnapshotService'

function parseArgs(argv: string[]) {
  const out: Record<string,string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    out[key] = val
  }
  return out
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set')
  if (!db) throw new Error('Database not initialized')
  const args = parseArgs(process.argv.slice(2))
  const user = args.user || 'dev-user'
  const viewId = args.view || args.viewId || ''
  let snapshotId = args.snapshot || ''

  console.log('[Phase5] Ensuring snapshot tables via migration...')
  await snapshotUp(db)
  console.log('[Phase5] Migration complete (idempotent)')

  const svc = new SnapshotService()

  // Create snapshot if not passed
  if (!snapshotId) {
    if (!viewId) throw new Error('Missing --view when no --snapshot provided')
    console.log(`[Phase5] Creating snapshot for view ${viewId} ...`) 
    const snap = await svc.createSnapshot({
      viewId,
      name: `phase5_dev_${Date.now()}`,
      description: 'Phase5 auto snapshot',
      createdBy: user,
      snapshotType: 'manual'
    })
    snapshotId = snap.id
    console.log(`[Phase5] Created snapshot ${snapshotId}`)
  } else {
    console.log(`[Phase5] Using existing snapshot ${snapshotId}`)
  }

  // Restore
  console.log(`[Phase5] Restoring snapshot ${snapshotId} ...`)
  const result = await svc.restoreSnapshot({ snapshotId, restoredBy: user })
  console.log(`[Phase5] Restore complete: success=${result.success} items=${result.itemsRestored} duration=${result.duration.toFixed(3)}s`)

  // Emit JSON for tooling/metrics check
  const out = { ok: true, snapshotId, viewId: viewId || null, user, restore: result }
  console.log(JSON.stringify(out, null, 2))
}

main().catch(err => { console.error('[Phase5] ERROR:', err); process.exit(1) })

