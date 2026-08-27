import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const coreBackend = join(repoRoot, 'packages/core-backend')
const vitest = join(repoRoot, 'node_modules/.bin/vitest')
const files = [
  {
    file: 'tests/integration/multitable-recovery-archive-catalog-realdb.test.ts',
    sentinel: 'recovery_archive_realdb_harness_missing_database_url',
  },
  {
    file: 'tests/integration/multitable-recovery-archive-stale-pin-cleanup-realdb.test.ts',
    sentinel: 'recovery_archive_stale_pin_realdb_harness_missing_database_url',
  },
  {
    file: 'tests/integration/multitable-recovery-archive-section-causality-realdb.test.ts',
    sentinel: 'section_causality_realdb_harness_missing_database_url',
  },
  {
    file: 'tests/integration/multitable-recovery-archive-operation-binding-realdb.test.ts',
    sentinel: 'operation_binding_realdb_harness_missing_database_url',
  },
  {
    file: 'tests/integration/multitable-recovery-archive-coverage-binding-realdb.test.ts',
    sentinel: 'recovery_archive_coverage_binding_realdb_harness_missing_database_url',
  },
  {
    file: 'tests/integration/multitable-recovery-archive-crypto-registry-realdb.test.ts',
    sentinel: 'recovery_archive_crypto_registry_realdb_harness_missing_database_url',
  },
  {
    file: 'tests/integration/multitable-recovery-archive-writer-block-realdb.test.ts',
    sentinel: 'recovery_archive_writer_block_realdb_harness_missing_database_url',
  },
]

test('each armed D2 real-DB spec fails instead of skipping when DATABASE_URL is absent', () => {
  for (const { file, sentinel } of files) {
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
    assert.notEqual(result.status, 0, `the armed real-DB file ${file} must fail without DATABASE_URL`)
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(sentinel))
  }
})
