/**
 * APIGateway Prometheus init-outcome tests.
 *
 * We drive `initRedisCircuitBreakerStore()` through each of the three
 * outcomes (`redis_attached`, `fell_back_to_memory`, `skipped_by_flag`)
 * and assert that the injected Prometheus counter is incremented with
 * the matching `outcome` label.  The counter is a hand-rolled test
 * double — we do NOT import prom-client here because the task
 * explicitly requires DI and keeping the gateway test decoupled from a
 * live registry.
 */

import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APIGateway } from '../../src/gateway/APIGateway'

type OutcomeLabel = 'redis_attached' | 'fell_back_to_memory' | 'skipped_by_flag'

function makeOutcomeCounter() {
  const counts: Record<OutcomeLabel, number> = {
    redis_attached: 0,
    fell_back_to_memory: 0,
    skipped_by_flag: 0,
  }
  return {
    counts,
    labels(labels: { outcome: OutcomeLabel }) {
      return {
        inc(value = 1) {
          counts[labels.outcome] += value
        },
      }
    },
  }
}

function minimalRedisShim(): unknown {
  return {
    evalsha: vi.fn(),
    eval: vi.fn(),
    script: vi.fn(),
    hmget: vi.fn(),
  }
}

function buildGateway(counter: ReturnType<typeof makeOutcomeCounter>): APIGateway {
  const app = express()
  return new APIGateway(app, {
    basePath: '/test',
    enableCircuitBreaker: true,
    enableMetrics: false,
    enableLogging: false,
    enableCors: false,
    initOutcomeCounter: counter,
  })
}

describe('APIGateway — apigw_cb_init_total counter wiring', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE
    delete process.env.DISABLE_REDIS_CIRCUIT_BREAKER_STORE
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('records outcome=skipped_by_flag when feature flag is unset (default)', async () => {
    const counter = makeOutcomeCounter()
    const gateway = buildGateway(counter)
    const activated = await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => minimalRedisShim(),
    })
    expect(activated).toBe(false)
    expect(counter.counts.skipped_by_flag).toBe(1)
    expect(counter.counts.redis_attached).toBe(0)
    expect(counter.counts.fell_back_to_memory).toBe(0)
    gateway.destroy()
  })

  it('records outcome=skipped_by_flag when DISABLE kill switch is set', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'
    process.env.DISABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'
    const counter = makeOutcomeCounter()
    const gateway = buildGateway(counter)
    const activated = await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => minimalRedisShim(),
    })
    expect(activated).toBe(false)
    expect(counter.counts.skipped_by_flag).toBe(1)
    gateway.destroy()
  })

  it('records outcome=redis_attached when flag is on and client is returned', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'
    const counter = makeOutcomeCounter()
    const gateway = buildGateway(counter)
    const activated = await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => minimalRedisShim(),
    })
    expect(activated).toBe(true)
    expect(counter.counts.redis_attached).toBe(1)
    expect(counter.counts.skipped_by_flag).toBe(0)
    expect(counter.counts.fell_back_to_memory).toBe(0)
    gateway.destroy()
  })

  it('records outcome=fell_back_to_memory when client factory returns null', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'
    const counter = makeOutcomeCounter()
    const gateway = buildGateway(counter)
    const activated = await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => null,
    })
    expect(activated).toBe(false)
    expect(counter.counts.fell_back_to_memory).toBe(1)
    expect(counter.counts.redis_attached).toBe(0)
    gateway.destroy()
  })

  it('records outcome=fell_back_to_memory when client factory throws', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'
    const counter = makeOutcomeCounter()
    const gateway = buildGateway(counter)
    const activated = await gateway.initRedisCircuitBreakerStore({
      clientFactory: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(activated).toBe(false)
    expect(counter.counts.fell_back_to_memory).toBe(1)
    gateway.destroy()
  })

  it('omitting the counter entirely is a no-op (legacy callers remain supported)', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'
    const app = express()
    const gateway = new APIGateway(app, {
      basePath: '/t',
      enableCircuitBreaker: true,
      enableMetrics: false,
      enableLogging: false,
      enableCors: false,
      // no initOutcomeCounter supplied
    })
    await expect(
      gateway.initRedisCircuitBreakerStore({
        clientFactory: async () => minimalRedisShim(),
      }),
    ).resolves.toBe(true)
    gateway.destroy()
  })

  it('counter errors are swallowed and do not propagate', async () => {
    process.env.ENABLE_REDIS_CIRCUIT_BREAKER_STORE = 'true'
    const exploding = {
      labels() {
        throw new Error('registry exploded')
      },
    }
    const app = express()
    const gateway = new APIGateway(app, {
      basePath: '/t',
      enableCircuitBreaker: true,
      enableMetrics: false,
      enableLogging: false,
      enableCors: false,
      initOutcomeCounter: exploding as unknown as Parameters<typeof buildGateway>[0],
    })
    await expect(
      gateway.initRedisCircuitBreakerStore({
        clientFactory: async () => minimalRedisShim(),
      }),
    ).resolves.toBe(true)
    gateway.destroy()
  })
})
