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
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  ApprovedAttendanceFactV1,
  AttendanceEvidenceV1,
} from '../w4c0-write-boundary-types'
import { calculateAttendanceSegmentsV1 } from '../w4c1-segment-calculator'
import {
  ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1,
  ATTENDANCE_W4C2_WRITE_PROBE_PRESENTED_CODE_V1,
  AttendanceW4ShadowExpectedDifferenceError,
  assertAttendanceW4C2RosterV1,
  isExpectedAttendanceShadowDifferenceV1,
  isExpectedAttendanceW4C2ReadSideDifferenceV1,
  parseAttendanceW4C2ReadSideProbeV1,
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
  it('roster is exactly the three ratified entries — (id, code, evaluator) whole-array equality', () => {
    // Pin CHANGED deliberately under owner ruling issue-4556.comment-5317181927 (entries 2-3;
    // mechanism per issue-4556.comment-5322708492) — 测试冻结≠批准: the ruling, not this test,
    // authorizes the membership; a FOURTH entry still reds this pin.
    expect(
      ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1.map((entry) => [entry.id, entry.shadowDiffCode, entry.evaluator]),
    ).toEqual([
      ['correction_applied_daily_adjusted', 'status_changed', 'write_probe_v1'],
      ['transient_partial_day_in_only_late', 'late_minutes_mismatch', 'read_convergence_v1'],
      ['transient_partial_day_out_only_early_leave', 'early_leave_minutes_mismatch', 'read_convergence_v1'],
    ])
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

  // ---- read-convergence mechanism (entries 2-3; ruling issue-4556.comment-5317181927) ----

  const READ_PROBE_IN_ONLY = {
    shadowDiffCode: 'late_minutes_mismatch',
    changedFields: ['lateMinutes'],
    projectedStatus: 'partial',
    projectedFirstInPresent: true,
    projectedLastOutPresent: false,
    absoluteMinuteDelta: 90,
    projectedLateMinutes: 90,
    projectedEarlyLeaveMinutes: 0,
    convergedToEqual: true,
  } as const

  const READ_PROBE_OUT_ONLY = {
    shadowDiffCode: 'early_leave_minutes_mismatch',
    changedFields: ['earlyLeaveMinutes'],
    projectedStatus: 'partial',
    projectedFirstInPresent: false,
    projectedLastOutPresent: true,
    absoluteMinuteDelta: 45,
    projectedLateMinutes: 0,
    projectedEarlyLeaveMinutes: 45,
    convergedToEqual: true,
  } as const

  it('read evaluator accepts BOTH converged one-boundary lifecycles (in-only late; out-only early-leave)', () => {
    expect(isExpectedAttendanceW4C2ReadSideDifferenceV1(READ_PROBE_IN_ONLY)).toBe(true)
    expect(isExpectedAttendanceW4C2ReadSideDifferenceV1(READ_PROBE_OUT_ONLY)).toBe(true)
  })

  it('read evaluator DEPARTURE MATRIX — every single-conjunct departure from the in-only accept flips to false', () => {
    const departures: Array<[string, Record<string, unknown>]> = [
      ['not converged (open day at a window edge)', { ...READ_PROBE_IN_ONLY, convergedToEqual: false }],
      ['completed day (both boundaries present) — a genuine miscalculation shape', { ...READ_PROBE_IN_ONLY, projectedLastOutPresent: true }],
      ['no boundary at all', { ...READ_PROBE_IN_ONLY, projectedFirstInPresent: false }],
      ['delta does not equal the witness minutes', { ...READ_PROBE_IN_ONLY, absoluteMinuteDelta: 91 }],
      ['witness minutes zero', { ...READ_PROBE_IN_ONLY, absoluteMinuteDelta: 0, projectedLateMinutes: 0 }],
      ['other minute field nonzero', { ...READ_PROBE_IN_ONLY, projectedEarlyLeaveMinutes: 5 }],
      ['other minute field null', { ...READ_PROBE_IN_ONLY, projectedEarlyLeaveMinutes: null }],
      ['status not partial', { ...READ_PROBE_IN_ONLY, projectedStatus: 'late' }],
      ['status null (incomplete projection)', { ...READ_PROBE_IN_ONLY, projectedStatus: null }],
      ['extra changed field', { ...READ_PROBE_IN_ONLY, changedFields: ['status', 'lateMinutes'] }],
      ['wrong code for the shape', { ...READ_PROBE_IN_ONLY, shadowDiffCode: 'work_minutes_mismatch', changedFields: ['workMinutes'] }],
    ]
    for (const [label, probe] of departures) {
      expect(isExpectedAttendanceW4C2ReadSideDifferenceV1(probe), label).toBe(false)
    }
  })

  it('read probe parser fails closed on malformed input (missing/extra keys, out-of-domain values, non-canonical field order)', () => {
    const bad: unknown[] = [
      null,
      [],
      {},
      { ...READ_PROBE_IN_ONLY, extra: 1 },
      (() => { const { convergedToEqual: _omitted, ...rest } = READ_PROBE_IN_ONLY; return rest })(),
      { ...READ_PROBE_IN_ONLY, shadowDiffCode: 'not_a_code' },
      { ...READ_PROBE_IN_ONLY, changedFields: ['lateMinutes', 'lateMinutes'] },
      { ...READ_PROBE_IN_ONLY, changedFields: ['lateMinutes', 'status'] }, // non-canonical order
      { ...READ_PROBE_IN_ONLY, absoluteMinuteDelta: -1 },
      { ...READ_PROBE_IN_ONLY, projectedLateMinutes: 1.5 },
      { ...READ_PROBE_IN_ONLY, convergedToEqual: 'yes' },
    ]
    for (const probe of bad) {
      expect(() => isExpectedAttendanceW4C2ReadSideDifferenceV1(probe)).toThrowError(
        AttendanceW4ShadowExpectedDifferenceError,
      )
    }
  })

  it('write predicate presented code is DERIVED from the roster write entry (no floating literal)', () => {
    expect(ATTENDANCE_W4C2_WRITE_PROBE_PRESENTED_CODE_V1).toBe('status_changed')
    // Behaviour-identity pin: the write predicate still accepts exactly the entry-1 probe.
    expect(isExpectedAttendanceShadowDifferenceV1(EXPECTED_PROBE)).toBe(true)
  })

  it('module-load roster assert fails closed on every invalid roster shape (driven against synthetic rosters)', () => {
    const write = ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1[0]
    const readIn = ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1[1]
    const expectInvalid = (roster: unknown, label: string) => {
      expect(
        () => assertAttendanceW4C2RosterV1(roster as never),
        label,
      ).toThrowError(AttendanceW4ShadowExpectedDifferenceError)
    }
    // shipped roster passes (positive control)
    expect(() => assertAttendanceW4C2RosterV1(ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1)).not.toThrow()
    expectInvalid([write, write], 'duplicate ids')
    expectInvalid([readIn], 'zero write entries')
    expectInvalid([write, { ...write, id: 'second-write' }], 'two write entries')
    expectInvalid([write, { ...readIn, shadowDiffCode: 'review_required' }], 'read entry on a CRITICAL code')
    expectInvalid([write, { ...readIn, shadowDiffCode: 'equal' }], 'read entry on equal')
    expectInvalid(
      [write, { ...readIn, shadowDiffCode: 'status_changed' }],
      'SAFETY: read entry sharing the write presented code (would re-arm the relabel branch)',
    )
    expectInvalid([write, { ...readIn, minuteWitness: undefined }], 'read entry missing minuteWitness')
    expectInvalid([write, { ...readIn, readProbeCore: undefined }], 'read entry missing readProbeCore')
    expectInvalid([{ ...write, minuteWitness: 'late' }, readIn], 'write entry carrying a read-only field')
    expectInvalid([write, { ...readIn, ratifiedBy: 'no issue ref' }], 'implausible ratifiedBy')
    expectInvalid([write, { ...readIn, evaluator: 'other_v1' }], 'unknown evaluator')
  })

  it('read evaluator is roster-driven: an empty-read roster accepts nothing; a synthetic roster decides', () => {
    expect(isExpectedAttendanceW4C2ReadSideDifferenceV1(READ_PROBE_IN_ONLY, [ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1[0]])).toBe(false)
    const parsed = parseAttendanceW4C2ReadSideProbeV1(READ_PROBE_IN_ONLY)
    expect(parsed.shadowDiffCode).toBe('late_minutes_mismatch')
  })

  it('CROSS-FILE DRIFT PIN (#4969 gate P2-1): the boundary relabel target literal equals the derived presented code', () => {
    // The boundary rewrite (reading the matched entry) is a SEPARATE, already-flagged
    // change; until it lands, this pin makes the two sites un-driftable: the gate proved a
    // mutation of the relabel literal to a CRITICAL code left every other test green — this
    // leg is the one that reds it.
    const here = dirname(fileURLToPath(import.meta.url))
    const boundarySource = readFileSync(
      join(here, '..', 'w4c2-live-scheduled-boundary.ts'),
      'utf8',
    )
    const relabel = boundarySource.match(/\{ \.\.\.shadowDiffCandidate, code: '([a-z_]+)' as const \}/)
    expect(relabel, 'the relabel branch must exist in the boundary').not.toBeNull()
    expect(relabel?.[1]).toBe(ATTENDANCE_W4C2_WRITE_PROBE_PRESENTED_CODE_V1)
  })

  it('read evaluator CODE conjunct is load-bearing in isolation (#4969 gate P3: parser-passable wrong-code probe with the SAME changedFields)', () => {
    // expected_break_exclusion permits arbitrary non-empty changedFields through the read
    // parser, so this probe differs from the in-only accept ONLY in its code — isolating
    // the code conjunct the departure matrix could not reach.
    expect(
      isExpectedAttendanceW4C2ReadSideDifferenceV1({
        ...READ_PROBE_IN_ONLY,
        shadowDiffCode: 'expected_break_exclusion',
      }),
    ).toBe(false)
  })
})
