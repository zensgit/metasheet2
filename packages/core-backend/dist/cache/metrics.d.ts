/**
 * Cache Metrics Collection (Internal)
 *
 * NOTE: These metrics are internal to src/cache/registry.ts.
 * Main SLO cache metrics are defined in metrics/metrics.ts with labels.
 * These use different names to avoid Prometheus registration conflicts.
 *
 * Provides comprehensive metrics for cache operations:
 * - Hit/miss rates
 * - Operation counts
 * - Duration histograms
 * - Implementation switches
 */
import { Counter, Histogram } from 'prom-client';
/**
 * Cache metrics container (internal use)
 * Named with _internal suffix to avoid conflict with SLO metrics
 */
export declare const cacheMetrics: {
    /**
     * Total cache operations (get/set/del)
     */
    operations: Counter<"status" | "operation">;
    /**
     * Cache hits (internal)
     */
    hits: Counter<string>;
    /**
     * Cache misses (internal)
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