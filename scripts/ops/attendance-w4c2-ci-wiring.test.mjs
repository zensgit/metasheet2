import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  REAL_DB_STEP_IDS,
  extractStepById,
  isQuotedInTestExclude,
  realDbStepWholeFileArgs,
  stepHasEnvDatabaseUrl,
  stepInvokesVitestIntegrationConfig,
  wholeFileVitestArgs,
} from './ci-realdb-step-contract.mjs'

// #4612 gate4 round 4 (P3-4): the W4C-2 attendance real-DB suites had NO source-level two-point
// wiring guard of their own. This file became that (17th) guard, originally as a hardcoded
// 7-entry FILES allowlist that grew to 33 entries.
//
// OBS-1 (2026-08-07): converted from that allowlist to a DERIVED COMPLETENESS check. The
// allowlist could prove its own 33 files stayed wired, but it structurally could not notice a
// file it was never told about: two W4C-3b suites (attendance-w4c3b-request-snapshots.db.test.ts
// — the real-DB proof of the 8-cell request-snapshot precondition, #4780, a soak entry gate —
// and attendance-w4c3b-central-approval.db.test.ts) landed in #4716 with NEITHER wiring point,
// so the no-DB job collected + skip-greened them and no CI job ever executed them, while this
// guard stayed green. The corpus is now enumerated from reality instead of from a list:
//
//   corpus part 1 (disk → wiring): every on-disk file matching the DB-suite naming convention
//     packages/core-backend/tests/integration/attendance-*.db.test.ts (73 at conversion time)
//     must be BOTH (a) a whole-file vitest arg of an EXECUTABLE real-DB step in
//     plugin-tests.yml AND (b) an exact quoted entry of vitest.config.ts test.exclude, so it
//     runs exactly once, with a database. A future attendance-*.db.test.ts added without both
//     points reddens this guard the moment it lands.
//   corpus part 2 (wiring → disk + exclude): every attendance-prefixed whole-file arg the
//     real-DB run-lists actually carry must exist on disk (vitest exits 0 on an unmatched path
//     argument, so a rename/delete with stale wiring stays green otherwise), and — for the
//     legacy non-.db-named DB-gated suites (attendance-plugin.test.ts and friends), which no
//     on-disk glob can distinguish from genuine no-DB integration tests — must be in the
//     no-DB exclude too. The non-.db corpus is run-list-derived because the run-list is the
//     only machine-readable statement that such a file is a real-DB suite.
//
// PLACEMENT REALITY the union below encodes: 71 of the 73 on-disk attendance .db suites are
// carried by the attendance step (id `attendance-real-db-integration`); the 2
// attendance-notification-redelivery* suites are carried by the approval step (§7.6 delivery
// closure, wired there long before the attendance step existed); the multitable step carries 0
// today but is part of the same executability contract, so a deliberate future move there does
// not red this guard. All three steps live in the required `test` job (the attendance step's
// job membership is pinned structurally below; the approval/multitable steps' full four-pin
// contract is asserted by t2gate-collision-mechanism-ci-wiring.test.mjs).
//
// DELIBERATELY OUTSIDE BOTH CORPORA: tests/integration/attendance-settlement-table-v1-5a.test.ts
// — a dormant schema lock whose every test body starts `if (!dbUrl) return` (self-soft-skip, not
// describeIfDatabase) and which is wired into no run-list. It is outside the .db naming
// convention AND outside every run-list, so neither corpus claims it; renaming it to
// *.db.test.ts would pull it into corpus part 1 and force real wiring.
//
// Located by the step's EXACT stable `id:` (`attendance-real-db-integration`) — never by its
// `- name:` title, for the same title-prefix-decoy reason as every sibling guard.
//
// UNLIKE the approval/multitable siblings, this step does NOT carry
// `if: matrix.node-version == '20.x'` — it runs unconditionally on both matrix legs (18.x/20.x),
// which is a SUPERSET of the sibling steps' coverage, not a narrower pin. This guard therefore
// does not call `requireExecutableRealDbStep`/`isSuiteWiredInRealDbStep` for the attendance step
// (those hard-require that exact `if:` string and would wrongly reject this step as "not
// executable"); it composes the equivalent checks from the lower-level exports instead, with an
// AFFIRMATIVE allowlist: only an ABSENT `if:` (today's real shape) or an equality comparison
// against '20.x' is accepted — see `requireAttendanceRealDbStepExecutable` below for why a
// substring/negative-match test on `if:` is not safe here (the `!= '18.x'` idiom already appears
// in this workflow). For the SAME reason, this step's id is NOT added to the shared, frozen
// `REAL_DB_STEP_IDS` in `ci-realdb-step-contract.mjs` (that object is iterated by
// `t2gate-collision-mechanism-ci-wiring.test.mjs`, which asserts the FULL 20.x-only four-pin
// contract on every entry); the id stays local to this file.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const STEP_ID = 'attendance-real-db-integration'
const W4C3C_TOOLING_STEP_ID = 'attendance-w4c3c-tooling-contracts'
const W4C3C_TOOLING_FILES = Object.freeze([
  'scripts/ops/staging-attendance-tooling-teardown.test.mjs',
  'scripts/ops/attendance-w4c3c-execute-ops-retirement-cleanup.test.mjs',
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
  // leg) — and that exact negated-comparison idiom is already used in this workflow
  // ("Build web app": `if: matrix.node-version != '18.x'`), so it is not a
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

// ---------------------------------------------------------------------------------------------
// #4612 final-gate P2-6: `extractStepById` scans EVERY job in document order, so all the legs
// above stay green if the step is moved wholesale into a job whose check is NOT required on main
// (verified mutation: the entire step block relocated into `after-sales-integration` — which has
// its own Postgres service and db:migrate, so it would even run green there — left this guard
// green while the suites silently left the required `test (20.x)` gate). The leg below pins
// JOB MEMBERSHIP structurally: the same python3+PyYAML bridge shape as the shared contract
// (these guards run pre-install, so no npm YAML parser is importable; the bridge FAILS CLOSED —
// missing python3, missing PyYAML, or a parse error all redden). Kept LOCAL to this file, not
// added to the shared `extractStepById`: the shared module's first-match-wins scan is an owner
// stop-line residual for the OTHER two step ids, and the header above already records why this
// step must not join the shared frozen allowlist.
// ---------------------------------------------------------------------------------------------
const REQUIRED_JOB = 'test' // the job whose matrix leg produces the required `test (20.x)` context

/**
 * Names of ALL jobs whose `steps` contain a step with the given `id:`, read off the PARSED
 * YAML structure (python3 + PyYAML, fail-closed) — never a substring/indentation heuristic.
 * Returning the full list (not first match) makes a duplicate-id decoy in another job visible.
 */
function jobsContainingStepId(stepId) {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const py = [
    'import json, sys',
    'try:',
    '    import yaml',
    'except Exception as exc:',
    "    sys.stderr.write('PYYAML_MISSING: %r' % (exc,))",
    '    sys.exit(3)',
    'try:',
    '    doc = yaml.safe_load(sys.stdin.read())',
    'except Exception as exc:',
    "    sys.stderr.write('YAML_PARSE_ERROR: %r' % (exc,))",
    '    sys.exit(4)',
    'jobs = doc.get("jobs") if isinstance(doc, dict) else None',
    'hits = []',
    'if isinstance(jobs, dict):',
    '    for job_name, job in jobs.items():',
    '        steps = job.get("steps") if isinstance(job, dict) else None',
    '        if not isinstance(steps, list):',
    '            continue',
    '        for step in steps:',
    '            if isinstance(step, dict) and step.get("id") == sys.argv[1]:',
    '                hits.append(str(job_name))',
    'json.dump(hits, sys.stdout)',
  ].join('\n')
  const res = spawnSync('python3', ['-c', py, stepId], {
    input: wf,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  })
  if (res.error) {
    throw new Error(`job-scope guard: failing CLOSED — python3 could not be spawned (${res.error.message})`)
  }
  if (res.status !== 0) {
    throw new Error(
      `job-scope guard: failing CLOSED — PyYAML bridge exited ${res.status}: `
        + `${(res.stderr || '').trim() || '(no stderr)'}`,
    )
  }
  return JSON.parse(res.stdout)
}

test(`attendance real-DB step (id: ${STEP_ID}) lives in job "${REQUIRED_JOB}" — the job that produces the required test (20.x) context — and in no other job`, () => {
  assert.deepEqual(
    jobsContainingStepId(STEP_ID),
    [REQUIRED_JOB],
    `the step carrying id "${STEP_ID}" must appear in EXACTLY the job "${REQUIRED_JOB}": moved to any `
      + `other job (even one where it would run green, e.g. after-sales-integration) the suites `
      + `silently leave the required test (20.x) gate; duplicated into a second job, a decoy copy `
      + `could anchor the shared first-match-wins step lookup`,
  )
})

test(`W4C-3c tooling step (id: ${W4C3C_TOOLING_STEP_ID}) lives in required job and invokes both node:test files`, () => {
  assert.deepEqual(jobsContainingStepId(W4C3C_TOOLING_STEP_ID), [REQUIRED_JOB])
  const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const step = extractStepById(workflow, W4C3C_TOOLING_STEP_ID)
  assert.ok(step && typeof step.run === 'string', 'W4C-3c tooling step must carry a real run script')
  assert.match(step.run, /\bnode\s+--test\b/)
  for (const file of W4C3C_TOOLING_FILES) {
    assert.ok(step.run.includes(file), `${file} must be an argument of the W4C-3c tooling step`)
    assert.ok(existsSync(join(repoRoot, file)), `${file} must exist on disk`)
  }
})

// ---------------------------------------------------------------------------------------------
// OBS-1 derived-corpus completeness (replaces the 33-entry FILES allowlist — see file header)
// ---------------------------------------------------------------------------------------------

const INTEGRATION_DIR = join(repoRoot, 'packages/core-backend/tests/integration')
/**
 * The DB-suite naming convention the attendance family actually uses on disk: anchored prefix +
 * anchored `.db.test.ts` suffix. Derived from the real file set, not invented — every attendance
 * suite that requires PostgreSQL and was written since the convention landed is named this way
 * (73 files at conversion time); the handful of legacy DB-gated suites with plain `.test.ts`
 * names are covered by corpus part 2 below instead.
 */
const ATTENDANCE_DB_SUITE_RE = /^attendance-.*\.db\.test\.ts$/

/** Corpus part 1: the on-disk attendance DB-suite files (repo-relative vitest arg form). */
function onDiskAttendanceDbSuites() {
  // readdirSync THROWS on a wrong/missing directory — an empty scan cannot pass silently, and
  // the floor test below reddens a scan that reads the wrong (near-empty) place.
  return readdirSync(INTEGRATION_DIR)
    .filter((name) => ATTENDANCE_DB_SUITE_RE.test(name))
    .sort()
    .map((name) => `tests/integration/${name}`)
}

/**
 * Every whole-file vitest arg across the workflow's THREE executable real-DB steps: the
 * attendance step (looser local executability contract, header) plus the approval and
 * multitable steps (shared four-pin contract — `realDbStepWholeFileArgs` throws unless the
 * step exists AND is executable, so a file cannot count as "wired" into a deleted or disabled
 * step).
 */
function realDbWholeFileArgUnion() {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  return [
    ...wholeFileVitestArgs(requireAttendanceRealDbStepExecutable()),
    ...realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.approval),
    ...realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable),
  ]
}

