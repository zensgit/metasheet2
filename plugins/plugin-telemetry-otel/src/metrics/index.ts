/**
 * Metrics Setup - Prometheus-based metrics collection
 */

import { Counter, Histogram, Registry } from 'prom-client'

export interface Metrics {
  httpRequestsTotal: Counter<string>
  httpRequestDuration: Histogram<string>
  httpRequestErrors: Counter<string>
  registry: Registry
}

export function setupMetrics(): Metrics {
  const registry = new Registry()

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'path', 'status'],
    registers: [registry]
  })

  const httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'path'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
    registers: [registry]
  })

  const httpRequestErrors = new Counter({
    name: 'http_request_errors_total',
    help: 'Total HTTP request errors',
    labelNames: ['method', 'path', 'errorType'],
    registers: [registry]
  })

  return {
    httpRequestsTotal,
    httpRequestDuration,
    httpRequestErrors,
    registry
  }
}
