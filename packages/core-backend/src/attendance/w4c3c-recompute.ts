/**
 * W4C-3c — prior-policy/default recompute and explicit current-policy recompute
 * as NEW distinct explainable capabilities (lock §1.1 / §4.1 / §12.6).
 *
 * - policy=frozen_prior (default): complete prior frozen context/attribution/evidence
 * - policy=current_policy: caller-supplied resolved_v2 attribution + real frozen
 *   context (built by plugin via resolver + buildW4ShadowFrozenContextV1); never
 *   an unsupported/empty-segment placeholder
 *
 * operationId is a required stable caller UUID — no server random fallback.
 * Manual override is a separate path (manual_edit), not recompute.
 */
import crypto from 'node:crypto'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import {
  calculateAttendanceSegmentsV1,
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  validateFrozenContextShape,
} from './w4c1-segment-calculator'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
} from './w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from './w4c1-fingerprints'
import { applyFrozenManualOverrideSnapshotToDailyProjectionV1 } from './w4c3c-manual-override'
import { assertParentNotRetiredForOrdinaryWriterV1 } from './w4c3c-ops-retirement'

export const ATTENDANCE_RECOMPUTE_POLICIES_V1 = Object.freeze([
  'frozen_prior',
  'current_policy',
] as const)

export type AttendanceRecomputePolicyV1 = (typeof ATTENDANCE_RECOMPUTE_POLICIES_V1)[number]

export const ATTENDANCE_RECOMPUTE_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'W4C3C_RECOMPUTE_INPUT_INVALID',
  RECORD_NOT_FOUND: 'ATTENDANCE_RECORD_NOT_FOUND',
  OPERATOR_RETIRED: 'ATTENDANCE_RECORD_OPERATOR_RETIRED',
  VERSION_CONFLICT: 'ATTENDANCE_RECORD_VERSION_CONFLICT',
  NO_PRIOR: 'W4C3C_RECOMPUTE_NO_PRIOR_CALCULATION',
  PRIOR_UNSUPPORTED: 'W4C3C_RECOMPUTE_PRIOR_UNSUPPORTED',
  CURRENT_POLICY_INCOMPLETE: 'W4C3C_RECOMPUTE_CURRENT_POLICY_INCOMPLETE',
  DATABASE_RESULT_INVALID: 'W4C3C_RECOMPUTE_DATABASE_RESULT_INVALID',
  REPLAY_CONFLICT: 'W4C3C_RECOMPUTE_REPLAY_CONFLICT',
  OPERATION_ID_REQUIRED: 'W4C3C_RECOMPUTE_OPERATION_ID_REQUIRED',
} as const)

export class AttendanceW4RecomputeError extends Error {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, httpStatus = 422) {
    super(code)
    this.name = 'AttendanceW4RecomputeError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

function fail(code: string, httpStatus = 422): never {
  throw new AttendanceW4RecomputeError(code, httpStatus)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64_RE = /^[0-9a-f]{64}$/

function requireUuid(value: unknown, code: string = ATTENDANCE_RECOMPUTE_ERROR_CODES.INPUT_INVALID): string {
  if (typeof value !== 'string' || !UUID_RE.test(value.toLowerCase())) {
    fail(code)
  }
  return value.toLowerCase()
}

function requireText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.INPUT_INVALID)
  }
  return value
}

async function rows(
  client: AttendanceW4TransactionClientV1,
  sqlText: string,
  params: readonly unknown[],
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(sqlText, [...params])
  return result.rows as Array<Record<string, unknown>>
}

function projectedDailyFingerprint(projection: {
  status: string
  firstInAt: string | null
  lastOutAt: string | null
  workedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
}): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalAttendanceJsonV1({
        status: projection.status,
        firstInAt: projection.firstInAt,
        lastOutAt: projection.lastOutAt,
        workMinutes: projection.workedMinutes,
        lateMinutes: projection.lateMinutes,
        earlyLeaveMinutes: projection.earlyLeaveMinutes,
      }),
      'utf8',
    )
    .digest('hex')
}

function isResolvedV2Attribution(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const attr = value as { posture?: unknown; value?: unknown }
  if (attr.posture !== 'resolved_v2') return false
  if (typeof attr.value !== 'object' || attr.value === null) return false
  const v = attr.value as { schemaVersion?: unknown; shiftId?: unknown }
  return v.schemaVersion === 2 && typeof v.shiftId === 'string' && v.shiftId.length > 0
}

