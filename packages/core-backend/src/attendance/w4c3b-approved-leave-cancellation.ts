/**
 * W4C-3b P14 - append-only calculation support for cancelling an approved
 * leave request. This is deliberately transaction-bound but is not wired to a
 * route yet: the later cancellation adapter owns eligibility, request state,
 * ledger reversal, and durable event sequencing.
 *
 * This module never resolves a schedule or reads mutable request policy. A
 * completed cancellation calculation is derived solely from the locked prior
 * calculation, its immutable segment children, and the snapshot referenced by
 * the leave fact. Missing or inconsistent frozen evidence returns a review /
 * no-parent result before source or result DML.
 */

import crypto from 'node:crypto'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
} from './w4c0-fingerprints'
import {
  calculateAttendanceSegmentsV1,
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
} from './w4c1-segment-calculator'
import { computeAttendanceSourceDefinitionFingerprintV1 } from './w4c1-fingerprints'

export type W4c3bApprovedLeaveCancellationQueryClient = Readonly<{
  query: (
    sql: string,
    params?: readonly unknown[] | unknown[],
  ) => Promise<Array<Record<string, unknown>> | { rows: Array<Record<string, unknown>> }>
}>

export const W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'W4C3B_P14_INPUT_INVALID',
  RECORD_NOT_FOUND: 'W4C3B_P14_RECORD_NOT_FOUND',
  RECORD_VERSION_CONFLICT: 'W4C3B_P14_RECORD_VERSION_CONFLICT',
  DATABASE_RESULT_INVALID: 'W4C3B_P14_DATABASE_RESULT_INVALID',
} as const)

export class ApprovedLeaveCancellationError extends Error {
  readonly code: (typeof W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES)[keyof typeof W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES]

  constructor(code: ApprovedLeaveCancellationError['code']) {
    super(code)
    this.name = 'ApprovedLeaveCancellationError'
    this.code = code
  }
}

export type ApprovedLeaveCancellationReviewReasonV1 =
  | 'record_missing'
  | 'no_current_calculation'
  | 'prior_calculation_not_completed'
  | 'prior_segments_missing'
  | 'frozen_request_fact_missing'
  | 'frozen_request_fact_ambiguous'
  | 'frozen_request_snapshot_missing'
  | 'frozen_request_snapshot_mismatch'
  | 'frozen_request_snapshot_identity_mismatch'
  | 'frozen_calculation_input_invalid'

export type AppendApprovedLeaveCancellationCalculationResultV1 =
  | Readonly<{
      kind: 'appended'
      calculationId: string
      priorCalculationId: string
      projectedStatus: string
    }>
  | Readonly<{
      kind: 'replay'
      calculationId: string
    }>
  | Readonly<{
      kind: 'review_required'
      reason: ApprovedLeaveCancellationReviewReasonV1
    }>

export type AppendApprovedLeaveCancellationCalculationInputV1 = Readonly<{
  /** Existing transaction client. The caller owns BEGIN/COMMIT/ROLLBACK. */
  client: W4c3bApprovedLeaveCancellationQueryClient
  orgId: string
  userId: string
  workDate: string
  requestId: string
  operationId: string
  actorId: string
  correlationId: string
  mode: 'shadow' | 'authoritative'
}>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX64_RE = /^[0-9a-f]{64}$/
const WORK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function fail(code: ApprovedLeaveCancellationError['code']): never {
  throw new ApprovedLeaveCancellationError(code)
}

function requireText(value: unknown, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES.INPUT_INVALID)
  }
  return value
}

function requireUuid(value: unknown): string {
  const id = requireText(value, 36)
  if (!UUID_RE.test(id)) fail(W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES.INPUT_INVALID)
  return id.toLowerCase()
}

async function rows(
  client: W4c3bApprovedLeaveCancellationQueryClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(sql, params as unknown[])
  return Array.isArray(result) ? result : result.rows
}

function json(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
  return value
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  return value as Record<string, unknown>
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalAttendanceJsonV1(left) === canonicalAttendanceJsonV1(right)
  } catch {
    return false
  }
}

function projectedDailyFingerprint(projection: Readonly<{
  status: string
  firstInAt: string | null
  lastOutAt: string | null
  workedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
}>): string {
  return crypto
    .createHash('sha256')
    .update('metasheet2:attendance:w4:projected-daily:v1\0', 'utf8')
    .update(canonicalAttendanceJsonV1(projection), 'utf8')
    .digest('hex')
}

function review(reason: ApprovedLeaveCancellationReviewReasonV1): AppendApprovedLeaveCancellationCalculationResultV1 {
  return Object.freeze({ kind: 'review_required', reason })
}

