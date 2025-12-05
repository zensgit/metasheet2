/**
 * Telemetry initialization and setup
 */

import { getTelemetry } from '../services/TelemetryService'
import { getConfig } from '../config/index'
import type { AppConfig } from '../config/index'
import { metrics } from '../metrics/metrics'
import { Logger } from '../core/logger'

const logger = new Logger('Telemetry')

/**
 * Initialize OpenTelemetry
 * Should be called at application startup before any other code
 */
export async function initializeTelemetry() {
  try {
    const app = getConfig()
    const telemetry = getTelemetry({
      serviceName: 'metasheet-backend',
      serviceVersion: process.env.npm_package_version || '1.0.0',
      environment: (process.env.NODE_ENV as string) || 'development',
      jaegerEndpoint: app.telemetry.jaegerEndpoint,
      prometheusPort: Number(app.telemetry.prometheusPort ?? 0),
      enableAutoInstrumentation: app.telemetry.autoInstrumentation === 'true',
      enableMetrics: app.telemetry.metricsEnabled === 'true',
      enableTracing: app.telemetry.tracingEnabled === 'true',
      samplingRate: Number(app.telemetry.samplingRate ?? 1)
    })

    await telemetry.initialize()

    // Register shutdown handler
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down telemetry...')
      await telemetry.shutdown()
    })

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down telemetry...')
      await telemetry.shutdown()
    })

    logger.info('Telemetry initialized successfully')
    return telemetry

  } catch (error) {
    logger.error('Failed to initialize telemetry', error as Error)
    // Don't fail the application if telemetry fails
    return null
  }
}

/**
 * Get telemetry instance
 */
export function getTelemetryInstance() {
  return getTelemetry()
}

/**
 * Restart telemetry when critical config changes
 */
export async function restartTelemetryIfNeeded(oldCfg: AppConfig, newCfg: AppConfig) {
  const wasEnabled = oldCfg.telemetry.enabled === 'true'
  const nowEnabled = newCfg.telemetry.enabled === 'true'
  const criticalKeys = ['jaegerEndpoint','prometheusPort','tracingEnabled','metricsEnabled','autoInstrumentation','samplingRate'] as const
  const changed = criticalKeys.filter(k => {
    const oldVal = oldCfg.telemetry[k]
    const newVal = newCfg.telemetry[k]
    return oldVal !== newVal
  })
  let restarted = false
  if (nowEnabled) {
    // If newly enabled or critical fields changed
    if (!wasEnabled || changed.length > 0) {
      try {
        const inst = await initializeTelemetry() // initializeTelemetry re-inits or warns if already started
        restarted = !!inst
      } catch (error) {
        logger.warn(`Failed to restart telemetry: ${error instanceof Error ? error.message : String(error)}`)
        restarted = false
      }
    }
  }
  // Update sampling rate gauge (even if disabled set to 0)
  try {
    metrics.configSamplingRate.set(nowEnabled ? (newCfg.telemetry.samplingRate || 0) : 0)
  } catch (error) {
    logger.debug(`Failed to set sampling rate metric: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { restarted, changed }
}

export { StructuredLogger, MetricsCollector, Trace } from '../services/TelemetryService'
