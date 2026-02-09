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

registry.registerMetric(attendanceApiErrorsTotal)
registry.registerMetric(attendanceRateLimitedTotal)

