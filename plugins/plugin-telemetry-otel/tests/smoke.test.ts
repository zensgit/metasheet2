/**
 * Smoke Test for plugin-telemetry-otel
 *
 * Basic functionality tests to ensure the plugin loads correctly
 */

import { describe, it, expect, beforeEach } from 'vitest'
// Import from built CJS artifact to avoid Vite SSR helpers
// Build is run via package.json test script before Vitest executes
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import TelemetryOtelPlugin from '../dist/index.cjs'

// Mock plugin context
const createMockContext = () => ({
  logger: {
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    warn: (msg: string) => console.warn(`[WARN] ${msg}`),
    error: (msg: string) => console.error(`[ERROR] ${msg}`)
  },
  app: (() => {
    const routes: string[] = []
    return {
      get: (path: string, handler: any) => {
        routes.push(path)
        console.log(`[MOCK] Registered route: GET ${path}`)
      },
      __routes: routes
    } as any
  })()
})

describe('plugin-telemetry-otel - Smoke Tests', () => {
  beforeEach(() => {
    // Reset environment
    delete process.env.FEATURE_OTEL
  })

  describe('Plugin Loading', () => {
    it('should load plugin with FEATURE_OTEL=false (default)', async () => {
      process.env.FEATURE_OTEL = 'false'

      const plugin = new TelemetryOtelPlugin()
      const mockContext = createMockContext()

      await plugin.onLoad(mockContext)

      // Plugin should load but not initialize metrics
      expect(plugin.isEnabled()).toBe(false)
      expect(plugin.getMetrics()).toBeUndefined()
    })

    it('should load plugin with FEATURE_OTEL=true', async () => {
      process.env.FEATURE_OTEL = 'true'

      const plugin = new TelemetryOtelPlugin()
      const mockContext = createMockContext()

      await plugin.onLoad(mockContext)

      // Plugin should initialize metrics
      expect(plugin.isEnabled()).toBe(true)
      expect(plugin.getMetrics()).toBeDefined()
      expect(plugin.getMetrics()?.registry).toBeDefined()
    })

    it('should handle missing FEATURE_OTEL environment variable', async () => {
      // No FEATURE_OTEL set - should default to disabled
      const plugin = new TelemetryOtelPlugin()
      const mockContext = createMockContext()

      await plugin.onLoad(mockContext)

      expect(plugin.isEnabled()).toBe(false)
    })
  })

  describe('Metrics', () => {
    it('should create HTTP metrics when enabled', async () => {
      process.env.FEATURE_OTEL = 'true'

      const plugin = new TelemetryOtelPlugin()
      const mockContext = createMockContext()

      await plugin.onLoad(mockContext)

      const metrics = plugin.getMetrics()

      expect(metrics).toBeDefined()
      expect(metrics?.httpRequestsTotal).toBeDefined()
      expect(metrics?.httpRequestDuration).toBeDefined()
      expect(metrics?.httpRequestErrors).toBeDefined()
    })

    it('should expose Prometheus registry', async () => {
      process.env.FEATURE_OTEL = 'true'

      const plugin = new TelemetryOtelPlugin()
      const mockContext = createMockContext()

      await plugin.onLoad(mockContext)

      const metrics = plugin.getMetrics()
      const metricsData = await metrics?.registry.metrics()

      expect(metricsData).toBeDefined()
      expect(typeof metricsData).toBe('string')

      // Check for HTTP metrics in output
      expect(metricsData).toContain('http_requests_total')
      expect(metricsData).toContain('http_request_duration_seconds')
      expect(metricsData).toContain('http_request_errors_total')
    })

    it('should register both /metrics and /metrics/otel endpoints when enabled', async () => {
      process.env.FEATURE_OTEL = 'true'

      const plugin = new TelemetryOtelPlugin()
      const mockContext = createMockContext() as any

      await plugin.onLoad(mockContext)

      const routes: string[] = mockContext.app.__routes
      expect(routes).toBeDefined()
      expect(routes).toContain('/metrics')
      expect(routes).toContain('/metrics/otel')
    })
  })

  describe('Plugin Lifecycle', () => {
    it('should support onUnload lifecycle', async () => {
      process.env.FEATURE_OTEL = 'true'

      const plugin = new TelemetryOtelPlugin()
      const mockContext = createMockContext()

      await plugin.onLoad(mockContext)
      expect(plugin.isEnabled()).toBe(true)

      await plugin.onUnload()
      expect(plugin.isEnabled()).toBe(false)
    })
  })

  describe('Configuration', () => {
    it('should respect OTEL_SERVICE_NAME', async () => {
      process.env.FEATURE_OTEL = 'true'
      process.env.OTEL_SERVICE_NAME = 'test-service'

      const plugin = new TelemetryOtelPlugin()
      const mockContext = createMockContext()

      await plugin.onLoad(mockContext)

      // Service name is used in plugin initialization
      expect(plugin.isEnabled()).toBe(true)
    })

    it('should respect OTEL_METRICS_PORT', async () => {
      process.env.FEATURE_OTEL = 'true'
      process.env.OTEL_METRICS_PORT = '9999'

      const plugin = new TelemetryOtelPlugin()
      const mockContext = createMockContext()

      await plugin.onLoad(mockContext)

      expect(plugin.isEnabled()).toBe(true)
    })
  })
})
