import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS,
  DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS,
  resolveDingTalkGroupDeliveryRetentionConfig,
  sweepDingTalkGroupDeliveryRetention,
} from '../../src/services/dingtalk-group-delivery-retention'
import {
  LedgerRetentionScheduler,
  stopLedgerRetentionScheduler,
} from '../../src/services/LedgerRetentionScheduler'
import {
  resolveDingTalkGroupDeliveryRetentionSchedulerIntervalMs,
  startDingTalkGroupDeliveryRetentionScheduler,
  stopDingTalkGroupDeliveryRetentionScheduler,
} from '../../src/services/dingtalk-group-delivery-retention-scheduler'

describe('resolveDingTalkGroupDeliveryRetentionConfig (env parse + floor + opt-out)', () => {
  it('defaults to 90 days, not disabled, with no env set', () => {
    expect(resolveDingTalkGroupDeliveryRetentionConfig({})).toEqual({
      retentionDays: DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS,
      disabled: false,
    })
  })

  it('honors a custom DINGTALK_GROUP_DELIVERY_RETENTION_DAYS', () => {
    expect(
      resolveDingTalkGroupDeliveryRetentionConfig({ DINGTALK_GROUP_DELIVERY_RETENTION_DAYS: '30' }),
    ).toEqual({ retentionDays: 30, disabled: false })
  })

  it('floors the retention window at the min (foot-gun guard): 1 day → MIN', () => {
    expect(
      resolveDingTalkGroupDeliveryRetentionConfig({ DINGTALK_GROUP_DELIVERY_RETENTION_DAYS: '1' }).retentionDays,
    ).toBe(DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS)
  })

  it('floors invalid / non-positive values back to the default (not below the floor)', () => {
    expect(
      resolveDingTalkGroupDeliveryRetentionConfig({ DINGTALK_GROUP_DELIVERY_RETENTION_DAYS: 'abc' }).retentionDays,
    ).toBe(DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS)
    expect(
      resolveDingTalkGroupDeliveryRetentionConfig({ DINGTALK_GROUP_DELIVERY_RETENTION_DAYS: '0' }).retentionDays,
    ).toBe(DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS)
    expect(
      resolveDingTalkGroupDeliveryRetentionConfig({ DINGTALK_GROUP_DELIVERY_RETENTION_DAYS: '-10' }).retentionDays,
    ).toBe(DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS)
    expect(
      resolveDingTalkGroupDeliveryRetentionConfig({ DINGTALK_GROUP_DELIVERY_RETENTION_DAYS: 'NaN' }).retentionDays,
    ).toBe(DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS)
  })

  it('opts out when DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED=1', () => {
    expect(
      resolveDingTalkGroupDeliveryRetentionConfig({ DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED: '1' }).disabled,
    ).toBe(true)
  })

  it('does not opt out on any other value (only the literal "1" disables)', () => {
    expect(
      resolveDingTalkGroupDeliveryRetentionConfig({ DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED: 'true' }).disabled,
    ).toBe(false)
  })
})

