/**
 * W0-1 L4-cov follow-up (post-merge review of #4438, 2026-07-17) — the ONE shared, flag-gated
 * fence+UPDATE seam for DERIVED-value materializations into `meta_records.data`.
 *
 * Three writer sites materialize derived values with the same in-place merge UPDATE (no version
 * bump, no revision, no seq): the pure-formula engine (`formula-engine.ts recalculateRecordFromData`)
 * and the two relation-aggregation sites in `univer-meta.ts` (same-record materialization inside
 * `recalculateFormulaFields`, and the dependent-sheet fan-out inside
 * `computeDependentLookupRollupRecords`). The #4438 v2 TOCTOU fix moved the engine's write into an
 * engine-internal fenced transaction but left the two relation-agg sites on bare autocommit
 * writes — a derived value computed from PRE-recovery inputs could still land inside a recovery's
 * applying window and clobber just-recovered data. This module is the single seam all three route
 * through, so the fence discipline cannot drift apart again.
 *
 * Contract (identical to the engine-v2 pattern it generalizes):
 *  - Flag ON (`MULTITABLE_ENABLE_WRITER_FENCE`): the fence-check→UPDATE PAIR runs in its OWN short
 *    transaction so `pg_advisory_xact_lock` is held from acquisition to COMMIT. Reads stay OUTSIDE
 *    (callers compute `updates` first) — per-record independence is preserved (each record's
 *    materialization commits/rolls back on its own; the partial-progress the bulk-recompute
 *    contract depends on). A durable recovery block ⇒ `fenceWriterEntry` throws
 *    `SheetWriterBlockedError` inside the txn ⇒ rollback ⇒ ZERO write. The caller decides the
 *    tolerance posture (the engine returns null; the relation-agg sites catch, log values-free and
 *    skip the materialization + its echo).
 *  - Flag OFF (default; what unit/mock callers run under): BYTE-IDENTICAL legacy write on the
 *    CALLER-passed query — no fence, no real-pool transaction, so a mock query stays honored.
 *  - Known residual (same as engine v2, documented at the goldens): the compute READS happen
 *    outside the fenced txn — a recovery that starts AND finishes in the compute→write gap clears
 *    the block, so a stale pre-recovery-derived value can still commit. Bounded: derived-only,
 *    self-heals on the next recompute, no PIT impact (these writes are revision-exempt/no-seq).
 */
import { fenceWriterEntry, isWriterFenceEnabled } from './canonical-sheet-fence'
import { poolManager } from '../integration/db/connection-pool'

/** Minimal query shape shared by the callers' QueryFn / MultitableRecordsQueryFn aliases. */
export type DerivedMergeQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

/**
 * Merge `updates` (derived-value keys only) into one record's `data`, joining the canonical
 * per-sheet writer fence when the L4 flag is ON. Throws `SheetWriterBlockedError` (zero write)
 * when a durable recovery block is active on `sheetId`.
 */
export async function applyFencedDerivedDataMerge(
  query: DerivedMergeQueryFn,
  sheetId: string,
  recordId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  if (isWriterFenceEnabled()) {
    await poolManager.get().transaction(async ({ query: fencedQuery }) => {
      const fq = fencedQuery as unknown as DerivedMergeQueryFn
      await fenceWriterEntry(fq, sheetId)
      // lock-exempt: system derived-value materialization — no user actor (a record lock is read-only to system recompute)
      // revision-exempt: derived materialization, no version bump — pure fn of stored inputs, recomputed on next write
      await fq(
        `UPDATE meta_records SET data = data || $1::jsonb, updated_at = now() WHERE id = $2 AND sheet_id = $3`,
        [JSON.stringify(updates), recordId, sheetId],
      )
    })
  } else {
    // Flag OFF: BYTE-IDENTICAL to the pre-fence write, on the caller's query (mocks stay honored).
    // lock-exempt: system derived-value materialization — no user actor (a record lock is read-only to system recompute)
    // revision-exempt: derived materialization, no version bump — pure fn of stored inputs, recomputed on next write
    await query(
      `UPDATE meta_records SET data = data || $1::jsonb, updated_at = now() WHERE id = $2 AND sheet_id = $3`,
      [JSON.stringify(updates), recordId, sheetId],
    )
  }
}
