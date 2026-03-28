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

export const attendanceImportUploadBytesTotal = new client.Counter({
  name: 'attendance_import_upload_bytes_total',
  help: 'Total bytes uploaded via attendance import upload channel (csvFileId)',
})

export const attendanceImportUploadRowsTotal = new client.Counter({
  name: 'attendance_import_upload_rows_total',
  help: 'Total data rows uploaded via attendance import upload channel (csvFileId)',
})

export const attendanceImportProcessedRowsTotal = new client.Counter({
  name: 'attendance_import_processed_rows_total',
  help: 'Total processed rows reported by attendance import operations',
  labelNames: ['operation', 'engine'] as const,
})

export const attendanceImportFailedRowsTotal = new client.Counter({
  name: 'attendance_import_failed_rows_total',
  help: 'Total failed rows reported by attendance import operations',
  labelNames: ['operation', 'engine'] as const,
})

export const attendanceImportElapsedSeconds = new client.Histogram({
  name: 'attendance_import_elapsed_seconds',
  help: 'Attendance import elapsed time reported by API payload telemetry',
  labelNames: ['operation', 'engine'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200],
})

registry.registerMetric(attendanceApiErrorsTotal)
registry.registerMetric(attendanceRateLimitedTotal)
registry.registerMetric(attendanceOperationRequestsTotal)
registry.registerMetric(attendanceOperationFailuresTotal)
registry.registerMetric(attendanceOperationLatencySeconds)
registry.registerMetric(attendanceImportUploadBytesTotal)
registry.registerMetric(attendanceImportUploadRowsTotal)
registry.registerMetric(attendanceImportProcessedRowsTotal)
registry.registerMetric(attendanceImportFailedRowsTotal)
registry.registerMetric(attendanceImportElapsedSeconds)
