import type { QueryFn } from './permission-service'

/**
 * Global History — T5-1: as-of-time-T record reconstruction (the read primitive the restore-preview (T5-2) and
 * the point-in-time read-only view (T7) both build on). PURE READ — writes nothing.
 *
 * Design-lock: docs/development/multitable-global-history-t5-restore-preview-design-lock-20260621.md (#2985),
 * PV-5. LOCK-9 + LOCK-11 from the canonical global-history design-lock (#2952).
 */

export interface RecordStateAtT {
  recordId: string
  /** false when the record did NOT exist at T (no revision <= T, or the latest <= T revision is a delete). */
  exists: boolean
  /** the record's full data at T, or null when it did not exist at T. */
  data: Record<string, unknown> | null
  /** the version of the latest <= T revision (the version the record was at, as of T). */
  version: number | null
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
 * W0-1 (corrected) §3 marker-safety: `exists`/`version` still come from the OVERALL latest `<=T` revision
 * (a lock/unlock marker is a real, later event — the record's version truly is whatever the marker left it
 * at, and a marker is never a delete so `exists` is unaffected). But `data` is NOT read off that same row —
 * a marker's `snapshot` is `NULL` by construction (content-neutral), and naively reading it here would make
 * a locked/unlocked record VANISH from PIT (`data: null` looks identical to "deleted") even though the
 * record plainly still exists with real content. `data` instead comes from the latest CONTENT-BEARING
 * (`action IN ('create','update','delete')`) revision `<= T` — the record's true content is whatever the
 * last content-bearing write left it at; a subsequent lock/unlock never changes `data`. Every record's
 * chain opens with a content-bearing `create`, so whenever the "head" join finds a row, the "content" join
 * finds one too (a marker can only exist chronologically AFTER its record's create) — the INNER JOIN below
 * never silently drops a record.
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
  // DISTINCT ON (record_id) + the LOCK-11 order picks exactly the latest <= T revision per record (`head`
  // — drives `exists`/`version`); a second CTE picks the latest CONTENT-BEARING <= T revision (`content` —
  // drives `data`, marker-safe per the docstring above). INNER JOIN is safe: `content` always has a match
  // whenever `head` does (see docstring).
  const res = await query(
    `WITH head AS (
       SELECT DISTINCT ON (record_id) record_id, action, version
       FROM meta_record_revisions
       WHERE sheet_id = $1 AND created_at <= $2 ${recFilter}
       ORDER BY record_id, created_at DESC, version DESC, id DESC
     ),
     content AS (
       SELECT DISTINCT ON (record_id) record_id, snapshot
       FROM meta_record_revisions
       WHERE sheet_id = $1 AND created_at <= $2 AND action IN ('create', 'update', 'delete') ${recFilter}
       ORDER BY record_id, created_at DESC, version DESC, id DESC
     )
     SELECT h.record_id, h.action, h.version, c.snapshot
     FROM head h
     JOIN content c ON c.record_id = h.record_id`,
    args,
  )
  for (const raw of res.rows as Array<Record<string, unknown>>) {
    const recordId = String(raw.record_id)
    const deleted = raw.action === 'delete'
    // version is `number | null` per the contract: a finite numeric value stays a number; anything else (null /
    // undefined / non-numeric) becomes null — NEVER coerced to 0, so "unknown version" cannot masquerade as a
    // real version 0 for the T5-2 / T7 / T8 consumers. Check `typeof` BEFORE Number() — `Number(null) === 0`
    // would otherwise resurrect the very bug this guards against.
    out.set(recordId, {
      recordId,
      exists: !deleted,
      data: deleted ? null : asRecord(raw.snapshot),
      version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : null,
    })
  }
  return out
}
