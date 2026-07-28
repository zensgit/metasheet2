import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const files = [
  'tests/integration/approval-attachment-gc-realdb.test.ts',
  'tests/integration/approval-attachment-bind-reconcile-realdb.test.ts',
  'tests/integration/approval-attachment-pipeline-realdb.test.ts',
  'tests/integration/approval-attachment-scan-purge-upgrade-migration.db.test.ts',
  'tests/integration/multitable-fwb-activation-realdb.test.ts',
  'tests/integration/multitable-p2-fwb-eight-scenario-matrix.test.ts',
]

const config = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')

for (const file of files) {
  test(`default no-DB collection excludes ${file}`, () => {
    assert.ok(config.includes(`'${file}'`), `vitest.config.ts must exclude ${file}`)
  })

  test(`required real-DB CI invokes ${file} as a whole file`, () => {
    assert.match(
      workflow,
      new RegExp(`\\n\\s*${file.replace(/[.]/g, '\\.')} \\\\`),
      `plugin-tests.yml must run ${file} as a whole file`,
    )
  })
}
