import { metrics } from '../metrics/metrics'

export type FallbackReason =
  | 'http_error'
  | 'http_timeout'
  | 'message_error'
  | 'message_timeout'
  | 'cache_miss'
  | 'circuit_breaker'
  | 'upstream_error'
  | 'unknown'

export function recordFallback(reason: FallbackReason, effective = true) {
  try {
    metrics.fallbackRawTotal.inc({ reason })
  } catch { /* metrics unavailable */ }
  try {
    const countCacheMissAsFallback = process.env.COUNT_CACHE_MISS_AS_FALLBACK === 'true'
    const isCacheMiss = reason === 'cache_miss'
    const shouldCountEffective = effective && (countCacheMissAsFallback ? true : !isCacheMiss)
    if (shouldCountEffective) {
      metrics.fallbackEffectiveTotal.inc({ reason })
    }
  } catch { /* metrics unavailable */ }
}
