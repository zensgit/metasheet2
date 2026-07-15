import { mapFieldType, isSystemFieldType } from './field-codecs'
import type { QueryFn } from './permission-service'
import { isSystemSheet } from './system-sheet-predicate'
import { hasVersionMarkerTable, hasChainSeqColumn } from './record-history-service'

/**
 * Global History — W0-1: `HISTORY_INCOMPLETE`, the fail-closed integrity PRECHECK for the destructive
 * recovery surfaces (PIT sheet Revert-to-T + Reset-to-T, preview AND execute). The owner-directed
 * correction of D-1c §0.6 (design lock:
 * docs/development/multitable-global-history-w0-1-history-incomplete-contiguity-trusted-since-design-lock-20260713.md,
 * §6 owner ruling 2026-07-14).
 *
 * WHAT CHANGED vs #4234 (the superseded live-vs-latest comparator): the PRIMARY integrity proof is now a
 * GENERATION-AWARE CONTIGUITY proof, not a live-vs-latest content diff. #4234 compared the live `data`
 * against the LATEST revision snapshot; a record at version 3 with revisions only {v1, v3} (v2 an
 * uncaptured mid-chain write) has live == v3, so #4234 PASSED it — but revert/reset to a T inside (v1, v3)
 * reconstructs the wrong (v1) snapshot. Contiguity proves that EVERY version in [1..liveVersion] is
 * accounted for by exactly one chain event (a create/update revision OR a legitimate lock/unlock marker);
 * a version with no chain event = an uncaptured data write = a HOLE = HISTORY_INCOMPLETE.
 *
 * The pre-existing live-vs-latest content-projection is RETAINED as the design-lock §1.3 SECOND layer
 * (contiguity proves the chain is complete; the content projection proves live == the latest captured
 * content), so no coverage from #4234 is lost. Contiguity is the load-bearing new proof.
 *
 * Doctrine (owner hard-lock, verbatim rules 1–4, unchanged):
 *  1. UNIFIED REFUSAL — while any live record's history in the affected scope is untrustworthy, preview and
 *     execute BOTH return `HISTORY_INCOMPLETE`; no execute token is minted and zero rows are written.
 *  2. GENERATION-AWARE, NOT COUNT — the criterion is an EXACT SET (C5): exactly one canonical chain event
 *     per expected version. It is NOT `count(distinct version) < live.version` and NOT `count(*) == version`,
 *     because a DELETE revision legally REUSES the last live version (so both counts are ambiguous). Delete
 *     revisions are excluded from the per-version occupant count; a delete that is the latest event on a
 *     LIVE row, or beyond the live version, refuses.
 *  3. SYSTEM SHEETS EXCLUDED — approval-projection / people-directory sheets are server-regenerated read
 *     models (`isSystemSheet`); they legitimately carry non-contiguous history and are skipped entirely.
 *  4. FAIL-CLOSED — any comparator failure refuses; there is no proceed-on-error branch.
 *
 * C8 (same-txn) + C4 (fence): the EXECUTE path re-runs this precheck INSIDE the destructive transaction,
 * after a per-sheet `pg_advisory_xact_lock` fence (see `routes/univer-meta.ts` reset-execute), so check and
 * write are atomic against a phantom insert landing between the preview/compute check and the write.
 *
 * PURE READ — writes nothing. NOT a backfill; it refuses to act on untrustworthy history.
 *
 * DEFERRED (docketed, must not be masked by this guard going green — design lock §6.3):
 *  - `recreateFieldFromConfig` (univer-meta.ts) content-integrity gap — owner-ruled MUST-WRITE, own rung.
 *  - C2 time-monotonicity (version-ascending/time-descending under concurrency can pick the wrong T-snapshot).
 *  - C3 deleted/tombstoned + resurrected (multi-generation) chains — live-only enumeration here; a resurrected
 *    record refuses fail-closed (duplicate create at v1), full handling is C3.
 *  - C6 durable trusted-since watermark + rollout protocol (grandfathers pre-marker lock holes).
 *
 * ============================================================================================================
 * W0-1 v3.7 (owner-ratified #4331 §9, docs/development/multitable-w0-1-v37-exact-anchor-trust-design-lock-
 * 20260715.md) — STRICT MODE, `MULTITABLE_HISTORY_CONTIGUITY_STRICT` (default OFF; flag-off is BYTE-IDENTICAL
 * to the #4269 behavior documented above — unchanged code path, unchanged exports, unchanged early-return
 * shortcuts). When the flag is on, `precheckSheetHistoryIntegrity` delegates ENTIRELY to
 * `precheckSheetHistoryIntegrityStrict` (a separate function — the non-strict function body above is never
 * touched by this addition), which differs in four ways:
 *
 *  1. EXACT CAUSAL ORDER (§1.1): events and markers are ordered by the real `seq` column — one shared PG
 *     sequence across BOTH tables (migration `zzzz20260715160000_add_meta_record_chain_seq`) — never
 *     `created_at`/`version`. Ordering is done by native SQL `ORDER BY` on the `bigint` column; `seq` is kept
 *     as a decimal STRING end-to-end in TypeScript (the pg driver returns int8 as a string, never a `number`,
 *     by default). `Number(seq)`, `parseInt`, unary `+`, subtraction comparators, and JSON-number seq fields
 *     are FORBIDDEN (§9.7) — every seq-vs-seq comparison in this module uses exact `BigInt(...)` compare or
 *     exact string equality, never float arithmetic. See `checkAllGenerationsContiguity`'s seq-ascending scan.
 *  2. GENERATION BY COUNT (§4): `generation = COUNT(*) FILTER (WHERE action='create') OVER (PARTITION BY
 *     sheet_id, record_id ORDER BY seq)` — computed here as a simple running counter over the seq-ordered
 *     per-record timeline (the counter only depends on which items are 'create' events, never on seq
 *     magnitude, so it carries no float-precision risk).
 *  3. ALL GENERATIONS, NOT TERMINAL-ONLY (§4/§9.3 owner High-2 — corrects the superseded v3.5 draft #4309,
 *     which validated only the current/terminal generation): `checkAllGenerationsContiguity` walks EVERY
 *     generation in a record's timeline and refuses on the FIRST hole/duplicate found anywhere, not only in
 *     the newest one. A record with a hole in an OLDER generation and a clean terminal generation still
 *     refuses — "terminal-generation-only validation is forbidden" (§4, verbatim). This lane implements the
 *     conservative "all generations reconstructable in scope" option v3.7 §9.3 explicitly permits in place of
 *     resolving an exact target/asOf generation (§1.3's exact anchor resolution is L6, DEFERRED); checking
 *     every generation is strictly stronger than checking only the one the recovery target would fall in.
 *  4. C3 DELETED-CHAIN ENUMERATION (§4/§9.3 scope item 5): records that are not live (chain-only, or present
 *     in `meta_records_trash`) are ALSO enumerated and validated (their scope requires the timeline's last
 *     item to be a delete; a trash row surviving with its ENTIRE revision chain retention-swept is
 *     unverifiable and fails closed, `chain_hole`).
 *
 * `chain_corrupt` is a NEW reason (strict-only, never returned when the flag is off) for a within-generation
 * duplicate occupant — it replaces the DROPPED cross-generation marker `UNIQUE` constraint's job, which used
 * to reject this shape at write time; now the seq-ordered occupancy walk rejects it at read time instead.
 * `comparator_error` also covers illegal seq (non-positive, malformed, or a duplicate seq value shared by two
 * items — a shared-sequence-domain violation) — fail-closed, never coerced to zero (§9.3 scope item 6).
 *
 * STILL DEFERRED beyond this lane (unchanged from the list above, plus the v3.7-specific items): §1.2 sealed
 * operation-endpoint ledger (L6), §1.3 exact recovery anchor / resolving a target generation from a real
 * commit boundary (L6), the L4 all-writer canonical fence, the L5 trust checkpoint. C2 time-monotonicity
 * (seq-vs-version agreement within a generation) is NOT added by this lane either — it remains on the
 * pre-existing DEFERRED docket above; this lane's scope is the exact-bigint + all-generations + C3 + dup/
 * illegal-seq fail-close set (v3.7 §9.3), not the full W0 trust correction.
 * ============================================================================================================
 */

