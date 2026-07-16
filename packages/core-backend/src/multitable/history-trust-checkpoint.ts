import type { QueryFn } from './permission-service'

/**
 * W0-1 v3.7 (owner-ratified #4331 §3 —
 * docs/development/multitable-w0-1-v37-exact-anchor-trust-design-lock-20260715.md §3) — Lane L5: the
 * TRUST-CHECKPOINT state machine, selection, and retention logic.
 *
 * The trust floor: a checkpoint's `trusted_since_seq` is the point at/after which sheet history is
 * trustworthy for destructive recovery. This module owns the `building → active` state machine, the
 * seq-based (and display-only T-based) checkpoint selection, and the floor-clamped retention prune. It does
 * NOT wire checkpoint activation into the live restore/execute path — that in-fence cutover is L5-wire,
 * deferred until L4's canonical sheet fence lands. `activateCheckpoint` is written to RECEIVE a fenced txn
 * (the "L4 wires this in" seam), so it can be unit/real-DB tested in isolation now and adopted verbatim by
 * L4 later.
 *
 * EXACT BIGINT (design lock §1.1): `seq`/`trusted_since_seq` are int8; the pg driver returns them as decimal
 * STRINGS. Every seq value crosses this module's boundary as a string; comparison is native SQL bigint
 * (`<= $n::bigint`) or exact `BigInt(...)` in TS. `Number`, `parseInt`, unary `+`, and subtraction
 * comparators are FORBIDDEN for seq — a >2^53 seq would collapse in float64.
 */

// ── seq string discipline (exact bigint, no float) ──────────────────────────────────────────────────────

/** A decimal, non-negative integer string — the only shape a seq/boundary may take in TS (§1.1). */
export function isSeqString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value)
}

export class SeqComparatorError extends Error {
  readonly code = 'comparator_error' as const
  constructor(message: string) {
    super(message)
    this.name = 'SeqComparatorError'
  }
}

/** Fail-closed guard: throws `SeqComparatorError` (never coerces to zero) on a non-decimal-integer seq. */
export function assertSeqString(value: unknown, context: string): asserts value is string {
  if (!isSeqString(value)) {
    throw new SeqComparatorError(`${context}: expected a decimal integer seq string, got ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`)
  }
}

/** Exact seq ordering via BigInt — never Number()/parseInt/subtraction (those collapse above 2^53). */
export function compareSeq(a: string, b: string): -1 | 0 | 1 {
  assertSeqString(a, 'compareSeq(a)')
  assertSeqString(b, 'compareSeq(b)')
  const av = BigInt(a)
  const bv = BigInt(b)
  return av < bv ? -1 : av > bv ? 1 : 0
}

// ── types ───────────────────────────────────────────────────────────────────────────────────────────────

export type CheckpointState = 'building' | 'active' | 'superseded'

/** Recognized server-owned system-sheet kinds (denormalized onto a checkpoint at activation). */
export const SYSTEM_SHEET_KINDS = ['people_directory', 'approval_projection'] as const
export type SystemSheetKind = (typeof SYSTEM_SHEET_KINDS)[number]

export interface TrustCheckpointRow {
  id: string
  sheetId: string
  state: CheckpointState
  /** decimal string — exact bigint, never Number() */
  trustedSinceSeq: string
  trustedFromAt: Date | null
  systemKind: string | null
  prunedAt: Date | null
}

// ── txn-safe existence probe (rolling-deploy safe) ──────────────────────────────────────────────────────

let trustCheckpointTablePresent = false
/**
 * Txn-safe existence probe for `meta_history_trust_checkpoints`. Mirrors `hasVersionMarkerTable`'s
 * information_schema pattern (never throws 42P01), so a caller inside a transaction can gate on the table's
 * presence during the pre-migration rolling-deploy window and fail CLOSED instead of poisoning the txn.
 */
