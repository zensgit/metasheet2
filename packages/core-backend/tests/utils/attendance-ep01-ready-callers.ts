import type { AttendanceSegmentCalculationResultV1 } from '../../src/attendance/w4c1-segment-calculator'

export const EP01_READY_CASES = [
  { id: 'D01', timezone: 'UTC', offsetMinutes: 0, workDate: '2026-02-04', startTime: '21:00', endTime: '06:00', endDayOffset: 1 as const,
    startAt: '2026-02-04T21:00:00.000Z', endAt: '2026-02-05T06:00:00.000Z',
    otStart: '2026-02-04T23:00:00.000Z', otEnd: '2026-02-05T01:00:00.000Z', otMinutes: 120 },
  { id: 'C01', timezone: 'UTC', offsetMinutes: 0, workDate: '2026-02-04', startTime: '09:00', endTime: '18:00', endDayOffset: 0 as const,
    startAt: '2026-02-04T09:00:00.000Z', endAt: '2026-02-04T18:00:00.000Z',
    otStart: '2026-02-04T16:00:00.000Z', otEnd: '2026-02-04T17:00:00.000Z', otMinutes: 60 },
] as const

export const EP01_NON_UTC_READY_CASES = [
  { id: 'D02_TAIPEI', timezone: 'Asia/Taipei', offsetMinutes: 480, workDate: '2026-02-04',
    startTime: '21:00', endTime: '06:00', endDayOffset: 1 as const,
    startAt: '2026-02-04T13:00:00.000Z', endAt: '2026-02-04T22:00:00.000Z',
    otStart: '2026-02-04T15:00:00.000Z', otEnd: '2026-02-04T17:00:00.000Z', otMinutes: 120 },
  { id: 'D02_NEW_YORK', timezone: 'America/New_York', offsetMinutes: -300, workDate: '2026-02-04',
    startTime: '21:00', endTime: '06:00', endDayOffset: 1 as const,
    startAt: '2026-02-05T02:00:00.000Z', endAt: '2026-02-05T11:00:00.000Z',
    otStart: '2026-02-05T04:00:00.000Z', otEnd: '2026-02-05T06:00:00.000Z', otMinutes: 120 },
] as const

export type ReadyCallerCase = typeof EP01_READY_CASES[number] | typeof EP01_NON_UTC_READY_CASES[number]

/** Literal independent timing/result oracle; transport references are bound separately. */
export function expectedReadyCallerResult(
  scenario: ReadyCallerCase,
  refs: [string, string],
): AttendanceSegmentCalculationResultV1 {
  return {
    outcome: 'completed', outcomeReasonCode: 'calculated',
    segments: [{
      segmentIndex: 0, expectedStartAt: scenario.startAt, expectedEndAt: scenario.endAt,
      expectedStartOffsetMinutes: scenario.offsetMinutes, expectedEndOffsetMinutes: scenario.offsetMinutes,
      expectedStartFold: 'unique', expectedEndFold: 'unique',
      actualInAt: scenario.startAt, actualOutAt: scenario.endAt,
      workedMinutes: 540, lateMinutes: 0, earlyLeaveMinutes: 0,
      overtimeExtensionMinutes: 0, excusedByLeave: false,
      status: 'normal', reasons: ['within_window'],
      matchedEvidenceRefs: refs, unmatchedEvidenceRefs: [],
    }],
    dailyProjection: {
      firstInAt: scenario.startAt, lastOutAt: scenario.endAt, workedMinutes: 540,
      lateMinutes: 0, earlyLeaveMinutes: 0, status: 'normal', timezone: scenario.timezone,
      workDate: scenario.workDate,
      meta: { severe_late_count: 0, severe_late_minutes: 0, absence_late_count: 0 },
    },
  }
}

/** Checkout-only fault probe, not the completed540-minute parity baseline. */
export function expectedCheckoutOnlyResult(ref: string, scenario: ReadyCallerCase = EP01_READY_CASES[0]): AttendanceSegmentCalculationResultV1 {
  const literal = expectedReadyCallerResult(scenario, [ref, ref])
  return {
    ...literal,
    segments: [{ ...literal.segments[0], actualInAt: null, workedMinutes: 0,
      status: 'missing_check_in', reasons: ['missing_check_in'], matchedEvidenceRefs: [ref] }],
    dailyProjection: { ...literal.dailyProjection!, firstInAt: null, workedMinutes: 0, status: 'partial' },
  }
}
