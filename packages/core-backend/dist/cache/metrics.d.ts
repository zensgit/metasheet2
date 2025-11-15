/**
 * Cache Metrics Collection
 *
 * Provides comprehensive metrics for cache operations:
 * - Hit/miss rates
 * - Operation counts
 * - Duration histograms
 * - Implementation switches
 */
import { Counter, Histogram } from 'prom-client';
/**
 * Cache metrics container
 */
export declare const cacheMetrics: {
    /**
     * Total cache operations (get/set/del)
     */
    operations: Counter<"status" | "operation">;
    /**
     * Cache hits
     */
    hits: Counter<string>;
    /**
     * Cache misses
     */
    misses: Counter<string>;
    /**
     * Cache operation duration
     */
    duration: Histogram<"operation">;
    /**
     * Cache implementation switches
     */
    switchCount: Counter<"implementation">;
};
//# sourceMappingURL=metrics.d.ts.map