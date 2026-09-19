import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  REAL_DB_STEP_IDS,
  isQuotedInTestExclude,
  isSuiteWiredInRealDbStep,
  realDbStepWholeFileArgs,
} from '../../../../scripts/ops/ci-realdb-step-contract.mjs'

/**
 * Approval cancel-round real-DB CI wiring (lane decision 1, 2026-09-17).
 *
 * WHAT THIS PINS: the seven `approval-cancel-round-*.db.test.ts` suites are (a) excluded from the
 * no-DB `vitest.config.ts` job (so `describeIfDatabase` cannot skip-green them there), and (b)
 * wired as WHOLE-FILE arguments of `plugin-tests.yml`'s required `test (20.x)` "Run approval
 * real-DB integration" step (id `approval-real-db-integration`) — the SAME step id the shared
 * `ci-realdb-step-contract.mjs` module already pins (a)/(b)/(c) executability for (20.x-only
 * matrix leg, a literal `DATABASE_URL`, a real `vitest --config vitest.integration.config.ts`
 * invocation). This test adds only pin (d) — that each of the seven files is actually a whole-file
 * argument of that same, already-executable invocation — reusing the shared parser rather than
 * re-deriving step discovery.
 *
 * WHY THIS FILE'S HOME NEEDS NO WORKFLOW EDIT: `packages/core-backend/tests/unit/*.test.ts` is
 * collected by Vitest's DEFAULT include glob, run via `packages/core-backend/package.json`'s
 * `"test": "vitest"` script, invoked by the "Run core-backend tests" step in `plugin-tests.yml`'s
 * `test` job (matrix `[18.x, 20.x]`, no `if:` guard) — i.e. BOTH required `test (18.x)` / `test
 * (20.x)` contexts. A brand-new file here needs no workflow edit to be collected (same rationale
 * `approval-ci-coverage-enumeration.test.ts`'s own header documents for its own home).
 *
 * WHY THE STANDALONE LANE IS ASSERTED ABSENT: these seven files were previously wired into a
 * standalone, non-required `.github/workflows/approval-realdb-cancel-round.yml` lane. That lane is
 * DELETED in the same commit that adds these files to the required step — keeping both would run
 * every file twice per PR for zero additional coverage (the explicit reason the lane's own pending
 * CI-wiring decision named for the promotion). A regression that resurrects the standalone file
 * without also removing these run-list entries would silently reintroduce the double-run; this
 * guard catches the resurrection half.
 *
 * WHY THIS PROMOTION IS THE "LEGITIMATE-TOUCH" EXCEPTION, NOT THE DEFAULT: per
 * `docs/development/approval-lock11-writer-org-derivation-20260822.md` §4.1, the DEFAULT for a new
 * approval real-DB gate is two-point wiring (vitest.config.ts exclude + a standalone workflow,
 * `plugin-tests.yml` left byte-identical) — landed as `45490f57ec` (#5098). A THIRD point — adding
 * the file into the existing "Run approval real-DB integration" step — is the named exception, used
 * only when a suite becomes a required-lane activation dependency (the `2171b07fb3` / #5095
 * precedent this lane's owner decision follows). That promotion recomputes the s6a
 * `pluginTestsWorkflow` digest via `computePackageProvenancePinSet(repoRoot)`
 * (`plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs`) in
 * the SAME commit — this file does not re-verify that digest (the sealed-export package's own
 * `sealed-export-package-provenance.test.cjs` already does, unconditionally, for every commit that
 * touches any pinned evidence file).
 */

const REPO_ROOT = join(__dirname, '../../../..')
const PLUGIN_TESTS_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/plugin-tests.yml')
const STANDALONE_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/approval-realdb-cancel-round.yml')
const VITEST_CONFIG_PATH = join(REPO_ROOT, 'packages/core-backend/vitest.config.ts')

const CANCEL_ROUND_REALDB_FILES = [
  'tests/integration/approval-cancel-round-lock-order-census.db.test.ts',
  'tests/integration/approval-cancel-round-creation.db.test.ts',
  'tests/integration/approval-cancel-round-redemption.db.test.ts',
  'tests/integration/approval-cancel-round-seat-guards.db.test.ts',
  'tests/integration/approval-cancel-round-attendance-fk-migration.db.test.ts',
  'tests/integration/approval-cancel-round-outlet-guards.db.test.ts',
  'tests/integration/approval-cancel-round-node-timeout-effect.db.test.ts',
] as const

describe('Approval cancel-round real-DB CI wiring (lane decision 1)', () => {
  it('the standalone approval-realdb-cancel-round.yml lane is deleted (no double-run)', () => {
    expect(existsSync(STANDALONE_WORKFLOW_PATH)).toBe(false)
  })

  it('every cancel-round real-DB file is excluded from the no-DB vitest.config.ts job', () => {
    const cfg = readFileSync(VITEST_CONFIG_PATH, 'utf8')
    for (const file of CANCEL_ROUND_REALDB_FILES) {
      expect(isQuotedInTestExclude(cfg, file)).toBe(true)
    }
  })

  it('every cancel-round real-DB file is a whole-file argument of the required approval-real-db-integration step', () => {
    const wf = readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')
    for (const file of CANCEL_ROUND_REALDB_FILES) {
      expect(isSuiteWiredInRealDbStep(wf, REAL_DB_STEP_IDS.approval, file)).toBe(true)
    }
  })

  it('the required step lists all seven files exactly once each (no duplicate/mistyped entries)', () => {
    const wf = readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')
    const args = realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.approval)
    for (const file of CANCEL_ROUND_REALDB_FILES) {
      const occurrences = args.filter((arg) => arg === file).length
      expect(occurrences).toBe(1)
    }
  })

  it('is NOT also wired into the sibling multitable real-DB step (single required lane, not both)', () => {
    const wf = readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')
    const multitableArgs = realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable)
    for (const file of CANCEL_ROUND_REALDB_FILES) {
      expect(multitableArgs).not.toContain(file)
    }
  })

  it('the required step body actually contains the file tokens (decoy resistance — a helper bug cannot fabricate a match)', () => {
    const wf = readFileSync(PLUGIN_TESTS_WORKFLOW_PATH, 'utf8')
    for (const file of CANCEL_ROUND_REALDB_FILES) {
      expect(wf).toContain(file)
    }
  })
})
