/**
 * Timer-overflow guards for the automation scheduler.
 *
 * Node's setTimeout / setInterval treat any delay above 2^31-1 ms (~24.8 days) as 1 ms and emit a
 * TimeoutOverflowWarning (the fake-timer clock emulates the same clamp). Before this guard a yearly cron, or a
 * monthly cron just after it fired, or a schedule.interval above ~24.8 days, fired in a 1 ms loop. These pin:
 *   O1 — a yearly cron runs exactly once at its target, never before, across many intermediate hops.
 *   O2 — a 30-day interval runs once per period on the registration grid, never early, across hops.
 *   O3 — unregister / replace / destroy / leader loss during an intermediate wait cancel the pending hop (no
 *        leaked timer; hops stay unref'd); a long-interval callback that drops its own rule is not re-armed.
 *   O4 — a wall-clock jump past several long-interval periods runs once, not a burst.
 *   O5 — the DST fall-back fire-once cron case still holds through the bounded arm.
 *   O6 — a short cron and a short interval (and an interval exactly at the bound) keep their single-timer path.
 *   O7 — the date-field timer delay is always far below the bound (no hop needed).
 *   O8 — REAL timers: registering two yearly crons and a 30-day interval emits no TimeoutOverflowWarning.
 * Each case starts with a few-ms advance so a 1 ms-loop mutant fails fast instead of hanging the run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AutomationScheduler, MAX_TIMER_DELAY_MS } from '../../src/multitable/automation-scheduler'
import type { AutomationRule } from '../../src/multitable/automation-executor'
import { nextDateReminderTimerDelayMs } from '../../src/multitable/automation-date-reminder'

const MIN = 60 * 1000
const H = 60 * MIN
const DAY = 24 * H

function makeRule(id: string, trigger: AutomationRule['trigger']): AutomationRule {
  return {
    id,
    name: `rule ${id}`,
    sheetId: 'sht_test',
    trigger,
    actions: [],
    enabled: true,
    createdBy: 'system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const cronRule = (id: string, expression: string, timezone?: string) =>
  makeRule(id, { type: 'schedule.cron', config: timezone ? { expression, timezone } : { expression } })
const intervalRule = (id: string, intervalMs: number) =>
  makeRule(id, { type: 'schedule.interval', config: { intervalMs } })

/** The pending handle the scheduler holds for a rule — a new handle means a hop (re-arm) happened. */
function handleOf(s: AutomationScheduler, id: string): unknown {
  return (s as unknown as { timers: Map<string, unknown> }).timers.get(id)
}

function recordingCallback() {
  const calls: Array<{ id: string; at: number }> = []
  const cb = vi.fn((rule: AutomationRule) => {
    calls.push({ id: rule.id, at: Date.now() })
  })
  return { cb, calls }
}

