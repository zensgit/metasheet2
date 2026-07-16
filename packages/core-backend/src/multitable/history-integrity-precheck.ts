import { mapFieldType, isSystemFieldType } from './field-codecs'
import type { QueryFn } from './permission-service'
import { isSystemSheet } from './system-sheet-predicate'
import { hasVersionMarkerTable, hasChainSeqColumns } from './record-history-service'

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
 * W0-1 v3.5 (design lock #4262) STRICT MODE — `MULTITABLE_HISTORY_CONTIGUITY_STRICT` (default OFF; flag-off
 * is BYTE-IDENTICAL to the #4269 behavior documented above — the epoch/version structural comparator,
 * live-rows-only, no C2, no C3). When the flag is on, `precheckSheetHistoryIntegrity` switches to:
 *   - §2 TRUE CAUSAL ORDER: events and markers are ordered by the real `seq` column (one shared PG sequence
 *     across both tables — `zzzz20260715120000_add_meta_record_chain_seq`), not `created_at`/`version`.
 *   - §2 GENERATION BY COUNT: `generation = COUNT(*) FILTER (WHERE action='create') OVER (ORDER BY seq)` —
 *     the owner's exact formula, replacing the "everything after the last delete" boundary. A within-
 *     generation duplicate is `chain_corrupt` (a NEW code — distinct from the legacy `duplicate_version_event`,
 *     because it replaces the DROPPED marker unique constraint, not the legacy live-vs-latest content check).
 *   - C2 (fail-CLOSED, was fail-open in #4269): within the terminal generation, seq order and version order
 *     must agree (delete-reuse excepted) — disagreement ⇒ `nonmonotonic_history`.
 *   - C3 (in scope): deleted/trashed records (revision chain ∪ `meta_records_trash`, minus live ids) are
 *     ALSO enumerated — Revert/Reset can resurrect them, so their terminal (most recent, pre-delete)
 *     generation must pass the SAME per-generation contiguity or the whole sheet-wide operation refuses.
 *     Scope note (deliberate, symmetric with the live-record model): only the TERMINAL generation of a
 *     deleted record is checked, exactly as only the CURRENT generation of a live record is checked — older
 *     generations of either are out of scope here (full backward multi-generation reconstruction is not
 *     required by this lane). A deleted record whose trash row survives but whose ENTIRE revision chain has
 *     been retention-swept cannot be verified at all and is refused (`chain_hole`) — expected until the §6
 *     durable trusted-since checkpoint (DEFERRED, a later lane) grandfathers pre-checkpoint history; this is
 *     exactly why strict mode is not meant to be enabled over a mature environment without that checkpoint.
 */
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
  // STRICT MODE ONLY (design lock #4262 v3.5 §2/§8) — never returned when
  // MULTITABLE_HISTORY_CONTIGUITY_STRICT is off.
  | 'chain_corrupt' // within-generation duplicate occupant (replaces the dropped marker UNIQUE)
  | 'nonmonotonic_history' // C2: seq order and version order disagree within a generation

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
 *  the version; see `chainOrderAfter`). Rank + version tiebreaks are compared structurally off the event.
 *  `seq` (optional here — required by `checkRecordChainContiguityStrict`) is the W0-1 v3.5 causal sequence
 *  column shared with markers (design lock §2); the default (non-strict) comparator never reads it. */
export interface ChainEvent {
  version: number
  action: ChainEventAction
  orderKey?: number
  seq?: number
}
/** A legitimate non-data version bump (lock/unlock) recorded out-of-chain in `meta_record_version_markers`.
 *  `orderKey` = raw `created_at` epoch-ms; a marker ranks with updates (it happens on a LIVE row). `seq` —
 *  see `ChainEvent` above; same causal domain, shared sequence. */
