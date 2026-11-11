import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  REAL_DB_STEP_IDS,
  isQuotedInTestExclude,
  isSuiteWiredInRealDbStep,
  realDbStepWholeFileArgs,
  requireExecutableRealDbStep,
} from '../../../../scripts/ops/ci-realdb-step-contract.mjs'

/**
 * Real-DB CI wiring of the directory integration lifecycle history suite.
 *
 * Pins, for `tests/integration/directory-integration-lifecycle-history-readable.db.test.ts`:
 *  - it is excluded from the no-DB `vitest.config.ts` job;
 *  - it is a whole-file argument of the required approval real-DB step (located by its stable id and
 *    executable under the shared four-pin contract), exactly once, and not of the multitable step;
 *  - it carries the EXPECT_DB sentinel at module top level, outside any DATABASE_URL-gated block.
 *
 * This file lives in `tests/unit`, which the default vitest include collects in the required unit job.
 */

const REPO_ROOT = join(__dirname, '../../../..')
const PLUGIN_TESTS_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/plugin-tests.yml')
const VITEST_CONFIG_PATH = join(REPO_ROOT, 'packages/core-backend/vitest.config.ts')
const FILE = 'tests/integration/directory-integration-lifecycle-history-readable.db.test.ts'

describe('Directory integration lifecycle history real-DB CI wiring', () => {
  it('the real-DB file is excluded from the no-DB vitest.config.ts job', () => {
    expect(isQuotedInTestExclude(readFileSync(VITEST_CONFIG_PATH, 'utf8'), FILE)).toBe(true)
  })

  it('the required approval real-DB step is executable under the shared four-pin contract', () => {
    const wf = readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')
    expect(() => requireExecutableRealDbStep(wf, REAL_DB_STEP_IDS.approval)).not.toThrow()
  })

  it('the real-DB file is a whole-file argument of the approval step, exactly once', () => {
    const wf = readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')
    expect(isSuiteWiredInRealDbStep(wf, REAL_DB_STEP_IDS.approval, FILE)).toBe(true)
    expect(realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.approval).filter((arg) => arg === FILE)).toHaveLength(1)
  })

  it('the real-DB file is not an argument of the multitable real-DB step', () => {
    const wf = readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')
    expect(realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable)).not.toContain(FILE)
  })

  it('the workflow body contains the file token', () => {
    expect(readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')).toContain(FILE)
  })

  it('the real-DB file carries the EXPECT_DB sentinel at module top level', () => {
    const src = readFileSync(join(REPO_ROOT, 'packages/core-backend', FILE), 'utf8')
    expect(src).toMatch(/^const EXPECT_DB = process\.env\.EXPECT_DB === '1'$/m)
    expect(src).toMatch(/^const itIfExpectDb = EXPECT_DB \? it : it\.skip$/m)
    expect(src).toMatch(/^itIfExpectDb\('sentinel: /m)
    expect(src).toMatch(/^const describeIfDatabase = process\.env\.DATABASE_URL \? describe : describe\.skip$/m)
  })
})
