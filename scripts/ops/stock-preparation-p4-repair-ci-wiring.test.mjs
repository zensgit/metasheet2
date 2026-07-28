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

// P4 Option C needs both points: exclusion from the no-DB default job, and a whole-file invocation
// in the required real-DB job. Losing either point would turn the repair proof into a silent skip.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/stock-preparation-p4-repair-once-realdb.test.ts'

// In plugin-tests.yml this suite runs inside the real-DB step carrying the EXACT stable id
// `multitable-real-db-integration` — the only step that hands it a live Postgres. The guard locates
// that step by id, never by its `- name:` title (an earlier decoy step whose name merely CONTAINS
// the same prefix used to capture the guard while the real step was gutted), and the shared helper
// pins EXECUTABILITY of it (if 20.x + env.DATABASE_URL + vitest.integration.config.ts) — so a path
// sitting in a step that can never run no longer passes.
const STEP_ID = REAL_DB_STEP_IDS.multitable

test('vitest.config.ts excludes the P4 repair suite from the no-DB job', () => {
  const config = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(config.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE}`)
})

test('plugin-tests.yml runs the P4 repair suite as a whole file in the multitable real-DB step (id: multitable-real-db-integration)', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.ok(
    isSuiteWiredInRealDbStep(workflow, STEP_ID, FILE),
    `plugin-tests.yml real-DB step id "${STEP_ID}" (if 20.x + env.DATABASE_URL + `
      + `vitest.integration.config.ts) must run ${FILE} as a whole-file vitest arg`,
  )
  // Negative: must not be the sole (or any) placement under the approval real-DB step.
  assert.equal(
    realDbStepWholeFileArgs(workflow, REAL_DB_STEP_IDS.approval).includes(FILE),
    false,
    `${FILE} must not be wired into the approval real-DB step`,
  )
})

test('the P4 repair suite file exists on disk', () => {
  // Third point: both wiring texts can stay intact while the suite is renamed/deleted — vitest
  // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
