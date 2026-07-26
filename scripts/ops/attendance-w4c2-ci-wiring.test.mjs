import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  REAL_DB_STEP_IDS,
  extractStepById,
  stepHasEnvDatabaseUrl,
  stepInvokesVitestIntegrationConfig,
  wholeFileVitestArgs,
} from './ci-realdb-step-contract.mjs'

// #4612 gate4 round 4 (P3-4): the W4C-2 attendance real-DB suites had NO source-level two-point
// wiring guard of their own — every OTHER family with a real-DB step in this workflow (approval,
// multitable, PB4-*, T1/T2, B4-B7, stock-preparation P4) already has one; attendance had zero.
// This is the exact skip-green shape gate4 caught for THIS PR's own primary evidence file
// (attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts) earlier in this same PR's history —
// present in the run-list, but the matching vitest.config.ts exclude line was missing, so the
// no-DB job silently collected and skip-greened it. Fixing that one line (already done, gate3/4)
// did not stop the NEXT such regression from being silent: nothing here reddens if a future PR
// removes either half again, or renames/deletes one of these seven files.
//
// Located by the step's EXACT stable `id:` (`attendance-real-db-integration`, added this round) —
// never by its `- name:` title, for the same title-prefix-decoy reason as every sibling guard.
//
// UNLIKE the approval/multitable siblings, this step does NOT carry
// `if: matrix.node-version == '20.x'` — it runs unconditionally on both matrix legs (18.x/20.x),
// which is a SUPERSET of the sibling steps' coverage, not a narrower pin. This guard therefore
// does not call `requireExecutableRealDbStep`/`isSuiteWiredInRealDbStep` (which hard-require that
// exact `if:` string and would wrongly reject this step as "not executable"); it composes the
// equivalent checks from the lower-level exports instead, with a pin that accepts "no restrictive
// `if:` at all" as at least as strong as the 20.x-only pin: an `if:` that excludes the required
// 20.x leg (or any other value) is refused, but an ABSENT `if:` (today's real shape) is not.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const STEP_ID = REAL_DB_STEP_IDS.attendance

const FILES = Object.freeze([
  'tests/integration/attendance-w4c2-timezone-write-guard.db.test.ts',
  'tests/integration/attendance-w4c2-outbox-dispatcher.db.test.ts',
  'tests/integration/attendance-w4c2-live-scheduled-boundary.db.test.ts',
  'tests/integration/attendance-w4c2-posture-matrix.db.test.ts',
  'tests/integration/attendance-w4c2-gate-matrix-e5.db.test.ts',
  'tests/integration/attendance-w4c2-p2-remediation.db.test.ts',
  'tests/integration/attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts',
])

/**
 * The attendance real-DB step's executability, checked WITHOUT the strict 20.x-only `if:` pin
 * (see file header). Throws — fails CLOSED — on any of: step not found, `if:` present but
 * excluding the required 20.x leg, missing/non-literal `env.DATABASE_URL`, or no real
 * `--config vitest.integration.config.ts` vitest invocation.
 */
function requireAttendanceRealDbStepExecutable() {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const step = extractStepById(wf, STEP_ID)
  if (step == null) {
    throw new Error(
      `real-DB step id "${STEP_ID}" not found in plugin-tests.yml — located by exact id, never `
        + `by name prefix`,
    )
  }
  const cond = typeof step.if === 'string' ? step.if.trim() : step.if
  const excludesRequiredLeg = cond != null && !/20\.x/.test(String(cond))
  if (excludesRequiredLeg) {
    throw new Error(
      `real-DB step id "${STEP_ID}" carries an "if:" (${JSON.stringify(cond)}) that does not `
        + `mention the required 20.x leg — it must run unconditionally (today's shape) or on `
        + `20.x, never be narrowed to exclude it`,
    )
  }
  if (!stepHasEnvDatabaseUrl(step)) {
    throw new Error(
      `real-DB step id "${STEP_ID}" must have env.DATABASE_URL as a real YAML key whose value is `
        + `a literal PostgreSQL URL (no Actions expression) — otherwise every describeIfDatabase `
        + `suite it runs skips green`,
    )
  }
  if (!stepInvokesVitestIntegrationConfig(step)) {
    throw new Error(
      `real-DB step id "${STEP_ID}" must run a real vitest command with `
        + `--config vitest.integration.config.ts — the default vitest.config.ts excludes every `
        + `DB-gated suite listed here`,
    )
  }
  return step
}

test('plugin-tests.yml attendance real-DB step (id: attendance-real-db-integration) is executable', () => {
  assert.doesNotThrow(() => requireAttendanceRealDbStepExecutable())
})

for (const file of FILES) {
  test(`vitest.config.ts excludes ${file} from the no-DB job`, () => {
    const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
    assert.ok(
      cfg.includes(`'${file}'`),
      `vitest.config.ts must exclude ${file} (DATABASE_URL-gated whole file) — a missing entry `
        + `is the exact skip-green shape gate4 found for this PR's own primary evidence file`,
    )
  })

  test(`plugin-tests.yml runs ${file} as a whole file in the attendance real-DB step`, () => {
    const step = requireAttendanceRealDbStepExecutable()
    assert.ok(
      wholeFileVitestArgs(step).includes(file),
      `attendance real-DB step (id: ${STEP_ID}) must run ${file} as a whole-file vitest arg`,
    )
  })

  test(`${file} exists on disk`, () => {
    // Third point: both wiring texts can stay intact while the suite is renamed/deleted —
    // vitest exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
    assert.ok(
      existsSync(join(repoRoot, 'packages/core-backend', file)),
      `wired suite packages/core-backend/${file} must exist on disk`,
    )
  })
}
