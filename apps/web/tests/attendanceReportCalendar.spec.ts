import { describe, expect, it } from 'vitest'
import { buildAttendanceReportCalendarRange, type AttendanceReportRangePreset } from '../src/views/attendance/attendanceReportCalendar'

describe('attendance report calendar date boundaries', () => {
  it.each([
    ['this-week', '2026-03-01T23:30:00Z', 'Pacific/Kiritimati', '2026-03-02', '2026-03-08'],
    ['this-week', '2026-03-02T01:30:00Z', 'Etc/GMT+12', '2026-02-23', '2026-03-01'],
    ['this-month', '2026-03-01T01:30:00Z', 'America/Los_Angeles', '2026-02-01', '2026-02-28'],
    ['this-month', '2026-02-28T16:30:00Z', 'Asia/Shanghai', '2026-03-01', '2026-03-31'],
    ['last-month', '2026-01-01T12:00:00Z', 'Asia/Shanghai', '2025-12-01', '2025-12-31'],
    ['last-month', '2024-03-01T12:00:00Z', 'UTC', '2024-02-01', '2024-02-29'],
    ['this-quarter', '2026-04-01T01:00:00Z', 'America/Los_Angeles', '2026-01-01', '2026-03-31'],
    ['this-quarter', '2026-12-31T12:00:00Z', 'Pacific/Kiritimati', '2027-01-01', '2027-03-31'],
    ['recent', '2026-03-09T07:15:00Z', 'America/Los_Angeles', '2026-02-07', '2026-03-09'],
    ['recent', '2026-11-02T08:15:00Z', 'America/Los_Angeles', '2026-10-03', '2026-11-02'],
    ['this-week', '2026-03-08T09:30:00Z', 'America/Los_Angeles', '2026-03-02', '2026-03-08'],
    ['this-week', '2026-11-01T09:30:00Z', 'America/Los_Angeles', '2026-10-26', '2026-11-01'],
  ])('%s at %s in %s', (period, instant, zone, from, to) => {
    expect(buildAttendanceReportCalendarRange(period as AttendanceReportRangePreset | 'recent', new Date(instant), zone))
      .toEqual({ from, to })
  })
  it.each([null, '', 'Not/AZone'])('does not invent a zone for %s', zone => {
    expect(buildAttendanceReportCalendarRange('this-week', new Date('2026-03-01T00:00:00Z'), zone)).toBeNull()
  })
  it('rejects invalid instants and unknown periods', () => {
    expect(buildAttendanceReportCalendarRange('this-week', new Date('invalid'), 'UTC')).toBeNull()
    expect(buildAttendanceReportCalendarRange('unknown' as AttendanceReportRangePreset, new Date(), 'UTC')).toBeNull()
  })
})
