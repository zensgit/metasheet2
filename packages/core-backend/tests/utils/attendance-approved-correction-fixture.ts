import type {
  AttendanceAttributionSnapshotV1, AttendanceEvidenceV1, FrozenAttendanceContextV1,
} from '../../src/attendance/w4c0-write-boundary-types'

export function approvedCorrectionFixture(orgId = 'org-A', userId = 'user-A', workDate = '2049-08-21') {
  const instant = (time: string) => workDate + 'T' + time + ':00.000Z'
  const context: FrozenAttendanceContextV1 = {
    schemaVersion: 1, selector: 'legacy', orgId, userId, workDate, timezone: 'UTC', shiftId: 'correction-A-shift',
    isWorkday: true, holidayKind: null, calculationGroupId: null, roundingMinutes: 1,
    severeLateThresholdMinutes: 45, absenceLateThresholdMinutes: 90,
    segments: [
      { index: 0, startTime: '09:00', endTime: '12:00', startDayOffset: 0, endDayOffset: 0,
        lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 },
      { index: 1, startTime: '13:00', endTime: '18:00', startDayOffset: 0, endDayOffset: 0,
        lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 },
    ],
  }
  const attribution: AttendanceAttributionSnapshotV1 = {
    posture: 'resolved_v2', value: {
      schemaVersion: 2, resolverVersion: 'approved-correction-A-fixture', orgId, userId, workDate,
      shiftId: context.shiftId, reasonCode: 'assignment_match', resolvedAt: instant('00:00'),
      absoluteWindow: { startAt: instant('00:00'), endAt: instant('20:00') },
      attributionWindow: { startAt: instant('00:00'), endAt: instant('23:00') },
      attributionTailMinutes: 180, extendedByApprovedOvertime: false, windowEvidenceFingerprint: 'a'.repeat(64),
      source: 'request_creation',
    },
  }
  const evidence: AttendanceEvidenceV1[] = [
    { kind: 'punch', ref: '00000000-0000-4000-8000-000000000001', direction: 'check_in', occurredAt: instant('09:15'), source: 'attendance_event' },
    { kind: 'punch', ref: '00000000-0000-4000-8000-000000000002', direction: 'check_out', occurredAt: instant('12:00'), source: 'attendance_event' },
    { kind: 'punch', ref: '00000000-0000-4000-8000-000000000003', direction: 'check_in', occurredAt: instant('13:00'), source: 'attendance_event' },
  ]
  return { context, attribution, evidence, approvedFacts: [], instant }
}
