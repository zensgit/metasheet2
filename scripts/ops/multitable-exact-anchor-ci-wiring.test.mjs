import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// W0 L6-b CI two-point wiring contract. The exact-anchor authority suite is DATABASE_URL-gated and
// must have BOTH (1) a vitest.config.ts exclusion so the no-DB lane cannot skip-green it and (2) a
// whole-file entry in plugin-tests.yml's multitable real-DB step. Removing either point must fail CI.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/multitable-exact-anchor-recovery-realdb.test.ts'

test('vitest.config.ts excludes the exact-anchor authority suite from the no-DB job', () => {
  const config = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(config.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE}`)
})

test('plugin-tests.yml runs the exact-anchor authority suite as a whole file with real Postgres', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.match(
    workflow,
    new RegExp(`\\n\\s*${FILE.replace(/[.]/g, '\\.')} \\\\`),
    `plugin-tests.yml must run ${FILE} in the multitable real-DB step`,
  )
})
