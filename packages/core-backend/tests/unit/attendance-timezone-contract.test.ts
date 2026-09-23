import { afterEach, describe, expect, it, vi } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs') as {
  resetAttendanceSettingsCacheForTests: () => void
  primeAttendanceSettingsCacheForTests: (raw: unknown) => void
  __attendanceTimezoneContractForTests: {
    computeAutoAbsenceNextRunAt: (input: { now: Date; timeZone: string; runAt: string }) => number | null
    normalizeCsvWorkDate: (value: unknown, timeZone?: string | null) => string | null
    resolveImportCsvWorkDateTimeZone: (input: {
      ruleTimezone?: string | null
      payloadTimezone?: string | null
      groupTimezone?: string | null
    }) => string | null
    resolveImportCsvCalendarTimeZone: (db: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }, orgId: string, payload: Record<string, unknown>) => Promise<string | null>
    iterateImportRowsFromCsv: (input: {
      csvText: string
      timeZone?: string | null
      onRow?: (row: { workDate: string; workDateWarning?: string }) => boolean
    }) => { rowCount: number }
    scheduleAutoAbsence: (input: {
      db: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }
      logger: { error: (message: string, extra?: unknown) => void; info: (message: string, extra?: unknown) => void }
      emit: () => void
      w4Boundary: object | null
    }) => void
    clearAutoAbsenceSchedule: () => void
    toWorkDate: (value: Date, timeZone: string) => string
    CSV_EPOCH_TIMEZONE_WARNING: string
  }
}

const helpers = attendancePlugin.__attendanceTimezoneContractForTests
const SHANGHAI_EPOCH_MS = Date.parse('2026-09-22T16:30:00.000Z')

function ruleRow(orgId: string, timezone: string) {
  return [{
    id: `rule-${orgId}`,
    org_id: orgId,
    name: 'Default',
    timezone,
    work_start_time: '09:00',
    work_end_time: '18:00',
    late_grace_minutes: 10,
    early_grace_minutes: 10,
    severe_late_threshold_minutes: 30,
    absence_late_threshold_minutes: 60,
    rounding_minutes: 5,
    working_days: [1, 2, 3, 4, 5],
    is_default: true,
  }]
}

