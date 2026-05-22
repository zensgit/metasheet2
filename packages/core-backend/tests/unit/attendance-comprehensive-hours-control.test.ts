import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

describe('attendance comprehensive working-hours control helpers', () => {
  it('resolves month, quarter, year, custom range, and payroll-cycle periods deterministically', () => {
    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({ type: 'month', year: 2026, month: 2 })).toEqual({
      ok: true,
      period: {
        type: 'month',
        key: '2026-02',
        from: '2026-02-01',
        to: '2026-02-28',
        label: '2026-02',
      },
    })

    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({ type: 'quarter', year: '2026', quarter: '4' })).toEqual({
      ok: true,
      period: {
        type: 'quarter',
        key: '2026-Q4',
        from: '2026-10-01',
        to: '2026-12-31',
        label: '2026 Q4',
      },
    })

    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({ type: 'year', year: 2028 })).toEqual({
      ok: true,
      period: {
        type: 'year',
        key: '2028',
        from: '2028-01-01',
        to: '2028-12-31',
        label: '2028',
      },
    })

    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({
      type: 'custom_range',
      from: '2026-05-01',
      to: '2026-05-31',
    })).toEqual({
      ok: true,
      period: {
        type: 'custom_range',
        key: 'range:2026-05-01:2026-05-31',
        from: '2026-05-01',
        to: '2026-05-31',
        label: '2026-05-01..2026-05-31',
      },
    })

    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({
      type: 'payroll_cycle',
      cycleId: 'cycle-a',
      cycle: {
        id: 'cycle-ignored',
        name: 'April payroll',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      },
    })).toEqual({
      ok: true,
      period: {
        type: 'payroll_cycle',
        key: 'cycle:cycle-a',
        cycleId: 'cycle-a',
        from: '2026-04-01',
        to: '2026-04-30',
        label: 'April payroll',
      },
    })
  })

  it('rejects invalid period input without throwing', () => {
    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({ type: 'week', year: 2026 }).error.code).toBe('INVALID_PERIOD_TYPE')
    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({ type: 'month', year: 2026, month: 13 }).error.code).toBe('INVALID_PERIOD_MONTH')
    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({ type: 'quarter', year: 2026, quarter: 5 }).error.code).toBe('INVALID_PERIOD_QUARTER')
    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({ type: 'year', year: 10000 }).error.code).toBe('INVALID_PERIOD_YEAR')
    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({ type: 'custom_range', from: '2026-02-02', to: '2026-02-01' }).error.code).toBe('INVALID_PERIOD_RANGE')
    expect(helpers.resolveAttendanceComprehensiveHoursPeriod({ type: 'payroll_cycle', cycleId: 'cycle-a' }).error.code).toBe('INVALID_PAYROLL_CYCLE')
  })

  it('aggregates planned minutes from effective calendar-style days without using actual attendance summary', () => {
    const planned = helpers.buildAttendanceComprehensivePlannedMinutesFromDays([
      {
        date: '2026-05-01',
        effective: { isWorkingDay: true, source: 'shift' },
        shift: { workStartTime: '09:00', workEndTime: '18:00', isOvernight: false },
      },
      {
        date: '2026-05-02',
        effective: { isWorkingDay: false, source: 'national' },
        shift: { workStartTime: '09:00', workEndTime: '18:00' },
      },
      {
        date: '2026-05-03',
        effective: { isWorkingDay: true, source: 'rotation' },
        shift: { workStartTime: '22:00', workEndTime: '06:00', isOvernight: true },
      },
      {
        date: '2026-05-04',
        effective: { isWorkingDay: true, source: 'manual' },
        plannedMinutes: 300,
      },
      {
        date: '2026-05-05',
        effective: { isWorkingDay: true, source: 'null-fallback' },
        shift: { workStartTime: '10:00', workEndTime: '17:30' },
        plannedMinutes: null,
      },
      {
        date: '2026-05-06',
        effective: { isWorkingDay: true, source: 'empty-fallback' },
        shift: { workStartTime: '08:00', workEndTime: '12:00' },
        planned_minutes: '',
      },
    ])

    expect(planned).toMatchObject({
      plannedMinutes: 540 + 0 + 480 + 300 + 450 + 240,
      days: 6,
      workingDays: 5,
    })
    expect(planned.items.map((item: any) => item.plannedMinutes)).toEqual([540, 0, 480, 300, 450, 240])
    expect(planned.items.map((item: any) => item.source)).toEqual(['shift', 'national', 'rotation', 'manual', 'null-fallback', 'empty-fallback'])
  })

  it('keeps actual minutes sourced from summary payloads separate from planned minutes', () => {
    expect(helpers.buildAttendanceComprehensiveActualMinutesFromSummary({ total_minutes: 1234 })).toEqual({
      actualMinutes: 1234,
      source: 'summary',
    })
    expect(helpers.buildAttendanceComprehensiveActualMinutesFromSummary({ work_duration: 456 })).toEqual({
      actualMinutes: 456,
      source: 'summary',
    })
    expect(helpers.buildAttendanceComprehensiveActualMinutesFromSummary(null)).toEqual({
      actualMinutes: 0,
      source: 'summary',
    })
  })

  it('builds warning vs violation comparisons from the same cap math', () => {
    expect(helpers.buildAttendanceComprehensiveHoursComparison({
      userId: 'user-a',
      metric: 'planned',
      enforcement: 'warn',
      capMinutes: 1000,
      plannedMinutes: 1105,
    })).toMatchObject({
      userId: 'user-a',
      metric: 'planned',
      enforcement: 'warn',
      capMinutes: 1000,
      minutes: 1105,
      plannedMinutes: 1105,
      remainingMinutes: 0,
      excessMinutes: 105,
      status: 'warning',
    })

    expect(helpers.buildAttendanceComprehensiveHoursComparison({
      userId: 'user-a',
      metric: 'actual',
      enforcement: 'block',
      capMinutes: 1000,
      actualMinutes: 1105,
    })).toMatchObject({
      metric: 'actual',
      enforcement: 'block',
      actualMinutes: 1105,
      excessMinutes: 105,
      status: 'violation',
    })

    expect(helpers.buildAttendanceComprehensiveHoursComparison({
      metric: 'planned',
      capMinutes: 1000,
      plannedMinutes: 960,
    })).toMatchObject({
      remainingMinutes: 40,
      excessMinutes: 0,
      status: 'ok',
    })
  })

  it('sorts preview rows by userId and switches metric source by mode', () => {
    const users = [{ id: 'user-b' }, { id: 'user-a' }]
    const plannedRows = helpers.buildAttendanceComprehensiveHoursPreviewRows({
      users,
      metric: 'planned',
      capMinutes: 500,
      plannedMinutesByUser: new Map([
        ['user-b', 400],
        ['user-a', 600],
      ]),
    })

    expect(plannedRows.map((row: any) => [row.userId, row.minutes, row.status])).toEqual([
      ['user-a', 600, 'warning'],
      ['user-b', 400, 'ok'],
    ])

    const actualRows = helpers.buildAttendanceComprehensiveHoursPreviewRows({
      users,
      metric: 'actual',
      enforcement: 'block',
      capMinutes: 500,
      actualMinutesByUser: new Map([
        ['user-b', 700],
        ['user-a', 300],
      ]),
    })

    expect(actualRows.map((row: any) => [row.userId, row.minutes, row.status])).toEqual([
      ['user-a', 300, 'ok'],
      ['user-b', 700, 'violation'],
    ])
  })
})
