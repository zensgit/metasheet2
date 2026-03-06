import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    threads: false,
    include: ['tests/**/*.test.ts'],
    isolate: true
  },
  server: {
    deps: {
      // Inline ESM deps so vite-node provides SSR helpers.
      inline: [/prom-client/, /@opentelemetry\/.*?/]
    }
  },
  ssr: {
    // Ensure these deps are processed by Vite SSR to avoid runtime helper gaps
    noExternal: ['prom-client', /@opentelemetry\/.*?/]
  },
  esbuild: {
    target: 'es2020'
  }
})
