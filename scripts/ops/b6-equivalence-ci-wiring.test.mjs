import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// B6 CI two-point wiring contract. The routing-policy schema suite proves the resolver over the (org,purpose)
// policy store's DB invariants (cross-org FK-impossible, closed purpose set, RESTRICT) against real
// Postgres — meaningless without a DB. It needs BOTH (1) the vitest.config.ts exclude (so the no-DB
// job cannot skip-green it) AND (2) the plugin-tests.yml directory real-DB whole-file step. Removing
// either point silently disables the proof while CI stays green. Runs in the gating no-DB test job.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/approval-routing-policy-equivalence.db.test.ts'

test('vitest.config.ts excludes the B6 routing-policy suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE}`)
})

test('plugin-tests.yml runs the B6 routing-policy suite as a whole file in the approval real-DB step', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.match(wf, new RegExp(`\\n\\s*${FILE.replace(/[.]/g, '\\.')} \\\\`), `plugin-tests.yml must run ${FILE}`)
})
