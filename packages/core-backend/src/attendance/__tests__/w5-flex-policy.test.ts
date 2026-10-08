/**
 * W5 (#4556) — pure flex policy validation and expectation resolution
 * (design lock §3.3 / §9.6 synthetic legs).
 *
 * Core hours: authoring guarantee only — every allowed clamped interval covers
 * core. No runtime reasonCode is invented.
 */
import { describe, expect, it } from 'vitest'
import {
  flexCoreHoursCoveredByAllClampedIntervalsV1,
  normalizeAttendanceFlexPolicyV1,
  resolveAttendanceFlexExpectationV1,
  validateAttendanceFlexPolicyV1,
} from '../w5-flex-policy'

describe('flexCoreHoursCoveredByAllClampedIntervalsV1', () => {
  // Segment start 09:00 (540). Window before 60 / after 60 => [08:00, 10:00].
  // Core 10:00-15:00 requires BOTH:
  //   latestPermittedStart  <= coreStart
  //   earliestPermittedStart + requiredMinutes >= coreEnd
  // requiredMinutes >= coreDuration alone is NOT sufficient (P1).

  /** Duration-only predicate the lock rejects as insufficient. */
  function durationOnlyCoversCore(input: {
    requiredMinutes: number
    coreStartMinutes: number
    coreEndMinutes: number
  }): boolean {
    return input.requiredMinutes >= input.coreEndMinutes - input.coreStartMinutes
  }

  it('accepts a window where every clamped start covers core', () => {
    const input = {
      segmentStartMinutes: 9 * 60,
      arrivalWindowBeforeMinutes: 60,
      arrivalWindowAfterMinutes: 60,
      requiredMinutes: 480,
      coreStartMinutes: 10 * 60,
      coreEndMinutes: 15 * 60,
    }
    expect(flexCoreHoursCoveredByAllClampedIntervalsV1(input)).toBe(true)
    // earliest 08:00 + 480 = 16:00 >= 15:00; latest 10:00 <= 10:00.
  })

  it('rejects latest>coreStart even when requiredMinutes >= core duration (P1 discriminating leg)', () => {
    // after=120 => latest 11:00 > coreStart 10:00, but required 480 >= 300.
    const input = {
      segmentStartMinutes: 9 * 60,
      arrivalWindowBeforeMinutes: 60,
      arrivalWindowAfterMinutes: 120,
      requiredMinutes: 480,
      coreStartMinutes: 10 * 60,
      coreEndMinutes: 15 * 60,
    }
    expect(durationOnlyCoversCore(input)).toBe(true) // weak check would pass
    expect(flexCoreHoursCoveredByAllClampedIntervalsV1(input)).toBe(false) // full check must fail
    // Removing latest<=coreStart alone would leave this green; it must stay red.
  })

  it('rejects earliest+required<coreEnd even when latest<=coreStart (P1 discriminating leg)', () => {
    // latest 09:00 <= coreStart 09:00, but earliest 08:00 + 300 = 13:00 < coreEnd 15:00.
    const input = {
      segmentStartMinutes: 9 * 60,
      arrivalWindowBeforeMinutes: 60,
      arrivalWindowAfterMinutes: 0,
      requiredMinutes: 300,
      coreStartMinutes: 9 * 60,
      coreEndMinutes: 15 * 60,
    }
    // duration-only also fails here (300 < 360); use a case where duration-only
    // passes but earliest+required does not relative to the window open:
    const input2 = {
      segmentStartMinutes: 9 * 60,
      arrivalWindowBeforeMinutes: 120, // earliest 07:00
      arrivalWindowAfterMinutes: 0, // latest 09:00 <= coreStart 09:00
      requiredMinutes: 360, // duration == core length, but 07:00+360=13:00 < 15:00
      coreStartMinutes: 9 * 60,
      coreEndMinutes: 15 * 60,
    }
    expect(durationOnlyCoversCore(input2)).toBe(true) // weak check would pass
    expect(input2.segmentStartMinutes + input2.arrivalWindowAfterMinutes
      <= input2.coreStartMinutes).toBe(true) // latest<=coreStart holds
    expect(flexCoreHoursCoveredByAllClampedIntervalsV1(input2)).toBe(false) // full check must fail
    // Removing earliest+required>=coreEnd alone would leave this green; it must stay red.
    expect(flexCoreHoursCoveredByAllClampedIntervalsV1(input)).toBe(false)
  })

  it('accepts the boundary equalities exactly (edge arrivals cover core)', () => {
    // latest == coreStart; earliest + required == coreEnd
    const input = {
      segmentStartMinutes: 9 * 60,
      arrivalWindowBeforeMinutes: 0,
      arrivalWindowAfterMinutes: 60, // latest 10:00
      requiredMinutes: 360, // earliest 09:00 + 360 = 15:00
      coreStartMinutes: 10 * 60,
      coreEndMinutes: 15 * 60,
    }
    expect(flexCoreHoursCoveredByAllClampedIntervalsV1(input)).toBe(true)
    // Edge: arrive at latest permitted start 10:00 => end 16:00 covers [10:00,15:00]
    const latestStart = input.segmentStartMinutes + input.arrivalWindowAfterMinutes
    expect(latestStart).toBe(input.coreStartMinutes)
    expect(latestStart + input.requiredMinutes).toBeGreaterThanOrEqual(input.coreEndMinutes)
    // Edge: arrive at earliest permitted start 09:00 => end 15:00 covers core end exactly
    const earliestStart = input.segmentStartMinutes - input.arrivalWindowBeforeMinutes
    expect(earliestStart + input.requiredMinutes).toBe(input.coreEndMinutes)
    expect(earliestStart).toBeLessThanOrEqual(input.coreStartMinutes)
  })
})

