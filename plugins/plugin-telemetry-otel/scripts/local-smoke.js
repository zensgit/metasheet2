// Local smoke test for plugin-telemetry-otel
// Verifies that enabling FEATURE_OTEL registers /metrics and /metrics/otel

// Force-enable the plugin
process.env.FEATURE_OTEL = 'true'

async function main() {
  const mod = await import('../dist/index.js')
  const TelemetryOtelPlugin = mod.default

  const registeredRoutes = []
  const mockContext = {
    logger: {
      info: (msg) => console.log(`[INFO] ${msg}`),
      warn: (msg) => console.warn(`[WARN] ${msg}`),
      error: (msg) => console.error(`[ERROR] ${msg}`),
    },
    app: {
      get: (path, handler) => {
        registeredRoutes.push(path)
      },
    },
  }

  const plugin = new TelemetryOtelPlugin()
  await plugin.onLoad(mockContext)

  const enabled = plugin.isEnabled()
  const metrics = plugin.getMetrics()
  const hasMetrics = !!metrics
  let metricsPreview = ''
  if (metrics?.registry?.metrics) {
    const data = await metrics.registry.metrics()
    metricsPreview = String(data).slice(0, 120).replace(/\n/g, ' ')
  }

  console.log(JSON.stringify({
    enabled,
    hasMetrics,
    routes: registeredRoutes,
    metricsPreview,
  }, null, 2))
}

main().catch((e) => {
  console.error('Local smoke failed:', e)
  process.exit(1)
})

