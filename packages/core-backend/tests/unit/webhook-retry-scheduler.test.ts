import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WebhookRetryScheduler,
  resolveWebhookRetrySchedulerIntervalMs,
  startWebhookRetryScheduler,
  stopWebhookRetryScheduler,
} from '../../src/services/WebhookRetryScheduler'
import { MemoryLeaderLockClient, RedisLeaderLock } from '../../src/multitable/redis-leader-lock'

describe('WebhookRetryScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    stopWebhookRetryScheduler()
    delete process.env.WEBHOOK_RETRY_SCHEDULER_DISABLED
    delete process.env.WEBHOOK_RETRY_SCHEDULER_INTERVAL_MS
  })

  it('tick() delegates to retryFailedDeliveries and returns its count', async () => {
    const retryFailedDeliveries = vi.fn<() => Promise<number>>().mockResolvedValue(3)
    const scheduler = new WebhookRetryScheduler({ service: { retryFailedDeliveries } })
    expect(await scheduler.tick()).toBe(3)
    expect(retryFailedDeliveries).toHaveBeenCalledTimes(1)
  })

  it('swallows retry errors and returns 0', async () => {
    const retryFailedDeliveries = vi.fn().mockRejectedValue(new Error('db down'))
    const scheduler = new WebhookRetryScheduler({ service: { retryFailedDeliveries } })
    expect(await scheduler.tick()).toBe(0)
  })

  it('prevents reentrant ticks from overlapping', async () => {
    let resolveFirst: ((v: number) => void) | null = null
    const retryFailedDeliveries = vi.fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue(0)
    const scheduler = new WebhookRetryScheduler({ service: { retryFailedDeliveries } })

    const firstPromise = scheduler.tick()
    const second = await scheduler.tick()
    expect(second).toBe(0)
    expect(retryFailedDeliveries).toHaveBeenCalledTimes(1) // second was blocked by the one-run guard

    resolveFirst?.(0)
    await firstPromise
  })

  it('runs ticks only on the process that acquired the leader lock', async () => {
    const store = new Map()
    const lockA = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
    const lockB = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
    const leaderRetry = vi.fn().mockResolvedValue(1)
    const followerRetry = vi.fn().mockResolvedValue(1)

    const leader = new WebhookRetryScheduler({
      service: { retryFailedDeliveries: leaderRetry },
      leaderOptions: { leaderLock: lockA, ownerId: 'node-a', ttlMs: 30_000 },
    })
    const follower = new WebhookRetryScheduler({
      service: { retryFailedDeliveries: followerRetry },
      leaderOptions: { leaderLock: lockB, ownerId: 'node-b', ttlMs: 30_000 },
    })
    await Promise.all([leader.ready, follower.ready])

    expect(leader.leader).toBe(true)
    expect(follower.leader).toBe(false)
    expect(await leader.tick()).toBe(1)
    expect(await follower.tick()).toBe(0)
    expect(leaderRetry).toHaveBeenCalledTimes(1)
    expect(followerRetry).not.toHaveBeenCalled()
  })

  it('startWebhookRetryScheduler returns null when WEBHOOK_RETRY_SCHEDULER_DISABLED=1', () => {
    process.env.WEBHOOK_RETRY_SCHEDULER_DISABLED = '1'
    const scheduler = startWebhookRetryScheduler({ service: { retryFailedDeliveries: vi.fn().mockResolvedValue(0) } })
    expect(scheduler).toBeNull()
  })

  it('startWebhookRetryScheduler is enabled by default (no env)', () => {
    const scheduler = startWebhookRetryScheduler({ service: { retryFailedDeliveries: vi.fn().mockResolvedValue(0) } })
    expect(scheduler).not.toBeNull()
  })

  it('resolveWebhookRetrySchedulerIntervalMs reads a positive override, else undefined', () => {
    expect(resolveWebhookRetrySchedulerIntervalMs()).toBeUndefined()
    process.env.WEBHOOK_RETRY_SCHEDULER_INTERVAL_MS = '15000'
    expect(resolveWebhookRetrySchedulerIntervalMs()).toBe(15000)
    process.env.WEBHOOK_RETRY_SCHEDULER_INTERVAL_MS = '-5'
    expect(resolveWebhookRetrySchedulerIntervalMs()).toBeUndefined()
  })
})
