import type { QueryResult, QueryResultRow } from 'pg'
import {
  deriveAttendanceLateTierFieldsV1,
  validateFrozenContextShape,
} from '../attendance/w4c1-segment-calculator'
import type { FrozenAttendanceContextV1 } from '../attendance/w4c0-write-boundary-types'

export const ATTENDANCE_W4_SHADOW_DIFF_CODES = [
  'equal',
  'expected_break_exclusion',
  'status_changed',
  'work_minutes_mismatch',
  'late_minutes_mismatch',
  'early_leave_minutes_mismatch',
  'missing_boundary_mismatch',
  'work_date_mismatch',
  'context_mismatch',
  'input_mismatch',
  'review_required',
  'legacy_uncomparable',
] as const

export type AttendanceW4ShadowDiffCode = (typeof ATTENDANCE_W4_SHADOW_DIFF_CODES)[number]

const CRITICAL_SHADOW_DIFF_CODES = new Set<AttendanceW4ShadowDiffCode>([
  'work_date_mismatch',
  'context_mismatch',
  'input_mismatch',
  'review_required',
])

export const ATTENDANCE_W4_SHADOW_DIFF_LABELS: Readonly<Record<AttendanceW4ShadowDiffCode, string>> =
  Object.freeze({
    equal: 'No difference',
    expected_break_exclusion: 'Expected break handling difference',
    status_changed: 'Status differs',
    work_minutes_mismatch: 'Work minutes differ',
    late_minutes_mismatch: 'Late minutes differ',
    early_leave_minutes_mismatch: 'Early leave minutes differ',
    missing_boundary_mismatch: 'Punch boundary differs',
    work_date_mismatch: 'Work date differs',
    context_mismatch: 'Frozen context differs',
    input_mismatch: 'Input differs',
    review_required: 'Manual review required',
    legacy_uncomparable: 'Legacy result is not comparable',
  })

const CALCULATION_KINDS = ['legacy_baseline', 'calculation', 'reversal'] as const
const CALCULATION_MODES = ['shadow', 'authoritative'] as const
const CALCULATION_ENTRYPOINTS = [
  'live',
  'legacy_import',
  'integration_sync',
  'correction',
  'approved_leave',
  'approved_overtime',
  'outdoor_approval',
  'manual_override',
  'recompute',
  'scheduled',
  'approval_reversal',
  'import_rollback',
  'ops_retirement',
] as const
const CALCULATION_OUTCOMES = ['baseline', 'completed', 'review_required', 'reversed'] as const
const CALCULATION_OUTCOME_REASONS = [
  'calculated',
  'shadow_only',
  'legacy_projection_baseline',
  'ambiguous_segment_match',
  'duplicate_check_in',
  'duplicate_check_out',
  'dst_gap_local_time',
  'dst_fold_shared_boundary_ambiguous',
  'invalid_timezone',
  'invalid_segment_order',
  'invalid_evidence_order',
  'overlapping_actual_intervals',
  'evidence_outside_attribution_window',
  'missing_frozen_context',
  'legacy_attribution_not_upgradeable',
  'frozen_evidence_unavailable',
  'context_resolution_ambiguous',
  'context_mismatch',
  'input_schema_invalid',
  'legacy_time_ingress_not_authoritative',
  'approved_fact_conflict',
  'manual_override_invalid',
  'import_metric_conflict',
  'import_rollback_reversal',
  'operator_retirement',
] as const
const PROJECTION_EFFECTS = ['none', 'set_active', 'set_retired'] as const
const PROJECTION_OWNERS = ['legacy_untracked', 'w4'] as const
const VISIBILITY_STATES = ['active', 'retired'] as const
const VISIBILITY_REASONS = ['active', 'review_placeholder', 'import_rollback', 'operator_retirement'] as const
const DAILY_STATUSES = ['normal', 'late', 'early_leave', 'late_early', 'partial', 'absent', 'adjusted', 'off'] as const
const ROLLOUT_STATES = ['legacy', 'shadow', 'eligible', 'authoritative', 'suspended'] as const
const SEGMENT_STATUSES = [
  'normal',
  'late',
  'early_leave',
  'late_early',
  'missing_check_in',
  'missing_check_out',
  'missing_both',
] as const
const SEGMENT_REASONS = [
  'within_window',
  'late_check_in',
  'early_check_out',
  'missing_check_in',
  'missing_check_out',
  'missing_both',
  'approved_correction_applied',
  'approved_leave_overlay',
  'approved_overtime_overlay',
  'dst_fold_start_earlier',
  'dst_fold_end_later',
] as const
const SHADOW_DIFF_CHANGED_FIELDS = [
  'workDate',
  'status',
  'firstInAt',
  'lastOutAt',
  'workMinutes',
  'lateMinutes',
  'earlyLeaveMinutes',
  'context',
  'input',
] as const

