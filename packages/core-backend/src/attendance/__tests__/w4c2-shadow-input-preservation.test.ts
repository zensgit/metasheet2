import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'
import type {
  AttendanceAttributionSnapshotV1, AttendanceEvidenceV1,
  FrozenAttendanceContextV1, ManualAttendanceOverrideV1,
} from '../w4c0-write-boundary-types'
import {
  canonicalAttendanceJsonV1, computeAttendanceSemanticInputFingerprintV1,
} from '../w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from '../w4c1-fingerprints'
import {
  ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, calculateAttendanceSegmentsV1,
} from '../w4c1-segment-calculator'
import {
  insertShadowCalculationV1, type ShadowCalculationRowInputV1,
} from '../w4c2-shadow-calculation-core'

const RECORD_ID = '10000000-0000-4000-8000-000000000001'
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

function fixture(): ShadowCalculationRowInputV1 {
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
  const approvedFacts: ShadowCalculationRowInputV1['approvedFacts'] = [{
    kind: 'overtime', requestId: 'writer-preservation-request',
    requestSnapshotVersion: 2, requestSnapshotFingerprint: 'c'.repeat(64),
    approvalVersion: 1, approvalRecordId: 'writer-preservation-approval',
    coverage: {
      kind: 'bounded_interval', startAt: '2026-10-27T17:00:00.000Z',
      endAt: '2026-10-27T18:00:00.000Z', minutes: 60,
    },
  }]
  const calculation = calculateAttendanceSegmentsV1({ attribution, context, evidence, approvedFacts })
  return {
    orgId: context.orgId, recordId: RECORD_ID, version: 2, entrypoint: 'approved_overtime',
    operationId: '50000000-0000-4000-8000-000000000005',
    attribution, context, evidence, approvedFacts,
    segmentSnapshot: context.segments,
    outcome: calculation.outcome, outcomeReasonCode: calculation.outcomeReasonCode,
    segments: calculation.segments, dailyProjection: calculation.dailyProjection,
    provenanceRef: {
      transport: 'approved_request', sourceRef: 'writer-preservation-request',
      artifactSha256: null, normalizedCsvSha256: null, convertedSheetName: null,
    },
    inputProvenance: { payloadFingerprint: 'd'.repeat(64) },
    mergePolicy: 'append',
    legacyProjection: {
      workDate: context.workDate, status: 'late', firstInAt: PHYSICAL_DAILY.firstInAt,
      lastOutAt: PHYSICAL_DAILY.lastOutAt, workMinutes: 470, lateMinutes: 10, earlyLeaveMinutes: 0,
    },
    actorId: 'writer-preservation-actor', correlationId: 'writer-preservation-correlation',
  }
}

// This fake captures the actual writer's SQL; it never calculates an expected result.
function captureTransaction() {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (!/^\s*INSERT INTO attendance_record_(calculations|segments)\b/.test(sql)) {
      throw new Error('UNEXPECTED_SHADOW_SQL')
    }
    return { rows: [] as Array<Record<string, unknown>> }
  })
  const trx: AttendanceW4TransactionClientV1 = { query }
  const rows = (table: string) => query.mock.calls.filter(([sql]) => sql.includes(table)).map(([, p]) => p ?? [])
  return { trx, query, rows }
}

function fingerprint(input: ShadowCalculationRowInputV1, override: ManualAttendanceOverrideV1 | null, policy = 'append') {
  return computeAttendanceSemanticInputFingerprintV1({
    attribution: input.attribution, context: input.context, evidence: input.evidence,
    approvedFacts: input.approvedFacts, manualOverride: override, mergePolicy: policy,
    calculationTier: 'legacy_shadow',
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshotSchemaVersion: 1,
  })
}

