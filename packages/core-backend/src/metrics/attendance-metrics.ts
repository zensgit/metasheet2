import client from 'prom-client'
import { registry } from './metrics'

// Keep labels low-cardinality. `route` must be normalized (no UUIDs).
export const attendanceApiErrorsTotal = new client.Counter({
  name: 'attendance_api_errors_total',
  help: 'Attendance API errors by route/method/status/error_code',
  labelNames: ['route', 'method', 'status', 'error_code'] as const,
})

export const attendanceRateLimitedTotal = new client.Counter({
  name: 'attendance_rate_limited_total',
  help: 'Attendance API rate-limited responses',
  labelNames: ['route', 'method'] as const,
})

export const attendanceOperationRequestsTotal = new client.Counter({
  name: 'attendance_operation_requests_total',
  help: 'Attendance operation request totals by operation/result',
  labelNames: ['operation', 'result'] as const,
})

export const attendanceOperationFailuresTotal = new client.Counter({
  name: 'attendance_operation_failures_total',
  help: 'Attendance operation failures grouped by reason and status class',
  labelNames: ['operation', 'reason', 'status_class'] as const,
})

export const attendanceOperationLatencySeconds = new client.Histogram({
  name: 'attendance_operation_latency_seconds',
  help: 'Attendance operation latency in seconds',
  labelNames: ['operation', 'result'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
})

registry.registerMetric(attendanceApiErrorsTotal)
registry.registerMetric(attendanceRateLimitedTotal)
registry.registerMetric(attendanceOperationRequestsTotal)
registry.registerMetric(attendanceOperationFailuresTotal)
registry.registerMetric(attendanceOperationLatencySeconds)
