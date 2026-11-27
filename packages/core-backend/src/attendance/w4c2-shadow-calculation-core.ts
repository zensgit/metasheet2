/**
 * Shared shadow calculation persistence. The caller owns admission, target
 * locking, version allocation, and the transaction; this writer never updates
 * the parent projection or pointer.
 */
import crypto from 'node:crypto'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
  type AttendanceInputProvenanceRefV1,
} from './w4c0-fingerprints'
import {
  ATTENDANCE_DAILY_STATUSES_V1,
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  type AttendanceCalculatedSegmentV1,
  type AttendanceDailyStatusV1,
  type AttendanceSegmentCalculationResultV1,
} from './w4c1-segment-calculator'
import { computeAttendanceSourceDefinitionFingerprintV1 } from './w4c1-fingerprints'
import type {
  AttendanceAttributionSnapshotV1,
  ApprovedAttendanceFactV1,
  FrozenAttendanceContextV1,
  ManualAttendanceOverrideV1,
} from './w4c0-write-boundary-types'
import {
  computeAttendanceW4ShadowDiff,
  type AttendanceW4ComparableDailyProjection,
} from '../services/AttendanceW4CalculationDetail'
import { isExpectedAttendanceShadowDifferenceV1 } from './w4c2-shadow-expected-differences'
import { applyFrozenManualOverrideSnapshotToDailyProjectionV1 } from './w4c3c-manual-override'

export class AttendanceW4ShadowCalculationError extends Error {
  readonly httpStatus = 422

  constructor(readonly code: 'W4C2_SHADOW_MERGE_POLICY_INVALID' | 'W4C2_SHADOW_OPERATION_ID_REQUIRED') {
    super(code)
    this.name = 'AttendanceW4ShadowCalculationError'
  }
}

function wireJson(value: unknown): unknown {
  // The stored response snapshot is the exact wire form the client received
  // (res.json serializes Dates the same way).
  return JSON.parse(JSON.stringify(value ?? null))
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

export interface ShadowCalculationRowInputV1 {
  orgId: string
  recordId: string
  version: number
  entrypoint: 'live' | 'scheduled' | 'approved_overtime'
  /** NULL exactly for the W7 group-shadow comparison record (whose producing
   *  operation travels in the provenance marker — `chk_arc_operation_id`'s
   *  marker disjunct enforces the pairing); every served-path shadow row
   *  carries its operation id as before. */
  operationId: string | null
  attribution: AttendanceAttributionSnapshotV1
  context: FrozenAttendanceContextV1 | null
  segmentSnapshot: unknown[]
  evidence: unknown[]
  approvedFacts: ApprovedAttendanceFactV1[]
  inputProvenance: Record<string, unknown>
  provenanceRef: AttendanceInputProvenanceRefV1
  manualOverride?: ManualAttendanceOverrideV1 | null
  mergePolicy?: 'append' | 'merge'
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
export async function insertShadowCalculationV1(
  client: AttendanceW4TransactionClientV1,
  input: ShadowCalculationRowInputV1,
): Promise<{ calculationId: string; semanticFingerprint: string; provenanceFingerprint: string }> {
  if (input.mergePolicy !== undefined && input.mergePolicy !== 'append' && input.mergePolicy !== 'merge') {
    throw new AttendanceW4ShadowCalculationError('W4C2_SHADOW_MERGE_POLICY_INVALID')
  }
  if (input.entrypoint === 'approved_overtime'
    && (typeof input.operationId !== 'string' || input.operationId.length === 0)) {
    throw new AttendanceW4ShadowCalculationError('W4C2_SHADOW_OPERATION_ID_REQUIRED')
  }
  const mergePolicy = input.mergePolicy ?? 'append'
  const manualOverride = input.manualOverride ?? null
  const completed = input.outcome === 'completed'
  const physicalProjection = completed ? input.dailyProjection : null
  // Validate frozen operations even for review, before any SQL. The inert base
  // is validation-only: review still persists no daily projection or children.
  const overlaidDaily = applyFrozenManualOverrideSnapshotToDailyProjectionV1(
    physicalProjection
      ? {
          status: physicalProjection.status,
          firstInAt: physicalProjection.firstInAt,
          lastOutAt: physicalProjection.lastOutAt,
          workMinutes: physicalProjection.workedMinutes,
          lateMinutes: physicalProjection.lateMinutes,
          earlyLeaveMinutes: physicalProjection.earlyLeaveMinutes,
        }
      : {
          status: 'normal',
          firstInAt: null,
          lastOutAt: null,
          workMinutes: null,
          lateMinutes: null,
          earlyLeaveMinutes: null,
        },
    manualOverride,
  )
  // Match authoritative/recompute: unset removes the override and restores the physical metric.
  const projection = physicalProjection
    ? {
        ...physicalProjection,
        status: overlaidDaily.status,
        workedMinutes: overlaidDaily.workMinutes ?? physicalProjection.workedMinutes,
        lateMinutes: overlaidDaily.lateMinutes ?? physicalProjection.lateMinutes,
        earlyLeaveMinutes: overlaidDaily.earlyLeaveMinutes ?? physicalProjection.earlyLeaveMinutes,
      }
    : null
  const semanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
    attribution: input.attribution,
    context: input.context,
    evidence: input.evidence,
    approvedFacts: input.approvedFacts,
    manualOverride,
    mergePolicy,
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
        $15::jsonb, $31::jsonb, $16::jsonb,
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
      mergePolicy,
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
      manualOverride === null ? null : canonicalAttendanceJsonV1(wireJson(manualOverride)),
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

