import * as fs from 'fs/promises'
import * as path from 'path'
import { beforeAll, afterAll, vi } from 'vitest'
import { setSettlementCoordinationNestingModeV1 } from '../src/attendance/coordination/settlement-coordination-context'

// Settlement coordination (P1-1, r6.1 §3.2 step 11, acceptance A11): the real-database suites refuse a
// main-pool access inside a live coordination context, as the unit setup does (tests/setup.ts). Production
// only counts it.
setSettlementCoordinationNestingModeV1('throw')

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
