/**
 * W2 — pure/near-pure request/response helpers for the exact-anchor recovery route wiring onto
 * L6 `resolveExactAnchor` + L7 plan classification + L8 `applyExactAnchorRecovery`.
 *
 * WIRED: `univer-meta`'s four recovery surfaces (revert/reset × preview/execute) consume these
 * helpers. The route layer owns flag/confirm gates, canManage + presentation masking, and the
 * primary size-ceiling call at the HTTP edge; env flags remain default-OFF (wiring is not
 * enablement).
 *
 * Destructive authority remains exclusively `resolveExactAnchor` + `applyExactAnchorRecovery`. Free
 * wall-clock `asOf` is never a destructive authority (`exact-anchor-required`, no existence oracle).
 *
 * No-oracle ordering for the preview path:
 *   1. exact request shape (parse — before any DB)
 *   2. full-read adjudication
 *   3. trust substrate (writer fence + contiguity-strict env flags)
 *   4. history integrity via the authoritative production entry `precheckSheetHistoryIntegrity`
 *      (which runs `checkStrictEnablementPrecondition` before any direct strict comparator)
 *   5. exact-anchor resolution
 *   6. live/field plan work (values-free restorable projection summary)
 *   7. finalize: `previewIdentity` is the mint token ONLY when executable; otherwise null
 * An unauthorized actor sees `forbidden` before anchor/size/history details.
 */
import type { QueryFn } from './permission-service'
import {
  resolveExactAnchor,
  type EvaluateRecoveryFullReadAccess,
  type RecoveryAnchorRequest,
  type ResolveAnchorRefusal,
  type ResolveAnchorResult,
} from './exact-anchor-recovery'
import {
  applyExactAnchorRecovery,
  type ExactAnchorApplyRefusal,
  type ExactAnchorApplyResult,
  type ExactAnchorMutationTxnHook,
  type ExactAnchorPlanAuthContext,
  type ExactAnchorRevertWriteIntent,
  type EvaluatePlanAuthorization,
} from './exact-anchor-recovery-execute'
import {
  classifyExactAnchorRecoveryPlan,
  ExactAnchorPlanDataError,
  type ExactAnchorRecoveryPlan,
} from './exact-anchor-recovery-plan'
import type { ExactAnchorRecoveryMode } from './restore-preview-identity'
import { resolveSheetRevertMaxRecords } from './restore-caps'
import {
  isContiguityStrictMode,
  precheckSheetHistoryIntegrity,
} from './history-integrity-precheck'
import { isWriterFenceEnabled } from './canonical-sheet-fence'
import { isFieldAlwaysReadOnly } from './permission-derivation'
import { projectRestorableOntoLive } from './record-restore-diff'
import { isLiveLinkProjectionConsistent } from './live-link-projection-integrity'

export type ExactAnchorBody = {
  historyBatchId?: unknown
  anchorOperationId?: unknown
  /** free wall-clock T — refused for destructive recovery (exact-anchor-required). */
  asOf?: unknown
  previewIdentity?: unknown
  confirm?: unknown
}

/**
 * Parse the request body into a RecoveryAnchorRequest.
 *
 * Accepts exactly one non-blank `historyBatchId` OR `anchorOperationId`. Both present ⇒
 * `validation` (ambiguous — never silently prefer one) before any DB access.
 * ANY nonblank `asOf` ⇒ `exact-anchor-required` (exact-authority only — never silently ignore
 * wall-clock, even when co-present with an exact id). Empty body is the same refusal class.
 */
