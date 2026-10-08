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

// Two-point wiring for directory-activation-source-lock.db.test.ts (post-merge review P1 —
// FOR SHARE on the T3 activation source read). External contract, mirroring the grant-table
// sibling: the suite's own in-file self-check only runs IF the suite runs, so it cannot detect
// its OWN removal from the run list. This contract runs in integration-guard (no DB), so
// dropping EITHER wiring point reds a required check.
// (1) vitest.config.ts test.exclude — the no-DB job cannot skip-green it
// (2) plugin-tests.yml approval real-DB whole-file step — required 20.x + DATABASE_URL
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/directory-activation-source-lock.db.test.ts'
const STEP_ID = REAL_DB_STEP_IDS.approval

test('vitest.config.ts excludes the activation-source-lock suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE}`)
})

test('plugin-tests.yml runs the activation-source-lock suite as a whole file in the approval real-DB step', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.ok(
    isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
    `plugin-tests.yml real-DB step id "${STEP_ID}" must run ${FILE} as a whole-file vitest arg`,
  )
  assert.equal(
    realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable).includes(FILE),
    false,
    `${FILE} must not be wired into the multitable real-DB step`,
  )
})

test('the activation-source-lock suite file exists on disk', () => {
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