describe('validateAttendanceFlexPolicyV1', () => {
  it('accepts strict and rejects unknown keys on strict', () => {
    expect(validateAttendanceFlexPolicyV1({ mode: 'strict' }, { segmentCount: 1 })).toBe(true)
    expect(validateAttendanceFlexPolicyV1(
      { mode: 'strict', requiredMinutes: 1 },
      { segmentCount: 1 },
    )).toBe(false)
  })

  it('accepts single-segment flex_required_duration and rejects multi-segment flex', () => {
    const policy = {
      mode: 'flex_required_duration',
      requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 60,
      arrivalWindowAfterMinutes: 0,
      coreStartTime: null,
      coreEndTime: null,
    }
    expect(validateAttendanceFlexPolicyV1(policy, { segmentCount: 1 })).toBe(true)
    expect(validateAttendanceFlexPolicyV1(policy, { segmentCount: 2 })).toBe(false)
    expect(validateAttendanceFlexPolicyV1(policy, { segmentCount: 3 })).toBe(false)
  })

  it('requires a positive requiredMinutes and non-negative windows', () => {
    const base = {
      mode: 'flex_required_duration',
      requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 0,
      arrivalWindowAfterMinutes: 0,
      coreStartTime: null,
      coreEndTime: null,
    }
    expect(validateAttendanceFlexPolicyV1({ ...base, requiredMinutes: 0 }, { segmentCount: 1 })).toBe(false)
    expect(validateAttendanceFlexPolicyV1({ ...base, requiredMinutes: 1441 }, { segmentCount: 1 })).toBe(false)
    expect(validateAttendanceFlexPolicyV1({ ...base, arrivalWindowBeforeMinutes: -1 }, { segmentCount: 1 })).toBe(false)
  })

  it('authoring-rejects core hours that are not covered by every clamped arrival', () => {
    // Segment 09:00, after=120 => latest 11:00 > core 10:00
    const policy = {
      mode: 'flex_required_duration',
      requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 60,
      arrivalWindowAfterMinutes: 120,
      coreStartTime: '10:00',
      coreEndTime: '15:00',
    }
    expect(validateAttendanceFlexPolicyV1(policy, {
      segmentCount: 1,
      segmentStartTime: '09:00',
    })).toBe(false)
  })

  it('authoring-accepts core hours covered by every clamped arrival', () => {
    // Segment 09:00, before=60 after=60 => [08:00,10:00]; required 480 covers to 16:00.
    const policy = {
      mode: 'flex_required_duration',
      requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 60,
      arrivalWindowAfterMinutes: 60,
      coreStartTime: '10:00',
      coreEndTime: '15:00',
    }
    expect(validateAttendanceFlexPolicyV1(policy, {
      segmentCount: 1,
      segmentStartTime: '09:00',
    })).toBe(true)
  })

  it('requires segmentStartTime when core hours are set', () => {
    const policy = {
      mode: 'flex_required_duration',
      requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 0,
      arrivalWindowAfterMinutes: 0,
      coreStartTime: '10:00',
      coreEndTime: '15:00',
    }
    expect(validateAttendanceFlexPolicyV1(policy, { segmentCount: 1 })).toBe(false)
    expect(validateAttendanceFlexPolicyV1(policy, {
      segmentCount: 1,
      segmentStartTime: null,
    })).toBe(false)
  })

  it('normalizes absent policy to strict and rejects invalid shapes', () => {
    expect(normalizeAttendanceFlexPolicyV1(undefined, { segmentCount: 1 })).toEqual({ mode: 'strict' })
    expect(normalizeAttendanceFlexPolicyV1(null, { segmentCount: 2 })).toEqual({ mode: 'strict' })
    expect(normalizeAttendanceFlexPolicyV1(
      { mode: 'flex_required_duration' },
      { segmentCount: 1 },
    )).toBeNull()
  })
})