describe('AutomationScheduler — waits longer than the 2^31-1 ms timer limit (fake timers)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the bound is the Node timer limit', () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1)
  })

  it('O1: a yearly cron runs exactly once at its target, not before, across many intermediate hops', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'))
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(cronRule('yearly', '0 0 1 1 *'))
      const target = Date.parse('2027-01-01T00:00:00.000Z')
      const h0 = handleOf(s, 'yearly')
      expect(h0).toBeDefined()

      await vi.advanceTimersByTimeAsync(5)
      expect(cb).not.toHaveBeenCalled()
      expect(handleOf(s, 'yearly')).toBe(h0) // no hop within a few ms ⇒ the armed delay is not clamped

      const seen = new Set<unknown>([h0])
      while (Date.now() < target - 10 * DAY) {
        await vi.advanceTimersByTimeAsync(10 * DAY)
        expect(cb).not.toHaveBeenCalled()
        expect(s.isRegistered('yearly')).toBe(true)
        expect(vi.getTimerCount()).toBe(1)
        seen.add(handleOf(s, 'yearly'))
      }
      expect(seen.size).toBeGreaterThanOrEqual(10) // ~14 hops of 24.8 days were taken, none of them ran

      await vi.advanceTimersByTimeAsync(target - Date.now() - 1)
      expect(cb).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toEqual([{ id: 'yearly', at: target }])

      await vi.advanceTimersByTimeAsync(30 * DAY) // re-armed for 2028-01-01 — no second run
      expect(cb).toHaveBeenCalledTimes(1)
      expect(s.isRegistered('yearly')).toBe(true)
    } finally {
      await s.destroy()
    }
  })

  it('O1b: a monthly cron right after it fired (31-day wait) runs once at the next month, not in a loop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z')) // next 1st-of-month 00:00 is 2026-02-01 (31 days)
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(cronRule('monthly', '0 0 1 * *'))
      const h0 = handleOf(s, 'monthly')
      await vi.advanceTimersByTimeAsync(5)
      expect(cb).not.toHaveBeenCalled()
      expect(handleOf(s, 'monthly')).toBe(h0)
      const target = Date.parse('2026-02-01T00:00:00.000Z')
      await vi.advanceTimersByTimeAsync(target - Date.now() - 1)
      expect(cb).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toEqual([{ id: 'monthly', at: target }])
    } finally {
      await s.destroy()
    }
  })

  it('O2: a 30-day interval runs once per period from registration, never early, across hops', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
    const t0 = Date.now()
    const period = 30 * DAY
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(intervalRule('monthly-ish', period))
      const h0 = handleOf(s, 'monthly-ish')
      await vi.advanceTimersByTimeAsync(5)
      expect(cb).not.toHaveBeenCalled()
      expect(handleOf(s, 'monthly-ish')).toBe(h0)

      for (let k = 1; k <= 3; k += 1) {
        const target = t0 + k * period
        await vi.advanceTimersByTimeAsync(target - Date.now() - 1)
        expect(cb).toHaveBeenCalledTimes(k - 1)
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(cb).toHaveBeenCalledTimes(k)
        expect(calls[k - 1]).toEqual({ id: 'monthly-ish', at: target })
      }
      expect(handleOf(s, 'monthly-ish')).not.toBe(h0) // chained one-shot legs, not a clamped setInterval
    } finally {
      await s.destroy()
    }
  })

  it('O3a: unregister during an intermediate wait cancels the pending hop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'))
    const { cb } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(cronRule('yearly', '0 0 1 1 *'))
      s.register(intervalRule('long', 30 * DAY))
      const firstLegs = [handleOf(s, 'yearly'), handleOf(s, 'long')]
      await vi.advanceTimersByTimeAsync(5)
      expect(handleOf(s, 'yearly')).toBe(firstLegs[0])
      expect(handleOf(s, 'long')).toBe(firstLegs[1])
      expect(cb).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(26 * DAY) // past the first hop of both: now on a second leg
      expect(handleOf(s, 'yearly')).not.toBe(firstLegs[0])
      expect(handleOf(s, 'long')).not.toBe(firstLegs[1])
      expect(vi.getTimerCount()).toBe(2)

      s.unregister('yearly')
      s.unregister('long')
      expect(s.isRegistered('yearly')).toBe(false)
      expect(s.isRegistered('long')).toBe(false)
      await vi.advanceTimersByTimeAsync(5) // let the logger's own setImmediate flushes drain
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(400 * DAY)
      expect(cb).not.toHaveBeenCalled()
    } finally {
      await s.destroy()
    }
  })

  it('O3b: replace during an intermediate wait cancels the old hop; only the new rule runs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'))
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(cronRule('r', '0 0 1 1 *'))
      const h0 = handleOf(s, 'r')
      await vi.advanceTimersByTimeAsync(5)
      expect(handleOf(s, 'r')).toBe(h0)
      await vi.advanceTimersByTimeAsync(26 * DAY - 5) // on the second leg toward 2027-01-01
      // Replace with a daily cron under the same id.
      const replacement = cronRule('r', '0 12 * * *')
      replacement.name = 'replacement'
      s.register(replacement)
      await vi.advanceTimersByTimeAsync(5) // let the logger's own setImmediate flushes drain
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(DAY)
      expect(cb).toHaveBeenCalledTimes(1)
      expect((cb.mock.calls[0][0] as AutomationRule).name).toBe('replacement')
      expect(calls[0].at).toBe(Date.parse('2026-01-27T12:00:00.000Z'))
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      await s.destroy()
    }
  })

  it('O3c: destroy during an intermediate wait leaves no timer behind', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'))
    const { cb } = recordingCallback()
    const s = new AutomationScheduler(cb)
    s.register(cronRule('yearly', '0 0 1 1 *'))
    s.register(intervalRule('long', 30 * DAY))
    const firstLegs = [handleOf(s, 'yearly'), handleOf(s, 'long')]
    await vi.advanceTimersByTimeAsync(5)
    expect(handleOf(s, 'yearly')).toBe(firstLegs[0])
    expect(handleOf(s, 'long')).toBe(firstLegs[1])
    expect(cb).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(26 * DAY)
    expect(vi.getTimerCount()).toBe(2)
    // The second legs are unref'd too (a pending hop never keeps the process alive).
    for (const id of ['yearly', 'long']) {
      const leg = handleOf(s, id) as { hasRef(): boolean }
      expect(leg).not.toBe(firstLegs[id === 'yearly' ? 0 : 1])
      expect(leg.hasRef()).toBe(false)
    }
    await s.destroy()
    await vi.advanceTimersByTimeAsync(5) // let the logger's own setImmediate flushes drain
    expect(vi.getTimerCount()).toBe(0)
    expect(s.activeCount).toBe(0)
    await vi.advanceTimersByTimeAsync(400 * DAY)
    expect(cb).not.toHaveBeenCalled()
  })

  it('O3d: leader loss during an intermediate wait clears the pending hop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'))
    const { cb } = recordingCallback()
    const s = new AutomationScheduler(cb) // no leader options ⇒ leader
    try {
      s.register(cronRule('yearly', '0 0 1 1 *'))
      s.register(intervalRule('long', 30 * DAY))
      await vi.advanceTimersByTimeAsync(5)
      expect(cb).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(26 * DAY)
      expect(vi.getTimerCount()).toBe(2)
      ;(s as unknown as { relinquishLeadership(reason: string): void }).relinquishLeadership('test')
      expect(s.leader).toBe(false)
      await vi.advanceTimersByTimeAsync(5) // let the logger's own setImmediate flushes drain
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(400 * DAY)
      expect(cb).not.toHaveBeenCalled()
    } finally {
      await s.destroy()
    }
  })

  it('O3e: a long-interval callback that synchronously unregisters or replaces its rule is not re-armed over', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
    const period = 30 * DAY
    let s!: AutomationScheduler
    const ran: string[] = []
    const cb = vi.fn((rule: AutomationRule) => {
      ran.push(rule.name)
      if (rule.id === 'gone') s.unregister('gone')
      if (rule.id === 'swap' && rule.name === 'rule swap') {
        const next = cronRule('swap', '0 12 * * *')
        next.name = 'swapped'
        s.register(next)
      }
    })
    s = new AutomationScheduler(cb)
    try {
      s.register(intervalRule('gone', period))
      s.register(intervalRule('swap', period))
      await vi.advanceTimersByTimeAsync(5)
      expect(cb).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(period - 5)
      expect(ran).toEqual(['rule gone', 'rule swap'])
      expect(s.isRegistered('gone')).toBe(false)
      expect(s.isRegistered('swap')).toBe(true)
      await vi.advanceTimersByTimeAsync(5) // let the logger's own setImmediate flushes drain
      expect(vi.getTimerCount()).toBe(1) // only the replacement daily cron
      await vi.advanceTimersByTimeAsync(2 * period)
      expect(ran.filter((n) => n === 'rule gone' || n === 'rule swap')).toHaveLength(2) // never ran again
      expect(ran.filter((n) => n === 'swapped').length).toBeGreaterThanOrEqual(59)
    } finally {
      await s.destroy()
    }
  })

  it('O4: a wall-clock jump past several long-interval periods runs once, then stays on the registration grid', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
    const t0 = Date.now()
    const period = 30 * DAY
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(intervalRule('long', period))
      const h0 = handleOf(s, 'long')
      await vi.advanceTimersByTimeAsync(5)
      expect(handleOf(s, 'long')).toBe(h0)
      expect(cb).not.toHaveBeenCalled()
      vi.setSystemTime(t0 + 100 * DAY) // host slept / clock stepped: periods 1..3 were missed
      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS) // the first hop wakes, sees the target passed
      expect(cb).toHaveBeenCalledTimes(1) // one run, not a burst of three
      const nextOnGrid = t0 + 5 * period // first grid point after the wake (t0 + 100d + ~24.8d ≈ t0 + 124.8d)
      expect(nextOnGrid).toBeGreaterThan(calls[0].at)
      await vi.advanceTimersByTimeAsync(nextOnGrid - Date.now() - 1)
      expect(cb).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(cb).toHaveBeenCalledTimes(2)
      expect(calls[1].at).toBe(nextOnGrid)
    } finally {
      await s.destroy()
    }
  })

  it('O5: DST fall-back — a tz cron whose wall-clock minute repeats still fires once', async () => {
    vi.useFakeTimers()
    // 2026-11-01 America/New_York: 01:30 occurs at 05:30Z (EDT) and again at 06:30Z (EST).
    vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'))
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(cronRule('dst', '30 1 * * *', 'America/New_York'))
      await vi.advanceTimersByTimeAsync(Date.parse('2026-11-01T05:30:00.000Z') - Date.now())
      expect(calls.map((c) => new Date(c.at).toISOString())).toEqual(['2026-11-01T05:30:00.000Z'])
      await vi.advanceTimersByTimeAsync(2 * H) // past the repeated 01:30 EST (06:30Z)
      expect(cb).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(Date.parse('2026-11-02T06:30:00.000Z') - Date.now())
      expect(calls.map((c) => new Date(c.at).toISOString())).toEqual([
        '2026-11-01T05:30:00.000Z',
        '2026-11-02T06:30:00.000Z',
      ])
    } finally {
      await s.destroy()
    }
  })

  it('O6a: a short cron keeps its single timer and fires at the same instant as before', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-28T09:14:30.000Z'))
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(cronRule('short', '15 9 * * *'))
      const h0 = handleOf(s, 'short')
      await vi.advanceTimersByTimeAsync(29_999)
      expect(cb).not.toHaveBeenCalled()
      expect(handleOf(s, 'short')).toBe(h0)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toEqual([{ id: 'short', at: Date.parse('2026-06-28T09:15:00.000Z') }])
      await vi.advanceTimersByTimeAsync(DAY)
      expect(cb).toHaveBeenCalledTimes(2)
    } finally {
      await s.destroy()
    }
  })

  it('O6b: a short interval — and one exactly at the bound — stay on setInterval (same handle across runs)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'))
    const { cb } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(intervalRule('short', 60_000))
      s.register(intervalRule('edge', MAX_TIMER_DELAY_MS))
      const hShort = handleOf(s, 'short')
      const hEdge = handleOf(s, 'edge')
      await vi.advanceTimersByTimeAsync(5)
      expect(cb).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(120_000 - 5)
      expect(cb.mock.calls.filter(([r]) => r.id === 'short')).toHaveLength(2)
      expect(handleOf(s, 'short')).toBe(hShort)
      s.unregister('short') // keep the long advance below cheap
      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS - 120_000)
      expect(cb.mock.calls.filter(([r]) => r.id === 'edge')).toHaveLength(1)
      expect(handleOf(s, 'edge')).toBe(hEdge)
    } finally {
      await s.destroy()
    }
  })

  it('O6c: a non-finite interval is refused instead of becoming a 1 ms loop', async () => {
    vi.useFakeTimers()
    const { cb } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(intervalRule('inf', Number.POSITIVE_INFINITY))
      expect(s.isRegistered('inf')).toBe(false)
      await vi.advanceTimersByTimeAsync(10)
      expect(cb).not.toHaveBeenCalled()
    } finally {
      await s.destroy()
    }
  })
  it('O9a: a wait of exactly the bound is one legal timer and fires at its target (no hop)', async () => {
    vi.useFakeTimers()
    const target = Date.parse('2027-01-01T00:00:00.000Z')
    vi.setSystemTime(target - MAX_TIMER_DELAY_MS)
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(cronRule('edge', '0 0 1 1 *'))
      const h0 = handleOf(s, 'edge')
      await vi.advanceTimersByTimeAsync(5)
      expect(cb).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS - 6)
      expect(cb).not.toHaveBeenCalled()
      expect(handleOf(s, 'edge')).toBe(h0)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toEqual([{ id: 'edge', at: target }])
    } finally {
      await s.destroy()
    }
  })

  it('O9b: a wait of the bound + 1 ms takes one hop and still fires exactly at its target', async () => {
    vi.useFakeTimers()
    const target = Date.parse('2027-01-01T00:00:00.000Z')
    vi.setSystemTime(target - MAX_TIMER_DELAY_MS - 1)
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(cronRule('edge1', '0 0 1 1 *'))
      const h0 = handleOf(s, 'edge1')
      await vi.advanceTimersByTimeAsync(5)
      expect(cb).not.toHaveBeenCalled()
      expect(handleOf(s, 'edge1')).toBe(h0)
      await vi.advanceTimersByTimeAsync(target - Date.now() - 1)
      expect(cb).not.toHaveBeenCalled()
      expect(handleOf(s, 'edge1')).not.toBe(h0)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toEqual([{ id: 'edge1', at: target }])
    } finally {
      await s.destroy()
    }
  })

  it('O9c: an interval of the bound + 1 ms is chained, not a clamped 1 ms setInterval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
    const t0 = Date.now()
    const period = MAX_TIMER_DELAY_MS + 1
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(intervalRule('edge', period))
      await vi.advanceTimersByTimeAsync(5)
      expect(cb).not.toHaveBeenCalled()
      for (let k = 1; k <= 2; k += 1) {
        await vi.advanceTimersByTimeAsync(t0 + k * period - Date.now() - 1)
        expect(cb).toHaveBeenCalledTimes(k - 1)
        await vi.advanceTimersByTimeAsync(1)
        expect(calls[k - 1]).toEqual({ id: 'edge', at: t0 + k * period })
      }
    } finally {
      await s.destroy()
    }
  })

  it('O9d: the cron target is fixed at registration — a wall-clock jump past it runs the pending occurrence once at the next wake, then next year', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'))
    const registeredAt = Date.now()
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(cronRule('yearly', '0 0 1 1 *'))
      await vi.advanceTimersByTimeAsync(5)
      expect(cb).not.toHaveBeenCalled()
      const jumpTo = Date.parse('2027-03-01T00:00:00.000Z')
      const elapsed = Date.now() - registeredAt
      vi.setSystemTime(jumpTo) // past the 2027-01-01 target, during the first leg
      const wake = jumpTo + (MAX_TIMER_DELAY_MS - elapsed) // the first leg's wake on the (jumped) wall clock
      await vi.advanceTimersByTimeAsync(wake - Date.now())
      expect(cb).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1) // the wake found the target passed and armed a 0 ms final leg
      expect(calls).toEqual([{ id: 'yearly', at: wake + 1 }])
      const next = Date.parse('2028-01-01T00:00:00.000Z')
      await vi.advanceTimersByTimeAsync(next - Date.now() - 1)
      expect(cb).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls[1]).toEqual({ id: 'yearly', at: next })
    } finally {
      await s.destroy()
    }
  })

  it('O9e: the cron 1 s floor still applies (registered 300 ms before the minute: fires 1 s later, not at the minute)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-28T09:14:59.700Z'))
    const { cb, calls } = recordingCallback()
    const s = new AutomationScheduler(cb)
    try {
      s.register(cronRule('floor', '15 9 * * *'))
      await vi.advanceTimersByTimeAsync(999)
      expect(cb).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toEqual([{ id: 'floor', at: Date.parse('2026-06-28T09:15:00.700Z') }])
      await vi.advanceTimersByTimeAsync(DAY)
      expect(calls[1]).toEqual({ id: 'floor', at: Date.parse('2026-06-29T09:15:00.000Z') })
    } finally {
      await s.destroy()
    }
  })

  it('O9f: a cron callback that synchronously re-registers its own rule still runs once per occurrence (stale leg ignored by the identity guard)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-28T00:00:30.000Z'))
    let s!: AutomationScheduler
    const ran: number[] = []
    let first = true
    s = new AutomationScheduler((rule) => {
      ran.push(Date.now())
      if (first) {
        first = false
        s.register(rule) // the fire then deletes and re-arms again: the callback's replacement leg is left unmapped
      }
    })
    try {
      s.register(cronRule('self', '0 12 * * *'))
      await vi.advanceTimersByTimeAsync(5)
      expect(ran).toEqual([])
      await vi.advanceTimersByTimeAsync(3 * DAY)
      expect(ran.map((t) => new Date(t).toISOString())).toEqual([
        '2026-06-28T12:00:00.000Z',
        '2026-06-29T12:00:00.000Z',
        '2026-06-30T12:00:00.000Z',
      ])
    } finally {
      await s.destroy()
    }
  })
})

