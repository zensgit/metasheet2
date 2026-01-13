/**
 * Prometheus Metrics for Adapter Layer
 *
 * Provides Prometheus-compatible metrics for federated adapter operations.
 * Includes request latency, error rates, cache hit ratios, and cross-system operations.
 *
 * @see PROGRESSIVE_FEDERATION_PLAN.md Phase 4.1
 */

import { Registry, Counter, Histogram, Gauge, Summary } from 'prom-client'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

/**
 * Labels for adapter requests
 */
export interface RequestLabels {
  adapter: string
  method: string
  endpoint?: string
  status?: string
}

/**
 * Labels for error tracking
 */
export interface ErrorLabels {
  adapter: string
  error_code: string
  operation?: string
}

/**
 * Labels for cache operations
 */
export interface CacheLabels {
  adapter: string
  operation: 'get' | 'set' | 'delete' | 'clear'
  hit?: 'true' | 'false'
}

/**
 * Labels for cross-system operations
 */
export interface CrossSystemLabels {
  flow: string
  source_system: string
  target_system: string
  status: 'success' | 'failure'
}

/**
 * Labels for token operations
 */
export interface TokenLabels {
  system: string
  status: 'success' | 'failure'
  operation: 'refresh' | 'exchange' | 'validate'
}

// ─────────────────────────────────────────────────────────────
// Prometheus Metrics Manager
// ─────────────────────────────────────────────────────────────

/**
 * Prometheus metrics manager for adapter observability
 */
export class PrometheusMetricsManager {
  private registry: Registry
  private prefix: string

  // Request metrics
  private requestLatency: Histogram<string>
  private requestTotal: Counter<string>

  // Error metrics
  private errorTotal: Counter<string>

  // Cache metrics
  private cacheOperations: Counter<string>
  private cacheHitRatio: Gauge<string>

  // Cross-system metrics
  private crossSystemDuration: Histogram<string>
  private crossSystemTotal: Counter<string>

  // Token metrics
  private tokenRefreshTotal: Counter<string>
  private tokenRefreshDuration: Histogram<string>

  // Connection metrics
  private activeConnections: Gauge<string>
  private connectionErrors: Counter<string>

  // Queue metrics (for async operations)
  private pendingOperations: Gauge<string>

