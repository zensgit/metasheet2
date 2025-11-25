import { Cache, Result } from '../../src/types/cache'
import { metrics } from '../../src/metrics/metrics'

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
export class NullCache implements Cache {
  /**
   * Always returns null (cache miss)
   * Records cache_miss_total metric
   */
  async get<T>(key: string): Promise<Result<T | null>> {
    // Record miss metric with key pattern
    const keyPattern = this.extractKeyPattern(key)
    metrics.cache_miss_total.inc({ impl: 'null', key_pattern: keyPattern })

    // Always miss - no caching
    return { ok: true, value: null }
  }

  /**
   * No-op set operation
   * Records cache_set_total metric
   */
  async set(key: string, value: any, ttl?: number): Promise<Result<void>> {
    // Record set metric with key pattern
    const keyPattern = this.extractKeyPattern(key)
    metrics.cache_set_total.inc({ impl: 'null', key_pattern: keyPattern })

    // No-op - don't store anything
    return { ok: true, value: undefined }
  }

  /**
   * No-op delete operation
   * Records cache_del_total metric
   */
  async del(key: string): Promise<Result<void>> {
    // Record del metric with key pattern
    const keyPattern = this.extractKeyPattern(key)
    metrics.cache_del_total.inc({ impl: 'null', key_pattern: keyPattern })

    // No-op - nothing to delete
    return { ok: true, value: undefined }
  }

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
  private extractKeyPattern(key: string): string {
    const parts = key.split(':')
    return parts[0] || 'unknown'
  }
}