export function parseRecoveryAnchorRequest(body: ExactAnchorBody):
  | { ok: true; request: RecoveryAnchorRequest }
  | { ok: false; reason: 'validation' | 'invalid-request' | 'exact-anchor-required' } {
  const has = (key: keyof ExactAnchorBody) => Object.prototype.hasOwnProperty.call(body, key)
  if (
    (has('anchorOperationId') && typeof body.anchorOperationId !== 'string') ||
    (has('historyBatchId') && typeof body.historyBatchId !== 'string') ||
    (has('asOf') && typeof body.asOf !== 'string')
  ) {
    return { ok: false, reason: 'invalid-request' }
  }
  const opId = typeof body.anchorOperationId === 'string' ? body.anchorOperationId.trim() : ''
  const batchId = typeof body.historyBatchId === 'string' ? body.historyBatchId.trim() : ''
  const asOf = typeof body.asOf === 'string' ? body.asOf.trim() : ''
  // Ambiguous exact anchors first (both sealed-operation and batch ids).
  if (opId && batchId) return { ok: false, reason: 'validation' }
  // Exact-authority only: any nonblank wall-clock refuses, even with a co-present exact id.
  if (asOf) return { ok: false, reason: 'exact-anchor-required' }
  if (opId) return { ok: true, request: { kind: 'exact-anchor', anchorOperationId: opId } }
  if (batchId) return { ok: true, request: { kind: 'history-batch', historyBatchId: batchId } }
  // Empty / whitespace-only: exact-anchor-required (uniform, no oracle).
  return { ok: false, reason: 'exact-anchor-required' }
}

export type SizeCeilingVerdict =
  | { ok: true; recordCount: number; maxRecords: number }
  | { ok: false; reason: 'too-large'; recordCount: number; maxRecords: number }
  /** Malformed/missing count — fail closed; never fabricate a zero count (ceiling bypass). */
  | { ok: false; reason: 'recovery-trust-required' }

/** Live-sheet size ceiling helper (D3 / PIT-6). Call AFTER full-read so unauthorized actors get no size oracle. */
export async function enforceSheetRecoverySizeCeiling(
  query: QueryFn,
  sheetId: string,
  maxRecords: number = resolveSheetRevertMaxRecords(),
): Promise<SizeCeilingVerdict> {
  const res = await query('SELECT count(*)::int AS c FROM meta_records WHERE sheet_id = $1', [sheetId])
  const raw = (res.rows[0] as { c?: unknown } | undefined)?.c
  // Fail closed on non-safe / non-negative integer counts — never coerce to 0 (that would open the ceiling).
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    return { ok: false, reason: 'recovery-trust-required' }
  }
  if (raw > maxRecords) return { ok: false, reason: 'too-large', recordCount: raw, maxRecords }
  return { ok: true, recordCount: raw, maxRecords }
}

/**
 * Values-free preview plan summary — record/field ids and counts only.
 * NEVER carries targetData / live snapshots / version payloads (HTTP serialization leak surface).
 */
export interface PreviewPlanSummary {
  /** TRUE restorable changed field ids per non-noop revert (projectRestorableOntoLive). */
  reverts: Array<{ recordId: string; fieldIds: string[] }>
  resurrectIds: string[]
  deleteIds: string[]
  /**
   * Effective write set for the secondary ceiling: actual non-noop restorable writes + resurrects
   * + reset deletes. Derived-only / mirror-only plan reverts do not count.
   */
  effectiveWriteCount: number
  /**
   * Records that Revert mode keeps (created after anchor + deleted-at-anchor-but-live-now).
   * Reset mode would delete these instead — count is 0 for reset (they land in `deleteIds`).
   */
  keptCreatedAfterAnchorCount: number
  /** Schema-drift exclusions counted by the L7 classifier (whole-apply refusal at execute). */
  driftCount: number
}

interface PreviewPlanDetails {
  summary: PreviewPlanSummary
  plan: ExactAnchorRecoveryPlan
  revertWrites: ExactAnchorRevertWriteIntent[]
  deleteRecordIds: string[]
}

/** Normalize a link-field cell (array | single | null) to string[] of foreign record ids. */
function normalizeLinkIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

/**
 * Classify the resolved at-anchor state into a VALUES-FREE plan summary for the preview response.
 *
 * Revert `fieldIds` are the TRUE restorable changed set from `projectRestorableOntoLive` against
 * current field types (derived-only and mirror-owned link fields excluded from the projection
 * surface). Do NOT use `Object.keys(targetData)`. Does NOT export the raw L7 plan (targetData/
 * snapshots). May throw `ExactAnchorPlanDataError` on malformed at-anchor/live substrate —
 * callers map that to `recovery-trust-required`.
 */