/** W0-1 v3.7 §9.3 — the STRICT MODE gate. Default OFF (unset/any non-'true' value): flag-off behavior is the
 *  byte-identical #4269 code path. See the module doc comment's STRICT MODE section for the full contract. */
export function isContiguityStrictMode(): boolean {
  return String(process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT ?? '').trim().toLowerCase() === 'true'
}

/** The unified refusal code (rule 1). Routes surface it as HTTP 409 with a values-free body. */
export const HISTORY_INCOMPLETE = 'HISTORY_INCOMPLETE' as const

/** C8 in-txn sentinel: thrown by the execute-path re-check inside the destructive transaction so the route
 *  catch can map it to the same values-free 409 and roll the whole transaction back (zero writes). */
export const HISTORY_INCOMPLETE_INTXN = 'HISTORY_INCOMPLETE_INTXN' as const
export class HistoryIncompleteInTxnError extends Error {
  readonly code = HISTORY_INCOMPLETE_INTXN
  constructor(readonly reason: HistoryIntegrityReason) {
    super('History is incomplete — destructive recovery refused inside the transaction (zero writes).')
    this.name = 'HistoryIncompleteInTxnError'
  }
}

/**
 * The EXACT derived-type exclusion list (retained §1.3 content layer) — value engines that materialize
 * computed keys into `meta_records.data` WITHOUT a revision by design. Derived materialization does NOT
 * bump `version` either, so it never creates a contiguity hole; this set only governs the content layer.
 */
export const DERIVED_FIELD_TYPES: ReadonlySet<string> = new Set(['formula', 'rollup', 'lookup', 'autoNumber'])

/** The four SYSTEM field types are server-maintained (derived at read time), excluded like derived types. */
export function isNonUserAuthoredFieldType(canonicalType: string): boolean {
  return DERIVED_FIELD_TYPES.has(canonicalType) || isSystemFieldType(canonicalType)
}

