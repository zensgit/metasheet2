/**
 * Cache Module - Phase 1: Observation Infrastructure
 *
 * Provides cache abstraction with metrics collection.
 * Phase 1 focuses on observation without changing business logic.
 *
 * Usage:
 * ```typescript
 * import { cache } from './cache'
 *
 * // Get from cache
 * const result = await cache.get<User>('user:123')
 * if (result.ok && result.value) {
 *   // Cache hit
 * }
 *
 * // Set to cache
 * await cache.set('user:123', userData, 3600)
 * ```
 */

export { CacheRegistry } from './registry'
export { NullCache } from './implementations/null-cache'
export { cacheMetrics } from './metrics'

// Re-export types
export type { Cache, Result } from '../types/cache'

// Create and export default cache instance
import { CacheRegistry } from './registry'
import { NullCache } from './implementations/null-cache'

// Default: NullCache (safe, no-op)
const cacheRegistry = new CacheRegistry(new NullCache())
cacheRegistry.register('null', new NullCache())

export const cache = cacheRegistry