function buildPreviewPlanDetails(
  stateMap: Map<
    string,
    {
      recordId: string
      exists: boolean
      data: Record<string, unknown> | null
      version: number | null
    }
  >,
  liveById: ReadonlyMap<string, { data: Record<string, unknown>; version: number }>,
  fieldIds: ReadonlySet<string>,
  mode: ExactAnchorRecoveryMode,
  projection: {
    fieldById: ReadonlyMap<string, { type: string }>
    rawTypeById: ReadonlyMap<string, string>
  },
): PreviewPlanDetails {
  const plan = classifyExactAnchorRecoveryPlan(stateMap, liveById, fieldIds)
  const reverts: Array<{ recordId: string; fieldIds: string[] }> = []
  const revertWrites: ExactAnchorRevertWriteIntent[] = []
  for (const r of plan.reverts) {
    const live = liveById.get(r.recordId)
    if (!live) continue
    const projected = projectRestorableOntoLive({
      fieldById: projection.fieldById,
      rawTypeById: projection.rawTypeById,
      targetSnapshot: r.targetData,
      currentData: live.data,
      recordId: r.recordId,
      currentVersion: live.version,
      normalizeLinkIds,
    })
    if (projected.isNoOp) continue
    reverts.push({ recordId: r.recordId, fieldIds: projected.changedFieldIds })
    revertWrites.push({
      recordId: r.recordId,
      liveVersion: r.liveVersion,
      changedFieldIds: projected.changedFieldIds,
      patch: projected.patch,
      projectedData: projected.data,
      linkUpdates: projected.linkUpdates,
    })
  }
  const resurrectIds = plan.resurrects.map((r) => r.recordId)
  const deleteIds = mode === 'reset' ? [...plan.deletedAtAnchorLiveNow, ...plan.createdAfterAnchor] : []
  const effectiveWriteCount = reverts.length + resurrectIds.length + deleteIds.length
  // Revert keeps post-anchor creates + later-resurrected rows; Reset deletes them (see deleteIds).
  const keptCreatedAfterAnchorCount =
    mode === 'revert' ? plan.createdAfterAnchor.length + plan.deletedAtAnchorLiveNow.length : 0
  return {
    summary: {
      reverts,
      resurrectIds,
      deleteIds,
      effectiveWriteCount,
      keptCreatedAfterAnchorCount,
      driftCount: plan.driftCount,
    },
    plan,
    revertWrites,
    deleteRecordIds: deleteIds,
  }
}

export function summarizePreviewPlan(
  stateMap: Map<
    string,
    {
      recordId: string
      exists: boolean
      data: Record<string, unknown> | null
      version: number | null
    }
  >,
  liveById: ReadonlyMap<string, { data: Record<string, unknown>; version: number }>,
  fieldIds: ReadonlySet<string>,
  mode: ExactAnchorRecoveryMode,
  projection: {
    fieldById: ReadonlyMap<string, { type: string }>
    rawTypeById: ReadonlyMap<string, string>
  },
): PreviewPlanSummary {
  return buildPreviewPlanDetails(stateMap, liveById, fieldIds, mode, projection).summary
}

/**
 * Load live rows for preview plan work. Malformed non-object data, arrays, or non-safe /
 * non-negative integer versions fail closed as values-free `recovery-trust-required` — never
 * coerced via `{}` or `Number(...) || 0`.
 */
export async function loadLiveByIdForPreview(
  query: QueryFn,
  sheetId: string,
): Promise<
  | { ok: true; liveById: Map<string, { data: Record<string, unknown>; version: number }> }
  | { ok: false; reason: 'recovery-trust-required' }
> {
  const liveById = new Map<string, { data: Record<string, unknown>; version: number }>()
  const rows = (
    await query('SELECT id, data, version FROM meta_records WHERE sheet_id = $1', [sheetId])
  ).rows as Array<{ id: unknown; data: unknown; version: unknown }>
  for (const r of rows) {
    if (r.data === null || typeof r.data !== 'object' || Array.isArray(r.data)) {
      return { ok: false, reason: 'recovery-trust-required' }
    }
    if (typeof r.version !== 'number' || !Number.isSafeInteger(r.version) || r.version < 0) {
      return { ok: false, reason: 'recovery-trust-required' }
    }
    liveById.set(String(r.id), {
      data: r.data as Record<string, unknown>,
      version: r.version,
    })
  }
  return { ok: true, liveById }
}

function parseFieldProperty(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* ignore malformed property JSON — treat as empty bag */
    }
  }
  return {}
}

/**
 * Load the CURRENT field surface for plan classification + restorable projection.
 * Mirror-owned link fields are excluded from the projection map (spine invariant) but remain in
 * `fieldIds` so schema-drift classification still sees them.
 */
