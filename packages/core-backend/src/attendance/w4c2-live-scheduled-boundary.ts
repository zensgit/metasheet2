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
 * pure data; no route-provided callback, intent, or prepared value is accepted
 * (lock 4.1). Adapters receive a plugin-shaped `trx` wrapper over the ONE
 * canonical transaction client, so every legacy byte runs inside the same
 * SERIALIZABLE transaction as the claim/shadow/seal writes.
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
  recheckAttendanceAuthorizationInTransactionV1,
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

export interface AttendanceW4LiveScheduledLegacyAdaptersV1 {
  /**
   * P01/P02 verbatim transaction body: event INSERT -> record lock -> frozen
   * V1 attribution meta -> upsert -> merge lift. MUST generate any random IDs
   * inside itself (the SERIALIZABLE wrapper may re-run the whole closure).
   * The merge lift is invoked only after the upsert returned the record row —
   * the P3-3 "record row exists" guarantee lives inside this adapter.
   */
  applyLivePunchLegacy(trx: AttendancePluginShapedTrxV1, args: unknown): Promise<{
    event: Record<string, unknown>
    record: Record<string, unknown>
    workDateResolution: unknown
  }>
  /** P03/P04 verbatim absence INSERT..SELECT (NOT EXISTS) for the given users. */
  applyScheduledAbsenceLegacy(
    trx: AttendancePluginShapedTrxV1,
    args: { orgId: string; workDate: string; timezone: string; userIds: readonly string[] },
  ): Promise<Array<{ user_id: string }>>
  /** In-transaction W2 live re-resolution (channel 'live', full-winner opt-in). */
  resolveLiveCandidate(
    trx: AttendancePluginShapedTrxV1,
    args: { orgId: string; userId: string; occurredAt: string; timezone: string; calendarWorkDate: string },
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
  /** Effective timezone the route resolved for this punch. */
  readonly timezone: string
  readonly source: string
  readonly location: unknown
  readonly meta: unknown
  readonly photoFileRef: string | null
  readonly workDate: string
  readonly isWorkday: boolean
  readonly holidayKind: string | null
  /** Opaque args for `applyLivePunchLegacy` (pure data computed by the route). */
  readonly legacyArgs: unknown
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
      // Section 7.3: source-definition fingerprint nullable only for review.
      completed ? semanticFingerprint : null,
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

        if (rolloutKey === null) {
          if (input.operationId !== null) {
            // A stable-ID command requires a canonical org key (values-free).
            boundaryFail('W4C2_ORG_KEY_OUTSIDE_W4_DOMAIN')
          }
          const result = await adapters.applyLivePunchLegacy(pluginTrx, input.legacyArgs)
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
            const result = await adapters.applyLivePunchLegacy(pluginTrx, input.legacyArgs)
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
          const result = await adapters.applyLivePunchLegacy(pluginTrx, input.legacyArgs)
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
          const result = await adapters.applyLivePunchLegacy(pluginTrx, input.legacyArgs)
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
        const result = await adapters.applyLivePunchLegacy(pluginTrx, input.legacyArgs)

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
          // Freeze W2 + context from the transaction snapshot, then calculate.
          const nowIso = new Date().toISOString()
          const resolution = await adapters.resolveLiveCandidate(pluginTrx, {
            orgId: envelope.orgId,
            userId: input.userId,
            occurredAt: input.occurredAtResolved,
            timezone: input.timezone,
            calendarWorkDate: input.workDate,
          })
          const attribution = attributionFromResolution(resolution, {
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
              timezone: attribution.value.workDate === input.workDate ? input.timezone : input.timezone,
              isWorkday: input.isWorkday,
              holidayKind: input.holidayKind,
            })
          }
          const evidence = await loadLivePunchEvidence(trx, envelope.orgId, input.userId, input.workDate)
          const calculation = calculateAttendanceSegmentsV1({
            attribution,
            context,
            evidence,
            approvedFacts: [],
          })
          outcome = calculation.outcome
          outcomeReasonCode = calculation.outcomeReasonCode
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
            segments: calculation.segments,
            dailyProjection: calculation.dailyProjection,
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
  // -------------------------------------------------------------------------

  function scheduledAuthorization(
    orgId: string,
    initiator: AttendanceScheduledRunInitiatorV1,
  ): AuthorizedAttendanceWriteContextV1 {
    // The registered internal scheduler identity (lock 4.1: "scheduler scope is
    // available only to the registered internal scheduler identity"). The
    // admin-run initiator is still permission-gated by its route; the ROUTE
    // permission decision precedes minting, per the adapter contract.
    return createAuthorizedAttendanceWriteContextV1({
      actorId: ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
      actorPosture: 'scheduler',
      tokenSubjectUserId: null,
      orgId,
      subjectScope: { kind: 'org_scheduler' },
      capability: 'scheduled',
      sourceRef: SCHEDULED_SOURCE_REF[initiator],
    })
  }

  async function executeScheduledRun(
    input: AttendanceScheduledRunBoundaryInputV1,
  ): Promise<AttendanceScheduledRunBoundaryResultV1> {
    if (!(SCHEDULED_INITIATORS as readonly string[]).includes(input.initiator)) {
      boundaryFail('W4C2_SCHEDULED_INITIATOR_INVALID')
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

    // W4 path only below: the witness is minted for the canonical org key and
    // SQL-rechecked inside every per-user registry transaction.
    const authorization = scheduledAuthorization(orgKey, input.initiator)

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
