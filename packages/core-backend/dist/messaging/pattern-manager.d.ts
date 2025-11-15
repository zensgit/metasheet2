/**
 * Pattern Manager with Trie Optimization
 * Issue #28: High-performance pattern matching with prefix tree
 */
import { Subscription } from './pattern-trie';
import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { CoreMetrics } from '../integration/metrics/metrics';
export interface PatternManagerConfig {
    enableMetrics?: boolean;
    optimizationMode?: 'memory' | 'speed' | 'balanced';
    maxPatterns?: number;
    cleanupIntervalMs?: number;
}
export interface MatchResult {
    subscriptions: Subscription[];
    matchTime: number;
    cacheHit: boolean;
}
export declare class PatternManager extends EventEmitter {
    private trie;
    private logger;
    private metrics?;
    private config;
    private matchCache;
    private cleanupTimer?;
    constructor(logger: Logger, metrics?: CoreMetrics, config?: PatternManagerConfig);
    /**
     * Subscribe to a pattern
     */
    subscribe(pattern: string, callback: (topic: string, message: any) => void, metadata?: any): string;
    /**
     * Unsubscribe from a pattern
     */
    unsubscribe(pattern: string, subscriptionId: string): boolean;
    /**
     * Find matching subscriptions for a topic
     */
    findMatches(topic: string): MatchResult;
    /**
     * Publish message to matching subscribers
     */
    publish(topic: string, message: any): Promise<number>;
    /**
     * Get pattern statistics
     */
    getStats(): {
        trie: any;
        cache: {
            size: number;
            hitRate: number;
        };
        performance: {
            averageMatchTime: number;
            averagePublishTime: number;
        };
    };
    /**
     * Get all active subscriptions
     */
    getAllSubscriptions(): Subscription[];
    /**
     * Clear all patterns and cache
     */
    clear(): void;
    /**
     * Shutdown and cleanup
     */
    shutdown(): Promise<void>;
    /**
     * Debug information
     */
    debug(): {
        trie: string;
        cache: any;
        stats: any;
    };
    /**
     * Private helper methods
     */
    private generateSubscriptionId;
    private getCacheKey;
    private isCacheValid;
    private cacheResult;
    private invalidateCache;
    private startCleanupTimer;
    private performCleanup;
    private setupMetrics;
    private recordMetric;
    private calculateCacheHitRate;
    private getAverageMetric;
}
//# sourceMappingURL=pattern-manager.d.ts.map