describe('sweepDingTalkGroupDeliveryRetention re-floor (defense-in-depth)', () => {
  it('re-floors an out-of-range config.retentionDays before building the DELETE — even though the only production caller (resolveDingTalkGroupDeliveryRetentionConfig) already floors it, a config object built by hand (e.g. a future caller, or a test) must not be able to bypass the floor', async () => {
    const calls: Array<unknown[] | undefined> = []
    const query = vi.fn(async (_sql: string, params?: unknown[]) => {
      calls.push(params)
      return { rows: [], rowCount: 0 }
    })
    await sweepDingTalkGroupDeliveryRetention(query as never, {
      retentionDays: 1, // below DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS (7); only reachable by
      // constructing the config directly, bypassing resolveDingTalkGroupDeliveryRetentionConfig's own floor
      disabled: false,
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(calls[0]?.[0]).toBe(DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS) // re-floored to 7, not the raw 1
  })
})

describe('DingTalk group-delivery retention scheduler (reuses the generic LedgerRetentionScheduler)', () => {
  afterEach(() => {
    stopLedgerRetentionScheduler()
    stopDingTalkGroupDeliveryRetentionScheduler()
    delete process.env.DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED
    delete process.env.DINGTALK_GROUP_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS
  })

  it('tick() delegates to the injected fake sweep and returns its deleted count', async () => {
    const sweep = vi.fn<() => Promise<number>>().mockResolvedValue(42)
    const scheduler = new LedgerRetentionScheduler({ service: { sweep } })
    expect(await scheduler.tick()).toBe(42)
    expect(sweep).toHaveBeenCalledTimes(1)
  })

  it('swallows sweep errors and returns 0 (degraded mode)', async () => {
    const sweep = vi.fn().mockRejectedValue(new Error('db down'))
    const scheduler = new LedgerRetentionScheduler({ service: { sweep } })
    expect(await scheduler.tick()).toBe(0)
  })

  it('startDingTalkGroupDeliveryRetentionScheduler returns null when DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED=1', () => {
    process.env.DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED = '1'
    const scheduler = startDingTalkGroupDeliveryRetentionScheduler({
      service: { sweep: vi.fn().mockResolvedValue(0) },
    })
    expect(scheduler).toBeNull()
  })

  it('startDingTalkGroupDeliveryRetentionScheduler is enabled by default (no env)', () => {
    const scheduler = startDingTalkGroupDeliveryRetentionScheduler({
      service: { sweep: vi.fn().mockResolvedValue(0) },
    })
    expect(scheduler).not.toBeNull()
  })

  it('startDingTalkGroupDeliveryRetentionScheduler returns the same shared instance on repeat calls', () => {
    const first = startDingTalkGroupDeliveryRetentionScheduler({ service: { sweep: vi.fn().mockResolvedValue(0) } })
    const second = startDingTalkGroupDeliveryRetentionScheduler({ service: { sweep: vi.fn().mockResolvedValue(0) } })
    expect(first).toBe(second)
  })

  it('resolveDingTalkGroupDeliveryRetentionSchedulerIntervalMs reads a positive override, else undefined', () => {
    expect(resolveDingTalkGroupDeliveryRetentionSchedulerIntervalMs()).toBeUndefined()
    process.env.DINGTALK_GROUP_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS = '3600000'
    expect(resolveDingTalkGroupDeliveryRetentionSchedulerIntervalMs()).toBe(3600000)
    process.env.DINGTALK_GROUP_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS = '-5'
    expect(resolveDingTalkGroupDeliveryRetentionSchedulerIntervalMs()).toBeUndefined()
  })

  it('start() actually arms the interval loop (not just returns a scheduler): the injected sweep fires once timers advance past the interval, fires again on the NEXT interval (the loop re-arms, it is not a one-shot timeout), and stop() halts further ticks', async () => {
    vi.useFakeTimers()
    try {
      const sweep = vi.fn<() => Promise<number>>().mockResolvedValue(0)
      const intervalMs = 60_000 // MIN_INTERVAL_MS floor in LedgerRetentionScheduler
      const scheduler = startDingTalkGroupDeliveryRetentionScheduler({ service: { sweep }, intervalMs })
      expect(scheduler).not.toBeNull()
      await scheduler!.ready // no leaderOptions → resolves synchronously, but await to flush the .then() that arms the timer

      expect(sweep).not.toHaveBeenCalled() // nothing fires before the interval elapses

      await vi.advanceTimersByTimeAsync(intervalMs)
      expect(sweep).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(intervalMs)
      expect(sweep).toHaveBeenCalledTimes(2) // second interval: the loop re-arms itself

      stopDingTalkGroupDeliveryRetentionScheduler()
      await vi.advanceTimersByTimeAsync(intervalMs * 3)
      expect(sweep).toHaveBeenCalledTimes(2) // stop() cleared the interval — no further ticks
    } finally {
      vi.useRealTimers()
    }
  })
})
