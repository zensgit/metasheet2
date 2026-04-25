import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalSlaScheduler } from '../../src/services/ApprovalSlaScheduler'
import { MemoryLeaderLockClient, RedisLeaderLock } from '../../src/multitable/redis-leader-lock'

describe('ApprovalSlaScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('invokes checkSlaBreaches and the onBreach hook with breached ids', async () => {
    const checkSlaBreaches = vi.fn<(now: Date) => Promise<string[]>>().mockResolvedValue(['apr-1', 'apr-2'])
    const onBreach = vi.fn().mockResolvedValue(undefined)

    const scheduler = new ApprovalSlaScheduler({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      metrics: { checkSlaBreaches } as any,
      intervalMs: 60_000,
      onBreach,
    })

    const breached = await scheduler.tick(new Date('2026-04-25T10:00:00Z'))

    expect(breached).toEqual(['apr-1', 'apr-2'])
    expect(checkSlaBreaches).toHaveBeenCalledTimes(1)
    expect(onBreach).toHaveBeenCalledWith(['apr-1', 'apr-2'])
  })

  it('swallows checkSlaBreaches errors and returns an empty list', async () => {
    const checkSlaBreaches = vi.fn().mockRejectedValue(new Error('db down'))
    const scheduler = new ApprovalSlaScheduler({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      metrics: { checkSlaBreaches } as any,
    })
    const breached = await scheduler.tick()
    expect(breached).toEqual([])
  })

  it('prevents reentrant ticks from overlapping', async () => {
    let resolveFirst: ((v: string[]) => void) | null = null
    const checkSlaBreaches = vi.fn()
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue([])

    const scheduler = new ApprovalSlaScheduler({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      metrics: { checkSlaBreaches } as any,
    })

    const firstPromise = scheduler.tick()
    const secondResult = await scheduler.tick()
    expect(secondResult).toEqual([])
    expect(checkSlaBreaches).toHaveBeenCalledTimes(1)

    resolveFirst?.([])
    await firstPromise
  })

  it('runs ticks only on the process that acquired the leader lock', async () => {
    const store = new Map()
    const leaderLockA = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
    const leaderLockB = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
    const leaderCheck = vi.fn().mockResolvedValue(['apr-1'])
    const followerCheck = vi.fn().mockResolvedValue(['apr-2'])

    const leader = new ApprovalSlaScheduler({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      metrics: { checkSlaBreaches: leaderCheck } as any,
      leaderOptions: { leaderLock: leaderLockA, ownerId: 'node-a', ttlMs: 30_000 },
    })
    const follower = new ApprovalSlaScheduler({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      metrics: { checkSlaBreaches: followerCheck } as any,
      leaderOptions: { leaderLock: leaderLockB, ownerId: 'node-b', ttlMs: 30_000 },
    })

    await Promise.all([leader.ready, follower.ready])

    expect(leader.leader).toBe(true)
    expect(follower.leader).toBe(false)
    expect(await leader.tick(new Date('2026-04-25T10:00:00Z'))).toEqual(['apr-1'])
    expect(await follower.tick(new Date('2026-04-25T10:00:00Z'))).toEqual([])
    expect(leaderCheck).toHaveBeenCalledTimes(1)
    expect(followerCheck).not.toHaveBeenCalled()
  })

  it('releases the leader lock on stop so a replacement can take over', async () => {
    const store = new Map()
    const firstLock = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
    const secondLock = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })

    const first = new ApprovalSlaScheduler({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      metrics: { checkSlaBreaches: vi.fn().mockResolvedValue([]) } as any,
      leaderOptions: { leaderLock: firstLock, ownerId: 'node-a', ttlMs: 30_000 },
    })
    await first.ready
    expect(first.leader).toBe(true)

    first.stop()
    await Promise.resolve()

    const second = new ApprovalSlaScheduler({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      metrics: { checkSlaBreaches: vi.fn().mockResolvedValue([]) } as any,
      leaderOptions: { leaderLock: secondLock, ownerId: 'node-b', ttlMs: 30_000 },
    })
    await second.ready
    expect(second.leader).toBe(true)
    second.stop()
  })
})
