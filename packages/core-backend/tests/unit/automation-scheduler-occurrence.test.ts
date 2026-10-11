/** Actual scheduler + fake clock. Retained timer callbacks model callbacks already
 * dequeued when cancellation/replacement occurs; no scheduler methods are mocked.
 * Occurrence equality is scheduling evidence only, not durable admission authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationScheduler, type AutomationSchedulerLeaderOptions, type ScheduleCallback } from '../../src/multitable/automation-scheduler'
import type { AutomationRule } from '../../src/multitable/automation-executor'
import { MemoryLeaderLockClient, RedisLeaderLock } from '../../src/multitable/redis-leader-lock'
import { scheduleIntervalMs } from '../../src/multitable/automation-triggers'

const start = Date.parse('2026-10-01T00:00:10.000Z')
const firstOccurrence = Date.parse('2026-10-01T00:01:00.000Z')
const maxTimeoutDelay = 2 ** 31 - 1
let restoreTimerCaptures: Array<() => void> = []
function cronRule(expression = '* * * * *'): AutomationRule {
  return { id: 'synthetic-cron', name: 'Synthetic cron', sheetId: 'synthetic-sheet',
    trigger: { type: 'schedule.cron', config: { expression } }, actions: [], enabled: true,
    createdBy: 'synthetic-owner', createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString() }
}
function captureTimeouts() {
  // Do not spyOn a fake-clock global: Vitest's later file-level mock restoration
  // could reinstall that already-uninstalled clock into the next spec's globals.
  const original = globalThis.setTimeout
  const spy = vi.fn(original)
  // This fake-clock passthrough intentionally does not implement Node's unused promisify hook.
  globalThis.setTimeout = spy as unknown as typeof setTimeout
  restoreTimerCaptures.push(() => { globalThis.setTimeout = original })
  return { spy, latest() {
    const callback = spy.mock.calls.at(-1)?.[0]
    const result = spy.mock.results.at(-1)
    if (typeof callback !== 'function' || result?.type !== 'return') throw new Error('Expected an actual timer callback')
    return { handle: result.value as ReturnType<typeof setTimeout>, fire: () => callback() }
  } }
}

describe('AutomationScheduler cron occurrence and timer ownership', () => {
  let schedulers: AutomationScheduler[]
  beforeEach(() => {
    // Count only scheduler timers, not the logger's deferred nextTick/immediate work.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(start)
    schedulers = []
    restoreTimerCaptures = []
  })
  afterEach(async () => {
    await Promise.all(schedulers.map(scheduler => scheduler.destroy()))
    for (const restore of restoreTimerCaptures.reverse()) restore()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  function scheduler(callback: ScheduleCallback, options?: AutomationSchedulerLeaderOptions) {
    const instance = new AutomationScheduler(callback, options)
    schedulers.push(instance)
    return instance
  }

  it('passes a frozen planned instant even when the callback runs late, then re-arms from now without catch-up', () => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), rule = cronRule()
    instance.register(rule)
    const pending = timers.latest()
    // Dequeue the timer, then deliver its callback after the intended minute.
    clearTimeout(pending.handle)
    vi.setSystemTime(Date.parse('2026-10-01T00:04:15.000Z'))
    pending.fire()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(rule, { triggerType: 'schedule.cron', scheduledAtMs: firstOccurrence })
    const occurrence = callback.mock.calls[0][1]!
    expect(Object.isFrozen(occurrence)).toBe(true)
    expect(Reflect.set(occurrence, 'scheduledAtMs', Date.now())).toBe(false)
    expect(occurrence.scheduledAtMs).toBe(firstOccurrence)
    expect(timers.spy).toHaveBeenLastCalledWith(expect.any(Function), 45_000)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(45_000)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[1][1]).toEqual({ triggerType: 'schedule.cron', scheduledAtMs: Date.parse('2026-10-01T00:05:00.000Z') })
  })

  it('gives two independent scheduler instances the same occurrence for the same cron minute', () => {
    const left = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const right = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>(), rule = cronRule()
    scheduler(left).register(rule)
    scheduler(right).register(rule)
    vi.advanceTimersByTime(50_000)
    expect(left).toHaveBeenCalledTimes(1)
    expect(right).toHaveBeenCalledTimes(1)
    expect(left.mock.calls[0][1]).toEqual(right.mock.calls[0][1])
    expect(left.mock.calls[0][1]?.scheduledAtMs).toBe(firstOccurrence)
    expect(Object.isFrozen(right.mock.calls[0][1])).toBe(true)
  })

  it.each([
    ['monthly', '0 0 1 * *', '2026-11-01T00:00:00.000Z'],
    ['yearly', '0 0 1 1 *', '2027-01-01T00:00:00.000Z'],
  ])('chunks a %s cron beyond signed-32-bit delay without admitting an early occurrence', (_kind, expression, instant) => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), rule = cronRule(expression), planned = Date.parse(instant)
    expect(planned - start).toBeGreaterThan(maxTimeoutDelay)
    instance.register(rule)
    const first = timers.latest()
    expect(timers.spy).toHaveBeenLastCalledWith(expect.any(Function), maxTimeoutDelay)
    vi.advanceTimersByTime(maxTimeoutDelay)
    expect(callback).not.toHaveBeenCalled()
    expect(timers.spy).toHaveBeenCalledTimes(2)
    expect(timers.latest().handle).not.toBe(first.handle)
    expect(vi.getTimerCount()).toBe(1)
    // All remaining chunks are real fake-clock timeouts, not direct callback invocations.
    vi.advanceTimersByTime(planned - Date.now() - 1)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(rule, { triggerType: 'schedule.cron', scheduledAtMs: planned })
    expect(Object.isFrozen(callback.mock.calls[0][1])).toBe(true)
    for (const [, delay] of timers.spy.mock.calls) {
      expect(delay).toBeGreaterThanOrEqual(1_000)
      expect(delay).toBeLessThanOrEqual(maxTimeoutDelay)
    }
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('clock rollback re-arms only the original planned minute, not an earlier newly matching minute', () => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), rule = cronRule()
    instance.register(rule)
    const dequeued = timers.latest(); clearTimeout(dequeued.handle)
    // An OS timeout can be ready while wall time has moved backward. A cron
    // rescan from this earlier wall time would wrongly choose 00:00, not 00:01.
    vi.setSystemTime(start - 60_000)
    dequeued.fire()
    expect(callback).not.toHaveBeenCalled()
    expect(timers.spy).toHaveBeenLastCalledWith(expect.any(Function), 110_000)
    expect(timers.latest().handle).not.toBe(dequeued.handle)
    vi.advanceTimersByTime(50_000)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(rule, { triggerType: 'schedule.cron', scheduledAtMs: firstOccurrence })
  })

  it.each(['replace', 'unregister', 'destroy'] as const)('expired and current long-wait chunks cannot re-arm after %s', async operation => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), rule = cronRule('0 0 1 * *')
    instance.register(rule)
    const expired = timers.latest()
    vi.advanceTimersByTime(maxTimeoutDelay)
    const current = timers.latest()
    // A chunk that already yielded its handle cannot replace its newer chunk.
    expired.fire()
    expect(timers.spy).toHaveBeenCalledTimes(2)
    expect(timers.latest().handle).toBe(current.handle)
    if (operation === 'replace') instance.register(cronRule())
    else if (operation === 'unregister') instance.unregister(rule.id)
    else await instance.destroy()
    const registrations = timers.spy.mock.calls.length, latest = timers.latest()
    expired.fire(); current.fire()
    expect(callback).not.toHaveBeenCalled()
    expect(timers.spy).toHaveBeenCalledTimes(registrations)
    expect(vi.getTimerCount()).toBe(operation === 'replace' ? 1 : 0)
    if (operation === 'replace') {
      expect(timers.latest().handle).toBe(latest.handle)
      const replacementInstant = Math.floor(Date.now() / 60_000) * 60_000 + 60_000
      vi.advanceTimersByTime(replacementInstant - Date.now())
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][1]?.scheduledAtMs).toBe(replacementInstant)
    }
  })

  it('a replaced cron callback cannot execute, consume its replacement or re-arm the old schedule', () => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>(), instance = scheduler(callback)
    instance.register(cronRule())
    const stale = timers.latest()
    const replacement = cronRule('*/5 * * * *')
    instance.register(replacement)
    const current = timers.latest()
    stale.fire()
    expect(callback).not.toHaveBeenCalled()
    expect(timers.spy).toHaveBeenCalledTimes(2)
    expect(timers.latest().handle).toBe(current.handle)
    expect(instance.isRegistered(replacement.id)).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(290_000)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(replacement, {
      triggerType: 'schedule.cron', scheduledAtMs: Date.parse('2026-10-01T00:05:00.000Z'),
    })
  })

  it.each(['unregister', 'destroy'] as const)('a retained old callback after %s cannot execute or re-arm', async operation => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>(), instance = scheduler(callback), rule = cronRule()
    instance.register(rule)
    const stale = timers.latest()
    if (operation === 'unregister') instance.unregister(rule.id)
    else await instance.destroy()
    stale.fire()
    expect(callback).not.toHaveBeenCalled()
    expect(instance.activeCount).toBe(0)
    expect(timers.spy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a retained cron callback cannot execute or re-arm after actual leader renewal loses the lease', async () => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const leaderLock = new RedisLeaderLock({ client: new MemoryLeaderLockClient() })
    const instance = scheduler(callback, { leaderLock, ownerId: 'synthetic-leader', ttlMs: 30_000, renewIntervalMs: 1_000 })
    await instance.ready
    instance.register(cronRule())
    const stale = timers.latest()
    expect(await leaderLock.release('automation-scheduler:leader', 'synthetic-leader')).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(instance.leader).toBe(false)
    stale.fire()
    expect(callback).not.toHaveBeenCalled()
    expect(instance.activeCount).toBe(0)
    expect(timers.spy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not consume a replacement registered synchronously by the admitted callback', () => {
    const timers = captureTimeouts(), rule = cronRule(), replacement = cronRule('*/5 * * * *')
    const callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback)
    callback.mockImplementationOnce(() => { instance.register(replacement) })
    instance.register(rule)
    vi.advanceTimersByTime(50_000)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(timers.spy).toHaveBeenCalledTimes(2)
    expect(instance.activeCount).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(240_000)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[1][0]).toBe(replacement)
    expect(callback.mock.calls[1][1]?.scheduledAtMs).toBe(Date.parse('2026-10-01T00:05:00.000Z'))
  })

  it.each(['unregister', 'destroy'] as const)('does not re-arm when its callback synchronously requests %s', async operation => {
    const timers = captureTimeouts(), rule = cronRule(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback)
    let stopping: Promise<void> | undefined
    callback.mockImplementationOnce(() => {
      if (operation === 'unregister') instance.unregister(rule.id)
      else stopping = instance.destroy()
    })
    instance.register(rule)
    vi.advanceTimersByTime(50_000)
    await stopping
    expect(callback).toHaveBeenCalledTimes(1)
    expect(instance.activeCount).toBe(0)
    expect(timers.spy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('destroy closes timer admission synchronously and waits for an already admitted callback', async () => {
    let finish!: () => void
    const held = new Promise<void>(resolve => { finish = resolve })
    const callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>().mockReturnValue(held), instance = scheduler(callback)
    instance.register(cronRule())
    vi.advanceTimersByTime(50_000)
    expect(callback).toHaveBeenCalledTimes(1)
    const settled = vi.fn(), stopping = instance.destroy().then(settled)
    try {
      instance.register(cronRule())
      expect(instance.activeCount).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      // Let destroy pass its already-resolved initial-election promise. The
      // admitted callback cannot settle until this test explicitly releases it.
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      vi.advanceTimersByTime(120_000)
      expect(callback).toHaveBeenCalledTimes(1)
    } finally {
      finish()
      await stopping
    }
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it.each(['schedule.interval', 'schedule.date_field'] as const)('preserves the single-argument callback for %s', triggerType => {
    const callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>(), instance = scheduler(callback)
    const rule: AutomationRule = { ...cronRule(), trigger: triggerType === 'schedule.interval'
      ? { type: triggerType, config: { intervalMs: 50_000 } }
      : { type: triggerType, config: { dateFieldId: 'synthetic-date', offsetDays: 0, direction: 'after', timeOfDay: '00:01' } } }
    instance.register(rule)
    vi.advanceTimersByTime(50_000)
    expect(callback.mock.calls).toEqual([[rule]])
  })

  function dateReadRule(timeOfDay = '00:01'): AutomationRule {
    return { ...cronRule(), trigger: { type: 'schedule.date_field',
      config: { dateFieldId: 'synthetic-date', offsetDays: 0, direction: 'after', timeOfDay, timezone: 'UTC' } },
      actions: [{ type: 'integration_read_preview', config: { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: false } }] }
  }
  it('date read startup catch-up delivers only a frozen host wake and arms the next daily timer', () => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), rule = dateReadRule('00:00')
    instance.register(rule)
    expect(callback.mock.calls).toEqual([[rule, { triggerType: 'schedule.date_field', scheduledAtMs: start }]])
    const wake = callback.mock.calls[0][1]!
    expect(Object.keys(wake).sort()).toEqual(['scheduledAtMs', 'triggerType'])
    expect(Object.isFrozen(wake)).toBe(true)
    expect(Reflect.set(wake, 'recordId', 'untrusted-record')).toBe(false)
    expect(timers.spy).toHaveBeenCalledTimes(1)
    expect(timers.spy).toHaveBeenLastCalledWith(expect.any(Function), 86_390_000)
    expect(instance.activeCount).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
  })
  it('date read delayed timer keeps its planned wake, not the callback wall time or a record occurrence', () => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), rule = dateReadRule()
    instance.register(rule)
    expect(callback).not.toHaveBeenCalled()
    const pending = timers.latest(); clearTimeout(pending.handle)
    const deliveredAt = Date.parse('2026-10-01T00:04:15.000Z')
    vi.setSystemTime(deliveredAt); pending.fire()
    expect(callback.mock.calls).toEqual([[rule, { triggerType: 'schedule.date_field', scheduledAtMs: firstOccurrence }]])
    expect(Object.isFrozen(callback.mock.calls[0][1])).toBe(true)
    expect(timers.spy).toHaveBeenLastCalledWith(expect.any(Function), Date.parse('2026-10-02T00:01:00.000Z') - deliveredAt)
    const rearmed = timers.latest(), registrations = timers.spy.mock.calls.length
    pending.fire()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(timers.spy).toHaveBeenCalledTimes(registrations)
    expect(timers.latest().handle).toBe(rearmed.handle)
  })
  it.each(['replace', 'unregister', 'destroy'] as const)('date read retained timer cannot execute or rearm after %s', async operation => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), rule = dateReadRule()
    instance.register(rule)
    const stale = timers.latest(), replacement = dateReadRule('00:02')
    if (operation === 'replace') instance.register(replacement)
    else if (operation === 'unregister') instance.unregister(rule.id)
    else await instance.destroy()
    const registrations = timers.spy.mock.calls.length
    vi.setSystemTime(firstOccurrence); stale.fire()
    expect(callback).not.toHaveBeenCalled()
    expect(timers.spy).toHaveBeenCalledTimes(registrations)
    expect(vi.getTimerCount()).toBe(operation === 'replace' ? 1 : 0)
    if (operation === 'replace') {
      // The real fake-clock deadline still has 110s remaining: setSystemTime
      // changes wall time only, not the timer's elapsed-clock position.
      vi.setSystemTime(start)
      await vi.advanceTimersByTimeAsync(110_000)
      expect(callback.mock.calls).toEqual([[replacement, { triggerType: 'schedule.date_field', scheduledAtMs: firstOccurrence + 60_000 }]])
    }
  })
  it.each(['replace', 'unregister', 'destroy'] as const)('date startup catch-up cannot overwrite a synchronous %s from its callback', async operation => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), replacement = dateReadRule('00:02')
    let stopping: Promise<void> | undefined
    callback.mockImplementationOnce(() => {
      if (operation === 'replace') instance.register(replacement)
      else if (operation === 'unregister') instance.unregister(replacement.id)
      else stopping = instance.destroy()
    })
    instance.register(dateReadRule('00:00'))
    await stopping
    expect(callback).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(operation === 'replace' ? 1 : 0)
    expect(timers.spy).toHaveBeenCalledTimes(operation === 'replace' ? 2 : 1)
    if (operation === 'replace') {
      await vi.advanceTimersByTimeAsync(110_000)
      expect(callback.mock.calls[1]).toEqual([replacement, { triggerType: 'schedule.date_field', scheduledAtMs: firstOccurrence + 60_000 }])
    }
  })
  it('date timer callback cannot consume its synchronous replacement or rearm an old daily handle', async () => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), rule = dateReadRule(), replacement = dateReadRule('00:02')
    callback.mockImplementationOnce(() => { instance.register(replacement) })
    instance.register(rule)
    await vi.advanceTimersByTimeAsync(50_000)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(timers.spy).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(callback.mock.calls[1]).toEqual([replacement, { triggerType: 'schedule.date_field', scheduledAtMs: firstOccurrence + 60_000 }])
  })
  it('date read clock rollback cannot admit an early wake and the superseded handle stays inert', async () => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), rule = dateReadRule()
    instance.register(rule)
    const dequeued = timers.latest(); clearTimeout(dequeued.handle)
    vi.setSystemTime(start - 5000); dequeued.fire()
    expect(callback).not.toHaveBeenCalled()
    expect(timers.spy).toHaveBeenLastCalledWith(expect.any(Function), 55_000)
    const registrations = timers.spy.mock.calls.length
    dequeued.fire()
    expect(timers.spy).toHaveBeenCalledTimes(registrations)
    await vi.advanceTimersByTimeAsync(55_000)
    expect(callback.mock.calls).toEqual([[rule, { triggerType: 'schedule.date_field', scheduledAtMs: firstOccurrence }]])
  })
  it('date read retained timer is inert after actual leader renewal loses the lease', async () => {
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const leaderLock = new RedisLeaderLock({ client: new MemoryLeaderLockClient() })
    const instance = scheduler(callback, { leaderLock, ownerId: 'synthetic-date-leader', ttlMs: 30000, renewIntervalMs: 1000 })
    await instance.ready
    instance.register(dateReadRule())
    const stale = timers.latest()
    expect(await leaderLock.release('automation-scheduler:leader', 'synthetic-date-leader')).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(instance.leader).toBe(false)
    vi.setSystemTime(firstOccurrence); stale.fire()
    expect(callback).not.toHaveBeenCalled()
    expect(instance.activeCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['startup', 'timer'] as const)('destroy drains an admitted date %s callback and closes all later admission', async path => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const timers = captureTimeouts(), callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>().mockReturnValue(held)
    const instance = scheduler(callback), rule = dateReadRule(path === 'startup' ? '00:00' : '00:01')
    instance.register(rule)
    if (path === 'timer') await vi.advanceTimersByTimeAsync(50_000)
    const retained = timers.latest()
    expect(callback).toHaveBeenCalledTimes(1)
    let settled = false
    const stopping = instance.destroy().then(() => { settled = true })
    try {
      await Promise.resolve(); await Promise.resolve()
      expect(settled).toBe(false)
      retained.fire(); instance.register(rule)
      await vi.advanceTimersByTimeAsync(2 * 86_400_000)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(instance.activeCount).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally { release(); await stopping }
    expect(settled).toBe(true)
  })
  it('ordinary date startup catch-up and daily timer retain the single-argument callback', async () => {
    const callback = vi.fn<Parameters<ScheduleCallback>, ReturnType<ScheduleCallback>>()
    const instance = scheduler(callback), rule = { ...dateReadRule('00:00'), actions: [] }
    instance.register(rule)
    expect(callback.mock.calls).toEqual([[rule]])
    await vi.advanceTimersByTimeAsync(86_390_000)
    expect(callback.mock.calls).toEqual([[rule], [rule]])
  })

  it.each([NaN, Infinity, -Infinity, 0, 999, 1000.5, 2147483648, '1000', null, undefined])('rejects unsafe interval delay %s before timer creation', value => {
    expect(scheduleIntervalMs({ intervalMs: value })).toBeNull()
    const instance = scheduler(vi.fn())
    instance.register({ ...cronRule(), trigger: { type: 'schedule.interval', config: { intervalMs: value } } })
    expect(instance.activeCount).toBe(0)
  })
  it('read interval closed shape rejects aliases, extras, prototypes and accessors without invoking them', () => {
    const getter = vi.fn(() => 1000)
    for (const config of [{ intervalMinutes: 1 }, { intervalMs: 1000, intervalMinutes: 1 },
      { intervalMs: 1000, startAt: '2026-10-01' }, Object.create({ intervalMs: 1000 }),
      Object.defineProperty({}, 'intervalMs', { get: getter, enumerable: true })]) {
      expect(scheduleIntervalMs(config, true)).toBeNull()
    }
    expect(getter).not.toHaveBeenCalled()
    expect(scheduleIntervalMs({ intervalMs: 1000 }, true)).toBe(1000)
    expect(scheduleIntervalMs({ intervalMs: 2147483647 }, true)).toBe(2147483647)
    expect(scheduleIntervalMs({ intervalMs: 1000, startAt: 'legacy-extra' })).toBe(1000)
  })
  function intervalReadRule(intervalMs = 1000): AutomationRule {
    return { ...cronRule(), trigger: { type: 'schedule.interval', config: { intervalMs } },
      actions: [{ type: 'integration_read_preview', config: { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: false } }],
      createdAt: new Date(start - 500).toISOString() }
  }
  it('read interval keeps the createdAt phase across late registration and restart', async () => {
    const callback = vi.fn(), instance = scheduler(callback), rule = intervalReadRule()
    instance.register(rule)
    await vi.advanceTimersByTimeAsync(500)
    expect(callback.mock.calls[0]).toEqual([rule, { triggerType: 'schedule.interval', scheduledAtMs: start + 500,
      intervalMs: 1000, anchorMs: start - 500 }])
    expect(Object.isFrozen(callback.mock.calls[0][1])).toBe(true)
    await instance.destroy()
    vi.setSystemTime(start + 2100)
    const restarted = scheduler(callback)
    restarted.register(rule)
    await vi.advanceTimersByTimeAsync(400)
    expect(callback.mock.calls[1][1]).toEqual({ triggerType: 'schedule.interval', scheduledAtMs: start + 2500,
      intervalMs: 1000, anchorMs: start - 500 })
  })
  it('late read interval retains the dequeued occurrence and skips all missed phases', async () => {
    const timers = captureTimeouts(), callback = vi.fn(), instance = scheduler(callback), rule = intervalReadRule()
    instance.register(rule)
    const pending = timers.latest(); clearTimeout(pending.handle)
    vi.setSystemTime(start + 5250)
    pending.fire()
    await vi.advanceTimersByTimeAsync(0)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][1].scheduledAtMs).toBe(start + 500)
    expect(timers.spy).toHaveBeenLastCalledWith(expect.any(Function), 250)
    await vi.advanceTimersByTimeAsync(250)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[1][1].scheduledAtMs).toBe(start + 5500)
  })
  it('read interval waits for async completion and replacement cannot overlap or be rearmed by stale completion', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const callback = vi.fn().mockReturnValueOnce(held), instance = scheduler(callback), rule = intervalReadRule()
    instance.register(rule)
    try {
      await vi.advanceTimersByTimeAsync(500)
      await vi.advanceTimersByTimeAsync(5000)
      expect(callback).toHaveBeenCalledTimes(1)
      instance.register(rule)
      await vi.advanceTimersByTimeAsync(1000)
      expect(callback).toHaveBeenCalledTimes(1)
      release(); await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(callback).toHaveBeenCalledTimes(2)
      expect(callback.mock.calls[1][1].scheduledAtMs).toBe(start + 7500)
    } finally { release() }
  })
  it('read interval rejects absent anchors and invalid read configurations rather than borrowing registration time', () => {
    const instance = scheduler(vi.fn())
    for (const rule of [{ ...intervalReadRule(), createdAt: 'invalid' },
      { ...intervalReadRule(), trigger: { type: 'schedule.interval' as const, config: { intervalMinutes: 1 } } }]) {
      instance.register(rule)
      expect(instance.activeCount).toBe(0)
    }
  })
  it('replaced or destroyed interval timer callbacks are inert', async () => {
    const timers = captureTimeouts(), callback = vi.fn(), instance = scheduler(callback), rule = intervalReadRule()
    instance.register(rule)
    const stale = timers.latest()
    instance.register(rule)
    vi.setSystemTime(start + 500)
    stale.fire()
    expect(callback).not.toHaveBeenCalled()
    const active = timers.latest()
    await instance.destroy()
    active.fire()
    expect(callback).not.toHaveBeenCalled()
  })
  it('read interval clock rollback re-arms the same future occurrence without an early callback', async () => {
    const timers = captureTimeouts(), callback = vi.fn(), instance = scheduler(callback), rule = intervalReadRule()
    instance.register(rule)
    const pending = timers.latest(); clearTimeout(pending.handle)
    vi.setSystemTime(start - 1000)
    pending.fire()
    expect(callback).not.toHaveBeenCalled()
    expect(timers.spy).toHaveBeenLastCalledWith(expect.any(Function), 1500)
    await vi.advanceTimersByTimeAsync(1500)
    expect(callback.mock.calls[0][1]).toEqual({ triggerType: 'schedule.interval', scheduledAtMs: start + 500,
      intervalMs: 1000, anchorMs: start - 500 })
  })
  it('read interval retained callback is inert after real leader renewal loses its lease', async () => {
    const timers = captureTimeouts(), callback = vi.fn()
    const leaderLock = new RedisLeaderLock({ client: new MemoryLeaderLockClient() })
    const instance = scheduler(callback, { leaderLock, ownerId: 'synthetic-interval-leader', ttlMs: 30000, renewIntervalMs: 1000 })
    await instance.ready
    instance.register(intervalReadRule(2000))
    const retained = timers.latest()
    expect(await leaderLock.release('automation-scheduler:leader', 'synthetic-interval-leader')).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(instance.leader).toBe(false)
    vi.setSystemTime(start + 1500)
    retained.fire()
    expect(callback).not.toHaveBeenCalled()
    expect(instance.activeCount).toBe(0)
  })
  it('destroy drains an admitted read interval callback without rearming it', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), callback = vi.fn().mockReturnValue(held)
    const instance = scheduler(callback)
    instance.register(intervalReadRule())
    await vi.advanceTimersByTimeAsync(500)
    let settled = false
    const stopping = instance.destroy().then(() => { settled = true })
    try {
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(instance.activeCount).toBe(0)
      release(); await stopping
      await vi.advanceTimersByTimeAsync(5000)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { release(); await stopping }
  })
})
