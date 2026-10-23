import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAttendanceLocalWallTimeV1, validateAttendanceIanaTimezoneV1 } from '../../src/attendance/w4c1-strict-time'

const require = createRequire(import.meta.url)
const calendar = require('../../../../plugins/plugin-attendance/lib/attendance-daily-calendar.cjs')
const source = readFileSync(resolve(__dirname, '../../../../plugins/plugin-attendance/index.cjs'), 'utf8')
function fn(name: string) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))
  if (!match) throw new Error('DAILY_CALENDAR_TEST_SYMBOL_REQUIRED')
  return match[0]
}
const strictTime = { resolveLocalWallTime: resolveAttendanceLocalWallTimeV1, validateIanaTimezone: validateAttendanceIanaTimezoneV1 }
interface Plan { orgId: string; timeZone: string; rule: { timezone: string }; runAt: string }
interface Options {
  loadPlans(): Promise<unknown[]>
  refreshPlan(plan: { orgId: string }): Promise<Plan>
  runPlan(plan: Plan, isCurrent: () => boolean): Promise<void>
  strictTime: typeof strictTime
}
function harness(enabled = true, boundary: object | null = {}) {
  const options: Options[] = []
  const stop = vi.fn()
  const start = vi.fn(async () => {})
  const writer = vi.fn(async (_db: unknown, _input: unknown) => {})
  const holiday = vi.fn(async () => ({ years: [2026], totalFetched: 0, totalApplied: 0, totalSkipped: 0, totalIgnored: 0 }))
  const emit = vi.fn()
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
  const context = {
    ...calendar, Date,
    autoAbsenceSchedule: { stop }, autoHolidaySyncSchedule: { stop },
    settingsCache: { value: { autoAbsence: { enabled, runAt: '00:15', lookbackDays: 3 }, holidaySync: { auto: { enabled, runAt: '08:15', timezone: 'America/Los_Angeles' } } } },
    mapRuleRow: (row: unknown) => row,
    runAutoAbsenceForOrgDate: writer, performHolidaySync: holiday,
    createDailyCalendarScheduler: (value: Options) => { options.push(value); return { start, stop } },
  }
  const runtime = runInNewContext(`${['clearAutoAbsenceSchedule', 'clearHolidaySyncSchedule', 'scheduleAutoAbsence', 'scheduleHolidaySync'].map(fn).join('\n')}; ({ scheduleAutoAbsence, scheduleHolidaySync })`, context)
  const db = { query: vi.fn(async () => [{ org_id: 'daily-org', timezone: 'America/Los_Angeles' }]) }
  runtime.scheduleAutoAbsence({ db, logger, emit, w4Boundary: boundary, strictTime })
  return { runtime, db, logger, emit, writer, holiday, options, start, stop }
}
afterEach(() => { vi.useRealTimers() })

