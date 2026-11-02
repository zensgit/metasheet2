import type { AttendanceSegmentCalculationResultV1 } from '../../src/attendance/w4c1-segment-calculator'

export const EP01_DST_READY_CASES = [
  { id: 'D03_FOLD_START', timezone: 'America/New_York', workDate: '2025-11-02', total: 165,
    startAt: '2025-11-02T04:30:00.000Z', endAt: '2025-11-02T08:00:00.000Z',
    segments: [{ startTime: '00:30', endTime: '00:45' }, { startTime: '01:30', endTime: '03:00' }],
    punches: [['check_in', '2025-11-02T04:30:00.000Z'], ['check_out', '2025-11-02T04:45:00.000Z'],
      ['check_in', '2025-11-02T05:30:00.000Z'], ['check_out', '2025-11-02T08:00:00.000Z']],
    expected: [
      { start: '2025-11-02T04:30:00.000Z', end: '2025-11-02T04:45:00.000Z', minutes: 15,
        startOffset: -240, endOffset: -240, startFold: 'unique', endFold: 'unique', reasons: ['within_window'] },
      { start: '2025-11-02T05:30:00.000Z', end: '2025-11-02T08:00:00.000Z', minutes: 150,
        startOffset: -240, endOffset: -300, startFold: 'fold_earlier', endFold: 'unique',
        reasons: ['dst_fold_start_earlier', 'within_window'] },
    ],
    otStart: '2025-11-02T07:00:00.000Z', otEnd: '2025-11-02T07:30:00.000Z', otMinutes: 30 },
  { id: 'D03_FOLD_END', timezone: 'America/New_York', workDate: '2025-11-02', total: 195,
    startAt: '2025-11-02T04:30:00.000Z', endAt: '2025-11-02T08:00:00.000Z',
    segments: [{ startTime: '00:30', endTime: '01:45' }, { startTime: '02:00', endTime: '03:00' }],
    punches: [['check_in', '2025-11-02T04:30:00.000Z'], ['check_out', '2025-11-02T06:45:00.000Z'],
      ['check_in', '2025-11-02T07:00:00.000Z'], ['check_out', '2025-11-02T08:00:00.000Z']],
    expected: [
      { start: '2025-11-02T04:30:00.000Z', end: '2025-11-02T06:45:00.000Z', minutes: 135,
        startOffset: -240, endOffset: -300, startFold: 'unique', endFold: 'fold_later',
        reasons: ['dst_fold_end_later', 'within_window'] },
      { start: '2025-11-02T07:00:00.000Z', end: '2025-11-02T08:00:00.000Z', minutes: 60,
        startOffset: -300, endOffset: -300, startFold: 'unique', endFold: 'unique', reasons: ['within_window'] },
    ],
    otStart: '2025-11-02T07:00:00.000Z', otEnd: '2025-11-02T07:30:00.000Z', otMinutes: 30 },
] as const

/** Literal parent CALC11 oracle, independent of production wall-time resolution. */
export function expectedDstReadyCallerResult(
  scenario: typeof EP01_DST_READY_CASES[number], refs: readonly string[],
): AttendanceSegmentCalculationResultV1 {
  return {
    outcome: 'completed', outcomeReasonCode: 'calculated',
    segments: scenario.expected.map((segment, index) => ({
      segmentIndex: index, expectedStartAt: segment.start, expectedEndAt: segment.end,
      expectedStartOffsetMinutes: segment.startOffset, expectedEndOffsetMinutes: segment.endOffset,
      expectedStartFold: segment.startFold, expectedEndFold: segment.endFold,
      actualInAt: segment.start, actualOutAt: segment.end,
      workedMinutes: segment.minutes, lateMinutes: 0, earlyLeaveMinutes: 0,
      overtimeExtensionMinutes: 0, excusedByLeave: false, status: 'normal',
      reasons: [...segment.reasons], matchedEvidenceRefs: refs.slice(index * 2, index * 2 + 2),
      unmatchedEvidenceRefs: [],
    })),
    dailyProjection: {
      firstInAt: scenario.startAt, lastOutAt: scenario.endAt, workedMinutes: scenario.total,
      lateMinutes: 0, earlyLeaveMinutes: 0, status: 'normal', timezone: scenario.timezone,
      workDate: scenario.workDate,
      meta: { severe_late_count: 0, severe_late_minutes: 0, absence_late_count: 0 },
    },
  }
}
