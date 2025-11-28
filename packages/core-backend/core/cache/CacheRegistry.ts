import { Cache } from '../../src/types/cache'
import { NullCache } from '../../src/cache/implementations/null-cache'
import { MemoryCache } from '../../src/cache/implementations/memory-cache'
import { metrics } from '../../src/metrics/metrics'

/**
 * Singleton managing active cache implementation
 *
 * CacheRegistry provides a central point for cache implementation management:
 * - Starts with NullCache (observability only) or MemoryCache (when FEATURE_CACHE=true)
 * - Supports runtime switching to other implementations (e.g., RedisCache)
 * - Tracks cache statistics for monitoring
 * - Provides status information for debugging
 *
 * **Design Pattern**: Singleton
 * - Single instance throughout application lifecycle
 * - Global access via getInstance()
 * - Thread-safe (Node.js single-threaded)
 *
 * **Environment Configuration**:
 * - FEATURE_CACHE=true: Use MemoryCache (real caching with metrics)
 * - FEATURE_CACHE=false or unset: Use NullCache (observability only)
 *
 * **Hot-Swapping**:
 * Implementations can be registered at any time:
 * ```typescript
 * // Phase 1: NullCache (default)
 * const cache = cacheRegistry.get() // NullCache
 *
 * // Phase 3: Switch to Redis
 * cacheRegistry.register(new RedisCache(config), 'RedisCache')
 * const cache = cacheRegistry.get() // RedisCache
 * ```
 *
 * @example Basic usage
 * ```typescript
 * import { cacheRegistry } from './core/cache/CacheRegistry'
 *
 * const cache = cacheRegistry.get()
 * await cache.set('key', 'value')
 * ```
 *
 * @example Status inspection
 * ```typescript
 * const status = cacheRegistry.getStatus()
 * console.log(status.implName) // "NullCache" or "MemoryCache"
 * console.log(status.stats.hits) // Total hits since startup
 * ```
 */
export class CacheRegistry {
  private static instance: CacheRegistry

  /**
   * Currently active cache implementation
   * @private
   */
  private current: Cache

  /**
   * Name of current implementation
   * @private
   */
  private implName: string

  /**
   * Cache statistics
   * @private
   */
  private stats = {
    /** When the current implementation was registered */
    registeredAt: new Date(),
    /** Total cache hits recorded */
    hits: 0,
    /** Total cache misses recorded */
    misses: 0,
    /** Total errors encountered */
    errors: 0
  }

  /**
   * Private constructor (Singleton pattern)
   * Initializes cache based on FEATURE_CACHE environment variable
   * @private
   */
  private constructor() {
    // Check environment for cache enablement
    const featureCache = process.env.FEATURE_CACHE === 'true'

    if (featureCache) {
      const impl = (process.env.CACHE_IMPL || 'memory').toLowerCase()
      if (impl === 'redis') {
        // Direct import (project ships redis adapter); fall back gracefully
        try {
          const { RedisCache } = require('../../src/cache/implementations/redis-cache')
          this.current = new RedisCache(process.env.REDIS_URL)
          this.implName = 'RedisCache'
          try {
            const redacted = (process.env.REDIS_URL || '').replace(/:\/\/[A-Za-z0-9_-]+:(.*?)@/, '://***:***@')
            console.log('[CacheRegistry] Initialized with RedisCache url=' + redacted)
          } catch {
            console.log('[CacheRegistry] Initialized with RedisCache')
          }
        } catch (e) {
          this.current = new MemoryCache()
          this.implName = 'MemoryCache'
          console.warn('[CacheRegistry] Redis init failed; falling back to MemoryCache:', e?.message || e)
        }
      } else {
        this.current = new MemoryCache()
        this.implName = 'MemoryCache'
      }
      if (this.implName === 'MemoryCache') {
        console.log('[CacheRegistry] Initialized with MemoryCache (FEATURE_CACHE=true)')
      }
      // Set cache_enabled gauge
      try {
        const implLabel = this.implName.toLowerCase().includes('redis') ? 'redis' : 'memory'
        metrics.cache_enabled.set({ impl: implLabel }, 1)
      } catch (e) {
        // Ignore metric errors during initialization
      }
    } else {
      this.current = new NullCache()
      this.implName = 'NullCache'
      console.log('[CacheRegistry] Initialized with NullCache (FEATURE_CACHE not set)')
      // Set cache_enabled gauge
      try {
        metrics.cache_enabled.set({ impl: 'null' }, 0)
      } catch (e) {
        // Ignore metric errors during initialization
      }
    }
  }