function requestFactForCancellation(
  approvedFacts: unknown,
  requestId: string,
): { fact: Record<string, unknown>; remaining: unknown[] } | AppendApprovedLeaveCancellationCalculationResultV1 {
  if (!Array.isArray(approvedFacts)) return review('frozen_calculation_input_invalid')
  const matching = approvedFacts.filter((value) => {
    const fact = plainObject(value)
    return fact?.kind === 'leave' && fact.requestId === requestId
  })
  if (matching.length === 0) return review('frozen_request_fact_missing')
  if (matching.length !== 1) return review('frozen_request_fact_ambiguous')
  const fact = plainObject(matching[0])
  if (!fact) return review('frozen_calculation_input_invalid')
  return { fact, remaining: approvedFacts.filter((value) => value !== matching[0]) }
}

function hasDenseFrozenSegments(rowsForCalculation: Array<Record<string, unknown>>, expectedCount: number): boolean {
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 3) return false
  if (rowsForCalculation.length !== expectedCount) return false
  const indexes = rowsForCalculation.map((row) => Number(row.segment_index)).sort((left, right) => left - right)
  return indexes.every((index, position) => index === position)
}

/**
 * Appends a cancellation calculation only when a completed immutable parent
 * already proves the target leave fact and the exact request snapshot it used.
 * It intentionally performs no live schedule, approval-request, or policy read.
 */
