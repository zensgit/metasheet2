import { describe, expect, it } from 'vitest'
import { currentAttendanceTimezone, parseAttendanceCurrentTimeContext } from '../src/views/attendance/attendanceCurrentTimeContext'

const context = {
  resolvedForInstant: '2026-04-15T02:00:00.000Z', effectiveTimezone: 'Asia/Singapore',
  timezoneSource: 'trip', mode: 'multi_timezone', policyVersion: 2,
  referenceId: 'approved-trip', version: 1, currentLocalDate: '2026-04-15',
  nextEffectiveBoundary: '2026-04-15T03:00:00.000Z',
}

describe('current attendance instant context', () => {
  it('uses the explicit server timezone until its half-open boundary', () => {
    const parsed = parseAttendanceCurrentTimeContext(context)
    expect(parsed).toEqual(context)
    expect(currentAttendanceTimezone(parsed, new Date('2026-04-15T02:59:59.999Z'))).toBe('Asia/Singapore')
    expect(currentAttendanceTimezone(parsed, new Date(context.nextEffectiveBoundary))).toBeNull()
    expect(currentAttendanceTimezone(parsed, null)).toBeNull()
  })
  it.each([
    { effectiveTimezone: 'Invalid/Zone' }, { timezoneSource: 'browser' }, { mode: 'other' },
    { currentLocalDate: '2026-04-14' }, { policyVersion: -1 }, { version: 0.5 },
    { referenceId: '' }, { resolvedForInstant: '2026-04-15T02:00:00' },
    { nextEffectiveBoundary: '2026-04-15T02:00:00.000Z' }, { extra: true },
    { mode: 'default_only' }, { timezoneSource: ['trip'] },
    { mode: 'default_only', nextEffectiveBoundary: null, timezoneSource: 'trip' },
  ])('rejects malformed authority without a fallback: %j', patch => {
    expect(parseAttendanceCurrentTimeContext({ ...context, ...patch })).toBeNull()
  })
  it('accepts default OFF only with the default source and no optional-source boundary', () => {
    expect(parseAttendanceCurrentTimeContext({ ...context, mode: 'default_only',
      timezoneSource: 'system_default', nextEffectiveBoundary: null })).not.toBeNull()
  })
})
