import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'
import type {
  AttendanceAttributionSnapshotV1,
  AttendanceEvidenceV1,
  FrozenAttendanceContextV1,
  ManualAttendanceOverrideV1,
} from '../w4c0-write-boundary-types'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceSemanticInputFingerprintV1,
} from '../w4c0-fingerprints'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
  calculateAttendanceSegmentsV1,
} from '../w4c1-segment-calculator'
import {
  ATTENDANCE_W4_AUTHORITATIVE_CALCULATION_ERROR_CODES_V1 as CODES,
  projectedDailyFingerprintV1,
  writeAuthoritativeSegmentCalculationV1,
  type WriteAuthoritativeSegmentCalculationInputV1,
} from '../w4c2-authoritative-calculation-core'
import { ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES as OVERRIDE_CODES } from '../w4c3c-manual-override'

const RECORD_ID = '10000000-0000-4000-8000-000000000001'
const PRIOR_ID = '20000000-0000-4000-8000-000000000002'
const RESULT_ID = '30000000-0000-4000-8000-000000000003'
const PHYSICAL_DAILY = {
  status: 'late',
  firstInAt: '2026-10-27T09:10:00.000Z',
  lastOutAt: '2026-10-27T17:50:00.000Z',
  workedMinutes: 520,
  lateMinutes: 10,
  earlyLeaveMinutes: 0,
}
const OVERRIDDEN_DAILY = {
  ...PHYSICAL_DAILY,
  status: 'adjusted',
  workedMinutes: 600,
  lateMinutes: 0,
  earlyLeaveMinutes: 7,
}

function manualOverride(
  operations: ManualAttendanceOverrideV1['operations'] = [
    { op: 'set', field: 'status', value: 'adjusted' },
    { op: 'set', field: 'workMinutes', value: 600 },
    { op: 'set', field: 'lateMinutes', value: 0 },
    { op: 'set', field: 'earlyLeaveMinutes', value: 7 },
  ],
): ManualAttendanceOverrideV1 {
  return {
    editId: '40000000-0000-4000-8000-000000000004',
    beforeFingerprint: 'b'.repeat(64),
    reason: 'synthetic correction',
    actorPosture: 'attendance_admin',
    operations,
  }
}

function fixture(): WriteAuthoritativeSegmentCalculationInputV1 {
  const context: FrozenAttendanceContextV1 = {
    schemaVersion: 1, selector: 'legacy', orgId: 'writer-preservation-org',
    userId: 'writer-preservation-user', workDate: '2026-10-27', timezone: 'UTC',
    shiftId: 'writer-preservation-shift', isWorkday: true, holidayKind: null,
    calculationGroupId: null, roundingMinutes: 1,
    severeLateThresholdMinutes: 45, absenceLateThresholdMinutes: 90,
    segments: [{
      index: 0, startTime: '09:00', endTime: '17:00', startDayOffset: 0, endDayOffset: 0,
      lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0,
    }],
  }
  const window = { startAt: '2026-10-27T00:00:00.000Z', endAt: '2026-10-28T00:00:00.000Z' }
  const attribution: AttendanceAttributionSnapshotV1 = {
    posture: 'resolved_v2',
    value: {
      schemaVersion: 2, resolverVersion: 'w2-resolver@3',
      orgId: context.orgId, userId: context.userId, workDate: context.workDate,
      shiftId: context.shiftId, reasonCode: 'assignment_match',
      resolvedAt: '2026-10-27T00:00:00.000Z', absoluteWindow: window,
      attributionWindow: window, attributionTailMinutes: 240,
      extendedByApprovedOvertime: false, windowEvidenceFingerprint: 'a'.repeat(64),
      source: 'request_creation',
    },
  }
  const evidence: AttendanceEvidenceV1[] = [
    { kind: 'punch', ref: 'import:in', source: 'import', direction: 'check_in', occurredAt: PHYSICAL_DAILY.firstInAt },
    { kind: 'punch', ref: 'event:out', source: 'attendance_event', direction: 'check_out', occurredAt: PHYSICAL_DAILY.lastOutAt },
  ]
  const approvedFacts: WriteAuthoritativeSegmentCalculationInputV1['approvedFacts'] = [{
    kind: 'overtime', requestId: 'writer-preservation-request',
    requestSnapshotVersion: 2, requestSnapshotFingerprint: 'c'.repeat(64),
    approvalVersion: 1, approvalRecordId: 'writer-preservation-approval',
    coverage: {
      kind: 'bounded_interval', startAt: '2026-10-27T17:00:00.000Z',
      endAt: '2026-10-27T18:00:00.000Z', minutes: 60,
    },
  }]
  return {
    orgId: context.orgId, recordId: RECORD_ID, entrypoint: 'approved_overtime',
    operationId: '50000000-0000-4000-8000-000000000005',
    attribution, context, evidence, approvedFacts,
    calculation: calculateAttendanceSegmentsV1({ attribution, context, evidence, approvedFacts }),
    provenanceRef: {
      transport: 'approved_request', sourceRef: 'writer-preservation-request',
      artifactSha256: null, normalizedCsvSha256: null, convertedSheetName: null,
    },
    payloadFingerprint: 'd'.repeat(64),
    inputProvenance: { payloadFingerprint: 'd'.repeat(64) },
    preimage: {
      posture: 'present', projectionOwner: 'w4', currentCalculationId: PRIOR_ID,
      visibilityState: 'active', visibilityReason: 'active',
      projection: {
        status: 'late', firstInAt: PHYSICAL_DAILY.firstInAt, lastOutAt: PHYSICAL_DAILY.lastOutAt,
        workMinutes: 470, lateMinutes: 10, earlyLeaveMinutes: 0,
      },
      compatibilityFingerprint: null,
    },
    expectedCurrentCalculationId: PRIOR_ID,
    actorId: 'writer-preservation-actor', correlationId: 'writer-preservation-correlation',
  }
}

