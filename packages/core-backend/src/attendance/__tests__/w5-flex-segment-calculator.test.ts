/**
 * W5 (#4556) — single-segment flex calculator synthetic matrix
 * (design lock §3.3 / §7.2 flex legs / §9.6).
 *
 * Strict-mode fixtures must remain byte-identical to the W4C-1 path when
 * flexPolicy is absent or mode=strict. Core hours are authoring-only; the
 * calculator does not invent a core_hours_violation reasonCode.
 */
import { describe, expect, it } from 'vitest'
import type {
  AttendanceAttributionSnapshotV1,
  AttendanceEvidenceV1,
  FrozenAttendanceContextV1,
} from '../w4c0-write-boundary-types'
import { calculateAttendanceSegmentsV1 } from '../w4c1-segment-calculator'

const sh = (time: string, dayShift = 0): string => `2026-07-0${1 + dayShift}T${time}:00+08:00`
const shIso = (hour: number, minute: number, dayShift = 0): string =>
  new Date(Date.UTC(2026, 6, 1 + dayShift, hour - 8, minute, 0)).toISOString()

function makeAttribution(): AttendanceAttributionSnapshotV1 {
  return {
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
  }
}

function makeStrictContext(): FrozenAttendanceContextV1 {
  return {
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
    roundingMinutes: 1,
    severeLateThresholdMinutes: 45,
    absenceLateThresholdMinutes: 90,
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
}

function makeFlexContext(
  overrides: Partial<NonNullable<FrozenAttendanceContextV1['flexPolicy']>> = {},
): FrozenAttendanceContextV1 {
  return {
    ...makeStrictContext(),
    flexPolicy: {
      mode: 'flex_required_duration',
      // Authoring-valid core: segment 09:00, before=60 after=60 => [08:00,10:00],
      // required 480 covers core 10:00-15:00 for every clamped start.
      requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 60,
      arrivalWindowAfterMinutes: 60,
      coreStartTime: '10:00',
      coreEndTime: '15:00',
      ...overrides,
    },
  }
}

const punch = (
  ref: string,
  direction: 'check_in' | 'check_out',
  occurredAt: string,
): AttendanceEvidenceV1 => ({
  kind: 'punch',
  ref,
  direction,
  occurredAt,
  source: 'attendance_event',
})

describe('W5 flex single-segment calculator', () => {
  it('preserves strict legacy bytes when flexPolicy is absent', () => {
    const context = makeStrictContext()
    const evidence = [
      punch('in-1', 'check_in', sh('09:00')),
      punch('out-1', 'check_out', sh('18:00')),
    ]
    const result = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context,
      evidence,
      approvedFacts: [],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0].expectedStartAt).toBe(shIso(9, 0))
    expect(result.segments[0].expectedEndAt).toBe(shIso(18, 0))
    expect(result.segments[0].workedMinutes).toBe(540)
    expect(result.segments[0].lateMinutes).toBe(0)
    expect(result.segments[0].earlyLeaveMinutes).toBe(0)
    expect(result.segments[0].reasons).toEqual(['within_window'])
  })

  it('preserves strict path when flexPolicy.mode is strict', () => {
    const evidence = [
      punch('in-1', 'check_in', sh('09:00')),
      punch('out-1', 'check_out', sh('18:00')),
    ]
    const absentResult = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context: makeStrictContext(),
      evidence,
      approvedFacts: [],
    })
    const context: FrozenAttendanceContextV1 = {
      ...makeStrictContext(),
      flexPolicy: { mode: 'strict' },
    }
    const result = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context,
      evidence,
      approvedFacts: [],
    })
    expect(result).toEqual(absentResult)
  })

  it('rejects multi-segment flex at frozen-context validation', () => {
    const context: FrozenAttendanceContextV1 = {
      ...makeStrictContext(),
      segments: [
        {
          index: 0,
          startTime: '08:00',
          endTime: '12:00',
          startDayOffset: 0,
          endDayOffset: 0,
          lateGraceMinutes: 5,
          earlyLeaveGraceMinutes: 5,
        },
        {
          index: 1,
          startTime: '13:00',
          endTime: '17:00',
          startDayOffset: 0,
          endDayOffset: 0,
          lateGraceMinutes: 5,
          earlyLeaveGraceMinutes: 5,
        },
      ],
      flexPolicy: {
        mode: 'flex_required_duration',
        requiredMinutes: 480,
        arrivalWindowBeforeMinutes: 0,
        arrivalWindowAfterMinutes: 0,
        coreStartTime: null,
        coreEndTime: null,
      },
    }
    const result = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context,
      evidence: [],
      approvedFacts: [],
    })
    expect(result).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'input_schema_invalid',
      segments: [],
      dailyProjection: null,
    })
  })

  it('fail-closes corrupt frozen core policy as review_required/input_schema_invalid with zero segments', () => {
    // after=120 => latest 11:00 > coreStart 10:00 — would pass duration-only (480>=300).
    const result = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context: makeFlexContext({ arrivalWindowAfterMinutes: 120 }),
      evidence: [
        punch('in-1', 'check_in', sh('09:00')),
        punch('out-1', 'check_out', sh('18:00')),
      ],
      approvedFacts: [],
    })
    expect(result).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'input_schema_invalid',
      segments: [],
      dailyProjection: null,
    })
  })

  it('fail-closes corrupt frozen core policy when earliest+required cannot reach core end', () => {
    // before=120, required=360: duration-only passes (360>=300) but earliest 07:00+360=13:00 < 15:00.
    const result = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context: makeFlexContext({
        arrivalWindowBeforeMinutes: 120,
        arrivalWindowAfterMinutes: 0,
        requiredMinutes: 360,
        coreStartTime: '09:00',
        coreEndTime: '15:00',
      }),
      evidence: [
        punch('in-1', 'check_in', sh('09:00')),
        punch('out-1', 'check_out', sh('15:00')),
      ],
      approvedFacts: [],
    })
    expect(result).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'input_schema_invalid',
      segments: [],
      dailyProjection: null,
    })
  })

  it('edge arrivals on an authoring-valid core policy still cover core (no new reasonCode)', () => {
    // Window [08:00,10:00], required 480, core 10:00-15:00.
    // Earliest clamp 08:00 => end 16:00 covers core; latest exact 10:00 => end 18:00 covers core.
    const earliest = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context: makeFlexContext(),
      evidence: [
        punch('in-1', 'check_in', sh('07:30')), // clamps to 08:00
        punch('out-1', 'check_out', sh('16:00')),
      ],
      approvedFacts: [],
    })
    expect(earliest.outcome).toBe('completed')
    expect(earliest.segments[0].expectedStartAt).toBe(shIso(8, 0))
    expect(earliest.segments[0].expectedEndAt).toBe(shIso(16, 0))
    // Expected [08:00,16:00] covers core [10:00,15:00]; no invented core reason.
    expect(earliest.segments[0].reasons).toEqual(['within_window'])
    expect(earliest.dailyProjection).not.toBeNull()
    expect(earliest.dailyProjection?.workedMinutes).toBe(480)

    const latest = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context: makeFlexContext(),
      evidence: [
        punch('in-2', 'check_in', sh('10:00')), // exact latest permitted start
        punch('out-2', 'check_out', sh('18:00')),
      ],
      approvedFacts: [],
    })
    expect(latest.outcome).toBe('completed')
    expect(latest.segments[0].expectedStartAt).toBe(shIso(10, 0))
    expect(latest.segments[0].expectedEndAt).toBe(shIso(18, 0))
    expect(latest.segments[0].lateMinutes).toBe(0)
    expect(latest.segments[0].reasons).toEqual(['within_window'])
    expect(latest.dailyProjection).not.toBeNull()
    expect(latest.dailyProjection?.workedMinutes).toBe(480)
  })

  it('resolves late-arrive / late-leave flex expectation and applies grace after', () => {
    // Arrival window [08:00, 10:00]. Arrive 10:30 => clamp expected start 10:00.
    // Expected end 18:00. Leave 17:50 with 5m early grace => early 5.
    // Late vs 10:00+5m grace: 10:30 is 25m late.
    const result = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context: makeFlexContext({ coreStartTime: null, coreEndTime: null }),
      evidence: [
        punch('in-1', 'check_in', sh('10:30')),
        punch('out-1', 'check_out', sh('17:50')),
      ],
      approvedFacts: [],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0].expectedStartAt).toBe(shIso(10, 0))
    expect(result.segments[0].expectedEndAt).toBe(shIso(18, 0))
    expect(result.segments[0].lateMinutes).toBe(25)
    expect(result.segments[0].earlyLeaveMinutes).toBe(5)
    expect(result.segments[0].status).toBe('late_early')
    // Payable intersection of [10:30, 17:50) with [10:00, 18:00) = 440 minutes.
    expect(result.segments[0].workedMinutes).toBe(440)
  })

  it('recomputes offset and fold metadata for a flex expectation on the later DST fold', () => {
    const baseAttribution = makeAttribution()
    if (baseAttribution.posture !== 'resolved_v2') throw new Error('expected resolved attribution')
    const attribution: AttendanceAttributionSnapshotV1 = {
      ...baseAttribution,
      value: {
        ...baseAttribution.value,
        workDate: '2026-11-01',
        absoluteWindow: {
          startAt: '2026-11-01T00:00:00-04:00',
          endAt: '2026-11-02T12:00:00-05:00',
        },
        attributionWindow: {
          startAt: '2026-11-01T00:00:00-04:00',
          endAt: '2026-11-02T12:00:00-05:00',
        },
      },
    }
    const context: FrozenAttendanceContextV1 = {
      ...makeFlexContext({
        requiredMinutes: 60,
        arrivalWindowBeforeMinutes: 0,
        arrivalWindowAfterMinutes: 120,
        coreStartTime: null,
        coreEndTime: null,
      }),
      workDate: '2026-11-01',
      timezone: 'America/New_York',
      segments: [{
        index: 0,
        startTime: '00:30',
        endTime: '10:00',
        startDayOffset: 0,
        endDayOffset: 0,
        lateGraceMinutes: 5,
        earlyLeaveGraceMinutes: 5,
      }],
    }
    const result = calculateAttendanceSegmentsV1({
      attribution,
      context,
      evidence: [
        punch('in-fold-later', 'check_in', '2026-11-01T01:30:00-05:00'),
        punch('out-after-fold', 'check_out', '2026-11-01T02:30:00-05:00'),
      ],
      approvedFacts: [],
    })

    expect(result.outcome).toBe('completed')
    expect(result.segments[0].expectedStartAt).toBe('2026-11-01T06:30:00.000Z')
    expect(result.segments[0].expectedStartOffsetMinutes).toBe(-300)
    expect(result.segments[0].expectedStartFold).toBe('fold_later')
    expect(result.segments[0].expectedEndAt).toBe('2026-11-01T07:30:00.000Z')
    expect(result.segments[0].expectedEndOffsetMinutes).toBe(-300)
    expect(result.segments[0].expectedEndFold).toBe('unique')
  })

  it('resolves early-arrive / early-leave flex expectation', () => {
    // Arrive 07:30 => clamp to window open 08:00; expected end 16:00.
    // Leave 15:50 with 5m early grace from 16:00 => early 5.
    const result = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context: makeFlexContext({ coreStartTime: null, coreEndTime: null }),
      evidence: [
        punch('in-1', 'check_in', sh('07:30')),
        punch('out-1', 'check_out', sh('15:50')),
      ],
      approvedFacts: [],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0].expectedStartAt).toBe(shIso(8, 0))
    expect(result.segments[0].expectedEndAt).toBe(shIso(16, 0))
    expect(result.segments[0].lateMinutes).toBe(0)
    expect(result.segments[0].earlyLeaveMinutes).toBe(5)
    // Intersection [07:30,15:50) ∩ [08:00,16:00) = 470 minutes.
    expect(result.segments[0].workedMinutes).toBe(470)
  })

  it('uses in-window arrival as expected start (no late when within arrival window)', () => {
    const result = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context: makeFlexContext({ coreStartTime: null, coreEndTime: null }),
      evidence: [
        punch('in-1', 'check_in', sh('09:30')),
        punch('out-1', 'check_out', sh('17:30')),
      ],
      approvedFacts: [],
    })
    expect(result.segments[0].expectedStartAt).toBe(shIso(9, 30))
    expect(result.segments[0].expectedEndAt).toBe(shIso(17, 30))
    expect(result.segments[0].lateMinutes).toBe(0)
    expect(result.segments[0].earlyLeaveMinutes).toBe(0)
    expect(result.segments[0].workedMinutes).toBe(480)
    expect(result.segments[0].reasons).toEqual(['within_window'])
  })

  it('uses the window open as the stable flex expectation when arrival is missing', () => {
    const result = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context: makeFlexContext({ coreStartTime: null, coreEndTime: null }),
      evidence: [],
      approvedFacts: [],
    })

    expect(result.outcome).toBe('completed')
    expect(result.segments[0].expectedStartAt).toBe(shIso(8, 0))
    expect(result.segments[0].expectedEndAt).toBe(shIso(16, 0))
    expect(result.segments[0].status).toBe('missing_both')
    expect(result.segments[0].workedMinutes).toBe(0)
    expect(result.segments[0].reasons).toEqual(['missing_both'])
  })

  it('runs authoring-valid core-hours flex without inventing a core reasonCode', () => {
    const result = calculateAttendanceSegmentsV1({
      attribution: makeAttribution(),
      context: makeFlexContext(),
      evidence: [
        punch('in-1', 'check_in', sh('09:00')),
        punch('out-1', 'check_out', sh('17:00')),
      ],
      approvedFacts: [],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0].expectedStartAt).toBe(shIso(9, 0))
    expect(result.segments[0].expectedEndAt).toBe(shIso(17, 0))
    expect(result.segments[0].reasons).toEqual(['within_window'])
    expect(result.segments[0].reasons).not.toContain('core_hours_violation')
  })
})