export interface VersionMarker {
  version: number
  kind: 'lock' | 'unlock'
  orderKey?: number
  seq?: number
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
// STRICT MODE (design lock #4262 v3.5 §2/C2/C3) — seq-ordered generation-aware contiguity. PURE,
// unit-testable core, gated behind MULTITABLE_HISTORY_CONTIGUITY_STRICT at the caller
// (`precheckSheetHistoryIntegrity`). Every `ChainEvent`/`VersionMarker` passed in MUST carry a real `.seq`
// (from the shared `meta_record_chain_seq` sequence) — a missing seq is a caller bug and fails CLOSED
// (`comparator_error`), never silently falls back to epoch/version ordering.
// ==============================================================================================================

type SeqTimelineItem =
  | { kind: 'event'; version: number; action: ChainEventAction; seq: number }
  | { kind: 'marker'; version: number; seq: number }

/**
 * Generation-aware contiguity, TRUE CAUSAL ORDER (design lock §2). Three differences from
 * `checkRecordChainContiguity` above:
 *   1. Order comes from the real `seq` column (one shared sequence across revisions AND markers), never
 *      `created_at`/`version` structural comparison — no same-ms collisions, no float packing.
 *   2. Generation = `COUNT(*) FILTER (WHERE action='create') OVER (ORDER BY seq)` — the owner's exact
 *      formula. This lets a DELETED (non-live) record's chain be generation-scoped exactly like a live
 *      one: `liveVersion === null` scopes the check to the record's TERMINAL generation using the
 *      terminal (delete) event's own `.version` as V (delete-reuse semantics), for the C3 caller.
 *   3. C2: within the terminal generation, seq order and version order must agree (the terminal delete, if
 *      any, is exempt — it legitimately REUSES the prior version). A disagreement is `nonmonotonic_history`,
 *      fail-CLOSED (§2's fail-open in #4269 is corrected here).
 * A within-generation duplicate occupant is `chain_corrupt` (new code — see design lock §2: replaces the
 * DROPPED cross-generation marker UNIQUE, which used to reject this at write time).
 */
export function checkRecordChainContiguityStrict(
  liveVersion: number | null,
  events: ReadonlyArray<ChainEvent>,
  markers: ReadonlyArray<VersionMarker>,
): ContiguityResult {
  const anyCreateOrUpdate = events.some((e) => e.action !== 'delete')
  if (!anyCreateOrUpdate && markers.length === 0) return { ok: false, reason: 'zero_revision_live_row' }
  if (events.some((e) => e.seq === undefined) || markers.some((m) => m.seq === undefined)) {
    return { ok: false, reason: 'comparator_error' } // caller bug: strict mode requires real seq everywhere
  }

  const timeline: SeqTimelineItem[] = [
    ...events.map((e): SeqTimelineItem => ({ kind: 'event', version: e.version, action: e.action, seq: e.seq as number })),
    ...markers.map((m): SeqTimelineItem => ({ kind: 'marker', version: m.version, seq: m.seq as number })),
  ].sort((a, b) => a.seq - b.seq)
  if (timeline.length === 0) return { ok: false, reason: 'zero_revision_live_row' }

  // Generation number per timeline position: count of 'create' events at-or-before this seq.
  let creates = 0
  const generations: number[] = new Array(timeline.length)
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i]
    if (item.kind === 'event' && item.action === 'create') creates += 1
    generations[i] = creates
  }
  if (creates === 0) return { ok: false, reason: 'chain_hole' } // no create ever captured (updates/markers only)

  const terminalItem = timeline[timeline.length - 1]
  const terminalGen = generations[generations.length - 1]

  // LIVE record: the terminal event must not be a delete (uncaptured resurrection). A DELETED record
  // (liveVersion === null, the C3 caller) is expected to end in a delete; the caller has already verified
  // that before calling, so this branch only applies when a record IS live.
  if (liveVersion !== null && terminalItem.kind === 'event' && terminalItem.action === 'delete') {
    return { ok: false, reason: 'live_row_after_delete_revision' }
  }

  const genItems = timeline.filter((_, i) => generations[i] === terminalGen)
  const genCreates = genItems.filter((it): it is Extract<SeqTimelineItem, { kind: 'event' }> => it.kind === 'event' && it.action === 'create')
  if (genCreates.length !== 1) return { ok: false, reason: 'chain_hole' } // must open with exactly one create
  const genStart = genCreates[0].version

  const V = liveVersion !== null ? Math.trunc(liveVersion) : Math.trunc((terminalItem as { version: number }).version)
  if (!Number.isFinite(V) || V < 1) return { ok: false, reason: 'chain_hole' }
  if (!Number.isInteger(genStart) || genStart < 1 || genStart > V) return { ok: false, reason: 'out_of_range_version' }

  // C2 MONOTONICITY: within the terminal generation, seq order and version order must agree. The terminal
  // delete (if the terminal item IS a delete) is EXEMPT — delete legitimately REUSES the prior version.
  let prevVersion = -Infinity
  for (const it of genItems) {
    const isTerminalDelete = it === terminalItem && it.kind === 'event' && it.action === 'delete'
    if (isTerminalDelete) continue
    if (it.version < prevVersion) return { ok: false, reason: 'nonmonotonic_history' }
    prevVersion = it.version
  }

  // Occupancy (C5 + marker uniqueness, §2): exactly one non-delete occupant per version in [genStart..V].
  // Delete events are excluded from occupancy (delete-reuse), matching the legacy comparator's semantics.
  const occupant = new Map<number, number>()
  for (const it of genItems) {
    if (it.kind === 'event' && it.action === 'delete') continue
    if (!Number.isInteger(it.version) || it.version < genStart || it.version > V) return { ok: false, reason: 'out_of_range_version' }
    occupant.set(it.version, (occupant.get(it.version) ?? 0) + 1)
  }
  for (let k = genStart; k <= V; k++) {
    const c = occupant.get(k) ?? 0
    if (c === 0) return { ok: false, reason: 'chain_hole' }
    if (c > 1) return { ok: false, reason: 'chain_corrupt' } // within-generation duplicate (§2)
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
 */
export async function precheckSheetHistoryIntegrity(
  query: QueryFn,
  sheetId: string,
): Promise<HistoryIntegrityVerdict> {
  const strict = isContiguityStrictMode()

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
  // Non-strict: unchanged shortcut (an empty sheet has nothing to refuse) — BYTE-IDENTICAL to #4269.
  // Strict mode cannot take this shortcut: C3 (§4) must still enumerate deleted/trashed records even when
  // the sheet currently has zero LIVE rows (e.g. every record in it was deleted).
  if (liveRows.length === 0 && !strict) return { ok: true }

  try {
    // Strict mode needs the real seq column; a pre-migration deploy window (column absent) fails CLOSED via
    // the pure functions below (every event/marker gets seq=undefined ⇒ comparator_error), never a crash.
    const seqColumnsPresent = strict && (await hasChainSeqColumns(query))

    // FULL chain per record (contiguity needs every event, not just the latest) — all versions/actions.
    const revRes = await query(
      `SELECT record_id, version, action, snapshot, created_at, id${seqColumnsPresent ? ', seq' : ''}
       FROM meta_record_revisions
       WHERE sheet_id = $1`,
      [sheetId],
    )
    type RevRow = { record_id: unknown; version: unknown; action: unknown; snapshot: unknown; created_at: unknown; id: unknown; seq?: unknown }
    const eventsByRecord = new Map<string, ChainEvent[]>()
    const latestSnapByRecord = new Map<string, { action: ChainEventAction; snapshot: unknown; version: number; orderKey: number }>()
    for (const r of revRes.rows as RevRow[]) {
      const rid = String(r.record_id)
      const version = toNumber(r.version)
      const action: ChainEventAction = (r.action === 'create' || r.action === 'delete') ? r.action : 'update'
      const orderKey = epochOf(r.created_at)
      const seq: number | undefined = seqColumnsPresent && r.seq !== undefined && r.seq !== null ? toNumber(r.seq) : undefined
      const list = eventsByRecord.get(rid) ?? []
      list.push({ version, action, orderKey, seq })
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
        `SELECT record_id, version, kind, created_at${seqColumnsPresent ? ', seq' : ''} FROM meta_record_version_markers WHERE sheet_id = $1`,
        [sheetId],
      )
      for (const m of markerRes.rows as Array<{ record_id: unknown; version: unknown; kind: unknown; created_at: unknown; seq?: unknown }>) {
        const rid = String(m.record_id)
        const version = toNumber(m.version)
        const seq: number | undefined = seqColumnsPresent && m.seq !== undefined && m.seq !== null ? toNumber(m.seq) : undefined
        const list = markersByRecord.get(rid) ?? []
        list.push({ version, kind: m.kind === 'unlock' ? 'unlock' : 'lock', orderKey: epochOf(m.created_at), seq })
        markersByRecord.set(rid, list)
      }
    }

    const liveIds = new Set(liveRows.map((r) => String(r.id)))

    for (const row of liveRows) {
      const rid = String(row.id)
      const liveVersion = toNumber(row.version)
      const events = eventsByRecord.get(rid) ?? []
      const markers = markersByRecord.get(rid) ?? []

      // PRIMARY: generation-aware contiguity — strict (seq-ordered, §2/C2) or the legacy (epoch-ordered,
      // #4269) comparator, selected ONCE per call by the flag (never mixed within one precheck run).
      const contiguity = strict
        ? checkRecordChainContiguityStrict(liveVersion, events, markers)
        : checkRecordChainContiguity(liveVersion, events, markers)
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

    // C3 (strict only, design lock §4): deleted/trashed records. Revert/Reset can resurrect them, so their
    // TERMINAL (most recent, pre-delete) generation must ALSO pass contiguity, or the whole sheet-wide
    // operation refuses. Enumerated from the revision chain (already fetched above, unscoped by liveness) ∪
    // `meta_records_trash` (belt-and-suspenders: a trash row can in principle outlive its own chain under
    // retention sweeps — see the fail-closed branch below).
    if (strict) {
      const deletedRecordIds = new Set<string>()
      for (const rid of eventsByRecord.keys()) if (!liveIds.has(rid)) deletedRecordIds.add(rid)
      const trashRes = await query('SELECT DISTINCT record_id FROM meta_records_trash WHERE sheet_id = $1', [sheetId])
      for (const r of trashRes.rows as Array<{ record_id: unknown }>) {
        const rid = String(r.record_id)
        if (!liveIds.has(rid)) deletedRecordIds.add(rid)
      }

      for (const rid of deletedRecordIds) {
        const events = eventsByRecord.get(rid) ?? []
        const markers = markersByRecord.get(rid) ?? []
        if (events.length === 0) {
          // A trash row survives but this record's ENTIRE revision chain has been retention-swept — there is
          // nothing left to verify. Fail-closed (expected until the deferred §6 durable trusted-since
          // checkpoint grandfathers pre-checkpoint history — see the module doc comment).
          return { ok: false, reason: 'chain_hole' }
        }
        const terminal = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[events.length - 1]
        if (terminal.action !== 'delete') {
          // Anomaly: not live, chain exists, but its last event isn't a delete. Fail-closed defensively
          // rather than guess at what state this record is actually in.
          return { ok: false, reason: 'chain_hole' }
        }
        const contiguity = checkRecordChainContiguityStrict(null, events, markers)
        if (!contiguity.ok) return contiguity
      }
    }

    return { ok: true }
  } catch {
    return { ok: false, reason: 'comparator_error' } // rule 4 fail-closed
  }
}
