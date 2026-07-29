/**
 * W4C-2 (#4556) — expected-shadow-difference roster legs (#4607 gate-handover
 * P0 obligation: "correction-applied => adjusted" must be a NAMED expected
 * difference with its own leg, or the W4C-4 soak will read it as a regression).
 *
 * The W4 side of the divergence is proved against the real calculator (not a
 * stub): an approved correction applied to a day with no remaining anomaly and
 * ZERO leave/overtime minutes yields daily `adjusted`. The legacy side is the
 * ratified fixture fact recorded on the roster entry (legacy `computeMetrics`
 * grants `adjusted` only when leave/overtime minutes > 0 — index.cjs ~L11369 —
 * so the same day projects `normal`).
 */
import { describe, expect, it } from 'vitest'
import type {
  ApprovedAttendanceFactV1,
  AttendanceEvidenceV1,
} from '../w4c0-write-boundary-types'
import { calculateAttendanceSegmentsV1 } from '../w4c1-segment-calculator'
import {
  ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1,
  AttendanceW4ShadowExpectedDifferenceError,
  isExpectedAttendanceShadowDifferenceV1,
} from '../w4c2-shadow-expected-differences'

const sh = (time: string): string => `2026-07-01T${time}:00+08:00`

function correctionDayResult() {
  // Full-day punches, one of which is superseded by an approved correction to
  // the SAME boundary quality (no anomaly created), zero leave/OT facts.
  const evidence: AttendanceEvidenceV1[] = [
    { kind: 'punch', ref: 'ev-in-0', direction: 'check_in', occurredAt: sh('09:00'), source: 'attendance_event' },
    { kind: 'punch', ref: 'ev-out-0', direction: 'check_out', occurredAt: sh('12:00'), source: 'attendance_event' },
    { kind: 'punch', ref: 'ev-in-1', direction: 'check_in', occurredAt: sh('13:00'), source: 'attendance_event' },
    // Forgotten-punch shape: the stale early check_out is superseded by the
    // approved correction boundary at the exact planned end (no anomaly left).
    { kind: 'punch', ref: 'ev-out-1', direction: 'check_out', occurredAt: sh('17:40'), source: 'attendance_event' },
    { kind: 'approved_adjustment', ref: 'adj-out-1', direction: 'check_out', occurredAt: sh('18:00'), source: 'correction' },
  ]
  const facts: ApprovedAttendanceFactV1[] = [
    {
      kind: 'correction',
      requestId: 'req-corr-1',
      requestSnapshotVersion: 1,
      requestSnapshotFingerprint: 'c'.repeat(64),
      approvalVersion: 2,
      approvalRecordId: '301',
      direction: 'check_out',
      occurredAt: sh('18:00'),
      supersededEvidenceRef: 'ev-out-1',
    },
  ]
  return calculateAttendanceSegmentsV1({
    attribution: {
      posture: 'resolved_v2',
      value: {
        schemaVersion: 2,
        resolverVersion: 'w2-resolver@3',
        orgId: 'org-1',
        userId: 'user-1',
        workDate: '2026-07-01',
        shiftId: 'shift-1',
        reasonCode: 'assignment_match',
        resolvedAt: '2026-07-02T00:05:00+08:00',
        absoluteWindow: { startAt: '2026-06-30T16:00:00Z', endAt: '2026-07-02T16:00:00Z' },
        attributionWindow: { startAt: '2026-06-30T20:00:00Z', endAt: '2026-07-01T20:00:00Z' },
        attributionTailMinutes: 240,
        extendedByApprovedOvertime: false,
        windowEvidenceFingerprint: 'a'.repeat(64),
        source: 'live_resolution',
      },
    },
    context: {
      schemaVersion: 1,
      selector: 'legacy',
      orgId: 'org-1',
      userId: 'user-1',
      workDate: '2026-07-01',
      timezone: 'Asia/Shanghai',
      shiftId: 'shift-1',
      isWorkday: true,
      holidayKind: null,
      calculationGroupId: null,
      roundingMinutes: 15,
      severeLateThresholdMinutes: 45,
      absenceLateThresholdMinutes: 90,
      segments: [
        { index: 0, startTime: '09:00', endTime: '12:00', startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 5, earlyLeaveGraceMinutes: 5 },
        { index: 1, startTime: '13:00', endTime: '18:00', startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 5, earlyLeaveGraceMinutes: 5 },
      ],
    },
    evidence,
    approvedFacts: facts,
  })
}

