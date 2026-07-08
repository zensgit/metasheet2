import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AttendanceScheduler,
  resolveUnscheduledReminderJob,
} from '../../src/services/AttendanceScheduler'
import type { AttendanceExpiryService } from '../../src/services/AttendanceExpiryService'
import { Logger } from '../../src/core/logger'
import {
  UnscheduledReminderService,
  clampLookaheadDays,
  type UnscheduledReminderQuery,
} from '../../src/services/UnscheduledReminderService'

const emptyQuery: UnscheduledReminderQuery = async () => ({ rows: [] })
const fixedNow = () => new Date('2026-06-04T23:30:00.000Z')

/** Matches resolveEligibleOrgIds()'s org fan-out query. */
const isOrgFanOutSql = (sql: string) => sql.includes('SELECT DISTINCT org_id FROM')
/** Matches resolveOrgTimeZone()'s attendance_rules lookup. */
const isOrgTimeZoneSql = (sql: string) => sql.includes('FROM attendance_rules')

describe('clampLookaheadDays (⑤ window math)', () => {
  it('defaults non-finite/undefined to 1 and clamps to [1,14]', () => {
    expect(clampLookaheadDays(undefined)).toBe(1)
    expect(clampLookaheadDays(Number.NaN)).toBe(1)
    expect(clampLookaheadDays(0)).toBe(1)
    expect(clampLookaheadDays(-5)).toBe(1)
    expect(clampLookaheadDays(1)).toBe(1)
    expect(clampLookaheadDays(3)).toBe(3)
    expect(clampLookaheadDays(2.9)).toBe(2)
    expect(clampLookaheadDays(99)).toBe(14)
  })
})

describe('UnscheduledReminderService.computeTargetDate', () => {
  it("is today's UTC date + lookaheadDays (tz-agnostic, end-of-day UTC has no off-by-one)", () => {
    expect(new UnscheduledReminderService({ query: emptyQuery, now: fixedNow, lookaheadDays: 1 }).computeTargetDate()).toBe('2026-06-05')
    expect(new UnscheduledReminderService({ query: emptyQuery, now: fixedNow, lookaheadDays: 3 }).computeTargetDate()).toBe('2026-06-07')
    // default lookahead = 1
    expect(new UnscheduledReminderService({ query: emptyQuery, now: fixedNow }).computeTargetDate()).toBe('2026-06-05')
  })
})

