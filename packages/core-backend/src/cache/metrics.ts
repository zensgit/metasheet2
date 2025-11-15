/**
 * Cache Metrics Collection
 *
 * Provides comprehensive metrics for cache operations:
 * - Hit/miss rates
 * - Operation counts
 * - Duration histograms
 * - Implementation switches
 */

import { Counter, Histogram } from 'prom-client'

/**
 * Cache metrics container
 */
export const cacheMetrics = {
  /**
   * Total cache operations (get/set/del)
   */
  operations: new Counter({
    name: 'cache_operations_total',
    help: 'Total cache operations',
    labelNames: ['operation', 'status'] // get/set/del, success/error
  }),

  /**
   * Cache hits
   */
  hits: new Counter({
    name: 'cache_hits_total',
    help: 'Total cache hits'
  }),

  /**
   * Cache misses
   */
  misses: new Counter({
    name: 'cache_misses_total',
    help: 'Total cache misses'
  }),

  /**
   * Cache operation duration
   */
  duration: new Histogram({
    name: 'cache_operation_duration_milliseconds',
    help: 'Cache operation duration',
    labelNames: ['operation'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000]
  }),

  /**
   * Cache implementation switches
   */
  switchCount: new Counter({
    name: 'cache_implementation_switches_total',
    help: 'Total cache implementation switches',
    labelNames: ['implementation']
  })
}
