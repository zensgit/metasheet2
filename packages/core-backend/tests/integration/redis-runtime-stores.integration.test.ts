import Redis from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { CircuitState } from '../../src/gateway/CircuitBreaker'
import {
  RedisCircuitBreakerStore,
  type RedisCircuitClient,
} from '../../src/gateway/redis-circuit-breaker-store'
import {
  RedisTokenBucketStore,
  type RedisScriptClient,
} from '../../src/integration/rate-limiting/redis-token-bucket-store'
import {
  RedisLeaderLock,
  type RedisLeaderLockClient,
} from '../../src/multitable/redis-leader-lock'

const redisUrl = process.env.REDIS_URL
const describeIfRedis = redisUrl ? describe : describe.skip

describeIfRedis('Redis runtime stores live smoke', () => {
  let redis: Redis
  let prefix: string

  beforeAll(async () => {
    redis = new Redis(redisUrl!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
    await redis.connect()
    await redis.ping()
  })

  afterEach(async () => {
    if (!redis || !prefix) return
    const keys = await redis.keys(`${prefix}*`)
    if (keys.length) await redis.del(...keys)
  })

  afterAll(async () => {
    await redis?.quit()
  })

  it('executes token bucket Lua against a real Redis server and recovers after SCRIPT FLUSH', async () => {
    prefix = `ms2:tb:${Date.now()}:${Math.random().toString(16).slice(2)}:`
    const store = new RedisTokenBucketStore({
      redis: redis as RedisScriptClient,
      keyPrefix: prefix,
      ttlSeconds: 60,
    })

    await expect(store.consume('user-a', 2, 0, 1)).resolves.toMatchObject({
      allowed: true,
      tokensRemaining: 1,
    })
    await expect(store.consume('user-a', 2, 0, 1)).resolves.toMatchObject({
      allowed: true,
      tokensRemaining: 0,
    })
    await expect(store.consume('user-a', 2, 0, 1)).resolves.toMatchObject({
      allowed: false,
      retryAfterMs: -1,
    })
    await expect(redis.ttl(`${prefix}user-a`)).resolves.toBeGreaterThan(0)

    await redis.script('FLUSH')
    await expect(store.consume('user-b', 1, 0, 1)).resolves.toMatchObject({
      allowed: true,
      tokensRemaining: 0,
    })
  })

  it('executes circuit-breaker Lua against a real Redis server and recovers after SCRIPT FLUSH', async () => {
    prefix = `ms2:cb:${Date.now()}:${Math.random().toString(16).slice(2)}:`
    const store = new RedisCircuitBreakerStore({
      redis: redis as RedisCircuitClient,
      keyPrefix: prefix,
      ttlSeconds: 60,
    })
    const thresholds = {
      errorThreshold: 50,
      volumeThreshold: 3,
      windowSizeMs: 10_000,
      resetTimeoutMs: 2_000,
    }

    await store.recordFailure('svc-a', thresholds)
    await store.recordFailure('svc-a', thresholds)
    const opened = await store.recordFailure('svc-a', thresholds)
    expect(opened.state).toBe(CircuitState.OPEN)
    expect(opened.windowRequests).toBe(3)
    expect(opened.windowFailures).toBe(3)
    await expect(redis.ttl(`${prefix}svc-a`)).resolves.toBeGreaterThan(0)

    await redis.script('FLUSH')
    const afterFlush = await store.checkAndUpdate('svc-a', thresholds)
    expect(afterFlush.state).toBe(CircuitState.OPEN)
    expect(afterFlush.windowFailures).toBe(3)
  })

  it('executes owner-scoped leader lock operations against a real Redis server', async () => {
    prefix = `ms2:leader:${Date.now()}:${Math.random().toString(16).slice(2)}:`
    const lockKey = `${prefix}scheduler`
    const lock = new RedisLeaderLock({
      client: redis as unknown as RedisLeaderLockClient,
    })

    await expect(lock.acquire(lockKey, 'node-a', 5_000)).resolves.toBe(true)
    await expect(lock.acquire(lockKey, 'node-b', 5_000)).resolves.toBe(false)
    await expect(lock.isHeldBy(lockKey, 'node-a')).resolves.toBe(true)

    await expect(lock.renew(lockKey, 'node-b', 5_000)).resolves.toBe(false)
    await expect(lock.renew(lockKey, 'node-a', 5_000)).resolves.toBe(true)

    await expect(lock.release(lockKey, 'node-b')).resolves.toBe(false)
    await expect(lock.isHeldBy(lockKey, 'node-a')).resolves.toBe(true)

    await expect(lock.release(lockKey, 'node-a')).resolves.toBe(true)
    await expect(lock.acquire(lockKey, 'node-b', 5_000)).resolves.toBe(true)
    await expect(lock.isHeldBy(lockKey, 'node-b')).resolves.toBe(true)
  })
})
