/**
 * NullCache - No-op cache implementation
 *
 * All operations succeed immediately but don't actually store data.
 * Use cases:
 * 1. Default implementation ensuring system doesn't depend on cache
 * 2. Observing cache call patterns and frequency
 * 3. Performance baseline (zero cache overhead)
 */
export class NullCache {
    /**
     * Always returns cache miss
     */
    async get(key) {
        return { ok: true, value: null };
    }
    /**
     * Does nothing, immediately succeeds
     */
    async set(key, value, ttl) {
        return { ok: true, value: undefined };
    }
    /**
     * Does nothing, immediately succeeds
     */
    async del(key) {
        return { ok: true, value: undefined };
    }
}
//# sourceMappingURL=null-cache.js.map