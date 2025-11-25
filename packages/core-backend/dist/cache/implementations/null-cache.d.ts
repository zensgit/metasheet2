/**
 * NullCache - No-op cache implementation
 *
 * All operations succeed immediately but don't actually store data.
 * Use cases:
 * 1. Default implementation ensuring system doesn't depend on cache
 * 2. Observing cache call patterns and frequency
 * 3. Performance baseline (zero cache overhead)
 */
import type { Cache, Result } from '../../../types/cache';
export declare class NullCache implements Cache {
    /**
     * Always returns cache miss
     */
    get<T = any>(key: string): Promise<Result<T | null>>;
    /**
     * Does nothing, immediately succeeds
     */
    set(key: string, value: any, ttl?: number): Promise<Result<void>>;
    /**
     * Does nothing, immediately succeeds
     */
    del(key: string): Promise<Result<void>>;
}
//# sourceMappingURL=null-cache.d.ts.map