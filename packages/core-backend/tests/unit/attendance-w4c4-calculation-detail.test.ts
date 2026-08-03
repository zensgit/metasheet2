import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  AttendanceCalculationSchemaUnsupportedError,
  computeAttendanceW4ShadowDiff,
  parseAttendanceW4ShadowDiff,
  readAttendanceCalculationDetail,
  readAttendanceW4ShadowBacklog,
  type AttendanceW4CalculationQuery,
} from '../../src/services/AttendanceW4CalculationDetail'
import {
  buildLateEarlyTrace,
  buildMissingPunchTrace,
  buildTodayStatusTrace,
  type AttendanceDecisionTraceQueryFn,
} from '../../src/services/AttendanceDecisionTrace'

const RECORD_ID = '10000000-0000-4000-8000-000000000001'
const CALCULATION_ID = '20000000-0000-4000-8000-000000000001'
const ORG_ID = 'org-w4c4'
const USER_ID = 'user-w4c4'
const WORK_DATE = '2026-08-03'

const frozenContext = {
  schemaVersion: 1,
  selector: 'legacy',
  orgId: ORG_ID,
  userId: USER_ID,
  workDate: WORK_DATE,
  timezone: 'Asia/Taipei',
  shiftId: 'shift-internal-not-surfaced',
  isWorkday: true,
  holidayKind: null,
  calculationGroupId: null,
  roundingMinutes: 1,
  severeLateThresholdMinutes: 30,
  absenceLateThresholdMinutes: 60,
  segments: [{
    index: 0,
    startTime: '09:00',
    endTime: '18:00',
    startDayOffset: 0,
    endDayOffset: 0,
    lateGraceMinutes: 5,
    earlyLeaveGraceMinutes: 5,
  }],
}

const detailRecord = {
  id: RECORD_ID,
  current_calculation_id: CALCULATION_ID,
  current_mode: 'authoritative',
  projection_owner: 'w4',
  visibility_state: 'active',
  visibility_reason: 'active',
}

const detailCalculation = {
  id: CALCULATION_ID,
  version: 2,
  calculation_kind: 'calculation',
  mode: 'authoritative',
  entrypoint: 'live',
  engine_version: 'attendance-segment-v1',
  snapshot_schema_version: 1,
  outcome: 'completed',
  outcome_reason_code: 'calculated',
  projection_effect: 'set_active',
  expected_segment_count: 1,
  projected_status: 'partial',
  projected_work_minutes: 420,
  projected_late_minutes: 35,
  projected_early_leave_minutes: 0,
  shadow_diff_code: null,
  shadow_diff: null,
  created_at: '2026-08-03T10:00:00.000Z',
}

const detailSegment = {
  segment_index: 0,
  expected_start_at: '2026-08-03T01:00:00.000Z',
  expected_end_at: '2026-08-03T10:00:00.000Z',
  actual_in_at: '2026-08-03T01:35:00.000Z',
  actual_out_at: null,
  work_minutes: 420,
  late_minutes: 35,
  early_leave_minutes: 0,
  status: 'missing_check_out',
  status_reasons: ['missing_check_out'],
}

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length } as QueryResult<T>
}

