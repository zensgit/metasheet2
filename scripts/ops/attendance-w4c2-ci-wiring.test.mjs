import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  REAL_DB_STEP_IDS,
  extractStepById,
  isQuotedInTestExclude,
  realDbStepWholeFileArgs,
  requireExecutableRealDbStep,
  stepHasEnvDatabaseUrl,
  stepInvokesVitestIntegrationConfig,
  vitestInvocations,
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
//     packages/core-backend/tests/integration/attendance-*.db.test.ts (74 at conversion time)
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
//   corpus part 3 (issue 4828, owner-ruled 2026-08-08): the slot the first two leave open — a
//     suite that IS DB-gated but is NOT named *.db.test.ts and is in NO run-list is invisible to
//     part 1 (glob misses it by name) AND to part 2 (run-list derivation misses it entirely).
//     Every on-disk non-.db attendance-*.test.ts must therefore be EITHER carried by a real-DB
//     run-list OR provably gate-free. The gate is detected BY SHAPE (the `? describe :
//     describe.skip` ternary, under any binding name), and an unclassifiable shape FAILS CLOSED.
//     Until this landed, the paragraph below said only in PROSE that such a file "must be wired".
//
// PLACEMENT REALITY the union below encodes: 72 of the 74 on-disk attendance .db suites are
// carried by the attendance step (id `attendance-real-db-integration`); the 2
// attendance-notification-redelivery* suites are carried by the approval step (§7.6 delivery
// closure, wired there long before the attendance step existed); the multitable step carries 0
// today but is part of the same executability contract, so a deliberate future move there does
// not red this guard. All three steps live in the required `test` job (the attendance step's
// job membership is pinned structurally below; the approval/multitable steps' full four-pin
// contract is asserted by t2gate-collision-mechanism-ci-wiring.test.mjs).
//
// NOTHING IS EXCLUDED FROM THE CORPORA. The first draft of this conversion carved out one file —
// tests/integration/attendance-settlement-table-v1-5a.test.ts, the dormant 加班银行 v1-5a settlement
// schema lock — on the grounds that it was outside the .db naming convention AND outside every
// run-list, so neither corpus claimed it. Owner ruling (2026-08-08, P1): that carve-out reproduced
// the exact defect this file exists to eliminate. The suite self-soft-skipped (`if (!dbUrl) return`,
// not describeIfDatabase) AND soft-passed on a MISSING TABLE (`if (cols.length === 0) return`), and
// the only job that collected it had no database — required CI went green over a schema lock that
// asserted nothing, with this guard endorsing the arrangement in prose. The suite has been renamed
// to attendance-settlement-table-v1-5a.db.test.ts, two-point wired, and its table-missing soft-pass
// deleted; it is now an ordinary corpus-part-1 member. A future file in that shape must be wired,
// not documented here: adding an exclusion to this guard is a contract change requiring an owner
// ruling, never a reviewer-local convenience.
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
// Issue 4828 hole 2 (owner-ruled): "wired" must also mean "not name-filtered to nothing".
//
// `wholeFileVitestArgs()` reports a file as a whole-file arg without inspecting the OTHER args on
// the same command, and vitest's `-t` / `--testNamePattern` filter is silent and exit-0 when it
// matches nothing:
//     vitest --config vitest.integration.config.ts <file> -t 'no-such-test-name-zz'
//     → exits 0, "Test Files 1 skipped (1)"
// So a suite can satisfy BOTH wiring points, be carried by an executable real-DB step, and still
// execute ZERO assertions while every corpus leg above stays green — the same skip-green shape
// this guard exists to eliminate, one level further in.
//
// SCOPE (owner ruling): the root fix belongs in `wholeFileVitestArgs` itself, but that helper is
// shared by all 17 `*-ci-wiring.test.mjs` guards and changing it there would blast-radius into 16
// other lanes. It is tracked separately as repo-level issue 4829. What lands HERE is the
// attendance-scoped assertion only — the shared helper is untouched.
//
// The DOMAIN is DERIVED PER INVOCATION, never named by step id (owner scope correction). The
// attendance corpus is NOT carried by a single step: the approval step carries the
// `attendance-notification-redelivery*` family (3 attendance whole-file args today), wired there
// long before the attendance step existed. Binding this check to `attendance-real-db-integration`
// would let a `-t` on the approval step silence those while the guard stayed green — the identical
// wired-but-executes-nothing shape, one step over. So: enumerate the vitest invocations of the
// three real-DB steps, keep the ones that ACTUALLY carry a `tests/integration/attendance-*` file
// arg (membership computed from the args, never assumed from the step name), and reject the filter
// flags on those. `multitable` carries ZERO attendance files today and therefore needs no
// special-case branch — it simply contributes no invocations, and if it ever carries one the
// derivation picks it up automatically. There is no hand-written multitable exception.
//
// Derived MECHANICALLY, never by eyeballing the raw YAML: `vitestInvocations()` already resolves
// the real binary, strips bash comments (both directions), joins `\` continuations and splits on
// `;`/`&&`/`||`/`|`/`&`, so a COMMENTED-OUT `-t` never reaches the token list (correctly ignored)
// and a REORDERED one is caught wherever it sits (position-independent). A substring scan of the
// YAML text would get both cases wrong.
// ---------------------------------------------------------------------------------------------

