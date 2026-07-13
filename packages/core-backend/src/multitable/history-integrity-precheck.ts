import { mapFieldType } from './field-codecs'
import type { QueryFn } from './permission-service'

/**
 * Global History — D-1c §0.6: `HISTORY_INCOMPLETE`, the fail-closed integrity PRECHECK for the destructive
 * recovery surfaces (PIT sheet Revert-to-T + Reset-to-T, preview AND execute). RATIFIED 2026-07-13 (owner);
 * design-lock: docs/development/multitable-global-history-d1c-form-submit-edit-uncaptured-revision-design-lock-20260712.md.
 *
 * Doctrine (owner hard-lock, verbatim rules 1–4):
 *  1. UNIFIED REFUSAL — while any live record's history in the affected scope is untrustworthy, preview and
 *     execute BOTH return `HISTORY_INCOMPLETE`; no execute token is minted and zero rows are written. Preview
 *     and execute consume the SAME function (this one), so execute re-checks by construction (rule 4 / TOCTOU —
 *     the revision-derived `previewIdentity` scopeHash is structurally blind to uncaptured writes and is NOT
 *     relied on for this).
 *  2. CONTENT, NOT VERSION — the comparator diffs the live `meta_records.data` against the latest revision's
 *     `snapshot`, projected onto the sheet's USER-AUTHORED field ids only. Version-only mutations (record
 *     lock/unlock bump `version` without touching `data`) therefore never trip it, and neither does derived-field
 *     materialization: formula / rollup / lookup / auto-number engines write computed keys into `data` with no
 *     revision BY DESIGN (`formula-engine.ts` recompute, `univer-meta.ts` relation-aggregation fan-out,
 *     `auto-number-service.ts` backfill), so a full-`data` diff would refuse every healthy record on every
 *     formula sheet. The exact excluded type list is pinned below (`DERIVED_FIELD_TYPES`).
 *  3. ZERO-REVISION LIVE ROWS REFUSE — a live record with no revision at all (the uncaptured-CREATE
 *     fingerprint) is trivially inconsistent with its non-existent latest snapshot. The precheck enumerates the
 *     LIVE row set of the scope — NOT the reconstruction — because `computeSheetReset` pushes live rows absent
 *     from the reconstructed state into its delete-set, so iterating the reconstruction misses exactly the rows
 *     the reset would silently destroy.
 *  4. FAIL-CLOSED — any comparator failure refuses; there is no proceed-on-error branch. (Database errors
 *     propagate to the routes' existing non-write error mapping instead of being folded into a false
 *     `HISTORY_INCOMPLETE`; every one of those paths is also a zero-write refusal.)
 *
 * PURE READ — writes nothing. NOT a backfill (OD-5 forbids fabricating history); it refuses to act on
 * untrustworthy history, it does not repair it.
 */

/** The unified refusal code (rule 1). Routes surface it as HTTP 409 with a values-free body. */
export const HISTORY_INCOMPLETE = 'HISTORY_INCOMPLETE' as const

/**
 * D-1c §0.6 item 2 — the EXACT derived-type exclusion list, pinned from how `field-codecs` classifies value
 * types (`mapFieldType` canonical names). These four are the value engines that materialize computed keys into
 * `meta_records.data` without a revision by design; every other type (including `link` ids, which live in
 * `data` and are snapshot-captured like any cell per OD-4) is user-authored and IS compared.
 */
export const DERIVED_FIELD_TYPES: ReadonlySet<string> = new Set(['formula', 'rollup', 'lookup', 'autoNumber'])

/** Raw DB `meta_fields.type` → derived? Routed through the canonical `mapFieldType` so raw spellings
 * (`auto_number`, `AUTO-NUMBER`, …) classify identically to their canonical forms. */
export function isDerivedFieldType(rawType: string): boolean {
  return DERIVED_FIELD_TYPES.has(String(mapFieldType(String(rawType ?? ''))))
}

