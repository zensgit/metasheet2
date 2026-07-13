import type { QueryFn } from './permission-service'
import { isDerivedFieldType } from './field-codecs'
import { canonicalSameLinkSet } from './record-restore-diff'

/**
 * D-1c §0.6 — the `HISTORY_INCOMPLETE` fail-closed integrity precheck (owner hard-lock).
 *
 * Design-lock: docs/development/multitable-global-history-d1c-form-submit-edit-uncaptured-revision-design-lock-20260712.md
 * §0.6. OD-5 forbids repairing already-polluted rows (no speculative backfill); this precheck is the fail-closed
 * counterpart — while a record's history is untrustworthy, no destructive PIT-Revert/Reset may act on it.
 *
 * The shared function BOTH `computeSheetRevert` and `computeSheetReset` call, at the top of their own
 * computation — each of those is already the single function preview AND execute both invoke (execute
 * RE-ENUMERATES from scratch, never trusts a cached preview result), so calling this here means the precheck
 * runs fresh on every preview AND every execute (item 4 — the TOCTOU re-check falls out structurally, not by
 * a separate wiring point).
 *
 * Two rules, both owner-verbatim (§0.6 items 2 and 3):
 *  1. Zero-revision live row ⇒ `HISTORY_INCOMPLETE`. A live record with NO revision at all (the
 *     uncaptured-CREATE fingerprint) has no snapshot to compare — trivially inconsistent with its
 *     (non-existent) latest revision. This is why the query below ENUMERATES THE LIVE ROW SET
 *     (`FROM meta_records`), not the reconstructed-at-T set: a precheck that iterated only the reconstruction
 *     would never see a zero-revision row, and `computeSheetReset` pushes exactly those rows into its
 *     delete-set (silent, irrecoverable delete — the exact harm this precheck exists to prevent).
 *  2. Content mismatch on USER-AUTHORED fields ⇒ `HISTORY_INCOMPLETE`. Live `data`, projected onto the
 *     sheet's non-derived field ids, must equal the record's own LATEST revision snapshot (irrespective of
 *     any requested PIT `asOf` — this is a general trustworthiness check, not a "does it match T" check),
 *     projected the same way. `version`-only drift (lock/unlock bumps version without touching `data`) does
 *     NOT trip this — the comparison never reads `version`. `link` fields are user-authored (OD-4 — link ids
 *     are ordinary `data`) but compare as an ORDER-INSENSITIVE id SET (`canonicalSameLinkSet`, the same
 *     comparator `computeRecordRestoreDiff` uses for links) — a raw value-equality check would false-positive
 *     on a healthy record whose live/snapshot link array merely differs in element order or string-vs-array
 *     representation, which is exactly the link-shaped analogue of the G-HI-3 formula false-positive this
 *     precheck's projection already guards against.
 */

export interface HistoryIncompletePollutedRecord {
  recordId: string
  reason: 'no_revision' | 'content_mismatch'
}

export interface HistoryIntegrityResult {
  historyIncomplete: boolean
  polluted: HistoryIncompletePollutedRecord[]
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

// Same value-equality convention as the canonical restore-diff comparator (record-restore-diff.ts's
// `sameValue`) — `undefined`/absent-key and JSON `null` are treated as the same "no value", so a field
// present in one side and entirely absent from the other still compares correctly.
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Runs the §0.6 precheck for one sheet. Self-contained (its own two queries) so it is trivially callable —
 * and real-DB-testable — in isolation, independent of whatever else `computeSheetRevert`/`computeSheetReset`
 * happen to have already loaded.
 *
 * @param normalizeLinkIds the caller's canonical link-id parser (injected, not imported — this codebase keeps
 *   one copy per call-site to avoid a route↔helper import cycle; `record-restore-diff.ts`'s
 *   `computeRecordRestoreDiff` takes the identical parameter for the identical reason. Callers pass the SAME
 *   parser they use everywhere else so a link value's canonical shape agrees across every comparison.)
 */
export async function checkSheetHistoryIntegrity(
  query: QueryFn,
  sheetId: string,
  normalizeLinkIds: (value: unknown) => string[],
): Promise<HistoryIntegrityResult> {
  const fieldRows = (await query('SELECT id, type FROM meta_fields WHERE sheet_id = $1', [sheetId])).rows as Array<{
    id: unknown
    type: unknown
  }>
  const userAuthoredFields = fieldRows
    .filter((f) => !isDerivedFieldType(String(f.type ?? '')))
    .map((f) => ({ id: String(f.id), type: String(f.type ?? '') }))

  // Enumerate the LIVE row set (`meta_records`), LEFT JOIN LATERAL each record's own latest revision by the
  // same deterministic order `reconstructRecordsAtT` uses (LOCK-11: created_at DESC, version DESC, id DESC) —
  // but with NO `created_at <= T` bound, because this is "is this record's history trustworthy at all", not
  // "what did it look like at T". `rev_found` distinguishes "no revision row at all" from "a revision row
  // exists but its own snapshot column happens to be SQL NULL" (the schema allows `snapshot` to be nullable) —
  // only the former is the zero-revision case; the latter still enumerates and inevitably content-mismatches
  // (fail-closed), which is the correct, conservative outcome for admittedly pathological data.
  const rows = (await query(
    `SELECT mr.id AS record_id, mr.data AS live_data, rev.snapshot AS latest_snapshot, rev.found AS rev_found
       FROM meta_records mr
       LEFT JOIN LATERAL (
         SELECT 1 AS found, r.snapshot
           FROM meta_record_revisions r
          WHERE r.sheet_id = $1 AND r.record_id = mr.id
          ORDER BY r.created_at DESC, r.version DESC, r.id DESC
          LIMIT 1
       ) rev ON true
      WHERE mr.sheet_id = $1`,
    [sheetId],
  )).rows as Array<{ record_id: unknown; live_data: unknown; latest_snapshot: unknown; rev_found: unknown }>

  const polluted: HistoryIncompletePollutedRecord[] = []
  for (const row of rows) {
    const recordId = String(row.record_id)
    if (row.rev_found !== 1) {
      // Item 3: no revision at all — the uncaptured-CREATE fingerprint.
      polluted.push({ recordId, reason: 'no_revision' })
      continue
    }
    const liveData = asRecord(row.live_data)
    const snapshotData = asRecord(row.latest_snapshot)
    let mismatched = false
    for (const field of userAuthoredFields) {
      const same = field.type === 'link'
        ? canonicalSameLinkSet(normalizeLinkIds(liveData[field.id]), normalizeLinkIds(snapshotData[field.id]))
        : sameValue(liveData[field.id], snapshotData[field.id])
      if (!same) {
        mismatched = true
        break
      }
    }
    if (mismatched) polluted.push({ recordId, reason: 'content_mismatch' })
  }
  return { historyIncomplete: polluted.length > 0, polluted }
}
