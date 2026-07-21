import type { QueryFn } from './permission-service'
import { assertSeqString, selectCheckpointByAnchorSeq } from './history-trust-checkpoint'
import { reconstructRecordsAtSeq, type RecordStateAtT } from './record-reconstructor'
import {
  hashAnchorRecoveryScope,
  hashExactAnchorSchema,
  hashRecoveryAuthorizationScope,
  mintExactAnchorRecoveryIdentity,
  verifyExactAnchorRecoveryIdentity,
  type ExactAnchorRecoveryMode,
} from './restore-preview-identity'

/**
 * W0-1 v3.7 Lane L6-b — the EXACT-ANCHOR recovery resolution + execute authority.
 *
 * Design authority: `…v37-exact-anchor-trust-design-lock-20260715.md` (#4331) §1.3 (exact recovery anchor
 * resolution), §0/P2-B (why a wall-clock `T` / a mutable `MAX(seq)` is NOT a trustworthy anchor), §9 item 6
 * (sealed operation ledger; server-minted, exact anchorSeq frozen in a signed identity). Owner-ratified design.
 *
 * THE PROTOCOL (§1.3):
 *   PREVIEW  `resolveExactAnchor`:
 *     opaque `anchorOperationId` (the sealed operation endpoint id, L6-a — NEVER a wall-clock `T`, NEVER a
 *     client-supplied seq) OR a History-Center `historyBatchId` resolved server-side to the batch's sealed
 *     terminal operation (owner ruling ⑤; unsealed/legacy ⇒ refused, ruling ⑧) → the immutable endpoint row
 *     in `meta_record_history_operations` → `anchorSeq = endpoint_seq` (exact bigint string) → the active
 *     trust checkpoint (L5) whose `trusted_since_seq <= anchorSeq` → FULL-READ adjudication (P1-2) →
 *     reconstruct the record set at `anchorSeq` (the causal `reconstructRecordsAtSeq`) → FREEZE
 *     {sheetId, anchorOperationId, anchorSeq, checkpointId, actorId, mode, authorizedScopeHash, scopeHash}
 *     into an HS256-signed preview identity (`exact-anchor-recovery.ts` reuses the server token-signing helper
 *     in `restore-preview-identity.ts` — no new crypto).
 *   EXECUTE  `executeExactAnchorRecovery`:
 *     verify the signed identity (signature + expiry + sheet/actor binding) → take the TOKEN-BOUND `anchorSeq`
 *     → reconstruct at exactly that seq (never `MAX(seq)`) → re-hash the reconstructed set and reject on drift.
 *     The token's `anchorSeq` is the sole recovery authority; the execute NEVER re-derives it.
 *
 * WALL-CLOCK REFUSAL (§1.3, values-free / no-oracle): a destructive-recovery request that carries a free
 * wall-clock `T` instead of an exact `anchorOperationId` or server-resolved `historyBatchId` is REFUSED
 * `exact-anchor-required` BEFORE any DB access — the
 * refusal is identical whether the sheet/data exists or not, so it leaks nothing. Manual-datetime navigation of
 * a read-only point-in-time VIEW still uses `T` (`reconstructRecordsAtT`, v3.7 §9.2) — that is display, not the
 * destructive authority; only the destructive recovery authority is anchor-only.
 *
 * WIRED / DEFAULT-OFF: this module is the recovery anchor AUTHORITY used by the four Revert/Reset routes. It
 * performs no destructive write itself; L8 apply remains behind the existing default-OFF
 * `MULTITABLE_ENABLE_SHEET_REVERT` / `MULTITABLE_ENABLE_PIT_RESET` flags. Preview resolution is read-only but
 * still requires the conservative full-read gate and recovery trust pair before an execute token is minted.
 */

