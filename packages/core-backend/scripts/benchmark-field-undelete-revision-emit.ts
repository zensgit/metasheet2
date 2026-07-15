/**
 * W0 enablement gate (owner ruling, post-merge review of #4279/#4286): real-scale benchmark for the
 * field-undelete rehydration revision-emit mechanism — OLD (per-record serial `recordRecordRevision` loop)
 * vs NEW (`recordRecordRevisionsBatch`, chunked multi-row INSERT).
 *
 * WHAT THIS MEASURES: the exact piece of `recreateFieldFromConfig` (univer-meta.ts) that changed. The
 * rehydration UPDATE (`UPDATE meta_records ... FROM meta_field_value_tombstones ... RETURNING ...`) is
 * copied HERE verbatim, byte-for-byte, from the production route — it is already a single set-based
 * statement (O(1) regardless of N) both before and after this PR, so it is NOT the bottleneck the owner
 * flagged and is run identically in both legs to keep the comparison apples-to-apples. What changed, and
 * what this benchmark isolates, is what happens to the UPDATE's `RETURNING` rows next: OLD emitted one
 * `recordRecordRevision` call per row (N sequential round trips); NEW emits them all via ONE
 * `recordRecordRevisionsBatch` call (chunked at 1000 rows/statement).
 *
 * WHY DIRECT-SEED, NOT THE FULL DELETE-FIELD HTTP ENDPOINT: `meta_field_value_tombstones.config_revision_id`
 * is deliberately NOT a foreign key (see `zzzz20260708090000_create_meta_tombstone_tables.ts`'s own
 * docstring — an FK here would block/cascade the very delete that's about to remove the referenced row).
 * That means a realistic tombstone set can be seeded directly with a manufactured revision id, without
 * paying for (and adding unrelated noise from) the full field-delete cascade. The rehydration UPDATE this
 * benchmark runs is unmodified production SQL either way.
 *
 * WHY THE SAME SEED DATA IS REUSED FOR BOTH LEGS: each leg runs inside its own `BEGIN ... ROLLBACK`
 * transaction (mirroring the real route's `poolManager.transaction()` wrapper), so the UPDATE's effects
 * (data merge + version bump) and every `meta_record_revisions` row it inserted are undone after each leg
 * — the same N pristine (field-absent) records + their tombstones can be rehydrated a second time for the
 * NEW leg. This is a fairness property, not a shortcut: it guarantees both legs race identical rows in
 * identical order, not two independently-seeded (and therefore not-quite-comparable) datasets.
 *
 * Usage: DATABASE_URL=postgresql://... pnpm --filter @metasheet/core-backend exec tsx \
 *   scripts/benchmark-field-undelete-revision-emit.ts [N]
 * N defaults to 10000; pass a smaller value (e.g. 5000) if seeding 10k is too slow in your environment.
 */
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

import { poolManager } from '../src/integration/db/connection-pool'
import { recordRecordRevision, recordRecordRevisionsBatch, type QueryFn, type RecordRevisionInput } from '../src/multitable/record-history-service'

const N = Number(process.argv[2] ?? process.env.BENCH_N ?? 10000)
const TS = Date.now()
const BASE = `bench_tfrr_${TS}`
const SHEET = `bench_sheet_tfrr_${TS}`
const FIELD = `bench_fld_tfrr_${TS}`
const SEED_CHUNK = 1000 // bulk-seed INSERT chunk size (separate from the thing being benchmarked)

type Counted = { query: QueryFn; count: () => number }

/** Wrap a raw transaction client's query into a `QueryFn` that also counts every statement issued —
 * the "statement count" half of the benchmark's report. */
function countedQuery(raw: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>): Counted {
  let n = 0
  const query: QueryFn = async (sql, params) => {
    n += 1
    return raw(sql, params)
  }
  return { query, count: () => n }
}

async function seed(): Promise<string[]> {
  const pool = poolManager.get()
  await pool.query('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'Bench Base'])
  await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, SHEET])
  await pool.query('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FIELD, SHEET, 'BenchVal', 'string', '{}', 1])

  const recordIds = Array.from({ length: N }, (_, i) => `bench_rec_${TS}_${i}`)
  const deleteRevisionId = randomUUID()

  for (let start = 0; start < N; start += SEED_CHUNK) {
    const chunk = recordIds.slice(start, start + SEED_CHUNK)

    // meta_records: id, sheet_id, data, version — 4 cols/row. Live row does NOT carry FIELD (post-field-
    // delete state) — the UPDATE's `NOT (data ? $3)` guard requires this so the rehydration has rows to touch.
    const recordParams: unknown[] = []
    const recordTuples: string[] = []
    chunk.forEach((id, i) => {
      const idx = start + i
      recordTuples.push(`($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}::jsonb, 1)`)
      recordParams.push(id, SHEET, JSON.stringify({ other: `x${idx}` }))
    })
    await poolManager.get().query(`INSERT INTO meta_records (id, sheet_id, data, version) VALUES ${recordTuples.join(', ')}`, recordParams)

    // meta_field_value_tombstones: id, sheet_id, field_id, record_id, value, reason, config_revision_id — 7 cols/row.
    const tsTuples: string[] = []
    const tsParams: unknown[] = []
    chunk.forEach((id, i) => {
      const idx = start + i
      const b = i * 6
      tsTuples.push(`($${b + 1}::uuid, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb, 'field_delete', $${b + 6}::uuid)`)
      tsParams.push(randomUUID(), SHEET, FIELD, id, JSON.stringify(`val-${idx}`), deleteRevisionId)
    })
    await poolManager.get().query(
      `INSERT INTO meta_field_value_tombstones (id, sheet_id, field_id, record_id, value, reason, config_revision_id) VALUES ${tsTuples.join(', ')}`,
      tsParams,
    )
  }
  return [deleteRevisionId]
}

