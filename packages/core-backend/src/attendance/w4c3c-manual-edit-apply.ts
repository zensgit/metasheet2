/**
 * W4C-3c P05 — transaction-bound manual override apply for shadow/authoritative
 * postures. Freezes ManualAttendanceOverrideV1 into manual_override_snapshot on
 * the calculation row and applies the override projection. Called only from the
 * record-operation boundary adapter after capability preflight.
 *
 * Contract (lock §4.1 / §7.8 / §12.6):
 * - requires a stable caller operation UUID and a complete valid prior immutable
 *   W4 calculation;
 * - never fabricates attribution/context/evidence/segments from
 *   attendance_records.first_in_at/last_out_at and never invents 09:00-18:00;
 * - preserves frozen prior provenance/context while appending the authorized
 *   manual snapshot and a truthful projection;
 * - incomplete legacy provenance fails closed with zero current change;
 * - unset does not silently coerce metrics to zero;
 * - replay identity binds operationId + target record + payload fingerprint.
 *
 * legacy_projection_only remains the plugin's single-write meta path; this
 * module is the W4 calculation path.
 */
import crypto from 'node:crypto'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
} from './w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from './w4c1-fingerprints'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  deriveAttendanceLateTierFieldsV1,
  validateFrozenContextShape,
} from './w4c1-segment-calculator'
import {
  applyManualOverrideDailyOverlayV1,
  assertManualEditableSourceStatusV1,
  assertManualOverrideOperationsValidV1,
  buildManualAttendanceOverrideSnapshotV1,
  buildManualResultEditMarkerInWriteV1,
  type AttendanceManualOverrideOperationV1,
  ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES,
  AttendanceW4ManualOverrideError,
} from './w4c3c-manual-override'
import { assertParentNotRetiredForOrdinaryWriterV1 } from './w4c3c-ops-retirement'
import { computeAttendanceW4ShadowDiff } from '../services/AttendanceW4CalculationDetail'

export const ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES = Object.freeze({
  ...ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES,
  RECORD_NOT_FOUND: 'ATTENDANCE_RECORD_NOT_FOUND',
  VERSION_CONFLICT: 'ATTENDANCE_RECORD_VERSION_CONFLICT',
  CYCLE_CLOSED: 'ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED',
  DATABASE_RESULT_INVALID: 'W4C3C_MANUAL_EDIT_DATABASE_RESULT_INVALID',
  OPERATOR_RETIRED: 'ATTENDANCE_RECORD_OPERATOR_RETIRED',
  PRIOR_INCOMPLETE: 'W4C3C_MANUAL_EDIT_PRIOR_INCOMPLETE',
  REPLAY_CONFLICT: 'W4C3C_MANUAL_EDIT_REPLAY_CONFLICT',
  OPERATION_ID_REQUIRED: 'W4C3C_MANUAL_EDIT_OPERATION_ID_REQUIRED',
} as const)

function fail(code: string, httpStatus = 422): never {
  throw new AttendanceW4ManualOverrideError(code, httpStatus)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64_RE = /^[0-9a-f]{64}$/

function requireUuid(value: unknown, code: string = ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.INPUT_INVALID): string {
  if (typeof value !== 'string' || !UUID_RE.test(value.toLowerCase())) {
    fail(code)
  }
  return value.toLowerCase()
}

function requireText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.INPUT_INVALID)
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

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n) && n >= 0 && Number.isInteger(n)) return n
  }
  return null
}