/** A recovery ANCHOR request. Discriminated so the wall-clock branch is refused by construction (§1.3). */
export type RecoveryAnchorRequest =
  /** the sealed operation endpoint id DIRECTLY (`meta_record_history_operations.operation_id`). */
  | { kind: 'exact-anchor'; anchorOperationId: string }
  /** a History-Center BATCH selection (the S1 user-action `batch_id`). The server resolves it to the batch's
   *  sealed TERMINAL operation on this sheet — MAX `endpoint_seq` (owner ruling ⑤, 2026-07-16). A batch with
   *  NO sealed operation (legacy / unsealed) is refused `exact-anchor-required`, NEVER given a wall-clock
   *  fallback (ruling ⑧). */
  | { kind: 'history-batch'; historyBatchId: string }
  /** a free wall-clock `T` — REFUSED for destructive recovery (`exact-anchor-required`). */
  | { kind: 'wall-clock'; asOf: string }

export type ResolveAnchorRefusal =
  /** the request carried a wall-clock `T` (refused, no DB access), OR a history-batch with no sealed terminal
   *  operation (legacy/unsealed — ruling ⑧: uniform refusal, no wall-clock fallback, no existence oracle:
   *  an unknown batch and an unsealed batch refuse identically). */
  | 'exact-anchor-required'
  /** `anchorOperationId` is not a well-formed sealed-operation endpoint id (uuid). */
  | 'invalid-anchor'
  /** no sealed operation endpoint exists for (sheet, anchorOperationId) — an unknown/forged anchor. */
  | 'unknown-anchor'
  /** no active/retained trust checkpoint covers the anchor (`trusted_since_seq <= anchorSeq`) — fail-closed. */
  | 'no-covering-checkpoint'
  /** the checkpoint baseline or current live-set identity contains malformed server-side data. */
  | 'history-incomplete'
  /** the actor fails the v1 FULL-READ authorization (owner P1-2 — U-L8 gate shape): the whole surface is
   *  refused BEFORE any anchor/batch resolution, so an unauthorized actor learns nothing (not even whether
   *  the anchor exists). */
  | 'forbidden'

/**
 * The kernel's REQUIRED authorization dependency (owner P1-2): evaluates whether the acting principal has
 * FULL-TABLE READ on the sheet (the 4c-1 U-L8 gate — CONFIG-derived axes only, never a data probe; see
 * `hasFullTableReadAccess` in the univer-meta route, which is the production evaluator and closes over the
 * request/capability context the kernel cannot reach). The ADJUDICATION lives HERE in the kernel — the
 * evaluator only answers the capability question; the kernel refuses `forbidden` on preview AND re-evaluates
 * in-fence at the destructive apply. There is no default and no way to omit it: a caller must hand the kernel
 * an evaluator to get a token at all.
 */
export type EvaluateRecoveryFullReadAccess = (query: QueryFn) => Promise<boolean>

export interface ResolveAnchorSuccess {
  ok: true
  /** the HS256-signed preview identity — presented back at execute. */
  token: string
  /** the exact causal anchor (decimal bigint string) — the sealed operation's `endpoint_seq`. */
  anchorSeq: string
  /** the covering trust checkpoint id. */
  checkpointId: string
  /** the resolved sealed operation endpoint id (for a history-batch request: the batch's terminal operation). */
  anchorOperationId: string
  /** the recovery mode this preview (and its token) authorizes — bound into the identity (P1-1). */
  mode: ExactAnchorRecoveryMode
  /** order-invariant HMAC over the reconstructed set at the anchor (bound into the token). */
  scopeHash: string
  /** the reconstructed record set at the anchor (the preview the actor sees). */
  stateMap: Map<string, RecordStateAtT>
}
export type ResolveAnchorResult = ResolveAnchorSuccess | { ok: false; reason: ResolveAnchorRefusal }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Order-invariant array form of a reconstructed state map, for `hashAnchorRecoveryScope`. */
export function scopeEntriesOf(stateMap: Map<string, RecordStateAtT>): Array<{ recordId: string; exists: boolean; version: number | null }> {
  return [...stateMap.values()].map((s) => ({ recordId: s.recordId, exists: s.exists, version: s.version }))
}