  /**
   * Get or create singleton instance
   *
   * @returns The singleton CacheRegistry instance
   */
  static getInstance(): CacheRegistry {
    if (!this.instance) {
      this.instance = new CacheRegistry()
    }
    return this.instance
  }

  /**
   * Register a new cache implementation
   *
   * Replaces the current implementation with a new one.
   * This operation is immediate and affects all subsequent cache operations.
   *
   * **When to call**:
   * - Phase 1: Never (NullCache is default)
   * - Phase 3: On startup when FEATURE_CACHE_REDIS=true
   * - Plugin activation: When cache plugin loads
   *
   * @param impl - Cache implementation to register
   * @param name - Human-readable name for logging and status
   *
   * @example
   * ```typescript
   * // In plugin activation
   * const redisCache = new RedisCache(config)
   * await redisCache.connect()
   * cacheRegistry.register(redisCache, 'RedisCache')
   * ```
   */
  register(impl: Cache, name: string): void {
    this.current = impl
    this.implName = name
    this.stats.registeredAt = new Date()

    // Reset stats on implementation change
    this.stats.hits = 0
    this.stats.misses = 0
    this.stats.errors = 0

    console.log(`[CacheRegistry] Switched to: ${name}`)
    // Update cache_enabled gauge
    try {
      const implLabel = name.toLowerCase().includes('memory') ? 'memory' : name.toLowerCase()
      metrics.cache_enabled.set({ impl: implLabel }, name === 'NullCache' ? 0 : 1)
    } catch {}
  }

  /**
   * Get current active cache implementation
   *
   * This is the primary method used by application code to access cache.
   *
   * @returns Current cache implementation
   *
   * @example
   * ```typescript
   * const cache = cacheRegistry.get()
   * const result = await cache.get('user:123')
   * ```
   */
  get(): Cache {
    return this.current
  }

  /**
   * Get registry status for monitoring and debugging
   *
   * Used by /internal/cache endpoint to provide runtime status.
   *
   * @returns Status object with implementation details and statistics
   *
   * @example
   * ```typescript
   * const status = cacheRegistry.getStatus()
   * console.log(`Cache: ${status.implName} (enabled: ${status.enabled})`)
   * console.log(`Hit rate: ${status.stats.hits / (status.stats.hits + status.stats.misses)}`)
   * ```
   */
  getStatus() {
    return {
      /** Whether cache is actually caching (false for NullCache) */
      enabled: this.implName !== 'NullCache',
      /** Current implementation name */
      implName: this.implName,
      /** Copy of current statistics */
      stats: { ...this.stats }
    }
  }

  /**
   * Record a cache hit
   * Called by cache implementations on successful get()
   * @internal
   */
  recordHit(): void {
    this.stats.hits++
  }

  /**
   * Record a cache miss
   * Called by cache implementations on get() returning null
   * @internal
   */
  recordMiss(): void {
    this.stats.misses++
  }

  /**
   * Record a cache error
   * Called by cache implementations on any error
   * @internal
   */
  recordError(): void {
    this.stats.errors++
  }
}

/**
 * Singleton instance for application-wide cache access
 *
 * Import and use this instance throughout the application:
 * ```typescript
 * import { cacheRegistry } from './core/cache/CacheRegistry'
 *
 * const cache = cacheRegistry.get()
 * ```
 *
 * @example
 * ```typescript
 * // In any service
 * import { cacheRegistry } from '../core/cache/CacheRegistry'
 *
 * export class UserService {
 *   async getUser(id: string) {
 *     const cache = cacheRegistry.get()
 *     const cached = await cache.get(`user:${id}`)
 *
 *     if (cached.ok && cached.value) {
 *       return cached.value
 *     }
 *
 *     // Fetch from DB and cache
 *     const user = await db.users.findOne(id)
 *     await cache.set(`user:${id}`, user, 3600)
 *     return user
 *   }
 * }
 * ```
 */
export const cacheRegistry = CacheRegistry.getInstance()
