import { mapFieldType, isSystemFieldType } from './field-codecs'
import type { QueryFn } from './permission-service'
import { isSystemSheet } from './system-sheet'

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

/**
 * P3-1 hardening (post-ratification, same doctrine — not a live false-positive today, but the security path
 * must be closed on its own terms, not on the accident that no writer currently exercises the gap). Rule 2's
 * text is "the sheet's user-authored/writable field ids" — the four value-derivation engines above are one
 * instance of "not user-authored", not the whole class. The four SYSTEM field types (`createdTime` /
 * `modifiedTime` / `createdBy` / `modifiedBy`, `field-codecs`'s canonical `SYSTEM_FIELD_TYPES`) are equally
 * server-maintained: `isFieldAlwaysReadOnly` (`permission-derivation.ts`) already places them in the SAME
 * always-read-only bucket as formula/lookup/rollup. In today's write paths a system field's value is derived
 * purely at READ time (`query-service.ts`'s `injectSystemFieldValues`, from `created_at`/`updated_at`/
 * `created_by`/`modified_by`) and is never written into the `data` column at all — so this exclusion has no
 * observable effect on any current writer. It hardens the precheck against a FUTURE or LEGACY/imported record
 * that happens to carry a stray value under a system field id in `data`: such a value must never be able to
 * pollute-refuse a healthy record, any more than a materialized formula value can. `autoNumber` is a member of
 * both sets; the union simply dedupes it.
 */
export function isNonUserAuthoredFieldType(canonicalType: string): boolean {
  return DERIVED_FIELD_TYPES.has(canonicalType) || isSystemFieldType(canonicalType)
}

/** Raw DB `meta_fields.type` → excluded from the user-authored-field projection? Routed through the canonical
 * `mapFieldType` so raw spellings (`auto_number`, `AUTO-NUMBER`, `modified_time`, …) classify identically to
 * their canonical forms. Covers both the derived-value engines (rule 2) and the system-computed types
 * (P3-1 hardening, above). */
export function isDerivedFieldType(rawType: string): boolean {
  return isNonUserAuthoredFieldType(String(mapFieldType(String(rawType ?? ''))))
}

export type HistoryIntegrityVerdict =
  | { ok: true }
  /** Reasons are internal/log-only enums — the HTTP surface is a flat, values-free `HISTORY_INCOMPLETE`
   *  (no record ids, no counts: the refusal must not become a denied-record existence oracle). */
  | {
      ok: false
      reason:
        | 'zero_revision_live_row'
        | 'live_row_after_delete_revision'
        | 'content_mismatch'
        | 'comparator_error'
        // W0-1 (corrected) §2/§6 — strict-mode-only reasons (MULTITABLE_HISTORY_CONTIGUITY_STRICT).
        | 'generation_gap'
        | 'nonmonotonic_history'
    }

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
 * W0-1 (corrected) §7 — `MULTITABLE_HISTORY_CONTIGUITY_STRICT`, default OFF. Flag-off = byte-for-byte the
 * pre-existing #4234 content-diff precheck (zero behavior change). Flag-on = ALSO run the generation-aware
 * §2 contiguity walk + §6 monotonicity guard, additively (a sheet must pass BOTH to proceed) — the content
 * diff catches an uncaptured EDIT whose live state still disagrees with the latest snapshot; contiguity
 * catches a "healed" gap the content diff structurally cannot see (an uncaptured middle write whose LATER
 * capture already re-aligned live data with the latest snapshot) and a resurrected-but-still-gapped
 * now-deleted vintage.
 */
export function isHistoryContiguityStrictEnabled(): boolean {
  return String(process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT ?? '').trim().toLowerCase() === 'true'
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
  const contentVerdict = await checkContentDiff(query, sheetId)
  if (!contentVerdict.ok) return contentVerdict
  // W0-1 (corrected) §2/§6 — additive strict-mode check, gated so flag-off stays byte-for-byte #4234.
  if (isHistoryContiguityStrictEnabled()) {
    return checkGenerationContiguity(query, sheetId)
  }
  return contentVerdict
}

/**
 * D-1c §0.6 rules 1-4 — the pre-existing (#4234) live-vs-latest-snapshot content-diff precheck, UNCHANGED
 * in doctrine. The ONE code change from #4234: the "latest revision per record" query now excludes the
 * W0-1 lock/unlock MARKER actions (`AND action NOT IN ('lock','unlock')`). Markers ship unconditionally
 * with the migration (not flag-gated — a trusted window must exist at flag-flip), so without this
 * exclusion a record's "latest revision" could become a marker (snapshot=NULL) the FIRST time it is
 * locked/unlocked, and the content comparator would then diff live data against an EMPTY snapshot →
 * false `content_mismatch` on every locked/unlocked record. This is the precise regression this guard
 * pre-existing invariant ("lock/unlock never trips it") must not suffer from marker emission — the
 * exclusion restores it exactly, independent of the strict flag (`G-HI-2` pins this).
 */