/** Corrupt checkpoint/live identity is trust failure, never a value to coerce into a signed token. */
export class ExactAnchorHistoryDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExactAnchorHistoryDataError'
  }
}

const requireHistoryRecordId = (value: unknown, source: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new ExactAnchorHistoryDataError(`${source}: invalid record id`)
  return value
}

const requireHistoryData = (value: unknown, source: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExactAnchorHistoryDataError(`${source}: invalid record data`)
  }
  return value as Record<string, unknown>
}

const requireHistoryVersion = (value: unknown, source: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ExactAnchorHistoryDataError(`${source}: invalid record version`)
  }
  return value
}

/**
 * F4 (pre-wiring gate list) — L5 BASELINE COMPOSITION, shared by PREVIEW and APPLY so the two sides are
 * SYMMETRIC BY CONSTRUCTION: records absent from the replay map (their revisions predate the trust floor or
 * were retention-pruned) come from the RESOLVED checkpoint's immutable `meta_history_baselines` rows — a
 * non-trashed baseline row IS that record's at-anchor state; a trashed one means deleted-at-anchor. The
 * replay map always wins (it is at-anchor-exact). Because BOTH the preview's `scopeHash` and the apply's
 * in-fence re-hash are computed over this COMPOSED map, the actor previews EXACTLY the set the apply will
 * plan over — a baseline-only record can no longer appear in the apply without having been shown at preview
 * (what-you-see-is-what-applies). Baseline rows are immutable post-activation and the token binds
 * `checkpointId`; the wired L8 apply re-resolves that checkpoint under the canonical fence before
 * any destructive write. The reconstruction-causality seam is therefore landed, while the runtime
 * Revert/Reset and trust flags remain independent, default-OFF operator gates.
 */
export async function composeBaselineOverlay(
  query: QueryFn,
  input: { sheetId: string; checkpointId: string; stateMap: Map<string, RecordStateAtT> },
): Promise<Map<string, RecordStateAtT>> {
  const baselineRes = await query(
    'SELECT record_id, data, version, is_trashed FROM meta_history_baselines WHERE checkpoint_id = $1 AND sheet_id = $2',
    [input.checkpointId, input.sheetId],
  )
  const composed = new Map<string, RecordStateAtT>(input.stateMap)
  for (const raw of baselineRes.rows as Array<Record<string, unknown>>) {
    const recordId = requireHistoryRecordId(raw.record_id, 'checkpoint baseline')
    if (composed.has(recordId)) continue // replay map wins — it is at-anchor-exact
    if (typeof raw.is_trashed !== 'boolean') throw new ExactAnchorHistoryDataError('checkpoint baseline: invalid trash marker')
    const trashed = raw.is_trashed
    const data = requireHistoryData(raw.data, 'checkpoint baseline')
    const version = requireHistoryVersion(raw.version, 'checkpoint baseline')
    composed.set(recordId, {
      recordId,
      exists: !trashed,
      data: trashed ? null : data,
      version,
    })
  }
  return composed
}

/**
 * PREVIEW: resolve an exact recovery anchor and mint the signed preview identity (§1.3). A wall-clock request is
 * refused `exact-anchor-required` with NO DB access (values-free). The actor is then FULL-READ adjudicated
 * (P1-2) BEFORE any anchor/batch resolution — an unauthorized actor learns nothing. An `anchorOperationId` that
 * is not a uuid → `invalid-anchor`; one with no sealed endpoint → `unknown-anchor`; a history-batch with no
 * sealed terminal operation → `exact-anchor-required` (ruling ⑧); an anchor with no covering trust checkpoint
 * → `no-covering-checkpoint` (fail-closed — a recovery below every trust floor is untrustworthy). On success the
 * anchorSeq comes from the IMMUTABLE endpoint row (`endpoint_seq`), never from a live `MAX(seq)`, and the token
 * binds `mode` + `authorizedScopeHash` (P1-1/P1-2 — the destructive apply obeys the TOKEN, not its request).
 */
