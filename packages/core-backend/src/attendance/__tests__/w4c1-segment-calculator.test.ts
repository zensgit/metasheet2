/**
 * W4C-1 (#4556) — pure segment calculator gates (§12.2 first-sentence coverage,
 * word for word): 1/2/3 segments, overnight, breaks, every status, midpoint
 * ties, out-of-window/unmatched/duplicate/ambiguous/reversed evidence,
 * cross-segment actual-interval overlap, DST including the shared-fold-boundary
 * review, full/partial leave, overtime with/without punch, plus the strict
 * ingress rejections (offset-less values, invalid zones, unknown enum members).
 *
 * Assertions are exact shapes (full deepEqual result bodies on the flagship
 * fixtures; exact review codes elsewhere). Fixtures use the natural closed
 * contract shapes from `w4c0-write-boundary-types` — no bare-row stand-ins.
 */
import { describe, expect, it } from 'vitest'
import type {
  ApprovedAttendanceFactV1,
  AttendanceAttributionSnapshotV1,
  AttendanceEvidenceV1,
  FrozenAttendanceContextV1,
} from '../w4c0-write-boundary-types'
import {
  calculateAttendanceSegmentsV1,
  deriveAttendanceLateTierFieldsV1,
  roundAttendanceMinutesV1,
  type AttendanceSegmentCalculationInputV1,
} from '../w4c1-segment-calculator'

// ---------------------------------------------------------------------------
// Fixture builders (Asia/Shanghai base day 2026-07-01; +08:00 all year).
// ---------------------------------------------------------------------------

/** Local Shanghai instant on the base day (+dayShift) as an explicit-offset string. */
const sh = (time: string, dayShift = 0): string => `2026-07-0${1 + dayShift}T${time}:00+08:00`
/** Exact UTC ISO the calculator emits for a Shanghai local time on the base day. */
const shIso = (hour: number, minute: number, dayShift = 0): string =>
  new Date(Date.UTC(2026, 6, 1 + dayShift, hour - 8, minute, 0)).toISOString()

function seg(
  index: 0 | 1 | 2,
  startTime: string,
  endTime: string,
  endDayOffset: 0 | 1 = 0,
): FrozenAttendanceContextV1['segments'][number] {
  return {
    index,
    startTime,
    endTime,
    startDayOffset: 0,
    endDayOffset,
    // Deliberately NON-default values (legacy defaults are 10): a mutation
    // that rereads default policy instead of the frozen context flips tests.
    lateGraceMinutes: 5,
    earlyLeaveGraceMinutes: 5,
  }
}

function makeContext(overrides: Partial<FrozenAttendanceContextV1> = {}): FrozenAttendanceContextV1 {
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
    // Deliberately non-default policy values (legacy defaults: 10/30/60).
    roundingMinutes: 15,
    severeLateThresholdMinutes: 45,
    absenceLateThresholdMinutes: 90,
    segments: [seg(0, '09:00', '12:00'), seg(1, '13:00', '18:00')],
    ...overrides,
  }
}

function makeAttribution(
  valueOverrides: Record<string, unknown> = {},
): AttendanceAttributionSnapshotV1 {
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
      ...valueOverrides,
    },
  } as AttendanceAttributionSnapshotV1
}

const punch = (
  ref: string,
  direction: 'check_in' | 'check_out',
  occurredAt: string,
  source: 'attendance_event' | 'outdoor_approval' | 'import' = 'attendance_event',
): AttendanceEvidenceV1 => ({ kind: 'punch', ref, direction, occurredAt, source })

const adjustment = (
  ref: string,
  direction: 'check_in' | 'check_out',
  occurredAt: string,
): AttendanceEvidenceV1 => ({ kind: 'approved_adjustment', ref, direction, occurredAt, source: 'correction' })

function factBase(requestId: string) {
  return {
    requestId,
    requestSnapshotVersion: 1,
    requestSnapshotFingerprint: 'f'.repeat(64),
    approvalVersion: 3,
    approvalRecordId: '101',
  }
}

const leaveFact = (
  requestId: string,
  startAt: string,
  endAt: string,
  minutes: number,
): ApprovedAttendanceFactV1 => ({
  ...factBase(requestId),
  kind: 'leave',
  leaveType: 'annual',
  coverage: { kind: 'bounded_interval', startAt, endAt, minutes },
})

const overtimeFact = (
  requestId: string,
  startAt: string,
  endAt: string,
  minutes: number,
): ApprovedAttendanceFactV1 => ({
  ...factBase(requestId),
  kind: 'overtime',
  coverage: { kind: 'bounded_interval', startAt, endAt, minutes },
})

const correctionFact = (
  requestId: string,
  direction: 'check_in' | 'check_out',
  occurredAt: string,
  supersededEvidenceRef: string,
): ApprovedAttendanceFactV1 => ({
  ...factBase(requestId),
  kind: 'correction',
  direction,
  occurredAt,
  supersededEvidenceRef,
})

function run(
  overrides: Partial<AttendanceSegmentCalculationInputV1> = {},
): ReturnType<typeof calculateAttendanceSegmentsV1> {
  return calculateAttendanceSegmentsV1({
    attribution: makeAttribution(),
    context: makeContext(),
    evidence: [],
    approvedFacts: [],
    ...overrides,
  })
}

const fullDayEvidence: AttendanceEvidenceV1[] = [
  punch('ev-in-1', 'check_in', sh('08:58')),
  punch('ev-out-1', 'check_out', sh('12:01')),
  punch('ev-in-2', 'check_in', sh('12:59')),
  punch('ev-out-2', 'check_out', sh('18:02')),
]

// ---------------------------------------------------------------------------
// Flagship exact shapes: 1/2/3 segments, breaks, overnight.
// ---------------------------------------------------------------------------

