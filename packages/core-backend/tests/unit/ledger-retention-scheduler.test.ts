import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LedgerRetentionScheduler,
  resolveLedgerRetentionSchedulerIntervalMs,
  startLedgerRetentionScheduler,
  stopLedgerRetentionScheduler,
} from '../../src/services/LedgerRetentionScheduler'
import {
  AI_USAGE_LEDGER_RETENTION_DEFAULT_DAYS,
  AI_USAGE_LEDGER_RETENTION_MIN_DAYS,
  resolveAiUsageRetentionConfig,
} from '../../src/services/ai-usage-ledger'
import { MemoryLeaderLockClient, RedisLeaderLock } from '../../src/multitable/redis-leader-lock'

describe('LedgerRetentionScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    stopLedgerRetentionScheduler()
    delete process.env.MULTITABLE_AI_LEDGER_RETENTION_DISABLED
    delete process.env.LEDGER_RETENTION_SCHEDULER_INTERVAL_MS
    delete process.env.MULTITABLE_AI_LEDGER_RETENTION_DAYS
  })

  it('tick() delegates to sweep() and returns its deleted count', async () => {
    const sweep = vi.fn<() => Promise<number>>().mockResolvedValue(7)
    const scheduler = new LedgerRetentionScheduler({ service: { sweep } })
    expect(await scheduler.tick()).toBe(7)
    expect(sweep).toHaveBeenCalledTimes(1)
  })

  it('swallows sweep errors and returns 0 (degraded mode)', async () => {
    const sweep = vi.fn().mockRejectedValue(new Error('db down'))
    const scheduler = new LedgerRetentionScheduler({ service: { sweep } })
    expect(await scheduler.tick()).toBe(0)
  })

  it('prevents reentrant ticks from overlapping (one-run guard)', async () => {
    let resolveFirst: ((v: number) => void) | null = null
    const sweep = vi.fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue(0)
    const scheduler = new LedgerRetentionScheduler({ service: { sweep } })

    const firstPromise = scheduler.tick()
    const second = await scheduler.tick()
    expect(second).toBe(0)
    expect(sweep).toHaveBeenCalledTimes(1) // second was blocked by the one-run guard

    resolveFirst?.(0)
    await firstPromise
  })

  it('runs ticks only on the process that acquired the leader lock', async () => {
    const store = new Map()
    const lockA = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
    const lockB = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
    const leaderSweep = vi.fn().mockResolvedValue(1)
    const followerSweep = vi.fn().mockResolvedValue(1)

    const leader = new LedgerRetentionScheduler({
      service: { sweep: leaderSweep },
      leaderOptions: { leaderLock: lockA, ownerId: 'node-a', ttlMs: 30_000 },
    })
    const follower = new LedgerRetentionScheduler({
      service: { sweep: followerSweep },
      leaderOptions: { leaderLock: lockB, ownerId: 'node-b', ttlMs: 30_000 },
    })
    await Promise.all([leader.ready, follower.ready])

    expect(leader.leader).toBe(true)
    expect(follower.leader).toBe(false)
    expect(await leader.tick()).toBe(1)
    expect(await follower.tick()).toBe(0)
    expect(leaderSweep).toHaveBeenCalledTimes(1)
    expect(followerSweep).not.toHaveBeenCalled()
  })

  it('startLedgerRetentionScheduler returns null when MULTITABLE_AI_LEDGER_RETENTION_DISABLED=1', () => {
    process.env.MULTITABLE_AI_LEDGER_RETENTION_DISABLED = '1'
    const scheduler = startLedgerRetentionScheduler({ service: { sweep: vi.fn().mockResolvedValue(0) } })
    expect(scheduler).toBeNull()
  })

  it('startLedgerRetentionScheduler is enabled by default (no env)', () => {
    const scheduler = startLedgerRetentionScheduler({ service: { sweep: vi.fn().mockResolvedValue(0) } })
    expect(scheduler).not.toBeNull()
  })

  it('resolveLedgerRetentionSchedulerIntervalMs reads a positive override, else undefined', () => {
    expect(resolveLedgerRetentionSchedulerIntervalMs()).toBeUndefined()
    process.env.LEDGER_RETENTION_SCHEDULER_INTERVAL_MS = '3600000'
    expect(resolveLedgerRetentionSchedulerIntervalMs()).toBe(3600000)
    process.env.LEDGER_RETENTION_SCHEDULER_INTERVAL_MS = '-5'
    expect(resolveLedgerRetentionSchedulerIntervalMs()).toBeUndefined()
  })
})

describe('resolveAiUsageRetentionConfig (env parse + floor + opt-out)', () => {
  it('defaults to 90 days, not disabled, with no env set', () => {
    expect(resolveAiUsageRetentionConfig({})).toEqual({
      retentionDays: AI_USAGE_LEDGER_RETENTION_DEFAULT_DAYS,
      disabled: false,
    })
  })

  it('honors a custom MULTITABLE_AI_LEDGER_RETENTION_DAYS', () => {
    expect(resolveAiUsageRetentionConfig({ MULTITABLE_AI_LEDGER_RETENTION_DAYS: '30' })).toEqual({
      retentionDays: 30,
      disabled: false,
    })
  })

  it('floors the retention window at the min (foot-gun guard): 1 day → MIN', () => {
    expect(resolveAiUsageRetentionConfig({ MULTITABLE_AI_LEDGER_RETENTION_DAYS: '1' }).retentionDays).toBe(
      AI_USAGE_LEDGER_RETENTION_MIN_DAYS,
    )
  })

  it('floors invalid / non-positive values back to the default (not below the floor)', () => {
    expect(resolveAiUsageRetentionConfig({ MULTITABLE_AI_LEDGER_RETENTION_DAYS: 'abc' }).retentionDays).toBe(
      AI_USAGE_LEDGER_RETENTION_DEFAULT_DAYS,
    )
    expect(resolveAiUsageRetentionConfig({ MULTITABLE_AI_LEDGER_RETENTION_DAYS: '0' }).retentionDays).toBe(
      AI_USAGE_LEDGER_RETENTION_DEFAULT_DAYS,
    )
    expect(resolveAiUsageRetentionConfig({ MULTITABLE_AI_LEDGER_RETENTION_DAYS: '-10' }).retentionDays).toBe(
      AI_USAGE_LEDGER_RETENTION_DEFAULT_DAYS,
    )
  })

  it('opts out when MULTITABLE_AI_LEDGER_RETENTION_DISABLED=1', () => {
    expect(resolveAiUsageRetentionConfig({ MULTITABLE_AI_LEDGER_RETENTION_DISABLED: '1' }).disabled).toBe(true)
  })
})
