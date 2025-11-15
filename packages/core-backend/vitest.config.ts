import { defineConfig } from 'vitest/config'
import * as fs from 'fs/promises'
import * as path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
    // Improve test isolation and stability
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true // Force single thread to avoid race conditions
      }
    },
    // Better error handling and debugging
    reporter: ['verbose'],
    maxConcurrency: 1, // Reduce concurrency for stability
    globalTeardown: async () => {
      // Clean up test fixtures after all tests
      const fixturesDir = path.join(__dirname, 'tests/fixtures/test-plugins')
      try {
        await fs.rm(fixturesDir, { recursive: true, force: true })
      } catch {
        // Ignore if doesn't exist
      }

      // Additional cleanup for potential resource leaks
      if (global.gc) {
        global.gc()
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests')
    }
  }
})
