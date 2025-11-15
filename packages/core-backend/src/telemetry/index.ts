/**
 * Telemetry initialization and setup
 */

import { getTelemetry } from '../services/TelemetryService'
import { getConfig } from '../config'
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
      serviceVersion: (process as any).env.npm_package_version || '1.0.0',
      environment: (process.env.NODE_ENV as string) || 'development',
      jaegerEndpoint: (app as any)?.telemetry?.jaegerEndpoint,
      prometheusPort: Number((app as any)?.telemetry?.prometheusPort ?? 0),
      enableAutoInstrumentation: String((app as any)?.telemetry?.autoInstrumentation) === 'true',
      enableMetrics: String((app as any)?.telemetry?.metricsEnabled) === 'true',
      enableTracing: String((app as any)?.telemetry?.tracingEnabled) === 'true',
      samplingRate: Number((app as any)?.telemetry?.samplingRate ?? 1)
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
export async function restartTelemetryIfNeeded(oldCfg: any, newCfg: any) {
  const wasEnabled = oldCfg?.telemetry?.enabled === 'true'
  const nowEnabled = newCfg?.telemetry?.enabled === 'true'
  const criticalKeys = ['jaegerEndpoint','prometheusPort','tracingEnabled','metricsEnabled','autoInstrumentation','samplingRate']
  const changed = criticalKeys.filter(k => (oldCfg?.telemetry?.[k] ?? undefined) !== (newCfg?.telemetry?.[k] ?? undefined))
  let restarted = false
  if (nowEnabled) {
    // If newly enabled or critical fields changed
    if (!wasEnabled || changed.length > 0) {
      try {
        const inst = await initializeTelemetry() // initializeTelemetry re-inits or warns if already started
        restarted = !!inst
      } catch {
        restarted = false
      }
    }
  }
  // Update sampling rate gauge (even if disabled set to 0)
  try {
    metrics.configSamplingRate.set(nowEnabled ? (newCfg.telemetry.samplingRate || 0) : 0)
  } catch {}
  return { restarted, changed }
}

export { StructuredLogger, MetricsCollector, Trace } from '../services/TelemetryService'
