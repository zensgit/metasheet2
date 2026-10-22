import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { resolveAttendanceLocalWallTimeV1, validateAttendanceIanaTimezoneV1 } from '../../src/attendance/w4c1-strict-time'

const require = createRequire(import.meta.url)
interface Plan { orgId: string; timeZone: string; runAt: string }
interface Timer { callback: () => Promise<void>; delay: number; cleared: boolean }
const strictTime = {
  resolveLocalWallTime: resolveAttendanceLocalWallTimeV1,
  validateIanaTimezone: validateAttendanceIanaTimezoneV1,
}
const { nextDailyRun, previousCalendarDates, createDailyCalendarScheduler, loadDailyCalendarDefaultRule, loadDailyCalendarOrgPlans } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-daily-calendar.cjs',
)
const shanghai: Plan = { orgId: 'daily-org-a', timeZone: 'Asia/Shanghai', runAt: '00:15' }
const la: Plan = { orgId: 'daily-org-b', timeZone: 'America/Los_Angeles', runAt: '00:15' }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function harness(plans: Plan[] = [shanghai], runPlan = vi.fn(async (_plan: Plan, _isCurrent: () => boolean) => {})) {
  let instant = Date.parse('2026-09-22T15:30:00Z')
  const timers: Timer[] = []
  const warn = vi.fn()
  const loadPlans = vi.fn(async () => plans)
  const refreshPlan = vi.fn(async (plan: Plan) => plan)
  const scheduler = createDailyCalendarScheduler({
    loadPlans, refreshPlan, runPlan, strictTime, warn,
    now: () => instant,
    setTimer: (callback: Timer['callback'], delay: number) => {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer: Timer) => { timer.cleared = true },
  })
  return { scheduler, timers, warn, loadPlans, refreshPlan, runPlan,
    at: (value: string) => { instant = Date.parse(value) },
  }
}

