/**
 * Cache Configuration
 *
 * Environment variables:
 * - FEATURE_CACHE: Enable cache system (default: false)
 * - CACHE_IMPL: Cache implementation (default: 'null')
 * - CACHE_DEFAULT_TTL: Default TTL in seconds (default: 3600)
 */
export declare const cacheConfig: {
    /**
     * Enable cache system
     */
    enabled: boolean;
    /**
     * Cache implementation: 'null' | 'redis' | 'memory'
     */
    implementation: string;
    /**
     * Default TTL in seconds
     */
    ttl: number;
    /**
     * Redis configuration (for future use)
     */
    redis: {
        host: string;
        port: number;
        password: string | undefined;
    };
};
//# sourceMappingURL=cache.d.ts.map