import { describe, expect, it } from 'vitest'
import {
  OVERTIME_MINUTES_ABOVE_MAX,
  OVERTIME_MINUTES_BELOW_MIN,
  OVERTIME_RULE_BOUNDS_INVALID,
  effectiveOvertimeSubmittedMinutes,
  overtimeRuleBoundsHintCopy,
  overtimeWriteBoundsCopy,
  resolveOvertimeWriteMinutes,
} from '../src/views/attendance/overtimeWriteBounds'

const rule = { minMinutes: 30, roundingMinutes: 15, maxMinutesPerDay: 600 }

describe('overtime write bounds (#5985)', () => {
  it('rejects below the minimum and above the daily maximum', () => {
    const below = resolveOvertimeWriteMinutes(10, rule)
    expect(below.ok).toBe(false)
    if (!below.ok) {
      expect(below.code).toBe(OVERTIME_MINUTES_BELOW_MIN)
      expect(overtimeWriteBoundsCopy(below).en).toContain('at least 30')
      expect(overtimeWriteBoundsCopy(below).zh).toContain('30')
    }

    const above = resolveOvertimeWriteMinutes(700, rule)
    expect(above.ok).toBe(false)
    if (!above.ok) {
      expect(above.code).toBe(OVERTIME_MINUTES_ABOVE_MAX)
      expect(above.roundedMinutes).toBeNull()
      expect(overtimeWriteBoundsCopy(above).en).toContain('600')
    }
  })

  it('rejects rounding that would pass the daily maximum and keeps in-range rounding', () => {
    const overflow = resolveOvertimeWriteMinutes(106, {
      minMinutes: 30,
      roundingMinutes: 15,
      maxMinutesPerDay: 110,
    })
    expect(overflow).toMatchObject({
      ok: false,
      code: OVERTIME_MINUTES_ABOVE_MAX,
      roundedMinutes: 120,
    })
    if (!overflow.ok) {
      expect(overtimeWriteBoundsCopy(overflow).en).toContain('rounds up to 120')
    }
    expect(resolveOvertimeWriteMinutes(47, {
      minMinutes: 30,
      roundingMinutes: 15,
      maxMinutesPerDay: 120,
    })).toEqual({ ok: true, minutes: 60 })
  })

  it('rejects an unsatisfiable rule and describes the hard limits', () => {
    const invalid = resolveOvertimeWriteMinutes(40, {
      minMinutes: 600,
      roundingMinutes: 15,
      maxMinutesPerDay: 30,
    })
    expect(invalid).toMatchObject({ ok: false, code: OVERTIME_RULE_BOUNDS_INVALID })
    if (!invalid.ok) {
      expect(overtimeWriteBoundsCopy(invalid).en).toContain('misconfigured')
    }
    expect(overtimeRuleBoundsHintCopy(rule).en).toContain('30–600')
    expect(overtimeRuleBoundsHintCopy(rule).zh).toContain('不会被自动改写')
  })

  it('uses explicit minutes, otherwise the floored in/out span', () => {
    expect(effectiveOvertimeSubmittedMinutes({
      minutes: '10',
      requestedInAt: '2026-09-23T18:00',
      requestedOutAt: '2026-09-23T20:00',
    })).toBe(10)
    expect(effectiveOvertimeSubmittedMinutes({
      minutes: '',
      requestedInAt: '2026-09-23T18:00',
      requestedOutAt: '2026-09-23T18:47',
    })).toBe(47)
    expect(effectiveOvertimeSubmittedMinutes({
      minutes: '0',
      requestedInAt: '2026-09-23T18:00',
      requestedOutAt: '2026-09-23T19:00',
    })).toBe(60)
  })
})