type CalculationMode = (typeof CALCULATION_MODES)[number]

export class AttendanceCalculationSchemaUnsupportedError extends Error {
  readonly code = 'CALCULATION_SCHEMA_UNSUPPORTED'

  constructor() {
    super('CALCULATION_SCHEMA_UNSUPPORTED')
    this.name = 'AttendanceCalculationSchemaUnsupportedError'
  }
}

function unsupported(): never {
  throw new AttendanceCalculationSchemaUnsupportedError()
}

function isClosedValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function asNonNegativeInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) unsupported()
  return parsed
}

function asPositiveInteger(value: unknown): number {
  const parsed = asNonNegativeInteger(value)
  if (parsed < 1) unsupported()
  return parsed
}

function asIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) unsupported()
  return new Date(value).toISOString()
}

function asNullableIsoString(value: unknown): string | null {
  return value === null || value === undefined ? null : asIsoString(value)
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsupported()
  return value as Record<string, unknown>
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort()
  const expected = [...keys].sort()
  return own.length === expected.length && own.every((key, index) => key === expected[index])
}

function asAtMostThree(value: unknown): number {
  const parsed = asNonNegativeInteger(value)
  if (parsed > 3) unsupported()
  return parsed
}

function asNullableNonNegativeInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : asNonNegativeInteger(value)
}

function parseDailyStatus(value: unknown): (typeof DAILY_STATUSES)[number] | null {
  if (value === null) return null
  if (!isClosedValue(DAILY_STATUSES, value)) unsupported()
  return value
}

function isOutcomeReasonPair(
  outcome: (typeof CALCULATION_OUTCOMES)[number],
  reason: (typeof CALCULATION_OUTCOME_REASONS)[number],
): boolean {
  if (outcome === 'baseline') return reason === 'legacy_projection_baseline'
  if (outcome === 'completed') return reason === 'calculated' || reason === 'shadow_only'
  if (outcome === 'reversed') return reason === 'import_rollback_reversal' || reason === 'operator_retirement'
  return ![
    'calculated',
    'shadow_only',
    'legacy_projection_baseline',
    'import_rollback_reversal',
    'operator_retirement',
  ].includes(reason)
}

export interface AttendanceW4ComparableDailyProjection {
  readonly workDate?: string | null
  readonly status: string | null
  readonly firstInAt: string | Date | null
  readonly lastOutAt: string | Date | null
  readonly workMinutes: number | null
  readonly lateMinutes: number | null
  readonly earlyLeaveMinutes: number | null
}

export interface AttendanceW4ShadowDiff {
  readonly schemaVersion: 1
  readonly code: AttendanceW4ShadowDiffCode
  readonly changedFields: readonly string[]
  readonly absoluteMinuteDelta: number
  readonly segmentCount: number
}

export interface AttendanceW4ShadowComparisonInput {
  readonly legacy: AttendanceW4ComparableDailyProjection | null
  readonly calculated: AttendanceW4ComparableDailyProjection | null
  readonly segmentCount: number
  readonly outcome: 'completed' | 'review_required'
  readonly workDateMismatch?: boolean
  readonly contextMismatch?: boolean
  readonly inputMismatch?: boolean
  readonly expectedBreakExclusion?: boolean
}

function instantKey(value: string | Date | null): string | null {
  if (value === null) return null
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value)
}