describe('daily calendar production wiring', () => {
  it.each<[boolean, object | null]>([[false, {}], [true, null]])('disabled or missing W4 boundary performs zero scheduling/DB/writes', (enabled, boundary) => {
    const h = harness(enabled, boundary)
    expect(h.stop).toHaveBeenCalledOnce()
    expect(h.options).toEqual([])
    expect(h.db.query).not.toHaveBeenCalled()
    expect(h.writer).not.toHaveBeenCalled()
  })
  it('uses strict org default, canonical W4 boundary and exact calendar dates; isolates each failed date', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-09T07:15Z'))
    const boundary = {}
    const h = harness(true, boundary)
    const plan = await h.options[0].refreshPlan({ orgId: 'daily-org' })
    h.writer.mockRejectedValueOnce(new Error('synthetic failure'))
    await h.options[0].runPlan(plan, () => true)
    expect(h.writer.mock.calls).toEqual(['2026-03-08', '2026-03-07', '2026-03-06'].map(workDate => [h.db, {
      orgId: 'daily-org', workDate, rule: plan.rule, logger: h.logger, emit: h.emit,
      w4Boundary: boundary, initiator: 'cron',
    }]))
    expect(h.logger.warn.mock.calls).toEqual([['Attendance daily calendar skipped', { code: 'DAILY_CALENDAR_ORG_DATE_FAILED' }]])
  })
  it('a superseded callback cannot initiate another lookback date', async () => {
    const h = harness()
    const plan = await h.options[0].refreshPlan({ orgId: 'daily-org' })
    let current = true
    h.writer.mockImplementationOnce(async () => { current = false })
    await h.options[0].runPlan(plan, () => current)
    expect(h.writer).toHaveBeenCalledOnce()
  })
  it('holiday uses the strict daily controller without changing its provider payload', async () => {
    const h = harness(false)
    h.runtime.scheduleHolidaySync({ db: h.db, logger: h.logger, emit: h.emit, strictTime })
    expect(h.options).toEqual([])
    const active = harness()
    active.runtime.scheduleHolidaySync({ db: active.db, logger: active.logger, emit: active.emit, strictTime })
    const options = active.options[1]
    expect(options.strictTime).toBe(strictTime)
    const plan = await options.refreshPlan({ orgId: 'daily-org' })
    expect(plan.timeZone).toBe('America/Los_Angeles')
    await options.runPlan(plan, () => true)
    expect(active.holiday.mock.calls).toEqual([[{ db: active.db, logger: active.logger, orgId: 'daily-org', settings: expect.any(Object), payload: {} }]])
    expect(active.emit.mock.calls).toEqual([['attendance.holiday.sync', {
      orgId: 'daily-org', years: [2026], totalFetched: 0, totalApplied: 0, totalSkipped: 0, totalIgnored: 0,
    }]])
  })
  it('keeps holiday provider work serial and isolates an org failure', async () => {
    const h = harness()
    h.db.query.mockResolvedValue([{ org_id: 'daily-a', timezone: 'UTC' }, { org_id: 'daily-b', timezone: 'UTC' }])
    h.runtime.scheduleHolidaySync({ db: h.db, logger: h.logger, emit: h.emit, strictTime })
    const options = h.options[1]
    const plan = await options.refreshPlan({ orgId: 'unused-plan-id' })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(done => { release = done })
    const started = new Promise<void>(done => { entered = done })
    h.holiday.mockImplementationOnce(async () => { entered(); await gate; throw new Error('synthetic failure') })
    const pending = options.runPlan(plan, () => true)
    await started
    expect(h.holiday).toHaveBeenCalledOnce()
    release()
    await pending
    expect(h.holiday.mock.calls).toEqual(['daily-a', 'daily-b'].map(orgId => [{ db: h.db, logger: h.logger, orgId, settings: expect.any(Object), payload: {} }]))
    expect(h.emit.mock.calls).toEqual([['attendance.holiday.sync', { orgId: 'daily-b', years: [2026], totalFetched: 0, totalApplied: 0, totalSkipped: 0, totalIgnored: 0 }]])
  })
  it('successful default-rule commit rearms before response; rollback/error path has no hook', () => {
    const route = source.slice(source.indexOf("      'PUT',\n      '/api/attendance/rules/default'"), source.indexOf("      'PUT',\n      '/api/attendance/rules/default'") + 8000)
    const success = route.slice(0, route.indexOf('} catch (error)'))
    expect(success).toMatch(/await verifyTripChange\(\)[\s\S]*return rows\[0\][\s\S]*\}\)[\s\S]*autoAbsenceSchedule\?\.rearm\(\{ orgId \}\)[\s\S]*res.json/)
    expect(success.match(/autoAbsenceSchedule\?\.rearm\(/g)).toHaveLength(1)
    expect(success).not.toContain('scheduleAutoAbsence(')
    const settings = source.slice(source.indexOf("      'PUT',\n      '/api/attendance/settings'"))
    const saved = settings.slice(0, settings.indexOf('} catch (error)'))
    expect(saved).toMatch(/await updateAttendanceSettings[\s\S]*scheduleAutoAbsence\([\s\S]*scheduleHolidaySync\(/)
  })
  it.each([undefined, '', 'Invalid/Zone', '+05:00'])('does not normalize an enabled holiday zone %j to UTC', timezone => {
    const declaration = source.slice(source.indexOf('  const holidaySyncAutoTimezone ='), source.indexOf('  const holidaySyncLastRunNormalized ='))
    const fallback = vi.fn(() => 'UTC')
    const value = runInNewContext(`${declaration}; holidaySyncAutoTimezone`, {
      holidaySyncAuto: { enabled: true, timezone },
      DEFAULT_SETTINGS: { holidaySync: { auto: { enabled: false, timezone: 'UTC' } } },
      parseBoolean: (input: boolean) => input, resolveTimeZone: fallback,
    })
    expect(value).toBe(timezone)
    expect(fallback).not.toHaveBeenCalled()
  })
  it('keeps generic zonedTimeToUtc byte-identical to the frozen baseline', () => {
    expect(createHash('sha256').update(fn('zonedTimeToUtc')).digest('hex')).toBe('45a1ecf544296eec4df03cf9da62369cde39c0b2e37fad8e280eba8920c627ea')
  })
})