async function checkContentDiff(query: QueryFn, sheetId: string): Promise<HistoryIntegrityVerdict> {
  const fieldsRes = await query('SELECT id, type FROM meta_fields WHERE sheet_id = $1', [sheetId])
  const userFieldIds: string[] = []
  for (const row of fieldsRes.rows as Array<{ id: unknown; type: unknown }>) {
    if (!isDerivedFieldType(String(row.type ?? ''))) userFieldIds.push(String(row.id))
  }
  const liveRes = await query('SELECT id, data FROM meta_records WHERE sheet_id = $1', [sheetId])
  const liveRows = liveRes.rows as Array<{ id: unknown; data: unknown }>
  if (liveRows.length === 0) return { ok: true }
  // Latest CONTENT-BEARING revision per record — LOCK-11 deterministic order (`created_at DESC, version
  // DESC, id DESC`), parity with `reconstructRecordsAtT` but WITHOUT the `<= T` cut: rule 2 compares live
  // data against history's most recent claim, which is T-independent. `action NOT IN ('lock','unlock')`
  // — see the function docstring above for why this exclusion is load-bearing, not cosmetic.
  const revRes = await query(
    `SELECT DISTINCT ON (record_id) record_id, action, snapshot
     FROM meta_record_revisions
     WHERE sheet_id = $1 AND action NOT IN ('lock', 'unlock')
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

interface RevisionRow {
  record_id: string
  action: string
  version: number
  created_at: string | Date
  id: string
  generation: number
}

function toEpochMs(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime()
}

/**
 * W0-1 (corrected) §2 (contiguity) + §6 (C2 monotonicity) — the generation-aware strict check. Additive to
 * (never a replacement for) `checkContentDiff` above; only reached when that already passed and the flag
 * is on. PURE READ.
 *
 * Scope: EVERY record_id this sheet has ANY revision for — live AND now-deleted alike (a deliberate
 * superset of "records live now or existing at the specific reconstruction T": T-independence keeps the
 * precheck a single, cheap, sheet-scoped read with no dependency on the caller's `asOf`, and is at least as
 * strict as a T-scoped check would be — see the PR body for this as a named, owner-facing fork). Sound only
 * from marker-emission ship-forward (§7): a retained pre-marker generation with a genuine legacy gap
 * refuses fail-closed by design, not a bug.
 *
 * §1's generation derivation (verbatim): `generation = COUNT(*) FILTER (WHERE action='create') OVER
 * (PARTITION BY record_id ORDER BY created_at, version, id ROWS UNBOUNDED PRECEDING)` — 1-based, contiguous,
 * vintage-exact. Within each (record_id, generation) group, re-sorted by (version, id) ascending (the
 * axis actually being asserted dense — see below), two independent assertions:
 *   §2 density: version must be exactly `+1` from the group's create (v1) onward, EXCEPT a `delete` may
 *     repeat the immediately preceding version (the terminal update+delete duplicate, §1). A `lock`/
 *     `unlock` marker is just another `+1` step — content-neutral, still version-consuming. Anything else
 *     (a jump, a non-delete duplicate, a decrease) is a missing/uncaptured write → `generation_gap`.
 *   §6 monotonicity: in that SAME version-ascending walk, `created_at` must be non-decreasing. `reconstruct
 *     RecordsAtT` picks "latest `created_at <= T`" — if two concurrent writers' commit order disagreed with
 *     their version-assignment order, the picked-by-time revision would not be the picked-by-version one →
 *     `nonmonotonic_history`.
 * Trailing check (this check's own addition, beyond §2's literal text, load-bearing for "remove the marker
 *   write ⇒ reds" — see PR body): for every LIVE record, its `meta_records.version` must equal the MAX
 *   version this scan found in `meta_record_revisions` for that record. A record whose captured chain ends
 *   at v1 while its live version is 3 (e.g. lock 1→2, unlock 2→3 with NO marker emitted) has an uncaptured
 *   trailing gap that the internal density walk alone cannot see (there is no "hole" among captured rows —
 *   the tip itself is simply missing).
 */
export async function checkGenerationContiguity(query: QueryFn, sheetId: string): Promise<HistoryIntegrityVerdict> {
  const sheetRes = await query('SELECT base_id, description FROM meta_sheets WHERE id = $1', [sheetId])
  const sheetRow = sheetRes.rows[0] as { base_id?: unknown; description?: unknown } | undefined
  // §3 Class B — system sheets are structurally excluded from strict contiguity BEFORE any assertion
  // (their existing revision-exempt writers bump `version` with no revision, by design).
  if (sheetRow && isSystemSheet({ baseId: typeof sheetRow.base_id === 'string' ? sheetRow.base_id : null, description: sheetRow.description })) {
    return { ok: true }
  }

  const revRes = await query(
    `SELECT record_id, action, version, created_at, id,
       COUNT(*) FILTER (WHERE action = 'create') OVER (
         PARTITION BY record_id ORDER BY created_at, version, id
         ROWS UNBOUNDED PRECEDING
       ) AS generation
     FROM meta_record_revisions
     WHERE sheet_id = $1
     ORDER BY record_id, created_at, version, id`,
    [sheetId],
  )
  const rows = revRes.rows as Array<{ record_id: unknown; action: unknown; version: unknown; created_at: unknown; id: unknown; generation: unknown }>
  if (rows.length === 0) return { ok: true }

  // Group into (record_id, generation) chunks, preserving the SQL's (record_id, created_at, version, id) order.
  const groups: RevisionRow[][] = []
  let cur: RevisionRow[] = []
  for (const raw of rows) {
    const row: RevisionRow = {
      record_id: String(raw.record_id),
      action: String(raw.action ?? ''),
      version: Number(raw.version),
      created_at: raw.created_at as string | Date,
      id: String(raw.id),
      generation: Number(raw.generation),
    }
    if (cur.length > 0 && (cur[0]!.record_id !== row.record_id || cur[0]!.generation !== row.generation)) {
      groups.push(cur)
      cur = []
    }
    cur.push(row)
  }
  if (cur.length > 0) groups.push(cur)

  // Per-record max version WITHIN ITS CURRENT (OPEN) GENERATION ONLY — never the global max across a
  // record's whole lifetime. `groups` is ordered by (record_id, generation) ascending (generation is
  // non-decreasing per record_id in the SQL's own order), so an OVERWRITE (not an accumulating max) as we
  // walk the groups in order naturally leaves each record_id keyed to its LAST (highest-generation)
  // group's max version. This is load-bearing: version RESETS to 1 on every new generation (trash-restore/
  // resurrect), so a live record's version can legitimately be LOWER than an earlier, now-closed
  // generation's terminal version — comparing against the global max would false-refuse EVERY
  // delete→restore chain (proven flaky without this fix; see the golden's own comment).
  const maxVersionByRecord = new Map<string, number>()
  for (const group of groups) {
    let groupMax = 0
    for (const row of group) if (row.version > groupMax) groupMax = row.version
    maxVersionByRecord.set(group[0]!.record_id, groupMax)
  }

  for (const group of groups) {
    // Re-sort by (version, ACTION-RANK, id) ascending — the axis §2/§6 actually walk (distinct from the
    // SQL's (created_at, version, id) grouping order, which only exists to derive `generation` per §1).
    // ACTION-RANK is load-bearing, not cosmetic: the terminal update+delete pair shares the SAME version
    // integer (§1) AND — because a delete never bumps `updated_at`/reuses the row's exact commit moment
    // in practice — can even share the SAME `created_at` down to the microsecond, leaving `id` (a random
    // uuid, uncorrelated with semantic order) as the only tiebreak. A delete must always be ordered AFTER
    // its same-version sibling (it is the terminal, closing act of the pair) — sorting those two by random
    // `id` would flip the pair's order roughly half the time and false-refuse a healthy delete→restore→
    // delete chain as a `generation_gap` (proven flaky without this rank; see the golden's own comment).
    const actionRank = (action: string): number => (action === 'delete' ? 1 : 0)
    const byVersion = [...group].sort((a, b) => {
      if (a.version !== b.version) return a.version - b.version
      const ra = actionRank(a.action), rb = actionRank(b.action)
      if (ra !== rb) return ra - rb
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    const first = byVersion[0]!
    if (first.action !== 'create' || first.version !== 1) return { ok: false, reason: 'generation_gap' }
    for (let i = 1; i < byVersion.length; i += 1) {
      const prev = byVersion[i - 1]!
      const item = byVersion[i]!
      const isDenseStep = item.version === prev.version + 1
      const isTerminalDeleteDup = item.action === 'delete' && item.version === prev.version
      if (!isDenseStep && !isTerminalDeleteDup) return { ok: false, reason: 'generation_gap' }
      if (toEpochMs(item.created_at) < toEpochMs(prev.created_at)) return { ok: false, reason: 'nonmonotonic_history' }
    }
  }

  // Trailing check: every LIVE record's version must equal the max captured version — otherwise the tip of
  // its chain is uncaptured (e.g. a lock/unlock whose marker never landed).
  const liveRes = await query('SELECT id, version FROM meta_records WHERE sheet_id = $1', [sheetId])
  for (const row of liveRes.rows as Array<{ id: unknown; version: unknown }>) {
    const id = String(row.id)
    const maxCaptured = maxVersionByRecord.get(id)
    if (maxCaptured === undefined) continue // zero-revision live rows are rule 3's job (checkContentDiff), not this check's
    if (Number(row.version) !== maxCaptured) return { ok: false, reason: 'generation_gap' }
  }

  return { ok: true }
}
