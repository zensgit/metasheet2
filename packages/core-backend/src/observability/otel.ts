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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic imports from optional dependencies
  let NodeSDK: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic imports from optional dependencies
  let getNodeAutoInstrumentations: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic imports from optional dependencies
  let ResourcesModule: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic imports from optional dependencies
  let ResourceCtor: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic imports from optional dependencies
  let SemanticResourceAttributes: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic imports from optional dependencies
  let OTLPTraceExporter: any

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    NodeSDK = require('@opentelemetry/sdk-node').NodeSDK
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    getNodeAutoInstrumentations = require('@opentelemetry/auto-instrumentations-node').getNodeAutoInstrumentations
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ResourcesModule = require('@opentelemetry/resources')
    ResourceCtor = ResourcesModule.Resource || ResourcesModule.default
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const semantic = require('@opentelemetry/semantic-conventions')
    SemanticResourceAttributes = semantic.SemanticResourceAttributes || semantic.default?.SemanticResourceAttributes
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    OTLPTraceExporter = require('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter
  } catch (err) {
    logger.warn('OTEL_ENABLED=true but OpenTelemetry packages are not installed; tracing skipped', err instanceof Error ? err : undefined)
    return { enabled: false, started: false, reason: 'missing-deps' }
  }

  if (!ResourceCtor || !SemanticResourceAttributes) {
    logger.warn('OTEL_ENABLED=true but @opentelemetry/resources or semantic-conventions exports not found; tracing skipped')
    return { enabled: false, started: false, reason: 'missing-resource' }
  }

  const resource = new ResourceCtor({
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
