import { afterEach, describe, expect, it } from 'vitest'

import {
  AttendanceScheduler,
  resolveUnscheduledReminderJob,
} from '../../src/services/AttendanceScheduler'
import type { AttendanceExpiryService } from '../../src/services/AttendanceExpiryService'
import { AttendanceNotifier, type AttendanceNotificationMessage } from '../../src/services/AttendanceNotifier'
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

describe('UnscheduledReminderService.run (claim + dispatch)', () => {
  it('claims candidates and dispatches the claimed set through the notifier', async () => {
    const captured: AttendanceNotificationMessage[] = []
    const notifier = new AttendanceNotifier({
      channels: [{ name: 'cap', async send(m) { captured.push(m); return { ok: true } } }],
    })
    let insertCalls = 0
    const query: UnscheduledReminderQuery = async (sql) => {
      if (sql.includes('INSERT INTO attendance_unscheduled_reminder_dispatch')) {
        insertCalls += 1
        return { rows: [{ org_id: 'default', user_id: 'u1' }, { org_id: 'default', user_id: 'u2' }] as never }
      }
      return { rows: [] }
    }
    const svc = new UnscheduledReminderService({ query, notifier, now: fixedNow, lookaheadDays: 1 })
    const result = await svc.run()
    expect(result).toEqual({ targetDate: '2026-06-05', claimed: 2, dispatched: 2 })
    expect(captured.map((m) => m.userId)).toEqual(['u1', 'u2'])
    expect(captured[0].kind).toBe('unscheduled_shift_reminder')
    expect(insertCalls).toBe(1)
  })

  it('claims nothing → no dispatch, dispatched=0 (and never throws with 0 channels)', async () => {
    const svc = new UnscheduledReminderService({ query: emptyQuery, notifier: new AttendanceNotifier(), now: fixedNow })
    expect(await svc.run()).toEqual({ targetDate: '2026-06-05', claimed: 0, dispatched: 0 })
  })

  it('re-entrancy guard: a second run while the first is in-flight is an immediate no-op', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const query: UnscheduledReminderQuery = async (sql) => {
      if (sql.includes('INSERT')) { await gate; return { rows: [{ org_id: 'default', user_id: 'u1' }] as never } }
      return { rows: [] }
    }
    const svc = new UnscheduledReminderService({ query, notifier: new AttendanceNotifier(), now: fixedNow })
    const first = svc.run()
    const second = await svc.run() // running guard → returns before touching the DB
    expect(second).toEqual({ targetDate: '2026-06-05', claimed: 0, dispatched: 0 })
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