describe('W4C-4 shadow comparator and strict persisted parser', () => {
  it('keeps work-date/context/input critical codes reachable before review_required', () => {
    const base = {
      legacy: null,
      calculated: null,
      segmentCount: 0,
      outcome: 'review_required' as const,
    }
    expect(computeAttendanceW4ShadowDiff({ ...base, workDateMismatch: true }).code).toBe('work_date_mismatch')
    expect(computeAttendanceW4ShadowDiff({ ...base, contextMismatch: true }).code).toBe('context_mismatch')
    expect(computeAttendanceW4ShadowDiff({ ...base, inputMismatch: true }).code).toBe('input_mismatch')
    expect(computeAttendanceW4ShadowDiff(base).code).toBe('review_required')
  })

  it.each([
    ['equal', {}, 'equal'],
    ['expected break', { calculated: { workMinutes: 420 }, expectedBreakExclusion: true }, 'expected_break_exclusion'],
    ['status', { calculated: { status: 'late' } }, 'status_changed'],
    ['work minutes', { calculated: { workMinutes: 420 } }, 'work_minutes_mismatch'],
    ['late minutes', { calculated: { lateMinutes: 6 } }, 'late_minutes_mismatch'],
    ['early-leave minutes', { calculated: { earlyLeaveMinutes: 7 } }, 'early_leave_minutes_mismatch'],
    ['punch boundary', { calculated: { firstInAt: '2026-08-03T01:01:00.000Z' } }, 'missing_boundary_mismatch'],
  ])('derives the %s non-critical comparator code', (_label, mutation, expectedCode) => {
    const baseline = {
      workDate: WORK_DATE,
      status: 'normal',
      firstInAt: '2026-08-03T01:00:00.000Z',
      lastOutAt: '2026-08-03T10:00:00.000Z',
      workMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
    }
    const calculated = { ...baseline, ...mutation.calculated }
    expect(computeAttendanceW4ShadowDiff({
      legacy: baseline,
      calculated,
      segmentCount: 1,
      outcome: 'completed',
      expectedBreakExclusion: mutation.expectedBreakExclusion,
    }).code).toBe(expectedCode)
  })

  it('derives legacy_uncomparable only when completed projections cannot be compared', () => {
    expect(computeAttendanceW4ShadowDiff({
      legacy: null,
      calculated: null,
      segmentCount: 0,
      outcome: 'completed',
    }).code).toBe('legacy_uncomparable')
  })

  it('derives work-date mismatch from distinct real projections rather than a copied legacy date', () => {
    const projection = {
      status: 'normal', firstInAt: null, lastOutAt: null,
      workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0,
    }
    const diff = computeAttendanceW4ShadowDiff({
      legacy: { ...projection, workDate: '2026-08-02' },
      calculated: { ...projection, workDate: '2026-08-03' },
      segmentCount: 1,
      outcome: 'completed',
    })
    expect(diff.code).toBe('work_date_mismatch')
    expect(diff.changedFields).toEqual(['workDate'])
  })

  it.each([
    ['unknown field', { schemaVersion: 1, code: 'status_changed', changedFields: ['rawUserId'], absoluteMinuteDelta: 0, segmentCount: 1 }],
    ['duplicate field', { schemaVersion: 1, code: 'status_changed', changedFields: ['status', 'status'], absoluteMinuteDelta: 0, segmentCount: 1 }],
    ['non-canonical field order', { schemaVersion: 1, code: 'status_changed', changedFields: ['workMinutes', 'status'], absoluteMinuteDelta: 1, segmentCount: 1 }],
    ['too many segments', { schemaVersion: 1, code: 'status_changed', changedFields: ['status'], absoluteMinuteDelta: 0, segmentCount: 4 }],
  ])('rejects %s in persisted shadow diff', (_label, value) => {
    expect(() => parseAttendanceW4ShadowDiff('status_changed', value)).toThrow(AttendanceCalculationSchemaUnsupportedError)
  })
})

