import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// B7 owner-round CI two-point wiring contract: the binding admin-routes suite and the Q6 post-sync
// hook suite are real-DB proofs (the hook one drives the REAL sync). Each needs BOTH the
// vitest.config.ts exclude (no skip-green) AND its plugin-tests.yml real-DB whole-file step.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILES = [
  'tests/integration/directory-binding-admin-routes.db.test.ts',
  'tests/integration/directory-binding-sync-hook.db.test.ts',
]

test('vitest.config.ts excludes both B7 round-2 suites from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  for (const f of FILES) assert.ok(cfg.includes(`'${f}'`), `vitest.config.ts must exclude ${f}`)
})

test('plugin-tests.yml runs both B7 round-2 suites as whole files in real-DB steps', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  for (const f of FILES) assert.match(wf, new RegExp(`\\n\\s*${f.replace(/[.]/g, '\\.')} \\\\`), `plugin-tests.yml must run ${f}`)
})