describe('strict attendance daily calendar (#5999)', () => {
  it.each([
    ['2026-09-22T15:30:00Z', 'Asia/Shanghai', '00:15', '2026-09-22T16:15:00.000Z'],
    ['2026-03-08T09:00:00Z', 'America/Los_Angeles', '08:15', '2026-03-08T15:15:00.000Z'],
    ['2026-11-01T07:00:00Z', 'America/Los_Angeles', '08:15', '2026-11-01T16:15:00.000Z'],
    ['2026-09-22T13:00:00Z', 'Pacific/Kiritimati', '00:15', '2026-09-23T10:15:00.000Z'],
    ['2026-09-22T13:00:00Z', 'Pacific/Auckland', '00:15', '2026-09-23T12:15:00.000Z'],
    ['2026-03-08T08:15:00Z', 'America/Los_Angeles', '00:15', '2026-03-09T07:15:00.000Z'],
    ['2026-11-01T07:15:00Z', 'America/Los_Angeles', '00:15', '2026-11-02T08:15:00.000Z'],
  ])('maps %s / %s %s to the unique future instant', (now, timeZone, runAt, expected) => {
    expect(new Date(nextDailyRun({ now: Date.parse(now), timeZone, runAt, strictTime, warn: vi.fn() })).toISOString()).toBe(expected)
  })

  it.each([
    ['2026-03-08T08:00:00Z', '02:30', '2026-03-09T09:30:00.000Z', 'DAILY_CALENDAR_GAP_SKIPPED'],
    ['2026-11-01T07:00:00Z', '01:30', '2026-11-02T09:30:00.000Z', 'DAILY_CALENDAR_FOLD_SKIPPED'],
  ])('skips a non-unique occurrence without normalizing it', (now, runAt, expected, code) => {
    const warn = vi.fn()
    expect(new Date(nextDailyRun({ now: Date.parse(now), timeZone: la.timeZone, runAt, strictTime, warn })).toISOString()).toBe(expected)
    expect(warn.mock.calls).toEqual([[code]])
  })

  it.each(['', ' ', 'Invalid/Zone', '+05:00'])('rejects invalid zone %j without fallback', timeZone => {
    expect(() => nextDailyRun({ now: Date.now(), timeZone, runAt: '00:15', strictTime, warn: vi.fn() })).toThrow()
  })
  it.each(['24:00', '1:15', '00:60', 'garbage'])('rejects invalid clock %j', runAt => {
    expect(() => nextDailyRun({ now: Date.now(), timeZone: 'UTC', runAt, strictTime, warn: vi.fn() })).toThrow()
  })
  it('uses calendar days across DST, year boundaries and leap days', () => {
    expect(previousCalendarDates(Date.parse('2026-03-09T07:15Z'), la.timeZone, 3)).toEqual(['2026-03-08', '2026-03-07', '2026-03-06'])
    expect(previousCalendarDates(Date.parse('2026-11-02T07:15Z'), la.timeZone, 2)).toEqual(['2026-10-31', '2026-10-30'])
    expect(previousCalendarDates(Date.parse('2024-03-01T01:00Z'), 'UTC', 2)).toEqual(['2024-02-29', '2024-02-28'])
    expect(previousCalendarDates(Date.parse('2026-01-01T01:00Z'), 'UTC', 1)).toEqual(['2025-12-31'])
  })

  it('arms independent organization clocks and rearms only the completed plan', async () => {
    const h = harness([shanghai, la])
    await h.scheduler.start()
    expect(h.timers.map(t => t.delay)).toEqual([45 * 60000, 15 * 3600000 + 45 * 60000])
    h.at('2026-09-22T16:15Z')
    await h.timers[0].callback()
    expect(h.runPlan.mock.calls).toHaveLength(1)
    expect(h.timers[1].cleared).toBe(false)
    expect(h.timers[2].delay).toBe(24 * 3600000)
  })
  it('recomputes after completed work instead of anchoring a 24h interval', async () => {
    const h = harness([la])
    h.at('2026-03-08T08:00Z')
    h.runPlan.mockImplementation(async () => { h.at('2026-03-08T08:20Z') })
    await h.scheduler.start()
    await h.timers[0].callback()
    expect(h.timers[1].delay).toBe(22 * 3600000 + 55 * 60000)
  })
  it('old callback completion cannot rearm after restart', async () => {
    const gate = deferred()
    const h = harness([shanghai], vi.fn((_plan: Plan, _isCurrent: () => boolean) => gate.promise))
    await h.scheduler.start()
    h.at('2026-09-22T16:15Z')
    const pending = h.timers[0].callback()
    await Promise.resolve()
    await h.scheduler.start()
    const count = h.timers.length
    gate.resolve()
    await pending
    expect(h.timers).toHaveLength(count)
  })
  it('old planning completion and cancelled retry cannot restart a stopped schedule', async () => {
    const gate = deferred()
    const h = harness()
    h.loadPlans.mockImplementationOnce(async () => { await gate.promise; return [shanghai] })
    const pending = h.scheduler.start()
    h.scheduler.stop()
    gate.resolve()
    await pending
    expect(h.timers).toEqual([])
    h.loadPlans.mockRejectedValueOnce(new Error('synthetic unavailable'))
    await h.scheduler.start()
    h.scheduler.stop()
    await h.timers[0].callback()
    expect(h.loadPlans).toHaveBeenCalledTimes(2)
  })
  it('skips an obsolete due timezone, then replans its replacement', async () => {
    const h = harness()
    await h.scheduler.start()
    h.refreshPlan.mockImplementation(async plan => ({ ...plan, timeZone: 'UTC' }))
    h.at('2026-09-22T16:15Z')
    await h.timers[0].callback()
    expect(h.runPlan).not.toHaveBeenCalled()
    expect(h.timers[1].delay).toBe(8 * 3600000)
  })
  it('isolates invalid organization planning and failed work', async () => {
    const h = harness([shanghai, la])
    h.refreshPlan.mockImplementation(async plan => {
      if (plan.orgId === shanghai.orgId) throw new Error('synthetic invalid default')
      return plan
    })
    h.runPlan.mockRejectedValueOnce(new Error('synthetic failure'))
    await h.scheduler.start()
    expect(h.timers.map(t => t.delay)).toEqual([60000, 15 * 3600000 + 45 * 60000])
    h.at('2026-09-23T07:15Z')
    await h.timers[1].callback()
    expect(h.timers.at(-1)?.delay).toBe(24 * 3600000)
    expect(h.warn.mock.calls).toEqual([['DAILY_CALENDAR_PLAN_FAILED'], ['DAILY_CALENDAR_RUN_FAILED']])
  })

  it('scoped replacement invalidates only its own pending refresh', async () => {
    const h = harness([shanghai, la])
    await h.scheduler.start()
    const gate = deferred()
    h.refreshPlan.mockImplementationOnce(async plan => { await gate.promise; return plan })
    h.at('2026-09-22T16:15Z')
    const pending = h.timers[0].callback()
    await h.scheduler.rearm({ ...shanghai, timeZone: 'UTC' })
    gate.resolve(); await pending
    expect(h.runPlan).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(3)
    expect(h.timers[1].cleared).toBe(false)
    expect(h.timers[2].delay).toBe(8 * 3600000)
    h.scheduler.stop()
  })
  it('a sibling rearm preserves every remaining lookback date of an active plan', async () => {
    const gate = deferred()
    const dates: string[] = []
    const started = deferred()
    const h = harness([shanghai, la], vi.fn(async (_plan: Plan, isCurrent: () => boolean) => {
      for (const date of ['2026-09-21', '2026-09-20', '2026-09-19']) {
        if (!isCurrent()) return
        dates.push(date)
        if (dates.length === 1) { started.resolve(); await gate.promise }
      }
    }))
    await h.scheduler.start()
    h.at('2026-09-22T16:15Z')
    const pending = h.timers[0].callback()
    await started.promise
    expect(dates).toEqual(['2026-09-21'])
    await h.scheduler.rearm(la)
    gate.resolve(); await pending
    expect(dates).toEqual(['2026-09-21', '2026-09-20', '2026-09-19'])
    expect(h.timers.at(-1)?.delay).toBe(86400000)
    h.scheduler.stop()
  })
  it('same-org rearm stops its old lookback continuation but preserves a sibling handle', async () => {
    const gate = deferred()
    const dates: string[] = []
    const started = deferred()
    const h = harness([shanghai, la], vi.fn(async (_plan: Plan, isCurrent: () => boolean) => {
      dates.push('entered')
      started.resolve(); await gate.promise
      if (isCurrent()) dates.push('obsolete-next-date')
    }))
    await h.scheduler.start()
    const pending = h.timers[0].callback()
    await started.promise
    await h.scheduler.rearm(shanghai)
    gate.resolve(); await pending
    expect(dates).toEqual(['entered'])
    expect(h.timers[1].cleared).toBe(false)
    expect(h.timers).toHaveLength(3)
    h.scheduler.stop()
  })
  it('a scoped COMMIT during startup owns its plan before the old org list returns', async () => {
    const gate = deferred()
    const h = harness([shanghai, la])
    h.loadPlans.mockImplementationOnce(async () => { await gate.promise; return [shanghai, la, shanghai] })
    const pending = h.scheduler.start()
    await h.scheduler.rearm({ ...shanghai, timeZone: 'UTC' })
    expect(h.timers.map(t => t.delay)).toEqual([8 * 3600000 + 45 * 60000])
    gate.resolve(); await pending
    expect(h.timers.map(t => t.delay)).toEqual([8 * 3600000 + 45 * 60000, 15 * 3600000 + 45 * 60000])
    expect(h.timers[0].cleared).toBe(false)
    h.scheduler.stop()
  })
  it('org-list retries add missing orgs without restarting a scoped new-org plan', async () => {
    const h = harness([shanghai, la])
    h.loadPlans.mockRejectedValueOnce(new Error('synthetic list unavailable'))
    h.loadPlans.mockRejectedValueOnce(new Error('synthetic list still unavailable'))
    await h.scheduler.start()
    await h.scheduler.rearm(shanghai)
    const owned = h.timers[1]
    await h.timers[0].callback()
    expect(owned.cleared).toBe(false)
    expect(h.timers).toHaveLength(3)
    await h.timers[2].callback()
    expect(h.timers).toHaveLength(4)
    expect(owned.cleared).toBe(false)
    expect(h.timers[3].delay).toBe(15 * 3600000 + 45 * 60000)
    h.scheduler.stop()
    expect(owned.cleared).toBe(true)
  })
  it('a failed scoped default read retries only that plan, not a sibling', async () => {
    const h = harness([shanghai, la])
    await h.scheduler.start()
    h.refreshPlan.mockRejectedValueOnce(new Error('synthetic scoped read unavailable'))
    await h.scheduler.rearm(shanghai)
    expect(h.timers[0].cleared).toBe(true)
    expect(h.timers[1].cleared).toBe(false)
    expect(h.timers[2].delay).toBe(60000)
    await h.timers[2].callback()
    expect(h.timers[3].delay).toBe(45 * 60000)
    expect(h.timers[1].cleared).toBe(false)
    h.scheduler.stop()
  })
  it('concurrent scoped reads cannot duplicate a plan and stop rejects later rearm', async () => {
    const h = harness()
    await h.scheduler.start()
    const gate = deferred()
    h.refreshPlan.mockImplementationOnce(async plan => { await gate.promise; return plan })
    const pending = h.scheduler.rearm(shanghai)
    await h.scheduler.rearm({ ...shanghai, timeZone: 'UTC' })
    gate.resolve(); await pending
    expect(h.timers).toHaveLength(2)
    expect(h.timers[1].delay).toBe(8 * 3600000 + 45 * 60000)
    h.scheduler.stop()
    await h.scheduler.rearm(la)
    expect(h.timers).toHaveLength(2)
    expect(h.timers[1].cleared).toBe(true)
  })

  it.each([[], [{ timezone: 'UTC' }, { timezone: 'UTC' }], [{ timezone: '' }], [{ timezone: 'Invalid/Zone' }]].map(rows => ({ rows })))('rejects an absent, conflicting or invalid default', async ({ rows }) => {
    const db = { query: vi.fn(async () => rows) }
    const map = vi.fn()
    await expect(loadDailyCalendarDefaultRule(db, 'daily-org', strictTime, map)).rejects.toThrow()
    expect(map).not.toHaveBeenCalled()
    expect(db.query.mock.calls).toEqual([['SELECT * FROM attendance_rules WHERE org_id = $1 AND is_default = true', ['daily-org']]])
  })
  it('reads only the requested org default and isolates invalid org identifiers', async () => {
    const row = { org_id: 'daily-org', timezone: 'Asia/Shanghai' }
    const db = { query: vi.fn(async () => [row]) }
    expect(await loadDailyCalendarDefaultRule(db, 'daily-org', strictTime, (value: unknown) => value)).toEqual(row)
    const warn = vi.fn()
    expect(await loadDailyCalendarOrgPlans({ query: async () => [{ org_id: null }, { org_id: 'daily-org' }] }, warn)).toEqual([{ orgId: 'daily-org' }])
    expect(warn.mock.calls).toEqual([['DAILY_CALENDAR_ORG_INVALID']])
  })
})