describe('calculateAttendanceSegmentsV1 — completed shapes', () => {
  it('two-segment day with a break: exact full result body (no envelope arithmetic, W4C-R1)', () => {
    const result = run({ evidence: fullDayEvidence })
    expect(result).toEqual({
      outcome: 'completed',
      outcomeReasonCode: 'calculated',
      segments: [
        {
          segmentIndex: 0,
          expectedStartAt: shIso(9, 0),
          expectedEndAt: shIso(12, 0),
          expectedStartOffsetMinutes: 480,
          expectedEndOffsetMinutes: 480,
          expectedStartFold: 'unique',
          expectedEndFold: 'unique',
          actualInAt: shIso(8, 58),
          actualOutAt: shIso(12, 1),
          workedMinutes: 180,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          overtimeExtensionMinutes: 0,
          excusedByLeave: false,
          status: 'normal',
          reasons: ['within_window'],
          matchedEvidenceRefs: ['ev-in-1', 'ev-out-1'],
          unmatchedEvidenceRefs: [],
        },
        {
          segmentIndex: 1,
          expectedStartAt: shIso(13, 0),
          expectedEndAt: shIso(18, 0),
          expectedStartOffsetMinutes: 480,
          expectedEndOffsetMinutes: 480,
          expectedStartFold: 'unique',
          expectedEndFold: 'unique',
          actualInAt: shIso(12, 59),
          actualOutAt: shIso(18, 2),
          workedMinutes: 300,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          overtimeExtensionMinutes: 0,
          excusedByLeave: false,
          status: 'normal',
          reasons: ['within_window'],
          matchedEvidenceRefs: ['ev-in-2', 'ev-out-2'],
          unmatchedEvidenceRefs: [],
        },
      ],
      dailyProjection: {
        firstInAt: shIso(8, 58),
        lastOutAt: shIso(18, 2),
        workedMinutes: 480,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        status: 'normal',
        timezone: 'Asia/Shanghai',
        workDate: '2026-07-01',
        meta: { severe_late_count: 0, severe_late_minutes: 0, absence_late_count: 0 },
      },
    })
  })

  it('is deterministic: identical frozen input twice gives deepEqual results', () => {
    expect(run({ evidence: fullDayEvidence })).toEqual(run({ evidence: fullDayEvidence }))
  })

  it('single-segment day', () => {
    const context = makeContext({ segments: [seg(0, '09:00', '18:00')] })
    const result = run({
      context,
      evidence: [punch('a', 'check_in', sh('09:00')), punch('b', 'check_out', sh('18:00'))],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments.map((s) => [s.status, s.workedMinutes])).toEqual([['normal', 540]])
    expect(result.dailyProjection?.workedMinutes).toBe(540)
    expect(result.dailyProjection?.status).toBe('normal')
  })

  it('three-segment day', () => {
    const context = makeContext({
      segments: [seg(0, '09:00', '11:00'), seg(1, '11:30', '13:30'), seg(2, '14:00', '18:00')],
    })
    const result = run({
      context,
      evidence: [
        punch('i1', 'check_in', sh('09:00')),
        punch('o1', 'check_out', sh('11:00')),
        punch('i2', 'check_in', sh('11:30')),
        punch('o2', 'check_out', sh('13:30')),
        punch('i3', 'check_in', sh('14:00')),
        punch('o3', 'check_out', sh('18:00')),
      ],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments.map((s) => [s.segmentIndex, s.status, s.workedMinutes])).toEqual([
      [0, 'normal', 120],
      [1, 'normal', 120],
      [2, 'normal', 240],
    ])
    expect(result.dailyProjection?.workedMinutes).toBe(480)
  })

  it('overnight segment (endDayOffset=1) resolves across midnight', () => {
    const context = makeContext({ segments: [seg(0, '21:00', '06:00', 1)] })
    const attribution = makeAttribution({
      absoluteWindow: { startAt: '2026-07-01T04:00:00Z', endAt: '2026-07-02T04:00:00Z' },
      attributionWindow: { startAt: '2026-07-01T08:00:00Z', endAt: '2026-07-02T04:00:00Z' },
    })
    const result = run({
      context,
      attribution,
      evidence: [punch('a', 'check_in', sh('20:58')), punch('b', 'check_out', sh('06:05', 1))],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0]).toMatchObject({
      expectedStartAt: shIso(21, 0),
      expectedEndAt: shIso(6, 0, 1),
      actualInAt: shIso(20, 58),
      actualOutAt: shIso(6, 5, 1),
      workedMinutes: 540,
      status: 'normal',
    })
    expect(result.dailyProjection?.workedMinutes).toBe(540)
  })

  it('an actual interval crossing the planned break pays only the in-segment intersection (W4C-R24)', () => {
    // Segment 0 out-punch at 12:40 crosses the 12:00-13:00 break by 40 minutes:
    // raw span is 222 minutes, payable is exactly 180.
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('08:58')),
        punch('ev-out-1', 'check_out', sh('12:40')),
        punch('ev-in-2', 'check_in', sh('12:59')),
        punch('ev-out-2', 'check_out', sh('18:02')),
      ],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0].workedMinutes).toBe(180)
    expect(result.segments[1].workedMinutes).toBe(300)
    expect(result.dailyProjection?.workedMinutes).toBe(480)
  })

  it('unapproved early arrival and late departure never extend payable time', () => {
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('08:30')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        punch('ev-in-2', 'check_in', sh('12:59')),
        punch('ev-out-2', 'check_out', sh('18:40')),
      ],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0].workedMinutes).toBe(180)
    expect(result.segments[1].workedMinutes).toBe(300)
    expect(result.segments[1].overtimeExtensionMinutes).toBe(0)
    expect(result.dailyProjection?.workedMinutes).toBe(480)
  })
})

// ---------------------------------------------------------------------------
// Every segment status + daily aggregation + tiers + rounding.
// ---------------------------------------------------------------------------

