import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// T2 CI two-point wiring contract. The source-freeze suite proves an ACTIVE org transfer freezes
// its source integration's sync (typed 409 before the lease claim, zero run rows, the destructive
// absence sweep provably blocked — with the freeze_source_sync=false override as the positive
// control) against the REAL syncDirectoryIntegration + real Postgres — meaningless without a DB.
// It needs BOTH (1) the vitest.config.ts exclude entry (so the no-DB job cannot skip-green it)
// AND (2) the plugin-tests.yml approval real-DB whole-file step. Removing either point silently
// disables the §12.2 freeze proof while CI stays green. Runs in the gating no-DB test job.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/directory-org-transfer-source-freeze.db.test.ts'

test('vitest.config.ts excludes the T2 source-freeze suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE} (DATABASE_URL-gated whole file)`)
})

test('plugin-tests.yml runs the T2 source-freeze suite as a whole file in a real-DB step', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.match(wf, new RegExp(`\\n\\s*${FILE.replace(/[.]/g, '\\.')} \\\\`), `plugin-tests.yml must run ${FILE} in a real-DB step`)
})
