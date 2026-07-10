import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS,
  DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS,
  resolveDingTalkGroupDeliveryRetentionConfig,
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
})
