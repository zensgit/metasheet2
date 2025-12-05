/**
 * Lightweight OpenTelemetry bootstrapper.
 * Uses optional deps; will log and skip if packages are missing.
 */

import { Logger } from '../core/logger'
import type { ObservabilityConfig } from '../config/observability'

interface InitResult {
  enabled: boolean
  started: boolean
  reason?: string
  shutdown?: () => Promise<void>
}

function parseHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k.trim(), v])
  )
}

export async function initObservability(config: ObservabilityConfig, logger = new Logger('Observability')): Promise<InitResult> {
  if (!config.enabled) {
    return { enabled: false, started: false, reason: 'disabled' }
  }

  let NodeSDK: any
  let getNodeAutoInstrumentations: any
  let Resource: any
  let SemanticResourceAttributes: any
  let OTLPTraceExporter: any

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    NodeSDK = require('@opentelemetry/sdk-node').NodeSDK
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    getNodeAutoInstrumentations = require('@opentelemetry/auto-instrumentations-node').getNodeAutoInstrumentations
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Resource = require('@opentelemetry/resources').Resource
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    SemanticResourceAttributes = require('@opentelemetry/semantic-conventions').SemanticResourceAttributes
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    OTLPTraceExporter = require('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter
  } catch (err) {
    logger.warn('OTEL_ENABLED=true but OpenTelemetry packages are not installed; tracing skipped', err instanceof Error ? err : undefined)
    return { enabled: false, started: false, reason: 'missing-deps' }
  }

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development'
  })

  const exporter =
    config.endpoint
      ? new OTLPTraceExporter({
          url: config.endpoint,
          headers: parseHeaders(config.headers)
        })
      : undefined

  const sampler =
    config.samplerRatio < 1
      ? {
          shouldSample: () => ({ decision: Math.random() < config.samplerRatio ? 1 : 0 }),
          toString: () => `RatioSampler(${config.samplerRatio})`
        }
      : undefined

  const sdk = new NodeSDK({
    resource,
    traceExporter: exporter,
    sampler,
    instrumentations: typeof getNodeAutoInstrumentations === 'function' ? [getNodeAutoInstrumentations()] : []
  })

  try {
    await sdk.start()
    logger.info('OpenTelemetry initialized', {
      endpoint: config.endpoint || 'console',
      samplerRatio: config.samplerRatio
    })
    return {
      enabled: true,
      started: true,
      shutdown: () => sdk.shutdown()
    }
  } catch (err) {
    if (config.strict) {
      throw err instanceof Error ? err : new Error(String(err))
    }
    logger.warn('OpenTelemetry initialization failed; continuing without tracing', err instanceof Error ? err : undefined)
    return { enabled: false, started: false, reason: 'init-failed' }
  }
}
