import { afterEach, describe, expect, it } from 'vitest'
import {
  computeWorkdayDeadline,
  getWorkdayCalendarRegistry,
  registerWorkdayCalendarProvider,
  unregisterWorkdayCalendarProvider,
  WORKDAY_SEARCH_CAP_DAYS,
  type WorkdayCalendar,
  type RecurringWindow,
} from '../../src/core/workday-calendar-port'

/**
 * T3-2 — pure business-time deadline arithmetic + the WorkdayCalendarPort registry. No DB, no port
 * resolution: computeWorkdayDeadline is a pure function over a snapshot WorkdayCalendar.
 */

function calendar(opts: {
  tz?: string
  workingWeekdays?: number[] // 0=Sun..6=Sat; default Mon-Fri
  windows?: RecurringWindow[]
  allNonWorking?: boolean
}): WorkdayCalendar {
  const working = opts.workingWeekdays ?? [1, 2, 3, 4, 5]
  return {
    timezone: opts.tz ?? 'UTC',
    isWorkingDay: (dayIso: string) => {
      if (opts.allNonWorking) return false
      const wd = new Date(`${dayIso}T00:00:00Z`).getUTCDay()
      return working.includes(wd)
    },
    nonCountingWindows: opts.windows ?? [],
  }
}

describe('computeWorkdayDeadline (T3-2 pure)', () => {
  it('counts plain wall-clock when the whole span is within one working day', () => {
    // Mon 2026-01-05 is a working day; 120 min from 00:00 → 02:00, no skips.
    const start = new Date('2026-01-05T00:00:00Z')
    expect(start.getUTCDay()).toBe(1)
    const { dueAt, clamped } = computeWorkdayDeadline(start, 120, calendar({}))
    expect(clamped).toBe(false)
    expect(dueAt.toISOString()).toBe('2026-01-05T02:00:00.000Z')
  })

  it('skips the weekend — business due lands strictly past the naive elapsed instant', () => {
    // Fri 2026-01-02 23:00Z + 120 business minutes: 60 min left Fri, Sat/Sun skipped, 60 min Mon.
    const start = new Date('2026-01-02T23:00:00Z')
    expect(start.getUTCDay()).toBe(5) // Friday
    const naive = new Date(start.getTime() + 120 * 60_000) // Sat 2026-01-03 01:00Z
    const { dueAt, clamped } = computeWorkdayDeadline(start, 120, calendar({}))
    expect(clamped).toBe(false)
    expect(dueAt.toISOString()).toBe('2026-01-05T01:00:00.000Z') // Monday 01:00Z
    expect(dueAt.getTime()).toBeGreaterThan(naive.getTime())
  })

  it('excludes a recurring intra-day non-counting window', () => {
    // Working every day; the first hour [00:00,01:00) does not count. 30 min budget → 01:30.
    const start = new Date('2026-01-05T00:00:00Z')
    const windows: RecurringWindow[] = [{ startMinuteOfDay: 0, endMinuteOfDay: 60 }]
    const { dueAt } = computeWorkdayDeadline(start, 30, calendar({ workingWeekdays: [0, 1, 2, 3, 4, 5, 6], windows }))
    expect(dueAt.toISOString()).toBe('2026-01-05T01:30:00.000Z')
  })

  it('clamps + flags when no working time is found within the 366-day cap', () => {
    const start = new Date('2026-01-05T00:00:00Z')
    const { dueAt, clamped } = computeWorkdayDeadline(start, 60, calendar({ allNonWorking: true }))
    expect(clamped).toBe(true)
    // Horizon-clamped roughly to start + cap days (day-granularity hops to local midnight).
    const minExpected = start.getTime() + (WORKDAY_SEARCH_CAP_DAYS - 1) * 86_400_000
    expect(dueAt.getTime()).toBeGreaterThan(minExpected)
  })

  it('zero-duration returns the start instant unchanged', () => {
    const start = new Date('2026-01-05T09:30:00Z')
    const { dueAt, clamped } = computeWorkdayDeadline(start, 0, calendar({}))
    expect(clamped).toBe(false)
    expect(dueAt.toISOString()).toBe(start.toISOString())
  })
})

describe('WorkdayCalendarRegistry (T3-2)', () => {
  afterEach(() => {
    unregisterWorkdayCalendarProvider()
  })

  it('binds, resolves, and unbinds a single provider (fail-open when unbound)', async () => {
    expect(getWorkdayCalendarRegistry().has()).toBe(false)
    expect(getWorkdayCalendarRegistry().get()).toBeUndefined()

    const provider = { resolve: async () => calendar({}) }
    registerWorkdayCalendarProvider(provider)
    expect(getWorkdayCalendarRegistry().has()).toBe(true)
    expect(getWorkdayCalendarRegistry().get()).toBe(provider)

    unregisterWorkdayCalendarProvider()
    expect(getWorkdayCalendarRegistry().has()).toBe(false)
  })
})
