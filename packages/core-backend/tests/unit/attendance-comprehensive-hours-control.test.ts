import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests
const pluginSource = readFileSync(new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url), 'utf8')

function createPreviewDb(handler: (sql: string, params: unknown[]) => unknown[] | Promise<unknown[]>) {
  const queries: Array<{ sql: string, params: unknown[] }> = []
  return {
    queries,
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params })
      return handler(sql, params)
    },
  }
}

function defaultRuleRow() {
  return {
    id: 'rule-default',
    name: 'Default',
    timezone: 'Asia/Shanghai',
    work_start_time: '09:00',
    work_end_time: '17:00',
    late_grace_minutes: 0,
    early_grace_minutes: 0,
    rounding_minutes: 0,
    working_days: [1, 2, 3, 4, 5],
    is_default: true,
    org_id: 'org-1',
  }
}

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

  it('previews planned comprehensive hours from effective-calendar producers without writes', async () => {
    const db = createPreviewDb((sql) => {
      if (sql.includes('SELECT 1 FROM')) return [{ ok: 1 }]
      if (sql.includes('FROM attendance_rules') && sql.includes('is_default')) return [defaultRuleRow()]
      return []
    })

    const result = await helpers.previewAttendanceComprehensiveHours(db, 'org-1', {
      scope: { userIds: ['user-b', 'user-a', 'user-a'] },
      period: { type: 'custom_range', from: '2026-05-04', to: '2026-05-05' },
      policyDraft: { capHours: 12, enforcement: 'block' },
      metric: 'planned',
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        readOnly: true,
        metric: 'planned',
        enforcement: 'block',
        capMinutes: 720,
        period: {
          type: 'custom_range',
          key: 'range:2026-05-04:2026-05-05',
        },
        aggregate: {
          users: 2,
          violation: 2,
          status: 'violation',
        },
      },
    })
    expect(result.data.scope.userIds).toEqual(['user-a', 'user-b'])
    expect(result.data.rows.map((row: any) => [row.userId, row.minutes, row.days, row.workingDays, row.status, row.source])).toEqual([
      ['user-a', 960, 2, 2, 'violation', 'effective_calendar'],
      ['user-b', 960, 2, 2, 'violation', 'effective_calendar'],
    ])
    expect(db.queries.every(({ sql }) => sql.trim().startsWith('SELECT'))).toBe(true)
    expect(db.queries.map(({ sql }) => sql).join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|PATCH)\b/i)
  })

  it('previews actual comprehensive hours from attendance summary without planned producers', async () => {
    const db = createPreviewDb((sql) => {
      if (sql.includes('SELECT 1 FROM')) return [{ ok: 1 }]
      if (sql.includes('FROM attendance_records')) {
        return [{
          total_days: 3,
          total_minutes: 620,
          total_late_minutes: 0,
          total_early_leave_minutes: 0,
          normal_days: 3,
          late_days: 0,
          early_leave_days: 0,
          late_early_days: 0,
          partial_days: 0,
          absent_days: 0,
          adjusted_days: 0,
          off_days: 0,
        }]
      }
      if (sql.includes('FROM attendance_requests')) return []
      throw new Error(`Unexpected query: ${sql}`)
    })

    const result = await helpers.previewAttendanceComprehensiveHours(db, 'org-1', {
      userId: 'user-a',
      period: { type: 'month', year: 2026, month: 5 },
      capMinutes: 600,
      metric: 'actual',
      enforcement: 'warn',
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        metric: 'actual',
        aggregate: {
          users: 1,
          warning: 1,
          status: 'warning',
          totalMinutes: 620,
          totalExcessMinutes: 20,
        },
      },
    })
    expect(result.data.rows).toEqual([
      expect.objectContaining({
        userId: 'user-a',
        actualMinutes: 620,
        plannedMinutes: undefined,
        source: 'summary',
        status: 'warning',
      }),
    ])
    expect(db.queries.map(({ sql }) => sql).join('\n')).not.toContain('attendance_shift_assignments')
  })

  it('resolves payroll-cycle preview periods from the database when only cycleId is provided', async () => {
    const cycleId = '11111111-1111-4111-8111-111111111111'
    const db = createPreviewDb((sql) => {
      if (sql.includes('FROM attendance_payroll_cycles')) {
        return [{
          id: cycleId,
          org_id: 'org-1',
          name: 'May payroll',
          start_date: '2026-05-01',
          end_date: '2026-05-31',
          status: 'open',
        }]
      }
      return []
    })

    await expect(helpers.resolveAttendanceComprehensiveHoursPreviewPeriod(db, 'org-1', {
      type: 'payroll_cycle',
      cycleId,
    })).resolves.toMatchObject({
      ok: true,
      period: {
        type: 'payroll_cycle',
        key: `cycle:${cycleId}`,
        cycleId,
        from: '2026-05-01',
        to: '2026-05-31',
        label: 'May payroll',
      },
    })
  })

  it('rejects invalid preview requests and reports schema gaps explicitly', async () => {
    const db = createPreviewDb(() => [])

    expect(helpers.normalizeAttendanceComprehensiveHoursPreviewInput({})).toMatchObject({
      ok: false,
      error: { code: 'EMPTY_SCOPE' },
    })
    expect(helpers.normalizeAttendanceComprehensiveHoursPreviewInput({
      userId: 'user-a',
      period: { type: 'month', year: 2026, month: 5 },
      capMinutes: 0,
    })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_CAP' },
    })
    await expect(helpers.previewAttendanceComprehensiveHours(db, 'org-1', {
      userId: 'user-a',
      period: { type: 'week' },
      capMinutes: 600,
    })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: 'INVALID_PERIOD_TYPE' },
    })

    const schemaDb = createPreviewDb((sql) => {
      if (sql.includes('SELECT 1 FROM attendance_rules')) {
        const error = new Error('relation "attendance_rules" does not exist') as Error & { code?: string }
        error.code = '42P01'
        throw error
      }
      return []
    })
    await expect(helpers.previewAttendanceComprehensiveHours(schemaDb, 'org-1', {
      userId: 'user-a',
      period: { type: 'custom_range', from: '2026-05-04', to: '2026-05-05' },
      capMinutes: 600,
    })).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: { code: 'DB_NOT_READY' },
    })
  })

  it('registers only an admin-gated read-only comprehensive-hours preview route', () => {
    expect(pluginSource).toMatch(
      /'POST',\s*\n\s*'\/api\/attendance\/comprehensive-hours\/preview',\s*\n\s*withPermission\('attendance:admin'/,
    )
    expect(pluginSource).not.toContain("'PUT',\n      '/api/attendance/comprehensive-hours/preview'")
    expect(pluginSource).not.toContain("'PATCH',\n      '/api/attendance/comprehensive-hours/preview'")
    expect(pluginSource).not.toContain("'DELETE',\n      '/api/attendance/comprehensive-hours/preview'")
  })
})
