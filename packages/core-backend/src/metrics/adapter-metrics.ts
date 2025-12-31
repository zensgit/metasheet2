/**
 * Adapter Metrics Integration
 *
 * Integrates PrometheusMetrics from data-adapters with the main MetaSheet metrics system.
 * Provides unified metrics endpoint and Express middleware for adapter observability.
 *
 * @see PROGRESSIVE_FEDERATION_PLAN.md Phase 4.2
 */

import type { Application, Request, Response, NextFunction } from 'express'
import { Registry } from 'prom-client'
import {
  PrometheusMetricsManager,
  createPrometheusMetrics,
  getPrometheusMetrics,
  type RequestLabels,
  type ErrorLabels,
  type CacheLabels,
  type CrossSystemLabels,
  type TokenLabels,
} from '../data-adapters/PrometheusMetrics'

// ─────────────────────────────────────────────────────────────
// Adapter Metrics Singleton
// ─────────────────────────────────────────────────────────────

let adapterMetrics: PrometheusMetricsManager | undefined
let adapterRegistry: Registry | undefined

/**
 * Get the adapter metrics registry
 * Creates a dedicated registry for adapter metrics to avoid conflicts
 */
function getAdapterRegistry(): Registry {
  if (!adapterRegistry) {
    adapterRegistry = new Registry()
  }
  return adapterRegistry
}

/**
 * Get or create the adapter metrics manager
 * Uses a dedicated registry for adapter metrics
 */
export function getAdapterMetrics(): PrometheusMetricsManager {
  if (!adapterMetrics) {
    // Create adapter metrics with 'federation_' prefix
    adapterMetrics = createPrometheusMetrics({
      prefix: 'federation_',
      registry: getAdapterRegistry(),
    })
  }
  return adapterMetrics
}

/**
 * Reset adapter metrics (for testing)
 */
export function resetAdapterMetrics(): void {
  if (adapterRegistry) {
    adapterRegistry.clear()
  }
  adapterRegistry = undefined
  adapterMetrics = undefined
}

/**
 * Get the adapter registry for integration with main metrics endpoint
 */
export function getAdapterMetricsRegistry(): Registry {
  return getAdapterRegistry()
}

// ─────────────────────────────────────────────────────────────
// Express Middleware
// ─────────────────────────────────────────────────────────────

/**
 * Middleware to track adapter requests
 * Wraps adapter-related endpoints with metrics collection
 */
export function adapterMetricsMiddleware(
  adapterName: string,
  options?: { endpoint?: string }
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const metrics = getAdapterMetrics()
    const startTime = Date.now()
    const endpoint = options?.endpoint || req.path

    // Track when response finishes
    res.on('finish', () => {
      const duration = Date.now() - startTime
      metrics.recordRequest(
        {
          adapter: adapterName,
          method: req.method,
          endpoint,
          status: String(res.statusCode),
        },
        duration
      )

      // Track errors
      if (res.statusCode >= 400) {
        const errorCode = res.statusCode >= 500 ? 'INTERNAL_ERROR' : 'CLIENT_ERROR'
        metrics.recordError({
          adapter: adapterName,
          error_code: errorCode,
          operation: endpoint,
        })
      }
    })

    next()
  }
}

/**
 * Middleware for cross-system operation tracking
 */
export function crossSystemMetricsMiddleware(
  flow: string,
  sourceSystem: string,
  targetSystem: string
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const metrics = getAdapterMetrics()
    const finish = metrics.startCrossSystemTimer({
      flow,
      source_system: sourceSystem,
      target_system: targetSystem,
    })

    res.on('finish', () => {
      const status = res.statusCode < 400 ? 'success' : 'failure'
      finish(status)
    })

    next()
  }
}

// ─────────────────────────────────────────────────────────────
// Route Installation
// ─────────────────────────────────────────────────────────────

/**
 * Install adapter-specific metrics routes
 */
export function installAdapterMetrics(app: Application): void {
  const metrics = getAdapterMetrics()

  // Dedicated adapter metrics endpoint
  app.get('/metrics/adapters', async (_req: Request, res: Response) => {
    try {
      const metricsOutput = await metrics.getMetrics()
      res.set('Content-Type', metrics.getContentType())
      res.send(metricsOutput)
    } catch (error) {
      res.status(500).json({ error: 'Failed to collect adapter metrics' })
    }
  })

  // Adapter metrics summary (JSON format)
  app.get('/metrics/adapters/summary', async (_req: Request, res: Response) => {
    try {
      const metricsText = await metrics.getMetrics()

      // Parse key metrics for summary
      const summary = parseMetricsSummary(metricsText)
      res.json(summary)
    } catch (error) {
      res.status(500).json({ error: 'Failed to generate metrics summary' })
    }
  })
}

/**
 * Parse Prometheus metrics text into summary object
 */
