import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REAL_DB_STEP_IDS,
  isQuotedInTestExclude,
  isSuiteWiredInRealDbStep,
  realDbStepWholeFileArgs,
  requireExecutableRealDbStep,
} from './ci-realdb-step-contract.mjs'

/**
 * CI wiring for the approval routing real-DB suites. Each suite must be (1) excluded from the
 * no-DB unit job by a real `test.exclude` entry, (2) run exactly once as a whole-file argument of
 * the approval real-DB step (Node 20.x, literal DATABASE_URL, integration config), (3) absent from
 * the multitable real-DB step, (4) present on disk, and (5) armed with the EXPECT_DB sentinel at
 * module top level so a missing database fails instead of skipping.
 */
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const STEP_ID = REAL_DB_STEP_IDS.approval
const SUITES = [
  'tests/integration/approval-routing-policy-required.db.test.ts',
  'tests/integration/approval-routing-policy-required.api.test.ts',
]

const vitestConfig = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')

test('the approval real-DB step is executable under the shared four-pin contract', () => {
  assert.doesNotThrow(() => requireExecutableRealDbStep(workflow, STEP_ID))
})

for (const file of SUITES) {
  test(`${file}: excluded from the no-DB job by a structured test.exclude entry`, () => {
    assert.ok(isQuotedInTestExclude(vitestConfig, file), `vitest.config.ts test.exclude must list ${file}`)
  })

  test(`${file}: wired whole-file into the approval real-DB step, exactly once, and not into the multitable step`, () => {
    assert.ok(
      isSuiteWiredInRealDbStep(workflow, STEP_ID, file),
      `plugin-tests.yml real-DB step id "${STEP_ID}" must run ${file} as a whole-file argument`,
    )
    assert.equal(realDbStepWholeFileArgs(workflow, STEP_ID).filter((arg) => arg === file).length, 1)
    assert.equal(
      realDbStepWholeFileArgs(workflow, REAL_DB_STEP_IDS.multitable).includes(file),
      false,
      `${file} must not be wired into the multitable real-DB step`,
    )
  })

  test(`${file}: exists on disk and carries the EXPECT_DB sentinel at module top level`, () => {
    const path = join(repoRoot, 'packages/core-backend', file)
    assert.ok(existsSync(path), `wired suite packages/core-backend/${file} must exist on disk`)
    const source = readFileSync(path, 'utf8')
    assert.match(source, /^const describeIfDatabase = process\.env\.DATABASE_URL \? describe : describe\.skip$/m)
    assert.match(source, /^const EXPECT_DB = process\.env\.EXPECT_DB === '1'$/m)
    assert.match(source, /^const itIfExpectDb = EXPECT_DB \? it : it\.skip$/m)
    assert.match(source, /^itIfExpectDb\('requires a real DB'/m)
    // The sentinel is registered before, and outside, the DATABASE_URL-gated describe.
    assert.ok(source.indexOf("itIfExpectDb('requires a real DB'") < source.indexOf('describeIfDatabase('))
    assert.equal(source.split('itIfExpectDb(').length - 1, 1)
  })
}

test('the wiring contract rejects a de-listed, an unexcluded and an unarmed suite (positive control)', () => {
  for (const file of SUITES) {
    const line = `            ${file} \\\n`
    assert.ok(workflow.includes(line), `expected the exact run-list line for ${file}`)
    assert.equal(isSuiteWiredInRealDbStep(workflow.replace(line, ''), STEP_ID, file), false)
    assert.equal(realDbStepWholeFileArgs(workflow.replace(line, line + line), STEP_ID).filter((arg) => arg === file).length, 2)
    const quoted = `'${file}',`
    assert.ok(vitestConfig.includes(quoted))
    assert.equal(isQuotedInTestExclude(vitestConfig.replace(quoted, ''), file), false)
  }
})
