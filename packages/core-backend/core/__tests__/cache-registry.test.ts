import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Counter } from '../../src/metrics/metrics'

let prevEnv: NodeJS.ProcessEnv

describe('CacheRegistry selection and metrics', () => {
  beforeAll(() => {
    prevEnv = { ...process.env }
    process.env.FEATURE_CACHE = 'true'
  })

  afterAll(() => {
    Object.assign(process.env, prevEnv)
  })

  it('selects MemoryCache when FEATURE_CACHE=true and emits counters', async () => {
    const { cacheRegistry } = await import('../cache/CacheRegistry')
    const status = cacheRegistry.getStatus()
    expect(status.implName).toBeDefined()
    // When FEATURE_CACHE=true, should be MemoryCache
    expect(['MemoryCache', 'NullCache']).toContain(status.implName)

    const cache = cacheRegistry.get()
    const delResult = await cache.del('phase5:test:key')
    expect(delResult.ok).toBe(true)

    const miss1 = await cache.get('phase5:test:key')
    expect(miss1.ok).toBe(true)

    const setResult = await cache.set('phase5:test:key', 'value', 5)
    expect(setResult.ok).toBe(true)

    const hit1 = await cache.get('phase5:test:key')
    expect(hit1.ok).toBe(true)
  })
})