// Capture the real writer's SQL parameters; do not simulate its projection or hashes.
function captureTransaction() {
  const query = vi.fn(async (
    sql: string,
    _params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes('SELECT id::text AS id, attendance_record_id')) return { rows: [] }
    if (sql.includes('SELECT current_calculation_id')) {
      return { rows: [{
        current_calculation_id: PRIOR_ID, projection_owner: 'w4',
        visibility_state: 'active', timezone: 'UTC',
      }] }
    }
    if (sql.includes('COALESCE(MAX(version)')) return { rows: [{ next: 2 }] }
    if (sql.includes('SELECT version FROM attendance_record_calculations')) return { rows: [{ version: 1 }] }
    if (/^\s*INSERT INTO attendance_record_(calculations|segments)\b/.test(sql)) return { rows: [] }
    if (/^\s*UPDATE attendance_records\b/.test(sql)) return { rows: [{ id: RECORD_ID }] }
    if (/^(SAVEPOINT|RELEASE SAVEPOINT) /.test(sql)) return { rows: [] }
    throw new Error('UNEXPECTED_WRITER_QUERY')
  })
  const paramsFor = (table: string) => query.mock.calls
    .filter(([sql]) => sql.includes(table))
    .map(([, params]) => params ?? [])
  const trx: AttendanceW4TransactionClientV1 = { query }
  return { trx, query, paramsFor }
}

function semanticFingerprint(
  input: WriteAuthoritativeSegmentCalculationInputV1,
  override: ManualAttendanceOverrideV1 | null,
  mergePolicy: 'append' | 'merge',
) {
  return computeAttendanceSemanticInputFingerprintV1({
    attribution: input.attribution, context: input.context, evidence: input.evidence,
    approvedFacts: input.approvedFacts, manualOverride: override, mergePolicy,
    calculationTier: 'segment_authoritative',
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshotSchemaVersion: 1,
  })
}

function expectedDailyColumns(daily: typeof PHYSICAL_DAILY) {
  return [
    daily.status, daily.firstInAt, daily.lastOutAt, daily.workedMinutes,
    daily.lateMinutes, daily.earlyLeaveMinutes, projectedDailyFingerprintV1(daily),
  ]
}