function hasDenseSegmentRows(
  segmentRows: Array<Record<string, unknown>>,
  expectedCount: number,
): boolean {
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 3) return false
  if (segmentRows.length !== expectedCount) return false
  const indexes = segmentRows
    .map((row) => Number(row.segment_index))
    .sort((a, b) => a - b)
  return indexes.every((index, position) => index === position)
}

export function computeRecomputePayloadFingerprintV1(input: {
  readonly recordId: string
  readonly expectedCalculationId: string | null
  readonly expectedCalculationVersion: number | null
  readonly policy: AttendanceRecomputePolicyV1
}): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalAttendanceJsonV1({
        recordId: input.recordId,
        expectedCalculationId: input.expectedCalculationId,
        expectedCalculationVersion: input.expectedCalculationVersion,
        policy: input.policy,
      }),
      'utf8',
    )
    .digest('hex')
}

export interface AppendRecomputeCalculationInputV1 {
  readonly client: AttendanceW4TransactionClientV1
  readonly orgId: string
  readonly recordId: string
  readonly expectedCalculationId: string | null
  readonly expectedCalculationVersion: number | null
  /** Stable caller UUID — required; never server-generated. */
  readonly operationId: string
  readonly actorId: string
  readonly correlationId: string
  readonly policy: AttendanceRecomputePolicyV1
  readonly mode: 'shadow' | 'authoritative'
  /**
   * Required for current_policy: fully resolved FrozenAttendanceContextV1 and
   * resolved_v2 attribution prepared by the private adapter via resolve_now +
   * buildW4ShadowFrozenContextV1. frozen_prior ignores these.
   */
  readonly currentPolicyAttribution?: unknown
  readonly currentPolicyContext?: unknown
}

export type AppendRecomputeCalculationResultV1 =
  | { readonly kind: 'replay'; readonly calculationId: string }
  | {
      readonly kind: 'appended'
      readonly calculationId: string
      readonly priorCalculationId: string
      readonly policy: AttendanceRecomputePolicyV1
      readonly contextDecision: 'prior_calculation_frozen' | 'current_policy_requested'
      readonly projectedStatus: string
    }

export function parseAttendanceRecomputePolicyV1(value: unknown): AttendanceRecomputePolicyV1 {
  if (value === 'frozen_prior' || value === 'current_policy') return value
  fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.INPUT_INVALID)
}

export function recomputeOperationIdentityLabelV1(policy: AttendanceRecomputePolicyV1): string {
  return policy === 'current_policy'
    ? 'recompute:current_policy'
    : 'recompute:frozen_prior'
}