/** Verbatim copy of the production rehydration UPDATE (univer-meta.ts ~6547) — see module docstring for
 * why this is copied rather than imported (it's an inline statement inside a non-exported function). */
const REHYDRATE_UPDATE_SQL = `UPDATE meta_records m
   SET data = data || jsonb_build_object($3::text, t.value),
       version = m.version + 1,
       updated_at = now()
   FROM meta_field_value_tombstones t
   WHERE m.id = t.record_id
     AND m.sheet_id = $2
     AND t.config_revision_id = $1
     AND t.field_id = $3
     AND t.reason = 'field_delete'
     AND NOT (m.data ? $3)
   RETURNING m.id, m.version, m.data, t.value AS rehydrated_value`

interface RehydratedRow { id: string; version: number; data: Record<string, unknown>; rehydrated_value: unknown }

async function runLeg(deleteRevisionId: string, mode: 'old-loop' | 'new-batch'): Promise<{ wallMs: number; statements: number; rowsRehydrated: number }> {
  const rawClient = await poolManager.get().getInternalPool().connect()
  const { query, count } = countedQuery((sql, params) => rawClient.query(sql, params) as Promise<{ rows: unknown[]; rowCount?: number | null }>)
  try {
    await query('BEGIN')
    const start = performance.now()
    const updateResult = (await query(REHYDRATE_UPDATE_SQL, [deleteRevisionId, SHEET, FIELD])) as unknown as { rows: RehydratedRow[] }
    const rows = updateResult.rows
    const recordBatchId = randomUUID()
    if (mode === 'old-loop') {
      for (const row of rows) {
        await recordRecordRevision(query, {
          sheetId: SHEET,
          recordId: String(row.id),
          version: Number(row.version) || 0,
          action: 'update',
          source: 'restore',
          actorId: 'bench-actor',
          changedFieldIds: [FIELD],
          patch: { [FIELD]: row.rehydrated_value },
          snapshot: row.data,
          batchId: recordBatchId,
        })
      }
    } else {
      const inputs: RecordRevisionInput[] = rows.map((row) => ({
        sheetId: SHEET,
        recordId: String(row.id),
        version: Number(row.version) || 0,
        action: 'update',
        source: 'restore',
        actorId: 'bench-actor',
        changedFieldIds: [FIELD],
        patch: { [FIELD]: row.rehydrated_value },
        snapshot: row.data,
        batchId: recordBatchId,
      }))
      await recordRecordRevisionsBatch(query, inputs)
    }
    const wallMs = performance.now() - start
    // ROLLBACK (not COMMIT): undoes the UPDATE + the revision inserts, so the SAME pristine seed rows
    // (still missing FIELD) are available for the next leg — see module docstring's fairness note.
    await query('ROLLBACK')
    return { wallMs, statements: count(), rowsRehydrated: rows.length }
  } catch (e) {
    await query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    rawClient.release()
  }
}

async function cleanup(): Promise<void> {
  const pool = poolManager.get()
  await pool.query('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET]).catch(() => {})
  await pool.query('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
  await pool.query('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
  await pool.query('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
  await pool.query('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
  await pool.query('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.')
    process.exit(1)
  }
  console.log(`W0 field-undelete revision-emit benchmark: N = ${N} tombstoned records`)
  console.log('Seeding...')
  const seedStart = performance.now()
  const [deleteRevisionId] = await seed()
  console.log(`Seed complete in ${(performance.now() - seedStart).toFixed(0)}ms`)

  try {
    console.log('\nRunning OLD leg (per-record serial recordRecordRevision loop)...')
    const oldResult = await runLeg(deleteRevisionId, 'old-loop')
    console.log(`  rows rehydrated: ${oldResult.rowsRehydrated}`)
    console.log(`  statements issued (incl. BEGIN/UPDATE/ROLLBACK): ${oldResult.statements}`)
    console.log(`  wall time: ${oldResult.wallMs.toFixed(1)}ms`)

    console.log('\nRunning NEW leg (recordRecordRevisionsBatch, chunked)...')
    const newResult = await runLeg(deleteRevisionId, 'new-batch')
    console.log(`  rows rehydrated: ${newResult.rowsRehydrated}`)
    console.log(`  statements issued (incl. BEGIN/UPDATE/ROLLBACK): ${newResult.statements}`)
    console.log(`  wall time: ${newResult.wallMs.toFixed(1)}ms`)

    console.log('\n=== Summary ===')
    console.log(`N = ${N}`)
    console.log(`OLD: ${oldResult.statements} statements, ${oldResult.wallMs.toFixed(1)}ms`)
    console.log(`NEW: ${newResult.statements} statements, ${newResult.wallMs.toFixed(1)}ms`)
    console.log(`statement reduction: ${(oldResult.statements / newResult.statements).toFixed(1)}x`)
    console.log(`wall-time speedup: ${(oldResult.wallMs / newResult.wallMs).toFixed(1)}x`)
  } finally {
    console.log('\nCleaning up seed data...')
    await cleanup()
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    cleanup()
      .catch(() => {})
      .finally(() => process.exit(1))
  })
