import type { QueryFn } from './permission-service'
import { assertSeqString, compareSeq, SeqComparatorError } from './history-trust-checkpoint'

/**
 * Global History — T5-1: as-of record reconstruction. TWO read primitives, PURE READ (writes nothing):
 *
 *   • {@link reconstructRecordsAtT} — as-of a WALL-CLOCK time T (`created_at <= T`). This is
 *     MANUAL-DATETIME READ-ONLY NAVIGATION only (v3.7 §9.2): a human scrubbing a time slider / the
 *     point-in-time read-only view (T7). It is DISPLAY/navigation, NOT the destructive-recovery authority —
 *     `created_at` is txn-start (same-ms events collide) and, worse, is NOT commit order, so a record whose
 *     `created_at` order disagrees with its `seq` (commit) order reconstructs to a state that was never
 *     externally visible (the C2 bug). Keep this path for navigation; NEVER anchor a destructive revert/reset on it.
 *
 *   • {@link reconstructRecordsAtSeq} — as-of an EXACT causal anchor `seq` (`seq <= anchorSeq`). W0-1 v3.7 §1.3
 *     (L6-b): the RECOVERY-AUTHORITY path. `seq` is the one shared causal `meta_record_chain_seq` domain
 *     (allocated at write time under the L4 canonical fence), so `seq <= anchorSeq` reconstructs the EXACT
 *     as-of-the-sealed-operation-endpoint state a recovery can trust. The `anchorSeq` is the immutable
 *     `endpoint_seq` of a sealed operation (L6-a) frozen into a signed identity (see `exact-anchor-recovery.ts`).
 *
 * Design-lock: docs/development/multitable-global-history-t5-restore-preview-design-lock-20260621.md (#2985),
 * PV-5; LOCK-9 + LOCK-11 (#2952); W0-1 v3.7 exact-anchor trust design-lock (#4331) §1.3/§9.2.
 */

