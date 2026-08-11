import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REAL_DB_STEP_IDS, isSuiteWiredInRealDbStep, realDbStepWholeFileArgs } from './ci-realdb-step-contract.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILES = [
  'tests/integration/directory-deprovision-ledger-schema.db.test.ts',
  'tests/integration/directory-deprovision-writer-ledger.db.test.ts',
  'tests/integration/directory-deprovision-race-supersede.db.test.ts',
]
const STEP_ID = REAL_DB_STEP_IDS.approval

test('vitest.config.ts excludes every D3/D4 ledger suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  for (const file of FILES) {
    assert.ok(cfg.includes(`'${file}'`), `vitest.config.ts must exclude ${file}`)
  }
})

test('plugin-tests.yml runs every D3/D4 ledger suite as a whole file in the approval real-DB step', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  for (const file of FILES) {
    assert.ok(
      isSuiteWiredInRealDbStep(workflow, STEP_ID, file),
      `plugin-tests.yml real-DB step id "${STEP_ID}" must run ${file} as a whole-file argument`,
    )
    assert.equal(
      realDbStepWholeFileArgs(workflow, REAL_DB_STEP_IDS.multitable).includes(file),
      false,
      `${file} must not be wired into the multitable real-DB step`,
    )
  }
})

test('every wired D3/D4 ledger suite file exists on disk', () => {
  for (const file of FILES) {
    assert.ok(
      existsSync(join(repoRoot, 'packages/core-backend', file)),
      `wired suite packages/core-backend/${file} must exist on disk`,
    )
  }
})