describe('W4C-4 calculation detail SQL scope and enum/schema fail-closed parsing', () => {
  it('retains record+org+subject on every self-host detail query', async () => {
    const calls: string[] = []
    const query = (async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
      calls.push(sql)
      if (/FROM attendance_record_segments segment/.test(sql)) return result([detailSegment]) as unknown as QueryResult<T>
      if (/FROM attendance_record_calculations calculation/.test(sql)) return result([detailCalculation]) as unknown as QueryResult<T>
      return result([detailRecord]) as unknown as QueryResult<T>
    }) as AttendanceW4CalculationQuery
    const response = await readAttendanceCalculationDetail(
      { orgId: ORG_ID, recordId: RECORD_ID, subjectUserId: USER_ID },
      query,
    )
    expect(typeof response).toBe('object')
    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatch(/r\.id = \$1::uuid AND r\.org_id = \$2 AND r\.user_id = \$3/)
    expect(calls[1]).toMatch(/owner\.user_id = \$4/)
    expect(calls[1]).toMatch(/calculation\.attendance_record_id = \$2::uuid/)
    expect(calls[1]).toMatch(/calculation\.org_id = \$3/)
    expect(calls[2]).toMatch(/owner\.user_id = \$4/)
    expect(calls[2]).toMatch(/segment\.record_id = \$2::uuid/)
    expect(calls[2]).toMatch(/segment\.org_id = \$3/)
  })

  it('retains record+org on every admin detail query', async () => {
    const calls: string[] = []
    const query = (async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
      calls.push(sql)
      if (/FROM attendance_record_segments segment/.test(sql)) return result([detailSegment]) as unknown as QueryResult<T>
      if (/FROM attendance_record_calculations calculation/.test(sql)) return result([detailCalculation]) as unknown as QueryResult<T>
      return result([detailRecord]) as unknown as QueryResult<T>
    }) as AttendanceW4CalculationQuery
    await readAttendanceCalculationDetail({ orgId: ORG_ID, recordId: RECORD_ID }, query)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatch(/r\.id = \$1::uuid AND r\.org_id = \$2/)
    expect(calls[1]).toMatch(/calculation\.attendance_record_id = \$2::uuid/)
    expect(calls[1]).toMatch(/calculation\.org_id = \$3/)
    expect(calls[2]).toMatch(/segment\.record_id = \$2::uuid/)
    expect(calls[2]).toMatch(/segment\.org_id = \$3/)
  })

  it.each([
    ['invalid persisted version', { version: 0 }],
    ['unknown calculation kind', { calculation_kind: 'future_kind' }],
    ['unknown calculation mode', { mode: 'future_mode' }],
    ['unknown entrypoint', { entrypoint: 'future_entrypoint' }],
    ['unknown outcome', { outcome: 'future_outcome' }],
    ['unknown outcome reason', { outcome_reason_code: 'future_reason' }],
    ['unknown projection effect', { projection_effect: 'future_effect' }],
    ['unknown projected status', { projected_status: 'future_status' }],
    ['expected segment count above three', { expected_segment_count: 4 }],
  ])('rejects %s instead of echoing persisted strings', async (_label, mutation) => {
    const query = (async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
      if (/FROM attendance_record_segments segment/.test(sql)) return result([detailSegment]) as unknown as QueryResult<T>
      if (/FROM attendance_record_calculations calculation/.test(sql)) {
        return result([{ ...detailCalculation, ...mutation }]) as unknown as QueryResult<T>
      }
      return result([detailRecord]) as unknown as QueryResult<T>
    }) as AttendanceW4CalculationQuery
    await expect(readAttendanceCalculationDetail({ orgId: ORG_ID, recordId: RECORD_ID }, query))
      .rejects.toBeInstanceOf(AttendanceCalculationSchemaUnsupportedError)
  })

  it.each([
    ['projection owner', { projection_owner: 'future_owner' }],
    ['visibility state', { visibility_state: 'future_visibility' }],
    ['visibility reason', { visibility_reason: 'future_reason' }],
    ['current mode', { current_mode: 'future_mode' }],
  ])('rejects unknown persisted record %s', async (_label, mutation) => {
    const query = (async <T extends QueryResultRow = QueryResultRow>() =>
      result([{ ...detailRecord, ...mutation }]) as unknown as QueryResult<T>) as AttendanceW4CalculationQuery
    await expect(readAttendanceCalculationDetail({ orgId: ORG_ID, recordId: RECORD_ID }, query))
      .rejects.toBeInstanceOf(AttendanceCalculationSchemaUnsupportedError)
  })

  it.each([
    ['segment status', { status: 'future_status' }],
    ['segment reason', { status_reasons: ['future_reason'] }],
    ['duplicate segment reason', { status_reasons: ['missing_check_out', 'missing_check_out'] }],
  ])('rejects unknown or non-canonical persisted %s', async (_label, mutation) => {
    const query = (async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
      if (/FROM attendance_record_segments segment/.test(sql)) {
        return result([{ ...detailSegment, ...mutation }]) as unknown as QueryResult<T>
      }
      if (/FROM attendance_record_calculations calculation/.test(sql)) return result([detailCalculation]) as unknown as QueryResult<T>
      return result([detailRecord]) as unknown as QueryResult<T>
    }) as AttendanceW4CalculationQuery
    await expect(readAttendanceCalculationDetail({ orgId: ORG_ID, recordId: RECORD_ID }, query))
      .rejects.toBeInstanceOf(AttendanceCalculationSchemaUnsupportedError)
  })

  it('returns only values-free aggregate backlog fields', async () => {
    const query = (async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
      expect(sql).toMatch(/GROUP BY entrypoint, shadow_diff_code/)
      return result([{ entrypoint: 'live', shadow_diff_code: 'context_mismatch', item_count: 3 }]) as unknown as QueryResult<T>
    }) as AttendanceW4CalculationQuery
    const backlog = await readAttendanceW4ShadowBacklog(ORG_ID, 50, query)
    expect(backlog).toEqual([{
      entrypoint: 'live',
      code: 'context_mismatch',
      label: 'Frozen context differs',
      critical: true,
      count: 3,
    }])
    expect(JSON.stringify(backlog)).not.toMatch(/user|punch|request|shift|group|recordId|calculationId/i)
  })
})

