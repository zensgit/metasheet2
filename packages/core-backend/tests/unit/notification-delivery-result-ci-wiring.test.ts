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
 * Delivery-result truthfulness real-DB CI wiring.
 *
 * WHAT THIS PINS: `tests/integration/notification-delivery-result.db.test.ts` is (a) excluded from the
 * no-DB `vitest.config.ts` job (its EXPECT_DB sentinel would otherwise throw there, and a
 * `describeIfDatabase` guard could never skip-green it), and (b) wired as a WHOLE-FILE argument of
 * `plugin-tests.yml`'s required `multitable-db` "Run multitable real-DB integration" step (id
 * `multitable-real-db-integration`) — the step the shared `ci-realdb-step-contract.mjs` module pins
 * executability for (20.x-only matrix leg, a literal `DATABASE_URL`, a real
 * `vitest --config vitest.integration.config.ts` invocation). This test adds pin (d): the file is an
 * argument of that same, already-executable invocation, exactly once.
 *
 * WHY THIS FILE'S HOME NEEDS NO WORKFLOW EDIT: `packages/core-backend/tests/unit/*.test.ts` is collected
 * by Vitest's DEFAULT include glob, run via the package's `"test": "vitest"` script in the "Run
 * core-backend tests" step of `plugin-tests.yml`'s required `unit` job (no `if:` guard).
 */

const REPO_ROOT = join(__dirname, '../../../..')
const PLUGIN_TESTS_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/plugin-tests.yml')
const VITEST_CONFIG_PATH = join(REPO_ROOT, 'packages/core-backend/vitest.config.ts')
const FILE = 'tests/integration/notification-delivery-result.db.test.ts'

describe('Delivery-result truthfulness real-DB CI wiring', () => {
  it('the real-DB file is excluded from the no-DB vitest.config.ts job', () => {
    expect(isQuotedInTestExclude(readFileSync(VITEST_CONFIG_PATH, 'utf8'), FILE)).toBe(true)
  })

  it('the required multitable real-DB step is executable under the shared four-pin contract', () => {
    const wf = readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')
    expect(() => requireExecutableRealDbStep(wf, REAL_DB_STEP_IDS.multitable)).not.toThrow()
  })

  it('the real-DB file is a whole-file argument of that step, exactly once', () => {
    const wf = readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')
    expect(isSuiteWiredInRealDbStep(wf, REAL_DB_STEP_IDS.multitable, FILE)).toBe(true)
    const args = realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable)
    expect(args.filter((arg) => arg === FILE)).toHaveLength(1)
  })

  it('is NOT also wired into the sibling approval real-DB step (single required lane, not both)', () => {
    const wf = readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')
    expect(realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.approval)).not.toContain(FILE)
  })

  it('the workflow body actually contains the file token (decoy resistance)', () => {
    expect(readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')).toContain(FILE)
  })

  it('the real-DB file carries the EXPECT_DB fail-not-skip sentinel at module scope', () => {
    const src = readFileSync(join(REPO_ROOT, 'packages/core-backend', FILE), 'utf8')
    expect(src).toMatch(/if \(process\.env\.EXPECT_DB !== '1'\) \{\s*\n\s*throw new Error\(/)
  })
})
