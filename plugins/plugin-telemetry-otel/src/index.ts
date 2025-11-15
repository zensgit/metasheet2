/**
 * OpenTelemetry Plugin Entry Point
 *
 * Minimal implementation for MetaSheet V2 observability
 */

import { loadConfig } from './config'
import { setupMetrics } from './metrics'
import type { Metrics } from './metrics'

export interface PluginContext {
  logger: {
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string) => void
  }
  app?: any // Express app instance (if available)
}

export default class TelemetryOtelPlugin {
  private config = loadConfig()
  private metrics?: Metrics
  private enabled = false

  async onLoad(context: PluginContext): Promise<void> {
    // Check feature flag
    if (!this.config.enabled) {
      context.logger.info('OpenTelemetry plugin is DISABLED (FEATURE_OTEL=false)')
      return
    }

    context.logger.info('Initializing OpenTelemetry plugin...')

    try {
      // Setup metrics
      this.metrics = setupMetrics()
      context.logger.info('✅ Metrics initialized')

      // Register /metrics endpoint if Express app is available
      if (context.app) {
        context.app.get('/metrics', async (req: any, res: any) => {
          if (!this.metrics) {
            res.status(503).send('Metrics not initialized')
            return
          }

          try {
            res.set('Content-Type', this.metrics.registry.contentType)
            const metricsData = await this.metrics.registry.metrics()
            res.end(metricsData)
          } catch (error) {
            res.status(500).send('Failed to collect metrics')
          }
        })

        // Also expose an alias endpoint to avoid conflicts and for clarity
        context.app.get('/metrics/otel', async (req: any, res: any) => {
          if (!this.metrics) {
            res.status(503).send('Metrics not initialized')
            return
          }

          try {
            res.set('Content-Type', this.metrics.registry.contentType)
            const metricsData = await this.metrics.registry.metrics()
            res.end(metricsData)
          } catch (error) {
            res.status(500).send('Failed to collect metrics')
          }
        })

        context.logger.info(`✅ Metrics endpoints registered: /metrics and /metrics/otel (port ${this.config.metricsPort})`)
      }

      this.enabled = true
      context.logger.info('🎉 OpenTelemetry plugin initialized successfully')
    } catch (error) {
      context.logger.error(`Failed to initialize OpenTelemetry: ${error}`)
      throw error
    }
  }

  async onUnload(): Promise<void> {
    // Cleanup resources
    this.enabled = false
  }

  getMetrics(): Metrics | undefined {
    return this.metrics
  }

  isEnabled(): boolean {
    return this.enabled
  }
}