export function computeAttendanceW4ShadowDiff(input: AttendanceW4ShadowComparisonInput): AttendanceW4ShadowDiff {
  const segmentCount = asNonNegativeInteger(input.segmentCount)
  if (segmentCount > 3) unsupported()

  if (input.workDateMismatch) {
    return Object.freeze({ schemaVersion: 1, code: 'work_date_mismatch', changedFields: ['workDate'], absoluteMinuteDelta: 0, segmentCount })
  }
  if (input.contextMismatch) {
    return Object.freeze({ schemaVersion: 1, code: 'context_mismatch', changedFields: ['context'], absoluteMinuteDelta: 0, segmentCount })
  }
  if (input.inputMismatch) {
    return Object.freeze({ schemaVersion: 1, code: 'input_mismatch', changedFields: ['input'], absoluteMinuteDelta: 0, segmentCount })
  }
  if (input.outcome === 'review_required') {
    return Object.freeze({ schemaVersion: 1, code: 'review_required', changedFields: [], absoluteMinuteDelta: 0, segmentCount })
  }
  if (!input.legacy || !input.calculated) {
    return Object.freeze({ schemaVersion: 1, code: 'legacy_uncomparable', changedFields: [], absoluteMinuteDelta: 0, segmentCount })
  }

  const changedFields: string[] = []
  if ((input.legacy.workDate ?? null) !== (input.calculated.workDate ?? null)) changedFields.push('workDate')
  if (input.legacy.status !== input.calculated.status) changedFields.push('status')
  if (instantKey(input.legacy.firstInAt) !== instantKey(input.calculated.firstInAt)) changedFields.push('firstInAt')
  if (instantKey(input.legacy.lastOutAt) !== instantKey(input.calculated.lastOutAt)) changedFields.push('lastOutAt')
  if (input.legacy.workMinutes !== input.calculated.workMinutes) changedFields.push('workMinutes')
  if (input.legacy.lateMinutes !== input.calculated.lateMinutes) changedFields.push('lateMinutes')
  if (input.legacy.earlyLeaveMinutes !== input.calculated.earlyLeaveMinutes) changedFields.push('earlyLeaveMinutes')

  const absoluteMinuteDelta =
    Math.abs((input.legacy.workMinutes ?? 0) - (input.calculated.workMinutes ?? 0))
    + Math.abs((input.legacy.lateMinutes ?? 0) - (input.calculated.lateMinutes ?? 0))
    + Math.abs((input.legacy.earlyLeaveMinutes ?? 0) - (input.calculated.earlyLeaveMinutes ?? 0))

  let code: AttendanceW4ShadowDiffCode = 'equal'
  if (changedFields.includes('workDate')) code = 'work_date_mismatch'
  else if (changedFields.includes('firstInAt') || changedFields.includes('lastOutAt')) code = 'missing_boundary_mismatch'
  else if (input.expectedBreakExclusion && changedFields.length > 0) code = 'expected_break_exclusion'
  else if (changedFields.includes('status')) code = 'status_changed'
  else if (changedFields.includes('workMinutes')) code = 'work_minutes_mismatch'
  else if (changedFields.includes('lateMinutes')) code = 'late_minutes_mismatch'
  else if (changedFields.includes('earlyLeaveMinutes')) code = 'early_leave_minutes_mismatch'

  return Object.freeze({
    schemaVersion: 1,
    code,
    changedFields: Object.freeze(changedFields),
    absoluteMinuteDelta,
    segmentCount,
  })
}

export function parseAttendanceW4ShadowDiff(code: unknown, value: unknown): AttendanceW4ShadowDiff {
  if (!isClosedValue(ATTENDANCE_W4_SHADOW_DIFF_CODES, code)) unsupported()
  const record = asJsonRecord(value)
  if (!hasExactKeys(record, ['schemaVersion', 'code', 'changedFields', 'absoluteMinuteDelta', 'segmentCount'])) unsupported()
  if (record.schemaVersion !== 1 || record.code !== code) unsupported()
  if (!Array.isArray(record.changedFields)) unsupported()
  const changedFields = record.changedFields
  if (!changedFields.every((field) => isClosedValue(SHADOW_DIFF_CHANGED_FIELDS, field))) unsupported()
  if (new Set(changedFields).size !== changedFields.length) unsupported()
  const canonical = [...changedFields].sort(
    (left, right) => SHADOW_DIFF_CHANGED_FIELDS.indexOf(left) - SHADOW_DIFF_CHANGED_FIELDS.indexOf(right),
  )
  if (canonical.some((field, index) => field !== changedFields[index])) unsupported()
  if ((code === 'equal' || code === 'review_required' || code === 'legacy_uncomparable') && changedFields.length !== 0) unsupported()
  if (code === 'work_date_mismatch' && !changedFields.includes('workDate')) unsupported()
  if (code === 'context_mismatch' && (changedFields.length !== 1 || changedFields[0] !== 'context')) unsupported()
  if (code === 'input_mismatch' && (changedFields.length !== 1 || changedFields[0] !== 'input')) unsupported()
  if (code === 'status_changed' && !changedFields.includes('status')) unsupported()
  if (code === 'work_minutes_mismatch' && !changedFields.includes('workMinutes')) unsupported()
  if (code === 'late_minutes_mismatch' && !changedFields.includes('lateMinutes')) unsupported()
  if (code === 'early_leave_minutes_mismatch' && !changedFields.includes('earlyLeaveMinutes')) unsupported()
  if (code === 'missing_boundary_mismatch' && !changedFields.some((field) => field === 'firstInAt' || field === 'lastOutAt')) unsupported()
  if (code === 'expected_break_exclusion' && changedFields.length === 0) unsupported()
  return Object.freeze({
    schemaVersion: 1,
    code,
    changedFields: Object.freeze([...changedFields]),
    absoluteMinuteDelta: asNonNegativeInteger(record.absoluteMinuteDelta),
    segmentCount: asAtMostThree(record.segmentCount),
  })
}

