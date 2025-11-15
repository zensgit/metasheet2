import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'PluginTelemetryOtel',
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
      formats: ['es', 'cjs']
    },
    rollupOptions: {
      external: [
        '@metasheet/core-backend',
        '@opentelemetry/api',
        '@opentelemetry/sdk-node',
        '@opentelemetry/instrumentation-http',
        '@opentelemetry/exporter-prometheus',
        '@opentelemetry/exporter-trace-otlp-http',
        'prom-client'
      ],
      output: {
        globals: {
          '@metasheet/core-backend': 'MetasheetCore',
          '@opentelemetry/api': 'OtelAPI',
          'prom-client': 'promClient'
        }
      }
    }
  }
})