export async function resolveExactAnchor(
  query: QueryFn,
  input: {
    sheetId: string
    request: RecoveryAnchorRequest
    actorId: string
    /** the recovery mode this preview authorizes — frozen into the signed identity (P1-1). */
    mode: ExactAnchorRecoveryMode
    /** REQUIRED v1 full-read adjudication dependency (P1-2) — see `EvaluateRecoveryFullReadAccess`. */
    evaluateFullReadAccess: EvaluateRecoveryFullReadAccess
  },
): Promise<ResolveAnchorResult> {
  const { sheetId, request, actorId, mode, evaluateFullReadAccess } = input
  // §1.3 wall-clock refusal — BEFORE any DB read (no-oracle: same refusal regardless of sheet/data existence).
  if (request.kind === 'wall-clock') return { ok: false, reason: 'exact-anchor-required' }

  // P1-2 FULL-READ gate — the FIRST DB-touching step: an actor without full-table read is refused the whole
  // surface here, before the anchor/batch is even looked up (no anchor-existence oracle for the unauthorized).
  if (!(await evaluateFullReadAccess(query))) return { ok: false, reason: 'forbidden' }

  let anchorOperationId: string
  let anchorSeq: string
  if (request.kind === 'history-batch') {
    // Ruling ⑤ resolver: the batch's sealed TERMINAL operation on THIS sheet = MAX endpoint_seq among the
    // sealed operations whose events carry this batch_id. Presence of the endpoint row IS the seal (the
    // ledger inserts the endpoint LAST, same-txn, DEFERRABLE-FK-validated). An unknown batch and a batch
    // with only unsealed/legacy (NULL operation_id) events refuse IDENTICALLY (ruling ⑧, no oracle).
    const historyBatchId = request.historyBatchId
    if (typeof historyBatchId !== 'string' || !historyBatchId) return { ok: false, reason: 'exact-anchor-required' }
    const terminalRes = await query(
      `SELECT o.operation_id::text AS operation_id, o.endpoint_seq::text AS endpoint_seq
       FROM meta_record_history_operations o
       WHERE o.sheet_id = $1
         AND o.operation_id IN (
           SELECT r.operation_id FROM meta_record_revisions r
           WHERE r.sheet_id = $1 AND r.batch_id = $2 AND r.operation_id IS NOT NULL
         )
       ORDER BY o.endpoint_seq DESC
       LIMIT 1`,
      [sheetId, historyBatchId],
    )
    const terminal = terminalRes.rows[0] as { operation_id?: unknown; endpoint_seq?: unknown } | undefined
    if (!terminal || typeof terminal.operation_id !== 'string' || typeof terminal.endpoint_seq !== 'string') {
      return { ok: false, reason: 'exact-anchor-required' }
    }
    anchorOperationId = terminal.operation_id
    anchorSeq = terminal.endpoint_seq
  } else {
    const requested = request.anchorOperationId
    if (typeof requested !== 'string' || !UUID_RE.test(requested)) return { ok: false, reason: 'invalid-anchor' }
    // The sealed operation endpoint is the exact, externally-visible commit boundary (L6-a). anchorSeq is its
    // FROZEN endpoint_seq — read as `::text` so it crosses the boundary as an exact bigint string.
    const endpointRes = await query(
      `SELECT endpoint_seq::text AS endpoint_seq
       FROM meta_record_history_operations
       WHERE sheet_id = $1 AND operation_id = $2::uuid`,
      [sheetId, requested],
    )
    const endpoint = endpointRes.rows[0] as { endpoint_seq?: unknown } | undefined
    if (!endpoint || typeof endpoint.endpoint_seq !== 'string') return { ok: false, reason: 'unknown-anchor' }
    anchorOperationId = requested
    anchorSeq = endpoint.endpoint_seq
  }
  assertSeqString(anchorSeq, 'resolveExactAnchor.endpoint_seq') // fail-closed; endpoint_seq is a DB bigint

  // The active trust checkpoint covering the anchor (L5). No covering checkpoint ⇒ fail-closed (a recovery to an
  // anchor below every trust floor is untrustworthy — v3.7 §3).
  const checkpoint = await selectCheckpointByAnchorSeq(query, sheetId, anchorSeq)
  if (!checkpoint) return { ok: false, reason: 'no-covering-checkpoint' }

  // Reconstruct the record set at the exact anchor (causal, seq-based), COMPOSE the L5 baseline overlay
  // (F4 — the preview must show exactly the set the apply will plan over), and bind the COMPOSED set into
  // the token.
  const replayMap = await reconstructRecordsAtSeq(query, sheetId, anchorSeq)
  let stateMap: Map<string, RecordStateAtT>
  try {
    stateMap = await composeBaselineOverlay(query, { sheetId, checkpointId: checkpoint.id, stateMap: replayMap })
  } catch (error) {
    if (error instanceof ExactAnchorHistoryDataError) return { ok: false, reason: 'history-incomplete' }
    throw error
  }
  const scopeHash = hashAnchorRecoveryScope(scopeEntriesOf(stateMap))
  // W0-1 L8 preview-freshness binding: fingerprint the LIVE set {id, version} too (same order-invariant
  // HMAC primitive, exists:true). The destructive apply re-hashes the live set IN-FENCE and refuses
  // `preview-drift` when a concurrent write landed between preview and execute — the anchor-authority
  // `scopeHash` alone cannot see that (the at-anchor reconstruction is immutable under append-only history).
  const liveRes = await query('SELECT id, version FROM meta_records WHERE sheet_id = $1', [sheetId])
  let liveEntries: Array<{ recordId: string; exists: true; version: number }>
  try {
    liveEntries = (liveRes.rows as Array<{ id: unknown; version: unknown }>).map((r) => ({
      recordId: requireHistoryRecordId(r.id, 'live recovery identity'),
      exists: true,
      version: requireHistoryVersion(r.version, 'live recovery identity'),
    }))
  } catch (error) {
    if (error instanceof ExactAnchorHistoryDataError) return { ok: false, reason: 'history-incomplete' }
    throw error
  }
  const liveSetHash = hashAnchorRecoveryScope(liveEntries)
  // G-SCHEMA-BEFORE-FENCE: bind CURRENT semantic field surface (id/type/property) into the identity.
  // Apply recomputes under the fence and refuses schema-drift on retype / property drift / field add-drop.
  const schemaRes = await query('SELECT id, type, property FROM meta_fields WHERE sheet_id = $1', [sheetId])
  const schemaHash = hashExactAnchorSchema(
    (schemaRes.rows as Array<{ id: unknown; type: unknown; property: unknown }>).map((r) => ({
      id: String(r.id),
      type: String(r.type ?? ''),
      property: r.property,
    })),
  )
  const token = mintExactAnchorRecoveryIdentity({
    sheetId,
    anchorOperationId,
    anchorSeq,
    checkpointId: checkpoint.id,
    scopeHash,
    liveSetHash,
    schemaHash,
    actorId,
    mode,
    // P1-2: the authorization CONTRACT is signed in. The apply recomputes this from its OWN in-fence
    // adjudication and compares — the mint here records which contract the preview was authorized under.
    authorizedScopeHash: hashRecoveryAuthorizationScope({ sheetId, actorId }),
  })
  return { ok: true, token, anchorSeq, checkpointId: checkpoint.id, anchorOperationId, mode, scopeHash, stateMap }
}