export async function loadFieldSurfaceForPreview(
  query: QueryFn,
  sheetId: string,
): Promise<{
  fieldIds: Set<string>
  fieldById: Map<string, { type: string }>
  rawTypeById: Map<string, string>
  writableLinkFieldIds: Set<string>
}> {
  const res = await query('SELECT id, type, property FROM meta_fields WHERE sheet_id = $1', [sheetId])
  const fieldIds = new Set<string>()
  const fieldById = new Map<string, { type: string }>()
  const rawTypeById = new Map<string, string>()
  const writableLinkFieldIds = new Set<string>()
  for (const r of res.rows as Array<{ id: unknown; type: unknown; property: unknown }>) {
    const id = String(r.id)
    const type = String(r.type ?? '')
    fieldIds.add(id)
    rawTypeById.set(id, type)
    const property = parseFieldProperty(r.property)
    // Exclude only mirror-owned links from the projection surface (same as L8 apply).
    if (type === 'link' && isFieldAlwaysReadOnly({ type, property })) continue
    if (type === 'link') writableLinkFieldIds.add(id)
    fieldById.set(id, { type })
  }
  return { fieldIds, fieldById, rawTypeById, writableLinkFieldIds }
}

/** Thin field-id set helper (delegates to {@link loadFieldSurfaceForPreview}). */
export async function loadFieldIdSet(query: QueryFn, sheetId: string): Promise<Set<string>> {
  const surface = await loadFieldSurfaceForPreview(query, sheetId)
  return surface.fieldIds
}

/** Env-only trust substrate (values-free): writer fence + contiguity-strict must both be on. */
export function checkExactAnchorRecoveryTrust():
  | { ok: true }
  | { ok: false; reason: 'recovery-trust-required' } {
  if (!isWriterFenceEnabled() || !isContiguityStrictMode()) {
    return { ok: false, reason: 'recovery-trust-required' }
  }
  return { ok: true }
}

/**
 * Values-free anchor metadata returned on every successful preview (never the raw stateMap).
 * Intentionally omits signed internal fingerprints such as `scopeHash` (token still binds them).
 */
export interface ExactAnchorPreviewAnchorMeta {
  anchorSeq: string
  checkpointId: string
  anchorOperationId: string
  mode: ExactAnchorRecoveryMode
}

export interface ExactAnchorPreviewSuccess {
  ok: true
  anchor: ExactAnchorPreviewAnchorMeta
  /**
   * HS256 preview identity — present ONLY when `executable` is true.
   * Doomed (resurrection / schema-drift / no-op) plans return `null` so a destructive token cannot leak over HTTP.
   */
  previewIdentity: string | null
  summary: PreviewPlanSummary
  /**
   * false when the plan is doomed (resurrects, schema drift, or no restorable writes).
   * L8 whole-refuses `driftCount > 0`, so drift is never executable at preview either.
   */
  executable: boolean
}

/**
 * Pure finalization of a successful resolve + plan summary.
 * `previewIdentity` is the mint token iff executable; otherwise null (never leaks a doomed token).
 */
export function finalizePreviewSuccess(
  resolved: Extract<ResolveAnchorResult, { ok: true }>,
  summary: PreviewPlanSummary,
): ExactAnchorPreviewSuccess {
  // L8 whole-refuses schema drift (zero writes) — never issue a destructive token for a doomed plan.
  const executable =
    summary.driftCount === 0 &&
    summary.resurrectIds.length === 0 &&
    (summary.reverts.length > 0 || (resolved.mode === 'reset' && summary.deleteIds.length > 0))
  return {
    ok: true,
    anchor: {
      anchorSeq: resolved.anchorSeq,
      checkpointId: resolved.checkpointId,
      anchorOperationId: resolved.anchorOperationId,
      mode: resolved.mode,
    },
    previewIdentity: executable ? resolved.token : null,
    summary,
    executable,
  }
}

/**
 * PREVIEW: resolve exact anchor + restorable plan summary + conditional preview identity.
 * Size ceiling primary gate is the caller's responsibility AFTER full-read (cheap count first);
 * this path re-checks the effective write set after plan projection.
 */
