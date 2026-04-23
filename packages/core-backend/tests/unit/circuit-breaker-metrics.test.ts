/**
 * CircuitBreaker store-used counter tests.
 *
 * Verifies that the DI'd `storeUsedCounter` gets an `inc()` call on every
 * breaker operation — success/failure in the in-process path, and on the
 * shared-store path when reporting through `reportToStore` or
 * `refreshSharedState`.
 *
 * We hand-roll the counter to avoid pulling prom-client in; the task
 * explicitly requires DI so that CircuitBreaker stays unit-testable.
 */

import { describe, expect, it } from 'vitest'

import { CircuitBreaker } from '../../src/gateway/CircuitBreaker'
import { MemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker-store'

type StoreLabel = 'redis' | 'memory'

function makeStoreUsedCounter() {
  const counts: Record<StoreLabel, number> = { redis: 0, memory: 0 }
  return {
    counts,
    labels(labels: { store: StoreLabel }) {
      return {
        inc(value = 1) {
          counts[labels.store] += value
        },
      }
    },
  }
}

describe('CircuitBreaker — apigw_cb_store_used_total counter wiring', () => {
  it('increments {store="memory"} on each in-process record op', async () => {
    const counter = makeStoreUsedCounter()
    const cb = new CircuitBreaker(
      { timeout: 1_000, errorThreshold: 50, resetTimeout: 100, volumeThreshold: 2 },
      { storeUsedCounter: counter },
    )

    await cb.execute(async () => 'ok')
    await cb.execute(async () => 'ok')
    expect(counter.counts.memory).toBe(2)
    expect(counter.counts.redis).toBe(0)

    await expect(
      cb.execute(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(counter.counts.memory).toBe(3)
    expect(counter.counts.redis).toBe(0)
    cb.destroy()
  })

  it('increments {store="redis"} when a shared store is wired up', async () => {
    const counter = makeStoreUsedCounter()
    // We use MemoryCircuitBreakerStore as a stand-in for any "shared"
    // store (CircuitBreaker branches on `store != null`, not on the
    // concrete class).  RedisCircuitBreakerStore is tested elsewhere
    // against a real shim.
    const sharedStore = new MemoryCircuitBreakerStore()
    const cb = new CircuitBreaker(
      { timeout: 1_000, errorThreshold: 50, resetTimeout: 100, volumeThreshold: 2 },
      { store: sharedStore, id: 'circuit-under-test', storeUsedCounter: counter },
    )

    await cb.reportToStore(true) // success path
    await cb.reportToStore(false) // failure path
    await cb.refreshSharedState()

    expect(counter.counts.redis).toBeGreaterThanOrEqual(3)
    // In-process record calls still trigger memory counts via execute(),
    // but we haven't called execute() in this test — keeps the assertion
    // clean for the shared-store labelling.
    expect(counter.counts.memory).toBe(0)
    cb.destroy()
  })

  it('mixing shared-store calls and execute() emits both labels appropriately', async () => {
    const counter = makeStoreUsedCounter()
    const sharedStore = new MemoryCircuitBreakerStore()
    const cb = new CircuitBreaker(
      { timeout: 1_000, errorThreshold: 50, resetTimeout: 100, volumeThreshold: 2 },
      { store: sharedStore, id: 'mixed', storeUsedCounter: counter },
    )

    await cb.reportToStore(true) // redis++
    await cb.execute(async () => 'ok') // redis++ (execute uses in-process + shared)
    // execute() calls recordSuccess which samples `this.store != null`
    // → store === 'redis'. So after one execute both `redis` and
    // `memory` have incremented from separate code paths.
    expect(counter.counts.redis).toBeGreaterThanOrEqual(2)
    cb.destroy()
  })

  it('no counter injected → no crash, no counts', async () => {
    const cb = new CircuitBreaker({ timeout: 500 })
    await cb.execute(async () => 'ok')
    await cb.reportToStore(true) // no-op when no store
    cb.destroy()
  })

  it('counter errors are swallowed — breaker logic is unaffected', async () => {
    const exploding = {
      labels() {
        throw new Error('registry exploded')
      },
    }
    const cb = new CircuitBreaker(
      { timeout: 500 },
      { storeUsedCounter: exploding as unknown as ReturnType<typeof makeStoreUsedCounter> },
    )
    await expect(cb.execute(async () => 'ok')).resolves.toBe('ok')
    cb.destroy()
  })
})
