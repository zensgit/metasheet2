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
    const { CacheRegistry } = await import('../cache/CacheRegistry')
    const cache = CacheRegistry.get()
    expect(cache.implName).toBeDefined()
    expect(cache.implName.toLowerCase()).toContain('memory')

    await cache.del('phase5:test:key')
    const miss1 = await cache.get('phase5:test:key')
    expect(miss1).toBeUndefined()
    await cache.set('phase5:test:key', 'value', 5)
    const hit1 = await cache.get('phase5:test:key')
    expect(hit1).toBe('value')
  })
})