  constructor(options?: { prefix?: string; registry?: Registry }) {
    this.prefix = options?.prefix || 'adapter_'
    this.registry = options?.registry || new Registry()

    // Initialize metrics
    this.requestLatency = new Histogram({
      name: `${this.prefix}request_latency_seconds`,
      help: 'Adapter request latency in seconds',
      labelNames: ['adapter', 'method', 'endpoint', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    })

    this.requestTotal = new Counter({
      name: `${this.prefix}request_total`,
      help: 'Total adapter requests',
      labelNames: ['adapter', 'method', 'status'],
      registers: [this.registry],
    })

    this.errorTotal = new Counter({
      name: `${this.prefix}error_total`,
      help: 'Total adapter errors by type',
      labelNames: ['adapter', 'error_code', 'operation'],
      registers: [this.registry],
    })

    this.cacheOperations = new Counter({
      name: `${this.prefix}cache_operations_total`,
      help: 'Total cache operations',
      labelNames: ['adapter', 'operation', 'hit'],
      registers: [this.registry],
    })

    this.cacheHitRatio = new Gauge({
      name: `${this.prefix}cache_hit_ratio`,
      help: 'Cache hit ratio by adapter',
      labelNames: ['adapter'],
      registers: [this.registry],
    })

    this.crossSystemDuration = new Histogram({
      name: `${this.prefix}cross_system_operation_duration_seconds`,
      help: 'Duration of cross-system operations',
      labelNames: ['flow', 'source_system', 'target_system', 'status'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry],
    })

    this.crossSystemTotal = new Counter({
      name: `${this.prefix}cross_system_operation_total`,
      help: 'Total cross-system operations',
      labelNames: ['flow', 'source_system', 'target_system', 'status'],
      registers: [this.registry],
    })

    this.tokenRefreshTotal = new Counter({
      name: `${this.prefix}token_refresh_total`,
      help: 'Total token refresh operations',
      labelNames: ['system', 'status', 'operation'],
      registers: [this.registry],
    })

    this.tokenRefreshDuration = new Histogram({
      name: `${this.prefix}token_refresh_duration_seconds`,
      help: 'Token refresh duration',
      labelNames: ['system', 'operation'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers: [this.registry],
    })

    this.activeConnections = new Gauge({
      name: `${this.prefix}active_connections`,
      help: 'Number of active adapter connections',
      labelNames: ['adapter'],
      registers: [this.registry],
    })

    this.connectionErrors = new Counter({
      name: `${this.prefix}connection_errors_total`,
      help: 'Total connection errors',
      labelNames: ['adapter', 'error_type'],
      registers: [this.registry],
    })

    this.pendingOperations = new Gauge({
      name: `${this.prefix}pending_operations`,
      help: 'Number of pending async operations',
      labelNames: ['adapter', 'operation_type'],
      registers: [this.registry],
    })
  }

  // ─────────────────────────────────────────────────────────
  // Request Metrics
  // ─────────────────────────────────────────────────────────

  /**
   * Record a request with latency
   */
  recordRequest(labels: RequestLabels, durationMs: number): void {
    const durationSec = durationMs / 1000

    this.requestLatency.observe(
      {
        adapter: labels.adapter,
        method: labels.method,
        endpoint: labels.endpoint || 'unknown',
        status: labels.status || 'unknown',
      },
      durationSec
    )

    this.requestTotal.inc({
      adapter: labels.adapter,
      method: labels.method,
      status: labels.status || 'unknown',
    })
  }

  /**
   * Create a timer for request duration
   */
  startRequestTimer(labels: Omit<RequestLabels, 'status'>): () => void {
    const end = this.requestLatency.startTimer({
      adapter: labels.adapter,
      method: labels.method,
      endpoint: labels.endpoint || 'unknown',
    })

    return () => end()
  }

  // ─────────────────────────────────────────────────────────
  // Error Metrics
  // ─────────────────────────────────────────────────────────

  /**
   * Record an error
   */
  recordError(labels: ErrorLabels): void {
    this.errorTotal.inc({
      adapter: labels.adapter,
      error_code: labels.error_code,
      operation: labels.operation || 'unknown',
    })
  }

  // ─────────────────────────────────────────────────────────
  // Cache Metrics
  // ─────────────────────────────────────────────────────────

  /**
   * Record a cache operation
   */
  recordCacheOperation(labels: CacheLabels): void {
    this.cacheOperations.inc({
      adapter: labels.adapter,
      operation: labels.operation,
      hit: labels.hit || 'false',
    })
  }

  /**
   * Update cache hit ratio
   */
  updateCacheHitRatio(adapter: string, ratio: number): void {
    this.cacheHitRatio.set({ adapter }, ratio)
  }

  // ─────────────────────────────────────────────────────────
  // Cross-System Metrics
  // ─────────────────────────────────────────────────────────

  /**
   * Record a cross-system operation
   */
  recordCrossSystemOperation(labels: CrossSystemLabels, durationMs: number): void {
    const durationSec = durationMs / 1000

    this.crossSystemDuration.observe(
      {
        flow: labels.flow,
        source_system: labels.source_system,
        target_system: labels.target_system,
        status: labels.status,
      },
      durationSec
    )

    this.crossSystemTotal.inc({
      flow: labels.flow,
      source_system: labels.source_system,
      target_system: labels.target_system,
      status: labels.status,
    })
  }

  /**
   * Create a timer for cross-system operations
   */
  startCrossSystemTimer(labels: Omit<CrossSystemLabels, 'status'>): (status: 'success' | 'failure') => void {
    const startTime = Date.now()

    return (status: 'success' | 'failure') => {
      const durationMs = Date.now() - startTime
      this.recordCrossSystemOperation({ ...labels, status }, durationMs)
    }
  }

  // ─────────────────────────────────────────────────────────
  // Token Metrics
  // ─────────────────────────────────────────────────────────

  /**
   * Record a token operation
   */
  recordTokenOperation(labels: TokenLabels, durationMs?: number): void {
    this.tokenRefreshTotal.inc({
      system: labels.system,
      status: labels.status,
      operation: labels.operation,
    })

    if (durationMs !== undefined) {
      this.tokenRefreshDuration.observe(
        {
          system: labels.system,
          operation: labels.operation,
        },
        durationMs / 1000
      )
    }
  }

  // ─────────────────────────────────────────────────────────
  // Connection Metrics
  // ─────────────────────────────────────────────────────────

  /**
   * Set active connections count
   */
  setActiveConnections(adapter: string, count: number): void {
    this.activeConnections.set({ adapter }, count)
  }

  /**
   * Increment active connections
   */
  incActiveConnections(adapter: string): void {
    this.activeConnections.inc({ adapter })
  }

  /**
   * Decrement active connections
   */
  decActiveConnections(adapter: string): void {
    this.activeConnections.dec({ adapter })
  }

  /**
   * Record a connection error
   */
  recordConnectionError(adapter: string, errorType: string): void {
    this.connectionErrors.inc({ adapter, error_type: errorType })
  }

  // ─────────────────────────────────────────────────────────
  // Queue Metrics
  // ─────────────────────────────────────────────────────────

  /**
   * Set pending operations count
   */
  setPendingOperations(adapter: string, operationType: string, count: number): void {
    this.pendingOperations.set({ adapter, operation_type: operationType }, count)
  }

  /**
   * Increment pending operations
   */
  incPendingOperations(adapter: string, operationType: string): void {
    this.pendingOperations.inc({ adapter, operation_type: operationType })
  }

  /**
   * Decrement pending operations
   */
  decPendingOperations(adapter: string, operationType: string): void {
    this.pendingOperations.dec({ adapter, operation_type: operationType })
  }

  // ─────────────────────────────────────────────────────────
  // Registry Access
  // ─────────────────────────────────────────────────────────

  /**
   * Get the Prometheus registry
   */
  getRegistry(): Registry {
    return this.registry
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics()
  }

  /**
   * Get metrics content type
   */
  getContentType(): string {
    return this.registry.contentType
  }

  /**
   * Reset all metrics
   */
  resetMetrics(): void {
    this.registry.resetMetrics()
  }
}

// ─────────────────────────────────────────────────────────────
// Metrics Middleware Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Create an Express middleware for exposing /metrics endpoint
 */
export function createMetricsMiddleware(manager: PrometheusMetricsManager) {
  return async (
    _req: { path: string },
    res: { set: (key: string, value: string) => void; send: (body: string) => void },
    next: () => void
  ) => {
    if (_req.path === '/metrics' || _req.path === '/metrics/prom') {
      try {
        const metrics = await manager.getMetrics()
        res.set('Content-Type', manager.getContentType())
        res.send(metrics)
      } catch (error) {
        next()
      }
    } else {
      next()
    }
  }
}

/**
 * Wrap an async function with metrics collection
 */
export function withMetrics<T extends (...args: unknown[]) => Promise<unknown>>(
  manager: PrometheusMetricsManager,
  fn: T,
  labels: { adapter: string; method: string; endpoint?: string }
): T {
  const wrappedFn = async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const startTime = Date.now()
    let status = '200'

    try {
      const result = await fn(...args)
      return result as ReturnType<T>
    } catch (error) {
      status = '500'
      throw error
    } finally {
      manager.recordRequest({ ...labels, status }, Date.now() - startTime)
    }
  }

  return wrappedFn as T
}

// ─────────────────────────────────────────────────────────────
// Factory Functions
// ─────────────────────────────────────────────────────────────

let globalMetricsManager: PrometheusMetricsManager | undefined

/**
 * Get the global Prometheus metrics manager
 */
export function getPrometheusMetrics(): PrometheusMetricsManager {
  if (!globalMetricsManager) {
    globalMetricsManager = new PrometheusMetricsManager()
  }
  return globalMetricsManager
}

/**
 * Reset the global metrics manager (for testing)
 */
export function resetPrometheusMetrics(): void {
  if (globalMetricsManager) {
    globalMetricsManager.resetMetrics()
  }
  globalMetricsManager = undefined
}

/**
 * Create a new Prometheus metrics manager instance
 */
export function createPrometheusMetrics(options?: {
  prefix?: string
  registry?: Registry
}): PrometheusMetricsManager {
  return new PrometheusMetricsManager(options)
}

// ─────────────────────────────────────────────────────────────
// Alert Rule Definitions (for documentation/export)
// ─────────────────────────────────────────────────────────────

/**
 * Recommended Prometheus alert rules for adapter monitoring
 */
export const RECOMMENDED_ALERT_RULES = `
# Adapter Alert Rules for Prometheus
groups:
  - name: adapter_alerts
    rules:
      # High latency alert
      - alert: AdapterHighLatency
        expr: histogram_quantile(0.99, rate(adapter_request_latency_seconds_bucket[5m])) > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High adapter latency detected"
          description: "P99 latency for {{ $labels.adapter }} is {{ $value }}s"

      # Auth failure alert
      - alert: AdapterAuthFailure
        expr: rate(adapter_error_total{error_code="AUTH_FAILED"}[5m]) > 0.1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Authentication failures detected"
          description: "Auth failures for {{ $labels.adapter }}: {{ $value }}/s"

      # Connection errors
      - alert: AdapterConnectionErrors
        expr: rate(adapter_connection_errors_total[5m]) > 0.5
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Connection errors detected"
          description: "Connection errors for {{ $labels.adapter }}: {{ $value }}/s"

      # Low cache hit ratio
      - alert: AdapterLowCacheHitRatio
        expr: adapter_cache_hit_ratio < 0.5
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "Low cache hit ratio"
          description: "Cache hit ratio for {{ $labels.adapter }} is {{ $value }}"

      # Token refresh failures
      - alert: TokenRefreshFailures
        expr: rate(adapter_token_refresh_total{status="failure"}[5m]) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Token refresh failures"
          description: "Token refresh failures for {{ $labels.system }}"

      # Cross-system operation failures
      - alert: CrossSystemOperationFailures
        expr: rate(adapter_cross_system_operation_total{status="failure"}[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Cross-system operation failures"
          description: "Failures in {{ $labels.flow }} flow: {{ $value }}/s"
`
