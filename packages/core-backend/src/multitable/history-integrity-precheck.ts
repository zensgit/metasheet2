import { mapFieldType, isSystemFieldType } from './field-codecs'
import type { QueryFn } from './permission-service'
import { isSystemSheet } from './system-sheet-predicate'
import { hasVersionMarkerTable } from './record-history-service'

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
 */

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
/** A revision chain event. `orderKey` is a monotone tiebreaker (created_at epoch, then version, then id) used
 *  ONLY to decide which event is "latest" for the live-row-after-delete check. */
export interface ChainEvent {
  version: number
  action: ChainEventAction
  orderKey?: number
}
/** A legitimate non-data version bump (lock/unlock) recorded out-of-chain in `meta_record_version_markers`.
 *  `orderKey` (created_at epoch, then version) places the marker in its generation, exactly like a ChainEvent. */
export interface VersionMarker {
  version: number
  kind: 'lock' | 'unlock'
  orderKey?: number
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

  // Generation boundary: the LAST delete (by orderKey) terminates the prior generation; the current
  // generation is everything strictly after it.
  let lastDeleteOrderKey = Number.NEGATIVE_INFINITY
  for (const e of events) {
    if (e.action === 'delete') lastDeleteOrderKey = Math.max(lastDeleteOrderKey, e.orderKey ?? 0)
  }
  const inCurrentGen = (orderKey?: number): boolean => (orderKey ?? 0) > lastDeleteOrderKey

  const currentGenEvents = events.filter((e) => e.action !== 'delete' && inCurrentGen(e.orderKey))
  const currentGenMarkers = markers.filter((m) => inCurrentGen(m.orderKey))

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

const toNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const orderKeyOf = (createdAt: unknown, version: number): number => {
  const t = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt ?? ''))
  // epoch-ms dominates; version is a sub-ms tiebreaker (max ~1e6 versions before it would collide a ms).
  return (Number.isFinite(t) ? t : 0) * 1e6 + version
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
    const latestSnapByRecord = new Map<string, { action: string; snapshot: unknown; orderKey: number }>()
    for (const r of revRes.rows as RevRow[]) {
      const rid = String(r.record_id)
      const version = toNumber(r.version)
      const action = (r.action === 'create' || r.action === 'delete') ? r.action : 'update'
      const orderKey = orderKeyOf(r.created_at, version)
      const list = eventsByRecord.get(rid) ?? []
      list.push({ version, action, orderKey })
      eventsByRecord.set(rid, list)
      const prev = latestSnapByRecord.get(rid)
      if (!prev || orderKey > prev.orderKey) latestSnapByRecord.set(rid, { action, snapshot: r.snapshot, orderKey })
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
        list.push({ version, kind: m.kind === 'unlock' ? 'unlock' : 'lock', orderKey: orderKeyOf(m.created_at, version) })
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
