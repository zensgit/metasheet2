import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    expect(helpers.normalizeAttendanceComprehensiveHoursPreviewInput({
      userId: 'user-a',
      period: { type: 'month', year: 2026, month: 5 },
      capMinutes: 600,
      metric: 'actuals',
    })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_METRIC' },
    })
    expect(helpers.normalizeAttendanceComprehensiveHoursPreviewInput({
      userId: 'user-a',
      period: { type: 'month', year: 2026, month: 5 },
      capMinutes: 600,
      policyDraft: { metric: 'actuals' },
    })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_METRIC' },
    })
    expect(helpers.normalizeAttendanceComprehensiveHoursPreviewInput({
      userId: 'user-a',
      period: { type: 'month', year: 2026, month: 5 },
      capMinutes: 600,
      enforcement: 'deny',
    })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ENFORCEMENT' },
    })
    expect(helpers.normalizeAttendanceComprehensiveHoursPreviewInput({
      userId: 'user-a',
      period: { type: 'month', year: 2026, month: 5 },
      capMinutes: 600,
      policyDraft: { enforcement: 'deny' },
    })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ENFORCEMENT' },
    })
    expect(helpers.normalizeAttendanceComprehensiveHoursPreviewInput({
      userId: 'user-a',
      period: { type: 'month', year: 2026, month: 5 },
      capMinutes: 600,
      metric: ' actual ',
      enforcement: ' block ',
    })).toMatchObject({
      ok: true,
      input: {
        metric: 'actual',
        enforcement: 'block',
      },
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

describe('comprehensive-hours cap-policy persistence (V1)', () => {
  const settingsWith = (capDefaults: Record<string, number | null>) => ({
    comprehensiveHours: { capDefaults },
  })

  // R1 — resolver contract: org default by cycle-type for month/quarter/year.
  it('R1: resolves the org default cap per cycle-type', () => {
    const settings = settingsWith({ month: 10560, quarter: 31680, year: 126720 })
    for (const [type, expected] of [['month', 10560], ['quarter', 31680], ['year', 126720]] as const) {
      const resolved = helpers.resolveAttendanceComprehensiveHoursCap(settings, 'org-1', 'u-1', { type, key: 'k' })
      expect(resolved).not.toBeNull()
      expect(resolved.capMinutes).toBe(expected)
      expect(resolved.source).toBe('org_default_by_cycle_type')
    }
  })

  // R2 (resolver half) — no cap configured → null (not 0, not error). The sync-side
  // stale-null behaviour is exercised by PR6 against the real wire.
  it('R2: returns null when the cap is unset for the cycle-type', () => {
    const settings = settingsWith({ month: null, quarter: null, year: null })
    expect(helpers.resolveAttendanceComprehensiveHoursCap(settings, 'org-1', 'u-1', { type: 'month', key: 'k' })).toBeNull()
    expect(helpers.resolveAttendanceComprehensiveHoursCap({}, 'org-1', 'u-1', { type: 'year', key: 'k' })).toBeNull()
  })

  // R3 — payroll_cycle / custom_range have no org default in V1 → null.
  it('R3: payroll_cycle and custom_range resolve to null in V1', () => {
    const settings = settingsWith({ month: 10560, quarter: 31680, year: 126720 })
    expect(helpers.resolveAttendanceComprehensiveHoursCap(settings, 'org-1', 'u-1', { type: 'payroll_cycle', key: 'c' })).toBeNull()
    expect(helpers.resolveAttendanceComprehensiveHoursCap(settings, 'org-1', 'u-1', { type: 'custom_range', key: 'r' })).toBeNull()
  })

  // R5 — fingerprintPayload keys are exactly the companion catalog codes PR6 relies on.
  it('R5: fingerprintPayload carries exactly the companion cap codes', () => {
    const resolved = helpers.resolveAttendanceComprehensiveHoursCap(
      settingsWith({ month: 10560, quarter: null, year: null }), 'org-1', 'u-1', { type: 'month', key: '2026-03' },
    )
    expect(Object.keys(resolved.fingerprintPayload).sort()).toEqual([
      'comprehensive_hours_cap_effective_key',
      'comprehensive_hours_cap_minutes',
      'comprehensive_hours_cap_source',
    ])
    expect(resolved.fingerprintPayload.comprehensive_hours_cap_minutes).toBe(10560)
    expect(resolved.fingerprintPayload.comprehensive_hours_cap_source).toBe('org_default_by_cycle_type')
    expect(resolved.fingerprintPayload.comprehensive_hours_cap_effective_key).toMatch(/^cfg:[0-9a-f]{12}$/)
  })

  // R4 (payload half) — a cap edit changes effective_key, so the row's fingerprint changes
  // and it re-syncs on the next pass. (The actual re-sync is exercised by PR6.)
  it('R4: effective_key changes when any cap default changes', () => {
    const a = helpers.buildAttendanceComprehensiveHoursCapEffectiveKey({ month: 10560, quarter: null, year: null })
    const b = helpers.buildAttendanceComprehensiveHoursCapEffectiveKey({ month: 10561, quarter: null, year: null })
    const aAgain = helpers.buildAttendanceComprehensiveHoursCapEffectiveKey({ month: 10560, quarter: null, year: null })
    expect(a).not.toBe(b)
    expect(a).toBe(aAgain)
  })

  // R7 — period-type bridge: exact natural windows map to month/quarter/year; others to
  // custom_range; so org defaults are reachable through the date_range producer.
  it('R7: bridges date_range windows to the correct cycle-type', () => {
    expect(helpers.bridgeAttendanceDateRangeToComprehensiveHoursPeriod('2026-03-01', '2026-03-31'))
      .toMatchObject({ type: 'month', key: '2026-03' })
    expect(helpers.bridgeAttendanceDateRangeToComprehensiveHoursPeriod('2026-01-01', '2026-03-31'))
      .toMatchObject({ type: 'quarter', key: '2026-Q1' })
    expect(helpers.bridgeAttendanceDateRangeToComprehensiveHoursPeriod('2026-02-01', '2026-02-28'))
      .toMatchObject({ type: 'month', key: '2026-02' })
    expect(helpers.bridgeAttendanceDateRangeToComprehensiveHoursPeriod('2026-01-01', '2026-12-31'))
      .toMatchObject({ type: 'year', key: '2026' })
    expect(helpers.bridgeAttendanceDateRangeToComprehensiveHoursPeriod('2026-03-02', '2026-03-30'))
      .toMatchObject({ type: 'custom_range' })
    expect(helpers.bridgeAttendanceDateRangeToComprehensiveHoursPeriod('2026-01-01', '2026-04-15'))
      .toMatchObject({ type: 'custom_range' })
  })

  // R7 end-to-end — a bridged natural-month window reaches the org default.
  it('R7: a bridged natural-month window resolves the month org default', () => {
    const period = helpers.bridgeAttendanceDateRangeToComprehensiveHoursPeriod('2026-03-01', '2026-03-31')
    const resolved = helpers.resolveAttendanceComprehensiveHoursCap(
      settingsWith({ month: 10560, quarter: null, year: null }), 'org-1', 'u-1', period,
    )
    expect(resolved?.capMinutes).toBe(10560)
  })

  // Settings normalizer — caps are positive integers or null; junk coerces to null.
  it('normalizer: cap defaults are positive integers or null', () => {
    const normalized = helpers.normalizeAttendanceComprehensiveHoursSettings({
      capDefaults: { month: 600, quarter: -5, year: 'nope', day: 99 },
    })
    expect(normalized.capDefaults).toEqual({ month: 600, quarter: null, year: null })
    expect(helpers.normalizeAttendanceComprehensiveHoursSettings(undefined).capDefaults)
      .toEqual({ month: null, quarter: null, year: null })
  })

  // Merge — a partial capDefaults update must NOT clear the other cycle-types' caps
  // (deep-merge), and the merged result is normalized.
  it('mergeSettings deep-merges capDefaults so a partial update preserves the rest', () => {
    const base = { comprehensiveHours: { capDefaults: { month: 10560, quarter: 31680, year: 126720 } } }
    const merged = helpers.mergeSettings(base, { comprehensiveHours: { capDefaults: { month: 10561 } } })
    expect(merged.comprehensiveHours.capDefaults).toEqual({ month: 10561, quarter: 31680, year: 126720 })
    // An unrelated update leaves caps intact.
    const merged2 = helpers.mergeSettings(base, { minPunchIntervalMinutes: 5 })
    expect(merged2.comprehensiveHours.capDefaults).toEqual({ month: 10560, quarter: 31680, year: 126720 })
  })

  // Save-path guard (static): the PUT /api/attendance/settings zod schema MUST accept
  // comprehensiveHours.capDefaults, otherwise the save path silently strips it and the
  // cap is never persisted. The real-wire round-trip is asserted in the integration test.
  it('settingsSchema accepts comprehensiveHours.capDefaults (not stripped on save)', () => {
    expect(pluginSource).toMatch(/comprehensiveHours:\s*z\.object\(\{\s*\n\s*capDefaults:\s*z\.object\(\{/)
    expect(pluginSource).toMatch(/capDefaults:\s*z\.object\(\{\s*\n\s*month:\s*z\.number\(\)/)
  })
})

describe('comprehensive-hours period value-plumbing (PR6)', () => {
  const orgId = 'org-1'
  const userId = 'u-1'
  // Exact natural March → bridges to cycle-type 'month'.
  const naturalMonth = {
    periodType: 'date_range',
    from: '2026-03-01',
    to: '2026-03-31',
    periodKey: '2026-03',
    periodName: 'Mar 2026',
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
  }
  const logger = { warn() {}, error() {}, info() {} }
  const monthCap = (minutes: number | null) => ({ comprehensiveHours: { capDefaults: { month: minutes, quarter: null, year: null } } })

  beforeEach(() => helpers.resetAttendanceSettingsCacheForTests())
  afterEach(() => helpers.resetAttendanceSettingsCacheForTests())

  function createMultitableContext() {
    const createRecord = vi.fn().mockResolvedValue({ id: 'rec-new' })
    const patchRecord = vi.fn().mockResolvedValue({})
    const queryRecords = vi.fn().mockResolvedValue([])
    const ensureObject = vi.fn().mockResolvedValue({ baseId: 'base-1', sheet: { id: 'sheet-1' } })
    return {
      createRecord,
      patchRecord,
      queryRecords,
      // No resolveFieldIds → the sync uses identity field mapping, so logical id === physical id.
      context: { api: { multitable: { provisioning: { ensureObject }, records: { queryRecords, createRecord, patchRecord } } } },
    }
  }

  function createSyncDb(settings: unknown, totalMinutes = 13000) {
    const queries: Array<{ sql: string, params: unknown[] }> = []
    const summaryRow = {
      total_days: 22, total_minutes: totalMinutes, total_late_minutes: 0, total_early_leave_minutes: 0,
      normal_days: 22, late_days: 0, early_leave_days: 0, late_early_days: 0, partial_days: 0,
      absent_days: 0, adjusted_days: 0, off_days: 9,
    }
    return {
      queries,
      async query(sql: string, params: unknown[] = []) {
        const s = String(sql)
        queries.push({ sql: s, params })
        if (/FROM system_configs/i.test(s)) return [{ value: JSON.stringify(settings) }]
        if (/is_workday THEN work_minutes/i.test(s)) return [summaryRow]
        if (/FROM attendance_requests/i.test(s)) return []
        if (/FROM users u/i.test(s)) return [{ user_name: 'U One', username: 'u1', meta: null }]
        if (/FROM attendance_leave_types/i.test(s)) return []
        if (/FROM attendance_overtime_rules/i.test(s)) return []
        throw new Error('unmocked query: ' + s.replace(/\s+/g, ' ').slice(0, 90))
      },
    }
  }

  // --- value helper: stale-null + cap (no DB) ---
  it('value helper: aligned date_range with cap → excess; others → null', () => {
    const withCap = helpers.buildAttendanceComprehensiveHoursPeriodSummaryValues(monthCap(10560), orgId, userId, naturalMonth, 13000)
    expect(withCap).toEqual({
      comprehensive_hours_excess_minutes: 2440,
      comprehensive_hours_cap_minutes: 10560,
      comprehensive_hours_cap_source: 'org_default_by_cycle_type',
      comprehensive_hours_cap_effective_key: expect.stringMatching(/^cfg:[0-9a-f]{12}$/),
    })
    const allNull = {
      comprehensive_hours_excess_minutes: null,
      comprehensive_hours_cap_minutes: null,
      comprehensive_hours_cap_source: null,
      comprehensive_hours_cap_effective_key: null,
    }
    expect(helpers.buildAttendanceComprehensiveHoursPeriodSummaryValues({}, orgId, userId, naturalMonth, 13000)).toEqual(allNull)
    // Fail-closed periodType whitelist: a date_range proceeds; a payroll_cycle WITHOUT a
    // templateId stale-nulls (this is the P4 anchor for the payroll-cycle mapping block below —
    // do NOT "fix" it by adding a templateId; templateId-less must remain null).
    expect(helpers.buildAttendanceComprehensiveHoursPeriodSummaryValues(monthCap(10560), orgId, userId, { ...naturalMonth, periodType: 'payroll_cycle' }, 13000)).toEqual(allNull)
    expect(helpers.buildAttendanceComprehensiveHoursPeriodSummaryValues(monthCap(10560), orgId, userId, { ...naturalMonth, periodType: 'custom_range' }, 13000)).toEqual(allNull)
    expect(helpers.buildAttendanceComprehensiveHoursPeriodSummaryValues(monthCap(10560), orgId, userId, { ...naturalMonth, periodType: 'some_future_type' }, 13000)).toEqual(allNull)
    expect(helpers.buildAttendanceComprehensiveHoursPeriodSummaryValues(monthCap(10560), orgId, userId, { from: '2026-03-01', to: '2026-03-31' }, 13000)).toEqual(allNull)
    // A non-aligned date_range still proceeds to the bridge, which yields custom_range → null.
    expect(helpers.buildAttendanceComprehensiveHoursPeriodSummaryValues(monthCap(10560), orgId, userId, { periodType: 'date_range', from: '2026-03-02', to: '2026-03-30' }, 13000)).toEqual(allNull)
  })

  // --- stale-null through the real sync ---
  it('sync stale-nulls the comprehensive-hours columns when no org default applies', async () => {
    const mt = createMultitableContext()
    const result = await helpers.syncAttendanceReportPeriodSummary(mt.context, createSyncDb(monthCap(null)), orgId, logger, { userId, period: naturalMonth })
    expect(result.created).toBe(1)
    const data = mt.createRecord.mock.calls[0][0].data
    expect(data.comprehensive_hours_excess_minutes).toBeNull()
    expect(data.comprehensive_hours_cap_minutes).toBeNull()
    expect(data.comprehensive_hours_cap_source).toBeNull()
    expect(data.comprehensive_hours_cap_effective_key).toBeNull()
  })

  it('sync writes the computed excess + cap companion fields when a cap is configured', async () => {
    const mt = createMultitableContext()
    await helpers.syncAttendanceReportPeriodSummary(mt.context, createSyncDb(monthCap(10560)), orgId, logger, { userId, period: naturalMonth })
    const data = mt.createRecord.mock.calls[0][0].data
    expect(data.comprehensive_hours_excess_minutes).toBe(2440)
    expect(data.comprehensive_hours_cap_minutes).toBe(10560)
    expect(data.comprehensive_hours_cap_source).toBe('org_default_by_cycle_type')
    expect(data.comprehensive_hours_cap_effective_key).toMatch(/^cfg:/)
  })

  // --- cap-fingerprint re-sync (capture-and-replay through the real fingerprint mechanism) ---
  it('re-syncs on cap change and skips when unchanged', async () => {
    const mt = createMultitableContext()
    const r1 = await helpers.syncAttendanceReportPeriodSummary(mt.context, createSyncDb(monthCap(10560)), orgId, logger, { userId, period: naturalMonth })
    expect(r1.created).toBe(1)
    const stored = mt.createRecord.mock.calls[0][0].data
    mt.queryRecords.mockResolvedValue([{ id: 'rec-1', data: stored }])

    helpers.resetAttendanceSettingsCacheForTests()
    const r2 = await helpers.syncAttendanceReportPeriodSummary(mt.context, createSyncDb(monthCap(10560)), orgId, logger, { userId, period: naturalMonth })
    expect(r2.skipped).toBe(1)
    expect(mt.patchRecord).not.toHaveBeenCalled()

    helpers.resetAttendanceSettingsCacheForTests()
    const r3 = await helpers.syncAttendanceReportPeriodSummary(mt.context, createSyncDb(monthCap(9000)), orgId, logger, { userId, period: naturalMonth })
    expect(r3.patched).toBe(1)
    const changes = mt.patchRecord.mock.calls[0][0].changes
    expect(changes.comprehensive_hours_cap_minutes).toBe(9000)
    expect(changes.comprehensive_hours_excess_minutes).toBe(4000)
  })

  it('re-syncs a pre-PR6 row whose fingerprint predates the comprehensive-hours columns', async () => {
    const mt = createMultitableContext()
    mt.queryRecords.mockResolvedValue([{ id: 'rec-old', data: { source_fingerprint: 'stale-old-fp', field_fingerprint: 'stale-old-ff' } }])
    const result = await helpers.syncAttendanceReportPeriodSummary(mt.context, createSyncDb(monthCap(10560)), orgId, logger, { userId, period: naturalMonth })
    expect(result.patched).toBe(1)
    expect(mt.patchRecord).toHaveBeenCalledTimes(1)
  })

  // --- no raw meta / snapshot-table write: snapshot writes go through the multitable records API only ---
  it('performs no raw INSERT/UPDATE/DELETE and never touches meta_ or the snapshot table directly', async () => {
    const mt = createMultitableContext()
    const db = createSyncDb(monthCap(10560))
    await helpers.syncAttendanceReportPeriodSummary(mt.context, db, orgId, logger, { userId, period: naturalMonth })
    expect(db.queries.filter((q) => /\b(INSERT|UPDATE|DELETE)\b/i.test(q.sql))).toEqual([])
    expect(db.queries.some((q) => /attendance_report_period_summaries|\bmeta_/i.test(q.sql))).toBe(false)
    // The only snapshot writes are through the records API.
    expect(mt.createRecord).toHaveBeenCalledTimes(1)
  })

  // --- no parallel producer + wiring + ordering (source-level guards) ---
  it('no parallel comprehensive-hours producer; helper wired into the sync after the loop and before the fingerprint', () => {
    expect(pluginSource).not.toMatch(/async function sync[A-Za-z]*Comprehensive[A-Za-z]*\b/)
    expect(pluginSource).toMatch(/buildAttendanceComprehensiveHoursPeriodSummaryValues\(/)
    expect(pluginSource).toMatch(
      /for \(const column of valueColumns\)[\s\S]*?Object\.assign\(logical, comprehensiveHoursValues\)[\s\S]*?buildAttendanceReportPeriodSummarySourceFingerprint\(logical\)/,
    )
  })
})

// Coarse payroll_cycle → month cap mapping (V1) — design-lock:
// docs/development/attendance-comprehensive-hours-payroll-cycle-cap-mapping-design-20260526.md
describe('comprehensive-hours payroll_cycle cap-mapping (§7 precise template-window)', () => {
  const orgId = 'org-1'
  const userId = 'u-1'
  const logger = { warn() {}, error() {}, info() {} }
  const monthCap = (minutes: number | null) => ({ comprehensiveHours: { capDefaults: { month: minutes, quarter: null, year: null } } })
  const PAYROLL_SOURCE = helpers.ATTENDANCE_COMPREHENSIVE_HOURS_CAP_SOURCE_PAYROLL_MONTHLY
  const allNull = {
    comprehensive_hours_excess_minutes: null,
    comprehensive_hours_cap_minutes: null,
    comprehensive_hours_cap_source: null,
    comprehensive_hours_cap_effective_key: null,
  }
  // A template-verified payroll cycle: in-span (≤62d), templateId present, and (§7) its dates
  // MATCH the template window — the producer sets templateWindowMatches:true. Dates here are a
  // cross-month pay window (26th→25th), deliberately NOT a natural calendar month, so the
  // date_range bridge would yield custom_range; the payroll branch maps it to month.
  const payrollCycle = (overrides: Record<string, unknown> = {}) => ({
    periodType: 'payroll_cycle',
    periodKey: 'cycle:c-1',
    cycleId: 'c-1',
    templateId: 'tpl-1',
    templateWindowMatches: true,
    from: '2026-02-26',
    to: '2026-03-25',
    periodStart: '2026-02-26',
    periodEnd: '2026-03-25',
    ...overrides,
  })
  const build = (settings: unknown, period: Record<string, unknown>, minutes = 13000) =>
    helpers.buildAttendanceComprehensiveHoursPeriodSummaryValues(settings, orgId, userId, period, minutes)

  // P1 — template + span≤62 + month cap set → excess against month cap; payroll source label.
  it('P1: template-bound, in-span, month cap set → month cap with payroll source', () => {
    expect(build(monthCap(10560), payrollCycle())).toEqual({
      comprehensive_hours_excess_minutes: 2440,
      comprehensive_hours_cap_minutes: 10560,
      comprehensive_hours_cap_source: PAYROLL_SOURCE,
      comprehensive_hours_cap_effective_key: expect.stringMatching(/^cfg:[0-9a-f]{12}$/),
    })
  })

  // P2 — cross-month window the date_range bridge canNOT map (→ custom_range → null), but the
  // payroll branch maps to month. This proves the new path CHANGES behavior, not just "no regression".
  it('P2: cross-month (26th→25th) — bridge would null, payroll branch resolves month', () => {
    const bridged = helpers.bridgeAttendanceDateRangeToComprehensiveHoursPeriod('2026-02-26', '2026-03-25')
    expect(bridged.type).toBe('custom_range')
    expect(helpers.resolveAttendanceComprehensiveHoursCap(monthCap(10560), orgId, userId, bridged)).toBeNull()
    const values = build(monthCap(10560), payrollCycle())
    expect(values.comprehensive_hours_cap_minutes).toBe(10560)
    expect(values.comprehensive_hours_cap_source).toBe(PAYROLL_SOURCE)
  })

  // P3 — month cap unset → stale-null.
  it('P3: month cap unset → null', () => {
    expect(build(monthCap(null), payrollCycle())).toEqual(allNull)
  })

  // P4 — templateId null → null. (See also the anchor assertion in the PR6 block above.)
  it('P4: templateId null → null (no monthly-cadence signal)', () => {
    expect(build(monthCap(10560), payrollCycle({ templateId: null }))).toEqual(allNull)
    expect(build(monthCap(10560), payrollCycle({ templateId: undefined }))).toEqual(allNull)
  })

  // P5 — span > 62d (anomaly / multi-month) → null even with a templateId.
  it('P5: span > 62d → null', () => {
    expect(build(monthCap(10560), payrollCycle({ from: '2026-01-01', to: '2026-03-31' }))).toEqual(allNull)
  })

  // P5b — §7 PRECISE BEHAVIOR (flipped from the V1 coarse heuristic): templateId present,
  // span≤62, but the cycle dates do NOT match the template window, so the producer sets
  // templateWindowMatches:false. The builder now stale-nulls (under V1 this case resolved month).
  // This is the imprecision the §7 upgrade removes.
  it('P5b: in-span but date-mismatched cycle (templateWindowMatches:false) → null (§7)', () => {
    const offWindow = payrollCycle({ from: '2026-03-10', to: '2026-04-08', templateWindowMatches: false })
    expect(build(monthCap(10560), offWindow)).toEqual(allNull)
  })

  // §7 gate — templateWindowMatches is REQUIRED (not just templateId). Absent/false → null even
  // for an in-span, template-bound cycle. Guards the builder against a producer that fails or
  // skips verification (fail-closed).
  it('§7 gate: templateWindowMatches must be exactly true (false/undefined → null)', () => {
    expect(build(monthCap(10560), payrollCycle({ templateWindowMatches: false }))).toEqual(allNull)
    expect(build(monthCap(10560), payrollCycle({ templateWindowMatches: undefined }))).toEqual(allNull)
    // Truthy-but-not-true must not satisfy the strict === true check.
    expect(build(monthCap(10560), payrollCycle({ templateWindowMatches: 1 as unknown as boolean }))).toEqual(allNull)
  })

  // Span guard — direct unit coverage of the ≤62 (inclusive) boundary.
  it('span guard: ≤62 inclusive passes, 63 fails, invalid/reversed fails', () => {
    expect(helpers.attendancePayrollCycleWithinMonthlySpan('2026-02-26', '2026-03-25')).toBe(true)
    expect(helpers.attendancePayrollCycleWithinMonthlySpan('2026-01-01', '2026-03-03')).toBe(true) // 62 inclusive
    expect(helpers.attendancePayrollCycleWithinMonthlySpan('2026-01-01', '2026-03-04')).toBe(false) // 63
    expect(helpers.attendancePayrollCycleWithinMonthlySpan('2026-03-25', '2026-02-26')).toBe(false) // reversed
    expect(helpers.attendancePayrollCycleWithinMonthlySpan('not-a-date', '2026-03-25')).toBe(false)
  })

  // Source-label contract lock — the literal is a snapshot column value; pin it.
  it('source label is the locked payroll literal, distinct from the calendar default', () => {
    expect(PAYROLL_SOURCE).toBe('payroll_cycle_template_monthly')
    expect(helpers.ATTENDANCE_COMPREHENSIVE_HOURS_CAP_SOURCE_DEFAULT).toBe('org_default_by_cycle_type')
    expect(PAYROLL_SOURCE).not.toBe(helpers.ATTENDANCE_COMPREHENSIVE_HOURS_CAP_SOURCE_DEFAULT)
  })

  // P8 — date_range path is untouched (still the calendar default source).
  it('P8: date_range path unchanged (calendar default source)', () => {
    const naturalMonth = { periodType: 'date_range', from: '2026-03-01', to: '2026-03-31' }
    const values = build(monthCap(10560), naturalMonth)
    expect(values.comprehensive_hours_cap_minutes).toBe(10560)
    expect(values.comprehensive_hours_cap_source).toBe('org_default_by_cycle_type')
  })

  // A 26th→25th monthly template: start_day 26, end_day 25, end_month_offset 1. Anchored on a
  // cycle start of 2026-02-26 it generates the window 2026-02-26 .. 2026-03-25.
  const monthlyTemplate26 = { id: 'tpl-9', org_id: orgId, name: 'monthly 26', timezone: 'UTC', start_day: 26, end_day: 25, end_month_offset: 1, auto_generate: true, config: null, is_default: true }
  const cycleId = '11111111-1111-4111-8111-111111111111'
  // db mock for the producer: serves the cycle row + (optionally) the template row.
  const producerDb = (opts: { templateId: string | null, start?: string, end?: string, template?: Record<string, unknown> | null }) => ({
    async query(sql: string, params: unknown[] = []) {
      const s = String(sql)
      if (/FROM attendance_payroll_cycles/i.test(s)) {
        return [{ id: cycleId, org_id: orgId, template_id: opts.templateId, name: 'cycle', start_date: opts.start ?? '2026-02-26', end_date: opts.end ?? '2026-03-25', status: 'open', metadata: null }]
      }
      if (/FROM attendance_payroll_templates/i.test(s)) {
        return opts.template === null ? [] : [opts.template ?? monthlyTemplate26]
      }
      throw new Error('unmocked query: ' + s + ' :: ' + JSON.stringify(params))
    },
  })

  // WIRE-VS-FIXTURE (mandatory): the producer must EMIT templateId AND compute templateWindowMatches
  // onto the payroll_cycle period — the builder tests above use synthetic periods and cannot catch a
  // producer that forgets either (cf. the #1781 dayIndex serialization drift). Exercise the real producer.
  it('producer carries templateId + templateWindowMatches (true when dates match the template window)', async () => {
    const matched = await helpers.resolveAttendanceReportPeriodSyncPeriod(producerDb({ templateId: 'tpl-9' }), orgId, { cycleId })
    expect(matched.ok).toBe(true)
    expect(matched.period.periodType).toBe('payroll_cycle')
    expect(matched.period.templateId).toBe('tpl-9')
    expect(matched.period.from).toBe('2026-02-26')
    expect(matched.period.templateWindowMatches).toBe(true)
  })

  it('producer sets templateWindowMatches false when the cycle dates do NOT match the template window', async () => {
    // Hand-entered window 2026-03-10..2026-04-08 — the template would generate 2026-02-26..2026-03-25.
    const mismatch = await helpers.resolveAttendanceReportPeriodSyncPeriod(producerDb({ templateId: 'tpl-9', start: '2026-03-10', end: '2026-04-08' }), orgId, { cycleId })
    expect(mismatch.period.templateId).toBe('tpl-9')
    expect(mismatch.period.templateWindowMatches).toBe(false)
  })

  it('producer sets templateId null + templateWindowMatches false when the cycle has no template', async () => {
    const noTpl = await helpers.resolveAttendanceReportPeriodSyncPeriod(producerDb({ templateId: null }), orgId, { cycleId })
    expect(noTpl.period.templateId).toBeNull()
    expect(noTpl.period.templateWindowMatches).toBe(false)
  })

  it('producer fails closed (templateWindowMatches false) when the template row is missing', async () => {
    const gone = await helpers.resolveAttendanceReportPeriodSyncPeriod(producerDb({ templateId: 'tpl-9', template: null }), orgId, { cycleId })
    expect(gone.period.templateWindowMatches).toBe(false)
  })

  // Direct unit coverage of the §7 verify helper — incl. the fail-closed catch on a throwing db
  // (an old/partial schema must NOT 503 the period sync; it degrades to "unverified" → no cap).
  it('verify helper: matches / mismatches / no-template / db-error all behave fail-closed', async () => {
    const ok = await helpers.verifyAttendancePayrollCycleTemplateWindow(producerDb({ templateId: 'tpl-9' }), orgId, { templateId: 'tpl-9', startDate: '2026-02-26', endDate: '2026-03-25' })
    expect(ok).toBe(true)
    const bad = await helpers.verifyAttendancePayrollCycleTemplateWindow(producerDb({ templateId: 'tpl-9' }), orgId, { templateId: 'tpl-9', startDate: '2026-03-10', endDate: '2026-04-08' })
    expect(bad).toBe(false)
    const none = await helpers.verifyAttendancePayrollCycleTemplateWindow(producerDb({ templateId: 'tpl-9' }), orgId, { templateId: null, startDate: '2026-02-26', endDate: '2026-03-25' })
    expect(none).toBe(false)
    // Calendar-month template shape (start_day 1, end_day 31, offset 0) must also verify true —
    // proves the helper handles same-month windows, not only the cross-month 26th→25th shape.
    const calTemplate = { id: 'tpl-cal', org_id: orgId, name: 'cal', timezone: 'UTC', start_day: 1, end_day: 31, end_month_offset: 0, auto_generate: true, config: null, is_default: false }
    const cal = await helpers.verifyAttendancePayrollCycleTemplateWindow(producerDb({ templateId: 'tpl-cal', template: calTemplate }), orgId, { templateId: 'tpl-cal', startDate: '2026-03-01', endDate: '2026-03-31' })
    expect(cal).toBe(true)
    const throwingDb = { async query() { throw new Error('relation "attendance_payroll_templates" does not exist') } }
    const errored = await helpers.verifyAttendancePayrollCycleTemplateWindow(throwingDb, orgId, { templateId: 'tpl-9', startDate: '2026-02-26', endDate: '2026-03-25' })
    expect(errored).toBe(false)
  })

  // P7 — cap edit changes effective_key → a payroll_cycle row re-syncs (run on the PAYROLL
  // branch explicitly; same fingerprint mechanism as date_range but assert it here).
  it('P7: cap edit re-syncs a payroll_cycle row through the real sync', async () => {
    helpers.resetAttendanceSettingsCacheForTests()
    const createRecord = vi.fn().mockResolvedValue({ id: 'rec-new' })
    const patchRecord = vi.fn().mockResolvedValue({})
    const queryRecords = vi.fn().mockResolvedValue([])
    const ensureObject = vi.fn().mockResolvedValue({ baseId: 'base-1', sheet: { id: 'sheet-1' } })
    const context = { api: { multitable: { provisioning: { ensureObject }, records: { queryRecords, createRecord, patchRecord } } } }
    const syncDb = (settings: unknown) => ({
      async query(sql: string) {
        const s = String(sql)
        if (/FROM system_configs/i.test(s)) return [{ value: JSON.stringify(settings) }]
        if (/is_workday THEN work_minutes/i.test(s)) return [{ total_days: 22, total_minutes: 13000, total_late_minutes: 0, total_early_leave_minutes: 0, normal_days: 22, late_days: 0, early_leave_days: 0, late_early_days: 0, partial_days: 0, absent_days: 0, adjusted_days: 0, off_days: 9 }]
        if (/FROM attendance_requests/i.test(s)) return []
        if (/FROM users u/i.test(s)) return [{ user_name: 'U One', username: 'u1', meta: null }]
        if (/FROM attendance_leave_types/i.test(s)) return []
        if (/FROM attendance_overtime_rules/i.test(s)) return []
        throw new Error('unmocked query: ' + s.replace(/\s+/g, ' ').slice(0, 90))
      },
    })
    const period = payrollCycle()
    const r1 = await helpers.syncAttendanceReportPeriodSummary(context, syncDb(monthCap(10560)), orgId, logger, { userId, period })
    expect(r1.created).toBe(1)
    const stored = createRecord.mock.calls[0][0].data
    expect(stored.comprehensive_hours_cap_source).toBe(PAYROLL_SOURCE)
    expect(stored.comprehensive_hours_cap_minutes).toBe(10560)
    queryRecords.mockResolvedValue([{ id: 'rec-1', data: stored }])

    helpers.resetAttendanceSettingsCacheForTests()
    const r2 = await helpers.syncAttendanceReportPeriodSummary(context, syncDb(monthCap(9000)), orgId, logger, { userId, period })
    expect(r2.patched).toBe(1)
    expect(patchRecord.mock.calls[0][0].changes.comprehensive_hours_cap_minutes).toBe(9000)
  })
})
