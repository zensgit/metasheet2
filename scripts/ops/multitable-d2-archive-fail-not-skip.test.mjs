import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const coreBackend = join(repoRoot, 'packages/core-backend')
const vitest = join(repoRoot, 'node_modules/.bin/vitest')
const file = 'tests/integration/multitable-recovery-archive-catalog-realdb.test.ts'

test('the armed D2a real-DB spec fails instead of skipping when DATABASE_URL is absent', () => {
  const env = {
    ...process.env,
    METASHEET_REAL_DB_TEST_STEP: '1',
  }
  delete env.DATABASE_URL

  const result = spawnSync(vitest, ['--config', 'vitest.integration.config.ts', 'run', file, '--reporter=dot'], {
    cwd: coreBackend,
    env,
    encoding: 'utf8',
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  assert.notEqual(result.status, 0, 'the armed real-DB file must fail when DATABASE_URL is absent')
  assert.match(`${result.stdout}\n${result.stderr}`, /recovery_archive_realdb_harness_missing_database_url/)
})
