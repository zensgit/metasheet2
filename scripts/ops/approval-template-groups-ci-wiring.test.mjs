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

// Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18) CI two-point wiring contract.
//
// WHY THIS GUARD WAS MISSING UNTIL NOW: the two phase-1 (A-1) suites
// (`approval-template-groups-lifecycle.db.test.ts` / `-serialization.db.test.ts`) landed with
// `vitest.config.ts` exclude entries and a `plugin-tests.yml` whole-file invocation, but no
// dedicated `*-ci-wiring.test.mjs` closed-world guard — the supplementary gate checklist
// (impl-supplementary-gate-checklist-20260918.md #1) flags exactly this shape: the shared
// `t2-source-freeze-ci-wiring.test.mjs`'s own `FILES` array is a DIFFERENT feature's closed
// world, so a new `.db.test.ts` for THIS feature entering the workflow manifest left every
// existing guard green while nothing asserted the wiring for approval-template-groups at all.
// Phase 3 (A-4) doubled the family to four files without closing that gap — disclosed as a
// residual in the reorder/sections suites' own headers — so this guard closes it now, covering
// all four (both phase-1 originals and both phase-3 additions) rather than only the two new ones,
// since the gap predates and is not specific to phase 3.
//
// Same three-point shape as the sibling `t2-source-freeze-ci-wiring.test.mjs` (the newer,
// step-id-anchored contract — NOT the older `approval-data-closure-ci-wiring.test.mjs` regex
// style, which cannot detect the "step exists but never runs" bypass class documented in
// `ci-realdb-step-contract.mjs`'s header): (1) `vitest.config.ts` excludes the file from the
// no-DB job, (2) `plugin-tests.yml`'s approval real-DB step — located by its EXACT stable `id:`,
// never by title, and pinned executable (20.x-only, a literal DATABASE_URL, a real
// `vitest.integration.config.ts` invocation) — runs it as a whole-file argument, negatively
// checked against the multitable real-DB step, and (3) the wired suite exists on disk. Runs in
// the gating no-DB `test` job (added as its own `node --test` step in `plugin-tests.yml`, per
// this repo's per-guard-line convention — guards here are not glob-discovered).
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILES = [
  'tests/integration/approval-template-groups-lifecycle.db.test.ts',
  'tests/integration/approval-template-groups-serialization.db.test.ts',
  'tests/integration/approval-template-groups-sections.db.test.ts',
  'tests/integration/approval-template-groups-reorder.db.test.ts',
]

const STEP_ID = REAL_DB_STEP_IDS.approval

for (const FILE of FILES) {
  test(`vitest.config.ts excludes ${FILE} from the no-DB job`, () => {
    const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
    assert.ok(cfg.includes(`'${FILE}'`), `vitest.config.ts must exclude ${FILE} (DATABASE_URL-gated whole file)`)
  })

  test(`plugin-tests.yml runs ${FILE} as a whole file in the approval real-DB step`, () => {
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

  test(`the wired suite ${FILE} exists on disk`, () => {
    // Third point: both wiring texts can stay intact while the suite is renamed/deleted — vitest
    // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
    assert.ok(
      existsSync(join(repoRoot, 'packages/core-backend', FILE)),
      `wired suite packages/core-backend/${FILE} must exist on disk`,
    )
  })
}
