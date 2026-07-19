import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// P4 Option C needs both points: exclusion from the no-DB default job, and a whole-file invocation
// in the required real-DB job. Losing either point would turn the repair proof into a silent skip.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/stock-preparation-p4-repair-once-realdb.test.ts'

test('vitest.config.ts excludes the P4 repair suite from the no-DB job', () => {
  const config = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(config.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE}`)
})

test('plugin-tests.yml runs the P4 repair suite as a whole file with real Postgres', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.match(
    workflow,
    new RegExp(`\\n\\s*${FILE.replace(/[.]/g, '\\.')} \\\\`),
    `plugin-tests.yml must run ${FILE} as a whole file`,
  )
})