export type AttendanceW4CalculationQuery = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<QueryResult<T>>

interface RecordRow extends QueryResultRow {
  id: string
  current_calculation_id: string | null
  current_mode: string | null
  projection_owner: string
  visibility_state: string
  visibility_reason: string
}

interface CalculationRow extends QueryResultRow {
  id: string
  version: number
  calculation_kind: string
  mode: string
  entrypoint: string
  engine_version: string
  snapshot_schema_version: number
  outcome: string
  outcome_reason_code: string
  projection_effect: string
  expected_segment_count: number
  projected_status: string | null
  projected_work_minutes: number | null
  projected_late_minutes: number | null
  projected_early_leave_minutes: number | null
  shadow_diff_code: string | null
  shadow_diff: unknown
  created_at: string
}

interface SegmentRow extends QueryResultRow {
  segment_index: number
  expected_start_at: string
  expected_end_at: string
  actual_in_at: string | null
  actual_out_at: string | null
  work_minutes: number
  late_minutes: number
  early_leave_minutes: number
  status: string
  status_reasons: unknown
}

export const ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND = Symbol('ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND')

export interface AttendanceCalculationDetailResponse {
  readonly recordId: string
  readonly calculation: null | {
    readonly id: string
    readonly version: number
    readonly kind: string
    readonly mode: CalculationMode
    readonly entrypoint: string
    readonly engineVersion: string
    readonly snapshotSchemaVersion: 1
    readonly outcome: string
    readonly outcomeReasonCode: string
    readonly projectionEffect: string
    readonly expectedSegmentCount: number
    readonly projectedStatus: string | null
    readonly projectedWorkMinutes: number | null
    readonly projectedLateMinutes: number | null
    readonly projectedEarlyLeaveMinutes: number | null
    readonly shadowDiff: AttendanceW4ShadowDiff | null
    readonly createdAt: string
  }
  readonly segments: readonly {
    readonly index: number
    readonly expectedStartAt: string
    readonly expectedEndAt: string
    readonly actualInAt: string | null
    readonly actualOutAt: string | null
    readonly workMinutes: number
    readonly lateMinutes: number
    readonly earlyLeaveMinutes: number
    readonly status: string
    readonly statusReasons: readonly string[]
  }[]
  readonly current: {
    readonly projectionOwner: string
    readonly visibilityState: string
    readonly visibilityReason: string
    readonly posture: CalculationMode | 'undeterminable'
  }
}

function parseRecord(row: RecordRow): AttendanceCalculationDetailResponse['current'] {
  if (!isClosedValue(PROJECTION_OWNERS, row.projection_owner)) unsupported()
  if (!isClosedValue(VISIBILITY_STATES, row.visibility_state)) unsupported()
  if (!isClosedValue(VISIBILITY_REASONS, row.visibility_reason)) unsupported()
  if (row.current_mode !== null && !isClosedValue(CALCULATION_MODES, row.current_mode)) unsupported()
  return {
    projectionOwner: row.projection_owner,
    visibilityState: row.visibility_state,
    visibilityReason: row.visibility_reason,
    posture: row.current_mode === null ? 'undeterminable' : row.current_mode as CalculationMode,
  }
}

