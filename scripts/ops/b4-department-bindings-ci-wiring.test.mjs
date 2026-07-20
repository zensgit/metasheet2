import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// B4 CI two-point wiring contract. The department-bindings suite proves the buildable FK chain makes
// a cross-org binding FK-impossible (and that the NOT NULL closes the MATCH SIMPLE hole) against real
// Postgres — meaningless without a DB. It needs BOTH (1) the vitest.config.ts exclude entry (so the
// no-DB job cannot skip-green it) AND (2) the plugin-tests.yml directory real-DB whole-file step (so
// a real-DB run actually names it). Removing either point makes the entire FK-chain proof silently
// never execute while exact-head CI stays green. This source-level guard (no DB) reddens if either
// point is dropped. It runs in the no-DB `test` job, so it gates every PR.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/directory-department-bindings.db.test.ts'

test('vitest.config.ts excludes the B4 department-bindings suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE} (DATABASE_URL-gated whole file)`)
})

test('plugin-tests.yml runs the B4 department-bindings suite as a whole file in the directory real-DB step', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.match(wf, new RegExp(`\\n\\s*${FILE.replace(/[.]/g, '\\.')} \\\\`), `plugin-tests.yml must run ${FILE} in the directory real-DB step`)
})

test('the B4 department-bindings suite file exists on disk', () => {
  // Third point: both wiring texts can stay intact while the suite is renamed/deleted — vitest
  // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
