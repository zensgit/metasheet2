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
 *  - effective `authoritative` write execution itself is NOT delivered by this
 *    slice: it fails closed before source DML (see
 *    `W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED`); the state is unreachable in
 *    production (no rollout transition writer ships).
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
  enqueueAttendanceResultEventOutboxV1,
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
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  calculateAttendanceSegmentsV1,
  type AttendanceSegmentCalculationResultV1,
} from './w4c1-segment-calculator'
import {
  computeAttendanceSourceDefinitionFingerprintV1,
  computeAttendanceOuterComparableSourceDefinitionFingerprintV1,
} from './w4c1-fingerprints'
import type {
  AttendanceAttributionSnapshotV1,
  AttendanceEvidenceV1,
  FrozenAttendanceContextV1,
} from './w4c0-write-boundary-types'
import { buildFrozenWorkDateAttributionV2 } from './w4c2-frozen-attribution'

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
// Scheduled run identity (W4C-2 discretionary namespace — declared in the PR).
// runId = UUIDv5(namespace, initiator NUL orgId NUL workDate): deterministic
// across process restarts, distinct per initiator, per org, per work date.
// ---------------------------------------------------------------------------

export const ATTENDANCE_W4C2_SCHEDULED_RUN_NAMESPACE_V1 = '0b9c9c2e-51f4-4f56-9a2e-6c1f0d3e8a72'

const SCHEDULED_INITIATORS = Object.freeze(['cron', 'admin_run'] as const)
export type AttendanceScheduledRunInitiatorV1 = (typeof SCHEDULED_INITIATORS)[number]

function uuidToBytes(canonicalUuid: string): Buffer {
  return Buffer.from(canonicalUuid.replace(/-/g, ''), 'hex')
}

function uuidv5(namespaceUuid: string, nameBytes: Buffer): string {
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([uuidToBytes(namespaceUuid), nameBytes]))
    .digest()
    .subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.toString('hex')
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
  )
}

export function deriveAttendanceScheduledRunIdV1(input: {
  readonly initiator: AttendanceScheduledRunInitiatorV1
  readonly orgId: string
  readonly workDate: string
}): string {
  if (!(SCHEDULED_INITIATORS as readonly string[]).includes(input.initiator)) {
    boundaryFail('W4C2_SCHEDULED_INITIATOR_INVALID')
  }
  const orgKey = parseCanonicalAttendanceOrgKeyV1(input.orgId) as string
  const workDate = parseCanonicalAttendanceWorkDateV1(input.workDate) as string
  const NUL = Buffer.from([0])
  return uuidv5(
    ATTENDANCE_W4C2_SCHEDULED_RUN_NAMESPACE_V1,
    Buffer.concat([
      Buffer.from(input.initiator, 'utf8'),
      NUL,
      Buffer.from(orgKey, 'utf8'),
      NUL,
      Buffer.from(workDate, 'utf8'),
    ]),
  )
}

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
}

export type AttendanceScheduledRunBoundaryResultV1 =
  | { readonly kind: 'legacy'; readonly rows: Array<{ user_id: string }> }
  | { readonly kind: 'suspended' }
  | {
      readonly kind: 'w4'
      readonly rows: Array<{ user_id: string }>
      readonly perUser: Array<{
        readonly userId: string
        readonly mode: 'replay' | 'executed' | 'legacy_compat'
        readonly inserted: boolean
      }>
    }

export interface AttendanceW4LiveScheduledBoundaryV1 {
  executeLivePunch(input: AttendanceLivePunchBoundaryInputV1): Promise<AttendanceLivePunchBoundaryResultV1>
  executeScheduledRun(input: AttendanceScheduledRunBoundaryInputV1): Promise<AttendanceScheduledRunBoundaryResultV1>
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

interface ShadowTargetRow {
  id: string
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
  const result = await client.query(
    'SELECT id::text AS id FROM attendance_records WHERE user_id = $1 AND org_id = $2 AND work_date = $3 FOR UPDATE',
    [userId, org.orgId as unknown as string, workDate],
  )
  if (result.rows.length === 0) return null
  return { id: String(result.rows[0].id) }
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
  approvedFacts: unknown[]
  inputProvenance: Record<string, unknown>
  provenanceRef: AttendanceInputProvenanceRefV1
  mergePolicy: 'append'
  outcome: 'completed' | 'review_required'
  outcomeReasonCode: string
  segments: AttendanceSegmentCalculationResultV1['segments']
  dailyProjection: AttendanceSegmentCalculationResultV1['dailyProjection']
  actorId: string
  correlationId: string
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
        actor_id, correlation_id
      ) VALUES (
        $1::uuid, $2, $3::uuid, $4, 'calculation', 'shadow', $5,
        $6, 1, $7::uuid,
        $8, $9, $10,
        $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
        $15::jsonb, NULL, $16::jsonb,
        $17, 'legacy_shadow', $18, $19, 'none',
        $20, $21, $22, $23,
        $24, $25, $26,
        $27, $28
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
  args: { orgId: string; userId: string; source: 'live_resolution' | 'scheduled_resolution'; nowIso: string },
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
    typeof adapters.applyScheduledAbsenceLegacy !== 'function' ||
    typeof adapters.resolveLiveCandidate !== 'function' ||
    typeof adapters.resolveScheduledCandidate !== 'function' ||
    typeof adapters.buildShadowFrozenContext !== 'function'
  ) {
    boundaryFail('W4C2_LEGACY_ADAPTERS_INVALID', 500)
  }
  if (typeof deps.acquireConnection !== 'function') {
    boundaryFail('W4C2_CONNECTION_PROVIDER_INVALID', 500)
  }