export async function previewExactAnchorRecovery(
  query: QueryFn,
  input: {
    sheetId: string
    request: RecoveryAnchorRequest
    actorId: string
    mode: ExactAnchorRecoveryMode
    evaluateFullReadAccess: EvaluateRecoveryFullReadAccess
    /** Preview-time advisory copy of the authoritative in-fence write gate; execute re-runs it. */
    evaluatePlanAuthorization: EvaluatePlanAuthorization
  },
): Promise<
  | ExactAnchorPreviewSuccess
  | { ok: false; reason: ResolveAnchorRefusal }
  | { ok: false; reason: 'too-large'; recordCount: number; maxRecords: number }
  | { ok: false; reason: 'history-incomplete' }
  | { ok: false; reason: 'recovery-trust-required' }
> {
  // 1. Exact shape — wall-clock never reaches here via parseRecoveryAnchorRequest, but refuse
  //    fail-closed if a caller constructs a wall-clock request directly (no integrity oracle).
  if (input.request.kind === 'wall-clock') {
    return { ok: false as const, reason: 'exact-anchor-required' as const }
  }

  // 2. Full-table-read FIRST among sheet-state adjudications (before trust integrity path, size,
  //    checkpoint, anchor, plan). resolveExactAnchor also re-checks; this blocks history/size
  //    oracles for field/row-denied actors.
  if (!(await input.evaluateFullReadAccess(query))) {
    return { ok: false as const, reason: 'forbidden' as const }
  }

  // 3. Trust substrate: fence + CONTIGUITY_STRICT both required (env-only, values-free).
  if (!checkExactAnchorRecoveryTrust().ok) {
    return { ok: false as const, reason: 'recovery-trust-required' as const }
  }

  // 4. History integrity via the AUTHORITATIVE production entry (NOT precheckSheetHistoryIntegrityStrict
  //    directly — that bypasses checkStrictEnablementPrecondition / RECONSTRUCTION_CAUSALITY_LANDED /
  //    active-checkpoint gating). A real chain failure keeps the established values-free
  //    HISTORY_INCOMPLETE contract; missing/malformed trust substrate remains a separate refusal.
  const integrity = await precheckSheetHistoryIntegrity(query, input.sheetId)
  if (!integrity.ok) return { ok: false as const, reason: 'history-incomplete' as const }

  // 5. Exact-anchor resolution + token mint (token is gated at finalize — not returned when doomed).
  const resolved = await resolveExactAnchor(query, input)
  if (resolved.ok === false) return { ok: false as const, reason: resolved.reason }

  // 6. Live/field plan work — values-free restorable projection summary.
  const liveLoaded = await loadLiveByIdForPreview(query, input.sheetId)
  if (!liveLoaded.ok) return { ok: false as const, reason: 'recovery-trust-required' as const }

  const surface = await loadFieldSurfaceForPreview(query, input.sheetId)
  if (!(await isLiveLinkProjectionConsistent(
    query,
    liveLoaded.liveById,
    surface.writableLinkFieldIds,
  ))) {
    return { ok: false as const, reason: 'recovery-trust-required' as const }
  }
  let details: PreviewPlanDetails
  try {
    details = buildPreviewPlanDetails(
      resolved.stateMap,
      liveLoaded.liveById,
      surface.fieldIds,
      input.mode,
      { fieldById: surface.fieldById, rawTypeById: surface.rawTypeById },
    )
  } catch (e) {
    if (e instanceof ExactAnchorPlanDataError) {
      return { ok: false as const, reason: 'recovery-trust-required' as const }
    }
    throw e
  }

  // Preview must not mint a token that is already known to be unusable. Reuse the SAME route adapter
  // as execute over the true projected delta; execute repeats this check under the canonical fence.
  const previewAuth: ExactAnchorPlanAuthContext = {
    mode: input.mode,
    sheetId: input.sheetId,
    actorId: input.actorId,
    plan: details.plan,
    revertWrites: details.revertWrites,
    deleteRecordIds: details.deleteRecordIds,
  }
  if (!(await input.evaluatePlanAuthorization(query, previewAuth))) {
    return { ok: false as const, reason: 'forbidden' as const }
  }

  const { summary } = details

  // Secondary ceiling on the effective write set (parity with the old T8-1 effective_write_set guard).
  const maxRecords = resolveSheetRevertMaxRecords()
  if (summary.effectiveWriteCount > maxRecords) {
    return {
      ok: false as const,
      reason: 'too-large' as const,
      recordCount: summary.effectiveWriteCount,
      maxRecords,
    }
  }

  // 7. Finalize: executable-only previewIdentity (doomed/no-op never expose a destructive token).
  return finalizePreviewSuccess(resolved, summary)
}

