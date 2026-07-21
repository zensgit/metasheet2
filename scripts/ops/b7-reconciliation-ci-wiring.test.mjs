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

// B7 CI two-point wiring contract. The suggest-only reconciliation suite proves stale-not-inactive,
// ambiguous-never-auto-match, and zero-write suggest against real Postgres — meaningless without a
// DB. It needs BOTH (1) the vitest.config.ts exclude (so the no-DB job cannot skip-green it) AND
// (2) the plugin-tests.yml directory real-DB whole-file step (the named step that hosts directory
// integration suites). Removing either point silently disables the proof while CI stays green.
// Runs in the gating no-DB test job.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/directory-binding-reconciliation.db.test.ts'

// Located by the step's EXACT stable `id:` in plugin-tests.yml — never by its `- name:` title.
// Title-prefix anchoring was bypassable: an earlier decoy step whose name merely CONTAINS the
// same prefix would capture the guard while the real step was gutted. The shared helper also
// pins EXECUTABILITY of the located step (if 20.x + env.DATABASE_URL + vitest.integration.config.ts),
// so membership of the path in a step that can never run no longer passes.
const STEP_ID = REAL_DB_STEP_IDS.approval

test('vitest.config.ts excludes the B7 reconciliation suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE}`)
})

test('plugin-tests.yml runs the B7 reconciliation suite as a whole file in the directory real-DB step', () => {
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

test('the B7 reconciliation suite file exists on disk', () => {
  // Third point: both wiring texts can stay intact while the suite is renamed/deleted — vitest
  // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
