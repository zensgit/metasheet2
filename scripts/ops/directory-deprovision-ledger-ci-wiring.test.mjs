import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REAL_DB_STEP_IDS, isSuiteWiredInRealDbStep, realDbStepWholeFileArgs } from './ci-realdb-step-contract.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/directory-deprovision-ledger-schema.db.test.ts'
const STEP_ID = REAL_DB_STEP_IDS.approval

test('vitest.config.ts excludes the D3 ledger suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE}`)
})

test('plugin-tests.yml runs the D3 ledger suite as a whole file in the approval real-DB step', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.ok(
    isSuiteWiredInRealDbStep(workflow, STEP_ID, FILE),
    `plugin-tests.yml real-DB step id "${STEP_ID}" must run ${FILE} as a whole-file argument`,
  )
  assert.equal(
    realDbStepWholeFileArgs(workflow, REAL_DB_STEP_IDS.multitable).includes(FILE),
    false,
    `${FILE} must not be wired into the multitable real-DB step`,
  )
})

test('the D3 ledger suite file exists on disk', () => {
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