export type ExecuteAnchorRefusal =
  /** the signed identity failed verification (tampered/expired/wrong sheet or actor/malformed anchor). */
  | 'identity-invalid'
  /** the actor fails the FRESH full-read adjudication at execute time, or the token's `authorizedScopeHash`
   *  does not match the recomputed v1 authorization basis (P1-2 — permission revoked since preview, or a
   *  token minted under a different authorization contract). Values-free, one reason for both. */
  | 'forbidden'
  /** the reconstructed set at the token-bound anchorSeq no longer matches what the preview signed (data moved
   *  since preview, OR — the load-bearing mutation surface — the execute recomputed the anchor as MAX(seq)). */
  | 'scope-drift'
  /** checkpoint baseline corruption discovered while rebuilding the token-bound target. */
  | 'history-incomplete'

export interface ExecuteAnchorSuccess {
  ok: true
  /** the TOKEN-BOUND anchor used to reconstruct (decimal bigint string) — never a recomputed MAX(seq). */
  anchorSeq: string
  checkpointId: string
  /** the TOKEN-BOUND recovery mode (P1-1) — the apply obeys this, never a request-supplied mode. */
  mode: ExactAnchorRecoveryMode
  /** the reconstructed record set at the token-bound anchor — the exact plan a Revert/Reset apply consumes. */
  stateMap: Map<string, RecordStateAtT>
}
export type ExecuteAnchorResult = ExecuteAnchorSuccess | { ok: false; reason: ExecuteAnchorRefusal }