export async function appendApprovedLeaveCancellationCalculationV1(
  input: AppendApprovedLeaveCancellationCalculationInputV1,
): Promise<AppendApprovedLeaveCancellationCalculationResultV1> {
  const orgId = requireText(input.orgId, 128)
  const requestId = requireUuid(input.requestId)
  const operationId = requireUuid(input.operationId)
  const userId = requireText(input.userId, 128)
  const workDate = requireText(input.workDate, 10)
  if (!WORK_DATE_RE.test(workDate)) {
    fail(W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES.INPUT_INVALID)
  }
  const actorId = requireText(input.actorId, 128)
  const correlationId = requireText(input.correlationId, 128)
  if (input.mode !== 'shadow' && input.mode !== 'authoritative') {
    fail(W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES.INPUT_INVALID)
  }

  const recordRows = await rows(
    input.client,
    `SELECT id::text AS id, org_id::text AS org_id, user_id::text AS user_id,
            work_date::text AS work_date, current_calculation_id::text AS current_calculation_id
       FROM attendance_records
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
      FOR UPDATE`,
    [orgId, userId, workDate],
  )
  if (recordRows.length === 0) return review('record_missing')
  if (recordRows.length !== 1) fail(W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES.DATABASE_RESULT_INVALID)
  const record = recordRows[0]
  const recordId = requireUuid(record.id)

  const replayRows = await rows(
    input.client,
    `SELECT id::text AS id
       FROM attendance_record_calculations
      WHERE org_id = $1 AND entrypoint = 'approval_reversal' AND operation_id = $2::uuid
      FOR UPDATE`,
    [orgId, operationId],
  )
  if (replayRows.length === 1) return Object.freeze({ kind: 'replay', calculationId: String(replayRows[0].id) })
  if (replayRows.length > 1) fail(W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES.DATABASE_RESULT_INVALID)

  const priorCalculationId = typeof record.current_calculation_id === 'string'
    ? record.current_calculation_id
    : null
  if (!priorCalculationId || !UUID_RE.test(priorCalculationId)) return review('no_current_calculation')

  const calculationRows = await rows(
    input.client,
    `SELECT id::text AS id, version, outcome, expected_segment_count,
            attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
            approved_facts_snapshot, manual_override_snapshot
       FROM attendance_record_calculations
      WHERE id = $1::uuid AND attendance_record_id = $2::uuid AND org_id = $3
      FOR UPDATE`,
    [priorCalculationId, recordId, orgId],
  )
  if (calculationRows.length === 0) return review('no_current_calculation')
  if (calculationRows.length !== 1) fail(W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES.DATABASE_RESULT_INVALID)
  const prior = calculationRows[0]
  if (prior.outcome !== 'completed') return review('prior_calculation_not_completed')

  const priorSegments = await rows(
    input.client,
    `SELECT segment_index
       FROM attendance_record_segments
      WHERE calculation_id = $1::uuid AND record_id = $2::uuid AND org_id = $3
      ORDER BY segment_index
      FOR KEY SHARE`,
    [priorCalculationId, recordId, orgId],
  )
  if (!hasDenseFrozenSegments(priorSegments, Number(prior.expected_segment_count))) {
    return review('prior_segments_missing')
  }

  const approvedFacts = json(prior.approved_facts_snapshot)
  const selected = requestFactForCancellation(approvedFacts, requestId)
  if ('kind' in selected) return selected
  const requestSnapshotVersion = selected.fact.requestSnapshotVersion
  const requestSnapshotFingerprint = selected.fact.requestSnapshotFingerprint
  if (!Number.isSafeInteger(requestSnapshotVersion) || (requestSnapshotVersion as number) < 1 ||
      typeof requestSnapshotFingerprint !== 'string' || !HEX64_RE.test(requestSnapshotFingerprint)) {
    return review('frozen_request_snapshot_mismatch')
  }

  const snapshotRows = await rows(
    input.client,
    `SELECT version, request_type::text AS request_type, subject_user_id::text AS subject_user_id,
            payload, payload_fingerprint
       FROM attendance_request_calculation_snapshots
      WHERE org_id = $1 AND request_id = $2::uuid AND version = $3
      FOR KEY SHARE`,
    [orgId, requestId, requestSnapshotVersion],
  )
  if (snapshotRows.length === 0) return review('frozen_request_snapshot_missing')
  if (snapshotRows.length !== 1) fail(W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES.DATABASE_RESULT_INVALID)
  const snapshot = snapshotRows[0]
  if (snapshot.request_type !== 'leave' || snapshot.subject_user_id !== userId) {
    return review('frozen_request_snapshot_identity_mismatch')
  }
  if (snapshot.payload_fingerprint !== requestSnapshotFingerprint) return review('frozen_request_snapshot_mismatch')
  const payload = plainObject(json(snapshot.payload))
  if (!payload || payload.workDate !== String(record.work_date).slice(0, 10)) {
    return review('frozen_request_snapshot_identity_mismatch')
  }

  const attribution = json(prior.attribution_snapshot)
  const context = json(prior.context_snapshot)
  const evidence = json(prior.evidence_snapshot)
  const segmentSnapshot = json(prior.segment_snapshot)
  const manualOverride = prior.manual_override_snapshot === null ? null : json(prior.manual_override_snapshot)
  const canonical = calculateAttendanceSegmentsV1({
    attribution: attribution as never,
    context: context as never,
    evidence: evidence as never,
    approvedFacts: selected.remaining as never,
  })
  if (canonical.outcome !== 'completed' || canonical.dailyProjection === null) {
    return review('frozen_calculation_input_invalid')
  }
  if (!sameJson(segmentSnapshot, (plainObject(context)?.segments ?? []))) {
    return review('frozen_calculation_input_invalid')
  }

  const sourceDefinitionFingerprint = computeAttendanceSourceDefinitionFingerprintV1({ attribution, context })
  if (sourceDefinitionFingerprint === null) return review('frozen_calculation_input_invalid')
  const calculationTier = input.mode === 'authoritative' ? 'segment_authoritative' : 'legacy_shadow'
  const provenance = Object.freeze({
    transport: 'approval_reversal' as const,
    sourceRef: requestId,
    artifactSha256: null,
    normalizedCsvSha256: null,
    convertedSheetName: null,
  })
  const semanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
    attribution,
    context,
    evidence,
    approvedFacts: selected.remaining,
    manualOverride,
    mergePolicy: 'reversal',
    calculationTier,
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
    snapshotSchemaVersion: 1,
  })
  const calculationId = crypto.randomUUID()
  const projection = canonical.dailyProjection
  const nextVersion = Number(prior.version) + 1
  if (!Number.isSafeInteger(nextVersion) || nextVersion < 2) {
    fail(W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES.DATABASE_RESULT_INVALID)
  }

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
        $1::uuid, $2, $3::uuid, $4, 'calculation', $5, 'approval_reversal',
        $6, 1, $7::uuid, $8::uuid,
        $9, $10, $11,
        $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
        $16::jsonb, $17::jsonb, $18::jsonb,
        'reversal', $19, 'completed', 'calculated', $20,
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
      canonicalAttendanceJsonV1(selected.remaining),
      manualOverride === null ? null : canonicalAttendanceJsonV1(manualOverride),
      canonicalAttendanceJsonV1({
        provenance,
        priorCalculationId,
        requestSnapshot: {
          requestId,
          version: requestSnapshotVersion,
          fingerprint: requestSnapshotFingerprint,
        },
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
              timezone = $10, updated_at = now()
        WHERE id = $1::uuid AND org_id = $2 AND current_calculation_id = $11::uuid
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
        plainObject(context)?.timezone ?? null,
        priorCalculationId,
      ],
    )
    if (updated.length !== 1) fail(W4C3B_APPROVED_LEAVE_CANCELLATION_ERROR_CODES.RECORD_VERSION_CONFLICT)
  }

  return Object.freeze({
    kind: 'appended',
    calculationId,
    priorCalculationId,
    projectedStatus: projection.status,
  })
}