/**
 * Test-name-filter arguments of ONE vitest invocation. Both the separate-value form (`-t 'x'`,
 * `--testNamePattern 'x'`) and the equals-joined form (`-t=x`, `--testNamePattern=x`) are matched
 * at ARG level, so a path argument or another flag's value can never be mistaken for one.
 */
function testNameFilterArgsOfInvocation(inv) {
  return inv.args.filter(
    (arg) => arg === '-t'
      || arg === '--testNamePattern'
      || /^(?:-t|--testNamePattern)=/.test(arg),
  )
}

/**
 * The DERIVED domain: every (stepId, invocation) pair across the three real-DB steps whose
 * invocation actually carries at least one `tests/integration/attendance-*` whole-file arg AND
 * runs under `vitest.integration.config.ts` — i.e. exactly the invocations whose file args
 * `wholeFileVitestArgs()` reports as "wired". Membership is computed from the ARGS; no step is
 * included because of its name.
 */
function attendanceCarryingInvocations() {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const steps = [
    [STEP_ID, requireAttendanceRealDbStepExecutable()],
    [REAL_DB_STEP_IDS.approval, requireExecutableRealDbStep(wf, REAL_DB_STEP_IDS.approval)],
    [REAL_DB_STEP_IDS.multitable, requireExecutableRealDbStep(wf, REAL_DB_STEP_IDS.multitable)],
  ]
  const out = []
  for (const [stepId, step] of steps) {
    for (const inv of vitestInvocations(step)) {
      if (!inv.usesIntegrationConfig) continue
      const attendanceFiles = inv.wholeFileArgs.filter((f) => f.startsWith('tests/integration/attendance-'))
      if (attendanceFiles.length === 0) continue
      out.push({ stepId, inv, attendanceFiles })
    }
  }
  return out
}

// NON-EMPTY CONTRIBUTOR control. Without it, a break in the contributor derivation empties the
// domain and the no-filter assertion below passes over an empty set forever — green against
// nothing (an empty scan is not an absence; that failure mode has bitten this repo before).
// Derived, not a count pin: the attendance step must contribute, since it carries the bulk of the
// corpus.
test('issue 4828 hole 2 domain is non-vacuous (attendance-carrying invocations exist, incl. the attendance step)', () => {
  const contributors = attendanceCarryingInvocations()
  assert.ok(
    contributors.length > 0,
    'no vitest invocation across the three real-DB steps appears to carry ANY attendance file — '
      + 'the contributor derivation broke, and the no-filter assertion would pass vacuously',
  )
  const stepIds = [...new Set(contributors.map((c) => c.stepId))]
  assert.ok(
    stepIds.includes(STEP_ID),
    `the attendance real-DB step "${STEP_ID}" must contribute at least one attendance-carrying `
      + `invocation (it carries the bulk of the corpus); it is missing, so the derivation broke `
      + `rather than the wiring changing — got ${JSON.stringify(stepIds)}`,
  )
})

