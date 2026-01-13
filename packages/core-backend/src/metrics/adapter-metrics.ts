import client from 'prom-client'
import { registry } from './metrics'

type RequestLabels = {
  adapter: string
  method: string
  endpoint: string
  status: string
}

type ErrorLabels = {
  adapter: string
  error_code: string
  operation: string
}

type CrossSystemLabels = {
  flow: string
  source: string
  target: string
  status: string
}

const requestTotal = new client.Counter({
  name: 'federation_request_total',
  help: 'Total federation requests',
  labelNames: ['adapter', 'method', 'endpoint', 'status'] as const,
  registers: [registry],
})

const requestDuration = new client.Histogram({
  name: 'federation_request_duration_seconds',
  help: 'Federation request duration in seconds',
  labelNames: ['adapter', 'method', 'endpoint', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
})

const errorTotal = new client.Counter({
  name: 'federation_error_total',
  help: 'Federation adapter errors',
  labelNames: ['adapter', 'error_code', 'operation'] as const,
  registers: [registry],
})

const crossSystemTotal = new client.Counter({
  name: 'federation_cross_system_total',
  help: 'Cross-system operation totals',
  labelNames: ['flow', 'source', 'target', 'status'] as const,
  registers: [registry],
})

const crossSystemDuration = new client.Histogram({
  name: 'federation_cross_system_duration_seconds',
  help: 'Cross-system operation duration in seconds',
  labelNames: ['flow', 'source', 'target', 'status'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
})

export function getAdapterMetrics() {
  return {
    recordRequest(labels: RequestLabels, durationMs: number) {
      requestTotal.inc(labels)
      requestDuration.observe(labels, durationMs / 1000)
    },
    recordError(labels: ErrorLabels) {
      errorTotal.inc(labels)
    },
    async getMetrics() {
      return registry.metrics()
    },
  }
}

export function recordCrossSystemOperation(labels: CrossSystemLabels) {
  crossSystemTotal.inc(labels)
}

export function startCrossSystemTimer(flow: string, source: string, target: string) {
  const startedAt = process.hrtime.bigint()
  return (status: string) => {
    const end = process.hrtime.bigint()
    const durationSeconds = Number(end - startedAt) / 1e9
    const labels = { flow, source, target, status }
    crossSystemTotal.inc(labels)
    crossSystemDuration.observe(labels, durationSeconds)
  }
}
