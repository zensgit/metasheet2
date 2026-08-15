/**
 * W4C-2 (#4556) — live and scheduled canonical write boundary (lock sections
 * 8.1/8.2; slice 12.3: live canonical writer, scheduled direct-insert removal,
 * W2/context freeze, atomic legacy projection + shadow result).
 *
 * This module is the `executeAttendanceResultOperation` implementation for the
 * `live_punch` and `scheduled` command kinds. It composes ONLY the W4C-0/W4C-1
 * published machinery (no parallel implementation):
 *
 *  - `normalizeAttendanceSourceOperationEnvelopeV1` (strict envelope),
 *  - `createAuthorizedAttendanceWriteContextV1` (branded witness; minted HERE,
 *    in-process, never from request JSON),
 *  - `runAttendanceResultOperationTransactionV1` (SERIALIZABLE + bounded
 *    40001/40P01 whole-transaction retry),
 *  - `attendanceResultOperationPreflightV1` (steps 1-2: replay / suspended /
 *    claim / legacy-no-operation),
 *  - target identity + class-11 advisory locks, the W4C-1 pure calculator, the
 *    W4C-2 V2 attribution builder, outbox enqueue, and operation seal.
 *
 * Legacy execution stays plugin-owned: the plugin injects `legacyAdapters` ONCE
 * at activate (closures over its own module functions — event INSERT + record
 * upsert + merge lift for live, the absence INSERT..SELECT for scheduled, the
 * W2 in-transaction resolvers, and the frozen-context loader). Routes submit
 * pure data; no route-provided callback or intent is accepted (lock 4.1).
 * W4C-2 remediation P1-3 (#4612 gate finding) made this literally true for the
 * legacy live-punch adapter too: it no longer accepts the opaque, unvalidated,
 * `unknown`-typed per-request bundle the pre-remediation boundary passed
 * through. `AttendanceLivePunchLegacyArgsV1` (below) is a
 * CLOSED, typed projection of the boundary's own already-canonical
 * `AttendanceLivePunchBoundaryInputV1` fields — no route-computed `rule`,
 * `punchWorkDateResolution`, or `settings` crosses into the transaction;
 * `applyLivePunchProjectionLegacyV1` derives all three itself, in-transaction,
 * from those closed fields (see its own module comment in index.cjs). Adapters
 * receive a plugin-shaped `trx` wrapper over the ONE canonical transaction
 * client, so every legacy byte — including that derivation — runs inside the
 * same SERIALIZABLE transaction as the claim/shadow/seal writes.
 *
 * W4C-2 remediation P1 (#4612 gate2 finding, exact-head `ad5541027`, fixed on
 * top of P1-3): P1-3's own in-transaction re-derivation had a latent bug —
 * `deriveLegacyLivePunchAttributionV1` recomputed `calendarWorkDate` from
 * `AttendanceLivePunchLegacyArgsV1.timezone`, but that field is the route's
 * POST-resolution timezone (the WINNING shift's own rule timezone), not the
 * PRE-resolution timezone the route actually fed into its own
 * `resolvePunchWorkDateByShiftWindow` call. Whenever the client omits an
 * explicit `timezone` and the winning shift's rule timezone differs from the
 * org default rule timezone used for the route's first `resolveWorkContext`
 * pass, the two calls receive DIFFERENT inputs and can return DIFFERENT
 * resolutions — reachable with a single client-controlled punch, zero
 * concurrency (see `punchSchema.timezone`). `AttendanceLivePunchLegacyArgsV1`
 * now carries a second, closed `requestTimezone` field that is the exact
 * PRE-resolution value; the adapter's `calendarWorkDate` recompute and its
 * resolver call use ONLY `requestTimezone`, never `timezone` (`timezone`
 * remains reserved for event/record persistence, unchanged from before this
 * fix).
 *
 * Posture matrix (lock 12.3 three-posture gate):
 *  - `legacy_projection_only`: same closed adapters, byte-identical DML and
 *    response; null-ID commands create no operation row, a stable-ID command
 *    claims+seals only its compatibility operation; never a calculation or
 *    outbox row; the caller keeps its existing synchronous best-effort emit.
 *  - effective `shadow`: legacy projection preserved; one shadow calculation
 *    (projection_effect='none') appended; a legacy-only business time is
 *    accepted AND recorded as exactly one zero-segment
 *    `legacy_time_ingress_not_authoritative` review carrying the raw value
 *    plus legacy-parser provenance.
 *  - effective `eligible`/`authoritative`: a legacy-only business time is
 *    rejected BEFORE any event/record/result/effect DML (the whole transaction
 *    rolls back, discarding the preflight claim).
 *  - effective `authoritative` (`live_punch`, Gate D2, #4844): the real
 *    authoritative writer runs — split event INSERT (no legacy records upsert),
 *    fail-closed retirement guard, create-if-absent review placeholder, then
 *    `writeAuthoritativeSegmentCalculationV1` (the D1 core) owns the calc row,
 *    the lineage, and the parent pointer.
 *  - effective `authoritative` (`scheduled`, Gate D3, #4844): BOTH former
 *    fail-closed sites are gone. The org-wide probe site is now a routing
 *    fall-through into the durable run registry (no run/targets/witnesses exist
 *    there yet, so no per-target record and no core call belong at that point);
 *    the per-target site is the real writer — one seam that resolves the parent
 *    guard-first (retirement adjudication dominates every return, including the
 *    present-parent SKIP), the create-if-absent review placeholder, the D2
 *    preimage builder, a scheduled-domain payload fingerprint, and the same D1
 *    core with `entrypoint: 'scheduled'`. `applyScheduledAbsenceLegacy` is
 *    called ZERO times on that branch. D3's distinctive machinery is PER-TARGET
 *    CONTAINMENT: a refusal whose class is in the ONE exported containment table
 *    rolls back to the branch savepoint, CANCELS the claimed operation (the
 *    deferred `trg_aro_claimed_commit_guard` makes committing a still-claimed
 *    operation illegal), records a terminal `'failed'` run outcome, and lets the
 *    batch CONTINUE; everything else rethrows and aborts so recovery/resume
 *    re-attempts the target.
 *    BYTE-NEUTRAL IN PRODUCTION regardless: `effectiveState==='authoritative'`
 *    additionally requires an EXACT-org entry in
 *    `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` (wildcard never counts),
 *    which is unset in production, so every production org collapses to
 *    `legacy` and this branch is unreachable irrespective of DB contents. No
 *    org goes authoritative without a separate, owner-actioned allowlist
 *    change.
 *
 * Values-free discipline: closed codes only; no caller value in any error.
 */