// Negative controls on the SCAN ITSELF (an empty/broken enumeration must red, never pass
// vacuously): the naming-convention predicate is self-tested on synthetic names, and the
// corpus size gets a floor. The floor is NOT a growth pin — it exists so a scan that reads
// the wrong directory or a predicate typo that matches (almost) nothing goes red; 73 files
// match at conversion time, and legitimately deleting a handful keeps it green.
test('OBS-1 corpus scan self-test: predicate matches the convention and only the convention; scan is non-vacuous', () => {
  assert.ok(ATTENDANCE_DB_SUITE_RE.test('attendance-w4c0-db-gates-e1.db.test.ts'))
  assert.ok(ATTENDANCE_DB_SUITE_RE.test('attendance-w4c3b-request-snapshots.db.test.ts'))
  assert.ok(!ATTENDANCE_DB_SUITE_RE.test('attendance-plugin.test.ts'), 'plain .test.ts is corpus part 2, not part 1')
  assert.ok(!ATTENDANCE_DB_SUITE_RE.test('multitable-automation-event-fires-lease-realdb.db.test.ts'), 'other families are out of scope')
  assert.ok(!ATTENDANCE_DB_SUITE_RE.test('attendance-w4c3b-central-approval.env.ts'), 'env bootstrap companions are not suites')
  const corpus = onDiskAttendanceDbSuites()
  assert.ok(
    corpus.length >= 60,
    `on-disk attendance-*.db.test.ts scan found only ${corpus.length} files (73 at conversion `
      + `time) — a near-empty scan means the directory path or the predicate broke, not that `
      + `the corpus shrank by that much`,
  )
  const union = realDbWholeFileArgUnion()
  assert.ok(union.length > 0, 'real-DB steps carry no whole-file args at all — run-list parsing broke')
})

