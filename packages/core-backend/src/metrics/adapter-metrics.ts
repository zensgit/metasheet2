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

const getOrCreateCounter = (name: string, help: string, labelNames: string[]) => {
  const existing = registry.getSingleMetric(name)
  if (existing && existing instanceof client.Counter) {
    return existing
  }
  const counter = new client.Counter({
    name,
    help,
    labelNames: labelNames as unknown as string[]
  })
  registry.registerMetric(counter)
  return counter
}

const getOrCreateHistogram = (name: string, help: string, labelNames: string[]) => {
  const existing = registry.getSingleMetric(name)
  if (existing && existing instanceof client.Histogram) {
    return existing
  }
  const histogram = new client.Histogram({
    name,
    help,
    labelNames: labelNames as unknown as string[],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]
  })
  registry.registerMetric(histogram)
  return histogram
}

const requestCounter = getOrCreateCounter(
  'federation_request_total',
  'Total federation adapter requests',
  ['adapter', 'method', 'endpoint', 'status']
)

const requestDuration = getOrCreateHistogram(
  'federation_request_duration_seconds',
  'Federation adapter request duration',
  ['adapter', 'method', 'endpoint', 'status']
)

const errorCounter = getOrCreateCounter(
  'federation_error_total',
  'Total federation adapter errors',
  ['adapter', 'error_code', 'operation']
)

const crossSystemCounter = getOrCreateCounter(
  'federation_cross_system_total',
  'Total cross-system operations',
  ['flow', 'source', 'target', 'status']
)

const crossSystemDuration = getOrCreateHistogram(
  'federation_cross_system_duration_seconds',
  'Cross-system operation duration',
  ['flow', 'source', 'target', 'status']
)

export const getAdapterMetrics = () => ({
  recordRequest: (labels: RequestLabels, durationMs: number) => {
    requestCounter.labels(labels.adapter, labels.method, labels.endpoint, labels.status).inc()
    requestDuration
      .labels(labels.adapter, labels.method, labels.endpoint, labels.status)
      .observe(durationMs / 1000)
  },
  recordError: (labels: ErrorLabels) => {
    errorCounter.labels(labels.adapter, labels.error_code, labels.operation).inc()
  },
  getMetrics: async () => registry.metrics()
})

export const recordCrossSystemOperation = (labels: CrossSystemLabels) => {
  crossSystemCounter.labels(labels.flow, labels.source, labels.target, labels.status).inc()
}

export const startCrossSystemTimer = (flow: string, source: string, target: string) => {
  const start = Date.now()
  return (status: CrossSystemLabels['status']) => {
    const elapsed = (Date.now() - start) / 1000
    crossSystemDuration.labels(flow, source, target, status).observe(elapsed)
    recordCrossSystemOperation({ flow, source, target, status })
  }
}
