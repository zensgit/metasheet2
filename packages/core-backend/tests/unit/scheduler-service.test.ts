import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SchedulerServiceImpl } from '../../src/services/SchedulerService'

// Node clamps setTimeout delays above 2^31-1 ms (~24.86 days) to 1ms. A validated
// far-future cron (e.g. a yearly schedule saved mid-year) must not be handed a raw delay
// that crosses that ceiling, or it fires immediately and hot-loops. These tests pin the
// chunked delay-arming mechanics in SchedulerService's JobScheduler.scheduleCronJob.
const NODE_MAX_TIMEOUT_MS = 2 ** 31 - 1

describe('SchedulerService cron delay arming (far-future crons)', () => {
  const originalTz = process.env.TZ

  beforeEach(() => {
    // SimpleCronExpression matches against local-time Date getters, not UTC — pin TZ so
    // the test is deterministic regardless of the machine/CI runner's default zone.
    process.env.TZ = 'UTC'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalTz === undefined) {
      delete process.env.TZ
    } else {
      process.env.TZ = originalTz
    }
  })

  function totalDelayToNextJan1(): number {
    // Mirrors what SimpleCronExpression.next() resolves '0 0 1 1 *' to from the fixed
    // system time above: the next Jan 1 00:00 (2026-01-01 has already passed).
    return Date.parse('2027-01-01T00:00:00.000Z') - Date.parse('2026-07-10T00:00:00.000Z')
  }

  it('does not fire a far-future cron early, and fires once the full delay elapses', async () => {
    const service = new SchedulerServiceImpl()
    const handler = vi.fn().mockResolvedValue(undefined)

    await service.schedule('yearly-job', '0 0 1 1 *', handler, { timezone: 'UTC' })

    const totalDelayMs = totalDelayToNextJan1()
    expect(totalDelayMs).toBeGreaterThan(NODE_MAX_TIMEOUT_MS) // sanity: this case actually crosses the clamp

    // Advance through several chunk boundaries but stop short of the real target time.
    await vi.advanceTimersByTimeAsync(totalDelayMs - 1_000)
    expect(handler).not.toHaveBeenCalled()

    // Cross the remaining delay: now it must fire, exactly once.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(handler).toHaveBeenCalledTimes(1)

    service.destroy()
  })

  it('kills a far-future cron unscheduled mid-chain — it must never fire', async () => {
    const service = new SchedulerServiceImpl()
    const handler = vi.fn().mockResolvedValue(undefined)

    await service.schedule('yearly-job-cancel', '0 0 1 1 *', handler, { timezone: 'UTC' })

    // Advance partway through the chain — past at least two chunk boundaries (~24.86 days
    // each) — while still well short of the total delay.
    await vi.advanceTimersByTimeAsync(60 * 24 * 60 * 60 * 1000)
    expect(handler).not.toHaveBeenCalled()

    await service.unschedule('yearly-job-cancel')

    // Advance well past what would have been the remaining delay.
    await vi.advanceTimersByTimeAsync(200 * 24 * 60 * 60 * 1000)
    expect(handler).not.toHaveBeenCalled()

    service.destroy()
  })

  it('never arms a raw setTimeout delay beyond Node\'s clamp ceiling for a far-future cron', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const service = new SchedulerServiceImpl()
    const handler = vi.fn().mockResolvedValue(undefined)

    await service.schedule('yearly-job-armed-delay', '0 0 1 1 *', handler, { timezone: 'UTC' })

    // At least one chunk timer must have been armed already (the total delay for this
    // case exceeds the ceiling), and every delay ever passed to setTimeout for this run
    // must stay under Node's clamp point — including delays armed later as the chain
    // advances.
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    for (const call of setTimeoutSpy.mock.calls) {
      const delay = call[1]
      if (typeof delay === 'number') {
        expect(delay).toBeLessThanOrEqual(NODE_MAX_TIMEOUT_MS)
      }
    }

    await vi.advanceTimersByTimeAsync(totalDelayToNextJan1() + 2_000)
    expect(handler).toHaveBeenCalledTimes(1)

    for (const call of setTimeoutSpy.mock.calls) {
      const delay = call[1]
      if (typeof delay === 'number') {
        expect(delay).toBeLessThanOrEqual(NODE_MAX_TIMEOUT_MS)
      }
    }

    service.destroy()
    setTimeoutSpy.mockRestore()
  })

  it('does not chunk a near-term cron — delay under the ceiling arms unchanged', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const service = new SchedulerServiceImpl()
    const handler = vi.fn().mockResolvedValue(undefined)

    // Next run is at most a few minutes out — nowhere near the ~24.86-day ceiling.
    await service.schedule('near-term-job', '*/5 * * * *', handler, { timezone: 'UTC' })

    const cronTimeoutCalls = setTimeoutSpy.mock.calls.filter((call) => {
      const delay = call[1]
      return typeof delay === 'number' && delay > 0
    })
    expect(cronTimeoutCalls.length).toBe(1) // single arm, no chunking
    const armedDelay = cronTimeoutCalls[0][1] as number
    expect(armedDelay).toBeLessThanOrEqual(5 * 60 * 1000)

    await vi.advanceTimersByTimeAsync(armedDelay + 1_000)
    expect(handler).toHaveBeenCalledTimes(1)

    service.destroy()
    setTimeoutSpy.mockRestore()
  })
})
