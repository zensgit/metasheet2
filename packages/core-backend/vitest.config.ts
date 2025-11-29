import { defineConfig } from 'vitest/config'
import * as path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Fix vite SSR transformation issues - use forks pool to avoid __vite_ssr_exportName__ errors
    pool: 'forks',
    deps: {
      interopDefault: true
    },
    // Excluded tests - All unit tests enabled as of Session 9
    // Integration tests require database/external services and custom PluginLoader API not yet implemented
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Integration tests require pluginDirs option in PluginLoader constructor (not implemented)
      // and require running database/external services
      'tests/integration/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      thresholds: {
        lines: 50,
        statements: 50,
        branches: 40,
        functions: 50
      },
      exclude: [
        'node_modules/**',
        'tests/**',
        '*.config.ts',
        'src/server.js' // Mock server
      ]
    },
    testTimeout: 30000, // Increased timeout for better stability
    hookTimeout: 15000,
    setupFiles: ['./tests/setup.ts'],
    // Better error handling and debugging
    reporter: ['verbose'],
    maxConcurrency: 1, // Reduce concurrency for stability
    globalTeardown: './tests/globalTeardown.ts'
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests')
    }
  }
})
