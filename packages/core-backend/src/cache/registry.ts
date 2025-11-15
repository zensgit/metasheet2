/**
 * CacheRegistry - Central cache management
 *
 * Manages multiple cache implementations with hot-swapping capability.
 * Provides unified interface with comprehensive metrics collection.
 *
 * Features:
 * - Register multiple implementations
 * - Hot-swap active implementation
 * - Automatic metrics collection
 * - Type-safe operation
 */

import type { Cache, Result } from '../../types/cache'
import { cacheMetrics } from './metrics'

export class CacheRegistry implements Cache {
  private activeCache: Cache
  private implementations: Map<string, Cache> = new Map()
  private metrics = cacheMetrics

  constructor(defaultImpl: Cache) {
    this.activeCache = defaultImpl
  }

  /**
   * Register a cache implementation
   *
   * @param name - Implementation name (e.g., 'null', 'redis', 'memory')
   * @param implementation - Cache implementation instance
   */
  register(name: string, implementation: Cache): void {
    this.implementations.set(name, implementation)
  }

  /**
   * Switch to a different cache implementation
   *
   * @param name - Name of registered implementation
   * @returns true if switch successful, false if implementation not found
   */
  switchTo(name: string): boolean {
    const impl = this.implementations.get(name)
    if (!impl) {
      return false
    }
    this.activeCache = impl
    this.metrics.switchCount.inc({ implementation: name })
    return true
  }

  /**
   * Get value by key with metrics
   */
  async get<T = any>(key: string): Promise<Result<T | null>> {
    const start = Date.now()
    const result = await this.activeCache.get<T>(key)

    // Record metrics
    this.metrics.operations.inc({
      operation: 'get',
      status: result.ok ? 'success' : 'error'
    })
    this.metrics.duration.observe(
      { operation: 'get' },
      Date.now() - start
    )

    if (result.ok && result.value !== null) {
      this.metrics.hits.inc()
    } else if (result.ok && result.value === null) {
      this.metrics.misses.inc()
    }

    return result
  }

  /**
   * Set value with metrics
   */
  async set(key: string, value: any, ttl?: number): Promise<Result<void>> {
    const start = Date.now()
    const result = await this.activeCache.set(key, value, ttl)

    this.metrics.operations.inc({
      operation: 'set',
      status: result.ok ? 'success' : 'error'
    })
    this.metrics.duration.observe(
      { operation: 'set' },
      Date.now() - start
    )

    return result
  }

  /**
   * Delete key with metrics
   */
  async del(key: string): Promise<Result<void>> {
    const start = Date.now()
    const result = await this.activeCache.del(key)

    this.metrics.operations.inc({
      operation: 'del',
      status: result.ok ? 'success' : 'error'
    })
    this.metrics.duration.observe(
      { operation: 'del' },
      Date.now() - start
    )

    return result
  }

  /**
   * Get current active implementation name
   */
  getCurrentImplementation(): string {
    for (const [name, impl] of this.implementations) {
      if (impl === this.activeCache) {
        return name
      }
    }
    return 'unknown'
  }

  /**
   * Get all registered implementation names
   */
  getRegisteredImplementations(): string[] {
    return Array.from(this.implementations.keys())
  }
}