/** Raw DB `meta_fields.type` → excluded from the user-authored-field projection? */
export function isDerivedFieldType(rawType: string): boolean {
  return isNonUserAuthoredFieldType(String(mapFieldType(String(rawType ?? ''))))
}

export type HistoryIntegrityReason =
  // contiguity (primary, W0-1)
  | 'zero_revision_live_row'
  | 'chain_hole'
  | 'duplicate_version_event'
  | 'out_of_range_version'
  | 'live_row_after_delete_revision'
  // content projection (retained §1.3 second layer)
  | 'content_mismatch'
  | 'comparator_error'
  // STRICT MODE ONLY (v3.7 §9.3) — never returned when MULTITABLE_HISTORY_CONTIGUITY_STRICT is off.
  | 'chain_corrupt' // within-generation duplicate occupant (replaces the dropped marker UNIQUE constraint)

export type HistoryIntegrityVerdict = { ok: true } | { ok: false; reason: HistoryIntegrityReason }

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Canonical value equality for the content projection (key-order-insensitive objects, `null` ≡ absent). */
const canonicalize = (v: unknown): string => {
  if (v === undefined || v === null) return 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`
  if (isPlainRecord(v)) {
    const keys = Object.keys(v).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

// ==============================================================================================================
// Generation-aware contiguity — the PURE, unit-testable core (mutation-proven in isolation of the DB).
// ==============================================================================================================

export type ChainEventAction = 'create' | 'update' | 'delete'
/** A revision chain event. `orderKey` is the RAW `created_at` epoch-ms (exact in float64 — never packed with
 *  the version; see `chainOrderAfter`). Rank + version tiebreaks are compared structurally off the event. */
export interface ChainEvent {
  version: number
  action: ChainEventAction
  orderKey?: number
}
/** A legitimate non-data version bump (lock/unlock) recorded out-of-chain in `meta_record_version_markers`.
 *  `orderKey` = raw `created_at` epoch-ms; a marker ranks with updates (it happens on a LIVE row). */
export interface VersionMarker {
  version: number
  kind: 'lock' | 'unlock'
  orderKey?: number
}

/**
 * Total chain order = (created_at epoch-ms, version, non-delete-before-delete), compared STRUCTURALLY.
 *
 * Why not a packed numeric key: the previous encoding (`epoch*1e6 + version`) silently LOST the version
 * tiebreak to float64 precision — at 2026 epochs the scaled value is ~1.7e18 where the ULP is ~256, so
 * same-millisecond events collapsed to one float and the generation boundary was mis-drawn (CI catch:
 * undelete-pit scenario (g), a same-ms delete + occupying create). Comments asserting "version is a sub-ms
 * tiebreaker" were an unverified invariant; this comparator is pinned by same-epoch unit goldens instead.
 *
 * Within one millisecond, VERSION is the primary tiebreak: same-epoch multi-vintage churn writes ascending
 * versions (…delete@2, create@3, delete@4… — 4c-3 §7 realdb goldens construct exactly this at one T), so
 * ordering by version keeps each create with ITS vintage. A static action rank (e.g. "create after delete")
 * cannot linearize that shape — it would hoist create@3 past delete@4 into the live generation and refuse
 * out_of_range. The final leg breaks the delete-REUSE tie only: a delete that reuses version k happens
 * after the content event at k, so at equal (epoch, version) the delete sorts LAST.
 *
 * Known fail-closed residue (C2 docket, NOT solved here): a restore/resurrect create@v1 landing in the SAME
 * millisecond as the delete it follows is version-below the delete and thus sorts before it — the row
 * refuses (live_row_after_delete_revision), it is never mis-reconstructed. The packed-float ordering refused
 * that shape too (collapsed keys), so this is no regression; disambiguating same-ms cross-generation order
 * needs the C2 time anchor.
 */
type ChainOrdered = { version: number; action?: ChainEventAction; orderKey?: number }
const chainOrderAfter = (a: ChainOrdered, b: ChainOrdered): boolean => {
  const ta = a.orderKey ?? 0
  const tb = b.orderKey ?? 0
  if (ta !== tb) return ta > tb
  if (a.version !== b.version) return a.version > b.version
  return a.action === 'delete' && b.action !== 'delete'
}

export type ContiguityResult = { ok: true } | { ok: false; reason: HistoryIntegrityReason }

/**
 * Generation-aware contiguity for ONE live record (owner §6.1 — "generation = count(create revisions
 * at-or-before)"; delete revisions REUSE the last live version, so NO count/version-uniqueness criterion works).
 *
 * A record's chain is a sequence of GENERATIONS separated by delete revisions (a record can be created,
 * deleted, then trash-restored / PIT-resurrected — a fresh `create` revision at version 1 starts a NEW
 * generation). Only the CURRENT generation (the suffix strictly after the LAST delete, by orderKey) governs
 * a LIVE record's trustworthiness for revert/reset to a T in that generation. Reconstruction across a prior
 * generation boundary is C3 (deleted-record chains) — explicitly DEFERRED — so this proof scopes to the
 * current generation, which is why a common trash-restore is NOT false-refused.
 *
 * The current generation is contiguous iff every version k ∈ [genStart..liveVersion] (genStart = the version
 * of the generation's `create`) is occupied by EXACTLY ONE canonical occupant:
 *   - a create/update revision at version k in the current generation, OR
 *   - a lock/unlock marker at version k in the current generation.
 * Fail-closed:
 *   - a version with no occupant = an uncaptured data write = a HOLE (this is the healed-gap the whole slice
 *     exists to catch: v3 record with revisions {v1, v3} ⇒ v2 hole);
 *   - two occupants at one version = duplicate/conflicting event (C5);
 *   - an occupant version > liveVersion (or < genStart) = out-of-range (C5);
 *   - the last chain event is a delete but the row is LIVE (current generation empty) = uncaptured
 *     resurrection;
 *   - no create/update revision anywhere = the zero-revision uncaptured-CREATE fingerprint.
 */
export function checkRecordChainContiguity(
  liveVersion: number,
  events: ReadonlyArray<ChainEvent>,
  markers: ReadonlyArray<VersionMarker>,
): ContiguityResult {
  const V = Number.isFinite(liveVersion) ? Math.trunc(liveVersion) : 0
  if (V < 1) return { ok: false, reason: 'chain_hole' } // a live record must have version >= 1

  const anyCreateOrUpdate = events.some((e) => e.action !== 'delete')
  if (!anyCreateOrUpdate && markers.length === 0) return { ok: false, reason: 'zero_revision_live_row' }

  // Generation boundary: the LAST delete (by chain order) terminates the prior generation; the current
  // generation is everything strictly after it (structural comparator — see chainOrderAfter).
  let lastDelete: ChainEvent | null = null
  for (const e of events) {
    if (e.action === 'delete' && (lastDelete === null || chainOrderAfter(e, lastDelete))) lastDelete = e
  }
  const boundary = lastDelete
  const inCurrentGen = (x: ChainOrdered): boolean => boundary === null || chainOrderAfter(x, boundary)

  const currentGenEvents = events.filter((e) => e.action !== 'delete' && inCurrentGen(e))
  const currentGenMarkers = markers.filter((m) => inCurrentGen(m))

  // Current generation empty while the row is LIVE ⇒ the latest chain event is a delete (uncaptured
  // resurrection: history claims dead but the row exists).
  if (currentGenEvents.length === 0 && anyCreateOrUpdate) return { ok: false, reason: 'live_row_after_delete_revision' }
  if (currentGenEvents.length === 0) return { ok: false, reason: 'zero_revision_live_row' }

  // A generation must START with a create. genStart = the create's version (v1 for original + resurrect).
  const createVersions = currentGenEvents.filter((e) => e.action === 'create').map((e) => e.version)
  if (createVersions.length === 0) return { ok: false, reason: 'chain_hole' } // updates with no create = broken generation
  const genStart = Math.min(...createVersions)
  if (genStart < 1 || genStart > V) return { ok: false, reason: 'out_of_range_version' }

  const occupant = new Map<number, number>()
  for (const e of currentGenEvents) {
    if (!Number.isInteger(e.version) || e.version < genStart || e.version > V) return { ok: false, reason: 'out_of_range_version' }
    occupant.set(e.version, (occupant.get(e.version) ?? 0) + 1)
  }
  for (const m of currentGenMarkers) {
    if (!Number.isInteger(m.version) || m.version < genStart || m.version > V) return { ok: false, reason: 'out_of_range_version' }
    occupant.set(m.version, (occupant.get(m.version) ?? 0) + 1)
  }

  for (let k = genStart; k <= V; k++) {
    const c = occupant.get(k) ?? 0
    if (c === 0) return { ok: false, reason: 'chain_hole' }
    if (c > 1) return { ok: false, reason: 'duplicate_version_event' }
  }
  return { ok: true }
}

// ==============================================================================================================
// STRICT MODE (W0-1 v3.7 §9.3) — seq-ordered, ALL-generations contiguity. PURE, unit-testable core, gated
// behind MULTITABLE_HISTORY_CONTIGUITY_STRICT at the caller (`precheckSheetHistoryIntegrityStrict` below).
// Does NOT share code with `checkRecordChainContiguity` above — that function and its exports are completely
// untouched by this addition (flag-off byte-identical guarantee).
// ==============================================================================================================

/** One item of a record's seq-ordered timeline (a revision event OR a lock/unlock marker). `seq` is the
 *  EXACT decimal-string value of the shared `meta_record_chain_seq` bigint column — never a `number`. The
 *  caller (`precheckSheetHistoryIntegrityStrict`) fetches this array already ordered by native SQL
 *  `ORDER BY record_id, seq` (bigint compare) — this function does not re-sort, it only DEFENSIVELY verifies
 *  the given order is truly seq-ascending (BigInt compare — never Number()/subtraction) before trusting it. */
export type StrictTimelineItem =
  | { kind: 'event'; version: number; action: ChainEventAction; seq: string }
  | { kind: 'marker'; version: number; seq: string }

/** Scope of the record being validated: a LIVE record's terminal generation ends at its current `version`;
 *  a DELETED record (chain-only or `meta_records_trash`, C3 §4) has no live version — its terminal generation
 *  must end in a delete event, whose own (reused) version closes it. */
export type StrictScope = { kind: 'live'; liveVersion: number } | { kind: 'deleted' }

/** Positive-integer decimal string, no leading zeros — the only legal `seq` shape. Exact regardless of
 *  magnitude (string format check, never a numeric parse). */
const SEQ_FORMAT = /^[1-9][0-9]*$/

/**
 * Generation-aware contiguity, TRUE CAUSAL ORDER, ALL GENERATIONS (v3.7 §4/§9.3 owner High-2). Differs from
 * `checkRecordChainContiguity` above in exactly these ways:
 *
 *  1. Order comes from the real `seq` column (one shared sequence across revisions AND markers), never
 *     `created_at`/`version` structural comparison. Every seq comparison here is exact `BigInt(...)` compare
 *     or exact string equality — never `Number(seq)`, `parseInt`, unary `+`, or a subtraction comparator
 *     (§9.7; those silently collapse distinct seq values once they exceed 2^53, see the exact-bigint
 *     goldens in `multitable-history-contiguity-strict-seq-realdb.test.ts`).
 *  2. Generation = `COUNT(*) FILTER (WHERE action='create') OVER (ORDER BY seq)` — a plain running counter
 *     over the (already seq-ordered) timeline; it only inspects `action`, never `seq` magnitude.
 *  3. EVERY generation is validated, not just the terminal one — "terminal-generation-only validation is
 *     forbidden" (§4, verbatim). A hole in an OLDER generation refuses even when the terminal generation is
 *     completely clean (the High-2 regression this lane exists to fix).
 *  4. Illegal/missing/out-of-range seq fails closed (`comparator_error`), never coerced to zero or dropped.
 *     A within-generation duplicate occupant is `chain_corrupt` (replaces the DROPPED cross-generation marker
 *     UNIQUE, which used to reject this shape at write time).
 *
 * C2 time-monotonicity (seq order vs. version order agreement) is explicitly NOT checked here — it remains
 * on the pre-existing DEFERRED docket (module doc comment); this lane's contract is exact-bigint ordering +
 * all-generations occupancy + C3 enumeration + dup/illegal-seq fail-close, not the full v3.7 W0 correction.
 */
export function checkAllGenerationsContiguity(
  scope: StrictScope,
  timeline: ReadonlyArray<StrictTimelineItem>,
): ContiguityResult {
  if (timeline.length === 0) return { ok: false, reason: 'zero_revision_live_row' }
  const anyCreateOrUpdate = timeline.some((it) => it.kind === 'event' && it.action !== 'delete')
  const anyMarker = timeline.some((it) => it.kind === 'marker')
  if (!anyCreateOrUpdate && !anyMarker) return { ok: false, reason: 'zero_revision_live_row' }

  // Fail-closed seq validation: format, then strict ascending + no duplicates (exact BigInt compare — the
  // shared sequence domain must never repeat a value; a repeat or a regression is corruption, not coercible).
  let prevSeq: bigint | null = null
  for (const it of timeline) {
    if (!SEQ_FORMAT.test(it.seq)) return { ok: false, reason: 'comparator_error' }
    const cur = BigInt(it.seq)
    if (prevSeq !== null) {
      if (cur === prevSeq) return { ok: false, reason: 'comparator_error' } // shared-domain seq collision
      if (cur < prevSeq) return { ok: false, reason: 'comparator_error' } // caller must pass seq-ascending
    }
    prevSeq = cur
  }

  // Generation index per item: cumulative count of 'create' events at-or-before this position (seq order).
  // A plain integer counter — never reads seq magnitude, so it carries no float-precision risk.
  let creates = 0
  const generation: number[] = new Array(timeline.length)
  for (let i = 0; i < timeline.length; i++) {
    const it = timeline[i]
    if (it.kind === 'event' && it.action === 'create') creates += 1
    generation[i] = creates
  }
  if (creates === 0) return { ok: false, reason: 'chain_hole' } // no create ever captured (updates/markers only)

  // CONSERVATIVE: validate EVERY generation (not terminal-only — v3.7 §4/§9.3 owner High-2 correction).
  for (let g = 1; g <= creates; g++) {
    const bucket: StrictTimelineItem[] = []
    for (let i = 0; i < timeline.length; i++) if (generation[i] === g) bucket.push(timeline[i])

    const first = bucket[0]
    if (!first || first.kind !== 'event' || first.action !== 'create') return { ok: false, reason: 'chain_hole' }
    const genStart = first.version
    const isTerminalGen = g === creates
    const last = bucket[bucket.length - 1]
    const lastIsDelete = last.kind === 'event' && last.action === 'delete'

    let genEnd: number
    if (!isTerminalGen) {
      // A non-terminal generation can only have been closed by a delete (a subsequent create implies the
      // prior generation ended) — anything else here is an anomaly: a live record double-created in place.
      if (!lastIsDelete) return { ok: false, reason: 'chain_hole' }
      genEnd = last.version // delete-reuse: the delete's own version closes the generation
    } else if (scope.kind === 'live') {
      if (lastIsDelete) return { ok: false, reason: 'live_row_after_delete_revision' } // uncaptured resurrection
      genEnd = scope.liveVersion
    } else {
      if (!lastIsDelete) return { ok: false, reason: 'chain_hole' } // deleted scope must end in a delete
      genEnd = last.version
    }

    if (!Number.isInteger(genStart) || genStart < 1) return { ok: false, reason: 'out_of_range_version' }
    if (!Number.isInteger(genEnd) || genEnd < genStart) return { ok: false, reason: 'out_of_range_version' }

    // Occupancy (exact set, C5): exactly one non-delete occupant per version in [genStart..genEnd]. Delete
    // events are excluded (delete-reuse — they close the generation, they never occupy a data version).
    const occupant = new Map<number, number>()
    for (const it of bucket) {
      if (it.kind === 'event' && it.action === 'delete') continue
      if (!Number.isInteger(it.version) || it.version < genStart || it.version > genEnd) return { ok: false, reason: 'out_of_range_version' }
      occupant.set(it.version, (occupant.get(it.version) ?? 0) + 1)
    }
    for (let k = genStart; k <= genEnd; k++) {
      const c = occupant.get(k) ?? 0
      if (c === 0) return { ok: false, reason: 'chain_hole' }
      if (c > 1) return { ok: false, reason: 'chain_corrupt' } // within-generation duplicate (strict-only code)
    }
  }

  return { ok: true }
}

// ==============================================================================================================

const toNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
/** Raw created_at epoch-ms — exact in float64. NEVER pack version into this (see chainOrderAfter). */
const epochOf = (createdAt: unknown): number => {
  const t = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt ?? ''))
  return Number.isFinite(t) ? t : 0
}

/**
 * The shared precheck. Scope = the sheet (revert/reset are whole-sheet operations). Preview and execute both
 * call this; the execute path ALSO re-runs it inside the destructive transaction (C8) via
 * `HistoryIncompleteInTxnError`.
 *
 * W0-1 v3.7 §9.3: when `MULTITABLE_HISTORY_CONTIGUITY_STRICT` is on, this delegates ENTIRELY to
 * `precheckSheetHistoryIntegrityStrict` below — a completely separate function. Everything from this line
 * down (through the end of the non-strict function body) is UNTOUCHED by the v3.7 addition, so flag-off
 * behavior stays byte-identical to #4269.
 */
export async function precheckSheetHistoryIntegrity(
  query: QueryFn,
  sheetId: string,
): Promise<HistoryIntegrityVerdict> {
  if (isContiguityStrictMode()) return precheckSheetHistoryIntegrityStrict(query, sheetId)

  // System sheets (approval projection / people directory) are server-regenerated read models — excluded.
  const sheetRes = await query('SELECT base_id, description FROM meta_sheets WHERE id = $1', [sheetId])
  const sheetRow = sheetRes.rows[0] as { base_id?: unknown; description?: unknown } | undefined
  if (sheetRow && isSystemSheet({ baseId: typeof sheetRow.base_id === 'string' ? sheetRow.base_id : null, description: sheetRow.description })) {
    return { ok: true }
  }

  const fieldsRes = await query('SELECT id, type FROM meta_fields WHERE sheet_id = $1', [sheetId])
  const userFieldIds: string[] = []
  for (const row of fieldsRes.rows as Array<{ id: unknown; type: unknown }>) {
    if (!isDerivedFieldType(String(row.type ?? ''))) userFieldIds.push(String(row.id))
  }
  const liveRes = await query('SELECT id, data, version FROM meta_records WHERE sheet_id = $1', [sheetId])
  const liveRows = liveRes.rows as Array<{ id: unknown; data: unknown; version: unknown }>
  if (liveRows.length === 0) return { ok: true }

  try {
    // FULL chain per record (contiguity needs every event, not just the latest) — all versions/actions.
    const revRes = await query(
      `SELECT record_id, version, action, snapshot, created_at, id
       FROM meta_record_revisions
       WHERE sheet_id = $1`,
      [sheetId],
    )
    type RevRow = { record_id: unknown; version: unknown; action: unknown; snapshot: unknown; created_at: unknown; id: unknown }
    const eventsByRecord = new Map<string, ChainEvent[]>()
    const latestSnapByRecord = new Map<string, { action: ChainEventAction; snapshot: unknown; version: number; orderKey: number }>()
    for (const r of revRes.rows as RevRow[]) {
      const rid = String(r.record_id)
      const version = toNumber(r.version)
      const action: ChainEventAction = (r.action === 'create' || r.action === 'delete') ? r.action : 'update'
      const orderKey = epochOf(r.created_at)
      const list = eventsByRecord.get(rid) ?? []
      list.push({ version, action, orderKey })
      eventsByRecord.set(rid, list)
      const prev = latestSnapByRecord.get(rid)
      const cand = { action, snapshot: r.snapshot, version, orderKey }
      if (!prev || chainOrderAfter(cand, prev)) latestSnapByRecord.set(rid, cand)
    }

    // Lock/unlock markers (deploy-window safe: a missing table pre-migration ⇒ no markers ⇒ locked records
    // fail CLOSED via a hole, never a crash — the C6 trusted-since watermark that grandfathers them is deferred).
    // The existence probe (information_schema, never 42P01) MUST run before the direct SELECT: this precheck is
    // re-run INSIDE the reset-execute destructive transaction, and a swallowed 42P01 there still aborts the txn
    // (25P02 on the next statement → 500 instead of clean 409). Mirrors the WRITE path's txn-safe probe.
    const markersByRecord = new Map<string, VersionMarker[]>()
    if (await hasVersionMarkerTable(query)) {
      const markerRes = await query(
        `SELECT record_id, version, kind, created_at FROM meta_record_version_markers WHERE sheet_id = $1`,
        [sheetId],
      )
      for (const m of markerRes.rows as Array<{ record_id: unknown; version: unknown; kind: unknown; created_at: unknown }>) {
        const rid = String(m.record_id)
        const version = toNumber(m.version)
        const list = markersByRecord.get(rid) ?? []
        list.push({ version, kind: m.kind === 'unlock' ? 'unlock' : 'lock', orderKey: epochOf(m.created_at) })
        markersByRecord.set(rid, list)
      }
    }

    for (const row of liveRows) {
      const rid = String(row.id)
      const liveVersion = toNumber(row.version)
      const events = eventsByRecord.get(rid) ?? []
      const markers = markersByRecord.get(rid) ?? []

      // PRIMARY: generation-aware contiguity.
      const contiguity = checkRecordChainContiguity(liveVersion, events, markers)
      if (!contiguity.ok) return contiguity

      // SECOND LAYER (retained §1.3): live user-field content must equal the latest captured snapshot.
      const latest = latestSnapByRecord.get(rid)
      if (latest && latest.action !== 'delete') {
        const live = isPlainRecord(row.data) ? row.data : {}
        const snap = isPlainRecord(latest.snapshot) ? latest.snapshot : {}
        for (const fid of userFieldIds) {
          if (canonicalize(live[fid]) !== canonicalize(snap[fid])) return { ok: false, reason: 'content_mismatch' }
        }
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'comparator_error' } // rule 4 fail-closed
  }
}

// ==============================================================================================================
// STRICT MODE entry point (W0-1 v3.7 §9.3). Independent of the non-strict function above — no shared state,
// no shared query shape, so the flag-off path above is provably unaffected by anything below this line.
// ==============================================================================================================

type StrictRawTimelineRow = {
  record_id: unknown
  version: unknown
  action: unknown
  snapshot: unknown
  seq: unknown
  kind: unknown
}

/**
 * STRICT MODE precheck (v3.7 §9.3). Same UNIFIED REFUSAL / FAIL-CLOSED doctrine as the non-strict function
 * (rules 1 and 4 in the module doc comment) — the differences are entirely in HOW contiguity is proven (see
 * `checkAllGenerationsContiguity`'s doc comment) and WHAT is enumerated (C3 deleted/trashed records too).
 */
async function precheckSheetHistoryIntegrityStrict(query: QueryFn, sheetId: string): Promise<HistoryIntegrityVerdict> {
  // System sheets excluded — identical predicate/semantics to the non-strict path.
  const sheetRes = await query('SELECT base_id, description FROM meta_sheets WHERE id = $1', [sheetId])
  const sheetRow = sheetRes.rows[0] as { base_id?: unknown; description?: unknown } | undefined
  if (sheetRow && isSystemSheet({ baseId: typeof sheetRow.base_id === 'string' ? sheetRow.base_id : null, description: sheetRow.description })) {
    return { ok: true }
  }

  const fieldsRes = await query('SELECT id, type FROM meta_fields WHERE sheet_id = $1', [sheetId])
  const userFieldIds: string[] = []
  for (const row of fieldsRes.rows as Array<{ id: unknown; type: unknown }>) {
    if (!isDerivedFieldType(String(row.type ?? ''))) userFieldIds.push(String(row.id))
  }

  const liveRes = await query('SELECT id, data, version FROM meta_records WHERE sheet_id = $1', [sheetId])
  const liveRows = liveRes.rows as Array<{ id: unknown; data: unknown; version: unknown }>
  const liveById = new Map<string, { data: unknown; version: number }>()
  for (const r of liveRows) liveById.set(String(r.id), { data: r.data, version: toNumber(r.version) })
  // NOTE: unlike the non-strict path, strict mode does NOT early-return on zero live rows — C3 (§4) must
  // still enumerate and validate deleted/trashed records even when a sheet currently has no live rows at all.

  try {
    // Strict mode requires the real seq column; a pre-migration deploy window (column absent) fails CLOSED,
    // never crashes with an undefined-column error (42703).
    if (!(await hasChainSeqColumn(query))) return { ok: false, reason: 'comparator_error' }

    // Illegal-seq fail-close (§9.3 scope item 6): any non-positive seq in scope refuses immediately, native
    // SQL `<= 0` comparison — exact regardless of magnitude, never coerced to zero.
    const illegalRev = await query('SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1 AND seq <= 0', [sheetId])
    if (Number((illegalRev.rows[0] as { c: number }).c) > 0) return { ok: false, reason: 'comparator_error' }

    const hasMarkers = await hasVersionMarkerTable(query)
    if (hasMarkers) {
      const illegalMarker = await query('SELECT count(*)::int AS c FROM meta_record_version_markers WHERE sheet_id = $1 AND seq <= 0', [sheetId])
      if (Number((illegalMarker.rows[0] as { c: number }).c) > 0) return { ok: false, reason: 'comparator_error' }
    }

    // The full seq-ordered timeline (revisions ∪ markers), one native SQL `ORDER BY` on the `bigint` column
    // (never a JS-side sort/comparison of seq) — grouped by `record_id` while preserving that order, which
    // is exactly what `checkAllGenerationsContiguity` requires as input.
    const timelineSql = hasMarkers
      ? `SELECT record_id, version, action, snapshot, seq, 'event' AS kind FROM meta_record_revisions WHERE sheet_id = $1
         UNION ALL
         SELECT record_id, version, NULL AS action, NULL::jsonb AS snapshot, seq, 'marker' AS kind FROM meta_record_version_markers WHERE sheet_id = $1
         ORDER BY record_id, seq`
      : `SELECT record_id, version, action, snapshot, seq, 'event' AS kind FROM meta_record_revisions WHERE sheet_id = $1 ORDER BY record_id, seq`
    const timelineRes = await query(timelineSql, [sheetId]) // `$1` is reused by BOTH UNION ALL branches — one value

    const timelineByRecord = new Map<string, StrictTimelineItem[]>()
    const latestSnapshotByRecord = new Map<string, { action: ChainEventAction; snapshot: unknown }>()
    for (const row of timelineRes.rows as StrictRawTimelineRow[]) {
      const rid = String(row.record_id)
      const seq = String(row.seq ?? '')
      const version = toNumber(row.version)
      const list = timelineByRecord.get(rid) ?? []
      if (row.kind === 'marker') {
        list.push({ kind: 'marker', version, seq })
      } else {
        const action: ChainEventAction = (row.action === 'create' || row.action === 'delete') ? row.action : 'update'
        list.push({ kind: 'event', version, action, seq })
        latestSnapshotByRecord.set(rid, { action, snapshot: row.snapshot }) // rows arrive seq-ascending ⇒ last write wins = latest
      }
      timelineByRecord.set(rid, list)
    }

    // C3 (§4/§9.3 scope item 5): deleted/trashed records — chain-only (not live) ∪ `meta_records_trash`,
    // minus live ids. Revert/Reset can resurrect them, so their chain must ALSO be provably contiguous.
    const deletedIds = new Set<string>()
    for (const rid of timelineByRecord.keys()) if (!liveById.has(rid)) deletedIds.add(rid)
    const trashRes = await query('SELECT DISTINCT record_id FROM meta_records_trash WHERE sheet_id = $1', [sheetId])
    for (const r of trashRes.rows as Array<{ record_id: unknown }>) {
      const rid = String(r.record_id)
      if (!liveById.has(rid)) deletedIds.add(rid)
    }

    // LIVE records.
    for (const [rid, live] of liveById) {
      const timeline = timelineByRecord.get(rid) ?? []
      const result = checkAllGenerationsContiguity({ kind: 'live', liveVersion: live.version }, timeline)
      if (!result.ok) return result

      // SECOND LAYER (retained §1.3, unchanged semantics): live user-field content must equal the latest
      // captured snapshot. Formula/rollup/lookup/autoNumber fields are excluded (userFieldIds) — they
      // materialize live without a revision by design, so their live-vs-snapshot drift is never a refusal.
      const latest = latestSnapshotByRecord.get(rid)
      if (latest && latest.action !== 'delete') {
        const liveData = isPlainRecord(live.data) ? live.data : {}
        const snap = isPlainRecord(latest.snapshot) ? latest.snapshot : {}
        for (const fid of userFieldIds) {
          if (canonicalize(liveData[fid]) !== canonicalize(snap[fid])) return { ok: false, reason: 'content_mismatch' }
        }
      }
    }

    // DELETED/TRASHED records (C3). A trash row surviving with its entire revision chain retention-swept has
    // nothing left to verify — fail-closed, never assumed healthy.
    for (const rid of deletedIds) {
      const timeline = timelineByRecord.get(rid) ?? []
      if (timeline.length === 0) return { ok: false, reason: 'chain_hole' }
      const result = checkAllGenerationsContiguity({ kind: 'deleted' }, timeline)
      if (!result.ok) return result
    }

    return { ok: true }
  } catch {
    return { ok: false, reason: 'comparator_error' } // rule 4 fail-closed
  }
}