describe('shared shadow writer input preservation (SQL capture, not native DB proof)', () => {
  beforeEach(() => { vi.spyOn(crypto, 'randomUUID').mockReturnValue(RESULT_ID) })
  afterEach(() => { vi.restoreAllMocks() })

  it.each(['completed', 'review_required'] as const)('omitted override matches explicit null with append for %s', async (outcome) => {
    const base = fixture()
    const input = outcome === 'completed' ? base : {
      ...base, outcome, outcomeReasonCode: 'context_mismatch', segments: [], dailyProjection: null,
    }
    const omitted = captureTransaction()
    const explicit = captureTransaction()
    await insertShadowCalculationV1(omitted.trx, input)
    await insertShadowCalculationV1(explicit.trx, { ...input, manualOverride: null })
    expect(omitted.query.mock.calls).toEqual(explicit.query.mock.calls)
    const row = omitted.rows('INSERT INTO attendance_record_calculations')[0]
    expect(row[7]).toBe(fingerprint(input, null))
    expect(row[9]).toBe(computeAttendanceSourceDefinitionFingerprintV1({ attribution: input.attribution, context: input.context }))
    expect(row[30]).toBeNull()
    expect(row[16]).toBe('append')
    expect(omitted.query.mock.calls.every(([sql]) => !/\b(?:UPDATE|DELETE)\b/.test(sql))).toBe(true)
  })

  it('stores the exact override and merge hash, overlays daily values, and preserves physical children', async () => {
    const base = fixture()
    const input = { ...base, manualOverride: manualOverride(), mergePolicy: 'merge' as const }
    const before = canonicalAttendanceJsonV1(input)
    const capture = captureTransaction()
    const plain = captureTransaction()
    await insertShadowCalculationV1(plain.trx, base)
    const result = await insertShadowCalculationV1(capture.trx, input)
    const row = capture.rows('INSERT INTO attendance_record_calculations')[0]
    expect(result.calculationId).toBe(RESULT_ID)
    expect(result.semanticFingerprint).toBe(fingerprint(input, input.manualOverride, 'merge'))
    expect(row[7]).toBe(result.semanticFingerprint)
    expect(row[7]).not.toBe(fingerprint(input, null, 'merge'))
    expect(row[7]).not.toBe(fingerprint(input, input.manualOverride))
    expect(row[30]).toBe(canonicalAttendanceJsonV1(input.manualOverride))
    expect(row.slice(13, 15)).toEqual([JSON.stringify(input.evidence), canonicalAttendanceJsonV1(input.approvedFacts)])
    expect(row.slice(16, 20)).toEqual(['merge', 'completed', 'calculated', 1])
    expect(row.slice(20, 26)).toEqual([
      OVERRIDDEN_DAILY.status, OVERRIDDEN_DAILY.firstInAt, OVERRIDDEN_DAILY.lastOutAt,
      OVERRIDDEN_DAILY.workedMinutes, OVERRIDDEN_DAILY.lateMinutes, OVERRIDDEN_DAILY.earlyLeaveMinutes,
    ])
    expect(capture.rows('INSERT INTO attendance_record_segments')).toEqual(plain.rows('INSERT INTO attendance_record_segments'))
    expect(capture.rows('INSERT INTO attendance_record_segments')).toHaveLength(1)
    expect(canonicalAttendanceJsonV1(input)).toBe(before)
    expect(capture.query.mock.calls.every(([sql]) => !/\b(?:UPDATE|DELETE)\b/.test(sql))).toBe(true)
  })

  it('keeps review inputs but creates zero children and six null projected fields', async () => {
    const input: ShadowCalculationRowInputV1 = {
      ...fixture(), manualOverride: manualOverride(), mergePolicy: 'merge',
      outcome: 'review_required', outcomeReasonCode: 'context_mismatch', segments: [], dailyProjection: null,
    }
    const capture = captureTransaction()
    await insertShadowCalculationV1(capture.trx, input)
    const row = capture.rows('INSERT INTO attendance_record_calculations')[0]
    expect(row[7]).toBe(fingerprint(input, input.manualOverride ?? null, 'merge'))
    expect(row[9]).toBe(computeAttendanceSourceDefinitionFingerprintV1({ attribution: input.attribution, context: input.context }))
    expect(row[30]).toBe(canonicalAttendanceJsonV1(input.manualOverride))
    expect(row.slice(16, 26)).toEqual(['merge', 'review_required', 'context_mismatch', 0, null, null, null, null, null, null])
    expect(capture.rows('INSERT INTO attendance_record_segments')).toEqual([])
    expect(capture.query).toHaveBeenCalledTimes(1)
  })

  it('retains unsupported-source null fingerprint and never promotes review to completed', async () => {
    const input: ShadowCalculationRowInputV1 = {
      ...fixture(), attribution: { posture: 'unsupported', sourceSchemaVersion: 1, reason: 'legacy_v1', sourceFingerprint: null },
      context: null, segmentSnapshot: [], outcome: 'review_required',
      outcomeReasonCode: 'attribution_unsupported', segments: [], dailyProjection: null,
    }
    const capture = captureTransaction()
    await insertShadowCalculationV1(capture.trx, input)
    const row = capture.rows('INSERT INTO attendance_record_calculations')[0]
    expect(row[9]).toBeNull()
    expect(row[11]).toBeNull()
    expect(row.slice(17, 26)).toEqual(['review_required', 'attribution_unsupported', 0, null, null, null, null, null, null])
    expect(capture.query).toHaveBeenCalledTimes(1)
  })

  it('uses physical values for unset overrides, matching authoritative/recompute semantics', async () => {
    const input = {
      ...fixture(), manualOverride: manualOverride([
        { op: 'set', field: 'status', value: 'adjusted' },
        { op: 'unset', field: 'workMinutes', value: null },
        { op: 'unset', field: 'lateMinutes', value: null },
        { op: 'unset', field: 'earlyLeaveMinutes', value: null },
      ]),
    }
    const capture = captureTransaction()
    await insertShadowCalculationV1(capture.trx, input)
    const row = capture.rows('INSERT INTO attendance_record_calculations')[0]
    expect(row[30]).toBe(canonicalAttendanceJsonV1(input.manualOverride))
    expect(row.slice(20, 26)).toEqual([
      'adjusted', PHYSICAL_DAILY.firstInAt, PHYSICAL_DAILY.lastOutAt,
      PHYSICAL_DAILY.workedMinutes, PHYSICAL_DAILY.lateMinutes, PHYSICAL_DAILY.earlyLeaveMinutes,
    ])
  })

  it.each([null, '', undefined])('rejects missing approved-overtime operation id %s before SQL', async (operationId) => {
    const capture = captureTransaction()
    await expect(insertShadowCalculationV1(capture.trx, {
      ...fixture(), operationId: operationId as string | null,
    })).rejects.toMatchObject({ code: 'W4C2_SHADOW_OPERATION_ID_REQUIRED', httpStatus: 422 })
    expect(capture.query).not.toHaveBeenCalled()
  })

  it.each(['override', 'retire', '', null])('refuses illegal merge policy %s before SQL', async (policy) => {
    const capture = captureTransaction()
    await expect(insertShadowCalculationV1(capture.trx, { ...fixture(), mergePolicy: policy as unknown as 'merge' })).rejects.toMatchObject({ code: 'W4C2_SHADOW_MERGE_POLICY_INVALID', httpStatus: 422 })
    expect(capture.query).not.toHaveBeenCalled()
  })

  it.each(['completed', 'review_required'] as const)('rejects invalid manual override before SQL for %s', async (outcome) => {
    const input: ShadowCalculationRowInputV1 = {
      ...fixture(), manualOverride: manualOverride([]), outcome,
      ...(outcome === 'review_required' ? { outcomeReasonCode: 'context_mismatch', segments: [], dailyProjection: null } : {}),
    }
    const capture = captureTransaction()
    await expect(insertShadowCalculationV1(capture.trx, input)).rejects.toMatchObject({ httpStatus: 422 })
    expect(capture.query).not.toHaveBeenCalled()
  })
})
