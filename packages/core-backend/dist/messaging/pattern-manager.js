"use strict";
/**
 * Pattern Manager with Trie Optimization
 * Issue #28: High-performance pattern matching with prefix tree
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PatternManager = void 0;
const pattern_trie_1 = require("./pattern-trie");
const events_1 = require("events");
class PatternManager extends events_1.EventEmitter {
    trie;
    logger;
    metrics;
    config;
    matchCache;
    cleanupTimer;
    constructor(logger, metrics, config = {}) {
        super();
        this.logger = logger;
        this.metrics = metrics;
        this.config = {
            enableMetrics: config.enableMetrics ?? true,
            optimizationMode: config.optimizationMode ?? 'balanced',
            maxPatterns: config.maxPatterns ?? 10000,
            cleanupIntervalMs: config.cleanupIntervalMs ?? 300000 // 5 minutes
        };
        this.trie = new pattern_trie_1.PatternTrie();
        this.matchCache = new Map();
        this.startCleanupTimer();
        this.setupMetrics();
    }
    /**
     * Subscribe to a pattern
     */
    subscribe(pattern, callback, metadata) {
        const subscriptionId = this.generateSubscriptionId();
        const subscription = {
            id: subscriptionId,
            pattern,
            callback,
            createdAt: Date.now(),
            metadata
        };
        try {
            this.trie.addPattern(pattern, subscription);
            this.invalidateCache();
            this.logger.debug(`Subscribed to pattern: ${pattern} (id: ${subscriptionId})`);
            this.recordMetric('pattern.subscribe', { pattern, subscriptionId });
            this.emit('subscribed', { pattern, subscriptionId, subscription });
            return subscriptionId;
        }
        catch (error) {
            const err = error;
            this.logger.error(`Failed to subscribe to pattern ${pattern}:`, err);
            this.recordMetric('pattern.subscribe.error', { pattern, error: err.message });
            throw error;
        }
    }
    /**
     * Unsubscribe from a pattern
     */
    unsubscribe(pattern, subscriptionId) {
        try {
            const removed = this.trie.removePattern(pattern, subscriptionId);
            if (removed) {
                this.invalidateCache();
                this.logger.debug(`Unsubscribed from pattern: ${pattern} (id: ${subscriptionId})`);
                this.recordMetric('pattern.unsubscribe', { pattern, subscriptionId });
                this.emit('unsubscribed', { pattern, subscriptionId });
            }
            else {
                this.logger.warn(`Subscription not found: ${pattern} (id: ${subscriptionId})`);
                this.recordMetric('pattern.unsubscribe.not_found', { pattern, subscriptionId });
            }
            return removed;
        }
        catch (error) {
            const err = error;
            this.logger.error(`Failed to unsubscribe from pattern ${pattern}:`, err);
            this.recordMetric('pattern.unsubscribe.error', { pattern, subscriptionId, error: err.message });
            return false;
        }
    }
    /**
     * Find matching subscriptions for a topic
     */
    findMatches(topic) {
        const startTime = process.hrtime.bigint();
        // Check cache first
        const cacheKey = this.getCacheKey(topic);
        const cached = this.matchCache.get(cacheKey);
        if (cached && this.isCacheValid(cached.timestamp)) {
            const matchTime = Number(process.hrtime.bigint() - startTime) / 1_000_000; // Convert to ms
            this.recordMetric('pattern.match.cache_hit', { topic, matchTime });
            return {
                subscriptions: cached.result,
                matchTime,
                cacheHit: true
            };
        }
        // Perform matching using trie
        const subscriptions = this.trie.findMatches(topic);
        const matchTime = Number(process.hrtime.bigint() - startTime) / 1_000_000;
        // Cache the result
        this.cacheResult(cacheKey, subscriptions);
        this.recordMetric('pattern.match.cache_miss', {
            topic,
            matchTime,
            matchCount: subscriptions.length
        });
        return {
            subscriptions,
            matchTime,
            cacheHit: false
        };
    }
    /**
     * Publish message to matching subscribers
     */
    async publish(topic, message) {
        const matchResult = this.findMatches(topic);
        const { subscriptions } = matchResult;
        if (subscriptions.length === 0) {
            this.recordMetric('pattern.publish.no_matches', { topic });
            return 0;
        }
        const startTime = process.hrtime.bigint();
        let successCount = 0;
        let errorCount = 0;
        // Execute callbacks in parallel for better performance
        const promises = subscriptions.map(async (subscription) => {
            try {
                await Promise.resolve(subscription.callback(topic, message));
                successCount++;
            }
            catch (error) {
                const err = error;
                errorCount++;
                this.logger.error(`Callback error for subscription ${subscription.id} on topic ${topic}:`, err);
                this.recordMetric('pattern.callback.error', {
                    subscriptionId: subscription.id,
                    topic,
                    pattern: subscription.pattern,
                    error: err.message
                });
            }
        });
        await Promise.all(promises);
        const publishTime = Number(process.hrtime.bigint() - startTime) / 1_000_000;
        this.recordMetric('pattern.publish', {
            topic,
            matchCount: subscriptions.length,
            successCount,
            errorCount,
            publishTime,
            cacheHit: matchResult.cacheHit
        });
        this.emit('published', {
            topic,
            message,
            matchCount: subscriptions.length,
            successCount,
            errorCount,
            publishTime
        });
        return successCount;
    }
    /**
     * Get pattern statistics
     */
    getStats() {
        const trieStats = this.trie.getStats();
        // Calculate cache hit rate from metrics
        const hitRate = this.calculateCacheHitRate();
        return {
            trie: trieStats,
            cache: {
                size: this.matchCache.size,
                hitRate
            },
            performance: {
                averageMatchTime: this.getAverageMetric('pattern.match.cache_miss', 'matchTime'),
                averagePublishTime: this.getAverageMetric('pattern.publish', 'publishTime')
            }
        };
    }
    /**
     * Get all active subscriptions
     */
    getAllSubscriptions() {
        return this.trie.getAllSubscriptions();
    }
    /**
     * Clear all patterns and cache
     */
    clear() {
        this.trie.clear();
        this.matchCache.clear();
        this.logger.info('Pattern manager cleared');
        this.recordMetric('pattern.clear');
        this.emit('cleared');
    }
    /**
     * Shutdown and cleanup
     */
    async shutdown() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        this.clear();
        this.logger.info('Pattern manager shutdown complete');
        this.emit('shutdown');
    }
    /**
     * Debug information
     */
    debug() {
        return {
            trie: this.trie.debug(),
            cache: Array.from(this.matchCache.entries()).map(([key, value]) => ({
                topic: key,
                matches: value.result.length,
                age: Date.now() - value.timestamp
            })),
            stats: this.getStats()
        };
    }
    /**
     * Private helper methods
     */
    generateSubscriptionId() {
        return `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    getCacheKey(topic) {
        return `topic:${topic}`;
    }
    isCacheValid(timestamp) {
        const maxAge = this.config.optimizationMode === 'speed' ? 30000 : 10000; // 30s or 10s
        return Date.now() - timestamp < maxAge;
    }
    cacheResult(key, result) {
        // Limit cache size
        const maxCacheSize = this.config.optimizationMode === 'memory' ? 1000 : 5000;
        if (this.matchCache.size >= maxCacheSize) {
            // Remove oldest entries
            const entries = Array.from(this.matchCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toRemove = entries.slice(0, Math.floor(maxCacheSize * 0.2)); // Remove 20%
            toRemove.forEach(([key]) => this.matchCache.delete(key));
        }
        this.matchCache.set(key, {
            result: result.slice(), // Copy array
            timestamp: Date.now()
        });
    }
    invalidateCache() {
        this.matchCache.clear();
        this.recordMetric('pattern.cache.invalidated');
    }
    startCleanupTimer() {
        this.cleanupTimer = setInterval(() => {
            this.performCleanup();
        }, this.config.cleanupIntervalMs);
    }
    performCleanup() {
        const before = this.matchCache.size;
        const cutoff = Date.now() - 300000; // 5 minutes
        for (const [key, value] of this.matchCache.entries()) {
            if (value.timestamp < cutoff) {
                this.matchCache.delete(key);
            }
        }
        const cleaned = before - this.matchCache.size;
        if (cleaned > 0) {
            this.logger.debug(`Cleaned ${cleaned} cache entries`);
            this.recordMetric('pattern.cache.cleanup', { cleaned });
        }
    }
    setupMetrics() {
        if (!this.config.enableMetrics || !this.metrics)
            return;
        // Register custom metrics
        this.on('subscribed', (data) => {
            this.metrics.increment('pattern_subscriptions_total');
            this.metrics.gauge('pattern_active_subscriptions', this.trie.getStats().totalSubscriptions);
        });
        this.on('unsubscribed', (data) => {
            this.metrics.increment('pattern_unsubscriptions_total');
            this.metrics.gauge('pattern_active_subscriptions', this.trie.getStats().totalSubscriptions);
        });
        this.on('published', (data) => {
            this.metrics.increment('pattern_messages_published_total');
            this.metrics.histogram('pattern_match_count', data.matchCount);
            this.metrics.histogram('pattern_publish_duration_ms', data.publishTime);
            if (data.errorCount > 0) {
                this.metrics.increment('pattern_callback_errors_total', data.errorCount);
            }
        });
        // Periodic stats update
        setInterval(() => {
            const stats = this.getStats();
            this.metrics.gauge('pattern_trie_nodes', stats.trie.totalNodes);
            this.metrics.gauge('pattern_trie_memory_bytes', stats.trie.memoryUsage);
            this.metrics.gauge('pattern_cache_size', stats.cache.size);
            this.metrics.gauge('pattern_cache_hit_rate', stats.cache.hitRate);
        }, 60000); // Every minute
    }
    recordMetric(event, data) {
        if (!this.config.enableMetrics || !this.metrics)
            return;
        // Convert event to metric name
        const metricName = event.replace(/\./g, '_');
        this.metrics.increment(metricName, data);
    }
    calculateCacheHitRate() {
        // This would typically be calculated from historical metrics
        // For now, return a placeholder based on cache size
        return Math.min(0.95, this.matchCache.size / 1000);
    }
    getAverageMetric(event, field) {
        // This would typically come from metrics aggregation
        // For now, return reasonable estimates based on optimization mode
        const estimates = {
            'pattern.match.cache_miss': { matchTime: 2.5 },
            'pattern.publish': { publishTime: 15.0 }
        };
        return estimates[event]?.[field] || 0;
    }
}
exports.PatternManager = PatternManager;
//# sourceMappingURL=pattern-manager.js.map