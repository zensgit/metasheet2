import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AttendanceScheduler,
  registerAttendanceSchedulerJob,
  resolveUnscheduledReminderJob,
  startAttendanceScheduler,
  stopAttendanceScheduler,
} from '../../src/services/AttendanceScheduler'
import type { AttendanceExpiryService, ExpiredCompTimeBalance } from '../../src/services/AttendanceExpiryService'
import {
  AttendanceNotifier,
  createAttendanceNotifierChannelsFromEnv,
} from '../../src/services/AttendanceNotifier'
import { UnscheduledReminderService } from '../../src/services/UnscheduledReminderService'

function fakeExpiryService(rows: ExpiredCompTimeBalance[], spy?: () => void): AttendanceExpiryService {
  return {
    async expireCompTimeBalances() {
      spy?.()
      return rows
    },
  } as unknown as AttendanceExpiryService
}

describe('AttendanceScheduler (④ C4)', () => {
  afterEach(() => {
    stopAttendanceScheduler()
    delete process.env.ATTENDANCE_SCHEDULER_ENABLED
    delete process.env.ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED
    vi.restoreAllMocks()
  })

  it('tick (single-process leader) runs the expiry service and returns its result', async () => {
    let calls = 0
    const expired: ExpiredCompTimeBalance[] = [
      { orgId: 'default', userId: 'u1', balanceId: 'b1', expiredMinutes: 90 },
    ]
    const scheduler = new AttendanceScheduler({ expiryService: fakeExpiryService(expired, () => { calls += 1 }) })
    expect(scheduler.leader).toBe(true) // no leaderOptions → single-process assumption
    const result = await scheduler.tick()
    expect(result).toEqual(expired)
    expect(calls).toBe(1)
  })

  it('tick swallows expiry errors and returns [] (a bad scan never crashes the loop)', async () => {
    const throwing = {
      async expireCompTimeBalances() { throw new Error('boom') },
    } as unknown as AttendanceExpiryService
    const scheduler = new AttendanceScheduler({ expiryService: throwing })
    await expect(scheduler.tick()).resolves.toEqual([])
  })

  it('startAttendanceScheduler is default OFF — returns null unless ATTENDANCE_SCHEDULER_ENABLED=true', () => {
    delete process.env.ATTENDANCE_SCHEDULER_ENABLED
    expect(startAttendanceScheduler({ expiryService: fakeExpiryService([]) })).toBeNull()

    process.env.ATTENDANCE_SCHEDULER_ENABLED = 'true'
    const scheduler = startAttendanceScheduler({ expiryService: fakeExpiryService([]) })
    expect(scheduler).not.toBeNull()
    // Idempotent: the shared instance is returned, not a second scheduler.
    expect(startAttendanceScheduler({ expiryService: fakeExpiryService([]) })).toBe(scheduler)
  })

  it('runCycle runs registered jobs after expiry and isolates a failing job', async () => {
    const calls: string[] = []
    const scheduler = new AttendanceScheduler({
      expiryService: fakeExpiryService([], () => { calls.push('expiry') }),
      jobs: [
        { name: 'first', async run() { calls.push('first') } },
        { name: 'bad', async run() { calls.push('bad'); throw new Error('down') } },
        { name: 'second', async run() { calls.push('second') } },
      ],
    })

    await scheduler.runCycle()

    expect(calls).toEqual(['expiry', 'first', 'bad', 'second'])
  })

  it('supports dynamic shared-scheduler job registration and unregistering', async () => {
    process.env.ATTENDANCE_SCHEDULER_ENABLED = 'true'
    const calls: string[] = []
    const scheduler = startAttendanceScheduler({ expiryService: fakeExpiryService([]), intervalMs: 999_999 })
    expect(scheduler).not.toBeNull()

    const unregister = registerAttendanceSchedulerJob({
      name: 'dynamic',
      async run() { calls.push('dynamic') },
    })
    expect(typeof unregister).toBe('function')

    await scheduler!.runCycle()
    expect(calls).toEqual(['dynamic'])

    unregister?.()
    await scheduler!.runCycle()
    expect(calls).toEqual(['dynamic'])
  })

  it('replaces named jobs without letting stale unregister handles remove the replacement', async () => {
    const calls: string[] = []
    const scheduler = new AttendanceScheduler({ expiryService: fakeExpiryService([]) })
    const unregisterOld = scheduler.registerJob({
      name: 'replaceable',
      async run() { calls.push('old') },
    })
    scheduler.registerJob({
      name: 'replaceable',
      async run() { calls.push('new') },
    })
    unregisterOld()

    await scheduler.runCycle()

    expect(calls).toEqual(['new'])
  })

  it('resolves the unscheduled reminder job with one stable service instance', async () => {
    process.env.ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED = 'true'
    const instances = new Set<unknown>()
    vi.spyOn(UnscheduledReminderService.prototype, 'run').mockImplementation(function (this: UnscheduledReminderService) {
      instances.add(this)
      return Promise.resolve({ targetDate: '2026-06-11', claimed: 0, deliveries: 0 })
    })

    const job = resolveUnscheduledReminderJob()
    expect(job?.name).toBe('unscheduled-reminder')

    await job?.run()
    await job?.run()

    expect(instances.size).toBe(1)
  })
})

describe('AttendanceNotifier scaffold (④ C4 — no messages)', () => {
  it('registers no channels from env by default (channel-env-gating discipline)', () => {
    expect(createAttendanceNotifierChannelsFromEnv({})).toEqual([])
  })

  it('notify with no channels is a silent no-op (no send, no throw, no warn noise)', async () => {
    const notifier = new AttendanceNotifier()
    expect(notifier.channelCount).toBe(0)
    const result = await notifier.notify([{ orgId: 'default', userId: 'u1', kind: 'comp_time_expiry', text: 'x' }])
    expect(result).toEqual({ requested: 1, sent: 0, failed: 0 })
  })

  it('dispatches across registered channels and isolates a failing one', async () => {
    const calls: string[] = []
    const notifier = new AttendanceNotifier({
      channels: [
        { name: 'ok', async send() { calls.push('ok'); return { ok: true } } },
        { name: 'bad', async send() { calls.push('bad'); throw new Error('down') } },
      ],
    })
    const result = await notifier.notify([{ orgId: 'default', userId: 'u1', kind: 'k', text: 't' }])
    expect(result).toEqual({ requested: 1, sent: 1, failed: 1 })
    expect(calls).toEqual(['ok', 'bad'])
  })
})