describe('calculateAttendanceSegmentsV1 — statuses, aggregation, rounding, tiers', () => {
  const seg1Normal = [punch('ev-in-2', 'check_in', sh('12:59')), punch('ev-out-2', 'check_out', sh('18:02'))]

  it('late: minutes measured beyond the FROZEN grace threshold (frozen 5, not default 10)', () => {
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('09:06')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        ...seg1Normal,
      ],
    })
    // 09:06 is 1 whole minute beyond 09:05 (start + frozen grace 5). A
    // default-grace (10) reread would report 0 and 'normal'.
    expect(result.segments[0].lateMinutes).toBe(1)
    expect(result.segments[0].status).toBe('late')
    expect(result.segments[0].reasons).toEqual(['late_check_in'])
    expect(result.dailyProjection?.status).toBe('late')
    expect(result.dailyProjection?.lateMinutes).toBe(1)
  })

  it('within-grace arrival stays normal', () => {
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('09:04')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        ...seg1Normal,
      ],
    })
    expect(result.segments[0].status).toBe('normal')
    expect(result.segments[0].lateMinutes).toBe(0)
  })

  it('early_leave with exact minutes beyond the frozen early grace', () => {
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('08:58')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        punch('ev-in-2', 'check_in', sh('12:59')),
        punch('ev-out-2', 'check_out', sh('17:40')),
      ],
    })
    // 17:40 is 15 whole minutes before 17:55 (end - frozen grace 5).
    expect(result.segments[1].earlyLeaveMinutes).toBe(15)
    expect(result.segments[1].status).toBe('early_leave')
    expect(result.segments[1].reasons).toEqual(['early_check_out'])
    expect(result.dailyProjection?.status).toBe('early_leave')
  })

  it('late_early inside one segment', () => {
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('09:20')),
        punch('ev-out-1', 'check_out', sh('11:00')),
        ...seg1Normal,
      ],
    })
    expect(result.segments[0]).toMatchObject({
      status: 'late_early',
      lateMinutes: 15,
      earlyLeaveMinutes: 55,
      reasons: ['early_check_out', 'late_check_in'],
    })
    expect(result.dailyProjection?.status).toBe('late_early')
  })

  it('rule 2 partial OUTRANKS rule 3 late_early when both apply on one day (lock 6.3 ordered rules — gate P2-2)', () => {
    // Gate finding P2-2: no existing leg observes the ORDER of §6.3 rules 2 and 3 — every
    // partial fixture is late/early-free and every late_early fixture is missing-free, so
    // swapping the two else-if branches left 126/126 green. This day has BOTH: seg0 is
    // late_early (in 09:12, out 11:50) and seg1 is missing_check_in (only a check-out) with
    // no excusing fact. The ordered rule set says an unexcused missing boundary makes the day
    // `partial` — the state that drives makeup-punch flows — never `late_early`.
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('09:12')),
        punch('ev-out-1', 'check_out', sh('11:50')),
        punch('ev-out-2', 'check_out', sh('17:00')),
      ],
    })
    expect(result.segments.map((s) => s.status)).toEqual(['late_early', 'missing_check_in'])
    expect(result.dailyProjection?.status).toBe('partial')
  })

  it('late plus early ACROSS segments also aggregates to late_early (lock 6.3 rule 3)', () => {
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('09:20')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        punch('ev-in-2', 'check_in', sh('12:59')),
        punch('ev-out-2', 'check_out', sh('17:30')),
      ],
    })
    expect(result.segments[0].status).toBe('late')
    expect(result.segments[1].status).toBe('early_leave')
    expect(result.dailyProjection?.status).toBe('late_early')
    expect(result.dailyProjection?.lateMinutes).toBe(15)
    expect(result.dailyProjection?.earlyLeaveMinutes).toBe(25)
  })

  it('missing_check_in / missing_check_out statuses and daily partial', () => {
    const onlyOut = run({
      evidence: [punch('ev-out-1', 'check_out', sh('12:01')), ...seg1Normal],
    })
    expect(onlyOut.segments[0]).toMatchObject({
      status: 'missing_check_in',
      reasons: ['missing_check_in'],
      workedMinutes: 0,
      actualInAt: null,
      actualOutAt: shIso(12, 1),
    })
    expect(onlyOut.dailyProjection?.status).toBe('partial')

    const onlyIn = run({
      evidence: [punch('ev-in-1', 'check_in', sh('08:58')), ...seg1Normal],
    })
    expect(onlyIn.segments[0]).toMatchObject({
      status: 'missing_check_out',
      reasons: ['missing_check_out'],
      workedMinutes: 0,
    })
    expect(onlyIn.dailyProjection?.status).toBe('partial')
  })

  it('missing boundaries synthesize no work; a fully absent workday is daily absent', () => {
    const result = run({ evidence: [] })
    expect(result.outcome).toBe('completed')
    expect(result.segments.map((s) => [s.status, s.workedMinutes])).toEqual([
      ['missing_both', 0],
      ['missing_both', 0],
    ])
    expect(result.segments[0].reasons).toEqual(['missing_both'])
    expect(result.dailyProjection).toMatchObject({
      firstInAt: null,
      lastOutAt: null,
      workedMinutes: 0,
      status: 'absent',
    })
  })

  it('a non-workday remains off with no anomaly minutes (lock 6.3)', () => {
    const result = run({
      context: makeContext({ isWorkday: false }),
      evidence: [
        punch('ev-in-1', 'check_in', sh('09:20')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        ...seg1Normal,
      ],
    })
    // Physical worked minutes stay segment-based: 160 + 300 = 460 raw, one
    // round-down pass at 15 -> 450. Anomaly minutes are suppressed on off days.
    expect(result.dailyProjection).toMatchObject({
      status: 'off',
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      workedMinutes: 450,
    })
  })

  it('one daily rounding pass over the raw segment sum (never per-segment, never on late/early)', () => {
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('09:00')),
        punch('ev-out-1', 'check_out', sh('11:52')),
        punch('ev-in-2', 'check_in', sh('13:00')),
        punch('ev-out-2', 'check_out', sh('17:40')),
      ],
    })
    // Raw segment minutes 172 + 280 = 452; ONE round-down pass at step 15
    // gives 450. Per-segment rounding would give 165 + 270 = 435.
    expect(result.segments[0].workedMinutes).toBe(172)
    expect(result.segments[1].workedMinutes).toBe(280)
    expect(result.dailyProjection?.workedMinutes).toBe(450)
    // Early totals are plain segment sums (3 + 15 = 18): a second rounding
    // pass at step 15 would report 15.
    expect(result.dailyProjection?.earlyLeaveMinutes).toBe(18)
  })

  it('daily late total keeps whole-minute precision (no rounding pass on late)', () => {
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('09:12')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        ...seg1Normal,
      ],
    })
    expect(result.dailyProjection?.lateMinutes).toBe(7)
    expect(result.dailyProjection?.status).toBe('late')
  })

  it('severe/absence tier fields derive from the final daily late total and FROZEN thresholds', () => {
    const severeOnly = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('10:00')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        ...seg1Normal,
      ],
    })
    // Late 55: >= severe 45, < absence 90.
    expect(severeOnly.dailyProjection?.lateMinutes).toBe(55)
    expect(severeOnly.dailyProjection?.meta).toEqual({
      severe_late_count: 1,
      severe_late_minutes: 55,
      absence_late_count: 0,
    })

    const betweenFrozenAndLegacyDefault = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('10:20')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        ...seg1Normal,
      ],
    })
    // Late 75: below the FROZEN absence threshold 90 (a legacy-default 60
    // reread would wrongly count an absence-tier day).
    expect(betweenFrozenAndLegacyDefault.dailyProjection?.lateMinutes).toBe(75)
    expect(betweenFrozenAndLegacyDefault.dailyProjection?.meta).toEqual({
      severe_late_count: 1,
      severe_late_minutes: 75,
      absence_late_count: 0,
    })

    const absenceTier = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('10:40')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        ...seg1Normal,
      ],
    })
    expect(absenceTier.dailyProjection?.lateMinutes).toBe(95)
    expect(absenceTier.dailyProjection?.meta).toEqual({
      severe_late_count: 1,
      severe_late_minutes: 95,
      absence_late_count: 1,
    })

    const disabled = run({
      context: makeContext({ severeLateThresholdMinutes: 0, absenceLateThresholdMinutes: 0 }),
      evidence: [
        punch('ev-in-1', 'check_in', sh('10:40')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        ...seg1Normal,
      ],
    })
    expect(disabled.dailyProjection?.meta).toEqual({
      severe_late_count: 0,
      severe_late_minutes: 0,
      absence_late_count: 0,
    })
  })

  it('deriveAttendanceLateTierFieldsV1 enforces tier nesting without resurrecting a disabled tier', () => {
    expect(deriveAttendanceLateTierFieldsV1(50, 45, 90)).toEqual({
      severe_late_count: 1,
      severe_late_minutes: 50,
      absence_late_count: 0,
    })
    // Incoherent persisted config (absence 40 < severe 45): nesting is
    // enforced with effectiveAbsence = max(absence, severe).
    expect(deriveAttendanceLateTierFieldsV1(44, 45, 40)).toEqual({
      severe_late_count: 0,
      severe_late_minutes: 0,
      absence_late_count: 0,
    })
    expect(deriveAttendanceLateTierFieldsV1(45, 45, 40)).toEqual({
      severe_late_count: 1,
      severe_late_minutes: 45,
      absence_late_count: 1,
    })
    expect(deriveAttendanceLateTierFieldsV1(200, 0, 0)).toEqual({
      severe_late_count: 0,
      severe_late_minutes: 0,
      absence_late_count: 0,
    })
  })

  it('roundAttendanceMinutesV1 is the exact legacy round-down', () => {
    expect(roundAttendanceMinutesV1(452, 15)).toBe(450)
    expect(roundAttendanceMinutesV1(452, 1)).toBe(452)
    expect(roundAttendanceMinutesV1(0, 15)).toBe(0)
    expect(roundAttendanceMinutesV1(-5, 15)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Midpoint ties, out-of-window, duplicates, ambiguity, reversed, overlap.
// ---------------------------------------------------------------------------

describe('calculateAttendanceSegmentsV1 — matching posture (lock 5.2/5.3)', () => {
  it('a check-in exactly on the in-partition midpoint belongs to the LATER segment', () => {
    // In-anchors 09:00/13:00 local -> midpoint 11:00 local exactly.
    const result = run({
      evidence: [punch('mid', 'check_in', sh('11:00')), punch('o2', 'check_out', sh('18:02'))],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0].status).toBe('missing_both')
    expect(result.segments[1].actualInAt).toBe(shIso(11, 0))
    expect(result.segments[1].matchedEvidenceRefs).toEqual(['mid', 'o2'])
    expect(result.dailyProjection?.status).toBe('partial')
  })

  it('evidence outside the frozen attribution window is review (never silently ignored, OD-W4C-18)', () => {
    const result = run({
      evidence: [punch('stale', 'check_in', '2026-06-30T10:00:00+08:00'), ...fullDayEvidence],
    })
    expect(result).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'evidence_outside_attribution_window',
      segments: [],
      dailyProjection: null,
    })
  })

  it('two check-in candidates in one directional cell are duplicate_check_in (never collapsed, W4C-R2)', () => {
    const result = run({
      evidence: [
        punch('dup-a', 'check_in', sh('08:50')),
        punch('dup-b', 'check_in', sh('09:10')),
        punch('ev-out-1', 'check_out', sh('12:01')),
      ],
    })
    expect(result).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'duplicate_check_in',
      segments: [],
      dailyProjection: null,
    })
  })

  it('identical-instant duplicates are still duplicates (no earliest/latest tie-break exists)', () => {
    const result = run({
      evidence: [punch('dup-a', 'check_in', sh('09:00')), punch('dup-b', 'check_in', sh('09:00'))],
    })
    expect(result.outcomeReasonCode).toBe('duplicate_check_in')
  })

  it('two check-out candidates in one cell are duplicate_check_out', () => {
    const result = run({
      evidence: [
        punch('ev-in-2', 'check_in', sh('12:59')),
        punch('dup-a', 'check_out', sh('17:50')),
        punch('dup-b', 'check_out', sh('18:02')),
      ],
    })
    expect(result.outcomeReasonCode).toBe('duplicate_check_out')
  })

  it('duplicates in BOTH directions escalate to ambiguous_segment_match (precedence, lock 5.3)', () => {
    const result = run({
      evidence: [
        punch('dup-in-a', 'check_in', sh('08:50')),
        punch('dup-in-b', 'check_in', sh('09:10')),
        punch('dup-out-a', 'check_out', sh('17:50')),
        punch('dup-out-b', 'check_out', sh('18:02')),
      ],
    })
    expect(result.outcomeReasonCode).toBe('ambiguous_segment_match')
  })

  it('reversed evidence (in >= out in one segment) is invalid_evidence_order', () => {
    const reversed = run({
      evidence: [punch('a', 'check_in', sh('10:00')), punch('b', 'check_out', sh('09:30'))],
    })
    expect(reversed.outcomeReasonCode).toBe('invalid_evidence_order')
    expect(reversed.segments).toEqual([])

    const equal = run({
      evidence: [punch('a', 'check_in', sh('10:00')), punch('b', 'check_out', sh('10:00'))],
    })
    expect(equal.outcomeReasonCode).toBe('invalid_evidence_order')
  })

  it('cross-segment actual-interval overlap is review (W4C-R20; no clipping, no reassignment)', () => {
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('08:58')),
        punch('ev-out-1', 'check_out', sh('13:30')),
        punch('ev-in-2', 'check_in', sh('13:00')),
        punch('ev-out-2', 'check_out', sh('18:02')),
      ],
    })
    expect(result).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'overlapping_actual_intervals',
      segments: [],
      dailyProjection: null,
    })
  })

  it('touching actual intervals (out_i == in_(i+1)) are allowed', () => {
    const result = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('08:58')),
        punch('ev-out-1', 'check_out', sh('12:40')),
        punch('ev-in-2', 'check_in', sh('12:40')),
        punch('ev-out-2', 'check_out', sh('18:02')),
      ],
    })
    expect(result.outcome).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// DST: gap, unshared fold choices, shared-fold-boundary review.