import crypto from 'node:crypto'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceCalculationTargetLocks,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  parseCanonicalAttendanceOrgKeyV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  parseCanonicalAttendanceWorkDateV1,
  resolveSegmentCalculationPosture,
  type VerifiedAttendanceOperationIdentityV1,
  type VerifiedAttendanceOrgIdentityV1,
} from './w4c0-identity'
import {
  ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
  createAuthorizedAttendanceWriteContextV1,
  recheckAttendanceActorLivenessInTransactionV1,
  type AuthorizedAttendanceWriteContextV1,
} from './w4c0-authorization'
import {
  attendanceResultOperationPreflightV1,
  cancelAttendanceResultOperationV1,
  enqueueAttendanceResultEventOutboxV1,
  isRetryableSqlState,
  runAttendanceResultOperationTransactionV1,
  sealAttendanceResultOperationV1,
} from './w4c0-operation-registry'
import { AttendanceW4OperationError } from './w4c0-operation-contract'
import {
  normalizeAttendanceSourceOperationEnvelopeV1,
  type NormalizedAttendanceSourceOperationEnvelopeV1,
} from './w4c0-source-commands'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceBusinessKeyFingerprintV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
  type AttendanceInputProvenanceRefV1,
} from './w4c0-fingerprints'
import { parseAttendanceInstantMsV1 } from './w4c1-strict-time'
import {
  ATTENDANCE_DAILY_STATUSES_V1,
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  calculateAttendanceSegmentsV1,
  type AttendanceCalculatedSegmentV1,
  type AttendanceDailyStatusV1,
  type AttendanceSegmentCalculationResultV1,
} from './w4c1-segment-calculator'
import {
  computeAttendanceSourceDefinitionFingerprintV1,
  computeAttendanceOuterComparableSourceDefinitionFingerprintV1,
} from './w4c1-fingerprints'
import {
  isAttendanceProjectionOwnerV1,
  type AttendanceProjectionOwnerV1,
} from './w7-provenance-domain'
import type {
  AttendanceAttributionSnapshotV1,
  ApprovedAttendanceFactV1,
  AttendanceEvidenceV1,
  FrozenAttendanceContextV1,
} from './w4c0-write-boundary-types'
import { buildFrozenWorkDateAttributionV2 } from './w4c2-frozen-attribution'
import {
  createOrResumeAttendanceScheduledRunV1,
  finalizeAttendanceScheduledRunV1,
  recordAttendanceScheduledRunTargetOutcomeV1,
  requireAttendanceScheduledRunRunningBeforeSourceDmlV1,
  resumeAttendanceScheduledRunByExactIdV1,
  type AttendanceScheduledRunMemberInputV1,
  type AttendanceScheduledRunMembershipResolverV1,
} from './w4c2-scheduled-run'
import {
  computeAttendanceW4ShadowDiff,
  type AttendanceW4ComparableDailyProjection,
} from '../services/AttendanceW4CalculationDetail'
import { isExpectedAttendanceShadowDifferenceV1 } from './w4c2-shadow-expected-differences'
// Gate D2 (#4556 / #4844) — the authoritative live-punch writer's collaborators.
import {
  AttendanceW4AuthoritativeCalculationError,
  writeAuthoritativeSegmentCalculationV1,
  type AttendanceAuthoritativeParentPreimageV1,
} from './w4c2-authoritative-calculation-core'
// The CANONICAL compatibility-fingerprint producer, shared byte-for-byte with import/rollback.
// Never hand-rolled here, and never modeled on ops-retirement's separate 6-field
// `dailyFingerprint` (a different, domainless digest — reconciling those two is out of scope).
import { computeAttendanceImportRollbackPreimageFingerprintV1 } from './w4c3a-import-rollback'
// Gate D3 (#4556 / #4844) imports the ERROR CLASS as well as the guard: the scheduled per-target
// containment predicate discriminates by CLASS IDENTITY, never by `error.name` (spoofable) and
// never by enumerating code strings (enumeration does not converge).
import {
  AttendanceW4OpsRetirementError,
  assertParentNotRetiredForAuthoritativePunchV1,
} from './w4c3c-ops-retirement'

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class AttendanceW4LiveScheduledBoundaryError extends Error {
  readonly code: string
  readonly httpStatus: number
  constructor(code: string, httpStatus = 422) {
    super(code)
    this.name = 'AttendanceW4LiveScheduledBoundaryError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

function boundaryFail(code: string, httpStatus = 422): never {
  throw new AttendanceW4LiveScheduledBoundaryError(code, httpStatus)
}

// ---------------------------------------------------------------------------
// Gate D3 (#4556 / #4844) — the scheduled per-target CONTAINMENT membership authority.
//
// The authoritative `scheduled` writer runs once per target inside its own transaction, inside a
// batch loop that has no try/catch today. The D1 core refuses with a closed enumeration of typed
// product codes and the boundary retirement guard refuses with its own two; none of those is a
// retryable SQLSTATE, so without containment ONE refused target would abort every remaining target
// in the run. The durable run registry has exactly one failure slot built for this
// (`{terminalOutcome:'failed', failureReasonCode:'ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED'}`),
// and a `'failed'` outcome is terminal by construction: excluded from the resume outstanding set,
// from finalization's not-ready check, and from both fold counters.
//
// MEMBERSHIP IS MECHANICAL, NOT PROSE: `(a)` the error carries a non-empty string `code` (a product
// code, never a raw SQLSTATE object or a bare `Error`) AND `(b)` it is an instance of a class in the
// ONE table below. The table is WALKED by a test, so adding a class here automatically extends the
// per-class proof rather than silently widening an undescribed predicate.
//
// DELIBERATE, STATED OVER-BREADTH: `AttendanceW4OpsRetirementError` also carries
// `ATTENDANCE_RECORD_NOT_FOUND`, `ATTENDANCE_RECORD_VERSION_CONFLICT`,
// `W4C3C_OPS_RETIREMENT_REPLAY_CONFLICT`, `W4C3C_OPS_RETIREMENT_OPERATION_ID_REQUIRED` and
// `W4C3C_OPS_RETIREMENT_DATABASE_RESULT_INVALID`, none of which the scheduled writer can reach today
// (it calls only that module's two `assert*` helpers). Containing by CLASS is therefore wider than
// the two reachable codes. That widening fails toward "this one target is marked failed and the
// batch continues" rather than "the whole batch aborts", which is the intended direction — recorded
// here rather than left as an unstated reachability argument that rots the moment a future call is
// added to this branch.
//
// WHAT IS DELIBERATELY *NOT* CONTAINED (fail-closed default; see the per-bucket table on the writer
// branch): `AttendanceW4LiveScheduledBoundaryError` (our own 500-class
// `W4C2_AUTHORITATIVE_PARENT_UNRESOLVED` is potentially transient — abort so recovery/resume
// re-attempts the target instead of burning it terminally), `AttendanceW4OperationError` (org
// suspension is run-wide, not per-target), raw pg errors including 40001/40P01 (absorbed by the two
// retry layers), and anything else.
export const ATTENDANCE_W4C2_SCHEDULED_CONTAINED_REFUSAL_CLASSES_V1 = Object.freeze([
  AttendanceW4AuthoritativeCalculationError,
  AttendanceW4OpsRetirementError,
] as const)

/**
 * The ONLY containment predicate for the scheduled authoritative per-target branch.
 *
 * Never `.name` matching: `index.cjs`'s `W4_ERROR_NAMES` dispatch uses `error.name` ONLY because it
 * crosses a CJS/ESM module boundary where the class identity is not shared. Inside this package the
 * constructor identity is available and is not spoofable by an attacker-shaped object literal.
 */
export function isAttendanceScheduledContainedRefusalV1(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string' || code.length === 0) return false
  return ATTENDANCE_W4C2_SCHEDULED_CONTAINED_REFUSAL_CLASSES_V1.some((cls) => error instanceof cls)
}

// ---------------------------------------------------------------------------
// Scheduled run initiators.
//
// W4C-2 caller cutover (owner ruling 2026-07-28, "(b-narrow)"): the run
// identity itself is no longer derived here. `deriveAttendanceScheduledRunIdV1`
// (the held branch's UUIDv5-over-(initiator,orgId,workDate) derivation) is
// RETIRED — section 1.1's "must not survive implementation" rule — because
// `runId` is now always the server-minted `attendance_scheduled_runs.run_id`
// row `createOrResumeAttendanceScheduledRunV1` (w4c2-scheduled-run.ts)
// produces (a fresh `gen_random_uuid()` per run-creation `INSERT`, re-read on
// resume), never recomputed from these three fields.
// ---------------------------------------------------------------------------

const SCHEDULED_INITIATORS = Object.freeze(['cron', 'admin_run'] as const)
export type AttendanceScheduledRunInitiatorV1 = (typeof SCHEDULED_INITIATORS)[number]

// ---------------------------------------------------------------------------
// Plugin-shaped transaction wrapper (adapters expect `query -> rows[]`).
// ---------------------------------------------------------------------------

export interface AttendancePluginShapedTrxV1 {
  query(sqlText: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>
  readonly __w4CanonicalTrx: true
}

function pluginShapedTrx(client: AttendanceW4TransactionClientV1): AttendancePluginShapedTrxV1 {
  return {
    __w4CanonicalTrx: true,
    async query(sqlText: string, params?: unknown[]) {
      const result = await client.query(sqlText, params ?? [])
      return result.rows
    },
  }
}

// ---------------------------------------------------------------------------
// Legacy adapters (injected once at plugin activate — never per request).
// ---------------------------------------------------------------------------

/** W2 resolution result subset the boundary consumes (full winner opt-in). */
export interface AttendanceW4ResolvedCandidateV1 {
  readonly kind: 'resolved' | 'ambiguous' | 'unresolved'
  readonly workDate?: string
  readonly shiftId?: string
  readonly reasonCode?: string
  readonly fullWinner?: {
    readonly workDate: string
    readonly shiftId: string
    readonly source: string
    readonly assignmentId: string | null
    readonly isOvernight: boolean
    readonly timezone?: string
    readonly workStartTime?: string
    readonly workEndTime?: string
    readonly absoluteWindow: { readonly startAt: Date; readonly endAt: Date }
    readonly attributionWindow: { readonly startAt: Date; readonly endAt: Date }
  } | null
  readonly attributionTailMinutes?: number
  readonly approvedOvertimeWindows?: ReadonlyArray<{
    readonly requestId: string
    readonly approvedEndAt: string | Date
    readonly anchor: unknown
  }>
}

/**
 * W4C-2 remediation P1-3 (#4612 gate finding, confirmed author self-report):
 * the CLOSED, typed argument shape `applyLivePunchLegacy` receives — every
 * field here is either a canonical top-level field the boundary ALREADY
 * carries on `AttendanceLivePunchBoundaryInputV1` (never a route-computed
 * "prepared plan"), or something the adapter derives ITSELF, in-transaction,
 * from these fields (`rule`, `punchWorkDateResolution`, `settings` — see
 * `applyLivePunchProjectionLegacyV1` in index.cjs). There is no opaque
 * `unknown`-typed payload and no route-supplied prepared value crossing this
 * boundary anymore; no production identifier named after the removed field
 * remains anywhere in this module or in index.cjs after this remediation.
 *
 * W4C-2 remediation P1 (#4612 gate2 finding, exact-head `ad5541027`): the
 * P1-3 landing above set `timezone` to the boundary's own POST-resolution
 * field and let the in-transaction re-derivation use IT to recompute
 * `calendarWorkDate` — but the route's own resolver call that PRODUCED the
 * resolution being re-derived was fed the PRE-resolution timezone, not the
 * post-resolution one. `requestTimezone` (below) closes that gap: it is the
 * exact PRE-resolution value, carried through unmodified from
 * `AttendanceLivePunchBoundaryInputV1.requestTimezone`. `timezone` remains
 * the post-resolution value reserved for event/record persistence bytes
 * (unchanged); `deriveLegacyLivePunchAttributionV1` in index.cjs must read
 * ONLY `requestTimezone` to recompute `calendarWorkDate` and re-invoke the
 * resolver.
 */
export interface AttendanceLivePunchLegacyArgsV1 {
  readonly userId: string
  readonly orgId: string
  readonly workDate: string
  /** Route-resolved instant (ISO, always offset-bearing) — same as occurredAtResolved. */
  readonly occurredAt: string
  readonly eventType: 'check_in' | 'check_out'
  readonly source: string
  readonly location: unknown
  readonly meta: unknown
  /** POST-resolution timezone — event/record persistence ONLY. Do not use to recompute `calendarWorkDate`. */
  readonly timezone: string
  /** PRE-resolution timezone the route fed its own resolver call — the ONLY field `deriveLegacyLivePunchAttributionV1` may use to recompute `calendarWorkDate`. */
  readonly requestTimezone: string
  readonly isWorkday: boolean
}

export interface AttendanceW4LiveScheduledLegacyAdaptersV1 {
  /**
   * P01/P02 verbatim transaction body: event INSERT -> record lock -> frozen
   * V1 attribution meta -> upsert -> merge lift. MUST generate any random IDs
   * inside itself (the SERIALIZABLE wrapper may re-run the whole closure).
   * The merge lift is invoked only after the upsert returned the record row —
   * the P3-3 "record row exists" guarantee lives inside this adapter. The
   * adapter derives `rule`/`punchWorkDateResolution`/`settings` itself, in
   * this same transaction, from the closed args below (P1-3 remediation).
   */
  applyLivePunchLegacy(trx: AttendancePluginShapedTrxV1, args: AttendanceLivePunchLegacyArgsV1): Promise<{
    event: Record<string, unknown>
    record: Record<string, unknown>
    workDateResolution: unknown
  }>
  /**
   * Gate D2 (#4556 / #4844): the SPLIT half of `applyLivePunchLegacy` — exactly its
   * `attendance_events` `INSERT ... RETURNING *`, nothing else. The AUTHORITATIVE live-punch
   * branch calls THIS (durable punch evidence + the wire `event`) and never the legacy adapter,
   * because on that path the D1 core owns the `attendance_records` row and the legacy daily
   * upsert must not run. Deliberately a SEPARATE injected seam rather than a `recordsUpsert`
   * flag on `applyLivePunchLegacy`: the flag form would make the authoritative path's
   * zero-invocation spy on `applyLivePunchLegacy` observe one call and destroy the control-flow
   * pin that proves the writer branch returns before reaching the shadow adapter call site.
   */
  insertLivePunchEvent(
    trx: AttendancePluginShapedTrxV1,
    args: AttendanceLivePunchLegacyArgsV1,
  ): Promise<Record<string, unknown>>
  /**
   * Gate D2 (#4556 / #4844): the `workDateResolution` the WIRE RESPONSE carries — the SAME
   * derivation the legacy adapter uses for the same field (`deriveLegacyLivePunchAttributionV1`'s
   * `punchWorkDateResolution`), so an authoritative punch's response field is shape-identical to a
   * legacy punch's. Deliberately NOT `resolveLiveCandidate`: that call opts into
   * `includeFullWinner`, which adds a `fullWinner` member the public response never carried, so
   * reusing it would silently widen the contract.
   */
  deriveLivePunchWorkDateResolution(
    trx: AttendancePluginShapedTrxV1,
    args: AttendanceLivePunchLegacyArgsV1,
  ): Promise<unknown>
  /** P03/P04 verbatim absence INSERT..SELECT (NOT EXISTS) for the given users. */
  applyScheduledAbsenceLegacy(
    trx: AttendancePluginShapedTrxV1,
    args: { orgId: string; workDate: string; timezone: string; userIds: readonly string[] },
  ): Promise<Array<{ user_id: string }>>
  /**
   * In-transaction W2 live re-resolution (channel 'live', full-winner
   * opt-in). `calendarWorkDate` is deliberately OPTIONAL and omitted by this
   * boundary's own call site (#4612 gate3 P2-1 remediation, canonical freeze
   * semantics judgment §4.1): the boundary's `input.workDate` is a POST-
   * resolution value (the route's OWN prior resolution's output, potentially
   * a DIFFERENT calendar day than the punch's own day for an overnight
   * shift — see `AttendanceLivePunchBoundaryInputV1.workDate`'s doc
   * comment), never a valid resolver input. Passing it through here would
   * reproduce a DIFFERENT W2 call than the route's own and can silently
   * change the resolution for an overnight shift (same defect class the P1
   * fix closed on the legacy sibling branch, `deriveLegacyLivePunchAttributionV1`
   * in index.cjs). The resolver derives the anchor itself from
   * `(occurredAt, timezone)` when the caller omits it — the SAME
   * `toWorkDate` formula the legacy sibling calls explicitly
   * (`attendance-work-date-resolver.cjs` channel='live' derivation) — so
   * there is exactly one derivation formula, shared by both branches.
   * Scheduled re-resolution below is DIFFERENT: its `calendarWorkDate` is
   * the run's own identity byte, not a resolver output, and stays required.
   */
  resolveLiveCandidate(
    trx: AttendancePluginShapedTrxV1,
    args: { orgId: string; userId: string; occurredAt: string; timezone: string; calendarWorkDate?: string },
  ): Promise<AttendanceW4ResolvedCandidateV1>
  /** In-transaction W2 scheduled re-resolution (channel 'scheduled', full-winner opt-in). */
  resolveScheduledCandidate(
    trx: AttendancePluginShapedTrxV1,
    args: { orgId: string; userId: string; timezone: string; calendarWorkDate: string },
  ): Promise<AttendanceW4ResolvedCandidateV1>
  /** Frozen calculation context from the winning shift (null = not buildable -> review). */
  buildShadowFrozenContext(
    trx: AttendancePluginShapedTrxV1,
    args: {
      orgId: string
      userId: string
      workDate: string
      shiftId: string
      timezone: string
      isWorkday: boolean
      holidayKind: string | null
    },
  ): Promise<FrozenAttendanceContextV1 | null>
  /**
   * W7-1b (#4556 comments 5293034619 + 5293478713) — THE ISSUANCE SEAM.
   *
   * Ruling 3 / OD-W7-9 = REPLACE: the posture branch sits upstream of the
   * legacy CONTEXT BUILDER, and every producer routes through ONE seam. This is
   * injected rather than imported so the boundary does not become a second
   * production importer of `w7-resolver/` — the plugin already owns the host
   * port and the plugin-side dependencies (the pure FSER derivation, the
   * canonical producer-key builder, the org-rule loader), and the seam's legacy
   * arm must be handed the caller's OWN plugin-shaped client.
   *
   * `buildShadowFrozenContext` is deliberately kept on this interface: it is the
   * LEGACY arm the seam itself calls, and removing it would hide the byte-for-
   * byte identity of that arm behind the new method.
   */
  issueFrozenContext(
    trx: AttendancePluginShapedTrxV1,
    args: {
      orgId: string
      userId: string
      workDate: string
      shiftId: string
      timezone: string
      isWorkday: boolean
      holidayKind: string | null
      purpose: 'persist' | 'mirror'
    },
  ): Promise<{
    // `blocked` is OD-W7-4(a)'s suspended posture: NO calculation is produced.
    // It is a distinct arm rather than a null context precisely so the caller
    // cannot unwrap it into a review row.
    arm: 'legacy' | 'group' | 'blocked'
    context: FrozenAttendanceContextV1 | null
    reason: string | null
  }>
}

// ---------------------------------------------------------------------------
// Boundary inputs/results.
// ---------------------------------------------------------------------------

export interface AttendanceLivePunchBoundaryInputV1 {
  readonly orgId: string
  readonly userId: string
  /** Client-supplied stable operation UUID, or null (legacy null-ID command). */
  readonly operationId: string | null
  readonly eventType: 'check_in' | 'check_out'
  /** Raw client business-time value (null when the client omitted it). */
  readonly occurredAtRaw: string | null
  /** Route-resolved instant (ISO, always offset-bearing). */
  readonly occurredAtResolved: string
  /**
   * Effective (POST-resolution) timezone the route resolved for this punch —
   * the WINNING shift's own rule timezone when one resolved. Reserved for
   * event/record persistence; the in-transaction legacy re-derivation must
   * NOT use this field to recompute `calendarWorkDate` (see `requestTimezone`
   * below and the module-header P1 remediation note).
   */
  readonly timezone: string
  /**
   * W4C-2 remediation P1 (#4612 gate2 finding, exact-head `ad5541027`): the
   * PRE-resolution timezone — the route's `timezone` local variable's value
   * at the moment it called its own final `resolvePunchWorkDateByShiftWindow`,
   * BEFORE that call's result (`punchWorkDate.timezone`) overwrites it. The
   * closed legacy adapter's in-transaction `calendarWorkDate` recompute and
   * its resolver re-invocation must use ONLY this field — using `timezone`
   * (above) instead reproduces a DIFFERENT resolver call than the route's own
   * and can byte-flip the persisted `workDateResolution` (real fixture, zero
   * concurrency: client tz != winning shift's own rule tz). The two fields
   * diverge exactly when `resolvePunchWorkDateByShiftWindow` resolves a shift
   * AND that shift row's own `timezone` column is non-blank and differs from
   * the PRE-resolution value — see that function's `nextTimezone` (plugin
   * `index.cjs`): it takes the WINNING SHIFT's own rule timezone whenever one
   * is set, unconditionally, WITHOUT re-consulting the client's request body.
   * This means an explicit client-supplied `timezone` does NOT protect
   * against divergence — the client tz can still be overwritten by a
   * differently-timezoned winning shift (this is exactly the gate's
   * zero-concurrency fixture: client `Asia/Tokyo`, winning shift `UTC`). The
   * two fields coincide only when the resolution is unresolved/ambiguous, or
   * when a resolved shift's own timezone column is blank (falls back to the
   * pre-resolution value) or happens to equal it.
   */
  readonly requestTimezone: string
  readonly source: string
  readonly location: unknown
  readonly meta: unknown
  readonly photoFileRef: string | null
  readonly workDate: string
  /**
   * W4C-2 remediation (#4612 gate3 P2-1 self-report ⑥ — lock §8.2 step 7
   * `:1821-1822` reads "candidate identity PLUS source-definition fingerprint
   * equality", not workDate alone): the route's own PRE-transaction winning
   * shift identity — `punchWorkDate.shiftId` — carried through the SAME way
   * `workDate` already is. `null` only when the route's own resolution did
   * NOT resolve a shift at all (the `LIVE_CALENDAR_FALLBACK_WORK_DATE_REASONS`
   * unresolved-fallback branch of `resolvePunchWorkDateByShiftWindow`); the
   * ambiguous case never reaches this boundary (the route responds 422
   * itself). Verified (read, not assumed) against a false-positive risk on an
   * ORDINARY (non-race) punch: the freeze step's in-transaction resolver call
   * omits `calendarWorkDate` and is fed the IDENTICAL `(occurredAt,
   * requestTimezone)` pair the route's own pre-transaction call used to
   * derive its own `calendarWorkDate` — `attendance-work-date-resolver.cjs`
   * derives `calendarWorkDate` via the SAME `toWorkDate(occurredAt,
   * timezone)` formula when the explicit parameter is absent (`:799-803`),
   * `groupAttendanceType` is uniformly omitted on this code path on BOTH
   * sides (`index.cjs` ~L21152), and candidate SELECTION for the 'live'
   * channel depends only on `(occurredAt, calendarWorkDate, DB state)`
   * (`:1006-1031`) — so absent a genuine committed write between the two
   * reads, both calls resolve the identical candidate (`shiftId` included).
   */
  readonly shiftId: string | null
  /**
   * W4C-2 gate3 P2-1 closure (#4612 self-report ⑥, second round): the
   * route's own PRE-transaction source-definition fingerprint, computed via
   * the new `computeOuterSourceDefinitionFingerprintV1` port method over
   * the SAME winning candidate `shiftId` derived alongside. `null` under
   * the identical conditions the port method (and the storage column)
   * returns `null` for — unresolved routes, or a frozen context the route
   * itself could not build (e.g. a >3-segment winning shift). Compared
   * against the freeze step's own in-transaction fingerprint below
   * (`identityDrift`'s fingerprint conjunct) — this is the OUTER half of
   * the lock's step-7 "candidate identity PLUS source-definition
   * fingerprint equality" clause; `shiftId`/`workDate` above are the
   * identity half. Structural note: the fingerprint domain already
   * contains `workDate`/`shiftId` (via `attribution.value`, PLUS
   * `context.shiftId` independently), so any identity drift necessarily
   * also drifts this fingerprint — the two conjuncts are NOT symmetric
   * opposites, but in this schema the identity conjunct's independent
   * value is a PROVEN STRUCTURAL argument, not a constructed leg: see the
   * boundary's own `identityDrift` comment for the CHECK-constraint proof
   * that the one theoretical carve-out (a >3-segment winning shift making
   * BOTH sides' frozen context null) is unreachable via a real DB fixture.
   */
  readonly outerSourceDefinitionFingerprint: string | null
  readonly isWorkday: boolean
  readonly holidayKind: string | null
}

export type AttendanceLivePunchBoundaryResultV1 =
  | { readonly kind: 'legacy'; readonly response: unknown }
  | { readonly kind: 'legacy_compat'; readonly response: unknown }
  | { readonly kind: 'replay'; readonly response: unknown }
  | {
      readonly kind: 'w4'
      readonly response: unknown
      readonly shadow: { readonly calculationId: string | null; readonly outcome: string; readonly outcomeReasonCode: string }
    }

export interface AttendanceScheduledRunBoundaryInputV1 {
  readonly orgId: string
  readonly workDate: string
  readonly timezone: string
  readonly targetUserIds: readonly string[]
  readonly initiator: AttendanceScheduledRunInitiatorV1
  /**
   * Process-local duplicate signal from the plugin caller. It is honored only
   * after this boundary resolves `legacy_projection_only`; W4 postures ignore
   * it and continue through the durable class-01 run protocol.
   */
  readonly legacyDedupHit?: boolean
  /**
   * W4C-2 remediation P1-4 (#4612 gate finding): the real host-authenticated
   * administrator identity for `initiator: 'admin_run'` — plain route-supplied
   * data (the ROUTE already performed its `attendance:admin` permission check
   * before calling in), exactly the `executeLivePunch` precedent at
   * `input.userId`/`actorPosture: 'self'` below: the route hands a validated
   * plain id, the boundary mints the witness FROM it and rechecks it in the
   * per-user transaction via the existing `recheckAttendanceActorLivenessInTransactionV1`
   * chokepoint (w4c0-operation-registry.ts preflight step 1). Required on both
   * branches (never `undefined`) so a cron caller cannot silently omit it and
   * a caller cannot smuggle an admin identity into the cron path: `cron` MUST
   * pass exactly `null`; `admin_run` MUST pass a non-empty string that is not
   * the internal scheduler constant (lock 4.1: "scheduler scope is available
   * only to the registered internal scheduler identity" — read here as also
   * fencing the `scheduled` capability's ACTOR identity, not only the
   * `subjectScope: 'org_scheduler'` shape; recorded as an explicit reading,
   * not a silent assumption, per the prior gate's G-5 note).
   */
  readonly adminActorId: string | null
  readonly isWorkday?: boolean
  readonly holidayKind?: string | null
  /**
   * W4C-2 caller cutover (owner ruling 2026-07-28, "(b-narrow)"): the SAME
   * `reviewRequired` list `runAutoAbsenceForOrgDate` already resolves via
   * `attendance-work-date-resolver.cjs` (unchanged), passed through so the
   * durable run's own target set (w4c2-scheduled-run.ts section 1.2/1.3)
   * covers `review` targets as well as `generate` ones — a run with zero
   * `generate` targets but a nonzero review count still creates and
   * inline-finalizes (section 1.9). Required (never omitted) so a caller
   * cannot silently starve the run of its review half; an org with no
   * review-required users passes an empty array.
   */
  readonly reviewTargets: readonly { readonly userId: string; readonly reasonCode: string }[]
}

export type AttendanceScheduledRunRecoveryBoundaryInputV1 = Omit<
  AttendanceScheduledRunBoundaryInputV1,
  'adminActorId'
> & {
  readonly runId: string
}

export type AttendanceScheduledRunBoundaryResultV1 =
  | { readonly kind: 'legacy'; readonly rows: Array<{ user_id: string }> }
  | { readonly kind: 'legacy_dedup' }
  | { readonly kind: 'suspended' }
  | {
      readonly kind: 'w4'
      readonly runId: string | null
      readonly rows: Array<{ user_id: string }>
      readonly perUser: Array<{
        readonly userId: string
        /**
         * Gate D3 (#4556 / #4844) added `'failed'` — a per-target authoritative refusal the batch
         * CONTAINED (recorded as a terminal `'failed'` run outcome) rather than aborting on. It
         * contributes no rows. Additive and internal: `perUser` has zero consumers repo-wide (the
         * plugin caller reads only `rows`), so widening the union cannot break a caller. Naming is
         * `` [OWNER-CONFIRM] ``.
         */
        readonly mode: 'replay' | 'executed' | 'legacy_compat' | 'failed'
        readonly inserted: boolean
      }>
    }

export interface AttendanceW4LiveScheduledBoundaryV1 {
  executeLivePunch(input: AttendanceLivePunchBoundaryInputV1): Promise<AttendanceLivePunchBoundaryResultV1>
  executeScheduledRun(input: AttendanceScheduledRunBoundaryInputV1): Promise<AttendanceScheduledRunBoundaryResultV1>
  recoverScheduledRun(
    input: AttendanceScheduledRunRecoveryBoundaryInputV1,
  ): Promise<AttendanceScheduledRunBoundaryResultV1>
}

export interface AttendanceW4BoundaryConnectionV1 {
  readonly client: AttendanceW4TransactionClientV1
  release(): void
}

export interface AttendanceW4LiveScheduledBoundaryDepsV1 {
  acquireConnection(): Promise<AttendanceW4BoundaryConnectionV1>
  legacyAdapters: AttendanceW4LiveScheduledLegacyAdaptersV1
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

const LIVE_SOURCE_REF = 'plugin-attendance:POST /api/attendance/punch'
const SCHEDULED_SOURCE_REF: Record<AttendanceScheduledRunInitiatorV1, string> = Object.freeze({
  cron: 'plugin-attendance:auto-absence:cron',
  admin_run: 'plugin-attendance:auto-absence:admin-run',
})
const SCHEDULED_RECOVERY_SOURCE_REF = 'plugin-attendance:auto-absence:recovery-sweep'
const SCHEDULED_ABSENCE_SOURCE: Record<AttendanceScheduledRunInitiatorV1, string> = Object.freeze({
  cron: 'cron_auto_absence',
  admin_run: 'admin_auto_absence_run',
})

function wireJson(value: unknown): unknown {
  // The stored response snapshot is the exact wire form the client received
  // (res.json serializes Dates the same way).
  return JSON.parse(JSON.stringify(value ?? null))
}

function isStrictInstant(value: unknown): boolean {
  try {
    parseAttendanceInstantMsV1(value)
    return true
  } catch {
    return false
  }
}

interface ShadowTargetRow extends AttendanceW4ComparableDailyProjection {
  id: string
  /**
   * Gate D2 (#4556 / #4844) — parent-state columns the AUTHORITATIVE branch needs and the
   * shadow branch ignores. They are read by the SAME single `FOR UPDATE` locked read (never a
   * second lock/round-trip): the authoritative writer cannot build the §7.8 preimage, decide the
   * F6 review-placeholder discriminator, or evaluate the retirement guard without them. The
   * shadow path passes this row to `computeAttendanceW4ShadowDiff` as `legacyProjection`, which
   * reads only the six named daily fields plus `workDate` — the extra members are inert there.
   */
  projectionOwner: AttendanceProjectionOwnerV1
  currentCalculationId: string | null
  visibilityState: 'active' | 'retired'
  visibilityReason: string
}

function approvedFactMinutes(
  facts: readonly ApprovedAttendanceFactV1[],
  kind: 'leave' | 'overtime',
): number {
  return facts.reduce((total, fact) => {
    if (fact.kind !== kind) return total
    return total + Math.max(0, Math.floor(fact.coverage.minutes))
  }, 0)
}

function hasW4Anomaly(segments: readonly AttendanceCalculatedSegmentV1[]): boolean {
  return segments.some((segment) =>
    segment.status === 'late'
    || segment.status === 'early_leave'
    || segment.status === 'late_early'
    || segment.status === 'missing_check_in'
    || segment.status === 'missing_check_out'
    || segment.status === 'missing_both')
}

async function lockShadowParentRecord(
  client: AttendanceW4TransactionClientV1,
  org: VerifiedAttendanceOrgIdentityV1,
  userId: string,
  workDate: string,
): Promise<ShadowTargetRow | null> {
  // Section 8.2 step 5: class-11 final signed target key, then the parent row.
  const target = createVerifiedAttendanceCalculationTargetIdentityV1({ org, userId, workDate })
  await acquireAttendanceCalculationTargetLocks(client, [target])
  // Gate D2 widened the projection list with the four parent-state columns (see
  // `ShadowTargetRow`). `first_in_at`/`last_out_at` stay RAW `timestamptz` (never `::text`) so
  // the authoritative compatibility fingerprint hashes exactly the instants it stores.
  const result = await client.query(
    `SELECT id::text AS id, work_date::text AS "workDate", status,
            first_in_at AS "firstInAt", last_out_at AS "lastOutAt",
            work_minutes AS "workMinutes", late_minutes AS "lateMinutes",
            early_leave_minutes AS "earlyLeaveMinutes",
            projection_owner AS "projectionOwner",
            current_calculation_id::text AS "currentCalculationId",
            visibility_state AS "visibilityState",
            visibility_reason AS "visibilityReason"
       FROM attendance_records
      WHERE user_id = $1 AND org_id = $2 AND work_date = $3
      FOR UPDATE`,
    [userId, org.orgId as unknown as string, workDate],
  )
  if (result.rows.length === 0) return null
  const row = result.rows[0]
  return {
    id: String(row.id),
    workDate: String(row.workDate),
    status: row.status === null ? null : String(row.status),
    firstInAt: row.firstInAt as string | Date | null,
    lastOutAt: row.lastOutAt as string | Date | null,
    workMinutes: row.workMinutes === null ? null : Number(row.workMinutes),
    lateMinutes: row.lateMinutes === null ? null : Number(row.lateMinutes),
    earlyLeaveMinutes: row.earlyLeaveMinutes === null ? null : Number(row.earlyLeaveMinutes),
    // W7-1a-M (#4556, ratified per #4556 comments 5293034619 + 5293478713): same
    // silent-downgrade fold as the authoritative core's locked read — membership
    // now decides, so `w4_group` survives the read; unknown values still fold to
    // `legacy_untracked`.
    projectionOwner: isAttendanceProjectionOwnerV1(row.projectionOwner)
      ? row.projectionOwner
      : 'legacy_untracked',
    currentCalculationId:
      typeof row.currentCalculationId === 'string' ? row.currentCalculationId : null,
    visibilityState: row.visibilityState === 'retired' ? 'retired' : 'active',
    visibilityReason: String(row.visibilityReason ?? ''),
  }
}

// ---------------------------------------------------------------------------
// Gate D2 (#4556 / #4844) — authoritative live-punch helpers.
// ---------------------------------------------------------------------------

/**
 * Create-if-absent review-path parent placeholder, in-txn under the target lock, BEFORE the core
 * call. ALWAYS `legacy_untracked` / pointer NULL / `retired` / `review_placeholder` — never an
 * outcome-conditional `active`.
 *
 * WHY `retired`, NOT `active` (this is the §7.5/F6 review-path parent-state install the D1 core
 * header names as a D2 obligation): the core's `writeCompletedRow` baseline predicate is exactly
 * `projectionOwner==='legacy_untracked' && visibilityState==='active'`. An `active` placeholder
 * would trip it and demand a compatibility fingerprint for a projection that does not exist. A
 * `retired`/`review_placeholder` placeholder makes the core skip the baseline entirely; for a
 * COMPLETED outcome its own tail pointer UPDATE then flips the parent to `w4`/`active`/`active`
 * in the same transaction — one atomic promotion. For a REVIEW outcome the placeholder is
 * preserved as-is, invisible to `visibility_state='active'` readers.
 *
 * DAILY-FIELD FIDELITY — what the LOCK requires, and what the daily columns therefore carry.
 *
 * §7.5 (`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md:1502-1505`) requires a
 * FOUR-TUPLE of parent-state columns for a fresh authoritative review — `legacy_untracked` /
 * pointer-null / `retired` / `review_placeholder` — plus the rationale clause "ordinary readers see
 * no fabricated `normal` zero-minute row". The INSERT below satisfies that four-tuple exactly. The
 * stronger phrasing "every mutable W4-owned daily field NULL" is the D2 build brief's own
 * amplification of §7.5, NOT lock text — worth stating, because four of those six columns
 * (`status`, `work_minutes`, `late_minutes`, `early_leave_minutes`) are `NOT NULL` (`status` with a
 * closed CHECK on top), so literal NULL is not writable for them and the amplified form is not
 * satisfiable against this schema at all. What ships is the schema's own neutral values for those
 * four and genuine NULLs for the two nullable instants (`first_in_at` / `last_out_at`).
 *
 * FABRICATION, COMPARED HONESTLY: this row DOES fabricate `normal`/0/0/0, and it fabricates MORE
 * than the import-side precedent, not less. `ensureAuthoritativeParent`
 * (`w4c3a-canonical-import-kernel.ts:832-860`) writes the REAL supplied compatibility projection
 * into its own `retired`/`review_placeholder` row — zero fabrication — because on the import path a
 * real projection exists to write. The live authoritative path has none: a review outcome means the
 * calculator produced no `dailyProjection`, and the day may have no prior legacy row at all. The
 * schema's neutral values are what remains once NULL is unavailable and no true value exists.
 *
 * WHY THE RATIONALE CLAUSE STILL HOLDS (the part that actually matters): the fabricated values are
 * never rendered to an ordinary reader, because every daily-VALUE surface filters visibility —
 * records list/export, report + multitable sync, period/payroll summary, missed-punch candidates and
 * comprehensive-hours all read through the `attendance_current_records` view
 * (`… WHERE visibility_state = 'active'`), one route filters `r.visibility_state = 'active'`
 * inline (`plugins/plugin-attendance/index.cjs:30197`), and anomaly listing / makeup facts /
 * open-record attribution / DecisionTrace go through the canonical `w4c3c-active-current` helper.
 * The one ordinary-permission read that touches the base table without a visibility predicate,
 * `readAttendanceCalculationDetail`, selects ZERO daily columns (id, pointer, mode, owner,
 * visibility state/reason) and is exactly the calculation-detail path §7.6:1526-1527 names as
 * permitted to read retired parents. Leg 8 of the D2 suite pins the canonical helper with a
 * positive control. So this needs no owner ruling and no nullability migration; it is recorded
 * here as a disclosure, not a deviation.
 *
 * POISON-RACE: `ON CONFLICT (user_id, work_date, org_id) DO NOTHING` (the in-file idiom and the
 * actual unique key) so a concurrent creator resolves to a PRODUCT outcome, never a raw 23505
 * that poisons the whole transaction. Zero rows returned means this caller LOST the race; the
 * caller must then re-`SELECT ... FOR UPDATE` and re-enter the full retirement/preimage
 * resolution — the winner's row may be a legacy-ACTIVE row, not another placeholder.
 *
 * A plain `ON CONFLICT` (rather than the F1 SAVEPOINT form) is legal here ONLY because this is
 * the FIRST DML the authoritative branch performs — Step 1's reject and Step 2's locked read are
 * DML-free. If any future change moves other DML ahead of this INSERT, the SAVEPOINT form
 * becomes MANDATORY, not a style preference.
 *
 * DEFENCE IN DEPTH, STATED HONESTLY: through the boundary the race is ALREADY prevented one layer
 * up — `lockShadowParentRecord` takes the class-11 transaction-scoped advisory target lock on
 * `(org, user, workDate)` BEFORE its read, so a second authoritative punch for the same day blocks
 * there and finds the winner's row on its own read rather than reaching this INSERT at all
 * (proven by the boundary-level concurrency leg, which observes ONE parent and TWO calculations
 * with the ON CONFLICT clause removed). The clause is therefore NOT load-bearing for the current
 * boundary call path; it is what keeps this helper safe for any caller that reaches it without
 * that advisory lock. Its own behaviour is pinned by a direct two-connection leg on this exported
 * seam — do not read the boundary-level leg as evidence for the clause.
 */
export async function insertAuthoritativeReviewPlaceholderParentV1(
  client: AttendanceW4TransactionClientV1,
  input: Readonly<{ orgId: string; userId: string; workDate: string; timezone: string; isWorkday: boolean }>,
): Promise<{ created: boolean }> {
  const result = await client.query(
    `INSERT INTO attendance_records (
        org_id, user_id, work_date, timezone,
        first_in_at, last_out_at,
        work_minutes, late_minutes, early_leave_minutes, status,
        is_workday, meta, source_batch_id,
        projection_owner, current_calculation_id, visibility_state, visibility_reason,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3::date, $4,
        NULL, NULL,
        0, 0, 0, 'normal',
        $5, '{}'::jsonb, NULL,
        'legacy_untracked', NULL, 'retired', 'review_placeholder',
        now(), now()
      )
      ON CONFLICT (user_id, work_date, org_id) DO NOTHING
      RETURNING id::text AS id`,
    [input.orgId, input.userId, input.workDate, input.timezone, input.isWorkday],
  )
  return { created: result.rows.length === 1 }
}

/**
 * The §7.8 frozen write-before parent witness the D1 core validates against, plus the caller's
 * `expectedCurrentCalculationId`.
 *
 * The compatibility fingerprint is LOAD-BEARING only for a present legacy-ACTIVE parent: the
 * core stores it verbatim as the `legacy_baseline` row's `projected_daily_fingerprint` and fails
 * `PREIMAGE_INVALID` when it is absent. It is computed for every present parent regardless (so
 * neither owner fork leaves a latent landmine) via the CANONICAL
 * `computeAttendanceImportRollbackPreimageFingerprintV1`, so the digest is byte-identical to the
 * one import/rollback freezes over the same parent state — never a fourth hand-rolled copy.
 *
 * Instants are normalized to ISO before hashing AND the same normalized values are what the
 * preimage stores, so the stored projection and the hashed projection are the same bytes.
 */
function buildAuthoritativeLivePunchPreimageV1(
  parent: ShadowTargetRow,
): { preimage: AttendanceAuthoritativeParentPreimageV1; expectedCurrentCalculationId: string | null } {
  const projection = {
    status: parent.status === null ? '' : String(parent.status),
    firstInAt: normalizeInstantIsoV1(parent.firstInAt),
    lastOutAt: normalizeInstantIsoV1(parent.lastOutAt),
    workMinutes: Math.max(0, Math.trunc(parent.workMinutes ?? 0)),
    lateMinutes: Math.max(0, Math.trunc(parent.lateMinutes ?? 0)),
    earlyLeaveMinutes: Math.max(0, Math.trunc(parent.earlyLeaveMinutes ?? 0)),
  }
  const compatibilityFingerprint = computeAttendanceImportRollbackPreimageFingerprintV1({
    projection,
    projectionOwner: parent.projectionOwner,
    currentCalculationId: parent.currentCalculationId,
    visibilityState: parent.visibilityState,
    visibilityReason: parent.visibilityReason,
  })
  return {
    preimage: {
      posture: 'present',
      projectionOwner: parent.projectionOwner,
      currentCalculationId: parent.currentCalculationId,
      visibilityState: parent.visibilityState,
      visibilityReason: parent.visibilityReason as 'active' | 'review_placeholder' | 'import_rollback' | 'operator_retirement',
      projection,
      compatibilityFingerprint,
    },
    // Always the LOCKED actual, never a recomputed or assumed value; the core cross-checks it
    // under its own `FOR UPDATE` re-lock and fails VERSION_CONFLICT on a mismatch.
    expectedCurrentCalculationId: parent.currentCalculationId,
  }
}

function normalizeInstantIsoV1(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  const ms = date.getTime()
  if (!Number.isFinite(ms)) return null
  return date.toISOString()
}

/**
 * Domain separator for the live-punch payload fingerprint below, terminated by a NUL.
 *
 * The NUL is written as the ESCAPE `\u0000`, never as a raw 0x00 byte in the source. A literal
 * NUL makes `file(1)` classify this `.ts` as `data` and makes `grep`/`rg` treat it as binary and
 * skip it SILENTLY — which would let this whole module drop out of any static audit that walks
 * the tree (the repo's own DML / SELECT-inventory collectors read source text). The escape
 * produces the IDENTICAL runtime string: `\u0000` is one code unit, byte-for-byte what the raw
 * NUL encoded, so every digest derived from this domain is unchanged. Pinned by
 * `__tests__/w4c2-live-punch-payload-fingerprint-domain.test.ts`, which asserts the exact code
 * units AND a digest computed against an independent oracle, so a future edit here cannot move
 * the fingerprint silently.
 */
/**
 * Deterministic payload identity for the core's retry-idempotency conflict check. The core reads
 * `input_provenance.payloadFingerprint` VERBATIM off the stored row on a retry, so this value
 * must (a) be derived only from the resolved command payload — never from a clock, a random id,
 * or the operation id itself — and (b) be embedded in BOTH `input.payloadFingerprint` and
 * `inputProvenance.payloadFingerprint`. Omitting the embedded copy makes a genuine retry read
 * `null`, mismatch, and surface `REPLAY_CONFLICT` where §7.3 requires a replay.
 */
export const ATTENDANCE_W4C2_LIVE_PUNCH_PAYLOAD_FINGERPRINT_DOMAIN_V1 =
  'metasheet2:attendance:w4c2:live-punch-authoritative-payload:v1\u0000'

export function computeAuthoritativeLivePunchPayloadFingerprintV1(
  input: AttendanceLivePunchBoundaryInputV1,
): string {
  return sha256Hex(
    ATTENDANCE_W4C2_LIVE_PUNCH_PAYLOAD_FINGERPRINT_DOMAIN_V1
    + canonicalAttendanceJsonV1({
      orgId: input.orgId,
      userId: input.userId,
      workDate: input.workDate,
      eventType: input.eventType,
      occurredAt: input.occurredAtRaw ?? input.occurredAtResolved,
      occurredAtResolved: input.occurredAtResolved,
      timezone: input.timezone,
      requestTimezone: input.requestTimezone,
      source: input.source,
      location: wireJson(input.location ?? null),
      meta: wireJson(input.meta ?? null),
      photoFileRef: input.photoFileRef,
      isWorkday: input.isWorkday,
      holidayKind: input.holidayKind,
    }),
  )
}

/**
 * Gate D3 (#4556 / #4844) — domain separator for the SCHEDULED payload fingerprint, terminated by a
 * NUL written as the ESCAPE `\u0000` and never as a raw 0x00 byte (same convention, and the same
 * reason, as the live-punch sibling above: a literal NUL makes `file(1)` classify this `.ts` as
 * `data` and makes `grep`/`rg` skip it SILENTLY, dropping the whole module out of every static audit
 * that walks the tree — the repo's own DML/read-inventory collectors included). The escape produces
 * the identical runtime string, so the digest is unchanged.
 *
 * A SEPARATE domain from `live_punch` on purpose: the two entrypoints must never be able to mint the
 * same payload digest for structurally different commands.
 */
export const ATTENDANCE_W4C2_SCHEDULED_PAYLOAD_FINGERPRINT_DOMAIN_V1 =
  'metasheet2:attendance:w4c2:scheduled-authoritative-payload:v1\u0000'

/**
 * Deterministic payload identity for the core's retry-idempotency conflict check, derived ONLY from
 * the RESOLVED command payload — never from a clock, a random id, or the operation id itself. The
 * core reads `input_provenance.payloadFingerprint` VERBATIM off the stored row on a retry, so the
 * caller must embed this value in BOTH `input.payloadFingerprint` and
 * `inputProvenance.payloadFingerprint`; omitting the embedded copy turns a genuine retry into
 * `REPLAY_CONFLICT`.
 */
export function computeAuthoritativeScheduledPayloadFingerprintV1(
  payload: Readonly<{
    scheduledRunId: string
    userId: string
    workDate: string
    expectedRunVersion: number
    scheduledAbsenceSource: string
  }>,
): string {
  return sha256Hex(
    ATTENDANCE_W4C2_SCHEDULED_PAYLOAD_FINGERPRINT_DOMAIN_V1
    + canonicalAttendanceJsonV1({
      scheduledRunId: payload.scheduledRunId,
      userId: payload.userId,
      workDate: payload.workDate,
      expectedRunVersion: payload.expectedRunVersion,
      scheduledAbsenceSource: payload.scheduledAbsenceSource,
    }),
  )
}

/**
 * Gate D3 (#4556 / #4844) — the ONE seam that resolves the authoritative `scheduled` writer's parent
 * and is the ONLY place in this module that may produce a `'skip'`.
 *
 * WHY ONE SEAM RATHER THAN INLINE STEPS: the retirement guard must dominate EVERY outcome, including
 * the skip. A naive top-to-bottom "present ⇒ skip, else placeholder, then guard" would seal
 * `{inserted:false, completed}` over an `operator_retirement` / `import_rollback` parent — a silent
 * pass over a day an operator or a rollback deliberately retired. Here the caller can never see a row
 * this function did not adjudicate, because the guard is called exactly once, unconditionally, before
 * BOTH returns; the only path that bypasses it is the 500-class throw, which is not a return.
 *
 * ORDER (normative):
 *  1. class-11 target lock + widened `FOR UPDATE` parent read;
 *  2. absent ⇒ create-if-absent `retired`/`review_placeholder` parent, then ALWAYS re-lock/re-read —
 *     a lost race may have been won by a legacy-ACTIVE row, another placeholder, or a retired-other
 *     row, and every one of those must re-enter the SAME adjudication below (still `null` under our
 *     own lock ⇒ `W4C2_AUTHORITATIVE_PARENT_UNRESOLVED`, which is NOT contained — see the writer);
 *  3. DEFAULT-REFUSE retirement adjudication on whatever row we ended up holding;
 *  4. presence branching on the GUARD'S VERDICT, never on bare `row !== null`:
 *     - guard-admitted `retired`/`review_placeholder` ⇒ WRITE (the F6 steady state, and the very
 *       placeholder step 2 creates — our own artifact, which a re-attempt must be able to complete);
 *     - present and NOT retired ⇒ SKIP (§6.2 default: legacy-ACTIVE rows and already-`w4`-owned
 *       active rows alike). The justification is LEGACY PARITY, not rarity: `'generate'` targets are
 *       not NOT-EXISTS-filtered at run creation, so a present parent is the ordinary case for anyone
 *       who punched that day, and the legacy `INSERT .. SELECT .. WHERE NOT EXISTS` contributes
 *       `inserted=false` for exactly that user — so `rows`/`generated_count`/`total` are unchanged by
 *       posture. It also makes the core's `RECORD_NOT_FOUND` unreachable for the legitimate dedup
 *       case. CONSEQUENCE, disclosed: the core's completed-supersede-over-legacy-active path stays
 *       DORMANT on `scheduled` under this default.
 */
type AuthoritativeScheduledParentResolutionV1 =
  | { readonly kind: 'skip' }
  | { readonly kind: 'write'; readonly parent: ShadowTargetRow }

async function resolveAuthoritativeScheduledParentV1(
  trx: AttendanceW4TransactionClientV1,
  org: VerifiedAttendanceOrgIdentityV1,
  userId: string,
  workDate: string,
  placeholder: Readonly<{ orgId: string; timezone: string; isWorkday: boolean }>,
): Promise<AuthoritativeScheduledParentResolutionV1> {
  let parent = await lockShadowParentRecord(trx, org, userId, workDate)
  if (parent === null) {
    await insertAuthoritativeReviewPlaceholderParentV1(trx, {
      orgId: placeholder.orgId,
      userId,
      workDate,
      timezone: placeholder.timezone,
      isWorkday: placeholder.isWorkday,
    })
    parent = await lockShadowParentRecord(trx, org, userId, workDate)
    if (parent === null) {
      // Neither our INSERT nor a racer's produced a visible row under our own lock — a
      // programming/DB-state error, not a business outcome, and deliberately NOT contained.
      boundaryFail('W4C2_AUTHORITATIVE_PARENT_UNRESOLVED', 500)
    }
  }
  // The guard is called on EVERY row this function ever returns or skips on. Its refusals are the
  // two ops-retirement 409s, which the writer's containment converts to a per-target `'failed'`.
  assertParentNotRetiredForAuthoritativePunchV1({
    visibilityState: parent.visibilityState,
    visibilityReason: parent.visibilityReason,
  })
  if (parent.visibilityState === 'retired') {
    // The guard admits exactly ONE retired reason (`review_placeholder`); every other retired reason
    // threw above. So this arm is the F6 carve-out, reached only through the guard's own verdict.
    return { kind: 'write', parent }
  }
  return { kind: 'skip' }
}

async function nextCalculationVersion(
  client: AttendanceW4TransactionClientV1,
  recordId: string,
): Promise<number> {
  const result = await client.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM attendance_record_calculations WHERE attendance_record_id = $1::uuid',
    [recordId],
  )
  return Number(result.rows[0].next)
}

interface ShadowCalculationRowInput {
  orgId: string
  recordId: string
  version: number
  entrypoint: 'live' | 'scheduled'
  operationId: string
  attribution: AttendanceAttributionSnapshotV1
  context: FrozenAttendanceContextV1 | null
  segmentSnapshot: unknown[]
  evidence: unknown[]
  approvedFacts: ApprovedAttendanceFactV1[]
  inputProvenance: Record<string, unknown>
  provenanceRef: AttendanceInputProvenanceRefV1
  mergePolicy: 'append'
  outcome: 'completed' | 'review_required'
  outcomeReasonCode: string
  segments: AttendanceSegmentCalculationResultV1['segments']
  dailyProjection: AttendanceSegmentCalculationResultV1['dailyProjection']
  actorId: string
  correlationId: string
  legacyProjection: AttendanceW4ComparableDailyProjection
}

/**
 * Shadow calculation + segment children INSERT (mode='shadow',
 * projection_effect='none' — the CHECK matrix rejects anything else). Returns
 * the calculation id and the semantic/provenance fingerprints for the seal.
 */
async function insertShadowCalculation(
  client: AttendanceW4TransactionClientV1,
  input: ShadowCalculationRowInput,
): Promise<{ calculationId: string; semanticFingerprint: string; provenanceFingerprint: string }> {
  const semanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
    attribution: input.attribution,
    context: input.context,
    evidence: input.evidence,
    approvedFacts: input.approvedFacts,
    manualOverride: null,
    mergePolicy: input.mergePolicy,
    calculationTier: 'legacy_shadow',
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
    snapshotSchemaVersion: 1,
  })
  const provenanceFingerprint = computeAttendanceProvenanceFingerprintV1(input.provenanceRef)
  // W4C-2 remediation (#4612 gate3 P2-1 self-report ⑥, lock 7.3 `:1400-1402`
  // + 8.2 step 7 `:1821-1822`): this was `completed ? semanticFingerprint :
  // null` — the semantic-input-fingerprint's OWN value (a different hash
  // domain entirely), never the dedicated source-definition fingerprint the
  // column is named for. `computeAttendanceSourceDefinitionFingerprintV1`
  // (W4C-1) already has the correct nullability contract built in (null for
  // `unsupported` posture OR an absent frozen context; the lock's "nullable
  // only for the unsupported-attribution review posture" — a `resolved_v2`
  // + `context_mismatch` review row still gets a real, non-null value), so
  // it is called unconditionally here rather than gated on `completed`.
  const sourceDefinitionFingerprint = computeAttendanceSourceDefinitionFingerprintV1({
    attribution: input.attribution,
    context: input.context,
  })
  const calculationId = crypto.randomUUID()
  const completed = input.outcome === 'completed'
  const projection = completed ? input.dailyProjection : null
  const resolvedWorkDate = input.attribution.posture === 'resolved_v2'
    ? input.attribution.value.workDate
    : null
  const shadowDiffCandidate = computeAttendanceW4ShadowDiff({
    legacy: input.legacyProjection,
    calculated: projection
      ? {
          workDate: resolvedWorkDate,
          status: projection.status,
          firstInAt: projection.firstInAt,
          lastOutAt: projection.lastOutAt,
          workMinutes: projection.workedMinutes,
          lateMinutes: projection.lateMinutes,
          earlyLeaveMinutes: projection.earlyLeaveMinutes,
        }
      : null,
    segmentCount: completed ? input.segments.length : 0,
    outcome: input.outcome,
    workDateMismatch: resolvedWorkDate !== null && resolvedWorkDate !== input.legacyProjection.workDate,
    contextMismatch: input.outcomeReasonCode === 'context_mismatch',
    inputMismatch: input.outcomeReasonCode === 'input_schema_invalid'
      || input.outcomeReasonCode === 'import_metric_conflict',
  })
  const legacyStatus = input.legacyProjection.status
  const projectedStatus = projection?.status ?? null
  const expectedRosterDifference = completed && projection !== null
    && typeof legacyStatus === 'string'
    && (ATTENDANCE_DAILY_STATUSES_V1 as readonly string[]).includes(legacyStatus)
    && typeof projectedStatus === 'string'
    && (ATTENDANCE_DAILY_STATUSES_V1 as readonly string[]).includes(projectedStatus)
    ? isExpectedAttendanceShadowDifferenceV1({
        shadowDiffCode: shadowDiffCandidate.code,
        legacyStatus: legacyStatus as AttendanceDailyStatusV1,
        w4Status: projectedStatus as AttendanceDailyStatusV1,
        w4CorrectionApplied: input.segments.some((segment) => segment.reasons.includes('approved_correction_applied')),
        w4AnomalyPresent: hasW4Anomaly(input.segments),
        legacyLeaveMinutes: approvedFactMinutes(input.approvedFacts, 'leave'),
        legacyOvertimeMinutes: approvedFactMinutes(input.approvedFacts, 'overtime'),
      })
    : false
  // The ratified roster entry deliberately presents as `status_changed`; it is
  // non-critical under §10.1 and must not be relabeled as break exclusion.
  const shadowDiff = expectedRosterDifference
    ? Object.freeze({ ...shadowDiffCandidate, code: 'status_changed' as const })
    : shadowDiffCandidate
  await client.query(
    `INSERT INTO attendance_record_calculations (
        id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
        engine_version, snapshot_schema_version, operation_id,
        semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
        attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
        approved_facts_snapshot, manual_override_snapshot, input_provenance,
        merge_policy, calculation_tier, outcome, outcome_reason_code, projection_effect,
        expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
        projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
        shadow_diff_code, shadow_diff, actor_id, correlation_id
      ) VALUES (
        $1::uuid, $2, $3::uuid, $4, 'calculation', 'shadow', $5,
        $6, 1, $7::uuid,
        $8, $9, $10,
        $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
        $15::jsonb, NULL, $16::jsonb,
        $17, 'legacy_shadow', $18, $19, 'none',
        $20, $21, $22, $23,
        $24, $25, $26,
        $27, $28::jsonb, $29, $30
      )`,
    [
      calculationId,
      input.orgId,
      input.recordId,
      input.version,
      input.entrypoint,
      ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
      input.operationId,
      semanticFingerprint,
      provenanceFingerprint,
      // Section 7.3: source-definition fingerprint nullable only for
      // unsupported/no-context review (see `sourceDefinitionFingerprint`'s
      // own computation above — no longer aliased to `semanticFingerprint`).
      sourceDefinitionFingerprint,
      canonicalAttendanceJsonV1(wireJson(input.attribution)),
      input.context === null ? null : canonicalAttendanceJsonV1(wireJson(input.context)),
      canonicalAttendanceJsonV1(wireJson(input.segmentSnapshot)),
      JSON.stringify(wireJson(input.evidence)),
      canonicalAttendanceJsonV1(wireJson(input.approvedFacts)),
      JSON.stringify(wireJson(input.inputProvenance)),
      input.mergePolicy,
      input.outcome,
      input.outcomeReasonCode,
      completed ? input.segments.length : 0,
      completed && projection ? projection.status : null,
      completed && projection ? projection.firstInAt : null,
      completed && projection ? projection.lastOutAt : null,
      completed && projection ? projection.workedMinutes : null,
      completed && projection ? projection.lateMinutes : null,
      completed && projection ? projection.earlyLeaveMinutes : null,
      shadowDiff.code,
      JSON.stringify(shadowDiff),
      input.actorId,
      input.correlationId,
    ],
  )
  if (completed) {
    for (const segment of input.segments) {
      await client.query(
        `INSERT INTO attendance_record_segments (
            org_id, record_id, calculation_id, segment_index,
            expected_start_at, expected_end_at, actual_in_at, actual_out_at,
            work_minutes, late_minutes, early_leave_minutes,
            status, status_reasons, matched_evidence_refs, unmatched_evidence_refs
          ) VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb)`,
        [
          input.orgId,
          input.recordId,
          calculationId,
          segment.segmentIndex,
          segment.expectedStartAt,
          segment.expectedEndAt,
          segment.actualInAt,
          segment.actualOutAt,
          segment.workedMinutes,
          segment.lateMinutes,
          segment.earlyLeaveMinutes,
          segment.status,
          JSON.stringify(segment.reasons),
          JSON.stringify(segment.matchedEvidenceRefs),
          JSON.stringify(segment.unmatchedEvidenceRefs),
        ],
      )
    }
  }
  return { calculationId, semanticFingerprint, provenanceFingerprint }
}

/** Attribution for a non-V2-castable resolution (never review-free). */
function unsupportedAttribution(
  reason: 'missing' | 'ambiguous' | 'unresolved',
  sourceFingerprint: string | null,
): AttendanceAttributionSnapshotV1 {
  return { posture: 'unsupported', sourceSchemaVersion: null, reason, sourceFingerprint }
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Build the V2-or-unsupported attribution snapshot from an in-transaction W2
 * re-resolution (freeze step). Ambiguous/unresolved/missing winner data and
 * strict-rebuild mismatches all land on `unsupported` (=> review), never on a
 * fabricated V2.
 */
function attributionFromResolution(
  resolution: AttendanceW4ResolvedCandidateV1,
  args: {
    orgId: string
    userId: string
    source: 'live_resolution' | 'request_creation' | 'scheduled_resolution'
    nowIso: string
  },
): AttendanceAttributionSnapshotV1 {
  if (resolution.kind === 'ambiguous') {
    return unsupportedAttribution('ambiguous', null)
  }
  if (resolution.kind !== 'resolved') {
    return unsupportedAttribution('unresolved', null)
  }
  const winner = resolution.fullWinner
  if (
    !winner ||
    typeof winner.workStartTime !== 'string' ||
    typeof winner.workEndTime !== 'string' ||
    typeof winner.timezone !== 'string' ||
    !Number.isInteger(resolution.attributionTailMinutes)
  ) {
    return unsupportedAttribution('unresolved', null)
  }
  const overtime = (resolution.approvedOvertimeWindows ?? []).map((entry) => ({
    requestId: String(entry.requestId),
    approvedEndAt:
      entry.approvedEndAt instanceof Date ? entry.approvedEndAt.toISOString() : String(entry.approvedEndAt),
    anchor: wireJson(entry.anchor ?? null),
  }))
  let built
  try {
    built = buildFrozenWorkDateAttributionV2({
      orgId: args.orgId,
      userId: args.userId,
      workDate: String(resolution.workDate),
      shiftId: String(resolution.shiftId),
      reasonCode: String(resolution.reasonCode ?? 'SINGLE_MATCHING_CANDIDATE'),
      resolvedAt: args.nowIso,
      timezone: winner.timezone,
      workStartTime: winner.workStartTime,
      workEndTime: winner.workEndTime,
      isOvernight: winner.isOvernight === true,
      candidateAbsoluteWindow: {
        startAt: winner.absoluteWindow.startAt.toISOString(),
        endAt: winner.absoluteWindow.endAt.toISOString(),
      },
      candidateAttributionWindow: {
        startAt: winner.attributionWindow.startAt.toISOString(),
        endAt: winner.attributionWindow.endAt.toISOString(),
      },
      attributionTailMinutes: resolution.attributionTailMinutes as number,
      approvedOvertimeWindows: overtime,
      source: args.source,
    })
  } catch {
    return unsupportedAttribution('unresolved', null)
  }
  if (built.kind !== 'resolved_v2') {
    return unsupportedAttribution('unresolved', sha256Hex(built.code))
  }
  return built.attribution
}

/**
 * P12 request-time freeze. The plugin supplies only its in-transaction W2
 * resolution; core owns strict reconstruction and the `request_creation`
 * source tag. Unsupported candidates remain explicit review posture.
 */
export function buildAttendanceRequestCreationAttributionSnapshotV1(input: {
  readonly orgId: string
  readonly userId: string
  readonly nowIso: string
  readonly resolution: AttendanceW4ResolvedCandidateV1
}): AttendanceAttributionSnapshotV1 {
  return attributionFromResolution(input.resolution, {
    orgId: input.orgId,
    userId: input.userId,
    source: 'request_creation',
    nowIso: input.nowIso,
  })
}

/**
 * W4C-2 gate3 P2-1 closure (#4612 self-report ⑥, second closure round) —
 * lock §8.2 step 7 `:1821-1822` second clause: "require candidate identity
 * PLUS source-definition fingerprint equality". The OUTER half of that
 * equality: the route (plugin, `index.cjs`) reads a W2 candidate and builds
 * a frozen context BEFORE opening its transaction, over its own
 * non-transactional connection, using the SAME plugin-local functions the
 * boundary's `legacyAdapters.resolveLiveCandidate`/`buildShadowFrozenContext`
 * closures call in-transaction (byte-identical call shape; only the
 * connection differs) — never a route-computed "prepared plan" smuggled
 * through (lock 4.1). This is the ONE new `attendanceW4SegmentCalculation`
 * port method (least-privilege, same posture as `applyMergePolicyPure`/
 * `validateIanaTimezone`): it wraps `attributionFromResolution` (private to
 * this module — never exported directly, so the plugin can only ever ask
 * "what fingerprint would THIS resolution+context produce", not reach the
 * raw `buildFrozenWorkDateAttributionV2`/`computeAttendanceSourceDefinition
 * FingerprintV1` primitives for arbitrary data).
 *
 * Uses `computeAttendanceOuterComparableSourceDefinitionFingerprintV1` (NOT
 * the storage-column fingerprint) — a narrower domain that ALSO projects out
 * `reasonCode`. Discovered empirically: the lock's own §8.2 step 3-before-4
 * ordering means the freeze step's in-transaction re-resolution can see an
 * open `attendance_records` row THIS SAME OPERATION'S OWN step-3 write just
 * created (`selectAmongMatchingCandidates`'s `openPreviousMatches` branch),
 * producing a DIFFERENT `reasonCode` than the route's pre-transaction read
 * ever could, with ZERO concurrency and the SAME resulting
 * `workDate`/`shiftId` — see `attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts`
 * ("Group E / eDay2") and `w4c1-fingerprints.ts`'s own doc comment on that
 * function for the full account, including why excluding `reasonCode` is
 * principled (tie-break provenance, not identity or policy) rather than a
 * convenience weakening.
 *
 * Returns `null` under the exact same conditions
 * `computeAttendanceOuterComparableSourceDefinitionFingerprintV1` does
 * (unsupported posture, or an absent frozen context) — never a
 * caller-echoed value.
 */
export function computeAttendanceOuterSourceDefinitionFingerprintV1(input: {
  readonly orgId: string
  readonly userId: string
  readonly source: 'live_resolution' | 'scheduled_resolution'
  readonly nowIso: string
  readonly resolution: AttendanceW4ResolvedCandidateV1
  readonly context: FrozenAttendanceContextV1 | null
}): string | null {
  const attribution = attributionFromResolution(input.resolution, {
    orgId: input.orgId,
    userId: input.userId,
    source: input.source,
    nowIso: input.nowIso,
  })
  return computeAttendanceOuterComparableSourceDefinitionFingerprintV1({ attribution, context: input.context })
}

/**
 * TEST-ONLY (#4612 O-5 self-observation probe): identical computation to
 * `computeAttendanceOuterSourceDefinitionFingerprintV1` above, but returns the
 * RAW `attribution.value` object instead of hashing it. Exists solely so a
 * real-DB test can empirically diff the route's own PRE-step-3 (outer)
 * resolution against the freeze step's POST-step-3 (inner) resolution
 * field-by-field — not just compare their narrowed-domain fingerprints — to
 * enumerate the actual self-observation drift set rather than assert it by
 * argument. Not wired into any production call site; never imported outside
 * `tests/`. `null` under the same conditions the sibling function returns
 * `null` for (unsupported posture / absent context).
 */
export function __computeAttendanceOuterAttributionValueForTestsV1(input: {
  readonly orgId: string
  readonly userId: string
  readonly source: 'live_resolution' | 'scheduled_resolution'
  readonly nowIso: string
  readonly resolution: AttendanceW4ResolvedCandidateV1
  readonly context: FrozenAttendanceContextV1 | null
}): Record<string, unknown> | null {
  const attribution = attributionFromResolution(input.resolution, {
    orgId: input.orgId,
    userId: input.userId,
    source: input.source,
    nowIso: input.nowIso,
  })
  return attribution.posture === 'resolved_v2' ? (attribution.value as unknown as Record<string, unknown>) : null
}

async function loadLivePunchEvidence(
  client: AttendanceW4TransactionClientV1,
  orgId: string,
  userId: string,
  workDate: string,
): Promise<AttendanceEvidenceV1[]> {
  const result = await client.query(
    `SELECT id::text AS id, event_type, occurred_at, source
       FROM attendance_events
      WHERE user_id = $1 AND org_id = $2 AND work_date = $3
      ORDER BY occurred_at, id`,
    [userId, orgId, workDate],
  )
  return result.rows.map((row) => ({
    kind: 'punch' as const,
    ref: String(row.id),
    direction: row.event_type === 'check_out' ? ('check_out' as const) : ('check_in' as const),
    occurredAt: new Date(row.occurred_at as string | Date).toISOString(),
    source: row.source === 'outdoor_approval' ? ('outdoor_approval' as const) : ('attendance_event' as const),
  }))
}

/**
 * W4C-2 remediation P1-3: the boundary's own closed projection of
 * `AttendanceLivePunchBoundaryInputV1` into `AttendanceLivePunchLegacyArgsV1`
 * — every field is copied verbatim from an already-canonical top-level input
 * field; nothing here is a route-computed "prepared plan" (`rule`,
 * `punchWorkDateResolution`, `settings` are deliberately NOT projected —
 * the adapter derives them itself, in-transaction).
 */
function buildLegacyPunchArgs(input: AttendanceLivePunchBoundaryInputV1): AttendanceLivePunchLegacyArgsV1 {
  return {
    userId: input.userId,
    orgId: input.orgId,
    workDate: input.workDate,
    occurredAt: input.occurredAtResolved,
    eventType: input.eventType,
    source: input.source,
    location: input.location,
    meta: input.meta,
    timezone: input.timezone,
    requestTimezone: input.requestTimezone,
    isWorkday: input.isWorkday,
  }
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

export function createAttendanceLiveScheduledBoundaryV1(
  deps: AttendanceW4LiveScheduledBoundaryDepsV1,
): AttendanceW4LiveScheduledBoundaryV1 {
  const adapters = deps.legacyAdapters
  if (
    !adapters ||
    typeof adapters.applyLivePunchLegacy !== 'function' ||
    // Gate D2: required, never optional — a host that provided the boundary but omitted the
    // split event seam would make an authoritative punch lose its own durable evidence. Folding
    // it into the SAME fail-closed gate keeps that state unreachable (the boundary simply does
    // not exist), instead of degrading at write time.
    typeof adapters.insertLivePunchEvent !== 'function' ||
    typeof adapters.deriveLivePunchWorkDateResolution !== 'function' ||
    typeof adapters.applyScheduledAbsenceLegacy !== 'function' ||
    typeof adapters.resolveLiveCandidate !== 'function' ||
    typeof adapters.resolveScheduledCandidate !== 'function' ||
    typeof adapters.buildShadowFrozenContext !== 'function' ||
    // W7-1b: folded into the SAME fail-closed gate. A host that supplies the
    // legacy builder but not the seam must make the boundary not exist, never
    // silently keep taking the legacy arm — that degradation is
    // indistinguishable from a correctly-configured legacy org.
    typeof adapters.issueFrozenContext !== 'function'
  ) {
    boundaryFail('W4C2_LEGACY_ADAPTERS_INVALID', 500)
  }
  if (typeof deps.acquireConnection !== 'function') {
    boundaryFail('W4C2_CONNECTION_PROVIDER_INVALID', 500)
  }

  /**
   * W7-1b — the ONE place this boundary reaches the issuance seam.
   *
   * Every producer arm calls THIS, never `adapters.buildShadowFrozenContext`
   * directly: the arm-selection rule must have a single definition, and a
   * second call site would be free to select differently for the same
   * `(org, work_date)`. `purpose: 'persist'` on all four arms — these are
   * persisting producers, not the fingerprint-only mirror.
   *
   * The `.context` unwrap keeps every call site's downstream code identical to
   * the pre-1b shape (`FrozenAttendanceContextV1 | null`), so the legacy arm's
   * control flow is unchanged byte-for-byte. The group arm's fail-closed `null`
   * (O-9 review-out) travels the SAME path the legacy builder's own `null`
   * already travelled, which is why no new review branch is needed here.
   */
  async function issueThroughW7Seam(
    pluginTrx: AttendancePluginShapedTrxV1,
    args: {
      orgId: string
      userId: string
      workDate: string
      shiftId: string
      timezone: string
      isWorkday: boolean
      holidayKind: string | null
    },
  ): Promise<FrozenAttendanceContextV1 | null> {
    const issued = await adapters.issueFrozenContext(pluginTrx, { ...args, purpose: 'persist' })
    // OD-W7-4(a): a SUSPENDED org produces NO calculation. Unwrapping `.context`
    // here would yield `null`, which the calculator turns into a durable
    // `review('missing_frozen_context')` ROW — a produced calculation, i.e.
    // exactly what suspension must prevent. So this refuses instead.
    //
    // On the scheduled path D3's per-target SAVEPOINT containment applies, so a
    // suspended target does not abort the surrounding batch.
    if (issued.arm === 'blocked') {
      boundaryFail('W4C2_W7_CONTEXT_SOURCE_SUSPENDED', 409)
    }
    return issued.context
  }

  async function withConnection<T>(body: (client: AttendanceW4TransactionClientV1) => Promise<T>): Promise<T> {
    const connection = await deps.acquireConnection()
    try {
      return await body(connection.client)
    } finally {
      connection.release()
    }
  }

  // W4C-2 P1-2 fix (#4612 verdict second gate round, real two-OS-process repro): under genuine
  // concurrent SERIALIZABLE access to the SAME run's per-target claim insert
  // (`insertClaimedItemRow`, w4c0-operation-registry.ts), `runAttendanceResultOperationTransactionV1`
  // already retries a SINGLE call up to `W4_TRANSACTION_MAX_RETRIES` (2) times on SQLSTATE
  // 40001/40P01 -- but with NO backoff between those inner attempts, so two racers stepping
  // through the same claim in near lockstep re-collide on every retry instead of de-correlating
  // (measured: 4/10 fresh two-process iterations still escaped a raw 40001 past that inner
  // wrapper). This is a SEPARATE, OUTER, bounded retry around ONE per-target call — each outer
  // attempt gets its own fresh connection and its own fresh inner 3-attempt sequence — with
  // jittered backoff BETWEEN outer attempts so the two racers' schedules diverge. It exists
  // ONLY around the per-target claim call site (verified by call-site-tagged repro: every
  // observed escape stack traced to `attendanceResultOperationPreflightV1` from THIS module's
  // per-target loop below; the probe/create-resume/finalization SERIALIZABLE transactions in
  // this same function did not escape in the same repro).
  //
  // Deliberately NOT a lock held across the per-user loop: section 1.7 of the ratified amendment
  // states "Per-user execution is unchanged from the held branch...A per-user transaction must
  // not update the run row, so per-user work never contends on it" — a lock spanning multiple
  // per-user transactions would contradict that sentence, not satisfy it. Retrying is safe
  // because a per-target claim insert has no observable side effect outside its own transaction:
  // it has either not committed at all, or the whole transaction (including the claim) already
  // rolled back — never a partial write a retry could duplicate.
  const W4C2_TARGET_CLAIM_MAX_OUTER_RETRIES = 4
  async function withConnectionRetryingTargetContention<T>(
    body: (client: AttendanceW4TransactionClientV1) => Promise<T>,
  ): Promise<T> {
    let attempt = 0
    for (;;) {
      try {
        return await withConnection(body)
      } catch (error) {
        if (!isRetryableSqlState(error)) throw error
        if (attempt >= W4C2_TARGET_CLAIM_MAX_OUTER_RETRIES) {
          // Retries exhausted: map to a closed, typed, RETRYABLE W4 error rather than letting
          // the raw pg SQLSTATE escape. `W4_ERROR_NAMES` (index.cjs) already recognizes
          // `AttendanceW4LiveScheduledBoundaryError` by name, so the admin route responds 503
          // (never a raw 500) and the cron caller's own per-(org, workDate) isolation (index.cjs
          // `scheduleAutoAbsence`) contains this to the one contended org/date, never the whole
          // tick.
          boundaryFail('W4C2_SCHEDULED_RUN_TARGET_CONTENDED', 503)
        }
        attempt += 1
        const backoffMs = Math.min(200, 15 * attempt) + Math.floor(Math.random() * 20)
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      }
    }
  }

  // -------------------------------------------------------------------------
  // Live punch.
  // -------------------------------------------------------------------------

  async function executeLivePunch(
    input: AttendanceLivePunchBoundaryInputV1,
  ): Promise<AttendanceLivePunchBoundaryResultV1> {
    // Org-key pre-classification. The rollout domain is canonical UUIDs plus the
    // exact 'default' sentinel; a legacy org key OUTSIDE that lexical domain can
    // never carry a rollout-state row through the sanctioned transition writer
    // (the posture seam itself refuses non-canonical keys), so it is
    // structurally `legacy_projection_only`. Its null-ID commands take the same
    // closed legacy adapter with NO canonical parsing at all — the legacy
    // response/projection red line admits no new rejection surface.
    let rolloutKey: ReturnType<typeof parseCanonicalAttendanceRolloutOrgKeyV1> | null = null
    try {
      rolloutKey = parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)
    } catch {
      rolloutKey = null
    }

    return withConnection((client) =>
      runAttendanceResultOperationTransactionV1(client, async (trx) => {
        const pluginTrx = pluginShapedTrx(trx)
        const legacyPunchArgs = buildLegacyPunchArgs(input)

        if (rolloutKey === null) {
          if (input.operationId !== null) {
            // A stable-ID command requires a canonical org key (values-free).
            boundaryFail('W4C2_ORG_KEY_OUTSIDE_W4_DOMAIN')
          }
          const result = await adapters.applyLivePunchLegacy(pluginTrx, legacyPunchArgs)
          return { kind: 'legacy' as const, response: result }
        }

        // Suspension preflight precedes the first source DML (lock 12.3): the
        // org rollout SHARED advisory lock, then the one posture seam.
        await acquireAttendanceCalculationRolloutLock(trx, rolloutKey, 'shared')
        const posture = await resolveSegmentCalculationPosture(trx, rolloutKey as unknown as string)

        if (input.operationId === null) {
          if (posture.writePosture === 'blocked') {
            throw new AttendanceW4OperationError('SEGMENT_CALCULATION_SUSPENDED')
          }
          if (posture.writePosture === 'legacy_projection_only') {
            // Null-ID legacy command: same closed adapter, no operation row, no
            // outbox, no calculation, NO strict envelope/witness surface; the
            // route keeps its existing synchronous best-effort emit.
            const result = await adapters.applyLivePunchLegacy(pluginTrx, legacyPunchArgs)
            return { kind: 'legacy' as const, response: result }
          }
          // W4-postured org + null-ID falls through to the registry protocol,
          // which fails closed with W4C0_OPERATION_ID_REQUIRED before source DML.
        }

        // Stable-ID or W4-postured command: strict envelope + branded witness +
        // full registry preflight (replay-before-suspension per lock 7.1/8.2).
        const envelope: NormalizedAttendanceSourceOperationEnvelopeV1 = normalizeAttendanceSourceOperationEnvelopeV1({
          schemaVersion: 1,
          orgId: input.orgId,
          correlationId: `live-punch:${input.orgId}:${input.userId}:${input.workDate}`,
          command: {
            schemaVersion: 1,
            kind: 'live_punch',
            subjectUserId: input.userId,
            operationId: input.operationId,
            payload: {
              eventType: input.eventType,
              // Command identity: the client's own business-time bytes when it
              // sent any; otherwise the route-resolved instant (a client that
              // wants a congruent response-loss retry supplies occurredAt
              // explicitly).
              occurredAt: input.occurredAtRaw ?? input.occurredAtResolved,
              timezone: input.timezone,
              source: input.source,
              location: wireJson(input.location) as Record<string, unknown> | null,
              meta: wireJson(input.meta) as Record<string, unknown> | null,
              photoFileRef: input.photoFileRef,
            },
          },
          batch: null,
        })

        const authorization = createAuthorizedAttendanceWriteContextV1({
          actorId: input.userId,
          actorPosture: 'self',
          tokenSubjectUserId: input.userId,
          orgId: envelope.orgId,
          subjectScope: { kind: 'self', userId: input.userId },
          capability: 'punch',
          sourceRef: LIVE_SOURCE_REF,
        })

        const preflight = await attendanceResultOperationPreflightV1(trx, authorization, envelope.registryInput)

        if (preflight.kind === 'replay') {
          const responses = Object.values(preflight.responses.itemResponses)
          return { kind: 'replay' as const, response: responses[0] ?? null }
        }
        if (preflight.kind === 'suspended') {
          throw new AttendanceW4OperationError('SEGMENT_CALCULATION_SUSPENDED')
        }

        if (preflight.kind === 'legacy_no_operation') {
          // Posture raced to legacy between the probe and the registry re-read:
          // the null-ID legacy contract applies (no operation row).
          const result = await adapters.applyLivePunchLegacy(pluginTrx, legacyPunchArgs)
          return { kind: 'legacy' as const, response: result }
        }

        // preflight.kind === 'claimed'
        const org = preflight.org
        const identity = preflight.itemIdentities[0] as VerifiedAttendanceOperationIdentityV1
        const isLegacyCompat = org.acceptedWritePosture === 'legacy_projection_only'

        if (isLegacyCompat) {
          // Stable-ID legacy command: same closed adapter plus ONLY the
          // compatibility operation claim/seal — no calculation, no outbox, no
          // W4 result pointer (lock 4.1/12 preamble).
          const result = await adapters.applyLivePunchLegacy(pluginTrx, legacyPunchArgs)
          await sealAttendanceResultOperationV1(trx, identity, {
            responseSnapshot: wireJson(result),
          })
          return { kind: 'legacy_compat' as const, response: result }
        }

        // Three-posture matrix: a business time only the legacy parser accepts.
        // HOISTED above the authoritative branch by Gate D2 so both the authoritative reject
        // (below, first thing in the branch) and the eligible reject (further down) read ONE
        // predicate rather than two copies that could drift. Pure and DML-free (`isStrictInstant`
        // is a try/catch around the strict instant parser), so hoisting it is behaviour-
        // preserving for every other posture.
        const legacyOnlyTime = input.occurredAtRaw !== null && !isStrictInstant(input.occurredAtRaw)

        // W4 posture. Distinguish effective shadow vs eligible vs authoritative
        // (still under the org rollout shared lock acquired above).
        if (posture.effectiveState === 'authoritative' || org.acceptedWritePosture === 'authoritative') {
          // ===================================================================
          // Gate D2 (#4556 / #4844) — the AUTHORITATIVE live-punch writer.
          //
          // REPLACEMENT, NOT A DELETE. This branch body previously failed closed. Deleting it
          // instead of replacing it would let an allowlisted authoritative org's punch fall
          // through to the shadow `applyLivePunchLegacy` call below — a silent 503-to-legacy-
          // projection conversion, fail-OPEN the instant the allowlist gains an authoritative
          // entry. The branch body must always be a real writer, and it must `return`/throw
          // before control can reach that call site (pinned behaviourally by the zero-invocation
          // spy on the injected `applyLivePunchLegacy`).
          //
          // Deliberate deviation from §8.2's step-4-before-step-5 numbering: the parent lock is
          // taken BEFORE the in-transaction W2 re-resolution here, because the retirement guard
          // and the create-if-absent placeholder must both settle before ANY source DML (the
          // split event INSERT included). Safe: the two orderings cannot interleave, because the
          // org rollout SHARED advisory lock is held for the whole transaction on BOTH paths and
          // a posture transition needs the EXCLUSIVE one — so every in-flight punch for an org
          // sees the same posture, and a shadow punch can never be concurrent with an
          // authoritative punch on the same parent row.
          // ===================================================================

          // -- Step 1: legacy-only business time is REJECTED, with ZERO DML ------------------
          // The eligible reject below never evaluates on this path (it is gated on
          // `effectiveState === 'eligible'`), so this is a genuinely new in-branch check, not a
          // widened existing one. Authoritative may never be LOOSER than eligible: §12.3 requires
          // effective eligible|authoritative to reject before event/request/result/effect DML.
          // The whole transaction rolls back, discarding the preflight claim; no event row, no
          // record row, no calculation row, and no `attendance.punched` outbox row (the enqueue
          // is further down, after this point).
          if (legacyOnlyTime) {
            throw new AttendanceW4OperationError('W4_ATTRIBUTION_UNSUPPORTED')
          }

          // -- Step 2: the widened locked parent read (class-11 target lock + FOR UPDATE) ------
          // Read-only. Also re-locked by the core's own `lockParent FOR UPDATE by id` inside the
          // same transaction (a no-op re-lock); the boundary's advisory target lock precedes the
          // row lock and the core takes no advisory lock, so there is no inversion.
          let authoritativeParent = await lockShadowParentRecord(trx, org, input.userId, input.workDate)

          // -- Step 3a: absent parent → create-if-absent review placeholder --------------------
          // The FIRST DML this branch performs (Steps 1-2 are a throw and a SELECT), which is
          // exactly what makes plain ON CONFLICT DO NOTHING legal here without a SAVEPOINT.
          if (authoritativeParent === null) {
            await insertAuthoritativeReviewPlaceholderParentV1(trx, {
              orgId: envelope.orgId,
              userId: input.userId,
              workDate: input.workDate,
              timezone: input.timezone,
              isWorkday: input.isWorkday,
            })
            // ALWAYS re-read under the lock — never assume our own placeholder won. On a lost
            // race the winner's row may be a legacy-ACTIVE row (compat fingerprint becomes
            // load-bearing), another review placeholder, or a RETIRED row (refused below); this
            // re-entry is what routes every one of those to the same resolution path.
            authoritativeParent = await lockShadowParentRecord(trx, org, input.userId, input.workDate)
            if (authoritativeParent === null) {
              // Neither our INSERT nor a racer's produced a visible row under our own lock —
              // a programming/DB-state error, not a business outcome.
              boundaryFail('W4C2_AUTHORITATIVE_PARENT_UNRESOLVED', 500)
            }
          }

          // -- Step 3b: DEFAULT-REFUSE retirement guard ---------------------------------------
          // Runs before any FURTHER DML — before the split event INSERT and before the core call.
          // (In the absent branch above the only preceding DML is our own placeholder INSERT,
          // which either created a `review_placeholder` row that this guard admits, or wrote
          // nothing at all; so no refusing case ever leaves a write behind.)
          //
          // The core is reason-BLIND: its `lockParent` SELECT omits `visibility_reason` and its
          // completed-path pointer UPDATE reactivates the parent to `w4/active/active`
          // UNCONDITIONALLY. The boundary is the only reason-aware reader, so the guard belongs
          // here. It is also precisely the guard the Step-4 adapter split removes from this path:
          // the legacy punch's own operator-retirement refusal lives inside the
          // `attendance_records` upsert that the split drops.
          //
          // D2 default on the `import_rollback` fork is explicit REFUSE (never a bare completed
          // that reactivates a rolled-back day); routing it through the governed preimage-freeze
          // reactivation instead is an owner product call, not a build-time choice.
          assertParentNotRetiredForAuthoritativePunchV1({
            visibilityState: authoritativeParent.visibilityState,
            visibilityReason: authoritativeParent.visibilityReason,
          })

          // -- Step 4: split event INSERT, then the shared compute ----------------------------
          // The SPLIT half only: durable punch evidence + the wire `event`. The legacy daily
          // `attendance_records` upsert is deliberately NOT run — the core owns that row on this
          // path. `adapters.applyLivePunchLegacy` is never called from this branch.
          const authoritativeEvent = await adapters.insertLivePunchEvent(pluginTrx, legacyPunchArgs)

          // The WIRE-ECHO `workDateResolution`, derived HERE — before any write this operation
          // makes to `attendance_records` — because that is where the legacy path derives it.
          //
          // ORDERING IS SEMANTIC, NOT COSMETIC. The resolver consults OPEN records
          // (`w4c3c-active-current.ts:176-190`: `visibility_state='active'` via the current view,
          // `first_in_at IS NOT NULL AND last_out_at IS NULL`) when it breaks ties between
          // candidate shifts. The core's completed-path pointer UPDATE writes exactly that shape
          // for a check-in-only day — `first_in_at` set, `last_out_at` still null, and it flips the
          // row to `active` — so a derivation placed AFTER the core call can observe an open record
          // THIS operation just created and echo a resolution the legacy path, which derives before
          // its own upsert (`index.cjs`, `deriveLegacyLivePunchAttributionV1` ahead of
          // `appendUpsert`), could never produce for the same punch. Only the echoed field is
          // affected — the persisted calculation freezes `authoritativeResolution` below — but the
          // owner's ruling is that the authoritative response matches the legacy contract,
          // SEMANTICS included, not merely field names and casing.
          //
          // Placed adjacent to `authoritativeResolution` so both resolver reads observe the same
          // pre-write state. (The preceding event INSERT is irrelevant to both: neither read
          // touches `attendance_events`, and the create-if-absent placeholder cannot register as an
          // open record — it is `retired`, so the current view excludes it, and its `first_in_at`
          // is NULL either way.)
          const authoritativeWorkDateResolution =
            await adapters.deriveLivePunchWorkDateResolution(pluginTrx, legacyPunchArgs)

          const authoritativeNowIso = new Date().toISOString()
          const authoritativeResolution = await adapters.resolveLiveCandidate(pluginTrx, {
            orgId: envelope.orgId,
            userId: input.userId,
            occurredAt: input.occurredAtResolved,
            // PRE-resolution timezone, anchor deliberately omitted — identical contract to the
            // shadow branch's own call (see `resolveLiveCandidate`'s doc comment).
            timezone: input.requestTimezone,
          })
          const authoritativeAttribution = attributionFromResolution(authoritativeResolution, {
            orgId: envelope.orgId,
            userId: input.userId,
            source: 'live_resolution',
            nowIso: authoritativeNowIso,
          })
          let authoritativeContext: FrozenAttendanceContextV1 | null = null
          if (authoritativeAttribution.posture === 'resolved_v2') {
            authoritativeContext = await issueThroughW7Seam(pluginTrx, {
              orgId: envelope.orgId,
              userId: input.userId,
              workDate: authoritativeAttribution.value.workDate,
              shiftId: authoritativeAttribution.value.shiftId,
              timezone: authoritativeResolution.fullWinner?.timezone ?? input.requestTimezone,
              isWorkday: input.isWorkday,
              holidayKind: input.holidayKind,
            })
          }
          // Evidence is loaded AFTER the split INSERT so this punch is inside its own evidence
          // set — otherwise a day's first check-in could never produce a completed segment.
          const authoritativeEvidenceAnchorWorkDate =
            authoritativeAttribution.posture === 'resolved_v2'
              ? authoritativeAttribution.value.workDate
              : input.workDate
          const authoritativeEvidence = await loadLivePunchEvidence(
            trx,
            envelope.orgId,
            input.userId,
            authoritativeEvidenceAnchorWorkDate,
          )
          const authoritativeCalculated = calculateAttendanceSegmentsV1({
            attribution: authoritativeAttribution,
            context: authoritativeContext,
            evidence: authoritativeEvidence,
            approvedFacts: [],
          })

          // identityDrift override (canonical freeze semantics §4.2 candidate (i)), computed
          // exactly as the shadow branch does. On the AUTHORITATIVE path this override is
          // load-bearing rather than cosmetic: passing the raw calculator result through on a
          // drifted punch would write a COMPLETED row and MOVE THE PARENT POINTER onto an
          // attribution whose identity the operation never committed to.
          const authoritativeInnerComparableFingerprint =
            authoritativeAttribution.posture === 'resolved_v2'
              ? computeAttendanceOuterComparableSourceDefinitionFingerprintV1({
                  attribution: authoritativeAttribution,
                  context: authoritativeContext,
                })
              : null
          const authoritativeIdentityMismatch =
            authoritativeAttribution.posture === 'resolved_v2' &&
            (authoritativeAttribution.value.workDate !== input.workDate
              || authoritativeAttribution.value.shiftId !== input.shiftId)
          const authoritativeFingerprintMismatch =
            authoritativeAttribution.posture === 'resolved_v2' &&
            authoritativeInnerComparableFingerprint !== input.outerSourceDefinitionFingerprint
          const authoritativeIdentityDrift =
            authoritativeIdentityMismatch || authoritativeFingerprintMismatch
          const authoritativeCalculation: AttendanceSegmentCalculationResultV1 =
            authoritativeIdentityDrift
              ? {
                  outcome: 'review_required',
                  outcomeReasonCode: 'context_mismatch',
                  segments: [],
                  dailyProjection: null,
                }
              : authoritativeCalculated

          // -- Steps 5 & 6: preimage + expected pointer, and the payload fingerprint ----------
          const authoritativeProvenanceRef: AttendanceInputProvenanceRefV1 = {
            transport: 'live_event',
            sourceRef: LIVE_SOURCE_REF,
            artifactSha256: null,
            normalizedCsvSha256: null,
            convertedSheetName: null,
          }
          const authoritativePayloadFingerprint =
            computeAuthoritativeLivePunchPayloadFingerprintV1(input)
          const { preimage: authoritativePreimage, expectedCurrentCalculationId } =
            buildAuthoritativeLivePunchPreimageV1(authoritativeParent)

          // -- Step 7: the core owns the calc row, the lineage, and the parent pointer --------
          const authoritativeWritten = await writeAuthoritativeSegmentCalculationV1(trx, {
            orgId: envelope.orgId,
            recordId: authoritativeParent.id,
            entrypoint: 'live',
            operationId: identity.id,
            calculation: authoritativeCalculation,
            attribution: authoritativeAttribution,
            context: authoritativeContext,
            evidence: authoritativeEvidence as unknown as readonly unknown[],
            approvedFacts: [],
            provenanceRef: authoritativeProvenanceRef,
            // BOTH places: top-level for the core's own conflict check, and embedded so a
            // genuine retry's `input_provenance.payloadFingerprint` read matches.
            inputProvenance: {
              ...authoritativeProvenanceRef,
              payloadFingerprint: authoritativePayloadFingerprint,
            },
            payloadFingerprint: authoritativePayloadFingerprint,
            preimage: authoritativePreimage,
            expectedCurrentCalculationId,
            sourceBatchId: null,
            actorId: authorization.actorId,
            correlationId: envelope.correlationId,
          })

          // Seal fingerprints are RECOMPUTED at the boundary over the same inputs the core
          // hashed — the core's return shape is deliberately unchanged by D2. The tier arg MUST
          // be `segment_authoritative`: copying the shadow builder's `legacy_shadow` would seal a
          // fingerprint that does not match the persisted authoritative row.
          const authoritativeSemanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
            attribution: authoritativeAttribution,
            context: authoritativeContext,
            evidence: authoritativeEvidence,
            approvedFacts: [],
            manualOverride: null,
            mergePolicy: 'append',
            calculationTier: 'segment_authoritative',
            engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
            snapshotSchemaVersion: 1,
          })
          const authoritativeProvenanceFingerprint =
            computeAttendanceProvenanceFingerprintV1(authoritativeProvenanceRef)

          // Outbox BEFORE seal (lock 8.2 steps 14-15), unconditional — byte-identical to the
          // shadow path's own enqueue, which already fires for review outcomes today. Whether a
          // review-only authoritative outcome SHOULD emit `attendance.punched` is an open product
          // question; D2 changes nothing about it.
          await enqueueAttendanceResultEventOutboxV1(trx, identity, [
            {
              eventKind: 'attendance.punched',
              payload: {
                userId: input.userId,
                orgId: envelope.orgId,
                workDate: input.workDate,
                eventType: input.eventType,
                occurredAt: input.occurredAtResolved,
                timezone: input.timezone,
              },
              payloadSchemaVersion: 1,
              businessKeyFingerprint: computeAttendanceBusinessKeyFingerprintV1({
                kind: 'attendance.punched',
                orgId: envelope.orgId,
                operationId: identity.id,
              }),
            },
          ])

          // -- Step 8a: the caller response — PRESERVES THE EXISTING PUBLIC CONTRACT -----------
          //
          // `POST /api/attendance/punch` returns `{event, record, workDateResolution}` where
          // `record` is the persisted `attendance_records` ROW in its snake_case DB shape (the
          // published `AttendanceRecord` contract; the legacy adapter returns exactly that row
          // from its own `RETURNING *` upsert). The authoritative path MUST return the same shape
          // — field set and casing identical, only the VALUES differing (they now reflect the
          // authoritative projection rather than the legacy one).
          //
          // An earlier revision of this branch mapped `record` from `calculation.dailyProjection`
          // (camelCase `PreparedDailyProjectionV1`, nine fields, all-null for review). That was a
          // BREAKING contract change: it renamed every field, dropped columns the published shape
          // carries (`id`, `user_id`, `org_id`, `is_workday`, `source_batch_id`,
          // `projection_owner`, `visibility_state`, `visibility_reason`, `created_at`,
          // `updated_at`) and would have silently broken the mobile client, with only tests
          // FREEZING the new shape rather than approving it. Owner ruling: preserve the contract.
          // Any future protocol change is an independent RATIFY plus OpenAPI/SDK/client updates,
          // not a side effect of delivering the authoritative writer.
          //
          // So: re-SELECT the row the core just wrote, INSIDE the same transaction and after the
          // core's pointer UPDATE, and ship it verbatim. For a COMPLETED outcome this is the
          // promoted `w4`/`active` row carrying the authoritative daily values; for a REVIEW
          // outcome it is the parent as it stands (the create-if-absent placeholder, or the
          // untouched legacy row when one already existed) — in both cases a REAL persisted row,
          // never a synthesized acknowledgement.
          const persistedParent = await trx.query(
            `SELECT * FROM attendance_records WHERE id = $1::uuid AND org_id = $2`,
            [authoritativeParent.id, envelope.orgId],
          )
          if (persistedParent.rows.length !== 1) {
            // The row was locked FOR UPDATE by this transaction and the core wrote through it, so
            // its absence here is a programming/DB-state error, not a business outcome.
            boundaryFail('W4C2_AUTHORITATIVE_PARENT_UNRESOLVED', 500)
          }
          const authoritativeRecord = persistedParent.rows[0] as Record<string, unknown>

          // `authoritativeWorkDateResolution` was derived in Step 4, BEFORE the core's writes —
          // see the ordering note there. Deriving it here instead would let it observe the open
          // record this operation's own pointer UPDATE just created.
          const authoritativeResponse = {
            event: authoritativeEvent,
            record: authoritativeRecord,
            workDateResolution: authoritativeWorkDateResolution,
          }

          await sealAttendanceResultOperationV1(trx, identity, {
            responseSnapshot: wireJson(authoritativeResponse),
            resolvedRecordId: authoritativeParent.id,
            resolvedCalculationId: authoritativeWritten.calculationId,
            resultSemanticFingerprint: authoritativeSemanticFingerprint,
            resultProvenanceFingerprint: authoritativeProvenanceFingerprint,
          })

          // The P-A obligation: this `return` is what keeps control from reaching the shadow
          // `applyLivePunchLegacy` call site below.
          return {
            kind: 'w4' as const,
            response: authoritativeResponse,
            shadow: {
              calculationId: authoritativeWritten.calculationId,
              outcome: authoritativeCalculation.outcome,
              outcomeReasonCode: authoritativeCalculation.outcomeReasonCode,
            },
          }
        }

        if (legacyOnlyTime && posture.effectiveState === 'eligible') {
          // Reject BEFORE event/request/result/effect DML: rollback discards
          // the preflight claim; no source row is ever written.
          throw new AttendanceW4OperationError('W4_ATTRIBUTION_UNSUPPORTED')
        }

        // Shadow: execute the prepared legacy projection (the same closed
        // adapter bytes), then append the shadow result atomically.
        const result = await adapters.applyLivePunchLegacy(pluginTrx, legacyPunchArgs)

        // Section 8.2 step 4: candidate resolution runs inside the
        // transaction, BEFORE step 5's target lock/parent FOR UPDATE below
        // (reorder — #4612 gate3 P2-1 remediation, canonical freeze
        // semantics judgment §6 "锁序倒置": the parent lock previously
        // preceded this resolution, inverting the lock's numbered step
        // order. Both calls are read-only queries under this transaction's
        // SERIALIZABLE snapshot with no lock contention between them, so the
        // reorder has no observable behavioral effect and no independently
        // provable mutation leg is claimed for it — this is a structural
        // realignment with §8.2's step numbering, not a correctness fix.
        // `timezone` below is the exact PRE-resolution value the route
        // itself fed its own resolver call (`input.requestTimezone`); the
        // anchor is deliberately OMITTED so the resolver derives it itself
        // from `(occurredAt, timezone)` — see `resolveLiveCandidate`'s own
        // doc comment above for why `input.timezone`/`input.workDate`
        // (POST-resolution) must never be used here. The legacy-only-time
        // branch below never resolves a candidate at all, so this is skipped
        // for it.
        const nowIso = new Date().toISOString()
        const resolution = legacyOnlyTime
          ? null
          : await adapters.resolveLiveCandidate(pluginTrx, {
              orgId: envelope.orgId,
              userId: input.userId,
              occurredAt: input.occurredAtResolved,
              timezone: input.requestTimezone,
            })

        const parent = await lockShadowParentRecord(trx, org, input.userId, input.workDate)
        if (!parent) {
          // The legacy upsert always creates the parent; a missing row here is
          // a programming error, not a business outcome.
          boundaryFail('W4C2_SHADOW_PARENT_MISSING', 500)
        }
        const version = await nextCalculationVersion(trx, parent.id)
        const command = envelope.commands[0]
        const provenanceRef: AttendanceInputProvenanceRefV1 = {
          transport: 'live_event',
          sourceRef: LIVE_SOURCE_REF,
          artifactSha256: null,
          normalizedCsvSha256: null,
          convertedSheetName: null,
        }
        const correlationId = envelope.correlationId

        let calculationId: string
        let outcome: 'completed' | 'review_required'
        let outcomeReasonCode: string
        let semanticFingerprint: string
        let provenanceFingerprint: string

        if (legacyOnlyTime) {
          // Exactly one zero-segment, no-pointer review carrying the raw value
          // plus legacy-parser provenance (lock 12.3 matrix, shadow leg).
          // `evidence_snapshot` stays a CLOSED AttendanceEvidenceV1 array (the
          // legacy-only value is NOT admissible W4 evidence — that is the whole
          // point of this branch), so the frozen raw/parser/resolved-instant
          // provenance lives in `input_provenance`; the raw bytes still bind
          // the semantic fingerprint through the attribution sourceFingerprint.
          outcome = 'review_required'
          outcomeReasonCode = 'legacy_time_ingress_not_authoritative'
          const attribution = unsupportedAttribution('unresolved', sha256Hex(String(input.occurredAtRaw)))
          const inserted = await insertShadowCalculation(trx, {
            orgId: envelope.orgId,
            recordId: parent.id,
            version,
            entrypoint: 'live',
            operationId: identity.id,
            attribution,
            context: null,
            segmentSnapshot: [],
            evidence: [],
            approvedFacts: [],
            inputProvenance: {
              ...provenanceRef,
              legacyTimeIngress: {
                raw: input.occurredAtRaw,
                parser: 'legacy_parseDateInput_server_local',
                resolvedInstant: input.occurredAtResolved,
              },
            },
            provenanceRef,
            mergePolicy: 'append',
            outcome,
            outcomeReasonCode,
            segments: [],
            dailyProjection: null,
            actorId: authorization.actorId,
            correlationId,
            legacyProjection: parent,
          })
          calculationId = inserted.calculationId
          semanticFingerprint = inserted.semanticFingerprint
          provenanceFingerprint = inserted.provenanceFingerprint
        } else {
          // W2/context freeze: `resolution` was already re-run above (step
          // 4, this transaction's snapshot) — build the frozen attribution
          // and context from it.
          const attribution = attributionFromResolution(resolution!, {
            orgId: envelope.orgId,
            userId: input.userId,
            source: 'live_resolution',
            nowIso,
          })
          let context: FrozenAttendanceContextV1 | null = null
          if (attribution.posture === 'resolved_v2') {
            context = await issueThroughW7Seam(pluginTrx, {
              orgId: envelope.orgId,
              userId: input.userId,
              workDate: attribution.value.workDate,
              shiftId: attribution.value.shiftId,
              // Section 5.2/5.3 (Q16 §4.1 :562-567, Q17 §5.2 :924): the
              // frozen context's timezone must come from THIS freeze step's
              // own winner, never the route's (possibly stale) input.timezone
              // — attributionFromResolution already required
              // resolution.fullWinner.timezone to be a non-empty string
              // whenever posture reached 'resolved_v2', so the fallback below
              // is defensive only (unreachable on this branch in practice).
              timezone: resolution!.fullWinner?.timezone ?? input.requestTimezone,
              isWorkday: input.isWorkday,
              holidayKind: input.holidayKind,
            })
          }
          // Section 5.3 (:936): evidence is anchored to the FROZEN
          // attribution's own work date, not the boundary's (possibly
          // stale, pre-transaction) `input.workDate` — the two coincide
          // unless a genuine DB-state race occurred between the route's
          // resolution and this transaction's snapshot (see the identity
          // drift check below, which forces review whenever they diverge).
          const evidenceAnchorWorkDate =
            attribution.posture === 'resolved_v2' ? attribution.value.workDate : input.workDate
          const evidence = await loadLivePunchEvidence(trx, envelope.orgId, input.userId, evidenceAnchorWorkDate)
          const calculation = calculateAttendanceSegmentsV1({
            attribution,
            context,
            evidence,
            approvedFacts: [],
          })
          // Section 8.2 step 7 (`:1821-1822` verbatim: "require candidate
          // identity plus source-definition fingerprint equality"): the
          // re-run candidate identity must equal the identity already
          // committed to when this operation was normalized (`input.workDate`
          // / `input.shiftId`, the latter baked into the route's own
          // pre-transaction `resolvePunchWorkDateByShiftWindow` call) —
          // reachable only via a genuine DB-state race between the route's
          // pre-transaction resolution and this transaction's snapshot (the
          // legacy adapter's own in-transaction resolution above and this one
          // share the SAME inputs/snapshot, so they always agree with EACH
          // OTHER; this compares against the OUTER, pre-transaction identity
          // instead). A completed V2 result may never attach to a parent
          // record keyed by a DIFFERENT work date, NOR carry a DIFFERENT
          // winning shift, than its own frozen attribution — canonical
          // freeze semantics judgment §4.2 candidate (i): review-required
          // with the closed `context_mismatch` code, zero segments, no
          // pointer change, the legacy projection already applied above left
          // exactly as is.
          //
          // W4C-2 remediation (#4612 gate3 P2-1 self-report ⑥): widened from
          // workDate-only to (workDate, shiftId) — a `shiftId`-only race
          // (workDate held fixed, only the winning shift swapped) previously
          // slipped this gate silently (`outcome` stayed `completed`); see
          // the real two-connection leg in
          // `attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts`
          // ("Group D").
          //
          // W4C-2 gate3 P2-1 closure (#4612 self-report ⑥, second round —
          // source-definition fingerprint half WIRED, PENDING O-5): the
          // comparison this code performs is wired end-to-end, but it
          // compares a NARROWER domain than the object §8.2 step 7 names
          // ("the source-definition fingerprint" — the storage column's
          // domain, which still includes `reasonCode`) — see the O-5 status
          // block atop `computeAttendanceOuterComparableSourceDefinition
          // FingerprintV1` in `w4c1-fingerprints.ts` and the PR body's O-5
          // section for the two full remediation specs and why this is not
          // yet a satisfied clause. `input.outerSourceDefinitionFingerprint`
          // is the route's own PRE-transaction fingerprint (see the field's
          // own doc comment); `innerComparableSourceDefinitionFingerprint`
          // below is this transaction's own freeze-step fingerprint, in the
          // SAME narrower comparison domain (see next paragraph) — a
          // SEPARATE call from the one `insertShadowCalculation` makes for
          // the STORAGE column (that one stays the original, wider domain;
          // `insertShadowCalculation`'s own signature/contract is
          // unchanged).
          //
          // DOMAIN NOTE — why this is NOT the storage fingerprint:
          // `computeAttendanceOuterComparableSourceDefinitionFingerprintV1`
          // (not `computeAttendanceSourceDefinitionFingerprintV1`) projects
          // out `reasonCode` IN ADDITION TO `resolvedAt`. Discovered
          // empirically (`attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts`
          // "Group E / eDay2"): the lock's own §8.2 step 3-before-4 ordering
          // means this SAME operation's own step-3 legacy write can flip
          // which branch of `selectAmongMatchingCandidates` matches
          // (`openPreviousMatches` seeing an open row THIS transaction just
          // created), changing `reasonCode` with ZERO concurrency and the
          // SAME resulting `workDate`/`shiftId` — a false positive the wider
          // storage domain would have produced here. See
          // `w4c1-fingerprints.ts`'s own doc comment on that function for
          // the full account of why excluding `reasonCode` is principled
          // (tie-break provenance, not identity or policy).
          //
          // STRUCTURAL NOTE — SUBSUMPTION for WELL-FORMED shifts, and a
          // RETRACTION (#4612 gate4 P2, independent review): an earlier
          // version of this comment claimed an "identity-only,
          // fingerprint-silent" leg "could not be built" from a real DB
          // fixture in this schema. That claim was WRONG AS STATED. What is
          // actually true, in three parts:
          //
          //  (a) For any shiftId swap between two WELL-FORMED shifts (both
          //      resolve a non-null `context`), subsumption holds: the
          //      (narrowed) fingerprint domain still CONTAINS
          //      `workDate`/`shiftId` (only `resolvedAt`/`reasonCode` are
          //      excluded), and `FrozenAttendanceContextV1` (`context`) ALSO
          //      carries its own `shiftId` independently
          //      (`w4c0-write-boundary-types.ts`) — so a real shiftId swap
          //      between two well-formed shifts changes BOTH
          //      `attribution.value.shiftId` AND `context.shiftId`, tripping
          //      the fingerprint conjunct too. This is confirmed by mutation
          //      (see the freeze-anchor test's own header comment and the PR
          //      body): neutering `identityMismatch` alone leaves every
          //      well-formed-shift leg in this suite green — the fingerprint
          //      conjunct independently catches the same race.
          //
          //  (b) The escape THIS well-formed-shift argument cannot rule out
          //      — identity differs while the fingerprint conjunct stays
          //      SILENT — requires `context === null` on BOTH the outer and
          //      inner reads, i.e. `buildW4ShadowFrozenContextV1` rejecting
          //      BOTH candidate shifts' shapes. The enumeration of its
          //      null-context paths (`index.cjs` ~L21451-21489 — cross-
          //      checked against the function's four `return null` sites:
          //      three simple sites, plus the ~L21479 compound guard's five
          //      disjuncts. Two of those five disjuncts (`!startTime` and
          //      `!endTime`) share one cause and collapse into the single
          //      list item (iv) below, so the compound guard contributes
          //      four list items, not five — 3 simple + 4 compound = the
          //      seven entries that follow, not five and not eight):
          //      (i) no matching shift row; (ii) more than 3 segment rows
          //      (ruled out for a genuinely persisted shift — the CHECK
          //      bounds the RANGE (`chk_attendance_shift_segments_index_range`
          //      caps `segment_index` at 0-2) and the per-shift UNIQUE index
          //      (`uq_attendance_shift_segments_shift_index` on
          //      `(shift_id, segment_index)`) bounds OCCUPANCY (each of the
          //      three legal values can appear at most once) — CHECK alone
          //      does not cap row count (four rows could all satisfy
          //      `segment_index = 1`), the two constraints TOGETHER are
          //      needed to conclude a 4th row cannot be inserted at all;
          //      `zzzz20260724120000_create_attendance_shift_segments.ts`);
          //      (iii) a NON-DENSE segment_index set (`index !== i` at
          //      ~L21479 — the CHECK constraint bounds the range, not the
          //      density, and the unique index does not require row 0 to
          //      exist, so a single `segment_index = 1` row with no row 0 IS
          //      insertable); (iv) `normalizeTimeString` failing on a
          //      segment's own `start_time`/`end_time` — e.g. a sub-second-
          //      precision value (`'09:00:00.5'`, legal for the column's
          //      `time` type, verified by direct INSERT: no CHECK on this
          //      table constrains time-string format) fails the read-side
          //      regex; this is NOT a "malformed row" case, it is legal per
          //      every CHECK/uniqueness constraint the table has, so it IS
          //      directly constructible in a real-DB test fixture, same as
          //      (iii) — but the shift service's create/update path's own
          //      input validation (`SEGMENT_INPUT_TIME_PATTERN` in
          //      `attendance-shift-service.cjs`, strict `HH:MM`, no seconds)
          //      rejects anything but exact minute-granularity, so THAT path
          //      never produces one either. NOT independently checked here:
          //      the one-time migration backfill
          //      (`zzzz20260724120000_create_attendance_shift_segments.ts`)
          //      is a SEPARATE writer — it derives segment 0's `start_time`/
          //      `end_time` from the shift's own legacy `work_start_time`/
          //      `work_end_time` columns, not from validated create/update
          //      input, and runs once at migrate time rather than on the
          //      ongoing write path; whether those legacy columns can
          //      themselves carry sub-second precision is not analyzed here;
          //      (v) a segment's
          //      `start_day_offset !== 0` (ruled out the same way as (ii) —
          //      `chk_attendance_shift_segments_start_day_offset` CHECK
          //      forces `start_day_offset = 0`, so this disjunct of the
          //      ~L21479 guard can never fire against a persisted row);
          //      (vi) a segment's `end_day_offset` outside `{0, 1}` (ruled
          //      out the same way — `chk_attendance_shift_segments_end_day_offset`
          //      CHECK forces `end_day_offset IN (0, 1)`); (vii) blank
          //      legacy `work_start_time`/`work_end_time`, reached ONLY via
          //      the `else` branch taken when `segmentRows.length === 0`
          //      (~L21492-21495) — NOT, as an earlier version of this
          //      comment claimed, "via path (iii)/(iv) once segment rows
          //      exist": that `else` branch is mutually exclusive with
          //      (iii)/(iv)/(v)/(vi), which all `return null` from inside
          //      the `segmentRows.length > 0` loop and can never fall
          //      through to it. (vii) is reachable only when the shift has
          //      zero persisted segment rows AND its own legacy time
          //      columns fail `normalizeTimeString`; `NOT NULL` on
          //      `attendance_shifts.work_start_time`/`work_end_time` rules
          //      out a blank/NULL value for a persisted row, but (as with
          //      (iv)) does not by itself rule out a sub-second-precision
          //      value — that route is not analyzed here. Paths
          //      (i)/(ii)/(v)/(vi) are blocked outright by a CHECK
          //      constraint with no fixture, malformed or otherwise, able
          //      to insert one; (vii) needs a deleted/never-created shift
          //      row or an un-migrated/corrupted one to hit blank legacy
          //      columns via the analyzed route. None of these is pursued
          //      (no sanctioned production path produces one mid-race — a
          //      different, unrelated defect class). Paths (iii) and (iv)
          //      are DIFFERENT: both are legal per every CHECK/uniqueness
          //      constraint this table has, so both ARE directly
          //      constructible in a real-DB test fixture, even though the
          //      canonical shift service (the only writer audited here for
          //      create/update; the one-time migration backfill described
          //      above under (iv) is a second sanctioned writer whose source
          //      columns are NOT analyzed here) never produces either shape
          //      via create/update (dense 0..2 for (iii) — see the
          //      migration's header comment; strict `HH:MM` input for (iv)
          //      — see above).
          //
          //  (c) CONCLUSION, corrected: an identity-only, fingerprint-silent
          //      leg is NOT reachable from two well-formed shifts (part a
          //      still holds), and is NOT production-reachable (part b's
          //      (iii) and (iv) both require a fixture the canonical shift
          //      service never writes) — but it IS constructible as a
          //      deliberately malformed real-DB test fixture, and the
          //      freeze-anchor test's "Group G" leg now does exactly that
          //      (via (iii)), giving the identity conjunct a genuine
          //      discriminating leg (closing the untested-guard gap gate4
          //      found; the fingerprint conjunct remains the only conjunct
          //      with an EXCLUSIVE mutation-discriminating leg among the
          //      well-formed-shift legs (L6: neutering fingerprint alone
          //      reds ONLY L6) — Group D / Group D-overnight are DOUBLE-
          //      covered well-formed-shift legs (neutering either conjunct
          //      alone leaves them green; both must be neutered to red
          //      them), not legs the fingerprint conjunct alone
          //      discriminates). See that test's own comment and the
          //      leg-map atop the file for the mutation evidence.
          //
          //  Letter note (#4612 gate4 round 3, P3-1/P3-2 fix): this
          //  sub-enumeration was previously five items (i)-(v) and mis-
          //  stated as "the full enumeration" while omitting the
          //  start_day_offset/end_day_offset disjuncts, and its old (v)
          //  claimed a false "only reachable via (iii)/(iv)" causal chain.
          //  It is now seven items (i)-(vii); old (v) is renumbered (vii).
          const innerComparableSourceDefinitionFingerprint =
            attribution.posture === 'resolved_v2'
              ? computeAttendanceOuterComparableSourceDefinitionFingerprintV1({ attribution, context })
              : null
          const identityMismatch =
            attribution.posture === 'resolved_v2' &&
            (attribution.value.workDate !== input.workDate || attribution.value.shiftId !== input.shiftId)
          const fingerprintMismatch =
            attribution.posture === 'resolved_v2' &&
            innerComparableSourceDefinitionFingerprint !== input.outerSourceDefinitionFingerprint
          const identityDrift = identityMismatch || fingerprintMismatch
          outcome = identityDrift ? 'review_required' : calculation.outcome
          outcomeReasonCode = identityDrift ? 'context_mismatch' : calculation.outcomeReasonCode
          const inserted = await insertShadowCalculation(trx, {
            orgId: envelope.orgId,
            recordId: parent.id,
            version,
            entrypoint: 'live',
            operationId: identity.id,
            attribution,
            context,
            segmentSnapshot: context ? (context.segments as unknown as unknown[]) : [],
            evidence: evidence as unknown as unknown[],
            approvedFacts: [],
            inputProvenance: { ...provenanceRef },
            provenanceRef,
            mergePolicy: 'append',
            outcome,
            outcomeReasonCode,
            segments: identityDrift ? [] : calculation.segments,
            dailyProjection: identityDrift ? null : calculation.dailyProjection,
            actorId: authorization.actorId,
            correlationId,
            legacyProjection: parent,
          })
          calculationId = inserted.calculationId
          semanticFingerprint = inserted.semanticFingerprint
          provenanceFingerprint = inserted.provenanceFingerprint
        }

        // Outbox BEFORE seal (lock 8.2 steps 14-15): the lifecycle event this
        // entrypoint currently emits becomes a durable row; the caller must NOT
        // direct-emit for this result kind.
        await enqueueAttendanceResultEventOutboxV1(trx, identity, [
          {
            eventKind: 'attendance.punched',
            payload: {
              userId: input.userId,
              orgId: envelope.orgId,
              workDate: input.workDate,
              eventType: input.eventType,
              occurredAt: input.occurredAtResolved,
              timezone: input.timezone,
            },
            payloadSchemaVersion: 1,
            businessKeyFingerprint: computeAttendanceBusinessKeyFingerprintV1({
              kind: 'attendance.punched',
              orgId: envelope.orgId,
              operationId: identity.id,
            }),
          },
        ])

        const response = wireJson(result)
        await sealAttendanceResultOperationV1(trx, identity, {
          responseSnapshot: response,
          resolvedRecordId: parent.id,
          resolvedCalculationId: calculationId,
          resultSemanticFingerprint: semanticFingerprint,
          resultProvenanceFingerprint: provenanceFingerprint,
        })

        return {
          kind: 'w4' as const,
          response: result,
          shadow: { calculationId, outcome, outcomeReasonCode },
        }
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Scheduled absence run.
  //
  // SCOPE NOTE (W4C-2 gate3 P2-1 closure, second round): the scheduled path
  // does NOT get a step-7 identity/fingerprint equality gate, by design, not
  // omission. `workDate` here is the RUN's own identity byte (part of the
  // operation's normalized envelope before this transaction even opens —
  // see `AttendanceScheduledRunBoundaryInputV1.workDate`), never a resolver
  // OUTPUT the way the live-punch route's pre-transaction `workDate` is; and
  // `adapters.resolveScheduledCandidate` below is the ONLY W2 resolution
  // this operation ever performs — there is no separate OUTER,
  // pre-transaction resolver call for a scheduled run to race against (the
  // route/job that enqueues the run does not itself resolve a candidate).
  // With no outer read to anchor an equality comparison against, step 7's
  // "re-run ... and require equality with the [prior] identity" has nothing
  // to re-run against on this path — it does not apply.
  // -------------------------------------------------------------------------

  /**
   * `cron` (P03): the registered internal scheduler identity (lock 4.1:
   * "scheduler scope is available only to the registered internal scheduler
   * identity"). This witness is minted ONCE per run and reused across every
   * target user — it carries no per-user subject (the `org_scheduler` scope
   * intentionally waives per-subject predicates; the scheduler's target-user
   * list itself is not caller-authorization-bearing).
   */
  function internalScheduledAuthorization(
    orgId: string,
    sourceRef: string,
  ): AuthorizedAttendanceWriteContextV1 {
    return createAuthorizedAttendanceWriteContextV1({
      actorId: ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
      actorPosture: 'scheduler',
      tokenSubjectUserId: null,
      orgId,
      subjectScope: { kind: 'org_scheduler' },
      capability: 'scheduled',
      sourceRef,
    })
  }

  /**
   * `admin_run` (P04) — W4C-2 remediation P1-4: a HOST-ISSUED plain admin
   * identity (route-supplied, same "route submits pure data, private adapter
   * mints" pattern as `executeLivePunch`'s `actorPosture: 'self'` witness
   * above), minted fresh for EACH target user with `subjectScope:
   * 'explicit_users'` so `recheckAttendanceActorLivenessInTransactionV1`
   * (called inside `attendanceResultOperationPreflightV1`, BEFORE any
   * source/result DML) independently re-verifies both the admin actor's own
   * active-user/membership state AND the target subject's — closing the gap
   * where `admin_run` was previously minted with the internal scheduler
   * constant and lost the real human operator identity entirely.
   *
   * The internal scheduler constant can never satisfy this branch: it is not
   * a directory user, so `requireActiveUser` fails it in-transaction even
   * without the explicit guard below — the guard exists to make the rejection
   * a deterministic, zero-SQL, mint-time failure instead of an incidental one.
   *
   * Posture is `platform_admin`, not `attendance_admin`: the route's RBAC gate
   * (`withPermission('attendance:admin', ...)`) is a GLOBAL permission check
   * (`user_permissions`/`role_permissions` carry no `org_id` column in this
   * codebase — an admin can already target ANY `orgId` in the request body).
   * `attendance_admin` posture would newly REQUIRE an active `user_orgs` row
   * for the target org (`recheckAttendanceActorLivenessInTransactionV1`'s
   * `requireActiveMembership`), which would silently break that existing
   * cross-org capability. `platform_admin` waives the membership predicate
   * (matching current behavior) while still requiring the actor be a real
   * active, non-deactivated user (closing the P1-4 gap) — org/subject
   * predicates for the TARGET user are never waived.
   */
  function adminRunScheduledAuthorization(
    orgId: string,
    adminActorId: string,
    userId: string,
  ): AuthorizedAttendanceWriteContextV1 {
    if (adminActorId === ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1) {
      boundaryFail('W4C2_SCHEDULED_ADMIN_WITNESS_INVALID')
    }
    return createAuthorizedAttendanceWriteContextV1({
      actorId: adminActorId,
      actorPosture: 'platform_admin',
      tokenSubjectUserId: adminActorId,
      orgId,
      subjectScope: { kind: 'explicit_users', userIds: [userId] },
      capability: 'scheduled',
      sourceRef: SCHEDULED_SOURCE_REF.admin_run,
    })
  }

  async function executeScheduledRunInternal(
    input: AttendanceScheduledRunBoundaryInputV1,
    recoveryRunId: string | null,
  ): Promise<AttendanceScheduledRunBoundaryResultV1> {
    if (!(SCHEDULED_INITIATORS as readonly string[]).includes(input.initiator)) {
      boundaryFail('W4C2_SCHEDULED_INITIATOR_INVALID')
    }
    // W4C-2 remediation P1-4: the initiator/witness shape is validated
    // UNCONDITIONALLY (before the posture probe, like the initiator check
    // above) — this is caller-shape validation (only this module's own two
    // production callers in index.cjs ever set `adminActorId`; no end-user
    // input reaches it), not a new business-input rejection surface on the
    // byte-identical legacy response, so it does not conflict with this
    // module's "legacy admits no new rejection surface" doctrine.
    if (recoveryRunId === null) {
      if (input.initiator === 'cron' && input.adminActorId !== null) {
        boundaryFail('W4C2_SCHEDULED_WITNESS_INITIATOR_MISMATCH')
      }
      if (
        input.initiator === 'admin_run'
        && (typeof input.adminActorId !== 'string' || input.adminActorId.length === 0)
      ) {
        boundaryFail('W4C2_SCHEDULED_ADMIN_WITNESS_REQUIRED')
      }
    }
    const workDate = parseCanonicalAttendanceWorkDateV1(input.workDate) as string
    const targetUserIds = [...input.targetUserIds].map(String)
    // Org-key pre-classification (same doctrine as executeLivePunch): a legacy
    // org key outside the canonical lexical domain cannot carry a rollout row,
    // so it is structurally `legacy_projection_only` — same closed adapter, no
    // canonical org/user parsing, no witness surface.
    let rolloutKey: ReturnType<typeof parseCanonicalAttendanceRolloutOrgKeyV1> | null = null
    try {
      rolloutKey = parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)
    } catch {
      rolloutKey = null
    }
    const orgKey = rolloutKey === null ? String(input.orgId) : (rolloutKey as unknown as string)

    // Posture probe + (for legacy) the batch DML in ONE canonical transaction:
    // suspension preflight and posture resolution precede the first source DML.
    const probe = await withConnection((client) =>
      runAttendanceResultOperationTransactionV1(client, async (trx) => {
        if (rolloutKey === null) {
          if (recoveryRunId !== null) {
            boundaryFail('W4C2_SCHEDULED_RUN_RECOVERY_ORG_INVALID')
          }
          if (input.legacyDedupHit === true) {
            return { mode: 'legacy_dedup' as const, rows: [] as Array<{ user_id: string }> }
          }
          if (targetUserIds.length === 0) {
            return { mode: 'legacy' as const, rows: [] as Array<{ user_id: string }> }
          }
          const rows = await adapters.applyScheduledAbsenceLegacy(pluginShapedTrx(trx), {
            orgId: orgKey,
            workDate,
            timezone: input.timezone,
            userIds: targetUserIds,
          })
          return { mode: 'legacy' as const, rows: rows as Array<{ user_id: string }> }
        }
        await acquireAttendanceCalculationRolloutLock(trx, rolloutKey, 'shared')
        const posture = await resolveSegmentCalculationPosture(trx, orgKey)
        if (posture.writePosture === 'blocked') {
          return { mode: 'suspended' as const, rows: [] as Array<{ user_id: string }> }
        }
        if (posture.writePosture === 'legacy_projection_only') {
          if (recoveryRunId !== null) {
            return { mode: 'w4' as const, rows: [] as Array<{ user_id: string }> }
          }
          if (input.legacyDedupHit === true) {
            return { mode: 'legacy_dedup' as const, rows: [] as Array<{ user_id: string }> }
          }
          if (targetUserIds.length === 0) {
            return { mode: 'legacy' as const, rows: [] as Array<{ user_id: string }> }
          }
          const rows = await adapters.applyScheduledAbsenceLegacy(pluginShapedTrx(trx), {
            orgId: orgKey,
            workDate,
            timezone: input.timezone,
            userIds: targetUserIds,
          })
          return { mode: 'legacy' as const, rows: rows as Array<{ user_id: string }> }
        }
        // Gate D3 (#4556 / #4844) — SITE A, the org-wide probe: REPLACEMENT BY ROUTING, not a
        // delete. This branch previously failed closed here. At this point in the probe
        // transaction NO run, NO targets and NO witnesses exist yet, so nothing per-target can be
        // recorded and no D1-core call belongs here — the correct authoritative treatment is
        // exactly the classification the shadow and eligible postures already take: fall through
        // to the run-registry mode below and let the durable per-target machinery (which admits
        // authoritative posture: `createOrResumeAttendanceScheduledRunV1` returns early only on
        // `blocked` and `legacy_projection_only`, and freezes the run row at
        // shadow/eligible/authoritative) do the writing.
        //
        // FAIL-OPEN CHECK: an authoritative posture cannot leak into the legacy batch arm — that
        // arm is gated on `legacy_projection_only`, which precedes this point and is disjoint
        // (`POSTURE_TABLE` maps state `authoritative` to writePosture `authoritative`). Pinned
        // behaviourally by the D3 probe-routing leg (authoritative org ⇒ run-registry mode, ZERO
        // legacy batch INSERT..SELECT rows, no 503) with `legacy_projection_only`/`blocked`
        // negative controls, not by this comment.
        return { mode: 'w4' as const, rows: [] as Array<{ user_id: string }> }
      }),
    )

    if (probe.mode === 'suspended') return { kind: 'suspended' }
    if (probe.mode === 'legacy_dedup') return { kind: 'legacy_dedup' }
    if (probe.mode === 'legacy') return { kind: 'legacy', rows: probe.rows }

    // W4 path only below: an ordinary `cron` run and a recovery sweep use the
    // registered internal scheduler identity; an ordinary `admin_run` mints a
    // FRESH witness per user from the real host-authenticated admin identity.
    // Recovery preserves the durable run initiator but records its own recovery
    // source ref, never fabricating a human actor. Every witness is SQL-rechecked
    // inside each per-user registry transaction before any source/result DML.
    const recoveryAuthorization =
      recoveryRunId === null ? null : internalScheduledAuthorization(orgKey, SCHEDULED_RECOVERY_SOURCE_REF)
    const cronAuthorization =
      recoveryRunId === null && input.initiator === 'cron'
        ? internalScheduledAuthorization(orgKey, SCHEDULED_SOURCE_REF.cron)
        : null
    const adminActorId = input.adminActorId

    // W4C-2 caller cutover (owner ruling 2026-07-28, "(b-narrow)"): the durable
    // run-creation/resume transaction (w4c2-scheduled-run.ts section 1.7) is the
    // FIRST step of the w4 branch — it re-resolves posture and the class-00/
    // class-01 locks independently of the probe above (the same "re-check
    // inside the owning transaction" doctrine every other posture read in this
    // file already follows). The injected membership resolver wraps the SAME
    // pre-resolved (generate, review) lists the caller already computed —
    // `runAutoAbsenceForOrgDate` in index.cjs — never a re-derivation.
    const membersForRun: AttendanceScheduledRunMemberInputV1[] = [
      ...targetUserIds.map((userId) => ({ userId, targetKind: 'generate' as const, reviewReasonCode: null })),
      ...input.reviewTargets.map((rt) => ({
        userId: rt.userId,
        targetKind: 'review' as const,
        reviewReasonCode: rt.reasonCode,
      })),
    ]
    const resolveMembership: AttendanceScheduledRunMembershipResolverV1 = async () => membersForRun

    const startOutcome = await withConnection((client) =>
      runAttendanceResultOperationTransactionV1(client, (trx) => {
        if (recoveryRunId !== null) {
          return resumeAttendanceScheduledRunByExactIdV1(
            trx,
            { orgId: orgKey, initiator: input.initiator, workDate, runId: recoveryRunId },
            resolveMembership,
          )
        }
        return createOrResumeAttendanceScheduledRunV1(
          trx,
          { orgId: orgKey, initiator: input.initiator, workDate },
          resolveMembership,
        )
      }),
    )

    if (startOutcome.kind === 'org_suspended_deferred') {
      return { kind: 'suspended' }
    }
    if (startOutcome.kind === 'org_legacy_zero_rows') {
      // Posture raced to `legacy_projection_only` between the outer probe and
      // the run-creation transaction (section 1.7 step 1): the SAME null-ID
      // legacy contract the probe's own legacy branch above takes — a single
      // batch INSERT..SELECT, zero W4 rows, no per-user split.
      if (input.legacyDedupHit === true) return { kind: 'legacy_dedup' }
      if (targetUserIds.length === 0) return { kind: 'legacy', rows: [] }
      const rows = await withConnection((client) =>
        runAttendanceResultOperationTransactionV1(client, (trx) =>
          adapters.applyScheduledAbsenceLegacy(pluginShapedTrx(trx), {
            orgId: orgKey,
            workDate,
            timezone: input.timezone,
            userIds: targetUserIds,
          }),
        ),
      )
      return { kind: 'legacy', rows: rows as Array<{ user_id: string }> }
    }
    if (startOutcome.kind === 'created_and_finalized') {
      // Section 1.9: zero `generate` targets — the run-creation transaction
      // WAS the finalization transaction; there is no per-user work and
      // nothing left to do here.
      return { kind: 'w4', runId: startOutcome.runId, rows: [], perUser: [] }
    }
    if (startOutcome.kind === 'not_running') {
      return { kind: 'w4', runId: startOutcome.runId, rows: [], perUser: [] }
    }

    const runId = startOutcome.runId
    // 'created_running' (first attempt this generation): every generate
    // target is outstanding by definition. 'resumed': only the durable
    // registry's own outstanding-set (section 1.7 step 4, "no row yet in
    // `attendance_scheduled_run_target_outcomes`") — NEVER re-looping the
    // caller's full `targetUserIds` on resume, which would re-attempt
    // already-terminal targets and hit `uq_asrto_target` on the duplicate
    // outcome insert.
    const pendingUserIds: readonly string[] =
      startOutcome.kind === 'created_running'
        ? targetUserIds
        : startOutcome.outstandingGenerateTargets.map((t) => t.userId)

    const perUser: Array<{
      userId: string
      mode: 'replay' | 'executed' | 'legacy_compat' | 'failed'
      inserted: boolean
    }> = []
    const insertedRows: Array<{ user_id: string }> = []

    for (const userId of pendingUserIds) {
      const envelope = normalizeAttendanceSourceOperationEnvelopeV1({
        schemaVersion: 1,
        orgId: orgKey,
        correlationId: `scheduled:${input.initiator}:${orgKey}:${workDate}`,
        command: {
          schemaVersion: 1,
          kind: 'scheduled',
          subjectUserId: userId,
          operationId: null,
          payload: {
            scheduledRunId: runId,
            userId,
            workDate,
            expectedRunVersion: 1,
            scheduledAbsenceSource: SCHEDULED_ABSENCE_SOURCE[input.initiator],
          },
        },
        batch: null,
      })
      const authorization =
        recoveryAuthorization
        ?? cronAuthorization
        ?? adminRunScheduledAuthorization(orgKey, adminActorId as string, userId)
      const outcome = await withConnectionRetryingTargetContention((client) =>
        runAttendanceResultOperationTransactionV1(client, async (trx) => {
          const preflight = await attendanceResultOperationPreflightV1(trx, authorization, envelope.registryInput)
          if (preflight.kind === 'replay') {
            const responses = Object.values(preflight.responses.itemResponses)
            const stored = (responses[0] ?? null) as { inserted?: unknown } | null
            return { mode: 'replay' as const, inserted: stored?.inserted === true }
          }
          if (preflight.kind === 'suspended') {
            throw new AttendanceW4OperationError('SEGMENT_CALCULATION_SUSPENDED')
          }
          if (preflight.kind === 'legacy_no_operation') {
            // Structurally unreachable for the 'scheduled' command kind:
            // w4c0-source-commands.ts always derives a non-null
            // `{sourceKind:'scheduled', scheduledRunId, ...}` source for it,
            // so `plan.sourced.length === 0` (this branch's own precondition)
            // never holds here — kept only because
            // `attendanceResultOperationPreflightV1`'s result type is shared
            // across every entrypoint. A durable run has no representation
            // for a null-ID legacy operation (every target row binds a real
            // `operation_id`), so this fails closed rather than silently
            // reusing the live-punch sibling's null-ID contract.
            boundaryFail('W4C2_SCHEDULED_RUN_LEGACY_NO_OPERATION_UNREACHABLE')
          }
          const pluginTrx = pluginShapedTrx(trx)
          const org = preflight.org
          const identity = preflight.itemIdentities[0] as VerifiedAttendanceOperationIdentityV1
          const isLegacyCompat = org.acceptedWritePosture === 'legacy_projection_only'

          // Gate 12, first half (section 1.7's fail-closed rule; the second
          // half — the outcome writer's own straggler rejection — is
          // `recordAttendanceScheduledRunTargetOutcomeV1`'s own
          // `run_state !== 'running'` check below): a per-user operation
          // transaction whose durable run is not (or no longer) `running` —
          // raced abandon, or finalized by a concurrent racer for the same
          // run — is rejected BEFORE the source DML, never after.
          await requireAttendanceScheduledRunRunningBeforeSourceDmlV1(trx, orgKey, runId)

          // =================================================================
          // Gate D3 (#4556 / #4844) — SITE B, the AUTHORITATIVE `scheduled` per-target writer.
          //
          // REPLACEMENT, NOT A DELETE, and it must run BEFORE the legacy absence adapter below.
          // Deleting the old fail-closed branch instead of replacing it would let an allowlisted
          // authoritative org's target fall through to `applyScheduledAbsenceLegacy`, fabricating a
          // legacy-ACTIVE `'absent'` `attendance_records` row visible to ordinary readers — the very
          // row the D1 core owns — the instant the allowlist gains an authoritative entry. The
          // branch body is always a real writer and always `return`s (or records a contained
          // failure) before control can reach that call site; the behavioural pin is the
          // zero-invocation spy on the INJECTED `applyScheduledAbsenceLegacy`, not this comment.
          //
          // The posture re-read is HOISTED above the legacy adapter (it used to sit after it) and
          // survives as the BRANCH SELECTOR — authoritative writer vs the existing shadow path —
          // mirroring how the `legacy_compat` arm below already handles the legacy-downgrade race
          // per-target. The hoist is behaviour-preserving for every other posture: it is a
          // read-only query, this transaction writes nothing it reads, and the SERIALIZABLE
          // snapshot is fixed before either position. It is skipped entirely for `legacy_compat`,
          // exactly as before.
          //
          // Dropping the absence adapter on this branch (ZERO invocations, never a split) also
          // removes the pre-writer source DML that made the §7.8 preimage capture point ambiguous
          // and the F6 self-created-parent hazard: the scheduled legacy adapter is 100% the
          // to-DROP half (one `INSERT .. SELECT .. WHERE NOT EXISTS` on `attendance_records`, zero
          // `attendance_events` DML), and the scheduled evidence is SYNTHETIC
          // (`{kind:'scheduled_absence', ref: runId}`), durable via the run registry rather than
          // via events.
          //
          // BYTE-NEUTRAL IN PRODUCTION: this branch fires only when the resolved posture is
          // `authoritative`, which requires an EXACT-org entry in
          // `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` (wildcard never counts). That env is
          // unset in production, so every production org collapses to `legacy` and this branch is
          // unreachable irrespective of DB contents — including via the run's frozen posture, which
          // can only be `authoritative` if the org resolved authoritative at run creation.
          // =================================================================
          if (!isLegacyCompat) {
            const targetPosture = await resolveSegmentCalculationPosture(trx, orgKey)
            if (
              targetPosture.effectiveState === 'authoritative'
              || org.acceptedWritePosture === 'authoritative'
            ) {
              // -- CONTAINMENT SCOPE ------------------------------------------------------------
              // ONE savepoint around the parent seam (placeholder INSERT included), the preimage
              // build, and the core call. It deliberately does NOT enclose the preflight claim: the
              // claim must survive a contained refusal so `cancelAttendanceResultOperationV1` (a
              // bare `UPDATE ... WHERE state='claimed'`) can dispose of it. Rolling the claim back
              // would make that cancel match zero rows and throw a NON-contained class, aborting the
              // very batch the containment exists to protect.
              //
              // WHY THE CLAIM MUST BE DISPOSED AT ALL: `trg_aro_claimed_commit_guard` is a
              // `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on
              // `attendance_result_operations` that re-reads the row's state AT COMMIT and raises
              // `W4C0_CLAIMED_COMMIT` if it is still `claimed`. "Record the outcome and leave the
              // operation unsealed" is therefore ILLEGAL — it would fail at COMMIT with a raw,
              // untyped exception and abort the batch anyway. Cancelling (`claimed -> canceled`,
              // `response_snapshot` stays NULL, admitted by
              // `attendance_w4_operation_transition_guard`) is the legal terminal disposition, and
              // it PRESERVES the "seal ⇒ success snapshot" invariant, because a contained failure is
              // never sealed at all. The finalize fold's LEFT JOIN then yields a NULL
              // `response_snapshot` for it, contributing 0 to `generated_count`.
              //
              // PER-BUCKET DISPOSITION of everything typed that can be thrown inside this savepoint:
              //  - the core's closed 15-code enumeration (`AttendanceW4AuthoritativeCalculationError`)
              //    ⇒ CONTAIN: deterministic for this (parent, payload); a retry cannot change it.
              //  - the two retirement 409s (`AttendanceW4OpsRetirementError`) ⇒ CONTAIN: same.
              //  - `W4C2_AUTHORITATIVE_PARENT_UNRESOLVED` (500,
              //    `AttendanceW4LiveScheduledBoundaryError`) ⇒ RETHROW, batch aborts: not a business
              //    outcome and potentially transient, so recovery/resume must re-attempt the target
              //    rather than burn it terminally. That is the principled split — CONTAINED =
              //    deterministic-for-this-target; RETHROWN = transient or infrastructural.
              //  - raw pg errors incl. 40001/40P01 ⇒ RETHROW (the two retry layers own those).
              //  - `AttendanceW4OperationError` (org suspension) ⇒ RETHROW, and it is thrown before
              //    this savepoint anyway — suspension is run-wide, not per-target.
              //  - anything else ⇒ RETHROW (fail-closed default).
              // The membership authority is `isAttendanceScheduledContainedRefusalV1` over the ONE
              // exported class table; this list is the reachability commentary, never the predicate.
              const authoritativeSavepoint = 'attendance_w4c2_scheduled_authoritative'
              let authoritativeSealInput: { inserted: boolean; calculationId: string | null }
              await trx.query(`SAVEPOINT ${authoritativeSavepoint}`)
              try {
                const resolvedParent = await resolveAuthoritativeScheduledParentV1(
                  trx,
                  org,
                  userId,
                  workDate,
                  {
                    orgId: orgKey,
                    timezone: input.timezone,
                    isWorkday: input.isWorkday !== false,
                  },
                )
                if (resolvedParent.kind === 'skip') {
                  // §6.2 default: present, guard-admitted, not-retired parent ⇒ no core call, no
                  // placeholder, no writes at all. Legacy parity: the legacy INSERT contributes
                  // `inserted=false` for exactly this user, so `rows`/`generated_count`/`total` are
                  // identical under either posture and the parent stays bit-identical.
                  await trx.query(`RELEASE SAVEPOINT ${authoritativeSavepoint}`)
                  authoritativeSealInput = { inserted: false, calculationId: null }
                } else {
                  const authoritativeParent = resolvedParent.parent
                  const authoritativeNowIso = new Date().toISOString()
                  // The SHARED shadow compute, reused verbatim: the in-transaction W2 `scheduled`
                  // channel anchored on the run's OWN workDate (required — it is a run identity
                  // byte, not a resolver output), `scheduled_resolution` attribution
                  // (ambiguous/unresolved/strict-rebuild failure ⇒ `unsupported` ⇒ review, never a
                  // fabricated V2), the frozen context for `resolved_v2`, synthetic evidence, and
                  // the pure calculator. The shadow path's `nextCalculationVersion` is DEAD here —
                  // the core allocates its own. No identity-drift override: `scheduled` BY DESIGN
                  // has no outer resolution to compare against (there is no
                  // `outerSourceDefinitionFingerprint` on the scheduled input), so synthesizing one
                  // would be inventing a gate, not replicating D2's.
                  const authoritativeResolution = await adapters.resolveScheduledCandidate(pluginTrx, {
                    orgId: orgKey,
                    userId,
                    timezone: input.timezone,
                    calendarWorkDate: workDate,
                  })
                  const authoritativeAttribution = attributionFromResolution(authoritativeResolution, {
                    orgId: orgKey,
                    userId,
                    source: 'scheduled_resolution',
                    nowIso: authoritativeNowIso,
                  })
                  let authoritativeContext: FrozenAttendanceContextV1 | null = null
                  if (authoritativeAttribution.posture === 'resolved_v2') {
                    authoritativeContext = await issueThroughW7Seam(pluginTrx, {
                      orgId: orgKey,
                      userId,
                      workDate,
                      shiftId: authoritativeAttribution.value.shiftId,
                      timezone: input.timezone,
                      isWorkday: input.isWorkday !== false,
                      holidayKind: input.holidayKind ?? null,
                    })
                  }
                  const authoritativeEvidence: AttendanceEvidenceV1[] = [
                    { kind: 'scheduled_absence', ref: runId },
                  ]
                  const authoritativeCalculation = calculateAttendanceSegmentsV1({
                    attribution: authoritativeAttribution,
                    context: authoritativeContext,
                    evidence: authoritativeEvidence,
                    approvedFacts: [],
                  })
                  const authoritativeProvenanceRef: AttendanceInputProvenanceRefV1 = {
                    transport: 'scheduled_job',
                    sourceRef: SCHEDULED_SOURCE_REF[input.initiator],
                    artifactSha256: null,
                    normalizedCsvSha256: null,
                    convertedSheetName: null,
                  }
                  // Derived ONLY from the resolved command payload — the same five fields the
                  // envelope carries — never from a clock, a random id, or the operation id.
                  const authoritativePayloadFingerprint =
                    computeAuthoritativeScheduledPayloadFingerprintV1({
                      scheduledRunId: runId,
                      userId,
                      workDate,
                      expectedRunVersion: 1,
                      scheduledAbsenceSource: SCHEDULED_ABSENCE_SOURCE[input.initiator],
                    })
                  // The D2 preimage builder VERBATIM (it takes only a `ShadowTargetRow`, which the
                  // widened locked read supplies) — the CANONICAL compat fingerprint, instants
                  // normalized to ISO with the SAME bytes hashed and stored, and
                  // `expectedCurrentCalculationId` always the LOCKED actual.
                  const { preimage: authoritativePreimage, expectedCurrentCalculationId } =
                    buildAuthoritativeLivePunchPreimageV1(authoritativeParent)
                  const authoritativeWritten = await writeAuthoritativeSegmentCalculationV1(trx, {
                    orgId: orgKey,
                    recordId: authoritativeParent.id,
                    // The DB entrypoint value: a disjoint retry space from `'live'`, so the
                    // `(org, entrypoint, operation_id)` replay key can never collide across kinds.
                    entrypoint: 'scheduled',
                    operationId: identity.id,
                    calculation: authoritativeCalculation,
                    attribution: authoritativeAttribution,
                    context: authoritativeContext,
                    evidence: authoritativeEvidence as unknown as readonly unknown[],
                    approvedFacts: [],
                    provenanceRef: authoritativeProvenanceRef,
                    // BOTH places: top-level for the core's own conflict check, and embedded so a
                    // genuine retry's `input_provenance.payloadFingerprint` read matches.
                    inputProvenance: {
                      ...authoritativeProvenanceRef,
                      payloadFingerprint: authoritativePayloadFingerprint,
                    },
                    payloadFingerprint: authoritativePayloadFingerprint,
                    preimage: authoritativePreimage,
                    expectedCurrentCalculationId,
                    sourceBatchId: null,
                    actorId: authorization.actorId,
                    correlationId: envelope.correlationId,
                  })
                  await trx.query(`RELEASE SAVEPOINT ${authoritativeSavepoint}`)
                  // §6.3 default: `inserted:true` ⇔ the pointer moved (an authoritative "generated
                  // absence day"), keeping `generated_count`'s meaning intact; a review outcome (or
                  // a replay of one) is `inserted:false`.
                  authoritativeSealInput = {
                    inserted: authoritativeWritten.kind === 'completed',
                    calculationId: authoritativeWritten.calculationId,
                  }
                }
              } catch (error) {
                if (!isAttendanceScheduledContainedRefusalV1(error)) throw error
                // ROLLBACK TO is LOAD-BEARING: without it a refused target can leave an orphan
                // `review_placeholder` parent behind for a target that produced nothing, and the
                // parent is required to be bit-identical after a refusal. RELEASE follows the
                // rollback (the D2 carry-forward lesson: `ROLLBACK TO` undoes the subtransaction but
                // leaves its slot on the stack).
                await trx.query(`ROLLBACK TO SAVEPOINT ${authoritativeSavepoint}`)
                await trx.query(`RELEASE SAVEPOINT ${authoritativeSavepoint}`)
                // Cancel FIRST, then record the outcome. `cancelAttendanceResultOperationV1`'s
                // docblock says "source-free cancel: allowed only before source DML (lock 7.1)" —
                // the rule is stated there and NOT enforced in code. Here the savepoint rollback has
                // already undone every source write this branch made, so the operation IS source-free
                // at cancel time; whether "source-free because it was rolled back" is the same
                // predicate the lock meant is an OWNER lock interpretation, shipped as the default
                // and surfaced for ruling, not decided here. The outcome table is run-registry
                // machinery, not source DML.
                await cancelAttendanceResultOperationV1(trx, identity)
                // The registry's single allowlisted failure reason. The writer validates the shape
                // as EXACTLY two keys, so persisting the specific refusing code alongside it is not
                // a build-time option — it would fail `W4C2_SCHEDULED_RUN_OUTCOME_INVALID`.
                await recordAttendanceScheduledRunTargetOutcomeV1(trx, identity, {
                  terminalOutcome: 'failed',
                  failureReasonCode: 'ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED',
                })
                // Terminal and contained: the loop continues to the next target, resume never
                // re-loops this one, and both fold counters exclude it.
                return { mode: 'failed' as const, inserted: false }
              }
              // Seal + outcome sit OUTSIDE the savepoint on purpose: their own failures must
              // propagate (the outcome writer refuses a non-`running` run) rather than re-enter
              // containment. The sealed snapshot PRESERVES the existing contract exactly — the two
              // keys the finalize fold reads (`response_snapshot ->> 'inserted'`) plus
              // `resolvedCalculationId`. Adding keys here would be a protocol change requiring an
              // independent ratify, not a side effect of delivering the writer.
              await sealAttendanceResultOperationV1(trx, identity, {
                responseSnapshot: { inserted: authoritativeSealInput.inserted },
                resolvedCalculationId: authoritativeSealInput.calculationId,
              })
              // §6.3 default: a `review_required` CALCULATION outcome still records `'completed'` —
              // the operation ran to a terminal calc outcome and the review state is carried on the
              // calc row. `'failed'` is reserved exclusively for contained refusals.
              await recordAttendanceScheduledRunTargetOutcomeV1(trx, identity, {
                terminalOutcome: 'completed',
              })
              // The P-A obligation: this `return` is what keeps control from reaching the shadow
              // `applyScheduledAbsenceLegacy` call site below.
              return { mode: 'executed' as const, inserted: authoritativeSealInput.inserted }
            }
          }

          const rows = await adapters.applyScheduledAbsenceLegacy(pluginTrx, {
            orgId: orgKey,
            workDate,
            timezone: input.timezone,
            userIds: [userId],
          })
          const inserted = rows.length === 1

          if (isLegacyCompat) {
            await sealAttendanceResultOperationV1(trx, identity, {
              responseSnapshot: { inserted },
            })
            // The run row this target belongs to is frozen at `shadow`/
            // `eligible`/`authoritative` (this is the w4 branch); a posture
            // race down to `legacy_projection_only` for THIS org-wide check
            // only changes how the operation itself is sealed (legacy_compat:
            // no calculation, no outbox), never whether the run can still
            // progress toward finalization — so the terminal outcome is
            // still recorded here, same as the full-execution branch below.
            await recordAttendanceScheduledRunTargetOutcomeV1(trx, identity, { terminalOutcome: 'completed' })
            return { mode: 'legacy_compat' as const, inserted }
          }

          // Gate D3 (#4556 / #4844): the authoritative arm's posture re-read and its former
          // fail-closed refusal used to live HERE, after the legacy absence adapter. Both moved
          // above that call site — the re-read is now the writer-branch selector and the refusal is
          // replaced by the real writer, which returns before control can reach the adapter. Only
          // shadow/eligible reach this point, and the arm below is unchanged.

          let calculationId: string | null = null
          if (inserted) {
            // Shadow result for the absence projection this operation created.
            const parent = await lockShadowParentRecord(trx, org, userId, workDate)
            if (parent) {
              const nowIso = new Date().toISOString()
              const resolution = await adapters.resolveScheduledCandidate(pluginTrx, {
                orgId: orgKey,
                userId,
                timezone: input.timezone,
                calendarWorkDate: workDate,
              })
              const attribution = attributionFromResolution(resolution, {
                orgId: orgKey,
                userId,
                source: 'scheduled_resolution',
                nowIso,
              })
              let context: FrozenAttendanceContextV1 | null = null
              if (attribution.posture === 'resolved_v2') {
                context = await issueThroughW7Seam(pluginTrx, {
                  orgId: orgKey,
                  userId,
                  workDate,
                  shiftId: attribution.value.shiftId,
                  timezone: input.timezone,
                  isWorkday: input.isWorkday !== false,
                  holidayKind: input.holidayKind ?? null,
                })
              }
              const evidence: AttendanceEvidenceV1[] = [{ kind: 'scheduled_absence', ref: runId }]
              const calculation = calculateAttendanceSegmentsV1({
                attribution,
                context,
                evidence,
                approvedFacts: [],
              })
              const version = await nextCalculationVersion(trx, parent.id)
              const provenanceRef: AttendanceInputProvenanceRefV1 = {
                transport: 'scheduled_job',
                sourceRef: SCHEDULED_SOURCE_REF[input.initiator],
                artifactSha256: null,
                normalizedCsvSha256: null,
                convertedSheetName: null,
              }
              const insertedCalc = await insertShadowCalculation(trx, {
                orgId: orgKey,
                recordId: parent.id,
                version,
                entrypoint: 'scheduled',
                operationId: identity.id,
                attribution,
                context,
                segmentSnapshot: context ? (context.segments as unknown as unknown[]) : [],
                evidence: evidence as unknown as unknown[],
                approvedFacts: [],
                inputProvenance: { ...provenanceRef },
                provenanceRef,
                mergePolicy: 'append',
                outcome: calculation.outcome,
                outcomeReasonCode: calculation.outcomeReasonCode,
                segments: calculation.segments,
                dailyProjection: calculation.dailyProjection,
                actorId: authorization.actorId,
                correlationId: envelope.correlationId,
                legacyProjection: parent,
              })
              calculationId = insertedCalc.calculationId
            }
          }

          await sealAttendanceResultOperationV1(trx, identity, {
            responseSnapshot: { inserted },
            resolvedCalculationId: calculationId,
          })
          await recordAttendanceScheduledRunTargetOutcomeV1(trx, identity, { terminalOutcome: 'completed' })
          return { mode: 'executed' as const, inserted }
        }),
      )
      perUser.push({ userId, mode: outcome.mode, inserted: outcome.inserted })
      if (outcome.inserted && outcome.mode !== 'replay') {
        insertedRows.push({ user_id: userId })
      }
    }

    // Attempt finalization now that every target this call was responsible
    // for has a terminal outcome (or already did, for a fully-resumed call
    // with `pendingUserIds = []`). `deferred` (org suspended mid-flight),
    // `not_ready` (another racer's target is still outstanding), and
    // `not_running` (a concurrent racer already finalized, or an operator
    // abandoned it) are all legitimate, silent, values-free outcomes here —
    // a later call (retry, resume, or the recovery sweep) finalizes it; this
    // call still returns its own per-user work either way.
    await withConnection((client) =>
      runAttendanceResultOperationTransactionV1(client, (trx) =>
        finalizeAttendanceScheduledRunV1(trx, { orgId: orgKey, initiator: input.initiator, workDate, runId }),
      ),
    )

    return { kind: 'w4', runId, rows: insertedRows, perUser }
  }

  async function executeScheduledRun(
    input: AttendanceScheduledRunBoundaryInputV1,
  ): Promise<AttendanceScheduledRunBoundaryResultV1> {
    return executeScheduledRunInternal(input, null)
  }

  async function recoverScheduledRun(
    input: AttendanceScheduledRunRecoveryBoundaryInputV1,
  ): Promise<AttendanceScheduledRunBoundaryResultV1> {
    return executeScheduledRunInternal(
      {
        orgId: input.orgId,
        workDate: input.workDate,
        timezone: input.timezone,
        targetUserIds: input.targetUserIds,
        initiator: input.initiator,
        adminActorId: null,
        isWorkday: input.isWorkday,
        holidayKind: input.holidayKind,
        reviewTargets: input.reviewTargets,
        legacyDedupHit: false,
      },
      input.runId,
    )
  }

  return { executeLivePunch, executeScheduledRun, recoverScheduledRun }
}
