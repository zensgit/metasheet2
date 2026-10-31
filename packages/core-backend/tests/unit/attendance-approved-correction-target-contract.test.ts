import { describe, expect, it } from 'vitest'
import { normalizeAttendanceCorrectionTargetsV1, verifyCorrectionTargetV1, correctionCandidatesForCellsV1 } from '../../src/attendance/approved-correction-target-contract'
import { calculateAttendanceSegmentsV1, inspectAttendanceCorrectionCellsV1 } from '../../src/attendance/w4c1-segment-calculator'
import { buildAttendanceRequestCalculationPayloadFromRequestRowV1, computeAttendanceRequestPayloadFingerprintV1,
  normalizeAttendanceRequestCalculationPayloadV1 } from '../../src/attendance/w4c3b-request-snapshots'
import { approvedCorrectionFixture } from '../utils/attendance-approved-correction-fixture'
import type { ApprovedAttendanceFactV1 } from '../../src/attendance/w4c0-write-boundary-types'

const source = { recordId: '00000000-0000-4000-8000-000000000010',
  calculationId: '00000000-0000-4000-8000-000000000011', calculationVersion: 1, semanticInputFingerprint: 'a'.repeat(64) }
const replacement = { kind: 'replacement' as const, segmentIndex: 0, direction: 'check_in' as const,
  evidenceRef: '00000000-0000-4000-8000-000000000001' }
const insertion = { kind: 'insertion' as const, segmentIndex: 1, direction: 'check_out' as const }
const targets = { schemaVersion: 1, source, checkIn: replacement, checkOut: insertion }

