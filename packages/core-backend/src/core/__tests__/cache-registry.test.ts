import { describe, it, expect } from 'vitest'
import { cacheRegistry, CacheRegistry } from '../../../core/cache/CacheRegistry'

describe('CacheRegistry', () => {
  it('provides access to cache implementation via singleton', async () => {
    // Singleton is created once on import; test the actual instance
    const registry = cacheRegistry
    const status = registry.getStatus()
    // The singleton is initialized; verify it has a valid implementation name
    expect(status.implName).toBeDefined()
    expect(['NullCache', 'MemoryCache', 'RedisCache']).toContain(status.implName)
  })

  it('provides status information', async () => {
    const status = cacheRegistry.getStatus()
    expect(status).toHaveProperty('enabled')
    expect(status).toHaveProperty('implName')
    expect(status).toHaveProperty('stats')
    expect(status.stats).toHaveProperty('hits')
    expect(status.stats).toHaveProperty('misses')
    expect(status.stats).toHaveProperty('errors')
  })

  it('returns a Cache instance from get()', async () => {
    const cache = cacheRegistry.get()
    expect(cache).toBeDefined()
    // Verify cache has required methods
    expect(typeof cache.get).toBe('function')
    expect(typeof cache.set).toBe('function')
    expect(typeof cache.del).toBe('function')
  })
})