/**
 * EXECUTE (the read/authority half — the destructive apply stays behind the default-OFF Revert/Reset flags).
 * Verify the signed identity, then reconstruct at the TOKEN-BOUND `anchorSeq` and re-check the scope hash. The
 * anchorSeq is taken verbatim from the verified token — the execute NEVER recomputes `MAX(seq)` as authority
 * (that mutable value drifts the moment any write lands; §0/P2-B). A drift between the token's `scopeHash` and
 * the live reconstruction → `scope-drift` (re-preview); this is exactly what reds if the execute is mutated to
 * anchor on `MAX(seq)` instead of the frozen `anchorSeq`. `sheetId`/`actorId` are re-bound fresh from the
 * request so a token can never be replayed onto another sheet or by another actor.
 */
export async function executeExactAnchorRecovery(
  query: QueryFn,
  input: { token: string; sheetId: string; actorId: string; evaluateFullReadAccess: EvaluateRecoveryFullReadAccess },
): Promise<ExecuteAnchorResult> {
  const verified = verifyExactAnchorRecoveryIdentity(input.token, { sheetId: input.sheetId, actorId: input.actorId })
  if (!verified.valid || !verified.claims) return { ok: false, reason: 'identity-invalid' }
  const { anchorSeq, checkpointId, scopeHash, mode, authorizedScopeHash } = verified.claims

  // P1-2: FRESH full-read adjudication at execute time — permission revoked since preview ⇒ refused; and
  // the token's authorization contract must MATCH this surface's recomputed v1 basis (the token's echo is
  // never the authority). Both failure shapes collapse into one values-free `forbidden`.
  if (!(await input.evaluateFullReadAccess(query))) return { ok: false, reason: 'forbidden' }
  if (authorizedScopeHash !== hashRecoveryAuthorizationScope({ sheetId: input.sheetId, actorId: input.actorId })) {
    return { ok: false, reason: 'forbidden' }
  }

  // Reconstruct at the TOKEN-BOUND anchorSeq — the sole authority. NOT MAX(seq), NOT the request — then
  // compose the SAME baseline overlay the preview hashed (F4 symmetry; checkpointId is token-bound).
  const replayMap = await reconstructRecordsAtSeq(query, input.sheetId, anchorSeq)
  let stateMap: Map<string, RecordStateAtT>
  try {
    stateMap = await composeBaselineOverlay(query, { sheetId: input.sheetId, checkpointId, stateMap: replayMap })
  } catch (error) {
    if (error instanceof ExactAnchorHistoryDataError) return { ok: false, reason: 'history-incomplete' }
    throw error
  }
  const liveScopeHash = hashAnchorRecoveryScope(scopeEntriesOf(stateMap))
  if (liveScopeHash !== scopeHash) return { ok: false, reason: 'scope-drift' }

  return { ok: true, anchorSeq, checkpointId, mode, stateMap }
}
