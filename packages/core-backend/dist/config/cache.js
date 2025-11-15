"use strict";
/**
 * Cache Configuration
 *
 * Environment variables:
 * - FEATURE_CACHE: Enable cache system (default: false)
 * - CACHE_IMPL: Cache implementation (default: 'null')
 * - CACHE_DEFAULT_TTL: Default TTL in seconds (default: 3600)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheConfig = void 0;
exports.cacheConfig = {
    /**
     * Enable cache system
     */
    enabled: process.env.FEATURE_CACHE === 'true',
    /**
     * Cache implementation: 'null' | 'redis' | 'memory'
     */
    implementation: process.env.CACHE_IMPL || 'null',
    /**
     * Default TTL in seconds
     */
    ttl: parseInt(process.env.CACHE_DEFAULT_TTL || '3600'),
    /**
     * Redis configuration (for future use)
     */
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD
    }
};
//# sourceMappingURL=cache.js.map