const EXPECTED_PROBE = {
  shadowDiffCode: 'status_changed',
  legacyStatus: 'normal',
  w4Status: 'adjusted',
  w4CorrectionApplied: true,
  w4AnomalyPresent: false,
  legacyLeaveMinutes: 0,
  legacyOvertimeMinutes: 0,
} as const

describe('w4c2 expected shadow differences (#4607 handover P0)', () => {
  it('roster names exactly the ratified correction_applied_daily_adjusted entry as status_changed', () => {
    expect(
      ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1.map((entry) => [entry.id, entry.shadowDiffCode]),
    ).toEqual([['correction_applied_daily_adjusted', 'status_changed']])
  })

  it('W4 side of the divergence is real: correction-applied, no-anomaly, zero leave/OT day is daily adjusted with correction reason', () => {
    const result = correctionDayResult()
    expect(result.outcome).toBe('completed')
    expect(result.segments.map((s) => [s.status, s.workedMinutes, s.excusedByLeave, s.overtimeExtensionMinutes])).toEqual([
      ['normal', 180, false, 0],
      ['normal', 300, false, 0],
    ])
    expect(result.segments[1]?.reasons).toContain('approved_correction_applied')
    // Legacy computeMetrics on the SAME day (leave 0 / overtime 0) gives
    // 'normal' — the divergence this roster entry adjudicates.
    expect(result.dailyProjection?.status).toBe('adjusted')
    expect(result.dailyProjection?.lateMinutes).toBe(0)
    expect(result.dailyProjection?.earlyLeaveMinutes).toBe(0)
  })

  it('the exact ratified probe is expected; every single-field departure is NOT expected', () => {
    expect(isExpectedAttendanceShadowDifferenceV1(EXPECTED_PROBE)).toBe(true)
    const departures: Array<Partial<Record<keyof typeof EXPECTED_PROBE, unknown>>> = [
      { shadowDiffCode: 'work_minutes_mismatch' },
      { legacyStatus: 'late' },
      { w4Status: 'normal' },
      { w4CorrectionApplied: false },
      { w4AnomalyPresent: true },
      { legacyLeaveMinutes: 30 },
      { legacyOvertimeMinutes: 60 },
    ]
    for (const departure of departures) {
      expect(isExpectedAttendanceShadowDifferenceV1({ ...EXPECTED_PROBE, ...departure })).toBe(false)
    }
  })

  it('malformed probes fail closed (unknown key, missing key, invalid enum, non-boolean, non-object)', () => {
    const bad: unknown[] = [
      { ...EXPECTED_PROBE, extra: true },
      (() => { const { legacyOvertimeMinutes: _omit, ...rest } = EXPECTED_PROBE; return rest })(),
      { ...EXPECTED_PROBE, shadowDiffCode: 'not_a_code' },
      { ...EXPECTED_PROBE, w4Status: 'weird' },
      { ...EXPECTED_PROBE, w4CorrectionApplied: 'yes' },
      { ...EXPECTED_PROBE, legacyLeaveMinutes: -1 },
      null,
      [],
      'status_changed',
    ]
    for (const probe of bad) {
      expect(() => isExpectedAttendanceShadowDifferenceV1(probe)).toThrowError(
        AttendanceW4ShadowExpectedDifferenceError,
      )
    }
  })
})
