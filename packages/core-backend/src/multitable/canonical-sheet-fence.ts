/**
 * W0-1 Lane L4 — the canonical per-sheet write fence.
 *
 * Design authority: `docs/development/multitable-w0-1-v36-unified-revision-design-lock-20260715.md`
 * §4.1 (canonical fence convergence) + §4.2 (all-writer matrix), aligned forward to the v3.7 lock
 * (`…v37-exact-anchor-trust-design-lock-20260715.md`) §2 (L4 canonical sheet-state fence) and §9 items 4
 * (fence) and 5 (in-fence execute). PROPOSED design; this module is DEFAULT-OFF (see `isWriterFenceEnabled`).
 *
 * WHY ONE FENCE (v3.6 §0.2-i, the bug this lane fixes): before L4 the auto-number feature held
 * `pg_advisory_xact_lock(hashtext('meta:auto-number:sheet:'||sheetId))` while PIT reset-execute held a
 * DISJOINT lock `pg_advisory_xact_lock(PIT_RECOVERY_LOCK_NS::int, hashtext(sheetId)::int)`. Two disjoint
 * advisory locks do NOT exclude each other, so a destructive recovery ran CONCURRENTLY with ordinary
 * writers — the whole causal-`seq` guarantee (allocation order == commit order within a sheet) silently
 * evaporated. L4 converges every `meta_records` writer onto ONE canonical fence so that the PG `seq`
 * allocation order equals the per-sheet commit order.
 *
 * KEY IS PRESERVED (v3.6 §4.1, v3.7 §2.1): the lock KEY string `meta:auto-number:sheet:${sheetId}` is the
 * SAME one the auto-number feature already used. We rename/generalise the HELPER (moved here, neutral
 * module) but NEVER the key — a new key would let an old instance (still holding the auto-number key) and a
 * new instance (holding a new key) pass each other during a rolling deploy, reopening the very race L4
 * closes.
 *
 * FLAG-OFF PARITY: with `MULTITABLE_ENABLE_WRITER_FENCE` off, the ONLY callers of `acquireCanonicalSheetFence`
 * are the pre-existing unconditional call sites (REST/plugin create, form submit, auto-number backfill) —
 * byte-identical to current main. Every NEW fence acquisition and every durable-block check added by L4 is
 * gated behind the flag. The migration adds a nullable `meta_sheets.recovery_writer_state` column (schema
 * change — NOT "byte-identical", per v3.6 §6 G-FLAG-OFF), but at runtime with the flag off the column is
 * never written and never read.
 */

export type FenceQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * The canonical per-sheet write-fence advisory-lock key. PRESERVED verbatim from the auto-number feature —
 * do NOT change this string (see module doc: rolling-deploy mutual-exclusion).
 */
export function canonicalSheetFenceKey(sheetId: string): string {
  return `meta:auto-number:sheet:${sheetId}`
}

/**
 * Acquire the canonical per-sheet write fence for the CURRENT transaction/connection. `pg_advisory_xact_lock`
 * is transaction-scoped: it is released only at COMMIT/ROLLBACK, so it must be taken as the first statement
 * of the writer's own transaction. Unconditional (no flag gate) so the pre-existing create/form/backfill
 * callers keep byte-identical behaviour; the L4 flag gates only the NEWLY-fenced writers via `fenceWriterEntry`.
 */
export async function acquireCanonicalSheetFence(query: FenceQuery, sheetId: string): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(sheetId)])
}

/**
 * Multi-sheet ordering (v3.6 §4.1 / v3.7 §2.1: "any future operation touching multiple sheet states acquires
 * all canonical fences in sorted sheet-id order"). Deduplicates and sorts by sheet_id so every caller acquires
 * in the SAME order — the standard deadlock-avoidance discipline for taking N locks. Used by a future
 * multi-sheet restore (single-sheet recovery today calls `acquireCanonicalSheetFence` directly).
 */
export async function acquireCanonicalSheetFencesInOrder(
  query: FenceQuery,
  sheetIds: readonly string[],
): Promise<string[]> {
  const ordered = [...new Set(sheetIds)].filter((s) => typeof s === 'string' && s.length > 0).sort()
  for (const sid of ordered) {
    await acquireCanonicalSheetFence(query, sid)
  }
  return ordered
}

/**
 * Durable writer-blocking states committed onto `meta_sheets.recovery_writer_state` by a recovery operation.
 * While the sheet carries one of these, a fenced writer that acquires the fence and observes the state must
 * refuse/park (see `assertNoActiveWriterBlock`). NULL = no block.
 *
 * - `fencing`         — recovery is claiming the sheet (pre-apply hand-off window).
 * - `applying`        — recovery is mutating across more than one transaction; the advisory fence alone is
 *                       released between those transactions, so the block MUST be durable to hold writers off.
 * - `paused_retryable`— a multi-step recovery failed part-way; the sheet stays blocked (recoverable, NOT a
 *                       stuck absorbing state — a re-run/operator clear resolves it; see release protocol).
 */
export const WRITER_BLOCK_STATES = ['fencing', 'applying', 'paused_retryable'] as const
export type WriterBlockState = (typeof WRITER_BLOCK_STATES)[number]

export function isWriterBlockState(v: unknown): v is WriterBlockState {
  return typeof v === 'string' && (WRITER_BLOCK_STATES as readonly string[]).includes(v)
}

/** Thrown by a fenced writer that observes a durable recovery block. Values-free (no state details leaked to
 * the client beyond the coarse code); callers map it to a 409-class refusal. */