// Corpus part 1 (disk → wiring): every on-disk attendance DB suite runs exactly once, with a
// database — whole-file in an executable real-DB step AND excluded from the no-DB job.
for (const file of onDiskAttendanceDbSuites()) {
  test(`${file} is a whole-file vitest arg of an executable real-DB step in plugin-tests.yml`, () => {
    assert.ok(
      realDbWholeFileArgUnion().includes(file),
      `${file} exists on disk but is NOT carried by any executable real-DB step's run-list — `
        + `the no-DB job collects it and describeIfDatabase skip-greens it, so it executes `
        + `NOWHERE (the exact OBS-1 shape: two W4C-3b suites sat in this state from #4716 `
        + `until 2026-08-07)`,
    )
  })

  test(`${file} is excluded from the no-DB job (vitest.config.ts test.exclude)`, () => {
    const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
    // Structured parse (depth-1 `test.exclude` array body, line-comments stripped): a bare
    // substring check is satisfied by a commented-out entry, a `coverage.exclude` entry, or any
    // other free-text mention of the path — none of which actually excludes the file from the
    // no-DB job (#4612 gate-confirm P2-1).
    assert.ok(
      isQuotedInTestExclude(cfg, file),
      `vitest.config.ts must exclude ${file} (DATABASE_URL-gated whole file) as an exact quoted `
        + `entry inside the direct test.exclude array — a comment / coverage.exclude / free-text `
        + `hit is not placement. A missing entry is the half-wired skip-green shape`,
    )
  })
}

