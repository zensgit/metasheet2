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

import { Counter, Histogram } from 'prom-client'

/**
 * Cache metrics container (internal use)
 * Named with _internal suffix to avoid conflict with SLO metrics
 */
export const cacheMetrics = {
  /**
   * Total cache operations (get/set/del)
   */
  operations: new Counter({
    name: 'cache_internal_operations_total',
    help: 'Internal cache operations counter',
    labelNames: ['operation', 'status'] // get/set/del, success/error
  }),

  /**
   * Cache hits (internal)
   */
  hits: new Counter({
    name: 'cache_internal_hits_total',
    help: 'Internal cache hits counter'
  }),

  /**
   * Cache misses (internal)
   */
  misses: new Counter({
    name: 'cache_internal_misses_total',
    help: 'Internal cache misses counter'
  }),

  /**
   * Cache operation duration
   */
  duration: new Histogram({
    name: 'cache_internal_operation_duration_ms',
    help: 'Internal cache operation duration',
    labelNames: ['operation'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000]
  }),

  /**
   * Cache implementation switches
   */
  switchCount: new Counter({
    name: 'cache_internal_switches_total',
    help: 'Internal cache implementation switches',
    labelNames: ['implementation']
  })
}
