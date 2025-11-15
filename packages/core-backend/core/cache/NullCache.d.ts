import { Cache, Result } from '../../types/cache';
/**
 * No-op cache implementation for observability
 *
 * NullCache implements the Cache interface but performs no actual caching.
 * All operations immediately return without storing data.
 *
 * **Purpose**: Phase 1 observability
 * - Records metrics to understand cache access patterns
 * - Provides baseline for cache hit/miss analysis
 * - Zero production impact (no behavior changes)
 *
 * **Metrics recorded**:
 * - cache_miss_total: Every get() call (always miss)
 * - cache_set_total: Every set() call
 * - cache_del_total: Every del() call
 *
 * @example
 * ```typescript
 * const cache = new NullCache()
 * await cache.set('key', 'value') // No-op, but metrics recorded
 * const result = await cache.get('key') // Always returns null
 * ```
 */
export declare class NullCache implements Cache {
    /**
     * Always returns null (cache miss)
     * Records cache_miss_total metric
     */
    get<T>(key: string): Promise<Result<T | null>>;
    /**
     * No-op set operation
     * Records cache_set_total metric
     */
    set(key: string, value: any, ttl?: number): Promise<Result<void>>;
    /**
     * No-op delete operation
     * Records cache_del_total metric
     */
    del(key: string): Promise<Result<void>>;
    /**
     * Extract key pattern for metrics grouping
     *
     * Examples:
     * - "user:123" → "user"
     * - "session:abc:data" → "session"
     * - "simple" → "simple"
     *
     * @private
     */
    private extractKeyPattern;
}
//# sourceMappingURL=NullCache.d.ts.map