function parseCalculation(row: CalculationRow): NonNullable<AttendanceCalculationDetailResponse['calculation']> {
  if (Number(row.snapshot_schema_version) !== 1) unsupported()
  if (!isClosedValue(CALCULATION_KINDS, row.calculation_kind)) unsupported()
  if (!isClosedValue(CALCULATION_MODES, row.mode)) unsupported()
  if (!isClosedValue(CALCULATION_ENTRYPOINTS, row.entrypoint)) unsupported()
  if (!isClosedValue(CALCULATION_OUTCOMES, row.outcome)) unsupported()
  if (!isClosedValue(CALCULATION_OUTCOME_REASONS, row.outcome_reason_code)) unsupported()
  if (!isOutcomeReasonPair(row.outcome, row.outcome_reason_code)) unsupported()
  if (!isClosedValue(PROJECTION_EFFECTS, row.projection_effect)) unsupported()
  const shadowDiff = row.shadow_diff_code === null && row.shadow_diff === null
    ? null
    : parseAttendanceW4ShadowDiff(row.shadow_diff_code, row.shadow_diff)
  const expectedSegmentCount = asAtMostThree(row.expected_segment_count)
  const projectedStatus = parseDailyStatus(row.projected_status)
  const projectedWorkMinutes = asNullableNonNegativeInteger(row.projected_work_minutes)
  const projectedLateMinutes = asNullableNonNegativeInteger(row.projected_late_minutes)
  const projectedEarlyLeaveMinutes = asNullableNonNegativeInteger(row.projected_early_leave_minutes)
  if (row.outcome === 'completed') {
    if (expectedSegmentCount < 1 || projectedStatus === null || projectedWorkMinutes === null
      || projectedLateMinutes === null || projectedEarlyLeaveMinutes === null) unsupported()
  } else if (expectedSegmentCount !== 0) unsupported()
  if (row.outcome === 'review_required' && (projectedStatus !== null || projectedWorkMinutes !== null
    || projectedLateMinutes !== null || projectedEarlyLeaveMinutes !== null)) unsupported()
  return {
    id: row.id,
    version: asPositiveInteger(row.version),
    kind: row.calculation_kind,
    mode: row.mode,
    entrypoint: row.entrypoint,
    engineVersion: row.engine_version,
    snapshotSchemaVersion: 1,
    outcome: row.outcome,
    outcomeReasonCode: row.outcome_reason_code,
    projectionEffect: row.projection_effect,
    expectedSegmentCount,
    projectedStatus,
    projectedWorkMinutes,
    projectedLateMinutes,
    projectedEarlyLeaveMinutes,
    shadowDiff,
    createdAt: asIsoString(row.created_at),
  }
}

function parseSegment(row: SegmentRow): AttendanceCalculationDetailResponse['segments'][number] {
  if (!isClosedValue(SEGMENT_STATUSES, row.status)) unsupported()
  if (!Array.isArray(row.status_reasons) || row.status_reasons.length === 0) unsupported()
  if (!row.status_reasons.every((reason) => isClosedValue(SEGMENT_REASONS, reason))) unsupported()
  if (new Set(row.status_reasons).size !== row.status_reasons.length) unsupported()
  const canonicalReasons = [...row.status_reasons].sort()
  if (canonicalReasons.some((reason, index) => reason !== row.status_reasons[index])) unsupported()
  return {
    index: asNonNegativeInteger(row.segment_index),
    expectedStartAt: asIsoString(row.expected_start_at),
    expectedEndAt: asIsoString(row.expected_end_at),
    actualInAt: asNullableIsoString(row.actual_in_at),
    actualOutAt: asNullableIsoString(row.actual_out_at),
    workMinutes: asNonNegativeInteger(row.work_minutes),
    lateMinutes: asNonNegativeInteger(row.late_minutes),
    earlyLeaveMinutes: asNonNegativeInteger(row.early_leave_minutes),
    status: row.status,
    statusReasons: Object.freeze([...row.status_reasons]),
  }
}

