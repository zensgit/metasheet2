import * as fs from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'

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
}