export class SheetWriterBlockedError extends Error {
  readonly code = 'SHEET_WRITER_BLOCKED'
  readonly sheetId: string
  readonly state: WriterBlockState
  constructor(sheetId: string, state: WriterBlockState) {
    super(`Sheet is temporarily locked for writes by a recovery operation`)
    this.name = 'SheetWriterBlockedError'
    this.sheetId = sheetId
    this.state = state
  }
}

/** L4 master gate. Default OFF. Same `String(env).trim().toLowerCase()==='true'` resolution as the recovery
 * flags. When off, none of the NEW fence/block machinery runs and behaviour is byte-identical to current main. */
export function isWriterFenceEnabled(): boolean {
  return String(process.env.MULTITABLE_ENABLE_WRITER_FENCE ?? '').trim().toLowerCase() === 'true'
}

// Cached probe for the L4 blocking-state column, mirroring the codebase's txn-safe `hasChainSeqColumns`
// pattern (record-history-service.ts). A missing column ⇒ the L4 migration has not been deployed ⇒ no
// recovery could ever have committed a block ⇒ treat as "no block" (correct fail-open on a not-yet-deployed
// feature — this is a concurrency gate, not a security gate; the durable block only EXISTS once the column
// exists). Reset in tests via `__resetRecoveryWriterStateColumnProbe`.
let recoveryWriterStateColumnCache: boolean | null = null
export function __resetRecoveryWriterStateColumnProbe(): void {
  recoveryWriterStateColumnCache = null
}
async function hasRecoveryWriterStateColumn(query: FenceQuery): Promise<boolean> {
  if (recoveryWriterStateColumnCache !== null) return recoveryWriterStateColumnCache
  const res = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'meta_sheets' AND column_name = 'recovery_writer_state' LIMIT 1`,
  )
  recoveryWriterStateColumnCache = (res.rows as unknown[]).length > 0
  return recoveryWriterStateColumnCache
}

/**
 * FENCE-BEFORE-CHECK read of the durable block. The caller MUST already hold the canonical fence on THIS
 * connection: the fence serialises the writer against the recovery's claim transaction, so once the writer
 * holds the fence the recovery's `applying` write is either not-yet-started (writer wins, no block) or
 * fully committed and visible (writer observes it). Reading the state BEFORE acquiring the fence is a TOCTOU:
 * the writer could read NULL, then block on the fence while the recovery commits `applying`, then proceed
 * against a sheet that is now blocked. Throws `SheetWriterBlockedError` when a block is present.
 */
export async function assertNoActiveWriterBlock(query: FenceQuery, sheetId: string): Promise<void> {
  if (!(await hasRecoveryWriterStateColumn(query))) return
  const res = await query('SELECT recovery_writer_state FROM meta_sheets WHERE id = $1', [sheetId])
  const raw = (res.rows[0] as { recovery_writer_state?: unknown } | undefined)?.recovery_writer_state
  if (isWriterBlockState(raw)) throw new SheetWriterBlockedError(sheetId, raw)
}

/**
 * The standard L4 entry for a writer that did NOT previously take the fence. Flag-gated: with the L4 flag off
 * this is a no-op (byte-identical). With it on: acquire the canonical fence (first), THEN check the durable
 * block (fence-before-check). `bypassBlockCheck` is for the recovery holder's OWN internal writes — they take
 * the fence for seq-ordering but must not refuse against the block THEY committed.
 */
export async function fenceWriterEntry(
  query: FenceQuery,
  sheetId: string,
  opts?: { bypassBlockCheck?: boolean },
): Promise<void> {
  if (!isWriterFenceEnabled()) return
  await acquireCanonicalSheetFence(query, sheetId)
  if (!opts?.bypassBlockCheck) await assertNoActiveWriterBlock(query, sheetId)
}

/**
 * Claim the durable writer-block for a MULTI-transaction recovery (revert-execute). MUST run while holding the
 * canonical fence on THIS connection (the caller acquires it first, in the same claim transaction). Sets
 * `applying`. RECLAIMS a prior failed run's `paused_retryable` (so that state is recoverable, never a stuck
 * absorbing state — [[feedback_state_machine_no_stuck_absorbing_state]]); REFUSES (throws
 * `SheetWriterBlockedError`) only when another recovery is actively holding the sheet (`applying`/`fencing`).
 */
export async function claimDurableWriterBlock(query: FenceQuery, sheetId: string): Promise<void> {
  if (!(await hasRecoveryWriterStateColumn(query))) return
  const res = await query('SELECT recovery_writer_state FROM meta_sheets WHERE id = $1', [sheetId])
  const raw = (res.rows[0] as { recovery_writer_state?: unknown } | undefined)?.recovery_writer_state
  if (raw === 'applying' || raw === 'fencing') throw new SheetWriterBlockedError(sheetId, raw)
  await query("UPDATE meta_sheets SET recovery_writer_state = 'applying' WHERE id = $1", [sheetId])
}

/**
 * Set (or clear, with `state === null`) the durable writer-block on a sheet. MUST be called while holding the
 * canonical fence in the same transaction (the caller acquires it first). Returns the number of rows updated
 * (0 ⇒ sheet not found). Column-probed for forward safety.
 */
export async function setRecoveryWriterState(
  query: FenceQuery,
  sheetId: string,
  state: WriterBlockState | null,
): Promise<number> {
  if (!(await hasRecoveryWriterStateColumn(query))) return 0
  const res = await query(
    'UPDATE meta_sheets SET recovery_writer_state = $2 WHERE id = $1',
    [sheetId, state],
  )
  return typeof res.rowCount === 'number' ? res.rowCount : 0
}
