/**
 * AutomationScheduler leader-lock tests.
 *
 * Two scheduler instances share one `MemoryLeaderLockClient` (backed by a
 * single `Map`). Only the first `acquire` wins; the second scheduler must
 * silently skip timer creation for the same rule.
 *
 * On TTL expiry / manual release the former leader's `register` calls
 * should stop creating timers — verified by driving the renewal path
 * manually through a small clock-advance utility.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationScheduler } from '../../src/multitable/automation-scheduler'
import type { AutomationRule } from '../../src/multitable/automation-executor'
import {
  MemoryLeaderLockClient,
  RedisLeaderLock,
} from '../../src/multitable/redis-leader-lock'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIntervalRule(id: string, intervalMs = 60_000): AutomationRule {
  return {
    id,
    name: `rule ${id}`,
    sheetId: 'sht_test',
    trigger: { type: 'schedule.interval', config: { intervalMs } },
    actions: [],
    enabled: true,
    createdBy: 'system',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('AutomationScheduler — leader lock', () => {
  let sharedStore: Map<string, { value: string; expireAt: number }>

  beforeEach(() => {
    sharedStore = new Map()
  })

  it('only the leader registers timers when two instances share the lock', async () => {
    const clientA = new MemoryLeaderLockClient(sharedStore)
    const clientB = new MemoryLeaderLockClient(sharedStore)
    const lockA = new RedisLeaderLock({ client: clientA })
    const lockB = new RedisLeaderLock({ client: clientB })

    const callbackA = vi.fn()
    const callbackB = vi.fn()

    const schedulerA = new AutomationScheduler(callbackA, {
      leaderLock: lockA,
      ownerId: 'node-A',
      ttlMs: 10_000,
      renewIntervalMs: 10_000, // keep renewal idle in this test
    })
    const schedulerB = new AutomationScheduler(callbackB, {
      leaderLock: lockB,
      ownerId: 'node-B',
      ttlMs: 10_000,
      renewIntervalMs: 10_000,
    })

    await schedulerA.ready
    await schedulerB.ready

    expect(schedulerA.leader).toBe(true)
    expect(schedulerB.leader).toBe(false)

    const rule = makeIntervalRule('rule_leader_1')
    schedulerA.register(rule)
    schedulerB.register(rule)

    expect(schedulerA.isRegistered('rule_leader_1')).toBe(true)
    expect(schedulerB.isRegistered('rule_leader_1')).toBe(false)
    expect(schedulerA.activeCount).toBe(1)
    expect(schedulerB.activeCount).toBe(0)

    schedulerA.destroy()
    schedulerB.destroy()
  })

  it('non-leader scheduler does not create timers for any schedule trigger', async () => {
    const shared = sharedStore
    // Pre-seed: something else already holds the lock.
    shared.set('automation-scheduler:leader', {
      value: 'external-owner',
      expireAt: Date.now() + 10_000,
    })

    const client = new MemoryLeaderLockClient(shared)
    const lock = new RedisLeaderLock({ client })

    const scheduler = new AutomationScheduler(vi.fn(), {
      leaderLock: lock,
      ownerId: 'loser',
      ttlMs: 10_000,
      renewIntervalMs: 10_000,
    })
    await scheduler.ready
    expect(scheduler.leader).toBe(false)

    scheduler.register(makeIntervalRule('rule_no_leader'))
    scheduler.register(
      // cron rule
      {
        ...makeIntervalRule('rule_cron'),
        trigger: { type: 'schedule.cron', config: { expression: '*/5 * * * *' } },
      },
    )
    expect(scheduler.activeCount).toBe(0)

    scheduler.destroy()
  })

  it('legacy constructor (no leader options) always acts as leader and preserves old behaviour', async () => {
    const scheduler = new AutomationScheduler(vi.fn())
    await scheduler.ready
    expect(scheduler.leader).toBe(true)
    scheduler.register(makeIntervalRule('rule_legacy', 1_000))
    expect(scheduler.isRegistered('rule_legacy')).toBe(true)
    scheduler.destroy()
  })

  it('loses leadership when renewal fails and clears all timers (relinquish on renewal failure)', async () => {
    // Client whose `eval` (used by renew) always returns 0 → renew() -> false.
    const client: ReturnType<typeof buildClient> = buildClient()

    // First acquire succeeds.
    client.set = vi.fn().mockResolvedValue('OK')
    // Renew via eval always returns 0 (not owner / missing).
    client.eval = vi.fn().mockResolvedValue(0)

    const lock = new RedisLeaderLock({ client })
    const scheduler = new AutomationScheduler(vi.fn(), {
      leaderLock: lock,
      ownerId: 'node-flaky',
      ttlMs: 300,
      renewIntervalMs: 50,
    })
    await scheduler.ready
    expect(scheduler.leader).toBe(true)

    scheduler.register(makeIntervalRule('rule_relinquish', 1_000))
    expect(scheduler.isRegistered('rule_relinquish')).toBe(true)

    // Allow the renewal loop to fire at least once.
    await new Promise((resolve) => setTimeout(resolve, 120))

    // After renewal returns 0, the scheduler must have relinquished.
    expect(scheduler.leader).toBe(false)
    expect(scheduler.activeCount).toBe(0)

    scheduler.destroy()
  })
})

function buildClient(): {
  set: (key: string, value: string, ...args: (string | number)[]) => Promise<string | null>
  get: (key: string) => Promise<string | null>
  eval: (
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ) => Promise<unknown>
} {
  return {
    async set() {
      return 'OK'
    },
    async get() {
      return null
    },
    async eval() {
      return 0
    },
  }
}