describe('authoritative writer input preservation (bounded SQL capture, no DB proof)', () => {
  beforeEach(() => { vi.spyOn(crypto, 'randomUUID').mockReturnValue(RESULT_ID) })
  afterEach(() => { vi.restoreAllMocks() })

  it('preserves immutable override/evidence/facts, binds their hash, and overlays only the daily projection', async () => {
    const input = { ...fixture(), manualOverride: manualOverride(), mergePolicy: 'merge' as const }
    const before = canonicalAttendanceJsonV1(input)
    const capture = captureTransaction()
    const result = await writeAuthoritativeSegmentCalculationV1(capture.trx, input)
    expect(result).toEqual({
      kind: 'completed', calculationId: RESULT_ID, version: 2,
      supersedesCalculationId: PRIOR_ID, baselineCalculationId: null,
    })
    const calculations = capture.paramsFor('INSERT INTO attendance_record_calculations')
    expect(calculations).toHaveLength(1)
    const row = calculations[0]
    expect(row[11]).toBe(semanticFingerprint(input, input.manualOverride, 'merge'))
    expect(row[11]).not.toBe(semanticFingerprint(input, null, 'merge'))
    expect(row[11]).not.toBe(semanticFingerprint(input, input.manualOverride, 'append'))
    expect(row.slice(17, 20)).toEqual([
      canonicalAttendanceJsonV1(input.evidence),
      canonicalAttendanceJsonV1(input.approvedFacts),
      canonicalAttendanceJsonV1(input.manualOverride),
    ])
    // Rehash the actual immutable stored inputs, not the in-memory overlay.
    expect(row[11]).toBe(computeAttendanceSemanticInputFingerprintV1({
      attribution: JSON.parse(row[14] as string), context: JSON.parse(row[15] as string),
      evidence: JSON.parse(row[17] as string), approvedFacts: JSON.parse(row[18] as string),
      manualOverride: JSON.parse(row[19] as string), mergePolicy: row[21],
      calculationTier: row[22], engineVersion: row[6], snapshotSchemaVersion: 1,
    }))
    expect(row.slice(21, 27)).toEqual(['merge', 'segment_authoritative', 'completed', 'calculated', 'set_active', 1])
    expect(row.slice(27, 34)).toEqual(expectedDailyColumns(OVERRIDDEN_DAILY))
    expect(row[33]).not.toBe(projectedDailyFingerprintV1(PHYSICAL_DAILY))
    expect(capture.paramsFor('UPDATE attendance_records')).toEqual([[
      RECORD_ID, input.orgId, RESULT_ID, 'adjusted', PHYSICAL_DAILY.firstInAt,
      PHYSICAL_DAILY.lastOutAt, 600, 0, 7, PRIOR_ID, 'w4',
    ]])
    expect(capture.paramsFor('INSERT INTO attendance_record_segments')).toEqual([[
      input.orgId, RECORD_ID, RESULT_ID, 0,
      '2026-10-27T09:00:00.000Z', '2026-10-27T17:00:00.000Z',
      PHYSICAL_DAILY.firstInAt, PHYSICAL_DAILY.lastOutAt, 520, 10, 0, 'late',
      JSON.stringify(['approved_overtime_overlay', 'late_check_in']),
      JSON.stringify(['import:in', 'event:out']), '[]',
    ]])
    expect(canonicalAttendanceJsonV1(input)).toBe(before)
  })

  it.each(['completed', 'review_required'] as const)(
    'omitted fields retain exactly the explicit null/append SQL and hash for %s',
    async (outcome) => {
      const base = fixture()
      const input: WriteAuthoritativeSegmentCalculationInputV1 = outcome === 'review_required'
        ? { ...base, calculation: {
            outcome, outcomeReasonCode: 'ambiguous_segment_match', segments: [], dailyProjection: null,
          } }
        : base
      const omitted = captureTransaction()
      const explicit = captureTransaction()
      await writeAuthoritativeSegmentCalculationV1(omitted.trx, input)
      await writeAuthoritativeSegmentCalculationV1(explicit.trx, {
        ...input, manualOverride: null, mergePolicy: 'append',
      })
      expect(omitted.query.mock.calls).toEqual(explicit.query.mock.calls)
      const row = omitted.paramsFor('INSERT INTO attendance_record_calculations')[0]
      expect(row[19]).toBeNull()
      expect(row[21]).toBe('append')
      expect(row[11]).toBe(semanticFingerprint(input, null, 'append'))
      expect(row.slice(27, 34)).toEqual(outcome === 'completed'
        ? expectedDailyColumns(PHYSICAL_DAILY)
        : [null, null, null, null, null, null, null])
    },
  )

  it('binds a supplied merge policy independently of an override without changing physical output', async () => {
    const input = { ...fixture(), mergePolicy: 'merge' as const }
    const capture = captureTransaction()
    await writeAuthoritativeSegmentCalculationV1(capture.trx, input)
    const row = capture.paramsFor('INSERT INTO attendance_record_calculations')[0]
    expect(row[19]).toBeNull()
    expect(row[21]).toBe('merge')
    expect(row[11]).toBe(semanticFingerprint(input, null, 'merge'))
    expect(row[11]).not.toBe(semanticFingerprint(input, null, 'append'))
    expect(row.slice(27, 34)).toEqual(expectedDailyColumns(PHYSICAL_DAILY))
  })

  it('retains review inputs and hash with zero children, null projected fields and no pointer update', async () => {
    const input: WriteAuthoritativeSegmentCalculationInputV1 = {
      ...fixture(), manualOverride: manualOverride(), mergePolicy: 'merge',
      calculation: {
        outcome: 'review_required', outcomeReasonCode: 'ambiguous_segment_match',
        segments: [], dailyProjection: null,
      },
    }
    const capture = captureTransaction()
    expect(await writeAuthoritativeSegmentCalculationV1(capture.trx, input)).toEqual({
      kind: 'review', calculationId: RESULT_ID, version: 2,
    })
    const rows = capture.paramsFor('INSERT INTO attendance_record_calculations')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.slice(7, 9)).toEqual([null, null])
    expect(row[11]).toBe(semanticFingerprint(input, input.manualOverride ?? null, 'merge'))
    expect(row[11]).not.toBe(semanticFingerprint(input, null, 'merge'))
    expect(row.slice(16, 20)).toEqual([
      '[]', canonicalAttendanceJsonV1(input.evidence),
      canonicalAttendanceJsonV1(input.approvedFacts), canonicalAttendanceJsonV1(input.manualOverride),
    ])
    expect(row.slice(21, 34)).toEqual([
      'merge', 'segment_authoritative', 'review_required', 'ambiguous_segment_match', 'none', 0,
      null, null, null, null, null, null, null,
    ])
    expect(capture.paramsFor('INSERT INTO attendance_record_segments')).toEqual([])
    expect(capture.paramsFor('UPDATE attendance_records')).toEqual([])
  })

  it('uses recompute unset fallback while preserving the exact unset snapshot and append default', async () => {
    const override = manualOverride([
      { op: 'set', field: 'status', value: 'adjusted' },
      { op: 'unset', field: 'workMinutes', value: null },
      { op: 'unset', field: 'lateMinutes', value: null },
      { op: 'unset', field: 'earlyLeaveMinutes', value: null },
    ])
    const input = { ...fixture(), manualOverride: override }
    const capture = captureTransaction()
    await writeAuthoritativeSegmentCalculationV1(capture.trx, input)
    const row = capture.paramsFor('INSERT INTO attendance_record_calculations')[0]
    expect(row[19]).toBe(canonicalAttendanceJsonV1(override))
    expect(row[21]).toBe('append')
    expect(row[11]).toBe(semanticFingerprint(input, override, 'append'))
    expect(row.slice(27, 34)).toEqual(expectedDailyColumns({ ...PHYSICAL_DAILY, status: 'adjusted' }))
  })

  it.each(['override', 'retire', '', null])('rejects invalid internal merge policy %s before SQL', async (policy) => {
    const capture = captureTransaction()
    await expect(writeAuthoritativeSegmentCalculationV1(capture.trx, {
      ...fixture(), mergePolicy: policy as unknown as 'merge',
    })).rejects.toMatchObject({ code: CODES.MERGE_POLICY_INVALID, httpStatus: 422 })
    expect(capture.query).not.toHaveBeenCalled()
  })

  it.each([
    { operations: [], code: OVERRIDE_CODES.INPUT_INVALID },
    { operations: [{ op: 'set', field: 'firstInAt', value: '2026-10-27T08:00:00.000Z' }], code: OVERRIDE_CODES.FIELD_UNKNOWN },
    { operations: [{ op: 'set', field: 'status', value: 'invented' }], code: OVERRIDE_CODES.INPUT_INVALID },
    { operations: [{ op: 'set', field: 'workMinutes', value: -1 }], code: OVERRIDE_CODES.INPUT_INVALID },
    { operations: [{ op: 'unset', field: 'lateMinutes', value: 0 }], code: OVERRIDE_CODES.UNSET_VALUE_NOT_NULL },
    { operations: [{ op: 'set', field: 'workMinutes', value: Number.MAX_SAFE_INTEGER + 1 }], code: CODES.COMPLETED_SHAPE_INVALID },
  ])('rejects invalid override operations before result DML: $code', async ({ operations, code }) => {
    const capture = captureTransaction()
    await expect(writeAuthoritativeSegmentCalculationV1(capture.trx, {
      ...fixture(), manualOverride: manualOverride(operations as ManualAttendanceOverrideV1['operations']),
    })).rejects.toMatchObject({ code, httpStatus: 422 })
    expect(capture.query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))).toEqual([])
  })

  it('does not allow an override to mask an invalid physical projection', async () => {
    const base = fixture()
    const input = {
      ...base,
      calculation: {
        ...base.calculation,
        dailyProjection: { ...base.calculation.dailyProjection!, workedMinutes: -1 },
      },
    }
    const capture = captureTransaction()
    await expect(writeAuthoritativeSegmentCalculationV1(capture.trx, {
      ...input, manualOverride: manualOverride(),
    })).rejects.toMatchObject({ code: CODES.COMPLETED_SHAPE_INVALID, httpStatus: 422 })
    expect(capture.query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))).toEqual([])
  })
})
