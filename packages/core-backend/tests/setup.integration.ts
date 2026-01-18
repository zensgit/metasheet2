import * as fs from 'fs/promises'
import * as path from 'path'
import { beforeAll, afterAll, vi } from 'vitest'

process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'error'
process.env.RBAC_BYPASS = 'true'
process.env.RBAC_TOKEN_TRUST = 'true'

beforeAll(async () => {
  const fixturesDir = path.join(__dirname, 'fixtures/test-plugins')
  try {
    await fs.rm(fixturesDir, { recursive: true, force: true })
  } catch (error) {
    console.warn('Warning: Could not clean fixtures directory:', error instanceof Error ? error.message : error)
  }

  vi.setConfig({ testTimeout: 30000 })
})

afterAll(async () => {
  try {
    vi.clearAllMocks()
    vi.clearAllTimers()

    if (global.gc) {
      global.gc()
    }

    delete process.env.NODE_ENV
    delete process.env.LOG_LEVEL
    delete process.env.RBAC_BYPASS
    delete process.env.RBAC_TOKEN_TRUST
  } catch (error) {
    console.warn('Warning: Cleanup failed:', error instanceof Error ? error.message : error)
  }
})