afterEach(() => {
  helpers.clearAutoAbsenceSchedule()
  attendancePlugin.resetAttendanceSettingsCacheForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('attendance timezone contract', () => {
  it('computes auto-absence runAt in the rule IANA zone, including across a DST spring-forward', () => {
    const now = new Date('2026-09-22T16:00:00.000Z')
    const shanghai = helpers.computeAutoAbsenceNextRunAt({
      now,
      timeZone: 'Asia/Shanghai',
      runAt: '00:15',
    })
    expect(shanghai).toBe(Date.parse('2026-09-22T16:15:00.000Z'))

    const utcWall = new Date(now)
    utcWall.setUTCHours(0, 15, 0, 0)
    if (utcWall.getTime() <= now.getTime()) utcWall.setUTCDate(utcWall.getUTCDate() + 1)
    expect(shanghai).not.toBe(utcWall.getTime())

    const justAfterPstRun = new Date('2026-03-08T08:16:00.000Z')
    expect(helpers.computeAutoAbsenceNextRunAt({
      now: justAfterPstRun,
      timeZone: 'America/Los_Angeles',
      runAt: '00:15',
    })).toBe(Date.parse('2026-03-09T07:15:00.000Z'))
    expect(helpers.computeAutoAbsenceNextRunAt({
      now,
      timeZone: 'Not/AZone',
      runAt: '00:15',
    })).toBeNull()
  })

  it('arms one timeout per org rule timezone instead of the process-local clock', async () => {
    const now = new Date('2026-09-22T16:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const delays: number[] = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number) => {
      delays.push(Number(timeout))
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)

    attendancePlugin.primeAttendanceSettingsCacheForTests({
      autoAbsence: { enabled: true, runAt: '00:15', lookbackDays: 1 },
    })
    helpers.scheduleAutoAbsence({
      db: {
        query: async (sql, params) => {
          const text = String(sql)
          if (text.includes('DISTINCT org_id')) {
            return [{ org_id: 'org-sh' }, { org_id: 'org-la' }]
          }
          if (text.includes('FROM attendance_rules')) {
            const orgId = String(params?.[0] ?? '')
            if (orgId === 'org-la') return ruleRow(orgId, 'America/Los_Angeles')
            return ruleRow(orgId, 'Asia/Shanghai')
          }
          return []
        },
      },
      logger: { error: () => undefined, info: () => undefined },
      emit: () => undefined,
      w4Boundary: {},
    })
    for (let i = 0; i < 20; i += 1) await Promise.resolve()

    const shanghaiDelay = Date.parse('2026-09-22T16:15:00.000Z') - now.getTime()
    const losAngelesDelay = Date.parse('2026-09-23T07:15:00.000Z') - now.getTime()
    expect(delays).toEqual(expect.arrayContaining([shanghaiDelay, losAngelesDelay]))
    expect(delays).not.toContain(24 * 60 * 60 * 1000)
  })

  it('maps CSV epoch days with the punch rule zone and refuses a bare UTC slice', () => {
    const epochMs = String(SHANGHAI_EPOCH_MS)
    const epochSeconds = String(Math.floor(SHANGHAI_EPOCH_MS / 1000))
    expect(helpers.normalizeCsvWorkDate(epochMs, 'Asia/Shanghai')).toBe('2026-09-23')
    expect(helpers.normalizeCsvWorkDate(epochSeconds, 'Asia/Shanghai')).toBe('2026-09-23')
    expect(helpers.normalizeCsvWorkDate(epochMs, 'UTC')).toBe('2026-09-22')
    expect(helpers.normalizeCsvWorkDate(epochMs, null)).toBeNull()
    expect(helpers.normalizeCsvWorkDate(epochMs, 'Not/AZone')).toBeNull()
    expect(helpers.normalizeCsvWorkDate('2026-09-23', 'UTC')).toBe('2026-09-23')
    expect(helpers.toWorkDate(new Date(SHANGHAI_EPOCH_MS), 'Asia/Shanghai')).toBe('2026-09-23')

    const rows: Array<{ workDate: string; workDateWarning?: string }> = []
    helpers.iterateImportRowsFromCsv({
      csvText: `姓名,日期,UserId\n张三,${epochMs},u1\n`,
      timeZone: 'Asia/Shanghai',
      onRow: (row) => {
        rows.push(row)
        return true
      },
    })
    expect(rows[0]?.workDate).toBe('2026-09-23')
    expect(rows[0]?.workDateWarning).toBeUndefined()

    const unresolved: Array<{ workDate: string; workDateWarning?: string }> = []
    helpers.iterateImportRowsFromCsv({
      csvText: `姓名,日期,UserId\n张三,${epochMs},u1\n`,
      onRow: (row) => {
        unresolved.push(row)
        return true
      },
    })
    expect(unresolved[0]?.workDate).toBe('')
    expect(unresolved[0]?.workDateWarning).toBe(helpers.CSV_EPOCH_TIMEZONE_WARNING)
  })

  it('prefers the import rule timezone, then payload, then group timezone', async () => {
    expect(helpers.resolveImportCsvWorkDateTimeZone({
      ruleTimezone: 'Asia/Shanghai',
      payloadTimezone: 'UTC',
      groupTimezone: 'America/Los_Angeles',
    })).toBe('Asia/Shanghai')
    expect(helpers.resolveImportCsvWorkDateTimeZone({
      ruleTimezone: 'Not/AZone',
      payloadTimezone: 'America/Los_Angeles',
      groupTimezone: 'UTC',
    })).toBe('America/Los_Angeles')
    expect(helpers.resolveImportCsvWorkDateTimeZone({
      ruleTimezone: '',
      payloadTimezone: '',
      groupTimezone: 'Asia/Shanghai',
    })).toBe('Asia/Shanghai')
    expect(helpers.resolveImportCsvWorkDateTimeZone({})).toBeNull()

    const db = {
      query: async (sql: string) => {
        const text = String(sql)
        if (text.includes('attendance_rule_sets')) {
          return [{ config: { rule: { timezone: 'America/Los_Angeles' } } }]
        }
        if (text.includes('attendance_rules')) return ruleRow('default', 'Asia/Shanghai')
        return []
      },
    }
    await expect(helpers.resolveImportCsvCalendarTimeZone(db, 'default', {
      ruleSetId: 'rule-set-1',
      timezone: 'UTC',
    })).resolves.toBe('America/Los_Angeles')
    await expect(helpers.resolveImportCsvCalendarTimeZone(db, 'default', {
      timezone: 'UTC',
      groupSync: { timezone: 'America/Los_Angeles' },
    })).resolves.toBe('Asia/Shanghai')
    await expect(helpers.resolveImportCsvCalendarTimeZone({
      query: async () => {
        throw new Error('db down')
      },
    }, 'default', {
      timezone: 'Asia/Shanghai',
    })).resolves.toBe('Asia/Shanghai')
  })
})