  async function withConnection<T>(body: (client: AttendanceW4TransactionClientV1) => Promise<T>): Promise<T> {
    const connection = await deps.acquireConnection()
    try {
      return await body(connection.client)
    } finally {
      connection.release()
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

        // W4 posture. Distinguish effective shadow vs eligible vs authoritative
        // (still under the org rollout shared lock acquired above).
        if (posture.effectiveState === 'authoritative' || org.acceptedWritePosture === 'authoritative') {
          // The authoritative live writer is NOT delivered by W4C-2; fail
          // closed before any source DML (whole transaction rolls back).
          boundaryFail('W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED', 503)
        }

        // Three-posture matrix: a business time only the legacy parser accepts.
        const legacyOnlyTime = input.occurredAtRaw !== null && !isStrictInstant(input.occurredAtRaw)
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
            context = await adapters.buildShadowFrozenContext(pluginTrx, {
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
          //      checked against the function's four `return null` sites,
          //      one of which is the ~L21479 compound guard's five
          //      disjuncts, so this list has seven entries, not five):
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
          //      canonical shift service (the only sanctioned writer) never
          //      produces either shape in production (dense 0..2 for (iii)
          //      — see the migration's header comment; strict `HH:MM` input
          //      for (iv) — see above).
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
  function cronScheduledAuthorization(orgId: string): AuthorizedAttendanceWriteContextV1 {
    return createAuthorizedAttendanceWriteContextV1({
      actorId: ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
      actorPosture: 'scheduler',
      tokenSubjectUserId: null,
      orgId,
      subjectScope: { kind: 'org_scheduler' },
      capability: 'scheduled',
      sourceRef: SCHEDULED_SOURCE_REF.cron,
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

  async function executeScheduledRun(
    input: AttendanceScheduledRunBoundaryInputV1,
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
    if (input.initiator === 'cron' && input.adminActorId !== null) {
      boundaryFail('W4C2_SCHEDULED_WITNESS_INITIATOR_MISMATCH')
    }
    if (input.initiator === 'admin_run' && (typeof input.adminActorId !== 'string' || input.adminActorId.length === 0)) {
      boundaryFail('W4C2_SCHEDULED_ADMIN_WITNESS_REQUIRED')
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
        if (posture.writePosture === 'authoritative' || posture.effectiveState === 'authoritative') {
          boundaryFail('W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED', 503)
        }
        return { mode: 'w4' as const, rows: [] as Array<{ user_id: string }> }
      }),
    )

    if (probe.mode === 'suspended') return { kind: 'suspended' }
    if (probe.mode === 'legacy') return { kind: 'legacy', rows: probe.rows }

    // W4 path only below: `cron` mints ONE org-scoped witness reused across
    // every target user (no per-subject identity); `admin_run` mints a FRESH
    // witness per user from the real host-authenticated admin identity
    // (validated non-null/non-scheduler above) — see cronScheduledAuthorization
    // / adminRunScheduledAuthorization. Both are SQL-rechecked inside every
    // per-user registry transaction before any source/result DML.
    const cronAuthorization = input.initiator === 'cron' ? cronScheduledAuthorization(orgKey) : null
    const adminActorId = input.adminActorId

    // W4 posture: one durable scheduled operation per user with a
    // deterministic run identity — durable replay survives restart and the
    // caller's in-memory dedup can never bypass the registry.
    const runId = deriveAttendanceScheduledRunIdV1({ initiator: input.initiator, orgId: orgKey, workDate })
    const perUser: Array<{ userId: string; mode: 'replay' | 'executed' | 'legacy_compat'; inserted: boolean }> = []
    const insertedRows: Array<{ user_id: string }> = []

    for (const userId of targetUserIds) {
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
        cronAuthorization ?? adminRunScheduledAuthorization(orgKey, adminActorId as string, userId)
      const outcome = await withConnection((client) =>
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
          const pluginTrx = pluginShapedTrx(trx)
          if (preflight.kind === 'legacy_no_operation') {
            // Posture raced back to legacy between probe and this transaction:
            // the null-ID legacy contract applies (no operation row).
            const rows = await adapters.applyScheduledAbsenceLegacy(pluginTrx, {
              orgId: orgKey,
              workDate,
              timezone: input.timezone,
              userIds: [userId],
            })
            return { mode: 'legacy_compat' as const, inserted: rows.length === 1 }
          }
          const org = preflight.org
          const identity = preflight.itemIdentities[0] as VerifiedAttendanceOperationIdentityV1
          const isLegacyCompat = org.acceptedWritePosture === 'legacy_projection_only'

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
            return { mode: 'legacy_compat' as const, inserted }
          }

          const posture = await resolveSegmentCalculationPosture(trx, orgKey)
          if (posture.effectiveState === 'authoritative' || org.acceptedWritePosture === 'authoritative') {
            boundaryFail('W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED', 503)
          }

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
                context = await adapters.buildShadowFrozenContext(pluginTrx, {
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
              })
              calculationId = insertedCalc.calculationId
            }
          }

          await sealAttendanceResultOperationV1(trx, identity, {
            responseSnapshot: { inserted },
            resolvedCalculationId: calculationId,
          })
          return { mode: 'executed' as const, inserted }
        }),
      )
      perUser.push({ userId, mode: outcome.mode, inserted: outcome.inserted })
      if (outcome.inserted && outcome.mode !== 'replay') {
        insertedRows.push({ user_id: userId })
      }
    }

    return { kind: 'w4', rows: insertedRows, perUser }
  }

  return { executeLivePunch, executeScheduledRun }
}