export type HistoryIntegrityVerdict =
  | { ok: true }
  /** Reasons are internal/log-only enums — the HTTP surface is a flat, values-free `HISTORY_INCOMPLETE`
   *  (no record ids, no counts: the refusal must not become a denied-record existence oracle). */
  | { ok: false; reason: 'zero_revision_live_row' | 'live_row_after_delete_revision' | 'content_mismatch' | 'comparator_error' }

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Canonical value equality for the projection: key-order-insensitive for nested objects, order-SENSITIVE for
 * arrays (healthy captured writers snapshot the very object they write, so ordering matches), and `null` ≡
 * absent — the same `?? null` fold the canonical restore diff (`record-restore-diff.ts` `sameValue`) already
 * uses for restorable-value equality, so the precheck cannot be stricter about emptiness than the restore
 * machinery it guards.
 */
const canonicalize = (v: unknown): string => {
  if (v === undefined || v === null) return 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`
  if (isPlainRecord(v)) {
    const keys = Object.keys(v).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/**
 * The shared §0.6 precheck. Scope = the sheet (revert/reset are whole-sheet operations, T8 D5).
 *
 * Both compute paths (`computeSheetRevert`, `computeSheetReset`) call this AFTER their cheap record-count
 * ceiling (a too-large sheet is refused 413 before any scan, precheck included) and BEFORE any diff/scope
 * work — so preview mints no token and execute writes no row once this refuses.
 */
export async function precheckSheetHistoryIntegrity(
  query: QueryFn,
  sheetId: string,
): Promise<HistoryIntegrityVerdict> {
  const fieldsRes = await query('SELECT id, type FROM meta_fields WHERE sheet_id = $1', [sheetId])
  const userFieldIds: string[] = []
  for (const row of fieldsRes.rows as Array<{ id: unknown; type: unknown }>) {
    if (!isDerivedFieldType(String(row.type ?? ''))) userFieldIds.push(String(row.id))
  }
  const liveRes = await query('SELECT id, data FROM meta_records WHERE sheet_id = $1', [sheetId])
  const liveRows = liveRes.rows as Array<{ id: unknown; data: unknown }>
  if (liveRows.length === 0) return { ok: true }
  // Latest revision per record — LOCK-11 deterministic order (`created_at DESC, version DESC, id DESC`),
  // parity with `reconstructRecordsAtT` but WITHOUT the `<= T` cut: rule 2 compares live data against
  // history's most recent claim, which is T-independent.
  const revRes = await query(
    `SELECT DISTINCT ON (record_id) record_id, action, snapshot
     FROM meta_record_revisions
     WHERE sheet_id = $1
     ORDER BY record_id, created_at DESC, version DESC, id DESC`,
    [sheetId],
  )
  const latestByRecord = new Map<string, { action: string; snapshot: unknown }>()
  for (const row of revRes.rows as Array<{ record_id: unknown; action: unknown; snapshot: unknown }>) {
    latestByRecord.set(String(row.record_id), { action: String(row.action ?? ''), snapshot: row.snapshot })
  }
  try {
    // Rule 3: iterate the LIVE rows (never the reconstruction — that misses exactly the delete-set-at-risk rows).
    for (const row of liveRows) {
      const latest = latestByRecord.get(String(row.id))
      // Zero revisions at all → the uncaptured-CREATE fingerprint → refuse.
      if (!latest) return { ok: false, reason: 'zero_revision_live_row' }
      // A LIVE row whose latest revision is a DELETE: history claims the record is dead, so
      // `reconstructRecordsAtT(now)` reports it non-existent and a Reset would push it into the delete-set
      // even when the content projection matches (a delete revision stores the PRE-delete snapshot). That is
      // the same silent-destruction class rule 3 exists for → refuse. (No captured path produces this state:
      // trash-restore and PIT-resurrect both write a fresh 'create' revision in the same transaction.)
      if (latest.action === 'delete') return { ok: false, reason: 'live_row_after_delete_revision' }
      const live = isPlainRecord(row.data) ? row.data : {}
      const snap = isPlainRecord(latest.snapshot) ? latest.snapshot : {}
      for (const fid of userFieldIds) {
        if (canonicalize(live[fid]) !== canonicalize(snap[fid])) return { ok: false, reason: 'content_mismatch' }
      }
    }
    return { ok: true }
  } catch {
    // Rule 4 fail-closed: a comparator error is a refusal, never a proceed.
    return { ok: false, reason: 'comparator_error' }
  }
}