export async function readAttendanceCalculationDetail(
  input: { readonly orgId: string; readonly recordId: string; readonly subjectUserId?: string; readonly calculationId?: string },
  runQuery: AttendanceW4CalculationQuery,
): Promise<AttendanceCalculationDetailResponse | typeof ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND> {
  const params: unknown[] = [input.recordId, input.orgId]
  const subjectPredicate = input.subjectUserId ? ' AND r.user_id = $3' : ''
  if (input.subjectUserId) params.push(input.subjectUserId)
  const recordResult = await runQuery<RecordRow>(
    `SELECT r.id::text AS id, r.current_calculation_id::text AS current_calculation_id,
            current_calculation.mode AS current_mode, r.projection_owner,
            r.visibility_state, r.visibility_reason
       FROM attendance_records r
       LEFT JOIN attendance_record_calculations current_calculation
         ON current_calculation.id = r.current_calculation_id
        AND current_calculation.attendance_record_id = r.id
        AND current_calculation.org_id = r.org_id
      WHERE r.id = $1::uuid AND r.org_id = $2${subjectPredicate}
      LIMIT 1`,
    params,
  )
  const record = recordResult.rows[0]
  if (!record) return ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND
  const current = parseRecord(record)
  const calculationId = input.calculationId ?? record.current_calculation_id
  if (!calculationId) {
    return { recordId: record.id, calculation: null, segments: [], current }
  }

  const calculationResult = await runQuery<CalculationRow>(
    `SELECT calculation.id::text AS id, calculation.version, calculation.calculation_kind,
            calculation.mode, calculation.entrypoint, calculation.engine_version,
            calculation.snapshot_schema_version, calculation.outcome,
            calculation.outcome_reason_code, calculation.projection_effect,
            calculation.expected_segment_count, calculation.projected_status,
            calculation.projected_work_minutes, calculation.projected_late_minutes,
            calculation.projected_early_leave_minutes, calculation.shadow_diff_code,
            calculation.shadow_diff, calculation.created_at
       FROM attendance_record_calculations calculation
       JOIN attendance_records owner
         ON owner.id = calculation.attendance_record_id
        AND owner.org_id = calculation.org_id
        ${input.subjectUserId ? 'AND owner.user_id = $4' : ''}
      WHERE calculation.id = $1::uuid
        AND calculation.attendance_record_id = $2::uuid
        AND calculation.org_id = $3
      LIMIT 1`,
    [calculationId, input.recordId, input.orgId, ...(input.subjectUserId ? [input.subjectUserId] : [])],
  )
  const calculationRow = calculationResult.rows[0]
  if (!calculationRow) return ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND
  const calculation = parseCalculation(calculationRow)
  const segmentResult = await runQuery<SegmentRow>(
    `SELECT segment.segment_index, segment.expected_start_at, segment.expected_end_at,
            segment.actual_in_at, segment.actual_out_at, segment.work_minutes,
            segment.late_minutes, segment.early_leave_minutes, segment.status,
            segment.status_reasons
       FROM attendance_record_segments segment
       JOIN attendance_records owner
         ON owner.id = segment.record_id
        AND owner.org_id = segment.org_id
        ${input.subjectUserId ? 'AND owner.user_id = $4' : ''}
      WHERE segment.calculation_id = $1::uuid
        AND segment.record_id = $2::uuid
        AND segment.org_id = $3
      ORDER BY segment.segment_index ASC`,
    [calculationId, input.recordId, input.orgId, ...(input.subjectUserId ? [input.subjectUserId] : [])],
  )
  if (segmentResult.rows.length > 3) unsupported()
  const segments = Object.freeze(segmentResult.rows.map(parseSegment))
  if (segments.length !== calculation.expectedSegmentCount) unsupported()
  if (segments.some((segment, index) => segment.index !== index)) unsupported()
  return { recordId: record.id, calculation, segments, current }
}

interface BacklogRow extends QueryResultRow {
  entrypoint: string
  shadow_diff_code: string
  item_count: number
}

export interface AttendanceW4ShadowBacklogItem {
  readonly entrypoint: string
  readonly code: AttendanceW4ShadowDiffCode
  readonly label: string
  readonly critical: boolean
  readonly count: number
}

export async function readAttendanceW4ShadowBacklog(
  orgId: string,
  limit: number,
  runQuery: AttendanceW4CalculationQuery,
): Promise<readonly AttendanceW4ShadowBacklogItem[]> {
  const boundedLimit = Math.min(Math.max(asNonNegativeInteger(limit), 1), 200)
  const result = await runQuery<BacklogRow>(
    `SELECT entrypoint, shadow_diff_code, count(*)::int AS item_count
       FROM attendance_record_calculations
      WHERE org_id = $1 AND mode = 'shadow'
        AND shadow_diff_code IS NOT NULL AND shadow_diff_code <> 'equal'
      GROUP BY entrypoint, shadow_diff_code
      ORDER BY entrypoint ASC, shadow_diff_code ASC
      LIMIT $2`,
    [orgId, boundedLimit],
  )
  return Object.freeze(result.rows.map((row) => {
    if (!isClosedValue(CALCULATION_ENTRYPOINTS, row.entrypoint)) unsupported()
    if (!isClosedValue(ATTENDANCE_W4_SHADOW_DIFF_CODES, row.shadow_diff_code)) unsupported()
    return Object.freeze({
      entrypoint: row.entrypoint,
      code: row.shadow_diff_code,
      label: ATTENDANCE_W4_SHADOW_DIFF_LABELS[row.shadow_diff_code],
      critical: CRITICAL_SHADOW_DIFF_CODES.has(row.shadow_diff_code),
      count: asNonNegativeInteger(row.item_count),
    })
  }))
}

export interface AttendanceW4TraceProjection {
  readonly status: (typeof DAILY_STATUSES)[number]
  readonly isWorkday: boolean
  readonly workMinutes: number
  readonly lateMinutes: number
  readonly earlyLeaveMinutes: number
  readonly severeLateCount: number
  readonly severeLateMinutes: number
  readonly absenceLateCount: number
  readonly segments: AttendanceCalculationDetailResponse['segments']
}

