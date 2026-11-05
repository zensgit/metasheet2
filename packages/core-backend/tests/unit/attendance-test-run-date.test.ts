import { describe, expect, it } from 'vitest'
import { attendanceTestRunDateOverride, attendanceTestRunNow } from '../utils/attendance-test-run-date'

describe('attendance date-matrix run day helper', () => {
  const real = Date.parse('2026-11-04T13:45:06.789Z')

  it('without an override returns the real instant unchanged', () => {
    expect(attendanceTestRunDateOverride({})).toBeNull()
    expect(attendanceTestRunDateOverride({ ATTENDANCE_TEST_RUN_DATE: '' })).toBeNull()
    expect(attendanceTestRunNow({}, real).toISOString()).toBe('2026-11-04T13:45:06.789Z')
  })

  it('moves only the UTC day and keeps the real time of day', () => {
    for (const date of ['2026-11-02', '2027-03-15', '2027-04-15', '2027-11-08']) {
      expect(attendanceTestRunNow({ ATTENDANCE_TEST_RUN_DATE: date }, real).toISOString()).toBe(date + 'T13:45:06.789Z')
    }
  })

  it('refuses a malformed or impossible date instead of silently using the real day', () => {
    for (const bad of ['2027-02-30', '2027-13-01', '2027-4-15', '2027-04-15T00:00:00Z', 'today', ' 2027-04-15']) {
      expect(() => attendanceTestRunNow({ ATTENDANCE_TEST_RUN_DATE: bad }, real)).toThrow('ATTENDANCE_TEST_RUN_DATE_INVALID')
    }
  })

  it('does not fake the process clock', () => {
    const before = Date.now()
    attendanceTestRunNow({ ATTENDANCE_TEST_RUN_DATE: '2027-11-08' })
    expect(Math.abs(Date.now() - before)).toBeLessThan(60_000)
  })
})