function makeAuthoritativeTraceQuery(
  overrides: Partial<typeof detailCalculation & { context_snapshot: unknown }> = {},
): AttendanceDecisionTraceQueryFn {
  return (async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
    if (/attendance_calculation_rollout_state/.test(sql)) {
      return result([{ state: 'authoritative', prior_state: 'eligible' }]) as unknown as QueryResult<T>
    }
    if (/FROM attendance_current_records/.test(sql)) {
      throw new Error('mutable attendance record must not be read for an authoritative W4 trace')
    }
    if (/FROM attendance_record_segments segment/.test(sql)) {
      return result(overrides.expected_segment_count === 0 ? [] : [detailSegment]) as unknown as QueryResult<T>
    }
    if (/JOIN attendance_record_calculations calculation/.test(sql)) {
      return result([{
        attendance_record_id: RECORD_ID,
        mode: 'authoritative',
        outcome: 'completed',
        outcome_reason_code: 'calculated',
        snapshot_schema_version: 1,
        expected_segment_count: 1,
        projected_status: 'partial',
        projected_work_minutes: 420,
        projected_late_minutes: 35,
        projected_early_leave_minutes: 0,
        context_snapshot: frozenContext,
        created_at: '2026-08-03T10:00:00.000Z',
        ...overrides,
      }]) as unknown as QueryResult<T>
    }
    return result([]) as unknown as QueryResult<T>
  }) as AttendanceDecisionTraceQueryFn
}

