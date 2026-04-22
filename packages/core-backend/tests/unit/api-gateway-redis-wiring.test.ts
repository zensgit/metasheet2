/**
 * Integration between APIGateway and RedisCircuitBreakerStore.
 *
 * These tests don't spin up a real Redis — we inject a mock client via
 * the `clientFactory` escape hatch on `initRedisCircuitBreakerStore()`.
 * The assertion is about wiring: once the flag is on and Redis returns
 * a connected client, every breaker registered after `init…()` must
 * report the Redis-backed store via its test-hook accessor. When the
 * flag is off (or Redis is unavailable), the breaker must fall back to
 * the legacy in-process path (store === null).
 */

import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APIGateway } from '../../src/gateway/APIGateway'
import { RedisCircuitBreakerStore } from '../../src/gateway/redis-circuit-breaker-store'

function minimalRedisShim(): unknown {
  // Only the methods `RedisCircuitBreakerStore` touches during tests.
  return {
    evalsha: vi.fn(),
    eval: vi.fn(),
    script: vi.fn(),
    hmget: vi.fn(),
  }
}

function buildGateway(): APIGateway {
  const app = express()
  return new APIGateway(app, {
    basePath: '/test',
    enableCircuitBreaker: true,
    enableMetrics: false,
    enableLogging: false,
    enableCors: false,
  })
}

describe('APIGateway — Redis CircuitBreaker wiring', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE
    delete process.env.DISABLE_REDIS_CIRCUIT_BREAKER_STORE
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('uses memory store when feature flag is unset (default behaviour)', async () => {
    const gateway = buildGateway()
    const activated = await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => minimalRedisShim(),
    })
    expect(activated).toBe(false)
    expect(gateway.getCircuitBreakerStoreForTest()).toBeNull()

    gateway.registerEndpoint({
      method: 'POST',
      path: '/orders',
      authentication: 'none',
      circuitBreaker: true,
      handler: (_req, res) => {
        res.json({ ok: true })
      },
    })

    // Access private map for assertion via unknown cast — only place we
    // cross the visibility boundary in this test file.
    const breakers = (gateway as unknown as {
      circuitBreakers: Map<string, { getStoreForTest(): unknown }>
    }).circuitBreakers
    const breaker = breakers.get('POST:/orders')
    expect(breaker).toBeDefined()
    expect(breaker!.getStoreForTest()).toBeNull()

    gateway.destroy()
  })

  it('uses RedisCircuitBreakerStore when flag is on and Redis returns a connected client', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'

    const gateway = buildGateway()
    const activated = await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => minimalRedisShim(),
    })
    expect(activated).toBe(true)

    const store = gateway.getCircuitBreakerStoreForTest()
    expect(store).toBeInstanceOf(RedisCircuitBreakerStore)

    gateway.registerEndpoint({
      method: 'POST',
      path: '/orders',
      authentication: 'none',
      circuitBreaker: true,
      handler: (_req, res) => {
        res.json({ ok: true })
      },
    })

    const breakers = (gateway as unknown as {
      circuitBreakers: Map<string, { getStoreForTest(): unknown }>
    }).circuitBreakers
    const breaker = breakers.get('POST:/orders')
    expect(breaker).toBeDefined()
    expect(breaker!.getStoreForTest()).toBe(store)

    gateway.destroy()
  })

  it('falls back to memory when Redis client factory returns null (flag on, Redis unavailable)', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'

    const gateway = buildGateway()
    const activated = await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => null,
    })
    expect(activated).toBe(false)
    expect(gateway.getCircuitBreakerStoreForTest()).toBeNull()

    gateway.registerEndpoint({
      method: 'POST',
      path: '/orders',
      authentication: 'none',
      circuitBreaker: true,
      handler: (_req, res) => {
        res.json({ ok: true })
      },
    })

    const breakers = (gateway as unknown as {
      circuitBreakers: Map<string, { getStoreForTest(): unknown }>
    }).circuitBreakers
    const breaker = breakers.get('POST:/orders')
    expect(breaker!.getStoreForTest()).toBeNull()

    gateway.destroy()
  })

  it('DISABLE flag overrides ENABLE (emergency kill switch)', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'
    process.env.DISABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'

    const gateway = buildGateway()
    const activated = await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => minimalRedisShim(),
    })
    expect(activated).toBe(false)
    expect(gateway.getCircuitBreakerStoreForTest()).toBeNull()

    gateway.destroy()
  })

  it('swallows Redis factory errors and falls back to memory (startup must not block)', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'

    const gateway = buildGateway()
    const activated = await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(activated).toBe(false)
    expect(gateway.getCircuitBreakerStoreForTest()).toBeNull()

    gateway.destroy()
  })

  it('ignores breakers for endpoints without circuitBreaker flag, flag on', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'

    const gateway = buildGateway()
    await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => minimalRedisShim(),
    })

    gateway.registerEndpoint({
      method: 'GET',
      path: '/ping',
      authentication: 'none',
      circuitBreaker: false,
      handler: (_req, res) => {
        res.json({ ok: true })
      },
    })

    const breakers = (gateway as unknown as {
      circuitBreakers: Map<string, unknown>
    }).circuitBreakers
    expect(breakers.get('GET:/ping')).toBeUndefined()

    gateway.destroy()
  })
})