function projectedDailyFingerprint(projection: {
  status: string
  firstInAt: string | null
  lastOutAt: string | null
  workedMinutes: number | null
  lateMinutes: number | null
  earlyLeaveMinutes: number | null
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

export function computeManualEditPayloadFingerprintV1(input: {
  readonly recordId: string
  readonly expectedCalculationId: string | null
  readonly expectedCalculationVersion: number | null
  readonly operations: readonly AttendanceManualOverrideOperationV1[]
  readonly reason: string
}): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalAttendanceJsonV1({
        recordId: input.recordId,
        expectedCalculationId: input.expectedCalculationId,
        expectedCalculationVersion: input.expectedCalculationVersion,
        operations: input.operations,
        reason: input.reason,
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
  const v = attr.value as { schemaVersion?: unknown; shiftId?: unknown; workDate?: unknown }
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

function parentIntegerFromNullable(
  projected: number | null,
  priorProjected: number | null,
  parentValue: unknown,
): number {
  if (projected !== null) return projected
  if (priorProjected !== null) return priorProjected
  const n = Number(parentValue ?? 0)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

export interface AppendManualOverrideCalculationInputV1 {
  readonly client: AttendanceW4TransactionClientV1
  readonly orgId: string
  readonly recordId: string
  readonly expectedCalculationId: string | null
  readonly expectedCalculationVersion: number | null
  /** Stable caller UUID — required; never server-generated. */
  readonly operationId: string
  readonly actorId: string
  readonly correlationId: string
  readonly reason: string
  readonly evidence: unknown
  readonly operations: readonly unknown[]
  readonly mode: 'shadow' | 'authoritative'
  readonly editId: string
}

export type AppendManualOverrideCalculationResultV1 =
  | { readonly kind: 'replay'; readonly calculationId: string }
  | {
      readonly kind: 'appended'
      readonly calculationId: string
      readonly priorCalculationId: string
      readonly projectedStatus: string
      readonly manualOverride: ReturnType<typeof buildManualAttendanceOverrideSnapshotV1>
      readonly metaMarker: Record<string, unknown>
      readonly projection: {
        readonly status: string
        readonly firstInAt: string | null
        readonly lastOutAt: string | null
        readonly workMinutes: number | null
        readonly lateMinutes: number | null
        readonly earlyLeaveMinutes: number | null
      }
    }

export async function appendManualOverrideCalculationV1(
  input: AppendManualOverrideCalculationInputV1,
): Promise<AppendManualOverrideCalculationResultV1> {
  const orgId = requireText(input.orgId, 128)
  const recordId = requireUuid(input.recordId)
  if (input.operationId === null || input.operationId === undefined || input.operationId === '') {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.OPERATION_ID_REQUIRED)
  }
  const operationId = requireUuid(
    input.operationId,
    ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.OPERATION_ID_REQUIRED,
  )
  const actorId = requireText(input.actorId, 128)
  const correlationId = requireText(input.correlationId, 128)
  const reason = requireText(input.reason, 2000)
  const editId = requireUuid(input.editId)
  if (input.mode !== 'shadow' && input.mode !== 'authoritative') {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.INPUT_INVALID)
  }
  const operations = assertManualOverrideOperationsValidV1([...input.operations])
  const expectedCalculationId =
    input.expectedCalculationId === null || input.expectedCalculationId === undefined
      ? null
      : requireUuid(input.expectedCalculationId)
  if (
    input.expectedCalculationVersion !== null
    && input.expectedCalculationVersion !== undefined
    && (!Number.isSafeInteger(input.expectedCalculationVersion) || input.expectedCalculationVersion < 1)
  ) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.INPUT_INVALID)
  }
  if (expectedCalculationId === null || input.expectedCalculationVersion == null) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.VERSION_CONFLICT, 409)
  }
  const payloadFingerprint = computeManualEditPayloadFingerprintV1({
    recordId,
    expectedCalculationId,
    expectedCalculationVersion: input.expectedCalculationVersion ?? null,
    operations,
    reason,
  })

  const recordRows = await rows(
    input.client,
    `SELECT id::text AS id, org_id::text AS org_id, user_id::text AS user_id,
            work_date::text AS work_date,
            current_calculation_id::text AS current_calculation_id,
            projection_owner, visibility_state, visibility_reason,
            status, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes,
            timezone, is_workday, meta
       FROM attendance_records
      WHERE id = $1::uuid AND org_id = $2
      FOR UPDATE`,
    [recordId, orgId],
  )
  if (recordRows.length === 0) fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.RECORD_NOT_FOUND, 404)
  if (recordRows.length !== 1) fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.DATABASE_RESULT_INVALID, 500)
  const record = recordRows[0]
  // Never reactivate any retired parent through ordinary manual_edit.
  assertParentNotRetiredForOrdinaryWriterV1(record)

  const beforeStatus = String(record.status ?? '')
  assertManualEditableSourceStatusV1(beforeStatus)

  const workDate = String(record.work_date).slice(0, 10)
  let cycleRows: Array<Record<string, unknown>>
  try {
    cycleRows = await rows(
      input.client,
      `SELECT 1 FROM attendance_payroll_cycles
        WHERE org_id = $1 AND status IN ('closed', 'archived')
          AND $2::date BETWEEN start_date AND end_date
        LIMIT 1`,
      [orgId, workDate],
    )
  } catch {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.CYCLE_CLOSED, 503)
  }
  if (cycleRows.length > 0) fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.CYCLE_CLOSED, 409)

  // Replay identity: operationId + target record + payload fingerprint.
  const replayRows = await rows(
    input.client,
    `SELECT id::text AS id,
            attendance_record_id::text AS attendance_record_id,
            input_provenance
       FROM attendance_record_calculations
      WHERE org_id = $1 AND entrypoint = 'manual_override' AND operation_id = $2::uuid
      FOR UPDATE`,
    [orgId, operationId],
  )
  if (replayRows.length > 1) fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.DATABASE_RESULT_INVALID, 500)
  if (replayRows.length === 1) {
    const existing = replayRows[0]
    if (String(existing.attendance_record_id) !== recordId) {
      fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.REPLAY_CONFLICT, 409)
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
      fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.REPLAY_CONFLICT, 409)
    }
    return Object.freeze({ kind: 'replay', calculationId: String(existing.id) })
  }

  const currentCalculationId =
    typeof record.current_calculation_id === 'string' ? record.current_calculation_id : null
  const priorCalculationId = expectedCalculationId
  if (input.mode === 'authoritative' && currentCalculationId !== priorCalculationId) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.VERSION_CONFLICT, 409)
  }

  const calcRows = await rows(
    input.client,
    `SELECT id::text AS id, version, outcome, expected_segment_count,
            attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
            approved_facts_snapshot, manual_override_snapshot,
            projected_status, projected_first_in_at, projected_last_out_at,
            projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
            input_provenance, provenance_fingerprint, source_definition_fingerprint
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
  if (calcRows.length !== 1) fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.VERSION_CONFLICT, 409)
  const prior = calcRows[0]
  if (
    Number(prior.version) !== input.expectedCalculationVersion
  ) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.VERSION_CONFLICT, 409)
  }
  if (prior.outcome !== 'completed') {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
  }
  if (!isResolvedV2Attribution(prior.attribution_snapshot)) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
  }
  if (!validateFrozenContextShape(prior.context_snapshot)) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
  }
  const expectedSegmentCount = Number(prior.expected_segment_count)
  const segmentRows = await rows(
    input.client,
    `SELECT segment_index
       FROM attendance_record_segments
      WHERE calculation_id = $1::uuid AND record_id = $2::uuid AND org_id = $3
      ORDER BY segment_index
      FOR KEY SHARE`,
    [priorCalculationId, recordId, orgId],
  )
  if (!hasDenseSegmentRows(segmentRows, expectedSegmentCount)) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
  }
  // Evidence must be an array snapshot (may be empty). Never reverse-engineer punches.
  if (!Array.isArray(prior.evidence_snapshot)) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
  }

  const priorInputProvenance =
    prior.input_provenance && typeof prior.input_provenance === 'object'
      ? (prior.input_provenance as Record<string, unknown>)
      : null
  const priorProvenance =
    priorInputProvenance?.provenance && typeof priorInputProvenance.provenance === 'object'
      ? priorInputProvenance.provenance
      : priorInputProvenance?.transport !== undefined
        ? priorInputProvenance
        : null
  let provenanceFingerprint: string
  try {
    provenanceFingerprint = computeAttendanceProvenanceFingerprintV1(priorProvenance)
  } catch {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
  }
  if (provenanceFingerprint !== prior.provenance_fingerprint) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
  }

  const priorAttribution = prior.attribution_snapshot
  const priorContext = prior.context_snapshot
  const priorEvidence = prior.evidence_snapshot
  const priorApproved = Array.isArray(prior.approved_facts_snapshot)
    ? prior.approved_facts_snapshot
    : []
  const priorSegments =
    Array.isArray(prior.segment_snapshot) && (prior.segment_snapshot as unknown[]).length > 0
      ? prior.segment_snapshot
      : (priorContext as { segments: unknown[] }).segments

  const priorProjected = {
    status: typeof prior.projected_status === 'string' ? prior.projected_status : beforeStatus,
    firstInAt: nullableIso(prior.projected_first_in_at),
    lastOutAt: nullableIso(prior.projected_last_out_at),
    workMinutes: nullableNonNegativeInteger(prior.projected_work_minutes),
    lateMinutes: nullableNonNegativeInteger(prior.projected_late_minutes),
    earlyLeaveMinutes: nullableNonNegativeInteger(prior.projected_early_leave_minutes),
  }

  // Projection base is the prior immutable projection — never mutable parent first/last inference.
  // Manual override is a daily overlay only (physical segments stay byte-equivalent copies).
  const beforeProjection = {
    status: priorProjected.status,
    firstInAt: priorProjected.firstInAt,
    lastOutAt: priorProjected.lastOutAt,
    workMinutes: priorProjected.workMinutes,
    lateMinutes: priorProjected.lateMinutes,
    earlyLeaveMinutes: priorProjected.earlyLeaveMinutes,
  }
  const overlaid = applyManualOverrideDailyOverlayV1(beforeProjection, operations)
  const projection = {
    status: overlaid.status,
    firstInAt: overlaid.firstInAt,
    lastOutAt: overlaid.lastOutAt,
    workedMinutes: overlaid.workMinutes,
    lateMinutes: overlaid.lateMinutes,
    earlyLeaveMinutes: overlaid.earlyLeaveMinutes,
  }
  const resolvedWorkDate = typeof (priorContext as { workDate?: unknown }).workDate === 'string'
    ? (priorContext as { workDate: string }).workDate
    : null
  const shadowDiff = input.mode === 'shadow'
    ? computeAttendanceW4ShadowDiff({
        legacy: {
          workDate,
          status: typeof record.status === 'string' ? record.status : null,
          firstInAt: record.first_in_at as string | Date | null,
          lastOutAt: record.last_out_at as string | Date | null,
          workMinutes: record.work_minutes === null ? null : Number(record.work_minutes),
          lateMinutes: record.late_minutes === null ? null : Number(record.late_minutes),
          earlyLeaveMinutes: record.early_leave_minutes === null ? null : Number(record.early_leave_minutes),
        },
        calculated: {
          workDate: resolvedWorkDate,
          status: projection.status,
          firstInAt: projection.firstInAt,
          lastOutAt: projection.lastOutAt,
          workMinutes: projection.workedMinutes,
          lateMinutes: projection.lateMinutes,
          earlyLeaveMinutes: projection.earlyLeaveMinutes,
        },
        segmentCount: expectedSegmentCount,
        outcome: 'completed',
        workDateMismatch: resolvedWorkDate !== null && resolvedWorkDate !== workDate,
      })
    : null
  const nextVersion = Number(prior.version) + 1
  if (!Number.isSafeInteger(nextVersion) || nextVersion < 2) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.DATABASE_RESULT_INVALID, 500)
  }

  const manualOverride = buildManualAttendanceOverrideSnapshotV1({
    editId,
    before: beforeProjection,
    reason,
    operations,
  })
  const metaMarker = buildManualResultEditMarkerInWriteV1({
    auditId: editId,
    idempotencyKey: operationId,
    targetStatus: projection.status,
    workMinutes: projection.workedMinutes ?? priorProjected.workMinutes ?? 0,
    lateMinutes: projection.lateMinutes ?? priorProjected.lateMinutes ?? 0,
    earlyLeaveMinutes: projection.earlyLeaveMinutes ?? priorProjected.earlyLeaveMinutes ?? 0,
    workDate,
    firstInAt: projection.firstInAt,
    lastOutAt: projection.lastOutAt,
    isWorkday: record.is_workday !== false,
    actorUserId: actorId,
  })

  const calculationTier = input.mode === 'authoritative' ? 'segment_authoritative' : 'legacy_shadow'
  const sourceDefinitionFingerprint = computeAttendanceSourceDefinitionFingerprintV1({
    attribution: priorAttribution,
    context: priorContext,
  })
  if (sourceDefinitionFingerprint === null || !HEX64_RE.test(sourceDefinitionFingerprint)) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
  }
  const semanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
    attribution: priorAttribution,
    context: priorContext,
    evidence: priorEvidence,
    approvedFacts: priorApproved,
    manualOverride,
    mergePolicy: 'override',
    calculationTier,
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
    snapshotSchemaVersion: 1,
  })
  const calculationId = crypto.randomUUID()
  const segmentCount = expectedSegmentCount
  // Avoid `const name = (` which the DML inventory nearest-enclosing-symbol scanner
  // would mis-attribute as a writer symbol.
  const frozenContextSegments: Array<Record<string, unknown>> =
    Array.isArray((priorContext as { segments?: unknown }).segments)
      ? ((priorContext as { segments: Array<Record<string, unknown>> }).segments)
      : []

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
        projected_daily_fingerprint, shadow_diff_code, shadow_diff, actor_id, correlation_id
      ) VALUES (
        $1::uuid, $2, $3::uuid, $4, 'calculation', $5, 'manual_override',
        $6, 1, $7::uuid, $8::uuid,
        $9, $10, $11,
        $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
        $16::jsonb, $17::jsonb, $18::jsonb,
        'override', $19, 'completed', 'calculated', $20,
        $21, $22, $23, $24, $25, $26, $27, $28,
        $29, $30::jsonb, $31, $32
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
      provenanceFingerprint,
      sourceDefinitionFingerprint,
      canonicalAttendanceJsonV1(priorAttribution),
      canonicalAttendanceJsonV1(priorContext),
      canonicalAttendanceJsonV1(priorSegments),
      canonicalAttendanceJsonV1(priorEvidence),
      canonicalAttendanceJsonV1(priorApproved),
      canonicalAttendanceJsonV1(manualOverride),
      canonicalAttendanceJsonV1({
        provenance: priorProvenance,
        priorCalculationId,
        evidence: input.evidence ?? null,
        reason,
        payloadFingerprint,
        editId,
      }),
      calculationTier,
      input.mode === 'authoritative' ? 'set_active' : 'none',
      segmentCount,
      projection.status,
      projection.firstInAt,
      projection.lastOutAt,
      projection.workedMinutes,
      projection.lateMinutes,
      projection.earlyLeaveMinutes,
      projectedDailyFingerprint(projection),
      shadowDiff?.code ?? null,
      shadowDiff ? canonicalAttendanceJsonV1(shadowDiff) : null,
      actorId,
      correlationId,
    ],
  )

  // Physical segment rows: byte/field-equivalent copy of prior segments.
  // Manual override is a daily projection overlay only — never inject daily
  // override metrics/status into any segment (corrupts multi-segment sums).
  const priorSegmentDetail = await rows(
    input.client,
    `SELECT segment_index, expected_start_at, expected_end_at, actual_in_at, actual_out_at,
            work_minutes, late_minutes, early_leave_minutes, status, status_reasons,
            matched_evidence_refs, unmatched_evidence_refs
       FROM attendance_record_segments
      WHERE calculation_id = $1::uuid AND record_id = $2::uuid AND org_id = $3
      ORDER BY segment_index`,
    [priorCalculationId, recordId, orgId],
  )
  if (priorSegmentDetail.length !== segmentCount) {
    fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
  }
  for (let i = 0; i < segmentCount; i += 1) {
    const priorSeg = priorSegmentDetail[i]
    if (!priorSeg || Number(priorSeg.segment_index) !== i) {
      fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
    }
    if (priorSeg.expected_start_at == null || priorSeg.expected_end_at == null) {
      fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE, 409)
    }
    await rows(
      input.client,
      `INSERT INTO attendance_record_segments (
          org_id, record_id, calculation_id, segment_index,
          expected_start_at, expected_end_at, actual_in_at, actual_out_at,
          work_minutes, late_minutes, early_leave_minutes, status,
          status_reasons, matched_evidence_refs, unmatched_evidence_refs
        ) VALUES (
          $1, $2::uuid, $3::uuid, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13::jsonb, $14::jsonb, $15::jsonb
        )`,
      [
        orgId,
        recordId,
        calculationId,
        i,
        priorSeg.expected_start_at,
        priorSeg.expected_end_at,
        priorSeg.actual_in_at ?? null,
        priorSeg.actual_out_at ?? null,
        priorSeg.work_minutes,
        priorSeg.late_minutes,
        priorSeg.early_leave_minutes,
        priorSeg.status,
        priorSeg.status_reasons != null
          ? canonicalAttendanceJsonV1(priorSeg.status_reasons)
          : JSON.stringify(['within_window']),
        priorSeg.matched_evidence_refs != null
          ? canonicalAttendanceJsonV1(priorSeg.matched_evidence_refs)
          : '[]',
        priorSeg.unmatched_evidence_refs != null
          ? canonicalAttendanceJsonV1(priorSeg.unmatched_evidence_refs)
          : '[]',
      ],
    )
  }
  void frozenContextSegments

  if (input.mode === 'authoritative') {
    const existingMeta =
      record.meta && typeof record.meta === 'object' && !Array.isArray(record.meta)
        ? (record.meta as Record<string, unknown>)
        : {}
    // Parent NOT NULL integer columns: never invent zero from unset — prefer projected,
    // then prior projected, then existing parent.
    const parentWork = parentIntegerFromNullable(
      projection.workedMinutes,
      priorProjected.workMinutes,
      record.work_minutes,
    )
    const parentLate = parentIntegerFromNullable(
      projection.lateMinutes,
      priorProjected.lateMinutes,
      record.late_minutes,
    )
    const parentEarly = parentIntegerFromNullable(
      projection.earlyLeaveMinutes,
      priorProjected.earlyLeaveMinutes,
      record.early_leave_minutes,
    )
    const lateTiers = deriveAttendanceLateTierFieldsV1(
      parentLate,
      priorContext.severeLateThresholdMinutes,
      priorContext.absenceLateThresholdMinutes,
    )
    const nextMeta = {
      ...existingMeta,
      ...lateTiers,
      manual_result_edit: metaMarker,
    }
    const updated = await rows(
      input.client,
      `UPDATE attendance_records
          SET current_calculation_id = $3::uuid,
              projection_owner = 'w4',
              visibility_state = 'active',
              visibility_reason = 'active',
              status = $4,
              first_in_at = $5,
              last_out_at = $6,
              work_minutes = $7,
              late_minutes = $8,
              early_leave_minutes = $9,
              meta = $10::jsonb,
              updated_at = now()
        WHERE id = $1::uuid AND org_id = $2
          AND current_calculation_id = $11::uuid
        RETURNING id`,
      [
        recordId,
        orgId,
        calculationId,
        projection.status,
        projection.firstInAt,
        projection.lastOutAt,
        parentWork,
        parentLate,
        parentEarly,
        canonicalAttendanceJsonV1(nextMeta),
        priorCalculationId,
      ],
    )
    if (updated.length !== 1) fail(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.VERSION_CONFLICT, 409)
  }

  return Object.freeze({
    kind: 'appended',
    calculationId,
    priorCalculationId,
    projectedStatus: projection.status,
    manualOverride,
    metaMarker,
    projection: Object.freeze({
      status: projection.status,
      firstInAt: projection.firstInAt,
      lastOutAt: projection.lastOutAt,
      workMinutes: projection.workedMinutes,
      lateMinutes: projection.lateMinutes,
      earlyLeaveMinutes: projection.earlyLeaveMinutes,
    }),
  })
}

/**
 * Preserve an existing manual_override_snapshot / meta marker when an unrelated
 * writer updates the parent without statusOverride. Used by ordinary writers.
 */
export function preserveManualOverrideOnUnrelatedUpdateV1(input: {
  readonly existingMeta: Record<string, unknown> | null | undefined
  readonly statusOverride: string | null | undefined
  readonly incomingMeta: Record<string, unknown> | null | undefined
}): Record<string, unknown> {
  const base = {
    ...(input.existingMeta && typeof input.existingMeta === 'object' ? input.existingMeta : {}),
    ...(input.incomingMeta && typeof input.incomingMeta === 'object' ? input.incomingMeta : {}),
  } as Record<string, unknown>
  const incomingHas =
    input.incomingMeta != null
    && Object.prototype.hasOwnProperty.call(input.incomingMeta, 'manual_result_edit')
  if (input.statusOverride == null && base.manual_result_edit && !incomingHas) {
    return base
  }
  if (input.statusOverride != null && !incomingHas) {
    delete base.manual_result_edit
  }
  return base
}