export interface AttendanceW4TraceEvidence {
  readonly mode: CalculationMode
  readonly outcome: (typeof CALCULATION_OUTCOMES)[number]
  readonly outcomeReasonCode: (typeof CALCULATION_OUTCOME_REASONS)[number]
  readonly snapshotSchemaVersion: 1
  readonly createdAt: string
  readonly projection: AttendanceW4TraceProjection | null
}

interface TraceCalculationRow extends QueryResultRow {
  calculation_id: string
  attendance_record_id: string
  mode: string
  outcome: string
  outcome_reason_code: string
  snapshot_schema_version: number
  expected_segment_count: number
  projected_status: string | null
  projected_work_minutes: number | null
  projected_late_minutes: number | null
  projected_early_leave_minutes: number | null
  context_snapshot: unknown
  created_at: string
}

async function readAuthoritativeTraceCalculation(
  orgId: string,
  userId: string,
  workDate: string,
  runQuery: AttendanceW4CalculationQuery,
): Promise<TraceCalculationRow | null> {
  const result = await runQuery<TraceCalculationRow>(
    `SELECT calculation.id::text AS calculation_id,
            record.id::text AS attendance_record_id, calculation.mode,
            calculation.outcome, calculation.outcome_reason_code,
            calculation.snapshot_schema_version, calculation.expected_segment_count,
            calculation.projected_status, calculation.projected_work_minutes,
            calculation.projected_late_minutes, calculation.projected_early_leave_minutes,
            calculation.context_snapshot, calculation.created_at
       FROM attendance_records record
       JOIN attendance_record_calculations calculation
         ON calculation.id = record.current_calculation_id
        AND calculation.attendance_record_id = record.id
        AND calculation.org_id = record.org_id
        AND calculation.mode = 'authoritative'
      WHERE record.org_id = $1 AND record.user_id = $2 AND record.work_date = $3
        AND record.visibility_state = 'active'
      LIMIT 1`,
    [orgId, userId, workDate],
  )
  return result.rows[0] ?? null
}

async function readShadowTraceCalculation(
  orgId: string,
  userId: string,
  workDate: string,
  runQuery: AttendanceW4CalculationQuery,
): Promise<TraceCalculationRow | null> {
  const result = await runQuery<TraceCalculationRow>(
    `SELECT calculation.id::text AS calculation_id,
            record.id::text AS attendance_record_id, calculation.mode,
            calculation.outcome, calculation.outcome_reason_code,
            calculation.snapshot_schema_version, calculation.expected_segment_count,
            calculation.projected_status, calculation.projected_work_minutes,
            calculation.projected_late_minutes, calculation.projected_early_leave_minutes,
            calculation.context_snapshot, calculation.created_at
       FROM attendance_records record
       JOIN attendance_record_calculations calculation
         ON calculation.attendance_record_id = record.id
        AND calculation.org_id = record.org_id
        AND calculation.mode = 'shadow'
      WHERE record.org_id = $1 AND record.user_id = $2 AND record.work_date = $3
        AND record.visibility_state = 'active'
      ORDER BY calculation.version DESC
      LIMIT 1`,
    [orgId, userId, workDate],
  )
  return result.rows[0] ?? null
}

async function readTraceSegments(
  row: TraceCalculationRow,
  orgId: string,
  userId: string,
  runQuery: AttendanceW4CalculationQuery,
): Promise<AttendanceCalculationDetailResponse['segments']> {
  const result = await runQuery<SegmentRow>(
    `SELECT segment.segment_index, segment.expected_start_at, segment.expected_end_at,
            segment.actual_in_at, segment.actual_out_at, segment.work_minutes,
            segment.late_minutes, segment.early_leave_minutes, segment.status,
            segment.status_reasons
       FROM attendance_record_segments segment
       JOIN attendance_records owner
         ON owner.id = segment.record_id
        AND owner.org_id = segment.org_id
        AND owner.user_id = $3
      WHERE segment.calculation_id = $1::uuid
        AND segment.record_id = $2::uuid
        AND segment.org_id = $4
      ORDER BY segment.segment_index ASC`,
    [row.calculation_id, row.attendance_record_id, userId, orgId],
  )
  if (result.rows.length > 3) unsupported()
  const segments = Object.freeze(result.rows.map(parseSegment))
  if (segments.some((segment, index) => segment.index !== index)) unsupported()
  return segments
}

