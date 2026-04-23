/**
 * AutomationScheduler leader-state gauge tests.
 *
 * Drives the scheduler through each leader transition (unconfigured →
 * leader on boot, lost lock → follower, renewal failure → relinquished)
 * and asserts the injected gauge reports the matching `state` label
 * with value=1 and the others with value=0.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationScheduler } from '../../src/multitable/automation-scheduler'
import type { AutomationRule } from '../../src/multitable/automation-executor'
import {
  MemoryLeaderLockClient,
  RedisLeaderLock,
} from '../../src/multitable/redis-leader-lock'

type StateLabel = 'leader' | 'follower' | 'relinquished'

function makeLeaderGauge() {
  const values: Record<StateLabel, number> = {
    leader: 0,
    follower: 0,
    relinquished: 0,
  }
  return {
    values,
    labels(labels: { state: StateLabel }) {
      return {
        set(v: number) {
          values[labels.state] = v
        },
      }
    },
  }
}

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

describe('AutomationScheduler — automation_scheduler_leader gauge wiring', () => {
  let sharedStore: Map<string, { value: string; expireAt: number }>

  beforeEach(() => {
    sharedStore = new Map()
  })

  it('reports state=leader when no leader options are configured (legacy boot)', async () => {
    const gauge = makeLeaderGauge()
    const scheduler = new AutomationScheduler(vi.fn(), null, {
      leaderStateGauge: gauge,
    })
    await scheduler.ready
    expect(gauge.values.leader).toBe(1)
    expect(gauge.values.follower).toBe(0)
    expect(gauge.values.relinquished).toBe(0)
    scheduler.destroy()
  })

  it('reports state=leader when acquire succeeds', async () => {
    const client = new MemoryLeaderLockClient(sharedStore)
    const lock = new RedisLeaderLock({ client })
    const gauge = makeLeaderGauge()
    const scheduler = new AutomationScheduler(
      vi.fn(),
      {
        leaderLock: lock,
        ownerId: 'node-winner',
        ttlMs: 10_000,
        renewIntervalMs: 10_000,
      },
      { leaderStateGauge: gauge },
    )
    await scheduler.ready
    expect(scheduler.leader).toBe(true)
    expect(gauge.values.leader).toBe(1)
    expect(gauge.values.follower).toBe(0)
    expect(gauge.values.relinquished).toBe(0)
    scheduler.destroy()
  })

  it('reports state=follower when another owner already holds the lock', async () => {
    sharedStore.set('automation-scheduler:leader', {
      value: 'pre-existing-owner',
      expireAt: Date.now() + 10_000,
    })
    const client = new MemoryLeaderLockClient(sharedStore)
    const lock = new RedisLeaderLock({ client })
    const gauge = makeLeaderGauge()
    const scheduler = new AutomationScheduler(
      vi.fn(),
      {
        leaderLock: lock,
        ownerId: 'node-loser',
        ttlMs: 10_000,
        renewIntervalMs: 10_000,
      },
      { leaderStateGauge: gauge },
    )
    await scheduler.ready
    expect(scheduler.leader).toBe(false)
    expect(gauge.values.follower).toBe(1)
    expect(gauge.values.leader).toBe(0)
    expect(gauge.values.relinquished).toBe(0)
    scheduler.destroy()
  })

  it('reports state=relinquished when renewal fails after leadership', async () => {
    // Custom client — set() wins, eval() (used by renew) always returns 0.
    const client = {
      async set() {
        return 'OK' as const
      },
      async get() {
        return null
      },
      async eval() {
        return 0
      },
    }
    const lock = new RedisLeaderLock({ client })
    const gauge = makeLeaderGauge()
    const scheduler = new AutomationScheduler(
      vi.fn(),
      {
        leaderLock: lock,
        ownerId: 'node-flaky',
        ttlMs: 300,
        renewIntervalMs: 50,
      },
      { leaderStateGauge: gauge },
    )
    await scheduler.ready
    expect(scheduler.leader).toBe(true)
    expect(gauge.values.leader).toBe(1)

    scheduler.register(makeIntervalRule('rule_transition', 1_000))

    // Wait for the renewal loop to tick at least once; the rejected
    // renew() should relinquish leadership.
    await new Promise((r) => setTimeout(r, 120))
    expect(scheduler.leader).toBe(false)
    expect(gauge.values.relinquished).toBe(1)
    expect(gauge.values.leader).toBe(0)
    expect(gauge.values.follower).toBe(0)
    scheduler.destroy()
  })

  it('gauge omitted → no crash (legacy callers remain supported)', async () => {
    const scheduler = new AutomationScheduler(vi.fn())
    await scheduler.ready
    expect(scheduler.leader).toBe(true)
    scheduler.destroy()
  })

  it('gauge errors are swallowed — scheduler still operates', async () => {
    const exploding = {
      labels() {
        throw new Error('registry exploded')
      },
    }
    const scheduler = new AutomationScheduler(vi.fn(), null, {
      leaderStateGauge: exploding as unknown as ReturnType<typeof makeLeaderGauge>,
    })
    await scheduler.ready
    expect(scheduler.leader).toBe(true)
    scheduler.destroy()
  })
})
