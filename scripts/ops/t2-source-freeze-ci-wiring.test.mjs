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
// Same two-point contract for every T2 freeze-linearization suite:
// - the original §12.2 source-freeze suite;
// - the lock-correctness suite (canonical UUID lock key + READ COMMITTED pin, proven on an
//   RR-default pool), added by the T2 lock-correctness ticket.
const FILES = [
  'tests/integration/directory-org-transfer-source-freeze.db.test.ts',
  'tests/integration/directory-source-freeze-lock-correctness.db.test.ts',
]

for (const FILE of FILES) {
  test(`vitest.config.ts excludes ${FILE} from the no-DB job`, () => {
    const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
    assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE} (DATABASE_URL-gated whole file)`)
  })

  test(`plugin-tests.yml runs ${FILE} as a whole file in a real-DB step`, () => {
    const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
    assert.match(wf, new RegExp(`\\n\\s*${FILE.replace(/[.]/g, '\\.')} \\\\`), `plugin-tests.yml must run ${FILE} in a real-DB step`)
  })
}
