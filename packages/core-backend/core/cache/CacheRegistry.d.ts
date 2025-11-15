import { Cache } from '../../types/cache';
/**
 * Singleton managing active cache implementation
 *
 * CacheRegistry provides a central point for cache implementation management:
 * - Starts with NullCache (observability only)
 * - Supports runtime switching to other implementations (e.g., RedisCache)
 * - Tracks cache statistics for monitoring
 * - Provides status information for debugging
 *
 * **Design Pattern**: Singleton
 * - Single instance throughout application lifecycle
 * - Global access via getInstance()
 * - Thread-safe (Node.js single-threaded)
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
 * console.log(status.implName) // "NullCache" or "RedisCache"
 * console.log(status.stats.hits) // Total hits since startup
 * ```
 */
export declare class CacheRegistry {
    private static instance;
    /**
     * Currently active cache implementation
     * @private
     */
    private current;
    /**
     * Name of current implementation
     * @private
     */
    private implName;
    /**
     * Cache statistics
     * @private
     */
    private stats;
    /**
     * Private constructor (Singleton pattern)
     * @private
     */
    private constructor();
    /**
     * Get or create singleton instance
     *
     * @returns The singleton CacheRegistry instance
     */
    static getInstance(): CacheRegistry;
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
    register(impl: Cache, name: string): void;
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
    get(): Cache;
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
    getStatus(): {
        /** Whether cache is actually caching (false for NullCache) */
        enabled: boolean;
        /** Current implementation name */
        implName: string;
        /** Copy of current statistics */
        stats: {
            /** When the current implementation was registered */
            registeredAt: Date;
            /** Total cache hits recorded */
            hits: number;
            /** Total cache misses recorded */
            misses: number;
            /** Total errors encountered */
            errors: number;
        };
    };
    /**
     * Record a cache hit
     * Called by cache implementations on successful get()
     * @internal
     */
    recordHit(): void;
    /**
     * Record a cache miss
     * Called by cache implementations on get() returning null
     * @internal
     */
    recordMiss(): void;
    /**
     * Record a cache error
     * Called by cache implementations on any error
     * @internal
     */
    recordError(): void;
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
export declare const cacheRegistry: CacheRegistry;
//# sourceMappingURL=CacheRegistry.d.ts.map