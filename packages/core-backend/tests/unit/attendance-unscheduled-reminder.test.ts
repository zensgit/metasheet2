import { afterEach, describe, expect, it } from 'vitest'

import {
  AttendanceScheduler,
  resolveUnscheduledReminderJob,
} from '../../src/services/AttendanceScheduler'
import type { AttendanceExpiryService } from '../../src/services/AttendanceExpiryService'
import {
  UnscheduledReminderService,
  clampLookaheadDays,
  type UnscheduledReminderQuery,
} from '../../src/services/UnscheduledReminderService'

const emptyQuery: UnscheduledReminderQuery = async () => ({ rows: [] })
const fixedNow = () => new Date('2026-06-04T23:30:00.000Z')

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

describe('UnscheduledReminderService.run (claim + C5 outbox production)', () => {
  it('claims candidates and produces delivery rows for claimed dispatches', async () => {
    let insertCalls = 0
    let deliveryCalls = 0
    const query: UnscheduledReminderQuery = async (sql) => {
      if (sql.includes('INSERT INTO attendance_unscheduled_reminder_dispatch')) {
        insertCalls += 1
        return {
          rows: [
            { id: '00000000-0000-0000-0000-000000000001', org_id: 'default', user_id: 'u1', target_date: '2026-06-05', reminder_type: 'unscheduled' },
            { id: '00000000-0000-0000-0000-000000000002', org_id: 'default', user_id: 'u2', target_date: '2026-06-05', reminder_type: 'unscheduled' },
          ] as never,
        }
      }
      if (sql.includes('FROM attendance_unscheduled_reminder_dispatch d') && sql.includes('NOT EXISTS')) {
        return {
          rows: [
            { id: '00000000-0000-0000-0000-000000000001', org_id: 'default', user_id: 'u1', target_date: '2026-06-05', reminder_type: 'unscheduled' },
            { id: '00000000-0000-0000-0000-000000000002', org_id: 'default', user_id: 'u2', target_date: '2026-06-05', reminder_type: 'unscheduled' },
          ] as never,
        }
      }
      if (sql.includes('INSERT INTO attendance_notification_deliveries')) {
        deliveryCalls += 1
        return { rows: [{ id: `delivery-${deliveryCalls}-1` }, { id: `delivery-${deliveryCalls}-2` }] as never }
      }
      return { rows: [] }
    }
    const svc = new UnscheduledReminderService({ query, now: fixedNow, lookaheadDays: 1 })
    const result = await svc.run()
    expect(result).toEqual({ targetDate: '2026-06-05', claimed: 2, deliveries: 2 })
    expect(insertCalls).toBe(1)
    expect(deliveryCalls).toBe(1)
  })

  it('claims/reconciles nothing → produces no deliveries', async () => {
    const svc = new UnscheduledReminderService({ query: emptyQuery, now: fixedNow })
    expect(await svc.run()).toEqual({ targetDate: '2026-06-05', claimed: 0, deliveries: 0 })
  })

  it('re-entrancy guard: a second run while the first is in-flight is an immediate no-op', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const query: UnscheduledReminderQuery = async (sql) => {
      if (sql.includes('INSERT')) { await gate; return { rows: [{ org_id: 'default', user_id: 'u1' }] as never } }
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
