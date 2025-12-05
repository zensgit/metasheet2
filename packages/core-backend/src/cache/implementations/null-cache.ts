/**
 * NullCache - No-op cache implementation
 *
 * All operations succeed immediately but don't actually store data.
 * Use cases:
 * 1. Default implementation ensuring system doesn't depend on cache
 * 2. Observing cache call patterns and frequency
 * 3. Performance baseline (zero cache overhead)
 */

import type { Cache, Result } from '../../types/cache'

export class NullCache implements Cache {
  /**
   * Always returns cache miss
   */
  async get<T = unknown>(_key: string): Promise<Result<T | null>> {
    return { ok: true, value: null }
  }

  /**
   * Does nothing, immediately succeeds
   */
  async set(_key: string, _value: unknown, _ttl?: number): Promise<Result<void>> {
    return { ok: true, value: undefined }
  }

  /**
   * Does nothing, immediately succeeds
   */
  async del(_key: string): Promise<Result<void>> {
    return { ok: true, value: undefined }
  }
}
