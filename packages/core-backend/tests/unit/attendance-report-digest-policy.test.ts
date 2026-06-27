import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportDigestForTests as {
  buildAttendanceReportDigestPayload: (input: {
    cadence?: string
    period?: Record<string, unknown>
    summary?: Record<string, unknown>
    requestTotals?: Record<string, unknown>
  }) => Record<string, unknown>
  clampAttendanceReportDigestDayOfMonth: (year: number, month: number, dayOfMonth: number) => string
  resolveAttendanceReportDigestPeriod: (
    cadence: string,
    options: { now?: Date | string; timezone?: string; todayKey?: string },
  ) => { cadence: string; timezone: string; from: string; to: string; periodKey: string; label: string }
}

describe('#考勤统计通知 RD-2 — report digest period builder (pure, no scheduler)', () => {
  it('daily uses the previous complete local day', () => {
    expect(helpers.resolveAttendanceReportDigestPeriod('daily', {
      timezone: 'Asia/Shanghai',
      now: new Date('2026-06-25T17:00:00.000Z'), // 2026-06-26 01:00 in Shanghai
    })).toEqual({
      cadence: 'daily',
      timezone: 'Asia/Shanghai',
      from: '2026-06-25',
      to: '2026-06-25',
      periodKey: 'daily:2026-06-25',
      label: '2026-06-25',
    })
  })

  it('weekly uses the previous complete ISO Monday-Sunday week', () => {
    expect(helpers.resolveAttendanceReportDigestPeriod('weekly', {
      timezone: 'Asia/Shanghai',
      todayKey: '2026-06-24',
    })).toMatchObject({
      from: '2026-06-15',
      to: '2026-06-21',
      periodKey: 'weekly:2026-06-15:2026-06-21',
      label: '2026-06-15..2026-06-21',
    })
  })

  it('monthly uses the previous complete natural month', () => {
    expect(helpers.resolveAttendanceReportDigestPeriod('monthly', {
      timezone: 'Asia/Shanghai',
      todayKey: '2026-03-15',
    })).toMatchObject({
      from: '2026-02-01',
      to: '2026-02-28',
      periodKey: 'monthly:2026-02-01:2026-02-28',
      label: '2026-02',
    })
  })

  it('monthly send day clamps to the actual month length', () => {
    expect(helpers.clampAttendanceReportDigestDayOfMonth(2026, 2, 31)).toBe('2026-02-28')
    expect(helpers.clampAttendanceReportDigestDayOfMonth(2028, 2, 31)).toBe('2028-02-29')
    expect(helpers.clampAttendanceReportDigestDayOfMonth(2026, 4, 31)).toBe('2026-04-30')
  })

  it('rejects unsupported cadences instead of silently falling back', () => {
    expect(() => helpers.resolveAttendanceReportDigestPeriod('quarterly', {
      timezone: 'Asia/Shanghai',
      todayKey: '2026-06-24',
    })).toThrow(/Unsupported attendance report digest cadence/)
  })

  it('rejects invalid timezones instead of silently computing in UTC', () => {
    expect(() => helpers.resolveAttendanceReportDigestPeriod('daily', {
      timezone: 'Not/AZone',
      todayKey: '2026-06-24',
    })).toThrow(/valid IANA time zone/)
  })
})

describe('#考勤统计通知 RD-2 — digest payload builder (summary only)', () => {
  it('builds a compact summary + request-total payload without raw records', () => {
    const payload = helpers.buildAttendanceReportDigestPayload({
      cadence: 'daily',
      period: {
        from: '2026-06-25',
        to: '2026-06-25',
        periodKey: 'daily:2026-06-25',
        label: '2026-06-25',
      },
      summary: {
        total_minutes: 480,
        late_days: 1,
        late_early_days: 0,
        early_leave_days: 2,
        absent_days: 0,
        leave_minutes: 60,
        overtime_minutes: 120,
        workday_overtime_minutes: 30,
        restday_overtime_minutes: 90,
        holiday_overtime_minutes: 0,
        full_attendance_eligible: false,
        records: [{ userId: 'should-not-leak' }],
      },
      requestTotals: {
        pending: 3,
        approved: 4,
        rejected: 1,
        leave_minutes: 60,
        overtime_minutes: 120,
        makeup_punch_count: 2,
        records: [{ requestId: 'should-not-leak' }],
      },
    })

    expect(payload).toEqual({
      kind: 'attendance_report_digest',
      cadence: 'daily',
      period: {
        from: '2026-06-25',
        to: '2026-06-25',
        label: '2026-06-25',
        periodKey: 'daily:2026-06-25',
      },
      summary: {
        totalMinutes: 480,
        lateDays: 1,
        lateEarlyDays: 0,
        earlyLeaveDays: 2,
        absentDays: 0,
        leaveMinutes: 60,
        overtimeMinutes: 120,
        workdayOvertimeMinutes: 30,
        restdayOvertimeMinutes: 90,
        holidayOvertimeMinutes: 0,
        fullAttendanceEligible: false,
      },
      requestTotals: {
        pending: 3,
        approved: 4,
        rejected: 1,
        leaveMinutes: 60,
        overtimeMinutes: 120,
        makeupPunchCount: 2,
      },
    })
    expect(payload).not.toHaveProperty('records')
    expect(payload.summary).not.toHaveProperty('records')
    expect(payload.requestTotals).not.toHaveProperty('records')
  })
})
