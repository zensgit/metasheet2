import * as fs from 'fs/promises'
import * as path from 'path'
import { expect, beforeAll, afterAll, vi } from 'vitest'
import { spreadsheetMatchers } from './utils/test-db'

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  RBAC_TOKEN_TRUST: process.env.RBAC_TOKEN_TRUST,
  JWT_SECRET: process.env.JWT_SECRET,
  DISABLE_WORKFLOW: process.env.DISABLE_WORKFLOW,
}

// Ensure auth/rbac flags are set before modules evaluate env at import time.
process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'error'
process.env.RBAC_TOKEN_TRUST = 'true'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret'
process.env.DISABLE_WORKFLOW = 'true'

// Extend expect with custom matchers
expect.extend({
  ...spreadsheetMatchers
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

  // Mock fetch only when the runtime does not provide it
  if (typeof globalThis.fetch !== 'function') {
    vi.stubGlobal('fetch', vi.fn())
  }

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

    // Reset environment to original values
    if (originalEnv.NODE_ENV === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalEnv.NODE_ENV
    }
    if (originalEnv.LOG_LEVEL === undefined) {
      delete process.env.LOG_LEVEL
    } else {
      process.env.LOG_LEVEL = originalEnv.LOG_LEVEL
    }
    if (originalEnv.RBAC_TOKEN_TRUST === undefined) {
      delete process.env.RBAC_TOKEN_TRUST
    } else {
      process.env.RBAC_TOKEN_TRUST = originalEnv.RBAC_TOKEN_TRUST
    }
    if (originalEnv.JWT_SECRET === undefined) {
      delete process.env.JWT_SECRET
    } else {
      process.env.JWT_SECRET = originalEnv.JWT_SECRET
    }
    if (originalEnv.DISABLE_WORKFLOW === undefined) {
      delete process.env.DISABLE_WORKFLOW
    } else {
      process.env.DISABLE_WORKFLOW = originalEnv.DISABLE_WORKFLOW
    }
  } catch (error) {
    console.warn('Warning: Cleanup failed:', error instanceof Error ? error.message : error)
  }
})
