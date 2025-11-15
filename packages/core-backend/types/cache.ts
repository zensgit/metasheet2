/**
 * Unified Cache interface - Foundation for all cache implementations
 *
 * This interface defines the contract for all cache implementations in the system.
 * Implementations can range from no-op (NullCache) to distributed Redis cache.
 *
 * @packageDocumentation
 */

/**
 * Result type for cache operations
 * Uses discriminated union for type-safe error handling
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error }

/**
 * Unified Cache interface
 *
 * All cache implementations must conform to this interface to ensure
 * hot-swappability through the CacheRegistry.
 *
 * @example Basic usage
 * ```typescript
 * const cache: Cache = new NullCache()
 * const result = await cache.get<UserData>('user:123')
 * if (result.ok) {
 *   console.log(result.value)
 * }
 * ```
 */
export interface Cache {
  /**
   * Get value by key
   *
   * @param key - Cache key
   * @returns Result with value if found, null if miss
   *
   * @example
   * ```typescript
   * const result = await cache.get<UserData>('user:123')
   * if (result.ok && result.value) {
   *   // Cache hit
   *   console.log(result.value.name)
   * } else if (result.ok && !result.value) {
   *   // Cache miss
   *   console.log('Not found')
   * } else {
   *   // Error
   *   console.error(result.error)
   * }
   * ```
   */
  get<T = any>(key: string): Promise<Result<T | null>>

  /**
   * Set value with optional TTL
   *
   * @param key - Cache key
   * @param value - Value to cache (will be JSON serialized)
   * @param ttl - Time to live in seconds (optional)
   * @returns Result indicating success or failure
   *
   * @example
   * ```typescript
   * const user = { id: 123, name: 'Alice' }
   * await cache.set('user:123', user, 3600) // 1 hour TTL
   * ```
   */
  set(key: string, value: any, ttl?: number): Promise<Result<void>>

  /**
   * Delete key
   *
   * @param key - Cache key to delete
   * @returns Result indicating success or failure
   *
   * @example
   * ```typescript
   * await cache.del('user:123')
   * ```
   */
  del(key: string): Promise<Result<void>>

  /**
   * Optional: Tag-based invalidation
   *
   * Allows invalidating multiple cache entries by tag.
   * Not all implementations support this feature.
   *
   * @example
   * ```typescript
   * // Set with tag
   * await cache.set('user:123', userData, 3600)
   * await cache.set('user:456', userData2, 3600)
   *
   * // Invalidate all user:* entries
   * if (cache.tags) {
   *   await cache.tags.invalidate('user')
   * }
   * ```
   */
  tags?: {
    /**
     * Invalidate all entries with given tag
     *
     * @param tag - Tag to invalidate
     * @returns Result indicating success or failure
     */
    invalidate(tag: string): Promise<Result<void>>
  }
}
