import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  REAL_DB_STEP_IDS,
  isSuiteWiredInRealDbStep,
  realDbStepWholeFileArgs,
} from './ci-realdb-step-contract.mjs'

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

// Located by the step's EXACT stable `id:` in plugin-tests.yml — never by its `- name:` title.
// Title-prefix anchoring was bypassable: an earlier decoy step whose name merely CONTAINS the
// same prefix would capture the guard while the real step was gutted. The shared helper also
// pins EXECUTABILITY of the located step (if 20.x + env.DATABASE_URL + vitest.integration.config.ts),
// so membership of the path in a step that can never run no longer passes.
const STEP_ID = REAL_DB_STEP_IDS.approval

test('vitest.config.ts excludes the T2 source-freeze suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE} (DATABASE_URL-gated whole file)`)
})

test('plugin-tests.yml runs the T2 source-freeze suite as a whole file in a real-DB step', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.ok(
    isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
    `plugin-tests.yml real-DB step id "${STEP_ID}" (if 20.x + env.DATABASE_URL + `
      + `vitest.integration.config.ts) must run ${FILE} as a whole-file vitest arg`,
  )
  // Negative: must not be the sole (or any) placement under multitable real-DB.
  assert.equal(
    realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable).includes(FILE),
    false,
    `${FILE} must not be wired into the multitable real-DB step`,
  )
})

test('the T2 source-freeze suite file exists on disk', () => {
  // Third point: both wiring texts can stay intact while the suite is renamed/deleted — vitest
  // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
