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

/** Exact bigint minimum, returned as the original string (no numeric round-trip). */
export function minSeq(a: string, b: string): string {
  return compareSeq(a, b) <= 0 ? a : b
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
  await tx(
    `INSERT INTO meta_history_baselines (checkpoint_id, sheet_id, record_id, data, version, is_trashed)
     SELECT $1, sheet_id, record_id, data, original_version, true FROM meta_records_trash WHERE sheet_id = $2
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

// ── retention (floor-clamped) ───────────────────────────────────────────────────────────────────────────

/**
 * The retention floor for a sheet = the ACTIVE checkpoint's `trusted_since_seq`. Retention must never prune
 * below it (dropping the active checkpoint or its baseline would leave nothing to reconstruct from). Returns
 * a decimal string, or `null` when there is no active checkpoint.
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
 * Clamp a requested retention cutoff seq at the floor: the effective "prune everything with
 * `trusted_since_seq < cutoff`" boundary may never exceed the active checkpoint's `trusted_since_seq`
 * (the floor). Exact bigint min (`minSeq`). When there is no active checkpoint (`floorSeq === null`) nothing
 * is protectable, so we fail CLOSED and return `'0'` — a cutoff below every positive seq, i.e. prune nothing.
 */
export function clampRetentionCutoffToFloor(requestedCutoffSeq: string, floorSeq: string | null): string {
  assertSeqString(requestedCutoffSeq, 'clampRetentionCutoffToFloor.requestedCutoffSeq')
  if (floorSeq === null) return '0'
  return minSeq(requestedCutoffSeq, floorSeq)
}

export interface RetentionPruneResult {
  prunedCount: number
  /** the cutoff actually applied after clamping (decimal string) */
  clampedCutoffSeq: string
  /** the active-checkpoint floor at prune time (decimal string) or null */
  floorSeq: string | null
}

/**
 * Prune (tombstone `pruned_at`) retained checkpoints below a requested cutoff, CLAMPED at the active floor.
 * The active checkpoint is protected SOLELY by the clamp (`clampedCutoffSeq <= floorSeq`, and the active
 * checkpoint's `trusted_since_seq == floorSeq`, so `floorSeq < clampedCutoffSeq` is never true) — there is no
 * separate `state <> 'active'` belt masking the clamp, so removing the clamp genuinely prunes the active
 * checkpoint and reds the floor golden. Caller SHOULD run this inside a transaction.
 */
export async function pruneRetainedCheckpoints(
  tx: QueryFn,
  sheetId: string,
  requestedCutoffSeq: string,
): Promise<RetentionPruneResult> {
  const floorSeq = await retentionFloorSeq(tx, sheetId)
  const clampedCutoffSeq = clampRetentionCutoffToFloor(requestedCutoffSeq, floorSeq)
  const res = await tx(
    `UPDATE meta_history_trust_checkpoints
     SET pruned_at = clock_timestamp()
     WHERE sheet_id = $1 AND pruned_at IS NULL AND trusted_since_seq < $2::bigint
     RETURNING id`,
    [sheetId, clampedCutoffSeq],
  )
  return { prunedCount: (res.rows as unknown[]).length, clampedCutoffSeq, floorSeq }
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