export type PreviewExactAnchorResult = Awaited<ReturnType<typeof previewExactAnchorRecovery>>
export type PreviewExactAnchorFailure = Extract<PreviewExactAnchorResult, { ok: false }>

/**
 * EXECUTE: all-or-nothing apply via L8. Token mode is authoritative (P1-1).
 */
export async function executeExactAnchorRecoveryApply(
  transaction: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>,
  input: {
    token: string
    sheetId: string
    actorId: string
    evaluateFullReadAccess: EvaluateRecoveryFullReadAccess
    evaluatePlanAuthorization: EvaluatePlanAuthorization
    /** optional same-transaction mutation seam (durable event enqueue) — see the L8 module. */
    onMutationApplied?: ExactAnchorMutationTxnHook
  },
): Promise<ExactAnchorApplyResult> {
  return applyExactAnchorRecovery(transaction, input)
}

/** Map parse-shape refusals to HTTP-ish code + status (before any DB). */
export function mapParseRefusal(
  reason: 'validation' | 'invalid-request' | 'exact-anchor-required',
): { status: number; code: string; message: string } {
  if (reason === 'invalid-request') {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'historyBatchId, anchorOperationId, and asOf must be strings when present.',
    }
  }
  if (reason === 'validation') {
    return {
      status: 400,
      code: 'AMBIGUOUS_ANCHOR',
      message:
        'Provide exactly one of historyBatchId or anchorOperationId; both present is ambiguous and refused.',
    }
  }
  return mapResolveRefusal('exact-anchor-required')
}

/** Map resolve refusals to HTTP-ish code + status for the four routes. */
export function mapResolveRefusal(reason: ResolveAnchorRefusal): { status: number; code: string; message: string } {
  switch (reason) {
    case 'exact-anchor-required':
      return {
        status: 400,
        code: 'EXACT_ANCHOR_REQUIRED',
        message:
          'Destructive recovery requires a server-resolved exact anchor (historyBatchId or anchorOperationId); free wall-clock asOf is refused.',
      }
    case 'invalid-anchor':
      return {
        status: 400,
        code: 'INVALID_ANCHOR',
        message: 'anchorOperationId is not a well-formed sealed operation id.',
      }
    case 'unknown-anchor':
      return {
        status: 404,
        code: 'UNKNOWN_ANCHOR',
        message: 'No sealed operation endpoint exists for this anchor on the sheet.',
      }
    case 'no-covering-checkpoint':
      return {
        status: 409,
        code: 'NO_COVERING_CHECKPOINT',
        message: 'No active trust checkpoint covers this anchor; activate a trust checkpoint before recovery.',
      }
    case 'history-incomplete':
      return mapHistoryIncompleteRefusal()
    case 'forbidden':
      return {
        status: 403,
        code: 'FORBIDDEN',
        message: 'Full-table read access is required for sheet-wide exact-anchor recovery.',
      }
    default: {
      const _exhaustive: never = reason
      return _exhaustive
    }
  }
}

/** Values-free HTTP envelope for the trust substrate refusal. */
export function mapRecoveryTrustRefusal(): { status: number; code: string; message: string } {
  return {
    status: 409,
    code: 'RECOVERY_TRUST_REQUIRED',
    message:
      'Exact-anchor recovery trust is unavailable or invalid; verify the canonical writer fence, strict history mode, and active checkpoint before retrying. Nothing was written and no token was minted.',
  }
}

/** Values-free HTTP envelope for a concrete incomplete/inconsistent history chain. */
export function mapHistoryIncompleteRefusal(): { status: number; code: string; message: string } {
  return {
    status: 409,
    code: 'HISTORY_INCOMPLETE',
    message:
      'Record history for this sheet is incomplete or inconsistent with its live data; destructive recovery is refused and nothing was written. History must be trustworthy before revert/reset can run.',
  }
}

