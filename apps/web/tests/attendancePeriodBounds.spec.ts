import { describe, expect, it } from 'vitest'
import {
  attendanceCalendarDate,
  comprehensiveHoursDefaultPeriod,
  resolvePayrollAnchorTimeZone,
} from '../src/views/attendance/attendancePeriodBounds'

const SHANGHAI_EVENING = new Date('2026-09-30T16:30:00.000Z')

describe('attendance period bounds', () => {
  it('builds comprehensive-hours defaults from the attendance IANA calendar', () => {
    expect(comprehensiveHoursDefaultPeriod(SHANGHAI_EVENING, 'Asia/Shanghai')).toEqual({
      year: 2026,
      month: 10,
      quarter: 4,
      from: '2026-10-01',
      to: '2026-10-31',
    })
    expect(comprehensiveHoursDefaultPeriod(SHANGHAI_EVENING, 'America/Los_Angeles')).toEqual({
      year: 2026,
      month: 9,
      quarter: 3,
      from: '2026-09-01',
      to: '2026-09-30',
    })
  })

  it('returns null for an invalid zone instead of a browser or UTC calendar', () => {
    expect(attendanceCalendarDate(SHANGHAI_EVENING, 'Mars/Olympus')).toBeNull()
    expect(comprehensiveHoursDefaultPeriod(SHANGHAI_EVENING, '')).toBeNull()
    expect(comprehensiveHoursDefaultPeriod(SHANGHAI_EVENING, null)).toBeNull()
  })

  it('prefers the selected payroll template zone, then the default template, then the rule zone', () => {
    const templates = [
      { id: 'utc', timezone: 'UTC', isDefault: false },
      { id: 'la', timezone: 'America/Los_Angeles', isDefault: true },
    ]
    expect(resolvePayrollAnchorTimeZone({
      templateId: 'utc',
      templates,
      attendanceTimeZone: 'Asia/Shanghai',
    })).toBe('UTC')
    expect(resolvePayrollAnchorTimeZone({
      templateId: '',
      templates,
      attendanceTimeZone: 'Asia/Shanghai',
    })).toBe('America/Los_Angeles')
    expect(resolvePayrollAnchorTimeZone({
      templateId: 'missing',
      templates,
      attendanceTimeZone: 'Asia/Shanghai',
    })).toBe('Asia/Shanghai')
    expect(resolvePayrollAnchorTimeZone({
      templateId: '',
      templates: [],
      attendanceTimeZone: 'not-a-zone',
    })).toBeNull()
  })
})
