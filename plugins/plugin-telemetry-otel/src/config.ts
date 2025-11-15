/**
 * OpenTelemetry Plugin Configuration
 */

export interface OtelConfig {
  enabled: boolean
  serviceName: string
  metricsPort: number
  tracingSampleRate: number
}

export function loadConfig(): OtelConfig {
  return {
    enabled: process.env.FEATURE_OTEL === 'true',
    serviceName: process.env.OTEL_SERVICE_NAME || 'metasheet-v2',
    metricsPort: parseInt(process.env.OTEL_METRICS_PORT || '9464'),
    tracingSampleRate: parseFloat(process.env.OTEL_TRACE_SAMPLE_RATE || '0.1')
  }
}
