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

  it('runs ticks only on the process that acquired the leader lock (SAME sweep, two processes — the intended election)', async () => {
    const store = new Map()
    const lockA = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
    const lockB = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
    const leaderSweep = vi.fn().mockResolvedValue(1)
    const followerSweep = vi.fn().mockResolvedValue(1)

    // Two PROCESSES, ONE sweep → they SHOULD share a key: exactly one of them may run it.
    const SAME_SWEEP_KEY = 'ledger-retention:ai-usage-ledger:leader'
    const leader = new LedgerRetentionScheduler({
      service: { sweep: leaderSweep },
      leaderOptions: { leaderLock: lockA, lockKey: SAME_SWEEP_KEY, ownerId: 'node-a', ttlMs: 30_000 },
    })
    const follower = new LedgerRetentionScheduler({
      service: { sweep: followerSweep },
      leaderOptions: { leaderLock: lockB, lockKey: SAME_SWEEP_KEY, ownerId: 'node-b', ttlMs: 30_000 },
    })
    await Promise.all([leader.ready, follower.ready])

    expect(leader.leader).toBe(true)
    expect(follower.leader).toBe(false)
    expect(await leader.tick()).toBe(1)
    expect(await follower.tick()).toBe(0)
    expect(leaderSweep).toHaveBeenCalledTimes(1)
    expect(followerSweep).not.toHaveBeenCalled()
  })

  // ─── owner review P2 (2026-07-12): DIFFERENT sweeps must not contend for one key ────────────────
  //
  // LedgerRetentionScheduler is GENERIC — the AI-usage ledger, the DingTalk group-delivery ledger and
  // the DingTalk card/person-delivery ledger all use it. `lockKey` used to be optional with ONE shared
  // default, and every consumer took the default. So in a Redis-leader deployment they all contended
  // for the same key: whichever booted first became leader, and every OTHER sweep became a PERMANENT
  // FOLLOWER that never swept. Owner reproduced it — start group + card together and the card sweep
  // never runs. That failure is invisible: a sweep that never runs looks just like one with nothing to do.

  it('P2: DIFFERENT sweeps with DISTINCT keys BOTH become leader and BOTH sweep (they must not starve each other)', async () => {
    const store = new Map() // ONE Redis, as in production
    const groupSweep = vi.fn().mockResolvedValue(3)
    const cardSweep = vi.fn().mockResolvedValue(5)

    const group = new LedgerRetentionScheduler({
      service: { sweep: groupSweep },
      leaderOptions: {
        leaderLock: new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) }),
        lockKey: 'ledger-retention:dingtalk-group-deliveries:leader',
        ownerId: 'proc-1:group',
        ttlMs: 30_000,
      },
    })
    const card = new LedgerRetentionScheduler({
      service: { sweep: cardSweep },
      leaderOptions: {
        leaderLock: new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) }),
        lockKey: 'ledger-retention:dingtalk-card-person-deliveries:leader',
        ownerId: 'proc-1:card',
        ttlMs: 30_000,
      },
    })
    await Promise.all([group.ready, card.ready])

    // RED-before (give them the same key, as the shipped default did): `card.leader` is false and
    // cardSweep is NEVER called — the card/person retention sweep silently never runs.
    expect(group.leader).toBe(true)
    expect(card.leader).toBe(true)
    expect(await group.tick()).toBe(3)
    expect(await card.tick()).toBe(5)
    expect(groupSweep).toHaveBeenCalledTimes(1)
    expect(cardSweep).toHaveBeenCalledTimes(1)
  })

  it('P2 (the bug, pinned): two DIFFERENT sweeps forced onto the SAME key starve one another — which is why the key is now required and unique', async () => {
    const store = new Map()
    const groupSweep = vi.fn().mockResolvedValue(3)
    const cardSweep = vi.fn().mockResolvedValue(5)
    const SHARED = 'ledger-retention-scheduler:leader' // the old shipped default

    const group = new LedgerRetentionScheduler({
      service: { sweep: groupSweep },
      leaderOptions: { leaderLock: new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) }), lockKey: SHARED, ownerId: 'g', ttlMs: 30_000 },
    })
    const card = new LedgerRetentionScheduler({
      service: { sweep: cardSweep },
      leaderOptions: { leaderLock: new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) }), lockKey: SHARED, ownerId: 'c', ttlMs: 30_000 },
    })
    await Promise.all([group.ready, card.ready])

    // This documents the defect rather than the fix: sharing a key IS starvation. The production
    // guarantee is that no two sweeps can share one — enforced by the required, per-sweep `lockKey`
    // (and the constructor throw below), not by anyone remembering to pass one.
    expect(group.leader).toBe(true)
    expect(card.leader).toBe(false)
    expect(await card.tick()).toBe(0)
    expect(cardSweep).not.toHaveBeenCalled()
  })

  it('P2: leaderOptions WITHOUT a lockKey is rejected outright — a missing key must never silently become a shared one', () => {
    expect(() => new LedgerRetentionScheduler({
      service: { sweep: vi.fn().mockResolvedValue(0) },
      leaderOptions: {
        leaderLock: new RedisLeaderLock({ client: new MemoryLeaderLockClient(new Map()) }),
        ownerId: 'no-key',
        ttlMs: 30_000,
      } as never,
    })).toThrow(/lockKey is required and must be UNIQUE per sweep/)
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
