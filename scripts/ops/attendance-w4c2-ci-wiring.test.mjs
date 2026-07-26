import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  extractStepById,
  stepHasEnvDatabaseUrl,
  stepInvokesVitestIntegrationConfig,
  wholeFileVitestArgs,
} from './ci-realdb-step-contract.mjs'

// #4612 gate4 round 4 (P3-4): the W4C-2 attendance real-DB suites had NO source-level two-point
// wiring guard of their own.
// #4612 gate4 round 5 correction: this is NOT "every OTHER family already has one". Checked
// directly: `multitable` (216 `multitable-*` files across this workflow's three real-DB steps'
// file lists — 203 run by multitable's own step, the remaining 13 run by attendance's step) has
// no suite-level guard of its own — none of the 17 files in scripts/ops/*-ci-wiring.test.mjs is
// multitable-owned. Only 2 of the 216 are incidentally named, by
// `approval-data-closure-ci-wiring.test.mjs` (a DIFFERENT family's guard, listing two multitable
// fixtures its own suites share DML with) — not by any multitable-owned guard. Counted across the
// three real-DB steps' de-duplicated file union (365 files), the 16 pre-existing guards together
// name 30 of them (approval, PB4-*, T1/T2, B4-B7, stock-preparation P4); attendance's 7 files were
// not among the 30. The other 335 — multitable's 216 included — are outside every existing
// guard's file list. This closes attendance's own gap; it does not close "the last" gap in the
// workflow.
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
// equivalent checks from the lower-level exports instead, with an AFFIRMATIVE allowlist: only
// an ABSENT `if:` (today's real shape) or an equality comparison against '20.x' is accepted —
// see `requireAttendanceRealDbStepExecutable` below for why a substring/negative-match test on
// `if:` is not safe here (the `!= '20.x'` idiom already appears three steps above this one).
//
// For the SAME reason, this step's id is NOT added to the shared, frozen `REAL_DB_STEP_IDS` in
// `ci-realdb-step-contract.mjs`: that object is iterated by the already-existing
// `t2gate-collision-mechanism-ci-wiring.test.mjs`, which asserts the FULL 20.x-only four-pin
// contract on every entry — adding a step with a genuinely different contract there would break
// that sibling guard (verified: it does, caught by running the full `*-ci-wiring.test.mjs` sibling
// suite before landing). This step's id is kept local to this file instead.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const STEP_ID = 'attendance-real-db-integration'

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
  // Affirmative allowlist, not a substring/negative-match test: a naive
  // `!/20\.x/.test(cond)` check would WRONGLY PASS `if: matrix.node-version != '20.x'`
  // (the literal substring "20.x" is present even though the condition EXCLUDES that
  // leg) — and that exact negated-comparison idiom is already used three steps above
  // this one ("Build web app": `if: matrix.node-version != '18.x'`), so it is not a
  // hypothetical bypass. Only two shapes are accepted: no `if:` at all (today's real
  // shape — the step runs unconditionally on both matrix legs), or an `if:` that is
  // an EQUALITY comparison against '20.x' specifically. Everything else — including
  // any `!=` form, `false`, or a comparison against a different value — is refused.
  const cond = typeof step.if === 'string' ? step.if.trim() : step.if
  const isUnconditional = cond == null
  const isAffirmativeEquals20x = typeof cond === 'string'
    && /^matrix\.node-version\s*==\s*['"]20\.x['"]$/.test(cond)
  if (!isUnconditional && !isAffirmativeEquals20x) {
    throw new Error(
      `real-DB step id "${STEP_ID}" carries an "if:" (${JSON.stringify(cond)}) that is neither `
        + `absent (unconditional, today's shape) nor an affirmative `
        + `"matrix.node-version == '20.x'" equality — a negated form `
        + `("!= '18.x'"/"!= '20.x'") or any other condition can silently exclude the required `
        + `20.x leg and is refused`,
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
