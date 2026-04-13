/**
 * Canary Routing Module
 *
 * Provides weight-based traffic splitting between stable and canary
 * handler versions, with tenant-sticky deterministic routing,
 * per-tenant overrides, and Prometheus metrics for comparison.
 *
 * Feature flag: ENABLE_CANARY_ROUTING (default: false)
 */

export { CanaryRouter, canaryHash } from './CanaryRouter'
export type { CanaryRule, CanaryVersion } from './CanaryRouter'
export { CanaryMetrics, canaryMetrics } from './CanaryMetrics'
export { CanaryInterceptor, createCanaryInterceptor } from './CanaryInterceptor'
