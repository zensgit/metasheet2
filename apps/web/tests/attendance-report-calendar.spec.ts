import { describe, expect, it } from 'vitest'
import {
  buildAttendanceReportDefaultRange,
  buildAttendanceReportRangePreset,
} from '../src/views/attendance/attendanceReportCalendar'

const SHANGHAI_WEEK_BOUNDARY = new Date('2026-09-27T16:30:00.000Z')
const SHANGHAI_MONTH_BOUNDARY = new Date('2026-09-30T16:30:00.000Z')

describe('attendance report calendar in the attendance IANA zone', () => {
  it('uses the Shanghai week when UTC is still the previous Sunday', () => {
    expect(buildAttendanceReportRangePreset('this-week', SHANGHAI_WEEK_BOUNDARY, 'Asia/Shanghai')).toEqual({
      from: '2026-09-28',
      to: '2026-10-04',
    })
    expect(buildAttendanceReportRangePreset('this-week', SHANGHAI_WEEK_BOUNDARY, 'UTC')).toEqual({
      from: '2026-09-21',
      to: '2026-09-27',
    })
  })

  it('uses the Shanghai month, previous month, and quarter across the UTC month boundary', () => {
    expect(buildAttendanceReportRangePreset('this-month', SHANGHAI_MONTH_BOUNDARY, 'Asia/Shanghai')).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    })
    expect(buildAttendanceReportRangePreset('last-month', SHANGHAI_MONTH_BOUNDARY, 'Asia/Shanghai')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    })
    expect(buildAttendanceReportRangePreset('this-quarter', SHANGHAI_MONTH_BOUNDARY, 'Asia/Shanghai')).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
    })
    expect(buildAttendanceReportRangePreset('this-month', SHANGHAI_MONTH_BOUNDARY, 'UTC')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    })
    expect(buildAttendanceReportRangePreset('this-quarter', SHANGHAI_MONTH_BOUNDARY, 'UTC')).toEqual({
      from: '2026-07-01',
      to: '2026-09-30',
    })
  })

  it('defaults to 30 attendance-zone calendar days through today', () => {
    expect(buildAttendanceReportDefaultRange(SHANGHAI_MONTH_BOUNDARY, 'Asia/Shanghai')).toEqual({
      from: '2026-09-01',
      to: '2026-10-01',
    })
    expect(buildAttendanceReportDefaultRange(SHANGHAI_MONTH_BOUNDARY, 'UTC')).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    })
  })

  it('returns null when the attendance zone is missing or invalid', () => {
    expect(buildAttendanceReportRangePreset('this-week', SHANGHAI_WEEK_BOUNDARY, null)).toBeNull()
    expect(buildAttendanceReportDefaultRange(SHANGHAI_WEEK_BOUNDARY, 'Not/AZone')).toBeNull()
  })

  it('keeps January last-month inside the previous December', () => {
    const now = new Date('2026-01-01T00:30:00.000Z')
    expect(buildAttendanceReportRangePreset('last-month', now, 'Asia/Shanghai')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    })
  })
})