test(`no attendance-carrying real-DB invocation uses -t/--testNamePattern (issue 4828 hole 2; shared-helper root fix tracked as issue 4829)`, () => {
  const offenders = attendanceCarryingInvocations()
    .map(({ stepId, inv, attendanceFiles }) => ({
      stepId,
      attendanceFilesAffected: attendanceFiles.length,
      filters: testNameFilterArgsOfInvocation(inv),
    }))
    .filter((o) => o.filters.length > 0)
  assert.deepEqual(
    offenders,
    [],
    `a vitest invocation carrying attendance suites must not use -t / --testNamePattern: the flag `
      + `is silent and exit-0 when it matches nothing (\`-t 'no-such-test-name-zz'\` → "Test Files `
      + `1 skipped (1)", exit 0), so every attendance suite on that command would still be reported `
      + `as a whole-file arg by wholeFileVitestArgs() — fully "wired" by all three corpora above — `
      + `while executing ZERO assertions. This is checked on EVERY step that carries attendance `
      + `files (the approval step carries the notification-redelivery family), not just the `
      + `attendance step`,
  )
})

// Negative control on the detector itself: an "assert absent" leg is worthless without proof it
// can see the thing it claims is absent (a typo'd flag name or a scan over the wrong invocation
// set would pass vacuously forever). Drive the same predicate over synthetic steps.
test('issue 4828 hole 2 detector positive control: it actually detects -t/--testNamePattern in every form, and only there', () => {
  // Exercises the SAME functions the live assertion uses — an inlined re-implementation here
  // would test a copy of the predicate rather than the shipped one.
  const detect = (runScript) => {
    const hits = []
    for (const inv of vitestInvocations({ run: runScript })) {
      if (!inv.usesIntegrationConfig) continue
      if (!inv.wholeFileArgs.some((f) => f.startsWith('tests/integration/attendance-'))) continue
      hits.push(...testNameFilterArgsOfInvocation(inv))
    }
    return hits
  }
  const BASE = 'pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-x.db.test.ts'
  // Clean command: no hit.
  assert.deepEqual(detect(BASE), [])
  // Every filter spelling is caught...
  assert.deepEqual(detect(`${BASE} -t 'zzz'`), ['-t'])
  assert.deepEqual(detect(`${BASE} --testNamePattern 'zzz'`), ['--testNamePattern'])
  assert.deepEqual(detect(`${BASE} -t=zzz`), ['-t=zzz'])
  assert.deepEqual(detect(`${BASE} --testNamePattern=zzz`), ['--testNamePattern=zzz'])
  // ...wherever it sits in the argument order (position-independent).
  assert.deepEqual(
    detect('pnpm exec vitest run -t zzz --config vitest.integration.config.ts tests/integration/attendance-x.db.test.ts'),
    ['-t'],
  )
  // A COMMENTED-OUT flag is correctly NOT a hit (this is why the check is token-derived, not a
  // substring scan of the YAML — the string "-t " appears in the text either way).
  assert.deepEqual(detect(`# ${BASE} -t 'zzz'\n${BASE}`), [])
  // A filter on a command that does NOT run under the integration config cannot make the
  // attendance suites vacuous, and is not reported.
  assert.deepEqual(detect(`pnpm exec vitest run --config vitest.config.ts tests/x.test.ts -t 'zzz'\n${BASE}`), [])
  // INVOCATION-level, not step-level: a `-t` on a sibling integration-config command that carries
  // NO attendance file cannot silence an attendance suite, so it is not reported — while the
  // attendance-carrying command on the very next line is still judged on its own args.
  assert.deepEqual(
    detect(`pnpm exec vitest run --config vitest.integration.config.ts tests/integration/multitable-x.db.test.ts -t 'zzz'\n${BASE}`),
    [],
  )
  assert.deepEqual(
    detect(`pnpm exec vitest run --config vitest.integration.config.ts tests/integration/multitable-x.db.test.ts -t 'zzz'\n${BASE} -t 'yyy'`),
    ['-t'],
  )
  // Look-alike tokens must not be mistaken for the flag.
  assert.deepEqual(detect(`${BASE} --reporter=verbose --testTimeout=60000`), [])
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
 * (74 files at conversion time); the handful of legacy DB-gated suites with plain `.test.ts`
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
// the wrong directory or a predicate typo that matches (almost) nothing goes red; 74 files
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
    `on-disk attendance-*.db.test.ts scan found only ${corpus.length} files (74 at conversion `
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

// ---------------------------------------------------------------------------------------------
// Corpus part 3 (issue 4828, owner-ruled): the hiding place the first two corpora leave open.
//
// A suite that IS DB-gated but is NOT named `*.db.test.ts` and is carried by NO real-DB run-list
// is invisible to BOTH corpora above — part 1 is a disk glob over `*.db.test.ts` (misses it by
// name), part 2 is derived from the run-lists (misses it because it is in no run-list). That is
// exactly the slot `attendance-settlement-table-v1-5a.test.ts` occupied until this PR renamed it,
// and until now the file header only said in PROSE that such a file "must be wired" — nothing
// enforced it. This closes it mechanically:
//
//   every on-disk non-.db `attendance-*.test.ts` is EITHER carried by a real-DB run-list
//   OR contains no DB gate.
//
// BOTH SIDES ARE DERIVED. The file set is a disk scan; "carried" is the SAME
// `realDbWholeFileArgUnion()` the other two corpora use (a separately-built set could drift and
// let part 3 pass on a definition of "carried" part 2 does not share). Nothing is hand-listed —
// a hand-listed domain is the defect class this guard exists to delete.
// ---------------------------------------------------------------------------------------------

/**
 * DB-gate detection by SHAPE, never by binding name. The tree expresses the gate exactly one way
 * — a conditional describe: `const <anything> = <dbUrlExpr> ? describe : describe.skip` (421
 * occurrences across tests/integration at this head, under at least four different identifiers:
 * describeDb, describeWithDb, describeIfDatabase, attendanceIntegrationDescribe). Matching the
 * IDENTIFIERS would rebuild the allowlist this PR deletes: a fifth name lands and the file is
 * silently classified ungated. So the predicate matches the ternary shape itself; the bound name
 * is irrelevant.
 *
 * Returns one of three verdicts, and the caller treats anything but 'ungated' as unwired:
 *   'gated'    — a recognized conditional-describe gate is present.
 *   'ungated'  — NO gate and NO gate-adjacent signal at all; safe to run in the no-DB job.
 *   'unknown'  — a gate-adjacent signal is present in a shape this function does not recognize
 *                (a skipIf/runIf form, a bare describe.skip that is not the ternary, a
 *                DATABASE_URL reference with no recognized gate), or the source is empty.
 *
 * 'unknown' FAILS CLOSED by design (owner ruling): an unclassifiable file must redden this guard
 * and force a human decision, never slip through the 'no DB gate' exit. The empty-source case is
 * part of that — an empty read is not evidence of absence, so it must not be classified 'ungated'
 * (readFileSync already throws on a missing path, so a wrong directory cannot pass silently
 * either).
 */
export function classifyDbGate(source) {
  if (typeof source !== 'string' || source.trim().length === 0) return 'unknown'
  const RECOGNIZED_GATE = [
    // `<expr> ? describe : describe.skip` — the form the whole tree uses.
    /\?\s*describe\s*:\s*describe\s*\.\s*skip\b/,
    // the inversion, accepted so a negated condition is not misread as "no gate".
    /\?\s*describe\s*\.\s*skip\s*:\s*describe\b/,
  ]
  if (RECOGNIZED_GATE.some((re) => re.test(source))) return 'gated'
  // Gate-ADJACENT signals: present but in no shape recognized above ⇒ cannot be called ungated.
  const GATE_ADJACENT = [
    /\bdescribe\s*\.\s*skip\b/,
    /\bdescribe\s*\.\s*(?:skipIf|runIf)\b/,
    /\b(?:it|test)\s*\.\s*(?:skipIf|runIf)\b/,
    /\bDATABASE_URL\b/,
  ]
  if (GATE_ADJACENT.some((re) => re.test(source))) return 'unknown'
  return 'ungated'
}

/** The on-disk non-.db attendance suites — part 1's complement within the attendance family. */
function onDiskNonDbAttendanceSuites(dir = INTEGRATION_DIR) {
  return readdirSync(dir)
    .filter((name) => /^attendance-.*\.test\.ts$/.test(name) && !ATTENDANCE_DB_SUITE_RE.test(name))
    .sort()
}

/**
 * The part-3 verdict for one suite. Carried short-circuits: a file the run-lists carry is wired
 * regardless of how it spells its gate, so it never needs classifying.
 */
function nonDbSuiteResidueReason({ file, source, carried }) {
  if (carried.has(`tests/integration/${file}`)) return null
  const gate = classifyDbGate(source)
  if (gate === 'ungated') return null
  return gate === 'gated'
    ? 'DB-gated but carried by no real-DB run-list — it executes NOWHERE'
    : 'gate shape unclassifiable — refusing to assume it is DB-free (fail closed)'
}

/**
 * The whole part-3 sweep as a pure-ish function of (directory, carried set) so the permanent
 * mutation test below can drive it over a SYNTHETIC temp-dir corpus — no probe fixture is
 * shipped in the real tree.
 */
function collectNonDbResidue({ dir, carried }) {
  const residue = []
  for (const file of onDiskNonDbAttendanceSuites(dir)) {
    const reason = nonDbSuiteResidueReason({
      file,
      source: readFileSync(join(dir, file), 'utf8'),
      carried,
    })
    if (reason != null) residue.push({ file, reason })
  }
  return residue
}

// Classifier unit tests over INLINE SOURCE STRINGS — no I/O, no temp dir, no fixture. This layer
// cannot go red for a path reason, so it isolates "the predicate is wrong" from "the scan read
// the wrong place" (the temp-dir test below covers the second).
test('issue 4828 classifier: recognizes the gate by shape under any binding name; fails closed on unrecognized shapes', () => {
  // All four real binding names present in the tree — the identifier must not matter.
  for (const name of ['describeDb', 'describeWithDb', 'describeIfDatabase', 'attendanceIntegrationDescribe']) {
    assert.equal(
      classifyDbGate(`const ${name} = dbUrl ? describe : describe.skip\n${name}('x', () => {})\n`),
      'gated',
      `binding name ${name} must be irrelevant — the ternary shape is the signal`,
    )
  }
  // A name never seen before must still classify as gated (the anti-allowlist property).
  assert.equal(classifyDbGate('const zzNeverSeenBefore = u ? describe : describe.skip\n'), 'gated')
  // Inverted ternary.
  assert.equal(classifyDbGate('const d = !u ? describe.skip : describe\n'), 'gated')
  // Genuinely gate-free integration test.
  assert.equal(
    classifyDbGate("import { describe, it } from 'vitest'\ndescribe('pure', () => { it('x', () => {}) })\n"),
    'ungated',
  )
  // Unclassifiable shapes must be 'unknown', NOT 'ungated' — these are the fail-closed cases.
  assert.equal(classifyDbGate("describe.skipIf(!process.env.PG)('x', () => {})\n"), 'unknown')
  assert.equal(classifyDbGate("describe.runIf(hasDb)('x', () => {})\n"), 'unknown')
  assert.equal(classifyDbGate("const d = pickDescribe(hasDb)\nd('x', () => {})\n"), 'ungated')
  assert.equal(classifyDbGate("if (!process.env.DATABASE_URL) return\n"), 'unknown')
  assert.equal(classifyDbGate("describe.skip('temporarily off', () => {})\n"), 'unknown')
  // An empty read is not evidence of absence.
  assert.equal(classifyDbGate(''), 'unknown')
  assert.equal(classifyDbGate('   \n\t '), 'unknown')
  assert.equal(classifyDbGate(undefined), 'unknown')
})

// PERMANENT ENCODING of the owner-named mutation: "a DB-gated attendance-*.test.ts that is NOT
// renamed and NOT wired must red". Driven over a temp-dir corpus, so the probe never lives in
// packages/core-backend/tests/integration.
test('issue 4828 residue sweep: a DB-gated, non-.db-named, un-carried suite is detected (temp-dir corpus)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w4c2-part3-'))
  try {
    const GATED = "const describeDb = process.env.DATABASE_URL ? describe : describe.skip\ndescribeDb('x', () => {})\n"
    const UNGATED = "import { describe, it } from 'vitest'\ndescribe('pure', () => { it('x', () => {}) })\n"
    const ODD = "describe.skipIf(!process.env.PG)('x', () => {})\n"
    writeFileSync(join(dir, 'attendance-probe-gated-uncarried.test.ts'), GATED)
    writeFileSync(join(dir, 'attendance-probe-gated-carried.test.ts'), GATED)
    writeFileSync(join(dir, 'attendance-probe-ungated.test.ts'), UNGATED)
    writeFileSync(join(dir, 'attendance-probe-unclassifiable.test.ts'), ODD)
    // Out-of-family / out-of-corpus decoys that must NOT be swept by this corpus.
    writeFileSync(join(dir, 'multitable-probe-gated.test.ts'), GATED)
    writeFileSync(join(dir, 'attendance-probe-named.db.test.ts'), GATED)

    const carried = new Set(['tests/integration/attendance-probe-gated-carried.test.ts'])
    const residue = collectNonDbResidue({ dir, carried })
    assert.deepEqual(
      residue.map((r) => r.file).sort(),
      ['attendance-probe-gated-uncarried.test.ts', 'attendance-probe-unclassifiable.test.ts'],
      'the gated+uncarried suite AND the unclassifiable one must both be residue; the carried '
        + 'one, the genuinely gate-free one, the other family and the .db-named file must not',
    )
    assert.match(residue.find((r) => r.file.endsWith('gated-uncarried.test.ts')).reason, /executes NOWHERE/)
    assert.match(residue.find((r) => r.file.endsWith('unclassifiable.test.ts')).reason, /fail closed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Non-vacuity floor on the part-3 scan itself: 13 non-.db attendance suites exist at this head.
test('issue 4828 corpus part 3 is non-vacuous (the non-.db attendance family is non-empty)', () => {
  const files = onDiskNonDbAttendanceSuites()
  assert.ok(
    files.length >= 8,
    `on-disk non-.db attendance-*.test.ts scan found only ${files.length} files (13 at this head) `
      + `— a near-empty scan means the directory path or the predicate broke, not that the family `
      + `shrank by that much`,
  )
})

// The live assertion, one test per file so the failure names the offender.
for (const file of onDiskNonDbAttendanceSuites()) {
  test(`tests/integration/${file} (non-.db-named) is carried by a real-DB run-list OR has no DB gate`, () => {
    const reason = nonDbSuiteResidueReason({
      file,
      source: readFileSync(join(INTEGRATION_DIR, file), 'utf8'),
      carried: new Set(realDbWholeFileArgUnion()),
    })
    assert.equal(
      reason,
      null,
      `tests/integration/${file}: ${reason} — a DB-gated suite that is neither renamed to the `
        + `*.db.test.ts convention (corpus part 1) nor carried by a real-DB run-list (corpus `
        + `part 2) is invisible to BOTH: the no-DB job collects it and the conditional describe `
        + `skip-greens it, so no CI job ever executes it. Wire it into a real-DB step's run-list `
        + `(and the no-DB test.exclude), or rename it to *.db.test.ts and two-point wire it. `
        + `Adding an exclusion here instead is a contract change requiring an owner ruling `
        + `(issue 4828)`,
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
      `real-DB run-lists carry only ${carried.length} attendance files (87 at conversion time) — `
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
