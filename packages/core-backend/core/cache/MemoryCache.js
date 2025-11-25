import { metrics } from '../../src/metrics/metrics';
export class MemoryCache {
    store = new Map();
    /**
     * Get value by key, checking expiration
     * Records cache_hits_total or cache_miss_total metric
     */
    async get(key) {
        const keyPattern = this.extractKeyPattern(key);
        try {
            const entry = this.store.get(key);
            if (!entry) {
                // Cache miss
                metrics.cache_miss_total.inc({ impl: 'memory', key_pattern: keyPattern });
                return { ok: true, value: null };
            }
            // Check expiration
            if (entry.expireAt !== null && Date.now() > entry.expireAt) {
                this.store.delete(key);
                // Expired = miss
                metrics.cache_miss_total.inc({ impl: 'memory', key_pattern: keyPattern });
                return { ok: true, value: null };
            }
            // Cache hit
            metrics.cache_hits_total.inc({ impl: 'memory', key_pattern: keyPattern });
            return { ok: true, value: entry.value };
        }
        catch (error) {
            metrics.cache_errors_total.inc({ impl: 'memory', error_type: 'runtime' });
            return { ok: false, error: error };
        }
    }
    /**
     * Set value with optional TTL (in seconds)
     * Records cache_set_total metric
     */
    async set(key, value, ttl) {
        const keyPattern = this.extractKeyPattern(key);
        try {
            const expireAt = ttl ? Date.now() + ttl * 1000 : null;
            this.store.set(key, { value, expireAt });
            metrics.cache_set_total.inc({ impl: 'memory', key_pattern: keyPattern });
            return { ok: true, value: undefined };
        }
        catch (error) {
            metrics.cache_errors_total.inc({ impl: 'memory', error_type: 'runtime' });
            return { ok: false, error: error };
        }
    }
    /**
     * Delete key from cache
     * Records cache_del_total metric
     */
    async del(key) {
        const keyPattern = this.extractKeyPattern(key);
        try {
            this.store.delete(key);
            metrics.cache_del_total.inc({ impl: 'memory', key_pattern: keyPattern });
            return { ok: true, value: undefined };
        }
        catch (error) {
            metrics.cache_errors_total.inc({ impl: 'memory', error_type: 'runtime' });
            return { ok: false, error: error };
        }
    }
    /**
     * Get current cache size (for debugging/metrics)
     */
    size() {
        return this.store.size;
    }
    /**
     * Clear all entries (for testing)
     */
    clear() {
        this.store.clear();
    }
    /**
     * Extract key pattern for metrics grouping
     *
     * Examples:
     * - "user:123" -> "user"
     * - "session:abc:data" -> "session"
     * - "simple" -> "simple"
     *
     * @private
     */
    extractKeyPattern(key) {
        const parts = key.split(':');
        return parts[0] || 'unknown';
    }
}
//# sourceMappingURL=MemoryCache.js.map