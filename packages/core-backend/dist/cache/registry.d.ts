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
import type { Cache, Result } from '../../types/cache';
export declare class CacheRegistry implements Cache {
    private activeCache;
    private implementations;
    private metrics;
    constructor(defaultImpl: Cache);
    /**
     * Register a cache implementation
     *
     * @param name - Implementation name (e.g., 'null', 'redis', 'memory')
     * @param implementation - Cache implementation instance
     */
    register(name: string, implementation: Cache): void;
    /**
     * Switch to a different cache implementation
     *
     * @param name - Name of registered implementation
     * @returns true if switch successful, false if implementation not found
     */
    switchTo(name: string): boolean;
    /**
     * Get value by key with metrics
     */
    get<T = any>(key: string): Promise<Result<T | null>>;
    /**
     * Set value with metrics
     */
    set(key: string, value: any, ttl?: number): Promise<Result<void>>;
    /**
     * Delete key with metrics
     */
    del(key: string): Promise<Result<void>>;
    /**
     * Get current active implementation name
     */
    getCurrentImplementation(): string;
    /**
     * Get all registered implementation names
     */
    getRegisteredImplementations(): string[];
}
//# sourceMappingURL=registry.d.ts.map