// Corpus part 2 (wiring → disk + exclude): every attendance-prefixed whole-file arg the
// real-DB run-lists carry. Deduplicated; the exclude leg is only emitted for files not already
// covered by corpus part 1 (the legacy non-.db-named DB-gated suites).
{
  const part1 = new Set(onDiskAttendanceDbSuites())
  const carried = [...new Set(realDbWholeFileArgUnion())]
    .filter((arg) => arg.startsWith('tests/integration/attendance-'))
    .sort()

  test('OBS-1 corpus part 2 is non-vacuous (real-DB run-lists carry attendance files)', () => {
    assert.ok(
      carried.length >= 60,
      `real-DB run-lists carry only ${carried.length} attendance files (86 at conversion time) — `
        + `a near-empty result means the run-list parsing broke, not that the wiring shrank by `
        + `that much`,
    )
  })

  for (const file of carried) {
    test(`${file} (carried by a real-DB run-list) exists on disk`, () => {
      // Both wiring texts can stay intact while the suite is renamed/deleted — vitest exits 0
      // on an unmatched path argument, so CI stays green and the proof never runs.
      assert.ok(
        existsSync(join(repoRoot, 'packages/core-backend', file)),
        `wired suite packages/core-backend/${file} must exist on disk`,
      )
    })

    if (!part1.has(file)) {
      test(`${file} (non-.db-named DB-gated suite carried by a real-DB run-list) is excluded from the no-DB job`, () => {
        const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
        assert.ok(
          isQuotedInTestExclude(cfg, file),
          `vitest.config.ts must exclude ${file}: it is carried by a real-DB run-list (the only `
            + `machine-readable statement that a non-.db-named file is a real-DB suite), so `
            + `without the exclude the no-DB job collects it too — describeDb skip-greens it `
            + `there (all its describes are DB-gated), a half-satisfied two-point wiring`,
        )
      })
    }
  }
}
