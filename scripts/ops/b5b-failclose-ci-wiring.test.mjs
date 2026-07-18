import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// B5-b P1 fail-close CI two-point wiring contract. The fail-close suite proves a broken/unreadable
// routing policy fail-closes ALL FOUR org assignee sources at approval create (422/503, zero
// instances, zero assignments) against a real server + real Postgres — meaningless without a DB.
// It needs BOTH (1) the vitest.config.ts exclude (so the no-DB job cannot skip-green it) AND
// (2) the plugin-tests.yml APPROVAL real-DB whole-file step. Removing either point silently
// disables the fail-open regression proof while CI stays green. Runs in the gating no-DB test job.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/approval-routing-policy-failclose.api.test.ts'

test('vitest.config.ts excludes the B5-b routing-policy suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE}`)
})

test('plugin-tests.yml runs the B5-b routing-policy suite as a whole file in the approval real-DB step', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.match(wf, new RegExp(`\\n\\s*${FILE.replace(/[.]/g, '\\.')} \\\\`), `plugin-tests.yml must run ${FILE}`)
})
