/**
 * Unit tests for RedisLeaderLock.
 *
 * We exercise the helper against the pure-JS `MemoryLeaderLockClient`
 * twin that mirrors the SET NX PX + owner-scoped Lua semantics. The same
 * store instance is reused across multiple helper invocations to emulate
 * "two processes sharing one Redis" scenarios.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MemoryLeaderLockClient,
  RedisLeaderLock,
  LEADER_RENEW_LUA,
  LEADER_RELEASE_LUA,
} from '../../src/multitable/redis-leader-lock'

describe('MemoryLeaderLockClient', () => {
  it('SET NX PX rejects when a non-expired entry exists', async () => {
    const client = new MemoryLeaderLockClient()
    expect(await client.set('k', 'owner-a', 'NX', 'PX', 5_000)).toBe('OK')
    expect(await client.set('k', 'owner-b', 'NX', 'PX', 5_000)).toBeNull()
  })

  it('expired entries are reclaimed on subsequent set', async () => {
    let now = 1_000_000
    const client = new MemoryLeaderLockClient(new Map(), () => now)
    expect(await client.set('k', 'owner-a', 'NX', 'PX', 500)).toBe('OK')
    now += 600
    expect(await client.set('k', 'owner-b', 'NX', 'PX', 500)).toBe('OK')
    expect(await client.get('k')).toBe('owner-b')
  })
})

describe('RedisLeaderLock (via memory twin)', () => {
  let client: MemoryLeaderLockClient
  let lock: RedisLeaderLock

  beforeEach(() => {
    client = new MemoryLeaderLockClient()
    lock = new RedisLeaderLock({ client })
  })

  describe('acquire', () => {
    it('returns true on uncontested key', async () => {
      expect(await lock.acquire('scheduler:leader', 'node-1', 5_000)).toBe(true)
    })

    it('returns false when another owner holds the lock', async () => {
      await lock.acquire('scheduler:leader', 'node-1', 5_000)
      expect(await lock.acquire('scheduler:leader', 'node-2', 5_000)).toBe(false)
    })

    it('returns false when TTL <= 0', async () => {
      expect(await lock.acquire('scheduler:leader', 'node-1', 0)).toBe(false)
    })

    it('swallows Redis errors and returns false', async () => {
      const brokenClient = {
        set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        get: vi.fn(),
        eval: vi.fn(),
      }
      const failing = new RedisLeaderLock({ client: brokenClient })
      expect(await failing.acquire('k', 'owner', 1_000)).toBe(false)
    })
  })

  describe('renew', () => {
    it('only extends the TTL if the owner matches', async () => {
      await lock.acquire('scheduler:leader', 'node-1', 5_000)
      expect(await lock.renew('scheduler:leader', 'node-1', 5_000)).toBe(true)
      expect(await lock.renew('scheduler:leader', 'node-2', 5_000)).toBe(false)
    })

    it('returns false once the lock has expired', async () => {
      let now = 1_000_000
      const memClient = new MemoryLeaderLockClient(new Map(), () => now)
      const memLock = new RedisLeaderLock({ client: memClient })

      await memLock.acquire('k', 'owner-a', 100)
      now += 200
      expect(await memLock.renew('k', 'owner-a', 100)).toBe(false)
    })

    it('rejects negative / zero TTL', async () => {
      await lock.acquire('k', 'owner', 1_000)
      expect(await lock.renew('k', 'owner', 0)).toBe(false)
    })

    it('uses the renew Lua script', () => {
      expect(LEADER_RENEW_LUA).toMatch(/pexpire/i)
      expect(LEADER_RENEW_LUA).toMatch(/ARGV\[1]/)
    })
  })

  describe('release', () => {
    it('only deletes if the owner matches', async () => {
      await lock.acquire('k', 'node-1', 5_000)
      expect(await lock.release('k', 'node-2')).toBe(false)
      expect(await lock.isHeldBy('k', 'node-1')).toBe(true)

      expect(await lock.release('k', 'node-1')).toBe(true)
      expect(await lock.isHeldBy('k', 'node-1')).toBe(false)
    })

    it('returns false when the key does not exist', async () => {
      expect(await lock.release('ghost', 'node-1')).toBe(false)
    })

    it('uses the release Lua script', () => {
      expect(LEADER_RELEASE_LUA).toMatch(/del/i)
    })
  })

  describe('isHeldBy', () => {
    it('reflects the current holder', async () => {
      expect(await lock.isHeldBy('k', 'node-1')).toBe(false)
      await lock.acquire('k', 'node-1', 5_000)
      expect(await lock.isHeldBy('k', 'node-1')).toBe(true)
      expect(await lock.isHeldBy('k', 'node-2')).toBe(false)
    })

    it('returns false once the TTL has elapsed', async () => {
      let now = 1_000_000
      const memClient = new MemoryLeaderLockClient(new Map(), () => now)
      const memLock = new RedisLeaderLock({ client: memClient })

      await memLock.acquire('k', 'node-1', 500)
      expect(await memLock.isHeldBy('k', 'node-1')).toBe(true)
      now += 600
      expect(await memLock.isHeldBy('k', 'node-1')).toBe(false)
    })
  })

  describe('multi-process simulation', () => {
    it('only the first acquirer wins; the second sees false and can only take over after release', async () => {
      const shared = new Map()
      const clientA = new MemoryLeaderLockClient(shared)
      const clientB = new MemoryLeaderLockClient(shared)
      const lockA = new RedisLeaderLock({ client: clientA })
      const lockB = new RedisLeaderLock({ client: clientB })

      expect(await lockA.acquire('scheduler', 'A', 5_000)).toBe(true)
      expect(await lockB.acquire('scheduler', 'B', 5_000)).toBe(false)

      // B attempts a renew anyway — should still fail because A owns the key.
      expect(await lockB.renew('scheduler', 'B', 5_000)).toBe(false)

      // After A releases, B can become the new leader.
      expect(await lockA.release('scheduler', 'A')).toBe(true)
      expect(await lockB.acquire('scheduler', 'B', 5_000)).toBe(true)
      expect(await lockB.isHeldBy('scheduler', 'B')).toBe(true)
      expect(await lockA.isHeldBy('scheduler', 'A')).toBe(false)
    })
  })
})