describe('UnscheduledReminderService.computeTargetDateForTimeZone (R9)', () => {
  it('UTC is byte-identical to computeTargetDate()', () => {
    const svc = new UnscheduledReminderService({ query: emptyQuery, now: fixedNow, lookaheadDays: 1 })
    expect(svc.computeTargetDateForTimeZone('UTC')).toBe(svc.computeTargetDate())
    expect(svc.computeTargetDateForTimeZone('UTC')).toBe('2026-06-05')
  })

  it('Asia/Shanghai (+8): a UTC-evening instant is already tomorrow locally — target date is one day AHEAD of the UTC calc', () => {
    // 2026-06-04T18:00:00Z = 2026-06-05T02:00 in Shanghai (+8) — the local calendar day has already rolled
    // over while UTC's is still 06-04. This is the exact bug scenario: UTC-only math would compute
    // "tomorrow" = 06-05 (already current, locally) hours late; tz-aware math correctly reaches 06-06.
    const now = () => new Date('2026-06-04T18:00:00.000Z')
    const svc = new UnscheduledReminderService({ query: emptyQuery, now, lookaheadDays: 1 })
    expect(svc.computeTargetDate()).toBe('2026-06-05') // UTC calc (the pre-R9 behaviour, unchanged)
    expect(svc.computeTargetDateForTimeZone('Asia/Shanghai')).toBe('2026-06-06') // tz-aware: one day later
  })

  it('America/Los_Angeles (-7 PDT): an early-UTC instant is still yesterday locally — target date is one day BEHIND the UTC calc', () => {
    // 2026-06-05T03:00:00Z = 2026-06-04T20:00 in Los Angeles (-7 PDT) — the local calendar day has NOT
    // yet rolled over while UTC's already has.
    const now = () => new Date('2026-06-05T03:00:00.000Z')
    const svc = new UnscheduledReminderService({ query: emptyQuery, now, lookaheadDays: 1 })
    expect(svc.computeTargetDate()).toBe('2026-06-06') // UTC calc
    expect(svc.computeTargetDateForTimeZone('America/Los_Angeles')).toBe('2026-06-05') // tz-aware: one day earlier
  })

  it('an invalid IANA zone falls back to the UTC target date and logs a warning', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const svc = new UnscheduledReminderService({ query: emptyQuery, now: fixedNow, lookaheadDays: 1 })
    expect(svc.computeTargetDateForTimeZone('Not/AZone')).toBe(svc.computeTargetDate())
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('UnscheduledReminderService.resolveOrgTimeZone (R9)', () => {
  it('returns the org default rule timezone when it is a recognized IANA zone', async () => {
    const query: UnscheduledReminderQuery = async (sql) => {
      if (isOrgTimeZoneSql(sql)) return { rows: [{ timezone: 'Asia/Shanghai' }] as never }
      return { rows: [] }
    }
    const svc = new UnscheduledReminderService({ query, now: fixedNow })
    expect(await svc.resolveOrgTimeZone('org-a')).toBe('Asia/Shanghai')
  })

  it('falls back to UTC (no warning) when the org has no default rule / no timezone on file', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const svc = new UnscheduledReminderService({ query: emptyQuery, now: fixedNow })
    expect(await svc.resolveOrgTimeZone('org-missing-rule')).toBe('UTC')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('falls back to UTC AND logs a warning (values-free — no raw timezone string) when the stored value is not a recognized IANA zone', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const query: UnscheduledReminderQuery = async (sql) => {
      if (isOrgTimeZoneSql(sql)) return { rows: [{ timezone: 'Definitely/Not-A-Zone' }] as never }
      return { rows: [] }
    }
    const svc = new UnscheduledReminderService({ query, now: fixedNow })
    expect(await svc.resolveOrgTimeZone('org-bad-tz')).toBe('UTC')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message, meta] = warnSpy.mock.calls[0]
    expect(message).not.toContain('Definitely/Not-A-Zone') // values-free: message never echoes the raw config value
    expect(meta).toEqual({ orgId: 'org-bad-tz' })
    warnSpy.mockRestore()
  })
})

describe('UnscheduledReminderService.resolveEligibleOrgIds (R9)', () => {
  it('returns the distinct org_ids from the fan-out query', async () => {
    const query: UnscheduledReminderQuery = async (sql) => {
      if (isOrgFanOutSql(sql)) return { rows: [{ org_id: 'org-a' }, { org_id: 'org-b' }] as never }
      return { rows: [] }
    }
    const svc = new UnscheduledReminderService({ query, now: fixedNow })
    expect(await svc.resolveEligibleOrgIds()).toEqual(['org-a', 'org-b'])
  })

  it('returns an empty array when there are no eligible orgs', async () => {
    const svc = new UnscheduledReminderService({ query: emptyQuery, now: fixedNow })
    expect(await svc.resolveEligibleOrgIds()).toEqual([])
  })
})

describe('UnscheduledReminderService.run (claim + C5 outbox production)', () => {
  it('claims per-org using EACH org\'s own attendance_rules timezone — not one shared UTC date (R9)', async () => {
    let insertCalls = 0
    let insertParams: unknown[] | undefined
    let deliveryCalls = 0
    const query: UnscheduledReminderQuery = async (sql, params) => {
      if (isOrgFanOutSql(sql)) return { rows: [{ org_id: 'default' }] as never }
      if (isOrgTimeZoneSql(sql)) return { rows: [{ timezone: 'Asia/Shanghai' }] as never }
      if (sql.includes('INSERT INTO attendance_unscheduled_reminder_dispatch')) {
        insertCalls += 1
        insertParams = params
        return {
          rows: [
            { id: '00000000-0000-0000-0000-000000000001', org_id: 'default', user_id: 'u1', target_date: '2026-06-06', reminder_type: 'unscheduled' },
            { id: '00000000-0000-0000-0000-000000000002', org_id: 'default', user_id: 'u2', target_date: '2026-06-06', reminder_type: 'unscheduled' },
          ] as never,
        }
      }
      if (sql.includes('FROM attendance_unscheduled_reminder_dispatch d') && sql.includes('NOT EXISTS')) {
        return {
          rows: [
            { id: '00000000-0000-0000-0000-000000000001', org_id: 'default', user_id: 'u1', target_date: '2026-06-06', reminder_type: 'unscheduled' },
            { id: '00000000-0000-0000-0000-000000000002', org_id: 'default', user_id: 'u2', target_date: '2026-06-06', reminder_type: 'unscheduled' },
          ] as never,
        }
      }
      if (sql.includes('INSERT INTO attendance_notification_deliveries')) {
        deliveryCalls += 1
        return { rows: [{ id: `delivery-${deliveryCalls}-1` }, { id: `delivery-${deliveryCalls}-2` }] as never }
      }
      return { rows: [] }
    }
    // fixedNow = 2026-06-04T23:30:00Z; Shanghai local (+8) is already 2026-06-05, one day ahead of UTC.
    const svc = new UnscheduledReminderService({ query, now: fixedNow, lookaheadDays: 1 })
    const result = await svc.run()
    // `targetDate` on the result stays the plain UTC reference value (unchanged field semantics) — the
    // ACTUAL claim (asserted via insertParams below) correctly used Shanghai's one-day-later local date.
    expect(result).toEqual({ targetDate: '2026-06-05', claimed: 2, deliveries: 2 })
    expect(insertCalls).toBe(1)
    expect(insertParams).toEqual(['2026-06-06', 'default'])
    expect(deliveryCalls).toBe(1)
  })

  it('falls back to UTC for an org with no attendance_rules row (pre-R9 behaviour preserved)', async () => {
    let insertParams: unknown[] | undefined
    const query: UnscheduledReminderQuery = async (sql, params) => {
      if (isOrgFanOutSql(sql)) return { rows: [{ org_id: 'default' }] as never }
      // isOrgTimeZoneSql falls through to the default branch below → rows: [] → resolveOrgTimeZone → 'UTC'.
      if (sql.includes('INSERT INTO attendance_unscheduled_reminder_dispatch')) {
        insertParams = params
        return { rows: [{ id: 'd1', org_id: 'default', user_id: 'u1', target_date: '2026-06-05', reminder_type: 'unscheduled' }] as never }
      }
      return { rows: [] }
    }
    const svc = new UnscheduledReminderService({ query, now: fixedNow, lookaheadDays: 1 })
    const result = await svc.run()
    expect(result.claimed).toBe(1)
    expect(insertParams).toEqual(['2026-06-05', 'default']) // UTC fallback, matches computeTargetDate()
  })

  it('isolates a per-org resolve/claim failure — other orgs still claim, and delivery production still runs', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    let insertCallsForOrgB = 0
    const query: UnscheduledReminderQuery = async (sql, params) => {
      if (isOrgFanOutSql(sql)) return { rows: [{ org_id: 'org-a' }, { org_id: 'org-b' }] as never }
      if (isOrgTimeZoneSql(sql)) {
        if ((params as unknown[] | undefined)?.[0] === 'org-a') throw new Error('boom: org-a rule lookup failed')
        return { rows: [{ timezone: 'UTC' }] as never }
      }
      if (sql.includes('INSERT INTO attendance_unscheduled_reminder_dispatch')) {
        insertCallsForOrgB += 1
        return { rows: [{ id: 'd-b', org_id: 'org-b', user_id: 'u-b', target_date: '2026-06-05', reminder_type: 'unscheduled' }] as never }
      }
      return { rows: [] }
    }
    const svc = new UnscheduledReminderService({ query, now: fixedNow })
    const result = await svc.run()
    expect(result.claimed).toBe(1) // org-b's claim still landed despite org-a's resolve throwing
    expect(insertCallsForOrgB).toBe(1)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('claims/reconciles nothing when there are no eligible orgs → produces no deliveries', async () => {
    const svc = new UnscheduledReminderService({ query: emptyQuery, now: fixedNow })
    expect(await svc.run()).toEqual({ targetDate: '2026-06-05', claimed: 0, deliveries: 0 })
  })

  it('re-entrancy guard: a second run while the first is in-flight is an immediate no-op', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const query: UnscheduledReminderQuery = async (sql) => {
      if (isOrgFanOutSql(sql)) return { rows: [{ org_id: 'default' }] as never }
      if (sql.includes('INSERT INTO attendance_unscheduled_reminder_dispatch')) {
        await gate
        return { rows: [{ id: 'd1', org_id: 'default', user_id: 'u1', target_date: '2026-06-05', reminder_type: 'unscheduled' }] as never }
      }
      return { rows: [] }
    }
    const svc = new UnscheduledReminderService({ query, now: fixedNow })
    const first = svc.run()
    const second = await svc.run() // running guard → returns before touching the DB
    expect(second).toEqual({ targetDate: '2026-06-05', claimed: 0, deliveries: 0 })
    release()
    expect((await first).claimed).toBe(1)
  })
})

describe('AttendanceScheduler.runCycle (⑤ second job)', () => {
  afterEach(() => { delete process.env.ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED })

  function expirySpy(): { service: AttendanceExpiryService; calls: () => number } {
    let calls = 0
    return {
      service: { async expireCompTimeBalances() { calls += 1; return [] } } as unknown as AttendanceExpiryService,
      calls: () => calls,
    }
  }

  it('runs expiry then the reminder job, and isolates a failing reminder from expiry', async () => {
    const exp = expirySpy()
    let reminderCalls = 0
    const reminderJob = { async run() { reminderCalls += 1; throw new Error('reminder boom') } }
    const scheduler = new AttendanceScheduler({ expiryService: exp.service, reminderJob })
    await expect(scheduler.runCycle()).resolves.toBeUndefined() // failure swallowed
    expect(exp.calls()).toBe(1)
    expect(reminderCalls).toBe(1)
  })

  it('without a reminderJob runs expiry only (④ unchanged)', async () => {
    const exp = expirySpy()
    const scheduler = new AttendanceScheduler({ expiryService: exp.service })
    await scheduler.runCycle()
    expect(exp.calls()).toBe(1)
  })
})

describe('resolveUnscheduledReminderJob (⑤ opt-in, default OFF)', () => {
  afterEach(() => { delete process.env.ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED })

  it('returns null unless ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED=true', () => {
    delete process.env.ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED
    expect(resolveUnscheduledReminderJob()).toBeNull()
    process.env.ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED = 'true'
    expect(resolveUnscheduledReminderJob()).not.toBeNull()
  })
})