// ---------------------------------------------------------------------------

describe('calculateAttendanceSegmentsV1 — DST (lock 5.1)', () => {
  const nyWindows = {
    absoluteWindow: { startAt: '2026-03-07T00:00:00Z', endAt: '2026-03-09T23:00:00Z' },
    attributionWindow: { startAt: '2026-03-07T00:00:00Z', endAt: '2026-03-09T23:00:00Z' },
  }
  const nyFallWindows = {
    absoluteWindow: { startAt: '2026-10-31T00:00:00Z', endAt: '2026-11-02T23:00:00Z' },
    attributionWindow: { startAt: '2026-10-31T00:00:00Z', endAt: '2026-11-02T23:00:00Z' },
  }

  it('a spring-forward gap boundary is review dst_gap_local_time (never resolved in UTC, W4C-R3)', () => {
    const result = run({
      context: makeContext({
        timezone: 'America/New_York',
        workDate: '2026-03-08',
        segments: [seg(0, '02:30', '10:00')],
      }),
      attribution: makeAttribution({ workDate: '2026-03-08', ...nyWindows }),
    })
    expect(result).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'dst_gap_local_time',
      segments: [],
      dailyProjection: null,
    })
  })

  it('an unshared fold START freezes the EARLIER instant with dst_fold_start_earlier', () => {
    const result = run({
      context: makeContext({
        timezone: 'America/New_York',
        workDate: '2026-11-01',
        segments: [seg(0, '01:30', '09:00')],
      }),
      attribution: makeAttribution({ workDate: '2026-11-01', ...nyFallWindows }),
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0]).toMatchObject({
      expectedStartAt: new Date(Date.UTC(2026, 10, 1, 5, 30, 0)).toISOString(),
      expectedStartOffsetMinutes: -240,
      expectedStartFold: 'fold_earlier',
      expectedEndAt: new Date(Date.UTC(2026, 10, 1, 14, 0, 0)).toISOString(),
      expectedEndOffsetMinutes: -300,
      expectedEndFold: 'unique',
      status: 'missing_both',
    })
    expect(result.segments[0].reasons).toEqual(['dst_fold_start_earlier', 'missing_both'])
  })

  it('an unshared fold END freezes the LATER instant with dst_fold_end_later (and pays the full repeated hour)', () => {
    const result = run({
      context: makeContext({
        timezone: 'America/New_York',
        workDate: '2026-11-01',
        segments: [seg(0, '00:30', '01:45')],
      }),
      attribution: makeAttribution({ workDate: '2026-11-01', ...nyFallWindows }),
      evidence: [
        punch('a', 'check_in', '2026-11-01T00:30:00-04:00'),
        punch('b', 'check_out', '2026-11-01T01:45:00-05:00'),
      ],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0]).toMatchObject({
      expectedStartAt: new Date(Date.UTC(2026, 10, 1, 4, 30, 0)).toISOString(),
      expectedStartFold: 'unique',
      expectedEndAt: new Date(Date.UTC(2026, 10, 1, 6, 45, 0)).toISOString(),
      expectedEndOffsetMinutes: -300,
      expectedEndFold: 'fold_later',
      // 04:30Z -> 06:45Z: choosing the earlier end (05:45Z) would pay only 75.
      workedMinutes: 135,
      status: 'normal',
    })
    expect(result.segments[0].reasons).toEqual(['dst_fold_end_later', 'within_window'])
  })

  it('a fold boundary SHARED by E_i and S_(i+1) is review dst_fold_shared_boundary_ambiguous', () => {
    const result = run({
      context: makeContext({
        timezone: 'America/New_York',
        workDate: '2026-11-01',
        segments: [seg(0, '00:00', '01:30'), seg(1, '01:30', '03:00')],
      }),
      attribution: makeAttribution({ workDate: '2026-11-01', ...nyFallWindows }),
    })
    expect(result).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'dst_fold_shared_boundary_ambiguous',
      segments: [],
      dailyProjection: null,
    })
  })

  it('an invalid or offset-form context timezone is review invalid_timezone (no UTC fallback)', () => {
    for (const timezone of ['America/Not_A_City', '+08:00']) {
      const result = run({ context: makeContext({ timezone }), evidence: fullDayEvidence })
      expect(result).toEqual({
        outcome: 'review_required',
        outcomeReasonCode: 'invalid_timezone',
        segments: [],
        dailyProjection: null,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Approved facts: full/partial leave, overtime with/without punch, corrections.
// ---------------------------------------------------------------------------

describe('calculateAttendanceSegmentsV1 — approved facts (lock 4.4)', () => {
  const seg1Normal = [punch('ev-in-2', 'check_in', sh('12:59')), punch('ev-out-2', 'check_out', sh('18:02'))]

  it('bounded leave fully covering a segment excuses it; physical missing stays visible', () => {
    const result = run({
      evidence: seg1Normal,
      approvedFacts: [leaveFact('req-leave', sh('09:00'), sh('12:00'), 180)],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0]).toMatchObject({
      status: 'missing_both',
      excusedByLeave: true,
      workedMinutes: 0,
      reasons: ['approved_leave_overlay', 'missing_both'],
    })
    // Excused missing is not an anomaly: the approved fact changed the result.
    expect(result.dailyProjection).toMatchObject({ status: 'adjusted', workedMinutes: 300 })
  })

  it('leave fully covering EVERY segment with no anomaly yields daily adjusted with zero fabricated work', () => {
    const result = run({
      approvedFacts: [leaveFact('req-leave', sh('09:00'), sh('18:00'), 480)],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments.map((s) => [s.excusedByLeave, s.workedMinutes])).toEqual([
      [true, 0],
      [true, 0],
    ])
    expect(result.dailyProjection).toMatchObject({ status: 'adjusted', workedMinutes: 0 })
  })

  it('PARTIAL bounded leave coverage cannot excuse a segment: review approved_fact_conflict', () => {
    const result = run({
      evidence: seg1Normal,
      approvedFacts: [leaveFact('req-leave', sh('09:00'), sh('10:30'), 90)],
    })
    expect(result).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'approved_fact_conflict',
      segments: [],
      dailyProjection: null,
    })
  })

  it('minutes_only_unbounded leave/overtime is review approved_fact_conflict (cannot excuse or extend)', () => {
    for (const fact of [
      {
        ...factBase('req-unbounded'),
        kind: 'leave',
        leaveType: 'annual',
        coverage: { kind: 'minutes_only_unbounded', minutes: 120, source: 'explicit_minutes' },
      },
      {
        ...factBase('req-unbounded'),
        kind: 'overtime',
        coverage: { kind: 'minutes_only_unbounded', minutes: 60, source: 'policy_default' },
      },
    ] as ApprovedAttendanceFactV1[]) {
      const result = run({ evidence: fullDayEvidence, approvedFacts: [fact] })
      expect(result.outcomeReasonCode).toBe('approved_fact_conflict')
      expect(result.outcome).toBe('review_required')
    }
  })

  it('bounded approved overtime WITH a punch extends payable time, clipped to the exact approved interval', () => {
    const withinApproval = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('08:58')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        punch('ev-in-2', 'check_in', sh('12:59')),
        punch('ev-out-2', 'check_out', sh('18:40')),
      ],
      approvedFacts: [overtimeFact('req-ot', sh('18:00'), sh('19:00'), 60)],
    })
    expect(withinApproval.outcome).toBe('completed')
    expect(withinApproval.segments[1]).toMatchObject({
      workedMinutes: 340,
      overtimeExtensionMinutes: 40,
    })
    expect(withinApproval.segments[1].reasons).toContain('approved_overtime_overlay')
    // 180 + 340 = 520 raw; one daily round-down pass at 15 -> 510.
    expect(withinApproval.dailyProjection).toMatchObject({ status: 'adjusted', workedMinutes: 510 })

    const beyondApproval = run({
      evidence: [
        punch('ev-in-1', 'check_in', sh('08:58')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        punch('ev-in-2', 'check_in', sh('12:59')),
        punch('ev-out-2', 'check_out', sh('19:30')),
      ],
      approvedFacts: [overtimeFact('req-ot', sh('18:00'), sh('19:00'), 60)],
    })
    // The extension is clipped to the approved 60 minutes even though the
    // punch ran to 19:30.
    expect(beyondApproval.segments[1]).toMatchObject({
      workedMinutes: 360,
      overtimeExtensionMinutes: 60,
    })
  })

  it('approved overtime WITHOUT a punch contributes zero physical work (no fabrication)', () => {
    const result = run({
      approvedFacts: [overtimeFact('req-ot', sh('18:00'), sh('19:00'), 60)],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments.map((s) => s.workedMinutes)).toEqual([0, 0])
    expect(result.segments.map((s) => s.overtimeExtensionMinutes)).toEqual([0, 0])
    expect(result.dailyProjection).toMatchObject({ status: 'absent', workedMinutes: 0 })
  })

  it('an approved correction supersedes its named evidence ref and applies the adjustment boundary', () => {
    const result = run({
      evidence: [
        punch('ev-late', 'check_in', sh('09:20')),
        adjustment('adj-1', 'check_in', sh('08:59')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        ...seg1Normal,
      ],
      approvedFacts: [correctionFact('req-fix', 'check_in', sh('08:59'), 'ev-late')],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0]).toMatchObject({
      actualInAt: shIso(8, 59),
      lateMinutes: 0,
      status: 'normal',
      matchedEvidenceRefs: ['adj-1', 'ev-out-1'],
      unmatchedEvidenceRefs: ['ev-late'],
    })
    expect(result.segments[0].reasons).toEqual(['approved_correction_applied', 'within_window'])
    expect(result.dailyProjection?.status).toBe('adjusted')
  })

  it('correcting an out-of-window punch removes it BEFORE the window check (no strand-in-review)', () => {
    const result = run({
      evidence: [
        punch('ev-stale', 'check_in', '2026-06-30T10:00:00+08:00'),
        adjustment('adj-1', 'check_in', sh('08:58')),
        punch('ev-out-1', 'check_out', sh('12:01')),
        ...seg1Normal,
      ],
      approvedFacts: [correctionFact('req-fix', 'check_in', sh('08:58'), 'ev-stale')],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments[0].actualInAt).toBe(shIso(8, 58))
  })
})

// ---------------------------------------------------------------------------
// Frozen-context posture, identity, ordering invariants, closed-set ingress.
// ---------------------------------------------------------------------------

describe('calculateAttendanceSegmentsV1 — frozen context and closed ingress', () => {
  it('null frozen context is review missing_frozen_context', () => {
    expect(run({ context: null })).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'missing_frozen_context',
      segments: [],
      dailyProjection: null,
    })
  })

  it('unsupported attribution maps to its closed review reasons', () => {
    const unsupported = (reason: 'legacy_v1' | 'missing' | 'ambiguous' | 'unresolved') =>
      ({
        posture: 'unsupported',
        sourceSchemaVersion: reason === 'legacy_v1' ? 1 : null,
        reason,
        sourceFingerprint: null,
      }) as AttendanceAttributionSnapshotV1
    expect(run({ attribution: unsupported('legacy_v1') }).outcomeReasonCode).toBe(
      'legacy_attribution_not_upgradeable',
    )
    expect(run({ attribution: unsupported('ambiguous') }).outcomeReasonCode).toBe(
      'context_resolution_ambiguous',
    )
    expect(run({ attribution: unsupported('missing') }).outcomeReasonCode).toBe('missing_frozen_context')
    expect(run({ attribution: unsupported('unresolved') }).outcomeReasonCode).toBe(
      'missing_frozen_context',
    )
  })

  it('attribution/context identity drift is review context_mismatch', () => {
    for (const drift of [
      { userId: 'user-2' },
      { orgId: 'org-2' },
      { workDate: '2026-07-02' },
      { shiftId: 'shift-2' },
    ]) {
      expect(run({ attribution: makeAttribution(drift) }).outcomeReasonCode).toBe('context_mismatch')
    }
  })

  it('segment ordering invariants: E_i <= S_(i+1) and S_i < E_i (lock 5.2)', () => {
    const overlappingPlan = run({
      context: makeContext({ segments: [seg(0, '09:00', '12:00'), seg(1, '11:30', '18:00')] }),
    })
    expect(overlappingPlan.outcomeReasonCode).toBe('invalid_segment_order')

    const inverted = run({ context: makeContext({ segments: [seg(0, '12:00', '12:00')] }) })
    expect(inverted.outcomeReasonCode).toBe('invalid_segment_order')
  })

  it('planned boundaries outside the frozen absoluteWindow are invalid_segment_order', () => {
    const result = run({
      attribution: makeAttribution({
        absoluteWindow: { startAt: '2026-06-30T16:00:00Z', endAt: '2026-07-01T09:00:00Z' },
      }),
    })
    expect(result.outcomeReasonCode).toBe('invalid_segment_order')
  })

  it('offset-less business times cannot enter a completed W4 calculation (§12.2 strict ingress)', () => {
    const offsetLess = run({
      evidence: [
        { kind: 'punch', ref: 'x', direction: 'check_in', occurredAt: '2026-07-01 09:00:00', source: 'attendance_event' } as never,
      ],
    })
    expect(offsetLess).toEqual({
      outcome: 'review_required',
      outcomeReasonCode: 'input_schema_invalid',
      segments: [],
      dailyProjection: null,
    })
    const offsetLessIso = run({
      evidence: [
        { kind: 'punch', ref: 'x', direction: 'check_in', occurredAt: '2026-07-01T09:00:00', source: 'attendance_event' } as never,
      ],
    })
    expect(offsetLessIso.outcomeReasonCode).toBe('input_schema_invalid')
  })

  it.each([
    [
      'unknown evidence kind',
      { evidence: [{ kind: 'badge_swipe', ref: 'x' }] },
    ],
    [
      'unknown punch direction',
      { evidence: [{ kind: 'punch', ref: 'x', direction: 'check_around', occurredAt: sh('09:00'), source: 'attendance_event' }] },
    ],
    [
      'unknown punch source',
      { evidence: [{ kind: 'punch', ref: 'x', direction: 'check_in', occurredAt: sh('09:00'), source: 'mobile_app' }] },
    ],
    [
      'approved_adjustment with non-correction source',
      { evidence: [{ kind: 'approved_adjustment', ref: 'x', direction: 'check_in', occurredAt: sh('09:00'), source: 'import' }] },
    ],
    [
      'unknown extra key on punch',
      { evidence: [{ kind: 'punch', ref: 'x', direction: 'check_in', occurredAt: sh('09:00'), source: 'attendance_event', deviceId: 'd1' }] },
    ],
    [
      'duplicate evidence refs',
      { evidence: [
        { kind: 'punch', ref: 'x', direction: 'check_in', occurredAt: sh('09:00'), source: 'attendance_event' },
        { kind: 'punch', ref: 'x', direction: 'check_out', occurredAt: sh('18:00'), source: 'attendance_event' },
      ] },
    ],
    [
      'scheduled_absence with extra key',
      { evidence: [{ kind: 'scheduled_absence', ref: 'x', occurredAt: sh('09:00') }] },
    ],
    [
      'unknown fact kind',
      { approvedFacts: [{ ...factBase('r'), kind: 'bonus' }] },
    ],
    [
      'unknown coverage kind',
      { approvedFacts: [{ ...factBase('r'), kind: 'leave', leaveType: 'annual', coverage: { kind: 'ratio', value: 0.5 } }] },
    ],
    [
      'unknown unbounded coverage source',
      { approvedFacts: [{ ...factBase('r'), kind: 'leave', leaveType: 'annual', coverage: { kind: 'minutes_only_unbounded', minutes: 60, source: 'guessed' } }] },
    ],
    [
      'reversal fact reaching the calculator',
      { approvedFacts: [{ ...factBase('r'), kind: 'reversal', reversesApprovalRecordId: '100' }] },
    ],
    [
      'correction fact without supersededEvidenceRef',
      { approvedFacts: [{ ...factBase('r'), kind: 'correction', direction: 'check_in', occurredAt: sh('09:00') }] },
    ],
    [
      'bounded coverage with reversed interval',
      { approvedFacts: [{ ...factBase('r'), kind: 'leave', leaveType: 'annual', coverage: { kind: 'bounded_interval', startAt: sh('12:00'), endAt: sh('09:00'), minutes: 180 } }] },
    ],
    [
      'context selector outside the closed set',
      { context: makeContext({ selector: 'modern' as never }) },
    ],
    [
      'context with calculation-group consumption (W4C-R7)',
      { context: makeContext({ calculationGroupId: 'group-1' as never }) },
    ],
    [
      'segment-specific grace injection (W4C-R28)',
      { context: makeContext({ segments: [seg(0, '09:00', '12:00'), { ...seg(1, '13:00', '18:00'), lateGraceMinutes: 30 }] }) },
    ],
    [
      'non-positive roundingMinutes',
      { context: makeContext({ roundingMinutes: 0 }) },
    ],
    [
      'tier nesting violation: severe below max grace',
      { context: makeContext({ severeLateThresholdMinutes: 3 }) },
    ],
    [
      'tier nesting violation: absence below severe',
      { context: makeContext({ absenceLateThresholdMinutes: 40 }) },
    ],
    [
      'empty timezone string',
      { context: makeContext({ timezone: '' }) },
    ],
    [
      'more than three segments',
      { context: makeContext({ segments: [seg(0, '08:00', '09:00'), seg(1, '10:00', '11:00'), seg(2, '12:00', '13:00'), { ...seg(2, '14:00', '15:00'), index: 3 }] as never }) },
    ],
    [
      'unknown attribution source',
      { attribution: makeAttribution({ source: 'inferred' }) },
    ],
    [
      'unknown unsupported-attribution reason',
      { attribution: { posture: 'unsupported', sourceSchemaVersion: null, reason: 'other', sourceFingerprint: null } },
    ],
    [
      'attribution window with offset-less boundary',
      { attribution: makeAttribution({ attributionWindow: { startAt: '2026-06-30T20:00:00', endAt: '2026-07-01T20:00:00Z' } }) },
    ],
  ] as Array<[string, Record<string, unknown>]>)(
    'unknown/invalid closed-set member fails closed as input_schema_invalid: %s',
    (_label, overrides) => {
      const result = calculateAttendanceSegmentsV1({
        attribution: makeAttribution(),
        context: makeContext(),
        evidence: [],
        approvedFacts: [],
        ...(overrides as Partial<AttendanceSegmentCalculationInputV1>),
      })
      expect(result).toEqual({
        outcome: 'review_required',
        outcomeReasonCode: 'input_schema_invalid',
        segments: [],
        dailyProjection: null,
      })
    },
  )
})

// ---------------------------------------------------------------------------
// W4C-2 first-batch hardening legs (#4607 gate handover P3-1 / P3-2 / P3-5).
// These ride the W4C-2 slice by explicit gate-review instruction; fixtures are
// the review's own pre-verified discriminating shapes (head green/mutation red).
// ---------------------------------------------------------------------------

describe('calculateAttendanceSegmentsV1 — W4C-2 hardening legs (#4607 handover)', () => {
  it('P3-2: a HALF-paired segment (check_in only) with bounded approved overtime contributes zero worked and zero overtime minutes; the day is partial', () => {
    // seg0 has only a check_in; the bounded OT interval extends past seg0's
    // planned end. A mutation that counts the OT span on a single-sided
    // segment (gate M39) fabricates minutes here and flips this leg.
    const result = run({
      evidence: [punch('half-in-0', 'check_in', sh('09:00'))],
      approvedFacts: [overtimeFact('req-ot-half', sh('12:00'), sh('12:30'), 30)],
    })
    expect(result.outcome).toBe('completed')
    expect(result.outcomeReasonCode).toBe('calculated')
    expect(result.segments.map((s) => [s.status, s.workedMinutes, s.overtimeExtensionMinutes])).toEqual([
      ['missing_check_out', 0, 0],
      ['missing_both', 0, 0],
    ])
    expect(result.dailyProjection).toEqual({
      firstInAt: shIso(9, 0),
      lastOutAt: null,
      workedMinutes: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      status: 'partial',
      timezone: 'Asia/Shanghai',
      workDate: '2026-07-01',
      meta: { severe_late_count: 0, severe_late_minutes: 0, absence_late_count: 0 },
    })
  })

  it('P3-1: raw 470 daily worked rounds ONCE to 465 under the frozen step 15 — exclusive against every realistic mutation target', () => {
    // Raw segment minutes 164 + 306 = 470. Correct behavior (single daily
    // floor at the FROZEN roundingMinutes=15) gives 465. Every named
    // alternative lands elsewhere:
    //   - reread legacy default step 30            -> 450
    //   - reread step 10 / step 5 / no rounding    -> 470
    //   - per-segment rounding at 15 (150 + 300)   -> 450
    const context = makeContext({ segments: [seg(0, '09:00', '12:00'), seg(1, '13:00', '19:00')] })
    const result = run({
      context,
      evidence: [
        punch('r470-in-0', 'check_in', sh('09:16')),
        punch('r470-out-0', 'check_out', sh('12:00')),
        punch('r470-in-1', 'check_in', sh('13:54')),
        punch('r470-out-1', 'check_out', sh('19:00')),
      ],
    })
    expect(result.outcome).toBe('completed')
    expect(result.segments.map((s) => [s.status, s.workedMinutes, s.lateMinutes, s.earlyLeaveMinutes])).toEqual([
      ['late', 164, 11, 0],
      ['late', 306, 49, 0],
    ])
    expect(result.dailyProjection).toEqual({
      firstInAt: shIso(9, 16),
      lastOutAt: shIso(19, 0),
      workedMinutes: 465,
      lateMinutes: 60,
      earlyLeaveMinutes: 0,
      status: 'late',
      timezone: 'Asia/Shanghai',
      workDate: '2026-07-01',
      meta: { severe_late_count: 1, severe_late_minutes: 60, absence_late_count: 0 },
    })
  })

  it('P3-5: positive control — contract-valid instances of the negative-only union variants complete (scheduled_absence evidence, outdoor_punch fact, import/outdoor punch sources, non-null holidayKind)', () => {
    // If the calculator's exact-key arrays drifted one character from the
    // w4c0-write-boundary-types unions, these CONTRACT-VALID instances would
    // fail closed as input_schema_invalid and the leave/outdoor/import named
    // paths would silently go review-only. tsc checks the contract side; the
    // run checks the calculator side.
    const context = makeContext({ holidayKind: 'company_special_workday' })
    const evidence: AttendanceEvidenceV1[] = [
      { kind: 'punch', ref: 'imported-in', direction: 'check_in', occurredAt: sh('09:00'), source: 'import' },
      { kind: 'punch', ref: 'outdoor-out', direction: 'check_out', occurredAt: sh('12:00'), source: 'outdoor_approval' },
      { kind: 'punch', ref: 'ev-in-2', direction: 'check_in', occurredAt: sh('13:00'), source: 'attendance_event' },
      { kind: 'approved_adjustment', ref: 'adj-out-2', direction: 'check_out', occurredAt: sh('18:00'), source: 'correction' },
      { kind: 'scheduled_absence', ref: 'sched-run-1' },
    ]
    const facts: ApprovedAttendanceFactV1[] = [
      {
        kind: 'outdoor_punch',
        requestId: 'req-outdoor',
        requestSnapshotVersion: 2,
        requestSnapshotFingerprint: 'b'.repeat(64),
        approvalVersion: 4,
        approvalRecordId: '202',
        direction: 'check_out',
        occurredAt: sh('12:00'),
      },
    ]
    const result = run({ context, evidence, approvedFacts: facts })
    expect(result.outcomeReasonCode).not.toBe('input_schema_invalid')
    expect(result.outcome).toBe('completed')
    expect(result.segments.map((s) => [s.status, s.workedMinutes])).toEqual([
      ['normal', 180],
      ['normal', 300],
    ])
    expect(result.dailyProjection?.workedMinutes).toBe(480)
  })
})