describe('W4C-4 DecisionTrace immutable authoritative evidence', () => {
  it('builds today/late/missing conclusions only from frozen projection/context/segments', async () => {
    const today = await buildTodayStatusTrace(ORG_ID, USER_ID, WORK_DATE, makeAuthoritativeTraceQuery())
    expect(today.conclusion).toEqual({
      workDate: WORK_DATE,
      status: 'partial',
      isWorkday: true,
      workMinutes: 420,
      lateMinutes: 35,
      earlyLeaveMinutes: 0,
    })
    expect(today.confidence).toBe('grounded')

    const late = await buildLateEarlyTrace(ORG_ID, USER_ID, WORK_DATE, makeAuthoritativeTraceQuery())
    expect(late.conclusion).toEqual({
      lateMinutes: 35,
      earlyLeaveMinutes: 0,
      severeLateCount: 1,
      severeLateMinutes: 35,
      absenceLateCount: 0,
      status: 'partial',
    })

    const missing = await buildMissingPunchTrace(ORG_ID, USER_ID, WORK_DATE, makeAuthoritativeTraceQuery())
    expect(missing.reasonCode).toBe('partial_missing_check_out')
    expect(missing.conclusion).toEqual({
      missingSide: 'check_out',
      isWorkday: true,
      suggestedRequestType: 'missed_check_out',
    })
  })

  it('returns exact values-free frozen_evidence_unavailable for authoritative review evidence', async () => {
    const query = makeAuthoritativeTraceQuery({
      outcome: 'review_required',
      outcome_reason_code: 'frozen_evidence_unavailable',
      expected_segment_count: 0,
      projected_status: null,
      projected_work_minutes: null,
      projected_late_minutes: null,
      projected_early_leave_minutes: null,
      context_snapshot: null,
    })
    const trace = await buildTodayStatusTrace(ORG_ID, USER_ID, WORK_DATE, query)
    expect(trace.confidence).toBe('undeterminable')
    expect(trace.conclusion).toEqual({
      workDate: WORK_DATE,
      status: null,
      isWorkday: null,
      workMinutes: null,
      lateMinutes: null,
      earlyLeaveMinutes: null,
    })
    expect(Object.prototype.hasOwnProperty.call(trace, 'reasonCode')).toBe(false)
    expect(trace.basis).toEqual([{
      source: { kind: 'snapshot', ref: 'frozen_evidence_unavailable' },
      version: { posture: 'undeterminable' },
    }])
  })

  it('maps unsupported W4 schema to a values-free undeterminable trace but still propagates query errors', async () => {
    const unsupportedTrace = await buildTodayStatusTrace(
      ORG_ID,
      USER_ID,
      WORK_DATE,
      makeAuthoritativeTraceQuery({ snapshot_schema_version: 2 }),
    )
    expect(unsupportedTrace).toEqual({
      category: 'today_status',
      conclusion: {
        workDate: WORK_DATE,
        status: null,
        isWorkday: null,
        workMinutes: null,
        lateMinutes: null,
        earlyLeaveMinutes: null,
      },
      basis: [{
        source: { kind: 'snapshot', ref: 'frozen_evidence_unavailable' },
        version: { posture: 'undeterminable' },
      }],
      confidence: 'undeterminable',
    })
    for (const buildTrace of [buildLateEarlyTrace, buildMissingPunchTrace]) {
      const trace = await buildTrace(
        ORG_ID,
        USER_ID,
        WORK_DATE,
        makeAuthoritativeTraceQuery({ snapshot_schema_version: 2 }),
      )
      expect(trace.confidence).toBe('undeterminable')
      expect(Object.prototype.hasOwnProperty.call(trace, 'reasonCode')).toBe(false)
      expect(trace.basis).toEqual([{
        source: { kind: 'snapshot', ref: 'frozen_evidence_unavailable' },
        version: { posture: 'undeterminable' },
      }])
    }

    const shadowQuery = (async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
      if (/attendance_calculation_rollout_state/.test(sql)) {
        return result([{ state: 'shadow', prior_state: 'legacy' }]) as unknown as QueryResult<T>
      }
      throw new Error('query failed')
    }) as AttendanceDecisionTraceQueryFn
    await expect(buildTodayStatusTrace(ORG_ID, USER_ID, WORK_DATE, shadowQuery)).rejects.toThrow('query failed')
  })

  it('maps an unknown persisted rollout state to a values-free undeterminable trace', async () => {
    const query = (async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
      expect(sql).toMatch(/attendance_calculation_rollout_state/)
      return result([{ state: 'future_state', prior_state: null }]) as unknown as QueryResult<T>
    }) as AttendanceDecisionTraceQueryFn
    const trace = await buildTodayStatusTrace(ORG_ID, USER_ID, WORK_DATE, query)
    expect(trace.basis).toEqual([{
      source: { kind: 'snapshot', ref: 'frozen_evidence_unavailable' },
      version: { posture: 'undeterminable' },
    }])
    expect(trace.confidence).toBe('undeterminable')
    expect(trace.conclusion.status).toBeNull()
  })
})
