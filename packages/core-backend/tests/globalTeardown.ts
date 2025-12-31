import * as fs from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { poolManager } from '../src/integration/db/connection-pool'
import { pool } from '../src/db/pg'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default async function globalTeardown() {
  // Clean up test fixtures after all tests
  const fixturesDir = path.join(__dirname, 'fixtures/test-plugins')
  try {
    await fs.rm(fixturesDir, { recursive: true, force: true })
  } catch {
    // Ignore if doesn't exist
  }

  // Additional cleanup for potential resource leaks
  if (global.gc) {
    global.gc()
  }

  try {
    await poolManager.close()
  } catch {
    // ignore pool cleanup errors
  }

  try {
    if (pool) {
      await pool.end()
    }
  } catch {
    // ignore legacy pool cleanup errors
  }

  const exitTimer = setTimeout(() => {
    process.exit(process.exitCode ?? 0)
  }, 100)
  if (exitTimer.unref) {
    exitTimer.unref()
  }
}