export async function appendRecomputeCalculationV1(
  input: AppendRecomputeCalculationInputV1,
): Promise<AppendRecomputeCalculationResultV1> {
  const orgId = requireText(input.orgId, 128)
  const recordId = requireUuid(input.recordId)
  if (input.operationId === null || input.operationId === undefined || input.operationId === '') {
    fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.OPERATION_ID_REQUIRED)
  }
  const operationId = requireUuid(
    input.operationId,
    ATTENDANCE_RECOMPUTE_ERROR_CODES.OPERATION_ID_REQUIRED,
  )
  const actorId = requireText(input.actorId, 128)
  const correlationId = requireText(input.correlationId, 128)
  const policy = parseAttendanceRecomputePolicyV1(input.policy)
  if (input.mode !== 'shadow' && input.mode !== 'authoritative') {
    fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.INPUT_INVALID)
  }
  const expectedCalculationId =
    input.expectedCalculationId === null || input.expectedCalculationId === undefined
      ? null
      : requireUuid(input.expectedCalculationId)
  if (
    input.expectedCalculationVersion !== null
    && input.expectedCalculationVersion !== undefined
    && (!Number.isSafeInteger(input.expectedCalculationVersion) || input.expectedCalculationVersion < 1)
  ) {
    fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.INPUT_INVALID)
  }
  if (expectedCalculationId === null || input.expectedCalculationVersion == null) {
    fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.VERSION_CONFLICT, 409)
  }
  const payloadFingerprint = computeRecomputePayloadFingerprintV1({
    recordId,
    expectedCalculationId,
    expectedCalculationVersion: input.expectedCalculationVersion ?? null,
    policy,
  })

  const recordRows = await rows(
    input.client,
    `SELECT id::text AS id, org_id::text AS org_id, user_id::text AS user_id,
            work_date::text AS work_date,
            current_calculation_id::text AS current_calculation_id,
            projection_owner, visibility_state, visibility_reason, timezone
       FROM attendance_records
      WHERE id = $1::uuid AND org_id = $2
      FOR UPDATE`,
    [recordId, orgId],
  )
  if (recordRows.length === 0) fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.RECORD_NOT_FOUND, 404)
  if (recordRows.length !== 1) fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.DATABASE_RESULT_INVALID, 500)
  const record = recordRows[0]
  // Never reactivate any retired parent through ordinary recompute.
  assertParentNotRetiredForOrdinaryWriterV1(record)

  const replayRows = await rows(
    input.client,
    `SELECT id::text AS id,
            attendance_record_id::text AS attendance_record_id,
            input_provenance
       FROM attendance_record_calculations
      WHERE org_id = $1 AND entrypoint = 'recompute' AND operation_id = $2::uuid
      FOR UPDATE`,
    [orgId, operationId],
  )
  if (replayRows.length > 1) fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.DATABASE_RESULT_INVALID, 500)
  if (replayRows.length === 1) {
    const existing = replayRows[0]
    if (String(existing.attendance_record_id) !== recordId) {
      fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.REPLAY_CONFLICT, 409)
    }
    const provenance =
      existing.input_provenance && typeof existing.input_provenance === 'object'
        ? (existing.input_provenance as Record<string, unknown>)
        : null
    const existingFp =
      provenance && typeof provenance.payloadFingerprint === 'string'
        ? provenance.payloadFingerprint
        : null
    if (existingFp !== payloadFingerprint) {
      fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.REPLAY_CONFLICT, 409)
    }
    return Object.freeze({ kind: 'replay', calculationId: String(existing.id) })
  }

  const currentCalculationId =
    typeof record.current_calculation_id === 'string' ? record.current_calculation_id : null
  const priorCalculationId = expectedCalculationId
  if (input.mode === 'authoritative' && currentCalculationId !== priorCalculationId) {
    fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.VERSION_CONFLICT, 409)
  }

  const calcRows = await rows(
    input.client,
    `SELECT id::text AS id, version, outcome, expected_segment_count,
            attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
            approved_facts_snapshot, manual_override_snapshot
       FROM attendance_record_calculations
      WHERE id = $1::uuid AND attendance_record_id = $2::uuid AND org_id = $3
        AND version = $4
        AND outcome = 'completed'
        AND (
          $5::text <> 'shadow'
          OR version = (
            SELECT MAX(latest.version)
              FROM attendance_record_calculations latest
             WHERE latest.attendance_record_id = $2::uuid
               AND latest.org_id = $3
               AND latest.outcome = 'completed'
          )
        )
      FOR UPDATE`,
    [priorCalculationId, recordId, orgId, input.expectedCalculationVersion, input.mode],
  )
  if (calcRows.length !== 1) fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.VERSION_CONFLICT, 409)
  const prior = calcRows[0]
  if (
    Number(prior.version) !== input.expectedCalculationVersion
  ) {
    fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.VERSION_CONFLICT, 409)
  }
  if (prior.outcome !== 'completed') fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.PRIOR_UNSUPPORTED, 409)

  // frozen_prior requires a complete prior snapshot (attribution + context + dense segments).
  if (policy === 'frozen_prior') {
    if (!isResolvedV2Attribution(prior.attribution_snapshot)) {
      fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.PRIOR_UNSUPPORTED, 409)
    }
    if (!validateFrozenContextShape(prior.context_snapshot)) {
      fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.PRIOR_UNSUPPORTED, 409)
    }
    const segmentRows = await rows(
      input.client,
      `SELECT segment_index
         FROM attendance_record_segments
        WHERE calculation_id = $1::uuid AND record_id = $2::uuid AND org_id = $3
        ORDER BY segment_index
        FOR KEY SHARE`,
      [priorCalculationId, recordId, orgId],
    )
    if (!hasDenseSegmentRows(segmentRows, Number(prior.expected_segment_count))) {
      fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.PRIOR_UNSUPPORTED, 409)
    }
    if (!Array.isArray(prior.evidence_snapshot)) {
      fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.PRIOR_UNSUPPORTED, 409)
    }
  }

  const contextDecision =
    policy === 'current_policy' ? 'current_policy_requested' as const : 'prior_calculation_frozen' as const

  let attribution = prior.attribution_snapshot
  let context = prior.context_snapshot
  if (policy === 'current_policy') {
    if (input.currentPolicyAttribution === undefined || input.currentPolicyContext === undefined) {
      fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.CURRENT_POLICY_INCOMPLETE, 409)
    }
    // Fail closed on unsupported/empty-segment placeholders.
    if (!isResolvedV2Attribution(input.currentPolicyAttribution)) {
      fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.CURRENT_POLICY_INCOMPLETE, 409)
    }
    if (!validateFrozenContextShape(input.currentPolicyContext)) {
      fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.CURRENT_POLICY_INCOMPLETE, 409)
    }
    const currentSegments: unknown[] = Array.isArray(
      (input.currentPolicyContext as { segments?: unknown }).segments,
    )
      ? ((input.currentPolicyContext as { segments: unknown[] }).segments)
      : []
    if (currentSegments.length < 1 || currentSegments.length > 3) {
      fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.CURRENT_POLICY_INCOMPLETE, 409)
    }
    attribution = input.currentPolicyAttribution
    context = input.currentPolicyContext
  }

  const evidence = prior.evidence_snapshot
  const approvedFacts = prior.approved_facts_snapshot
  const manualOverride = prior.manual_override_snapshot
  const canonical = calculateAttendanceSegmentsV1({
    attribution: attribution as never,
    context: context as never,
    evidence: evidence as never,
    approvedFacts: approvedFacts as never,
  })
  if (canonical.outcome !== 'completed' || canonical.dailyProjection === null) {
    fail(
      policy === 'current_policy'
        ? ATTENDANCE_RECOMPUTE_ERROR_CODES.CURRENT_POLICY_INCOMPLETE
        : ATTENDANCE_RECOMPUTE_ERROR_CODES.PRIOR_UNSUPPORTED,
      409,
    )
  }

  const calculationTier = input.mode === 'authoritative' ? 'segment_authoritative' : 'legacy_shadow'
  const provenance = Object.freeze({
    transport: 'recompute' as const,
    sourceRef: recomputeOperationIdentityLabelV1(policy),
    artifactSha256: null,
    normalizedCsvSha256: null,
    convertedSheetName: null,
  })
  const sourceDefinitionFingerprint = computeAttendanceSourceDefinitionFingerprintV1({
    attribution,
    context,
  })
  if (sourceDefinitionFingerprint === null || !HEX64_RE.test(sourceDefinitionFingerprint)) {
    fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.PRIOR_UNSUPPORTED, 409)
  }
  const semanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
    attribution,
    context,
    evidence,
    approvedFacts,
    manualOverride,
    mergePolicy: 'merge',
    calculationTier,
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
    snapshotSchemaVersion: 1,
  })
  const calculationId = crypto.randomUUID()
  // Canonical segments remain physical calculator output. Surviving
  // manual_override_snapshot is a daily projection overlay only.
  const physicalDaily = canonical.dailyProjection
  const overlaidDaily = applyFrozenManualOverrideSnapshotToDailyProjectionV1(
    {
      status: physicalDaily.status,
      firstInAt: physicalDaily.firstInAt,
      lastOutAt: physicalDaily.lastOutAt,
      workMinutes: physicalDaily.workedMinutes,
      lateMinutes: physicalDaily.lateMinutes,
      earlyLeaveMinutes: physicalDaily.earlyLeaveMinutes,
    },
    manualOverride,
  )
  const projection = {
    status: overlaidDaily.status,
    firstInAt: overlaidDaily.firstInAt,
    lastOutAt: overlaidDaily.lastOutAt,
    workedMinutes: overlaidDaily.workMinutes ?? physicalDaily.workedMinutes,
    lateMinutes: overlaidDaily.lateMinutes ?? physicalDaily.lateMinutes,
    earlyLeaveMinutes: overlaidDaily.earlyLeaveMinutes ?? physicalDaily.earlyLeaveMinutes,
  }
  const nextVersion = Number(prior.version) + 1
  if (!Number.isSafeInteger(nextVersion) || nextVersion < 2) {
    fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.DATABASE_RESULT_INVALID, 500)
  }

  const segmentSnapshot =
    policy === 'current_policy'
      ? (context as { segments: unknown[] }).segments
      : prior.segment_snapshot

  await rows(
    input.client,
    `INSERT INTO attendance_record_calculations (
        id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
        engine_version, snapshot_schema_version, supersedes_calculation_id, operation_id,
        semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
        attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
        approved_facts_snapshot, manual_override_snapshot, input_provenance,
        merge_policy, calculation_tier, outcome, outcome_reason_code, projection_effect,
        expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
        projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
        projected_daily_fingerprint, actor_id, correlation_id
      ) VALUES (
        $1::uuid, $2, $3::uuid, $4, 'calculation', $5, 'recompute',
        $6, 1, $7::uuid, $8::uuid,
        $9, $10, $11,
        $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
        $16::jsonb, $17::jsonb, $18::jsonb,
        'merge', $19, 'completed', 'calculated', $20,
        $21, $22, $23, $24, $25, $26, $27, $28,
        $29, $30
      )`,
    [
      calculationId,
      orgId,
      recordId,
      nextVersion,
      input.mode,
      ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
      priorCalculationId,
      operationId,
      semanticFingerprint,
      computeAttendanceProvenanceFingerprintV1(provenance),
      sourceDefinitionFingerprint,
      canonicalAttendanceJsonV1(attribution),
      canonicalAttendanceJsonV1(context),
      canonicalAttendanceJsonV1(segmentSnapshot),
      canonicalAttendanceJsonV1(evidence),
      canonicalAttendanceJsonV1(approvedFacts),
      manualOverride === null || manualOverride === undefined
        ? null
        : canonicalAttendanceJsonV1(manualOverride),
      canonicalAttendanceJsonV1({
        provenance,
        policy,
        contextDecision,
        priorCalculationId,
        payloadFingerprint,
      }),
      calculationTier,
      input.mode === 'authoritative' ? 'set_active' : 'none',
      canonical.segments.length,
      projection.status,
      projection.firstInAt,
      projection.lastOutAt,
      projection.workedMinutes,
      projection.lateMinutes,
      projection.earlyLeaveMinutes,
      projectedDailyFingerprint(projection),
      actorId,
      correlationId,
    ],
  )

  for (const segment of canonical.segments) {
    await rows(
      input.client,
      `INSERT INTO attendance_record_segments (
          org_id, record_id, calculation_id, segment_index,
          expected_start_at, expected_end_at, actual_in_at, actual_out_at,
          work_minutes, late_minutes, early_leave_minutes, status,
          status_reasons, matched_evidence_refs, unmatched_evidence_refs
        ) VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                  $13::jsonb, $14::jsonb, $15::jsonb)`,
      [
        orgId,
        recordId,
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
        canonicalAttendanceJsonV1(segment.reasons),
        canonicalAttendanceJsonV1(segment.matchedEvidenceRefs),
        canonicalAttendanceJsonV1(segment.unmatchedEvidenceRefs),
      ],
    )
  }

  if (input.mode === 'authoritative') {
    const updated = await rows(
      input.client,
      `UPDATE attendance_records
          SET current_calculation_id = $3::uuid, projection_owner = 'w4',
              visibility_state = 'active', visibility_reason = 'active',
              status = $4, first_in_at = $5, last_out_at = $6,
              work_minutes = $7, late_minutes = $8, early_leave_minutes = $9,
              updated_at = now()
        WHERE id = $1::uuid AND org_id = $2 AND current_calculation_id = $10::uuid
        RETURNING id`,
      [
        recordId,
        orgId,
        calculationId,
        projection.status,
        projection.firstInAt,
        projection.lastOutAt,
        projection.workedMinutes,
        projection.lateMinutes,
        projection.earlyLeaveMinutes,
        priorCalculationId,
      ],
    )
    if (updated.length !== 1) fail(ATTENDANCE_RECOMPUTE_ERROR_CODES.VERSION_CONFLICT, 409)
  }

  return Object.freeze({
    kind: 'appended',
    calculationId,
    priorCalculationId,
    policy,
    contextDecision,
    projectedStatus: projection.status,
  })
}
