/**
 * Observability configuration loader.
 */

export interface ObservabilityConfig {
  enabled: boolean
  endpoint?: string
  headers?: Record<string, string>
  serviceName: string
  samplerRatio: number
  strict: boolean
}

function parseHeaders(raw?: string): Record<string, string> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed
  } catch {
    const headers: Record<string, string> = {}
    raw.split(',').forEach(pair => {
      const [k, ...rest] = pair.split('=')
      if (k && rest.length) headers[k.trim()] = rest.join('=').trim()
    })
    return Object.keys(headers).length ? headers : undefined
  }
}

export function loadObservabilityConfig(): ObservabilityConfig {
  const enabled = process.env.OTEL_ENABLED === 'true'
  const samplerRatio = parseFloat(process.env.OTEL_SAMPLER_RATIO || '1')
  return {
    enabled,
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: parseHeaders(process.env.OTEL_HEADERS),
    serviceName: process.env.OTEL_SERVICE_NAME || 'metasheet-core',
    samplerRatio: Number.isFinite(samplerRatio) ? samplerRatio : 1,
    strict: process.env.OTEL_STRICT === 'true'
  }
}
