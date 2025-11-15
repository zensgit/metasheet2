"use strict";
/**
 * Cache Metrics Collection
 *
 * Provides comprehensive metrics for cache operations:
 * - Hit/miss rates
 * - Operation counts
 * - Duration histograms
 * - Implementation switches
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheMetrics = void 0;
const prom_client_1 = require("prom-client");
/**
 * Cache metrics container
 */
exports.cacheMetrics = {
    /**
     * Total cache operations (get/set/del)
     */
    operations: new prom_client_1.Counter({
        name: 'cache_operations_total',
        help: 'Total cache operations',
        labelNames: ['operation', 'status'] // get/set/del, success/error
    }),
    /**
     * Cache hits
     */
    hits: new prom_client_1.Counter({
        name: 'cache_hits_total',
        help: 'Total cache hits'
    }),
    /**
     * Cache misses
     */
    misses: new prom_client_1.Counter({
        name: 'cache_misses_total',
        help: 'Total cache misses'
    }),
    /**
     * Cache operation duration
     */
    duration: new prom_client_1.Histogram({
        name: 'cache_operation_duration_milliseconds',
        help: 'Cache operation duration',
        labelNames: ['operation'],
        buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000]
    }),
    /**
     * Cache implementation switches
     */
    switchCount: new prom_client_1.Counter({
        name: 'cache_implementation_switches_total',
        help: 'Total cache implementation switches',
        labelNames: ['implementation']
    })
};
//# sourceMappingURL=metrics.js.map