/** Map apply refusals to HTTP-ish code + status. Covers every current ExactAnchorApplyRefusal. */
export function mapApplyRefusal(reason: ExactAnchorApplyRefusal): { status: number; code: string; message: string } {
  switch (reason) {
    case 'identity-invalid':
      return {
        status: 409,
        code: 'PREVIEW_IDENTITY_INVALID',
        message: 'Recovery preview identity rejected; the sheet changed since preview — re-preview.',
      }
    case 'token-replayed':
      return {
        status: 409,
        code: 'PREVIEW_IDENTITY_INVALID',
        message: 'This recovery token was already used; re-preview to obtain a fresh identity.',
      }
    case 'forbidden':
      return {
        status: 403,
        code: 'FORBIDDEN',
        message: 'Full-table read access is required for sheet-wide exact-anchor recovery.',
      }
    case 'no-covering-checkpoint':
      return {
        status: 409,
        code: 'NO_COVERING_CHECKPOINT',
        message: 'No active trust checkpoint covers this anchor; activate a trust checkpoint before recovery.',
      }
    case 'checkpoint-changed':
      return {
        status: 409,
        code: 'CHECKPOINT_CHANGED',
        message: 'The covering trust checkpoint changed since preview; re-preview.',
      }
    case 'preview-drift':
      return {
        status: 409,
        code: 'PREVIEW_IDENTITY_INVALID',
        message: 'The sheet changed since preview; nothing written — re-preview.',
      }
    case 'schema-drift':
      return {
        status: 422,
        code: 'SCHEMA_DRIFT',
        message: 'Schema drift blocks whole-sheet exact-anchor recovery; nothing written.',
      }
    case 'inbound-unprovable':
      return {
        status: 409,
        code: 'INBOUND_UNPROVABLE',
        message:
          'Exact-anchor undelete/resurrection is refused: at-anchor inbound link state cannot be proven. Until an at-anchor inbound reconstruction authority exists, resurrection stays fail-closed (absence of terminal tombstones is not proof).',
      }
    case 'link-integrity':
      return {
        status: 409,
        code: 'LINK_INTEGRITY',
        message:
          'Outbound link reconstruction failed closed (missing foreign sheet target, missing foreign record, or link schema); nothing was written.',
      }
    case 'value-invalid':
      return {
        status: 422,
        code: 'VALUE_INVALID',
        message:
          'A restored value is invalid under the current schema; exact-anchor recovery is all-or-nothing and nothing was written.',
      }
    case 'record-locked':
      return {
        status: 409,
        code: 'RECORD_LOCKED',
        message:
          'A target record is locked; exact-anchor recovery is all-or-nothing and nothing was written. Unlock and re-preview.',
      }
    case 'history-incomplete':
      return mapHistoryIncompleteRefusal()
    case 'recovery-trust-required':
      return mapRecoveryTrustRefusal()
    default: {
      const _exhaustive: never = reason
      return _exhaustive
    }
  }
}

/** Collapse a failed previewExactAnchorRecovery result into HTTP status/code/message. */
export function httpForPreviewFailure(
  failure: PreviewExactAnchorFailure,
  kind: 'revert' | 'reset',
): { status: number; code: string; message: string } {
  if (failure.reason === 'too-large') {
    return {
      status: 413,
      code: 'SHEET_TOO_LARGE',
      message: `This ${kind} would touch ${failure.recordCount} records, above the ${failure.maxRecords}-record ${kind} ceiling; a sheet-wide ${kind} of this size is refused.`,
    }
  }
  if (failure.reason === 'recovery-trust-required') {
    return mapRecoveryTrustRefusal()
  }
  if (failure.reason === 'history-incomplete') {
    return mapHistoryIncompleteRefusal()
  }
  return mapResolveRefusal(failure.reason)
}

/** Map {@link enforceSheetRecoverySizeCeiling} failures to values-free HTTP envelopes. */
export function mapSizeCeilingFailure(
  failure: Extract<SizeCeilingVerdict, { ok: false }>,
  kind: 'revert' | 'reset',
): { status: number; code: string; message: string } {
  if (failure.reason === 'recovery-trust-required') return mapRecoveryTrustRefusal()
  return {
    status: 413,
    code: 'SHEET_TOO_LARGE',
    message: `This ${kind} would touch ${failure.recordCount} records, above the ${failure.maxRecords}-record ${kind} ceiling; a sheet-wide ${kind} of this size is refused.`,
  }
}
