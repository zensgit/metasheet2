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

// Two-point wiring for the grant-table and OPS-01 compensation real-DB suites:
// (1) vitest.config.ts test.exclude — no-DB job cannot skip-green
// (2) plugin-tests.yml approval real-DB whole-file step — required 20.x + DATABASE_URL
// Removing either point must red this contract.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILES = [
  'tests/integration/directory-deprovision-grant-table.db.test.ts',
  'tests/integration/directory-deprovision-compensation.db.test.ts',
]
const STEP_ID = REAL_DB_STEP_IDS.approval

test('vitest.config.ts excludes both grant suites from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  for (const file of FILES) {
    assert.ok(cfg.includes(`'${file}'`), `vitest.config.ts must exclude ${file}`)
  }
})

test('plugin-tests.yml runs both grant suites as whole files in the approval real-DB step', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  for (const file of FILES) {
    assert.ok(
      isSuiteWiredInRealDbStep(wf, STEP_ID, file),
      `plugin-tests.yml real-DB step id "${STEP_ID}" must run ${file} as a whole-file vitest arg`,
    )
    assert.equal(
      realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable).includes(file),
      false,
      `${file} must not be wired into the multitable real-DB step`,
    )
  }
})

test('both wired grant suite files exist on disk', () => {
  for (const file of FILES) {
    assert.ok(
      existsSync(join(repoRoot, 'packages/core-backend', file)),
      `wired suite packages/core-backend/${file} must exist on disk`,
    )
  }
})