export async function hasTrustCheckpointTable(query: QueryFn): Promise<boolean> {
  if (trustCheckpointTablePresent) return true
  const res = await query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_name = 'meta_history_trust_checkpoints' AND table_schema = ANY(current_schemas(false)) LIMIT 1`,
  )
  if ((res.rows as unknown[]).length > 0) {
    trustCheckpointTablePresent = true
    return true
  }
  return false
}

function mapCheckpointRow(row: Record<string, unknown>): TrustCheckpointRow {
  const seq = row.trusted_since_seq
  assertSeqString(seq, 'mapCheckpointRow.trusted_since_seq') // driver returns int8 as string; fail closed if not
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    state: row.state as CheckpointState,
    trustedSinceSeq: seq,
    trustedFromAt: row.trusted_from_at instanceof Date ? row.trusted_from_at : row.trusted_from_at ? new Date(String(row.trusted_from_at)) : null,
    systemKind: typeof row.system_kind === 'string' ? row.system_kind : null,
    prunedAt: row.pruned_at instanceof Date ? row.pruned_at : row.pruned_at ? new Date(String(row.pruned_at)) : null,
  }
}

const SELECT_CHECKPOINT_COLS = `id, sheet_id, state, trusted_since_seq::text AS trusted_since_seq, trusted_from_at, system_kind, pruned_at`

// ── activation (the L4-wire seam) ───────────────────────────────────────────────────────────────────────

export interface ActivateCheckpointResult {
  checkpointId: string
  /** decimal string — the allocated trusted_since_seq */
  trustedSinceSeq: string
  baselineCount: number
}

/**
 * Activate a new trust checkpoint for a sheet — the cutover. **L4 WIRES THIS IN**: this function RECEIVES an
 * already-fenced transaction handle (`tx`), it does NOT acquire the canonical sheet fence itself. When L4
 * lands, the reset/revert/cutover path will `BEGIN → canonical fence → activateCheckpoint(tx, …)`; until then
 * it is exercised in isolation by opening a txn (optionally holding the fence) in tests. Nothing here is wired
 * into the live restore/execute path.
 *
 * Protocol (design lock §3, one fenced transaction):
 *   1. allocate `trusted_since_seq := nextval('meta_record_chain_seq')` — occupy a real position in the one
 *      causal seq domain (every post-cutover write gets a higher seq under the same fence);
 *   2. insert the checkpoint in `building`;
 *   3. snapshot all live + recoverable-trash rows into `meta_history_baselines`;
 *   4. supersede the prior `active` checkpoint (if any) for this sheet;
 *   5. flip `building → active`, stamping `trusted_from_at = clock_timestamp()` (NOT `now()`, which is
 *      txn-start) — the atomic flip trips the partial-unique if a second activation is racing.
 *
 * `system_kind` is derived SERVER-SIDE from the sheet's own `meta_sheets.system_kind`; it is never a caller
 * argument, so a client/request cannot forge it (design lock §3/§6 G-SYSTEM-KIND).
 *
 * Caller MUST run this inside a transaction (it performs multiple statements that must be all-or-nothing). It
 * returns the new checkpoint id + the allocated seq (as a string).
 */
export async function activateCheckpoint(tx: QueryFn, input: { sheetId: string }): Promise<ActivateCheckpointResult> {
  const { sheetId } = input

  // 1. allocate the trusted-since seq from the shared causal sequence (::text — exact bigint string).
  const seqRes = await tx(`SELECT nextval('meta_record_chain_seq')::text AS seq`)
  const trustedSinceSeq = (seqRes.rows[0] as { seq: unknown }).seq
  assertSeqString(trustedSinceSeq, 'activateCheckpoint.nextval')

  // system_kind derived server-side from the sheet (never a caller value → non-forgeable).
  const kindRes = await tx('SELECT system_kind FROM meta_sheets WHERE id = $1', [sheetId])
  const systemKind = typeof (kindRes.rows[0] as { system_kind?: unknown } | undefined)?.system_kind === 'string'
    ? String((kindRes.rows[0] as { system_kind: string }).system_kind)
    : null

  // 2. insert building checkpoint.
  const insRes = await tx(
    `INSERT INTO meta_history_trust_checkpoints (sheet_id, state, trusted_since_seq, system_kind)
     VALUES ($1, 'building', $2::bigint, $3)
     RETURNING id`,
    [sheetId, trustedSinceSeq, systemKind],
  )
  const checkpointId = String((insRes.rows[0] as { id: unknown }).id)

  // 3. snapshot baselines: all live rows, then recoverable-trash rows (live wins on a record_id collision).
  await tx(
    `INSERT INTO meta_history_baselines (checkpoint_id, sheet_id, record_id, data, version, is_trashed)
     SELECT $1, sheet_id, id, data, version, false FROM meta_records WHERE sheet_id = $2`,
    [checkpointId, sheetId],
  )
  // P1-b: a record that went through several delete/restore cycles has MULTIPLE trash rows. The old
  // "insert all + ON CONFLICT DO NOTHING" froze an ARBITRARY (physical-order) vintage — a stale snapshot.
  // Select the LATEST vintage DETERMINISTICALLY by the causal `seq` of the delete revision that produced each
  // trash row (`meta_records_trash.delete_revision_id → meta_record_revisions.seq`, exact SQL bigint ORDER BY
  // — never Number()). `DISTINCT ON (record_id) … ORDER BY record_id, r.seq DESC` keeps only the newest-delete
  // row per record. The JOIN is INNER, so a trash row whose vintage CANNOT be causally attributed (no
  // `delete_revision_id`, or the delete revision was retention-swept) is EXCLUDED — fail-closed, never
  // silently frozen (design lock §3). ON CONFLICT still yields to the live row captured above.
  await tx(
    `INSERT INTO meta_history_baselines (checkpoint_id, sheet_id, record_id, data, version, is_trashed)
     SELECT DISTINCT ON (t.record_id) $1, t.sheet_id, t.record_id, t.data, t.original_version, true
     FROM meta_records_trash t
     JOIN meta_record_revisions r
       ON r.id = t.delete_revision_id AND r.sheet_id = t.sheet_id AND r.record_id = t.record_id AND r.action = 'delete'
     WHERE t.sheet_id = $2
     ORDER BY t.record_id, r.seq DESC, t.deleted_at DESC, t.id DESC
     ON CONFLICT (checkpoint_id, record_id) DO NOTHING`,
    [checkpointId, sheetId],
  )
  const countRes = await tx('SELECT count(*)::int AS c FROM meta_history_baselines WHERE checkpoint_id = $1', [checkpointId])
  const baselineCount = Number((countRes.rows[0] as { c: number }).c)

  // 4. supersede the prior active checkpoint for this sheet (moves it out of the partial-unique domain).
  await tx(`UPDATE meta_history_trust_checkpoints SET state = 'superseded' WHERE sheet_id = $1 AND state = 'active'`, [sheetId])

  // 5. flip building → active under the fence; clock_timestamp() = the real activation instant (NOT now() =
  //    txn-start). The write to state='active' trips uq_..._one_active if a concurrent activation is racing.
  await tx(
    `UPDATE meta_history_trust_checkpoints
     SET state = 'active', activated_at = clock_timestamp(), trusted_from_at = clock_timestamp()
     WHERE id = $1`,
    [checkpointId],
  )

  return { checkpointId, trustedSinceSeq, baselineCount }
}

// ── selection ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Select the latest RETAINED checkpoint whose `trusted_since_seq <= anchorSeq` — the seq-based (exact,
 * load-bearing) recovery selection (design lock §3). Totally ordered by `(trusted_since_seq DESC, id DESC)`
 * so there is NEVER more than one candidate; the `id DESC` tiebreak is deterministic even for two
 * checkpoints that (only in synthetic fixtures) share a `trusted_since_seq`. Retained = not pruned and not
 * still `building`. Comparison is native SQL bigint; `anchorSeq` is bound as a string cast to `::bigint`.
 */
export async function selectCheckpointByAnchorSeq(
  query: QueryFn,
  sheetId: string,
  anchorSeq: string,
): Promise<TrustCheckpointRow | null> {
  assertSeqString(anchorSeq, 'selectCheckpointByAnchorSeq.anchorSeq') // fail-closed on a forged/garbage anchor
  const res = await query(
    `SELECT ${SELECT_CHECKPOINT_COLS}
     FROM meta_history_trust_checkpoints
     WHERE sheet_id = $1 AND state IN ('active', 'superseded') AND pruned_at IS NULL
       AND trusted_since_seq <= $2::bigint
     ORDER BY trusted_since_seq DESC, id DESC
     LIMIT 1`,
    [sheetId, anchorSeq],
  )
  const row = res.rows[0] as Record<string, unknown> | undefined
  return row ? mapCheckpointRow(row) : null
}

/**
 * Select the latest RETAINED checkpoint whose `trusted_from_at <= T` — the DISPLAY/navigation selection. The
 * wall-clock field is display/ops metadata, NOT the recovery authority (design lock §3): destructive recovery
 * must resolve an exact anchorSeq and use {@link selectCheckpointByAnchorSeq}. Same total order + retained
 * predicate as the seq path.
 */
export async function selectCheckpointByT(
  query: QueryFn,
  sheetId: string,
  t: Date | string,
): Promise<TrustCheckpointRow | null> {
  const res = await query(
    `SELECT ${SELECT_CHECKPOINT_COLS}
     FROM meta_history_trust_checkpoints
     WHERE sheet_id = $1 AND state IN ('active', 'superseded') AND pruned_at IS NULL
       AND trusted_from_at IS NOT NULL AND trusted_from_at <= $2
     ORDER BY trusted_since_seq DESC, id DESC
     LIMIT 1`,
    [sheetId, t instanceof Date ? t.toISOString() : t],
  )
  const row = res.rows[0] as Record<string, unknown> | undefined
  return row ? mapCheckpointRow(row) : null
}

// ── retention (anchor-covering) ─────────────────────────────────────────────────────────────────────────

/**
 * The ACTIVE checkpoint's `trusted_since_seq` — observability/belt reference. NOTE (P1-c): this is NOT the
 * retention protection boundary. Protecting only the active checkpoint drops a checkpoint that an older-but-
 * still-legal recovery anchor requires (see `pruneRetainedCheckpoints`). Returns a decimal string, or `null`
 * when there is no active checkpoint.
 */
export async function retentionFloorSeq(query: QueryFn, sheetId: string): Promise<string | null> {
  const res = await query(
    `SELECT trusted_since_seq::text AS s FROM meta_history_trust_checkpoints
     WHERE sheet_id = $1 AND state = 'active' AND pruned_at IS NULL`,
    [sheetId],
  )
  const s = (res.rows[0] as { s?: unknown } | undefined)?.s
  if (s === undefined || s === null) return null
  assertSeqString(s, 'retentionFloorSeq')
  return s
}

/**
 * The RETENTION-COVERING seq for an anchor horizon: `max(seq)` among the retained checkpoint seqs that is
 * `<= oldestLegalAnchorSeq` — i.e. the checkpoint a recovery to the OLDEST still-legal anchor would resolve
 * to (same `seq <= anchor` rule as `selectCheckpointByAnchorSeq`). That checkpoint AND every checkpoint after
 * it must survive retention: every legal anchor (>= oldestLegalAnchorSeq) selects it or a newer one. Exact
 * bigint (`compareSeq` — never `Number()`/`parseInt`/subtraction). Returns `null` when NO retained checkpoint
 * is at-or-below the anchor (nothing older is reachable ⇒ the caller prunes nothing, fail-closed).
 */
export function selectRetentionCoveringSeq(retainedSeqs: readonly string[], oldestLegalAnchorSeq: string): string | null {
  assertSeqString(oldestLegalAnchorSeq, 'selectRetentionCoveringSeq.oldestLegalAnchorSeq')
  let covering: string | null = null
  for (const s of retainedSeqs) {
    assertSeqString(s, 'selectRetentionCoveringSeq.retainedSeq')
    if (compareSeq(s, oldestLegalAnchorSeq) <= 0 && (covering === null || compareSeq(s, covering) > 0)) covering = s
  }
  return covering
}

export interface RetentionPruneResult {
  prunedCount: number
  /** the protected floor actually applied — the anchor-covering checkpoint seq (decimal string), or `null`
   *  (no covering checkpoint ⇒ nothing pruned) */
  protectedFloorSeq: string | null
  /** the active-checkpoint floor at prune time (decimal string) or null — observability only */
  floorSeq: string | null
  /** the anchor horizon the prune was computed against (decimal string) */
  oldestLegalAnchorSeq: string
}

/**
 * Prune (tombstone `pruned_at`) retained checkpoints that NO retained recovery anchor can still need.
 *
 * P1-c: the protected floor is NOT the active checkpoint's seq. Protecting only the active checkpoint drops a
 * checkpoint an older-but-still-legal anchor requires. Counterexample: C1(seq=100), C2(seq=200, active);
 * oldest legal anchor seq = 150. A recovery to 150 selects C1 (latest checkpoint with `seq <= 150`), so C1
 * must survive — active-only protection prunes it. The protected floor is the ANCHOR-COVERING checkpoint
 * `max(seq <= oldestLegalAnchorSeq)` (`selectRetentionCoveringSeq`): that checkpoint AND every checkpoint
 * after it (all reachable by any retained anchor) survive; only checkpoints strictly below it are pruned.
 * Because the covering seq is always `<=` the active floor, the active checkpoint is ALWAYS protected by this
 * SAME cutoff — there is NO separate `state <> 'active'` belt, so reverting to active-only protection genuinely
 * prunes the covering checkpoint and reds the C1/C2 golden. Exact bigint throughout. Caller SHOULD run this
 * inside a transaction.
 */
export async function pruneRetainedCheckpoints(
  tx: QueryFn,
  sheetId: string,
  oldestLegalAnchorSeq: string,
): Promise<RetentionPruneResult> {
  assertSeqString(oldestLegalAnchorSeq, 'pruneRetainedCheckpoints.oldestLegalAnchorSeq')
  const floorSeq = await retentionFloorSeq(tx, sheetId)
  // Retained = selectable checkpoints (active|superseded, not pruned, not still building) — the exact set
  // `selectCheckpointByAnchorSeq` can resolve. `::text` keeps seq an exact bigint string end-to-end.
  const retainedRes = await tx(
    `SELECT trusted_since_seq::text AS s FROM meta_history_trust_checkpoints
     WHERE sheet_id = $1 AND state IN ('active','superseded') AND pruned_at IS NULL`,
    [sheetId],
  )
  const retainedSeqs = (retainedRes.rows as Array<{ s?: unknown }>).map((r) => {
    assertSeqString(r.s, 'pruneRetainedCheckpoints.retainedSeq')
    return r.s
  })
  const protectedFloorSeq = selectRetentionCoveringSeq(retainedSeqs, oldestLegalAnchorSeq)
  if (protectedFloorSeq === null) {
    // No retained checkpoint at-or-below the anchor ⇒ nothing older is reachable ⇒ prune nothing (fail-closed).
    return { prunedCount: 0, protectedFloorSeq: null, floorSeq, oldestLegalAnchorSeq }
  }
  const res = await tx(
    `UPDATE meta_history_trust_checkpoints
     SET pruned_at = clock_timestamp()
     WHERE sheet_id = $1 AND pruned_at IS NULL AND trusted_since_seq < $2::bigint
     RETURNING id`,
    [sheetId, protectedFloorSeq],
  )
  return { prunedCount: (res.rows as unknown[]).length, protectedFloorSeq, floorSeq, oldestLegalAnchorSeq }
}

/** True iff the sheet currently has an `active`, non-pruned trust checkpoint. */
export async function hasActiveTrustCheckpoint(query: QueryFn, sheetId: string): Promise<boolean> {
  if (!(await hasTrustCheckpointTable(query))) return false
  const res = await query(
    `SELECT 1 FROM meta_history_trust_checkpoints WHERE sheet_id = $1 AND state = 'active' AND pruned_at IS NULL LIMIT 1`,
    [sheetId],
  )
  return (res.rows as unknown[]).length > 0
}