function parseMetricsSummary(metricsText: string): Record<string, unknown> {
  const lines = metricsText.split('\n')
  const summary: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    adapters: {} as Record<string, unknown>,
    crossSystem: {} as Record<string, unknown>,
    cache: {} as Record<string, unknown>,
  }

  const adapters = summary.adapters as Record<string, Record<string, number>>
  const crossSystem = summary.crossSystem as Record<string, Record<string, number>>
  const cache = summary.cache as Record<string, number>

  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue

    // Parse adapter request totals
    const requestMatch = line.match(/federation_request_total\{.*adapter="([^"]+)".*\}\s+(\d+)/)
    if (requestMatch) {
      const [, adapter, count] = requestMatch
      if (!adapters[adapter]) adapters[adapter] = {}
      adapters[adapter].requests = (adapters[adapter].requests || 0) + parseInt(count, 10)
    }

    // Parse error totals
    const errorMatch = line.match(/federation_error_total\{.*adapter="([^"]+)".*\}\s+(\d+)/)
    if (errorMatch) {
      const [, adapter, count] = errorMatch
      if (!adapters[adapter]) adapters[adapter] = {}
      adapters[adapter].errors = (adapters[adapter].errors || 0) + parseInt(count, 10)
    }

    // Parse cross-system operations
    const crossMatch = line.match(/federation_cross_system_operation_total\{.*flow="([^"]+)".*status="([^"]+)".*\}\s+(\d+)/)
    if (crossMatch) {
      const [, flow, status, count] = crossMatch
      if (!crossSystem[flow]) crossSystem[flow] = {}
      crossSystem[flow][status] = parseInt(count, 10)
    }

    // Parse cache hit ratio
    const cacheMatch = line.match(/federation_cache_hit_ratio\{.*adapter="([^"]+)".*\}\s+([\d.]+)/)
    if (cacheMatch) {
      const [, adapter, ratio] = cacheMatch
      cache[`${adapter}_hit_ratio`] = parseFloat(ratio)
    }
  }

  return summary
}

// ─────────────────────────────────────────────────────────────
// Helper Functions for Adapter Integration
// ─────────────────────────────────────────────────────────────

/**
 * Record a PLM adapter operation
 */
export function recordPLMOperation(
  method: string,
  endpoint: string,
  status: string,
  durationMs: number
): void {
  getAdapterMetrics().recordRequest(
    { adapter: 'plm', method, endpoint, status },
    durationMs
  )
}

/**
 * Record an Athena adapter operation
 */
export function recordAthenaOperation(
  method: string,
  endpoint: string,
  status: string,
  durationMs: number
): void {
  getAdapterMetrics().recordRequest(
    { adapter: 'athena', method, endpoint, status },
    durationMs
  )
}

/**
 * Record an adapter error
 */
export function recordAdapterError(
  adapter: 'plm' | 'athena' | 'mock',
  errorCode: string,
  operation?: string
): void {
  getAdapterMetrics().recordError({
    adapter,
    error_code: errorCode,
    operation,
  })
}

/**
 * Record cache operation
 */
export function recordCacheOperation(
  adapter: string,
  operation: 'get' | 'set' | 'delete' | 'clear',
  hit?: boolean
): void {
  getAdapterMetrics().recordCacheOperation({
    adapter,
    operation,
    hit: hit !== undefined ? (hit ? 'true' : 'false') : undefined,
  })
}

/**
 * Update cache hit ratio for an adapter
 */
export function updateCacheHitRatio(adapter: string, ratio: number): void {
  getAdapterMetrics().updateCacheHitRatio(adapter, ratio)
}

/**
 * Record a cross-system operation (e.g., MetaSheet -> Athena edit/save)
 */
export function recordCrossSystemOperation(
  flow: string,
  sourceSystem: string,
  targetSystem: string,
  status: 'success' | 'failure',
  durationMs: number
): void {
  getAdapterMetrics().recordCrossSystemOperation(
    { flow, source_system: sourceSystem, target_system: targetSystem, status },
    durationMs
  )
}

/**
 * Start a cross-system operation timer
 */
export function startCrossSystemTimer(
  flow: string,
  sourceSystem: string,
  targetSystem: string
): (status: 'success' | 'failure') => void {
  return getAdapterMetrics().startCrossSystemTimer({
    flow,
    source_system: sourceSystem,
    target_system: targetSystem,
  })
}

/**
 * Record token operation
 */
export function recordTokenOperation(
  system: string,
  operation: 'refresh' | 'exchange' | 'validate',
  status: 'success' | 'failure',
  durationMs?: number
): void {
  getAdapterMetrics().recordTokenOperation(
    { system, operation, status },
    durationMs
  )
}

/**
 * Update active connections count
 */
export function setActiveConnections(adapter: string, count: number): void {
  getAdapterMetrics().setActiveConnections(adapter, count)
}

/**
 * Record connection error
 */
export function recordConnectionError(adapter: string, errorType: string): void {
  getAdapterMetrics().recordConnectionError(adapter, errorType)
}

// ─────────────────────────────────────────────────────────────
// Re-exports for convenience
// ─────────────────────────────────────────────────────────────

export {
  PrometheusMetricsManager,
  createPrometheusMetrics,
  getPrometheusMetrics,
  type RequestLabels,
  type ErrorLabels,
  type CacheLabels,
  type CrossSystemLabels,
  type TokenLabels,
}