function parseTraceProjection(
  row: TraceCalculationRow,
  segments: AttendanceCalculationDetailResponse['segments'],
): AttendanceW4TraceProjection | null {
  const expectedSegmentCount = asAtMostThree(row.expected_segment_count)
  if (row.outcome !== 'completed') {
    if (expectedSegmentCount !== 0 || row.projected_status !== null
      || row.projected_work_minutes !== null || row.projected_late_minutes !== null
      || row.projected_early_leave_minutes !== null) unsupported()
    return null
  }
  if (expectedSegmentCount < 1 || segments.length !== expectedSegmentCount) unsupported()
  if (!validateFrozenContextShape(row.context_snapshot)) unsupported()
  const context = row.context_snapshot as FrozenAttendanceContextV1
  const status = parseDailyStatus(row.projected_status)
  if (status === null) unsupported()
  const workMinutes = asNullableNonNegativeInteger(row.projected_work_minutes)
  const lateMinutes = asNullableNonNegativeInteger(row.projected_late_minutes)
  const earlyLeaveMinutes = asNullableNonNegativeInteger(row.projected_early_leave_minutes)
  if (workMinutes === null || lateMinutes === null || earlyLeaveMinutes === null) unsupported()
  const tiers = deriveAttendanceLateTierFieldsV1(
    lateMinutes,
    context.severeLateThresholdMinutes,
    context.absenceLateThresholdMinutes,
  )
  return Object.freeze({
    status,
    isWorkday: context.isWorkday,
    workMinutes,
    lateMinutes,
    earlyLeaveMinutes,
    severeLateCount: tiers.severe_late_count,
    severeLateMinutes: tiers.severe_late_minutes,
    absenceLateCount: tiers.absence_late_count,
    segments,
  })
}

export async function readAttendanceW4TraceEvidence(
  orgId: string,
  userId: string,
  workDate: string,
  runQuery: AttendanceW4CalculationQuery,
): Promise<{
  readonly rolloutState: (typeof ROLLOUT_STATES)[number] | null
  readonly priorRolloutState: (typeof ROLLOUT_STATES)[number] | null
  readonly evidence: AttendanceW4TraceEvidence | null
}> {
  const rollout = await runQuery<{ state: string; prior_state: string | null }>(
    `SELECT state, prior_state FROM attendance_calculation_rollout_state WHERE org_id = $1 LIMIT 1`,
    [orgId],
  )
  const rolloutRow = rollout.rows[0]
  if (rolloutRow && !isClosedValue(ROLLOUT_STATES, rolloutRow.state)) unsupported()
  if (rolloutRow?.prior_state !== null && rolloutRow?.prior_state !== undefined
    && !isClosedValue(ROLLOUT_STATES, rolloutRow.prior_state)) unsupported()
  const rolloutState = rolloutRow
    ? rolloutRow.state as (typeof ROLLOUT_STATES)[number]
    : null
  const priorRolloutState = rolloutRow?.prior_state
    ? rolloutRow.prior_state as (typeof ROLLOUT_STATES)[number]
    : null
  const authoritative = rolloutState === 'authoritative'
    || (rolloutState === 'suspended' && priorRolloutState === 'authoritative')
  const shadow = rolloutState === 'shadow' || rolloutState === 'eligible'
    || (rolloutState === 'suspended' && (priorRolloutState === 'shadow' || priorRolloutState === 'eligible'))
  if (!authoritative && !shadow) return { rolloutState, priorRolloutState, evidence: null }
  const row = authoritative
    ? await readAuthoritativeTraceCalculation(orgId, userId, workDate, runQuery)
    : await readShadowTraceCalculation(orgId, userId, workDate, runQuery)
  if (!row) return { rolloutState, priorRolloutState, evidence: null }
  if (Number(row.snapshot_schema_version) !== 1) unsupported()
  if (!isClosedValue(CALCULATION_MODES, row.mode)) unsupported()
  if (!isClosedValue(CALCULATION_OUTCOMES, row.outcome)) unsupported()
  if (!isClosedValue(CALCULATION_OUTCOME_REASONS, row.outcome_reason_code)) unsupported()
  if (!isOutcomeReasonPair(row.outcome, row.outcome_reason_code)) unsupported()
  const expectedSegmentCount = asAtMostThree(row.expected_segment_count)
  const segments = await readTraceSegments(row, orgId, userId, runQuery)
  if (segments.length !== expectedSegmentCount) unsupported()
  return {
    rolloutState,
    priorRolloutState,
    evidence: {
      mode: row.mode,
      outcome: row.outcome,
      outcomeReasonCode: row.outcome_reason_code,
      snapshotSchemaVersion: 1,
      createdAt: asIsoString(row.created_at),
      projection: parseTraceProjection(row, segments),
    },
  }
}
