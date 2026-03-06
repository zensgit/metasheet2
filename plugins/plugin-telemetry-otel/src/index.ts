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
  app?: TelemetryHttpApp
}

interface TelemetryHttpResponse {
  status(code: number): {
    send(body: string): void
  }
  set(name: string, value: string): void
  end(body: string): void
}

type TelemetryHttpHandler = (_request: unknown, response: TelemetryHttpResponse) => Promise<void> | void

interface TelemetryHttpApp {
  get(path: string, handler: TelemetryHttpHandler): void
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
        context.app.get('/metrics', async (_request, response) => {
          if (!this.metrics) {
            response.status(503).send('Metrics not initialized')
            return
          }

          try {
            response.set('Content-Type', this.metrics.registry.contentType)
            const metricsData = await this.metrics.registry.metrics()
            response.end(metricsData)
          } catch (error) {
            response.status(500).send('Failed to collect metrics')
          }
        })

        // Also expose an alias endpoint to avoid conflicts and for clarity
        context.app.get('/metrics/otel', async (_request, response) => {
          if (!this.metrics) {
            response.status(503).send('Metrics not initialized')
            return
          }

          try {
            response.set('Content-Type', this.metrics.registry.contentType)
            const metricsData = await this.metrics.registry.metrics()
            response.end(metricsData)
          } catch (error) {
            response.status(500).send('Failed to collect metrics')
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
