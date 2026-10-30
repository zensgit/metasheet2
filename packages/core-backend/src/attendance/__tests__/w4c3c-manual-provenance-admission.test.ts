import { describe, expect, it } from 'vitest'
import { appendManualOverrideCalculationV1 } from '../w4c3c-manual-edit-apply'
import { computeAttendanceProvenanceFingerprintV1 } from '../w4c0-fingerprints'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'

const orgId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const recordId = '33333333-3333-4333-8333-333333333333'
const priorId = '44444444-4444-4444-8444-444444444444'
const operationId = '55555555-5555-4555-8555-555555555555'
const shiftId = '66666666-6666-4666-8666-666666666666'
const ref = {
  transport: 'live_event', sourceRef: 'synthetic-manual-provenance',
  artifactSha256: null, normalizedCsvSha256: null, convertedSheetName: null,
}
const expectedFingerprint = computeAttendanceProvenanceFingerprintV1(ref)

function admission(inputProvenance: Record<string, unknown>, fingerprint = expectedFingerprint) {
  const context = {
    schemaVersion: 1, selector: 'legacy', orgId, userId, workDate: '2026-07-01', timezone: 'UTC',
    shiftId, isWorkday: true, holidayKind: null, calculationGroupId: null, roundingMinutes: 15,
    severeLateThresholdMinutes: 45, absenceLateThresholdMinutes: 90,
    segments: [{ index: 0, startTime: '09:00', endTime: '17:00', startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 5, earlyLeaveGraceMinutes: 5 }],
  }
  const prior = {
    id: priorId, version: 1, outcome: 'completed', expected_segment_count: 1,
    attribution_snapshot: {
      posture: 'resolved_v2', value: {
        schemaVersion: 2, resolverVersion: 'w2-resolver@3', orgId, userId, workDate: '2026-07-01',
        shiftId, reasonCode: 'assignment_match', resolvedAt: '2026-07-01T09:00:00.000Z',
        absoluteWindow: { startAt: '2026-07-01T00:00:00.000Z', endAt: '2026-07-02T00:00:00.000Z' },
        attributionWindow: { startAt: '2026-07-01T00:00:00.000Z', endAt: '2026-07-02T00:00:00.000Z' },
        attributionTailMinutes: 0, extendedByApprovedOvertime: false,
        windowEvidenceFingerprint: 'a'.repeat(64), source: 'live_resolution',
      },
    },
    context_snapshot: context, segment_snapshot: context.segments, evidence_snapshot: [],
    approved_facts_snapshot: [], manual_override_snapshot: null,
    projected_status: 'partial', projected_first_in_at: '2026-07-01T09:00:00.000Z',
    projected_last_out_at: null, projected_work_minutes: 0, projected_late_minutes: 0, projected_early_leave_minutes: 0,
    input_provenance: inputProvenance, provenance_fingerprint: fingerprint,
  }
  const record = {
    id: recordId, org_id: orgId, user_id: userId, work_date: '2026-07-01',
    current_calculation_id: priorId, projection_owner: 'w4', visibility_state: 'active', visibility_reason: 'active',
    status: 'partial', first_in_at: prior.projected_first_in_at, last_out_at: null,
    work_minutes: 0, late_minutes: 0, early_leave_minutes: 0, timezone: 'UTC', is_workday: true, meta: {},
  }
  const admittedWrite = new Error('SYNTHETIC_PROVENANCE_ADMITTED_BEFORE_WRITE')
  let writeAttempts = 0
  const client = {
    async query(sql: string) {
      if (/^\s*INSERT INTO attendance_record_calculations/.test(sql)) {
        writeAttempts += 1
        throw admittedWrite // Admission-only unit boundary: no INSERT is executed.
      }
      if (sql.includes('FROM attendance_records')) return { rows: [record] }
      if (sql.includes('FROM attendance_payroll_cycles')) return { rows: [] }
      if (sql.includes("entrypoint = 'manual_override'")) return { rows: [] }
      if (sql.includes('FROM attendance_record_calculations')) return { rows: [prior] }
      if (sql.includes('FROM attendance_record_segments')) return { rows: [{ segment_index: 0 }] }
      throw new Error('UNEXPECTED_SYNTHETIC_QUERY')
    },
  } as AttendanceW4TransactionClientV1
  return {
    run: () => appendManualOverrideCalculationV1({
      client, orgId, recordId, expectedCalculationId: priorId, expectedCalculationVersion: 1,
      operationId, actorId: userId, correlationId: 'synthetic-manual-correlation', reason: 'synthetic fixture',
      evidence: [], operations: [{ op: 'set', field: 'status', value: 'adjusted' }], mode: 'authoritative', editId: operationId,
    }),
    admittedWrite,
    writes: () => writeAttempts,
  }
}

describe('manual edit provenance admission (query-stub scope, not transaction proof)', () => {
  it.each([
    ['flat live envelope', { ...ref, payloadFingerprint: 'b'.repeat(64) }],
    ['nested reference envelope', { provenance: ref, payloadFingerprint: 'b'.repeat(64) }],
  ])('admits the valid %s up to the explicit no-write boundary', async (_name, provenance) => {
    const fixture = admission(provenance)
    await expect(fixture.run()).rejects.toBe(fixture.admittedWrite)
    expect(fixture.writes()).toBe(1)
  })

  const missingSource = { ...ref, payloadFingerprint: 'b'.repeat(64) } as Record<string, unknown>
  delete missingSource.sourceRef
  const missingNullField = { ...ref } as Record<string, unknown>
  delete missingNullField.convertedSheetName
  it.each([
    ['flat missing source', missingSource, expectedFingerprint],
    ['flat invalid transport', { ...ref, transport: 'unknown_transport', payloadFingerprint: 'b'.repeat(64) }, expectedFingerprint],
    ['flat inapplicable artifact', { ...ref, artifactSha256: 'f'.repeat(64), payloadFingerprint: 'b'.repeat(64) }, expectedFingerprint],
    ['flat fingerprint mismatch', { ...ref, payloadFingerprint: 'b'.repeat(64) }, '0'.repeat(64)],
    ['nested extra key', { ...ref, provenance: { ...ref, unexpected: true } }, expectedFingerprint],
    ['nested missing null field', { ...ref, provenance: missingNullField }, expectedFingerprint],
    ['nested array', { ...ref, provenance: [] }, expectedFingerprint],
  ])('refuses %s before any write attempt', async (_name, provenance, fingerprint) => {
    const fixture = admission(provenance as Record<string, unknown>, fingerprint as string)
    await expect(fixture.run()).rejects.toMatchObject({
      code: 'W4C3C_MANUAL_EDIT_PRIOR_INCOMPLETE', httpStatus: 409,
    })
    expect(fixture.writes()).toBe(0)
  })
})