describe('resolveAttendanceFlexExpectationV1', () => {
  const policy = {
    mode: 'flex_required_duration' as const,
    requiredMinutes: 480,
    arrivalWindowBeforeMinutes: 60,
    arrivalWindowAfterMinutes: 120,
    coreStartTime: null,
    coreEndTime: null,
  }
  // Nominal start 09:00 as epoch ms on a fixed day.
  const nominalStartMs = Date.parse('2026-07-01T01:00:00.000Z') // 09:00 +08
  const windowStart = nominalStartMs - 60 * 60_000
  const windowEnd = nominalStartMs + 120 * 60_000

  it('clamps early arrival to the window open (early-arrive)', () => {
    const early = windowStart - 30 * 60_000
    const resolved = resolveAttendanceFlexExpectationV1({
      policy,
      nominalStartMs,
      actualArrivalMs: early,
    })
    expect(resolved.expectedStartMs).toBe(windowStart)
    expect(resolved.expectedEndMs).toBe(windowStart + 480 * 60_000)
  })

  it('uses in-window arrival as expected start and extends required minutes', () => {
    const arrival = nominalStartMs + 30 * 60_000
    const resolved = resolveAttendanceFlexExpectationV1({
      policy,
      nominalStartMs,
      actualArrivalMs: arrival,
    })
    expect(resolved.expectedStartMs).toBe(arrival)
    expect(resolved.expectedEndMs).toBe(arrival + 480 * 60_000)
  })

  it('clamps late arrival to the window close (late-arrive)', () => {
    const late = windowEnd + 45 * 60_000
    const resolved = resolveAttendanceFlexExpectationV1({
      policy,
      nominalStartMs,
      actualArrivalMs: late,
    })
    expect(resolved.expectedStartMs).toBe(windowEnd)
    expect(resolved.expectedEndMs).toBe(windowEnd + 480 * 60_000)
  })

  it('falls back to window open when arrival is missing', () => {
    const resolved = resolveAttendanceFlexExpectationV1({
      policy,
      nominalStartMs,
      actualArrivalMs: null,
    })
    expect(resolved.expectedStartMs).toBe(windowStart)
    expect(resolved.expectedEndMs).toBe(windowStart + 480 * 60_000)
  })
})
