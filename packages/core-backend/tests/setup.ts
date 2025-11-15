import * as fs from 'fs/promises'
import * as path from 'path'
import { expect, beforeAll, afterAll, vi } from 'vitest'
import { spreadsheetMatchers, responseMatchers } from './utils/test-db'

// Extend expect with custom matchers
expect.extend({
  ...spreadsheetMatchers,
  ...responseMatchers
})

// Global test environment setup with better error handling
beforeAll(async () => {
  const fixturesDir = path.join(__dirname, 'fixtures/test-plugins')
  try {
    await fs.rm(fixturesDir, { recursive: true, force: true })
  } catch (error) {
    // Log warning but don't fail tests
    console.warn('Warning: Could not clean fixtures directory:', error instanceof Error ? error.message : error)
  }

  // Set test environment flags
  process.env.NODE_ENV = 'test'
  process.env.LOG_LEVEL = 'error' // Reduce log noise during tests

  // Mock commonly problematic globals
  vi.stubGlobal('fetch', vi.fn())

  // Increase timeout for async operations
  vi.setConfig({ testTimeout: 30000 })
})

// Enhanced cleanup after all tests
afterAll(async () => {
  try {
    // Clear all mocks and timers
    vi.clearAllMocks()
    vi.clearAllTimers()

    // Force garbage collection if available
    if (global.gc) {
      global.gc()
    }

    // Reset environment
    delete process.env.NODE_ENV
    delete process.env.LOG_LEVEL
  } catch (error) {
    console.warn('Warning: Cleanup failed:', error instanceof Error ? error.message : error)
  }
})