export interface RecordStateAtT {
  recordId: string
  /** false when the record did NOT exist at T (no revision <= T, or the latest <= T revision is a delete). */
  exists: boolean
  /** the record's full data at T, or null when it did not exist at T. */
  data: Record<string, unknown> | null
  /** the version of the latest <= T revision (the version the record was at, as of T). */
  version: number | null
  /** Internal replay marker: the first trusted item was a marker, so checkpoint data/existence was inherited. */
  inheritsCheckpointBaseline?: true
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * Reconstruct each record's state as of timestamp T = the LATEST revision with `created_at <= T` under the
 * deterministic LOCK-11 order (`created_at DESC, version DESC, id DESC`). LOCK-9: if that latest revision is
 * `action='delete'`, the record did NOT exist at T (a delete revision stores the PRE-delete snapshot, so a
 * naive "latest snapshot" would resurrect deleted records) → `exists:false, data:null`. A record with no
 * revision `<= T` is absent from the result map (it was created after T).
 *
 * @param recordIds undefined → every record the sheet has a revision for; otherwise only the given ids.
 * @returns Map keyed by recordId. Callers treat an absent key the same as `exists:false`.
 */
export async function reconstructRecordsAtT(
  query: QueryFn,
  sheetId: string,
  asOfIso: string,
  recordIds?: string[],
): Promise<Map<string, RecordStateAtT>> {
  const out = new Map<string, RecordStateAtT>()
  if (!sheetId || !asOfIso) return out
  const args: unknown[] = [sheetId, asOfIso]
  let recFilter = ''
  if (recordIds) {
    if (recordIds.length === 0) return out
    args.push(recordIds)
    recFilter = `AND record_id = ANY($${args.length}::text[])`
  }
  // DISTINCT ON (record_id) + the LOCK-11 order picks exactly the latest <= T revision per record.
  const res = await query(
    `SELECT DISTINCT ON (record_id) record_id, action, snapshot, version
     FROM meta_record_revisions
     WHERE sheet_id = $1 AND created_at <= $2 ${recFilter}
     ORDER BY record_id, created_at DESC, version DESC, id DESC`,
    args,
  )
  for (const raw of res.rows as Array<Record<string, unknown>>) {
    mapReconstructedRow(out, raw)
  }
  return out
}

/**
 * Reconstruct each record's state as of an EXACT causal anchor `seq` from the shared trusted
 * revisions + version-markers timeline where `trustedSinceSeq < seq <= anchorSeq`, ordered by the
 * shared `meta_record_chain_seq` bigint (`ORDER BY record_id, seq`). This is the
 * W0-1 v3.7 §1.3 (L6-b) RECOVERY-AUTHORITY reconstruction — the state a destructive revert/reset resolves against.
 *
 * WHY seq, not created_at (the C2 fix): `seq` is allocated at write time under the L4 canonical fence, so it is
 * the exact causal order in which writes were serialized; `created_at` is txn-start (not commit order). For a
 * record whose `created_at` order disagrees with its `seq` order, the `created_at` path picks a write that was
 * never the externally-visible latest as-of the anchor (an "un-happened" state), while this seq path picks the
 * true as-of-anchorSeq state. `seq` is UNIQUE in the shared domain, so `seq DESC` alone is a total order — no
 * `version`/`id` tiebreak is needed (contrast the LOCK-11 tiebreaks the created_at path must carry).
 *
 * A marker occupies its own version but carries no payload: it inherits the nearest trusted data/existence
 * state. If the first post-floor item is a marker, the selected checkpoint baseline supplies that state while
 * the marker's version remains authoritative. DELETE-CHAIN (LOCK-9) remains unchanged: a delete stores the
 * PRE-delete snapshot but makes the state absent. SAME-GENERATION contiguity is proven separately by strict.
 *
 * EXACT BIGINT (§1.1): `anchorSeq` is a decimal-string bound straight into a `::bigint` parameter — never
 * Number()/parseInt/+/-. A non-decimal-integer `anchorSeq` FAILS CLOSED (`assertSeqString` throws) rather than
 * silently coercing; callers resolve `anchorSeq` from the immutable `endpoint_seq` of a sealed operation.
 *
 * @param anchorSeq the exact causal anchor as a decimal bigint string (the sealed operation's `endpoint_seq`).
 * @param recordIds undefined → every record with a revision `seq <= anchorSeq`; otherwise only the given ids.
 * @param trustedSinceSeq optional checkpoint trust floor; when present, pre-checkpoint/backfilled rows are excluded.
 * @param checkpointId DB-selected checkpoint used only to hydrate marker-only baseline inheritance.
 */
export async function reconstructRecordsAtSeq(
  query: QueryFn,
  sheetId: string,
  anchorSeq: string,
  recordIds?: string[],
  trustedSinceSeq?: string,
  checkpointId?: string,
): Promise<Map<string, RecordStateAtT>> {
  const out = new Map<string, RecordStateAtT>()
  if (!sheetId) return out
  assertSeqString(anchorSeq, 'reconstructRecordsAtSeq.anchorSeq') // fail-closed on a forged/garbage anchor
  const args: unknown[] = [sheetId, anchorSeq]
  let floorFilter = ''
  if (trustedSinceSeq !== undefined) {
    assertSeqString(trustedSinceSeq, 'reconstructRecordsAtSeq.trustedSinceSeq')
    if (compareSeq(trustedSinceSeq, anchorSeq) > 0) {
      throw new SeqComparatorError('reconstructRecordsAtSeq: trust floor exceeds anchor')
    }
    args.push(trustedSinceSeq)
    floorFilter = `AND seq > $${args.length}::bigint`
  }
  if (checkpointId !== undefined && trustedSinceSeq === undefined) {
    throw new SeqComparatorError('reconstructRecordsAtSeq: checkpoint requires trust floor')
  }
  let recFilter = ''
  if (recordIds) {
    if (recordIds.length === 0) return out
    args.push(recordIds)
    recFilter = `AND record_id = ANY($${args.length}::text[])`
  }
  // Revisions and markers are one exact bigint timeline. Folding in seq order makes marker inheritance explicit:
  // a marker updates only the version and cannot erase the closest trusted data/existence state.
  const rangeFilter = `sheet_id = $1 AND seq <= $2::bigint ${floorFilter} ${recFilter}`
  const res = await query(
    `SELECT record_id, action, snapshot, version, seq, 'event' AS kind
     FROM meta_record_revisions
     WHERE ${rangeFilter}
     UNION ALL
     SELECT record_id, NULL::text AS action, NULL::jsonb AS snapshot, version, seq, 'marker' AS kind
     FROM meta_record_version_markers
     WHERE ${rangeFilter}
     ORDER BY record_id, seq`,
    args,
  )
  for (const raw of res.rows as Array<Record<string, unknown>>) {
    if (raw.kind !== 'marker') {
      mapReconstructedRow(out, raw)
      continue
    }
    const recordId = String(raw.record_id)
    const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : null
    const inherited = out.get(recordId)
    out.set(recordId, inherited
      ? { ...inherited, version }
      : {
          recordId,
          exists: false,
          data: null,
          version,
          inheritsCheckpointBaseline: true,
        })
  }

  const markerOnlyIds = [...out.values()]
    .filter((state) => state.inheritsCheckpointBaseline)
    .map((state) => state.recordId)
  if (checkpointId !== undefined && markerOnlyIds.length > 0) {
    const baselineRes = await query(
      `SELECT record_id, data, is_trashed
       FROM meta_history_baselines
       WHERE checkpoint_id = $1 AND sheet_id = $2 AND record_id = ANY($3::text[])`,
      [checkpointId, sheetId, markerOnlyIds],
    )
    for (const raw of baselineRes.rows as Array<Record<string, unknown>>) {
      const recordId = String(raw.record_id)
      const state = out.get(recordId)
      if (!state?.inheritsCheckpointBaseline || typeof raw.is_trashed !== 'boolean') continue
      out.set(recordId, {
        ...state,
        exists: !raw.is_trashed,
        data: raw.is_trashed ? null : asRecord(raw.data),
      })
    }
  }
  return out
}

/**
 * Shared row → RecordStateAtT mapping for BOTH reconstruction paths (created_at and seq). LOCK-9 delete
 * awareness + the strict `version` typing: version is `number | null` — a finite numeric value stays a number;
 * anything else (null / undefined / non-numeric) becomes null, NEVER coerced to 0, so "unknown version" cannot
 * masquerade as a real version 0 for the T5-2 / T7 / T8 / recovery consumers. Check `typeof` BEFORE Number() —
 * `Number(null) === 0` would otherwise resurrect the very bug this guards against.
 */
function mapReconstructedRow(out: Map<string, RecordStateAtT>, raw: Record<string, unknown>): void {
  const recordId = String(raw.record_id)
  const deleted = raw.action === 'delete'
  out.set(recordId, {
    recordId,
    exists: !deleted,
    data: deleted ? null : asRecord(raw.snapshot),
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : null,
  })
}