describe('date-field timer delay stays far below the bound (O7)', () => {
  it('is finite and at most about one civil day for UTC, DST zones, a junk zone and a junk timeOfDay', () => {
    const zones = [undefined, 'UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Not/AZone']
    const times = ['09:00', '00:00', '23:59', 'junk', undefined]
    const start = Date.parse('2026-01-01T00:00:00.000Z')
    let max = 0
    for (const tz of zones) {
      for (const tod of times) {
        for (let t = start; t < start + 366 * DAY; t += 7 * H + 13 * MIN) {
          const d = nextDateReminderTimerDelayMs(tod, t, tz)
          expect(Number.isFinite(d)).toBe(true)
          if (d > max) max = d
        }
      }
    }
    expect(max).toBeLessThanOrEqual(26 * H)
    expect(max).toBeLessThan(MAX_TIMER_DELAY_MS)
  })
})

describe('AutomationScheduler — no TimeoutOverflowWarning (O8, real timers)', () => {
  it('registering two yearly crons and a 30-day interval emits no TimeoutOverflowWarning', async () => {
    vi.useRealTimers()
    const overflow: string[] = []
    const onWarning = (warning: Error) => {
      if (warning.name === 'TimeoutOverflowWarning') overflow.push(warning.message)
    }
    process.on('warning', onWarning)
    const cb = vi.fn()
    const s = new AutomationScheduler(cb)
    try {
      // Two yearly crons six months apart: whatever today's date, at least one is > 24.8 days away.
      s.register(cronRule('yearly-jan', '0 0 1 1 *'))
      s.register(cronRule('yearly-jul', '0 0 1 7 *'))
      s.register(intervalRule('long', 30 * DAY))
      expect(s.activeCount).toBe(3)
      // process.emitWarning delivers on the next tick; let it (and any 1 ms clamp) land before asserting.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 20)
        t.unref()
      })
      expect(overflow).toEqual([])
      expect(cb).not.toHaveBeenCalled()
    } finally {
      process.off('warning', onWarning)
      await s.destroy()
    }
    expect(s.activeCount).toBe(0)
  })
})