describe('approved correction A closed contract', () => {
  it('retains two independent targets without inventing an insertion reference', () => {
    expect(normalizeAttendanceCorrectionTargetsV1(targets)).toEqual(targets)
    expect(Object.keys(normalizeAttendanceCorrectionTargetsV1(targets).checkOut!)).toEqual(['kind', 'segmentIndex', 'direction'])
  })
  it.each([
    { ...targets, schemaVersion: 3 }, { ...targets, display: {} },
    { ...targets, source: { ...source, calculationVersion: 0 } },
    { ...targets, source: { ...source, semanticInputFingerprint: 'bad' } },
    { ...targets, checkIn: { ...replacement, direction: 'check_out' } },
    { ...targets, checkIn: { ...replacement, direction: 'clock_in' } },
    { ...targets, checkIn: { ...replacement, kind: 'unknown' } },
    { ...targets, checkIn: { ...replacement, segmentIndex: 3 } },
    { ...targets, checkIn: { ...replacement, evidenceRef: '' } },
    { ...targets, checkIn: { ...replacement, display: {} } },
    { ...targets, checkOut: { ...insertion, evidenceRef: 'phantom' } },
  ])('rejects malformed/version/enum/display/phantom fields %#', input => {
    expect(() => normalizeAttendanceCorrectionTargetsV1(input)).toThrow('ATTENDANCE_CORRECTION_TARGET_INVALID')
  })
  it('verifies exact direction/segment, empty boundary, and the existing capture window', () => {
    const f = approvedCorrectionFixture()
    const input = { attribution: f.attribution, context: f.context, evidence: f.evidence, approvedFacts: [] }
    const cells = inspectAttendanceCorrectionCellsV1(input)!
    expect(correctionCandidatesForCellsV1(cells)).toEqual([
      replacement, { kind: 'replacement', segmentIndex: 1, direction: 'check_in', evidenceRef: f.evidence[2].ref },
      { kind: 'replacement', segmentIndex: 0, direction: 'check_out', evidenceRef: f.evidence[1].ref }, insertion,
    ])
    expect(() => verifyCorrectionTargetV1(replacement, cells, f.instant('09:00'), f.evidence)).not.toThrow()
    expect(() => verifyCorrectionTargetV1(insertion, cells, f.instant('18:00'), f.evidence)).not.toThrow()
    expect(() => verifyCorrectionTargetV1({ ...insertion, segmentIndex: 0 }, cells, f.instant('12:00'), f.evidence))
      .toThrow('ATTENDANCE_CORRECTION_TARGET_NOT_EMPTY')
    expect(() => verifyCorrectionTargetV1({ ...replacement, evidenceRef: f.evidence[2].ref }, cells, f.instant('09:00'), f.evidence))
      .toThrow('ATTENDANCE_CORRECTION_TARGET_STALE')
    expect(() => verifyCorrectionTargetV1(replacement, cells, f.instant('13:00'), f.evidence)).toThrow('ATTENDANCE_CORRECTION_TARGET_MISMATCH')
    expect(() => verifyCorrectionTargetV1(replacement, cells, '2049-08-21T09:00:00', f.evidence)).toThrow('ATTENDANCE_CORRECTION_TARGET_MISMATCH')
  })
  it('keeps v1 payload/hash while v2 binds each target/source independently', () => {
    const old = buildAttendanceRequestCalculationPayloadFromRequestRowV1({ workDate: '2049-08-21',
      requestedInAt: '2049-08-21T09:00:00.000Z', requestedOutAt: '2049-08-21T18:00:00.000Z' })
    expect(old).toEqual({ schemaVersion: 1, workDate: '2049-08-21', requestedInAt: '2049-08-21T09:00:00.000Z',
      requestedOutAt: '2049-08-21T18:00:00.000Z', reason: null, minutes: null, leaveTypeCode: null, outdoorPunch: null })
    expect(computeAttendanceRequestPayloadFingerprintV1(old)).toBe('9bd4a0c8d9165e5a0b156bb1157570758e11b36289c404c0591f82bffd5f9438')
    const v2 = normalizeAttendanceRequestCalculationPayloadV1({ ...old, schemaVersion: 2, correctionTargets: targets })
    expect(v2).toEqual({ ...old, schemaVersion: 2, correctionTargets: targets })
    expect(computeAttendanceRequestPayloadFingerprintV1(v2)).not.toBe(computeAttendanceRequestPayloadFingerprintV1(old))
    expect(computeAttendanceRequestPayloadFingerprintV1({ ...v2, correctionTargets: {
      ...targets, checkOut: { ...insertion, segmentIndex: 0 },
    } } as never)).not.toBe(computeAttendanceRequestPayloadFingerprintV1(v2))
    expect(() => normalizeAttendanceRequestCalculationPayloadV1({ ...v2, extra: true })).toThrow()
    expect(() => normalizeAttendanceRequestCalculationPayloadV1({ ...v2, requestedOutAt: null })).toThrow()
    expect(() => normalizeAttendanceRequestCalculationPayloadV1({ ...old, correctionTargets: targets })).toThrow()
  })
  it('applies replacement and insertion under one immutable request/approval identity', () => {
    const f = approvedCorrectionFixture()
    const changes = [
      { target: replacement, occurredAt: f.instant('09:00'), adjustmentEvidenceRef: 'correction:request:check_in' },
      { target: insertion, occurredAt: f.instant('18:00'), adjustmentEvidenceRef: 'correction:request:check_out' },
    ]
    const fact: ApprovedAttendanceFactV1 = { kind: 'correction', schemaVersion: 2, requestId: 'request',
      requestSnapshotVersion: 4, requestSnapshotFingerprint: 'b'.repeat(64), approvalVersion: 2, approvalRecordId: '123', changes }
    const evidence = [...f.evidence, ...changes.map(change => ({
      kind: 'approved_adjustment' as const, ref: change.adjustmentEvidenceRef, direction: change.target.direction,
      occurredAt: change.occurredAt, source: 'correction' as const,
    }))]
    const input = { attribution: f.attribution, context: f.context, evidence, approvedFacts: [fact] }
    const result = calculateAttendanceSegmentsV1(input)
    expect(result.outcome).toBe('completed')
    expect(result.segments.map(segment => ({ index: segment.segmentIndex, status: segment.status,
      worked: segment.workedMinutes, matched: segment.matchedEvidenceRefs, unmatched: segment.unmatchedEvidenceRefs }))).toEqual([
      { index: 0, status: 'normal', worked: 180, matched: ['correction:request:check_in', f.evidence[1].ref], unmatched: [f.evidence[0].ref] },
      { index: 1, status: 'normal', worked: 300, matched: [f.evidence[2].ref, 'correction:request:check_out'], unmatched: [] },
    ])
    expect(result.dailyProjection).toEqual({ firstInAt: f.instant('09:00'), lastOutAt: f.instant('18:00'),
      workedMinutes: 480, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'adjusted', timezone: 'UTC', workDate: '2049-08-21',
      meta: { severe_late_count: 0, severe_late_minutes: 0, absence_late_count: 0 } })
    const malformed = { ...fact, changes: [{ ...changes[0], target: { ...replacement, evidenceRef: 'foreign' } }, changes[1]] }
    expect(calculateAttendanceSegmentsV1({ ...input, approvedFacts: [malformed] }).outcomeReasonCode).toBe('approved_fact_conflict')
    expect(calculateAttendanceSegmentsV1({ ...input, approvedFacts: [{ ...fact, changes: [changes[0], changes[0]] }] }).outcomeReasonCode)
      .toBe('input_schema_invalid')
    expect(calculateAttendanceSegmentsV1({ ...input, approvedFacts: [{ ...fact, schemaVersion: 3 }] as never }).outcomeReasonCode)
      .toBe('input_schema_invalid')
  })
})
