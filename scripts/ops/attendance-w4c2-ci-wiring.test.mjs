import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  REAL_DB_STEP_IDS,
  extractStepById,
  isQuotedInTestExclude,
  quotedExcludeEntries,
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
//   corpus part 1 (disk → wiring), TOTAL over the family: every attendance-prefixed SUITE under
//     packages/core-backend/tests/integration, found RECURSIVELY, must be excluded from the no-DB
//     job's vitest.config.ts IF AND ONLY IF it is a whole-file vitest arg of an EXECUTABLE real-DB
//     step in plugin-tests.yml — so it runs exactly once, with a database. Both directions fail:
//     carried-but-not-excluded is collected twice and skip-greens in the no-DB job;
//     excluded-but-not-carried executes NOWHERE. A suite that is neither must prove it needs no
//     database (below). 87 members at this head.
//     "Is a suite" is the UNION of two independent derivations, neither of them a list of names:
//     the file's path matches an `include` glob compiled from a vitest config's own literal, OR
//     its masked source calls a vitest suite API. No suffix and no directory depth is written down
//     here. The narrower predicate this replaced (`/^attendance-.*\.db\.test\.ts$/` over a FLAT
//     readdirSync) was provably narrower than the collector it reconciled against: a `.spec.ts`
//     probe and a subdirectory probe were both collected and skip-greened by the no-DB job while
//     sitting in NO corpus and this guard stayed fully green (both executed, 2026-08-08).
//   corpus part 2 (wiring → disk): every attendance-prefixed whole-file arg the real-DB run-lists
//     actually carry must exist on disk (vitest exits 0 on an unmatched path argument, so a
//     rename/delete with stale wiring stays green otherwise). Its exclude leg is now part 1's, in
//     both directions. This part also pins vitest.integration.config.ts itself: every carried
//     attendance arg must match that config's `include` and none of its `exclude`, and it must
//     declare no `testNamePattern` — otherwise one config edit silences every carried suite with
//     the run-lists, the excludes and the argument allowlist all still green.
//   corpus part 3 (issue 4828, owner-ruled 2026-08-08): the residual cell — a suite that is
//     NEITHER excluded NOR carried genuinely lives in the no-DB job, and must carry POSITIVE proof
//     that it executes assertions without a database. Not "no gate was recognised": proof. The
//     first implementation had it the other way round — it enumerated four gate-ADJACENT source
//     patterns and called everything else gate-free — and review executed ten real gate shapes
//     that it waved through, including a self-skip on this lane's own ATTENDANCE_TEST_DATABASE_URL
//     and a gate hoisted into a helper module. The default is now `unknown`, which reds.
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
// KNOWN RESIDUAL, stated rather than left to be found: the corpus derivation is static, because the
// step that runs this file (plugin-tests.yml, "Attendance W4C-2 CI wiring contract", :448) executes
// BEFORE `Setup pnpm` (:495) and `pnpm install --frozen-lockfile` (:521) — vitest does not exist in
// the workspace yet, so the file set cannot be taken from vitest's own collection. One shape
// therefore remains outside it: a file that declares no suite API inline, does not match any
// `include` glob of either config, and is nonetheless collected by the no-DB job while importing a
// module that declares its suites. Both configs' `include` values are read from the configs
// themselves, and vitest.config.ts having no explicit `include` is asserted rather than assumed, so
// this residual cannot widen without a red.
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
// Issue 4828 hole 2 (owner-ruled): "wired" must also mean "the command actually executes the
// files it carries".
//
// `wholeFileVitestArgs()` reports a file as a whole-file arg without inspecting the OTHER args on
// the same command, and several vitest flags are silent and exit-0 while executing nothing or
// almost nothing:
//     vitest --config vitest.integration.config.ts <file> -t 'no-such-test-name-zz'
//     → exits 0, "Test Files 1 skipped (1)"
//     vitest --config vitest.integration.config.ts <6 files> --shard=1/6
//     → exits 0, "Test Files 1 passed (1)" — 5 of 6 carried files never ran
//     vitest --config … <files> --exclude 'tests/integration/attendance-**' --passWithNoTests
//     → exits 0, "No test files found"
// So a suite can satisfy BOTH wiring points, be carried by an executable real-DB step, and still
// execute ZERO assertions while every corpus leg above stays green — the same skip-green shape
// this guard exists to eliminate, one level further in.
//
// THIS IS CHECKED AS AN ALLOWLIST, NOT A LIST OF FORBIDDEN SPELLINGS. The first draft of this leg
// asserted the ABSENCE of four literal spellings of one flag (`-t`, `--testNamePattern`, and their
// `=`-joined forms). Review of that draft executed three families that keep the whole guard green:
// `--shard=1/6`; `--exclude …` / `--dir …` paired with `--passWithNoTests`; and `-t` carried in a
// shell variable (`$NAME_FILTER`, `${F}`, `$(…)`, backticks), which `shellTokens` does not expand,
// so the literal never appears in the arg list. Enumerating those would just move the boundary —
// the standing failure mode in this tree. The assertion is therefore POSITIVE: every argument of an
// attendance-carrying invocation must be drawn from a small allowlist of tokens that provably do
// not change WHICH tests execute (the `run` subcommand, `--config` + its value, `--reporter`, and
// the carried file paths themselves, taken from `inv.wholeFileArgs` so this leg cannot drift from
// the shared "is a whole-file arg" definition). Anything else — a new vitest narrowing flag nobody
// has thought of, an unexpanded `$VAR`, `--passWithNoTests` (which converts "selected nothing" into
// success) — is unrecognised and REDS. An allowlist fails closed on the next flag; a denylist fails
// open on it.
//
// BEHAVIOUR NOTE (stated, not left to be discovered): a path argument outside
// `tests/integration/**` — e.g. a `tests/unit/x.test.ts` appended to one of these commands — is not
// in `inv.wholeFileArgs` for that invocation and therefore reds too. No real-DB step carries such an
// argument today; if one legitimately needs to, that is an owner decision, not a silent widening.
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
 * Arguments of ONE vitest invocation that are NOT drawn from the positive allowlist of tokens
 * known to leave WHAT EXECUTES untouched. The allowlist, and only it:
 *
 *   - `run`                     the subcommand (does not select tests)
 *   - `--config <v>` / `-c <v>` / `--config=<v>`   which config file (pinned by
 *                               `usesIntegrationConfig` on the domain itself; a config that
 *                               narrowed collection would red the integration-config pin below)
 *   - `--reporter <v>` / `--reporter=<v>`          output format only
 *   - any token that is already one of THIS invocation's `wholeFileArgs`   the carried suites
 *
 * `wholeFileArgs` comes from the shared `vitestInvocations()`, so "is a file argument" cannot drift
 * between this leg and the three corpora — there is no second copy of that regex here.
 *
 * A separate-form flag consumes its value ONLY when the next token does not itself start with `-`,
 * so `--reporter -t zzz` cannot swallow the `-t`.
 *
 * @param {{ args: string[], wholeFileArgs: string[] }} inv
 * @returns {string[]} every unrecognised token, in order
 */
function unpermittedArgsOfInvocation(inv) {
  const fileArgs = new Set(inv.wholeFileArgs)
  const consumesValue = (flag) => flag === '--config' || flag === '-c' || flag === '--reporter'
  const out = []
  for (let i = 0; i < inv.args.length; i++) {
    const arg = inv.args[i]
    if (arg === 'run') continue
    if (consumesValue(arg)) {
      const value = inv.args[i + 1]
      if (typeof value === 'string' && !value.startsWith('-')) i += 1
      continue
    }
    if (/^(?:--config|--reporter)=/.test(arg)) continue
    if (fileArgs.has(arg)) continue
    out.push(arg)
  }
  return out
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

test(`every attendance-carrying real-DB invocation runs its files with no execution-narrowing argument (issue 4828 hole 2; shared-helper root fix tracked as issue 4829)`, () => {
  const offenders = attendanceCarryingInvocations()
    .map(({ stepId, inv, attendanceFiles }) => ({
      stepId,
      attendanceFilesAffected: attendanceFiles.length,
      unpermitted: unpermittedArgsOfInvocation(inv),
    }))
    .filter((o) => o.unpermitted.length > 0)
  assert.deepEqual(
    offenders,
    [],
    `a vitest invocation carrying attendance suites may only carry arguments that provably do not `
      + `change which tests execute (\`run\`, \`--config\`+value, \`--reporter\`, and its own carried `
      + `file paths). An unrecognised argument reds because the silent-and-exit-0 family is open-`
      + `ended: \`-t 'no-such-test-name-zz'\` → "Test Files 1 skipped (1)"; \`--shard=1/6\` runs one `
      + `file of six; \`--exclude …\`/\`--dir …\` with \`--passWithNoTests\` runs none; a \`$VAR\` `
      + `holding any of them is invisible to token matching because the shell expands it at runtime. `
      + `In every case each attendance suite on the command is still reported as a whole-file arg by `
      + `wholeFileVitestArgs() — fully "wired" by all three corpora above — while executing ZERO `
      + `assertions. This is checked on EVERY step that carries attendance files (the approval step `
      + `carries the notification-redelivery family), not just the attendance step`,
  )
})

// Negative control on the detector itself: an "assert absent" leg is worthless without proof it
// can see the thing it claims is absent (a typo'd flag name or a scan over the wrong invocation
// set would pass vacuously forever). Drive the same predicate over synthetic steps.
test('issue 4828 hole 2 detector positive control: the allowlist accepts the real argument vocabulary and rejects every executed bypass family', () => {
  // Exercises the SAME functions the live assertion uses — an inlined re-implementation here
  // would test a copy of the predicate rather than the shipped one.
  const detect = (runScript) => {
    const hits = []
    for (const inv of vitestInvocations({ run: runScript })) {
      if (!inv.usesIntegrationConfig) continue
      if (!inv.wholeFileArgs.some((f) => f.startsWith('tests/integration/attendance-'))) continue
      hits.push(...unpermittedArgsOfInvocation(inv))
    }
    return hits
  }
  const BASE = 'pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-x.db.test.ts'
  // The REAL argument vocabulary of all three real-DB steps at this head — must be accepted, or
  // this leg would red the live workflow and be neutered on arrival.
  assert.deepEqual(detect(BASE), [])
  assert.deepEqual(detect(`${BASE} --reporter=dot`), [])
  assert.deepEqual(detect(`${BASE} --reporter dot`), [])
  assert.deepEqual(detect(`pnpm exec vitest --config=vitest.integration.config.ts run tests/integration/attendance-x.db.test.ts`), [])
  assert.deepEqual(detect(`pnpm exec vitest -c vitest.integration.config.ts run tests/integration/attendance-x.db.test.ts`), [])
  // (a) the owner-named test-name filter, every spelling, position-independent.
  assert.deepEqual(detect(`${BASE} -t 'zzz'`), ['-t', 'zzz'])
  assert.deepEqual(detect(`${BASE} --testNamePattern 'zzz'`), ['--testNamePattern', 'zzz'])
  assert.deepEqual(detect(`${BASE} -t=zzz`), ['-t=zzz'])
  assert.deepEqual(detect(`${BASE} --testNamePattern=zzz`), ['--testNamePattern=zzz'])
  assert.deepEqual(
    detect('pnpm exec vitest run -t zzz --config vitest.integration.config.ts tests/integration/attendance-x.db.test.ts'),
    ['-t', 'zzz'],
  )
  // (b) sibling silencers the spelling-enumeration draft let through, executed against vitest
  // 1.6.1 and all exit-0: sharding drops files, exclude/dir + passWithNoTests select nothing.
  assert.deepEqual(detect(`${BASE} --shard=1/6`), ['--shard=1/6'])
  assert.deepEqual(detect(`${BASE} --shard 1/6`), ['--shard', '1/6'])
  assert.deepEqual(detect(`${BASE} --passWithNoTests`), ['--passWithNoTests'])
  assert.deepEqual(
    detect(`${BASE} --exclude 'tests/integration/attendance-**' --passWithNoTests`),
    ['--exclude', 'tests/integration/attendance-**', '--passWithNoTests'],
  )
  assert.deepEqual(detect(`${BASE} --dir tests/nowhere --passWithNoTests`), ['--dir', 'tests/nowhere', '--passWithNoTests'])
  assert.deepEqual(detect(`${BASE} --project foo`), ['--project', 'foo'])
  // (c) the flag carried in a shell variable — `shellTokens` does not expand shell syntax, so the
  // literal `-t` never appears; the UNEXPANDED token is what reds.
  assert.deepEqual(detect(`${BASE} $NAME_FILTER`), ['$NAME_FILTER'])
  assert.deepEqual(detect(`${BASE} \${NAME_FILTER}`), ['${NAME_FILTER}'])
  assert.ok(detect(`${BASE} $(echo -t) zzz`).length > 0, 'command substitution must not be permitted')
  assert.ok(detect(`${BASE} \`echo -t\` zzz`).length > 0, 'backtick substitution must not be permitted')
  // (d) a path argument outside tests/integration is not one of THIS invocation's wholeFileArgs.
  assert.deepEqual(detect(`${BASE} tests/unit/attendance-x.test.ts`), ['tests/unit/attendance-x.test.ts'])
  // A COMMENTED-OUT flag is correctly NOT a hit (this is why the check is token-derived, not a
  // substring scan of the YAML — the string "-t " appears in the text either way).
  assert.deepEqual(detect(`# ${BASE} -t 'zzz'\n${BASE}`), [])
  // A narrowing argument on a command that does NOT run under the integration config cannot make
  // the attendance suites vacuous, and is not reported.
  assert.deepEqual(detect(`pnpm exec vitest run --config vitest.config.ts tests/x.test.ts -t 'zzz'\n${BASE}`), [])
  // INVOCATION-level, not step-level: a filter on a sibling integration-config command that carries
  // NO attendance file cannot silence an attendance suite, so it is not reported — while the
  // attendance-carrying command on the very next line is still judged on its own args.
  assert.deepEqual(
    detect(`pnpm exec vitest run --config vitest.integration.config.ts tests/integration/multitable-x.db.test.ts -t 'zzz'\n${BASE}`),
    [],
  )
  assert.deepEqual(
    detect(`pnpm exec vitest run --config vitest.integration.config.ts tests/integration/multitable-x.db.test.ts -t 'zzz'\n${BASE} -t 'yyy'`),
    ['-t', 'yyy'],
  )
  // A flag NOT on the allowlist reds even when it is harmless in isolation — that is the point of
  // an allowlist, and the cost is one owner decision per genuinely new argument.
  assert.deepEqual(detect(`${BASE} --testTimeout=60000`), ['--testTimeout=60000'])
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

/**
 * The `run:` scripts of a job's steps, IN DOCUMENT ORDER, off the parsed YAML (same fail-closed
 * python3+PyYAML bridge as above). Order is the point: it is what lets the ordering leg below
 * assert that this guard runs before the workspace install rather than assert it in a comment.
 */
function stepRunScriptsOfJob(jobName) {
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
    'job = jobs.get(sys.argv[1]) if isinstance(jobs, dict) else None',
    'steps = job.get("steps") if isinstance(job, dict) else None',
    'out = []',
    'if isinstance(steps, list):',
    '    for step in steps:',
    '        run = step.get("run") if isinstance(step, dict) else None',
    '        out.append(run if isinstance(run, str) else "")',
    'json.dump(out, sys.stdout)',
  ].join('\n')
  const res = spawnSync('python3', ['-c', py, jobName], {
    input: wf,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  })
  if (res.error) {
    throw new Error(`step-order guard: failing CLOSED — python3 could not be spawned (${res.error.message})`)
  }
  if (res.status !== 0) {
    throw new Error(
      `step-order guard: failing CLOSED — PyYAML bridge exited ${res.status}: `
        + `${(res.stderr || '').trim() || '(no stderr)'}`,
    )
  }
  return JSON.parse(res.stdout)
}

// Why the corpus below is derived STATICALLY rather than from vitest's own collection: this guard
// runs before the workspace install, so vitest does not exist yet. That is a real property of the
// workflow, so it is asserted here instead of claimed in a comment that could quietly stop being
// true. If the guard is ever moved after the install, this leg reds and the stronger, EXECUTED
// derivation becomes available to the corpus — that is a deliberate decision point, not a silent
// one.
test(`this guard's step runs BEFORE the workspace install in job "${REQUIRED_JOB}" (why its corpus is static)`, () => {
  const runs = stepRunScriptsOfJob(REQUIRED_JOB)
  const guardAt = runs.findIndex((r) => r.includes('scripts/ops/attendance-w4c2-ci-wiring.test.mjs'))
  const installAt = runs.findIndex((r) => /\bpnpm install\b/.test(r))
  assert.ok(guardAt >= 0, `this guard's own step was not found in job "${REQUIRED_JOB}" — it must run there`)
  assert.ok(installAt >= 0, `no \`pnpm install\` step found in job "${REQUIRED_JOB}" — the ordering claim cannot be evaluated`)
  assert.ok(
    guardAt < installAt,
    `this guard's step (index ${guardAt}) must precede \`pnpm install\` (index ${installAt}): it is `
      + `placed pre-install so a wiring break reds the required check in seconds, and the corpus `
      + `derivation documents that placement as the reason it cannot use vitest's own collection`,
  )
})

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

const CORE_BACKEND_DIR = join(repoRoot, 'packages/core-backend')
const INTEGRATION_DIR = join(CORE_BACKEND_DIR, 'tests/integration')
const INTEGRATION_ARG_PREFIX = 'tests/integration/'
/** The config the NO-DB job runs under (`pnpm test` in packages/core-backend). */
const NO_DB_CONFIG = 'vitest.config.ts'
/** The config every real-DB step runs under. */
const INTEGRATION_CONFIG = 'vitest.integration.config.ts'

const readCoreBackendFile = (rel) => readFileSync(join(CORE_BACKEND_DIR, rel), 'utf8')

/**
 * Source with comments AND string/template bodies blanked, positions preserved. Used for every
 * STRUCTURAL question below (does this file call a suite API, does it read the environment, does
 * this config declare a key) so a mention inside a comment or a test title can never answer one.
 *
 * Local rather than imported: `ci-realdb-step-contract.mjs` has an equivalent private masker, but
 * that module is shared by 17 guards and is deliberately untouched by this change (its
 * whole-file-arg root fix is repo-level issue 4829).
 */
function maskSourceNoise(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < src.length) {
        out += '  '
        i += 2
      }
      continue
    }
    if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const quote = src[i]
      out += ' '
      i += 1
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          out += '  '
          i += 2
          continue
        }
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < src.length) {
        out += ' '
        i += 1
      }
      continue
    }
    out += src[i]
    i += 1
  }
  return out
}

/**
 * Entries of the DIRECT `test.<key>: [ … ]` array of a vitest config, or `null` when the key is
 * absent as a direct property of `test` (a nested `coverage.exclude`, a commented-out key, or a
 * free-text mention does not count). Same depth-1 discipline as the shared
 * `extractTestExcludeArrayBody`, generalised to any key because this guard needs `include` too.
 */
function directTestArrayEntries(src, key) {
  const keyRe = new RegExp(`^${key}\\s*:\\s*\\[`)
  const masked = maskSourceNoise(src)
  const testKey = /\btest\s*:\s*\{/.exec(masked)
  if (!testKey) return null
  const openBrace = masked.indexOf('{', testKey.index + testKey[0].length - 1)
  if (openBrace < 0) return null
  let depth = 1
  let i = openBrace + 1
  while (i < masked.length && depth > 0) {
    const ch = masked[i]
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1
      i += 1
      continue
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1
      i += 1
      continue
    }
    if (depth === 1) {
      const m = keyRe.exec(masked.slice(i))
      if (m) {
        const bracketOpen = i + m[0].length - 1
        let bDepth = 0
        for (let j = bracketOpen; j < masked.length; j++) {
          if (masked[j] === '[') bDepth += 1
          else if (masked[j] === ']') {
            bDepth -= 1
            // Slice the ORIGINAL source so quoted entries survive the mask.
            if (bDepth === 0) return quotedExcludeEntries(src.slice(bracketOpen + 1, j))
          }
        }
        return null
      }
    }
    i += 1
  }
  return null
}

/** True when the config declares a direct `test.<key>` of ANY value shape. */
function declaresDirectTestKey(src, key) {
  const keyRe = new RegExp(`^${key}\\s*:`)
  const masked = maskSourceNoise(src)
  const testKey = /\btest\s*:\s*\{/.exec(masked)
  if (!testKey) return false
  const openBrace = masked.indexOf('{', testKey.index + testKey[0].length - 1)
  if (openBrace < 0) return false
  let depth = 1
  let i = openBrace + 1
  while (i < masked.length && depth > 0) {
    const ch = masked[i]
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1
    else if (depth === 1 && keyRe.test(masked.slice(i))) return true
    i += 1
  }
  return false
}

/**
 * A vitest include/exclude glob, compiled to an anchored RegExp over package-relative POSIX paths.
 * Mechanical — every construct vitest's matcher supports in these configs is translated, and any
 * construct this converter does NOT understand THROWS rather than silently compiling to something
 * narrower (a mis-compiled include would shrink the corpus, which is the failure mode the whole
 * derivation exists to prevent).
 *
 * `**` spans zero or more path segments (picomatch semantics) — the case that matters here, since
 * `tests/integration/ ** /x.test.ts` must match a TOP-LEVEL `tests/integration/x.test.ts` as well
 * as a nested one.
 */
function globToRegExp(glob) {
  return new RegExp(`^${globBody(glob)}$`)
}

function globBody(glob) {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (glob.startsWith('**/', i)) {
      re += '(?:[^/]+/)*' // zero or more whole segments
      i += 3
      continue
    }
    if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      re += '(?:/.*)?'
      i += 3
      continue
    }
    if (glob.startsWith('**', i)) {
      re += '.*'
      i += 2
      continue
    }
    if (ch === '*') {
      re += '[^/]*'
      i += 1
      continue
    }
    if (/[?*+@!]/.test(ch) && glob[i + 1] === '(') {
      const close = matchingBracket(glob, i + 1, '(', ')')
      const alternatives = splitTopLevel(glob.slice(i + 2, close), '|').map(globBody)
      const group = `(?:${alternatives.join('|')})`
      if (ch === '?') re += `${group}?`
      else if (ch === '*') re += `${group}*`
      else if (ch === '+') re += `${group}+`
      else if (ch === '@') re += group
      else throw new Error(`glob→regexp: unsupported extglob "!(" in ${JSON.stringify(glob)}`)
      i = close + 1
      continue
    }
    if (ch === '?') {
      re += '[^/]'
      i += 1
      continue
    }
    if (ch === '{') {
      const close = matchingBracket(glob, i, '{', '}')
      re += `(?:${splitTopLevel(glob.slice(i + 1, close), ',').map(globBody).join('|')})`
      i = close + 1
      continue
    }
    if (ch === '[') {
      const close = glob.indexOf(']', i + 1)
      if (close < 0) throw new Error(`glob→regexp: unterminated character class in ${JSON.stringify(glob)}`)
      re += glob.slice(i, close + 1) // character classes are regexp syntax already
      i = close + 1
      continue
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  return re
}

function matchingBracket(text, start, open, close) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth += 1
    else if (text[i] === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error(`glob→regexp: unbalanced ${open}${close} in ${JSON.stringify(text)}`)
}

function splitTopLevel(text, separator) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(' || ch === '{' || ch === '[') depth += 1
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1
    if (ch === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/** Package-relative POSIX paths of every file under `dir`, RECURSIVELY. Throws on a missing dir. */
function walkFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/**
 * A call to a vitest suite/test API in ANY member form (`describe(`, `it.each(`, `test.skipIf(`,
 * `describe.skip(`). Matched against MASKED source, so a mention in a comment or inside a test
 * title cannot make a fixture look like a suite.
 */
const SUITE_API_CALL_RE = /(?:^|[^.\w$])(?:describe|it|test|suite|bench)\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)*\(/

/**
 * The attendance corpus: every file under tests/integration (RECURSIVELY) whose basename carries
 * the family prefix AND that is a test suite by EITHER of two independent derivations —
 *
 *   (a) its path matches an `include` glob of a vitest config in this package, compiled from the
 *       config's own literal — no `.test.ts` (or any other suffix) is written down here; or
 *   (b) its masked source calls a vitest suite API, which is true of a suite whatever it is named.
 *
 * The UNION is the point. (a) alone was the shipped defect: a hand-written `.test.ts` literal plus
 * a FLAT `readdirSync` is narrower than the collector it reconciles against, so a `.spec.ts` suite
 * or one a directory deep sat in NO corpus and was skip-greened by the no-DB job with this guard
 * fully green (both executed, 2026-08-08). (b) alone would miss a suite whose declarations come
 * from an imported module. Either derivation going narrow leaves the other one standing, and
 * neither is a list of names.
 */
function attendanceCorpus({ dir = INTEGRATION_DIR, includeRegexes = suiteIncludeRegexes() } = {}) {
  const out = []
  for (const rel of walkFiles(dir)) {
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    if (!base.startsWith('attendance-')) continue
    const arg = `${INTEGRATION_ARG_PREFIX}${rel}`
    const source = readFileSync(join(dir, rel), 'utf8')
    const matchesInclude = includeRegexes.some((re) => re.test(arg))
    if (!matchesInclude && !SUITE_API_CALL_RE.test(maskSourceNoise(source))) continue
    out.push({ rel, arg, source })
  }
  return out
}

/**
 * The `include` globs of every vitest config in this package that can collect a
 * tests/integration file, compiled. `vitest.config.ts` (the NO-DB job) declares none today and
 * therefore falls back to vitest's own default — an assumption this guard PINS below rather than
 * re-implements, so growing an explicit `include` there reddens instead of silently narrowing
 * this corpus.
 */
function suiteIncludeRegexes() {
  const globs = [
    ...(directTestArrayEntries(readCoreBackendFile(INTEGRATION_CONFIG), 'include') ?? []),
    ...(directTestArrayEntries(readCoreBackendFile(NO_DB_CONFIG), 'include') ?? []),
  ]
  return globs.map(globToRegExp)
}

/** The exact quoted entries of the no-DB job's `test.exclude` (the set the collector removes). */
function noDbExcludedArgs() {
  return new Set(directTestArrayEntries(readCoreBackendFile(NO_DB_CONFIG), 'exclude') ?? [])
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

// Negative controls on the DERIVATION ITSELF. An empty or broken enumeration must red, never pass
// vacuously, and every mechanical converter it depends on is exercised on inputs whose right
// answer is known — including the ones whose WRONG answer would silently shrink the corpus.
test('glob→regexp converter: `**` spans zero segments, the suffix alternation is honoured, and non-suites do not match', () => {
  const re = globToRegExp('tests/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)')
  // The zero-segment case. Getting this wrong (`/.*/ ` instead of `(?:[^/]+/)*`) would drop EVERY
  // top-level suite out of the corpus — the whole family — so it is asserted first.
  assert.ok(re.test('tests/integration/attendance-x.test.ts'), '`**/` must match zero segments')
  assert.ok(re.test('tests/integration/sub/attendance-x.test.ts'), '`**/` must match one segment')
  assert.ok(re.test('tests/integration/a/b/attendance-x.test.ts'), '`**/` must match many segments')
  // The suffix vocabulary comes from the config; these are the alternatives it spells.
  for (const suffix of ['test.ts', 'spec.ts', 'test.tsx', 'test.cts', 'test.mjs', 'spec.js']) {
    assert.ok(re.test(`tests/integration/attendance-x.${suffix}`), `.${suffix} must be collected`)
  }
  // Negative controls: a non-suite companion, another directory, a near-miss suffix.
  assert.ok(!re.test('tests/integration/attendance-w4c3b-central-approval.env.ts'))
  assert.ok(!re.test('tests/integration/attendance-x.ts'))
  assert.ok(!re.test('tests/unit/attendance-x.test.ts'))
  assert.ok(!re.test('tests/integration/attendance-x.test.ts.bak'))
  // node_modules/dist exclude globs must NOT swallow a real suite path.
  assert.ok(!globToRegExp('**/node_modules/**').test('tests/integration/attendance-x.db.test.ts'))
  assert.ok(globToRegExp('**/node_modules/**').test('tests/integration/node_modules/x.test.ts'))
  // Unsupported syntax fails CLOSED rather than compiling to something narrower.
  assert.throws(() => globToRegExp('tests/!(integration)/x.test.ts'), /unsupported extglob/)
})

test('suite-API detector: any member form counts, prose and test titles do not', () => {
  const detects = (src) => SUITE_API_CALL_RE.test(maskSourceNoise(src))
  assert.ok(detects("describe('x', () => {})"))
  assert.ok(detects("describeDb('x', () => {})\nit('y', () => {})"))
  assert.ok(detects('describe.skip("x", () => {})'))
  assert.ok(detects('it.each([1])("x", () => {})'))
  assert.ok(detects('test.skipIf(!u)("x", () => {})'))
  // Prose / titles / other families' identifiers must not manufacture a suite.
  assert.ok(!detects('// this fixture is used by describe( blocks elsewhere'))
  assert.ok(!detects("const label = 'describe(' \n export const x = 1\n"))
  assert.ok(!detects('export const unit = (n) => n\nunit(1)\n'))
  assert.ok(!detects('const scratch = process.env.ATTENDANCE_TEST_DATABASE_URL\n'))
})

test('OBS-1 corpus derivation is non-vacuous and both wiring sides parse', () => {
  const corpus = attendanceCorpus()
  assert.ok(
    corpus.length >= 70,
    `attendance corpus scan under tests/integration found only ${corpus.length} suites (87 at this `
      + `head) — a near-empty scan means the directory path, the include globs or the suite-API `
      + `detector broke, not that the family shrank by that much`,
  )
  const union = realDbWholeFileArgUnion()
  assert.ok(union.length > 0, 'real-DB steps carry no whole-file args at all — run-list parsing broke')
  const excluded = noDbExcludedArgs()
  assert.ok(excluded.size > 0, 'vitest.config.ts test.exclude parsed as empty — the config parse broke')
  // This file parses `test.exclude` locally (it needs `test.include` too, which the shared module
  // does not expose). Prove the local parse agrees with the shared, already-gated
  // `isQuotedInTestExclude` on every corpus member, so the two cannot drift apart.
  const cfg = readCoreBackendFile(NO_DB_CONFIG)
  for (const { arg } of corpus) {
    assert.equal(
      excluded.has(arg),
      isQuotedInTestExclude(cfg, arg),
      `local test.exclude parse disagrees with the shared isQuotedInTestExclude for ${arg}`,
    )
  }
})

// The no-DB job's config declares no `include`, so vitest's own default decides what it collects
// and this guard's corpus leans on the integration config's `include` for its suffix vocabulary.
// That assumption is PINNED, not assumed: growing an explicit `include` in vitest.config.ts changes
// what the no-DB job collects, and must force a human to re-derive rather than silently narrow the
// corpus underneath this guard.
test('the no-DB job config declares no explicit test.include (the assumption this corpus rests on)', () => {
  assert.equal(
    directTestArrayEntries(readCoreBackendFile(NO_DB_CONFIG), 'include'),
    null,
    `packages/core-backend/${NO_DB_CONFIG} has grown a direct test.include: the no-DB job now `
      + `collects a set this guard did not derive from. Feed those globs into suiteIncludeRegexes() `
      + `(they are already unioned in — this leg exists so the change is noticed, not so it is `
      + `forbidden) and re-run the corpus floor before removing this assertion`,
  )
})

// Corpus part 1 (disk → wiring), now TOTAL over the family: for every attendance suite on disk,
// "excluded from the no-DB job" and "carried by an executable real-DB run-list" must be the SAME
// answer, and when both are false the file lives in the no-DB job and must prove it needs no
// database. See the part-3 header below for why the two directions are one assertion.
for (const entry of attendanceCorpus()) {
  test(`${entry.arg} runs exactly once, with a database (no-DB exclude ⟺ real-DB run-list)`, () => {
    const reason = attendanceSuiteResidueReason({
      arg: entry.arg,
      source: readFileSync(join(INTEGRATION_DIR, entry.rel), 'utf8'),
      carried: new Set(realDbWholeFileArgUnion()),
      excluded: noDbExcludedArgs(),
    })
    assert.equal(reason, null, `${entry.arg}: ${reason}`)
  })
}

// ---------------------------------------------------------------------------------------------
// Corpus part 3 (issue 4828, owner-ruled): the hiding place the first two corpora leave open —
// closed by a TOTAL partition instead of by classifying gate shapes.
//
// The slot: a suite that IS DB-gated but is NOT named `*.db.test.ts` and is carried by NO real-DB
// run-list was invisible to a `*.db.test.ts` disk glob (misses it by name) and to a run-list
// derivation (misses it because it is in no run-list) alike. That is exactly the slot
// `attendance-settlement-table-v1-5a.test.ts` occupied until this PR renamed it.
//
// The FIRST implementation of this leg closed the slot by asking "does this file contain a DB
// gate?", answering from a four-entry list of gate-ADJACENT source patterns, and treating anything
// that tripped none of them as gate-free. Review executed that classifier over fourteen real gate
// shapes: TEN returned the safe-to-run-with-no-database verdict, including a self-skip on this
// lane's OWN `ATTENDANCE_TEST_DATABASE_URL` (invisible to `/\bDATABASE_URL\b/` — the preceding `_`
// is a word character, so there is no word boundary), a gate hoisted into a helper module, and a
// `beforeAll(ctx => ctx.skip())`. Extending the list would have moved the boundary, not removed it.
//
// So the question changed. This leg no longer asks what a file contains; it asks WHERE THE FILE
// RUNS, which is stated in two machine-readable places and nowhere else:
//
//   excluded from the no-DB job's vitest.config.ts   ⟺   carried by an executable real-DB run-list
//
// Both directions are asserted, and they are one assertion because each direction is a distinct
// way to execute nothing:
//   • carried but NOT excluded — the no-DB job collects it too and its gate skip-greens it there,
//     a half-satisfied two-point wiring.
//   • excluded but NOT carried — removed from the only job that would have collected it and put in
//     no run-list: it executes NOWHERE, whatever its source says. The gate-shape classifier could
//     not see this case at all, because a gate-free file passed it.
//   • NEITHER — the file genuinely lives in the no-DB job. Only here does the source matter, and
//     only as POSITIVE proof (below): the burden is on the file to show it needs no database, and
//     everything that cannot be shown is unknown and reds.
//
// BOTH SIDES ARE DERIVED. The file set is the recursive disk scan above; "carried" is the SAME
// `realDbWholeFileArgUnion()` the other corpora use; "excluded" is parsed out of the same
// `test.exclude` the shared `isQuotedInTestExclude` reads (and proven to agree with it, above).
// Nothing is hand-listed — a hand-listed domain is the defect class this guard exists to delete.
// ---------------------------------------------------------------------------------------------

/**
 * POSITIVE proof that a file executes assertions WITHOUT a database. The inversion of the deleted
 * `classifyDbGate`: that function enumerated what a gate looks like and called everything else
 * gate-free; this one enumerates what DB-INDEPENDENCE looks like and calls everything else
 * unknown. The complement of a positive predicate cannot be widened by inventing a new gate
 * spelling — a new spelling simply fails to be proof, which is already the failing verdict.
 *
 * Every "must NOT contain" requirement is failed by a hit in EITHER the raw source OR the masked
 * one (comments and string bodies blanked). Masking exists to stop a comment answering a structural
 * question, but a masker is a heuristic — a regexp literal containing a quote character, say, could
 * blank real code and hand back a file that looks clean. Taking the UNION of both readings makes
 * that failure mode over-strict (a comment saying "skip" blocks the proof) instead of over-
 * permissive, which is the only direction this predicate may err in.
 *
 *   1. no reference to `process` or `import.meta.env` at all — the only way a suite in this tree
 *      learns whether a database exists is by reading the environment;
 *   2. no `skip` token anywhere, in any casing — `describe.skip`, `it.skipIf`, `ctx.skip()`,
 *      `const { skip: off } = describe`, and any future spelling all contain it;
 *   3. no `runIf`, and no member access on a suite API (`describe.`/`it.`/`test.`) — a gate is a
 *      member of one of them or a rebinding of one of them;
 *   4. every TOP-LEVEL call is literally `describe(`, `it(` or `test(` — this is what rejects
 *      `describeDb('x', …)` and `const d = pickDescribe(hasDb); d('x', …)` regardless of where the
 *      binding came from;
 *   5. `describe`/`it`/`test` are not locally rebound;
 *   6. no import or require of anything but `'vitest'` — a gate can be hoisted into a helper
 *      module, and a specifier this function cannot follow is not proof of anything;
 *   7. at least one `it(`/`test(` — a file that declares no test cannot prove it executes
 *      assertions, and an empty/unreadable source is not evidence of absence.
 *
 * WHAT THIS COSTS, stated rather than left to be discovered: (6) and (4) together mean a file that
 * imports the application cannot be proven DB-free, so in practice the proof succeeds only for a
 * self-contained suite. At this head zero files rely on it — all 87 corpus members are excluded and
 * carried — so the reachable behaviour is unchanged; a future genuinely-DB-free attendance
 * integration suite either keeps itself self-contained or is wired like every other one, which is
 * an owner decision, not a silent widening here.
 *
 * An EXECUTED signal would be stronger still — collect the file with no database and observe
 * whether it executes or skips. It is not available to this guard: the step that runs it sits ahead
 * of the workspace install in its job, so vitest does not exist when this file runs. That placement
 * is deliberate (a wiring break reds before the install), and it is why the corpus derivation above
 * leans on two independent static derivations rather than on one clever one. The ordering is not
 * asserted in this comment: the leg named "this guard's step runs BEFORE the workspace install"
 * asserts it off the parsed workflow, so the justification cannot go stale without a red.
 *
 * @param {unknown} source
 * @returns {{ proven: boolean, missing: string[] }}
 */
export function proveNoDatabaseDependence(source) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { proven: false, missing: ['source is empty or unreadable — an empty read is not evidence of absence'] }
  }
  const masked = maskSourceNoise(source)
  const missing = []
  // "must NOT contain" — union of both readings, so a masking mistake can only over-restrict.
  const anywhere = (re) => re.test(source) || re.test(masked)
  if (anywhere(/\bprocess\b/) || anywhere(/\bimport\s*\.\s*meta\s*\.\s*env\b/)) {
    missing.push('reads the environment (process / import.meta.env)')
  }
  if (anywhere(/skip/i)) missing.push('mentions skip')
  if (anywhere(/\brunIf\b/)) missing.push('mentions runIf')
  if (anywhere(/(?:^|[^.\w$])(?:describe|it|test)\s*\./)) {
    missing.push('takes a member of a suite API (describe./it./test.)')
  }
  if (anywhere(/\b(?:const|let|var|function|class)\s+(?:describe|it|test)\b/)) {
    missing.push('rebinds describe/it/test locally')
  }
  const topLevelCallees = new Set()
  for (const text of [source, masked]) {
    for (const m of text.matchAll(/^([A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/gm)) {
      topLevelCallees.add(m[1])
    }
  }
  for (const callee of topLevelCallees) {
    if (!['describe', 'it', 'test'].includes(callee)) {
      missing.push(`calls "${callee}(" at top level — only literal describe/it/test may declare suites`)
    }
  }
  // Module specifiers are read off the RAW source: a commented-out import blocking the proof is
  // fail-closed, whereas stripping comments first risks a `//` inside a string hiding a real one.
  for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
    if (m[1] !== 'vitest') missing.push(`imports ${JSON.stringify(m[1])} — only 'vitest' can be followed`)
  }
  // "must contain" — masked only, so a mention in a comment or a test title cannot supply it.
  if (!/(?:^|[^.\w$])(?:it|test)\s*\(/.test(masked)) {
    missing.push('declares no it()/test() case, so it cannot be shown to execute assertions')
  }
  return { proven: missing.length === 0, missing }
}

/**
 * The part-3 verdict for one attendance suite: `null` when it runs exactly once with a database,
 * otherwise the reason it does not. `carried` and `excluded` are INJECTED so the temp-dir mutation
 * below can drive all four cells — on the live tree every member is carried+excluded, which would
 * otherwise leave both new directions green against nothing.
 */
function attendanceSuiteResidueReason({ arg, source, carried, excluded }) {
  const isCarried = carried.has(arg)
  const isExcluded = excluded.has(arg)
  if (isCarried && isExcluded) return null
  if (isCarried && !isExcluded) {
    return 'carried by a real-DB run-list but NOT an exact quoted entry of vitest.config.ts '
      + 'test.exclude — the no-DB job collects it as well and its DB gate skip-greens it there, '
      + 'a half-satisfied two-point wiring'
  }
  if (isExcluded && !isCarried) {
    return 'excluded from the no-DB job but carried by NO executable real-DB run-list — it is '
      + 'removed from the only job that would have collected it and listed in none that would '
      + 'execute it, so it executes NOWHERE'
  }
  const proof = proveNoDatabaseDependence(source)
  if (proof.proven) return null
  return 'neither excluded from the no-DB job nor carried by a real-DB run-list, and its '
    + `independence from a database is NOT proven (${proof.missing.join('; ')}) — so the no-DB job `
    + 'collects it and a gate in any spelling skip-greens it, and no CI job ever executes it. Wire '
    + "it into a real-DB step's run-list AND the no-DB test.exclude, or make it self-contained. "
    + 'Adding an exclusion to this guard instead is a contract change requiring an owner ruling '
    + '(issue 4828)'
}

/**
 * The whole part-3 sweep as a pure-ish function of (directory, carried set, excluded set) so the
 * permanent mutation test below can drive it over a SYNTHETIC temp-dir corpus — no probe fixture
 * is shipped in the real tree.
 */
function collectAttendanceResidue({ dir, carried, excluded, includeRegexes }) {
  const residue = []
  for (const entry of attendanceCorpus({ dir, includeRegexes })) {
    const reason = attendanceSuiteResidueReason({
      arg: entry.arg,
      source: entry.source,
      carried,
      excluded,
    })
    if (reason != null) residue.push({ file: entry.rel, reason })
  }
  return residue
}

// Predicate unit tests over INLINE SOURCE STRINGS — no I/O, no temp dir, no fixture. This layer
// cannot go red for a path reason, so it isolates "the predicate is wrong" from "the scan read
// the wrong place" (the temp-dir test below covers the second).
test('issue 4828 DB-independence proof: every executed gate shape fails it, including the ones the deleted classifier called gate-free', () => {
  const proven = (src) => proveNoDatabaseDependence(src).proven
  // The one shape that IS proof: self-contained, imports only vitest, bare suite calls.
  assert.ok(proven("import { describe, it } from 'vitest'\ndescribe('pure', () => { it('x', () => {}) })\n"))
  assert.ok(proven("it('x', () => { if (1 + 1 !== 2) throw new Error('math') })\n"), 'globals:true form')
  // The four real binding names in this tree.
  for (const name of ['describeDb', 'describeWithDb', 'describeIfDatabase', 'attendanceIntegrationDescribe']) {
    assert.ok(!proven(`const ${name} = dbUrl ? describe : describe.skip\n${name}('x', () => {})\n`))
  }
  // A binding name never seen before — the anti-allowlist property, now on the safe side.
  assert.ok(!proven('const zzNeverSeenBefore = u ? describe : describe.skip\n'))
  assert.ok(!proven('const d = !u ? describe.skip : describe\n'))
  // THE TEN SHAPES THE DELETED CLASSIFIER RETURNED "ungated" FOR. Each is a real DB gate; each
  // must now fail the proof. These are the executed findings, encoded so they cannot come back.
  assert.ok(!proven("const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL\nconst d = dbUrl ? describe : describe.skip\n"), 'this lane\'s own env var')
  assert.ok(!proven("const u = process.env.TEST_DATABASE_URL\nif (!u) throw new Error('x')\n"))
  assert.ok(!proven("const u = process.env.POSTGRES_URL\n"))
  assert.ok(!proven("import { describeDb } from './helpers/db-describe'\ndescribeDb('x', () => { it('y', () => {}) })\n"), 'gate hoisted to a helper module')
  assert.ok(!proven("const d = pickDescribe(hasDb)\nd('x', () => {})\n"), 'the shape the deleted unit test PINNED as ungated')
  assert.ok(!proven("const itDb = process.env.PGURL ? it : it.skip\nitDb('x', () => {})\n"), 'it-level gate')
  assert.ok(!proven("const testDb = process.env.PGURL ? test : test.skip\ntestDb('x', () => {})\n"), 'test-level gate')
  assert.ok(!proven("describe('x', () => { beforeAll((ctx) => { if (!u) ctx.skip() }) })\n"), 'vitest silent whole-suite skip')
  assert.ok(!proven("const { skip: off } = describe\nconst d = hasDb ? describe : off\nd('x', () => {})\n"), 'fully aliased ternary')
  assert.ok(!proven("import { dbUrl } from './fixtures/db'\ndescribe('x', () => { if (!dbUrl) return\n  it('y', () => {}) })\n"), 'early return, gate value imported')
  // And the shapes it already caught must stay caught.
  assert.ok(!proven("describe.skipIf(!process.env.PG)('x', () => {})\n"))
  assert.ok(!proven("describe.runIf(hasDb)('x', () => {})\n"))
  assert.ok(!proven("if (!process.env.DATABASE_URL) return\n"))
  assert.ok(!proven("describe.skip('temporarily off', () => {})\n"))
  // An empty read is not evidence of absence.
  assert.ok(!proven(''))
  assert.ok(!proven('   \n\t '))
  assert.ok(!proven(undefined))
  // A file that declares no test case cannot prove it executes assertions.
  assert.ok(!proven("import { describe } from 'vitest'\nexport const helper = 1\n"))
  // Masker-evasion: a regexp literal containing a quote character makes the naive mask blank the
  // rest of the file. The union of raw+masked readings is what keeps this failing.
  assert.ok(
    !proven("import { describe, it } from 'vitest'\nconst q = /['\"]/\nconst u = process.env.DATABASE_URL\ndescribe('x', () => { it('y', () => {}) })\n"),
    'a regexp literal must not be able to hide an env read from the mask',
  )
  // A commented-out import is fail-closed too (specifiers are read off the raw source).
  assert.ok(!proven("// import { describeDb } from './helpers/db'\nit('x', () => {})\n"))
  // The reasons are reported, not just the verdict (the live failure message quotes them), and they
  // name the specific requirement that failed rather than "unclassifiable".
  assert.deepEqual(
    proveNoDatabaseDependence("const d = process.env.X ? describe : describe.skip\n").missing,
    [
      'reads the environment (process / import.meta.env)',
      'mentions skip',
      'takes a member of a suite API (describe./it./test.)',
      'declares no it()/test() case, so it cannot be shown to execute assertions',
    ],
  )
})

// PERMANENT ENCODING of the owner-named mutation, extended to all four cells of the partition.
// Driven over a temp-dir corpus, so no probe fixture ever lives in
// packages/core-backend/tests/integration — and, critically, so the two directions that are
// LIVE-VACUOUS on the real tree (every real member is carried AND excluded) still have a test that
// can go red when they break.
test('issue 4828 residue sweep: all four cells of (excluded × carried) behave, over a temp-dir corpus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w4c2-part3-'))
  try {
    const GATED = "const describeDb = process.env.DATABASE_URL ? describe : describe.skip\ndescribeDb('x', () => { it('y', () => {}) })\n"
    const PROVEN_FREE = "import { describe, it } from 'vitest'\ndescribe('pure', () => { it('x', () => {}) })\n"
    const HELPER_GATED = "import { describeDb } from './helpers/db'\ndescribeDb('x', () => { it('y', () => {}) })\n"
    const files = {
      // excluded ∧ carried — the only clean cell.
      'attendance-probe-wired.db.test.ts': GATED,
      // excluded ∧ ¬carried — executes NOWHERE. Invisible to the deleted gate classifier.
      'attendance-probe-excluded-uncarried.db.test.ts': GATED,
      // ¬excluded ∧ carried — the no-DB job collects it too and skip-greens it.
      'attendance-probe-carried-unexcluded.test.ts': GATED,
      // ¬excluded ∧ ¬carried, unproven — the original OBS-1 shape.
      'attendance-probe-loose-gated.test.ts': GATED,
      // ¬excluded ∧ ¬carried, unproven via an imported gate — no env read in the file at all,
      // which the deleted classifier called gate-free.
      'attendance-probe-loose-helper.test.ts': HELPER_GATED,
      // ¬excluded ∧ ¬carried, PROVEN DB-free — the one legitimate resident of the no-DB job.
      'attendance-probe-loose-free.test.ts': PROVEN_FREE,
      // A `.spec.ts` suite and a SUBDIRECTORY suite: both were collected and skip-greened by the
      // no-DB job while sitting in NO corpus at all (executed, 2026-08-08). Both must be swept.
      'attendance-probe-spec.spec.ts': GATED,
      'sub/attendance-probe-nested.test.ts': GATED,
      // A non-suite companion (the real tree has one) must NOT be swept.
      'attendance-probe-bootstrap.env.ts': 'const scratch = process.env.ATTENDANCE_TEST_DATABASE_URL\n',
      // Another family must NOT be swept by the attendance corpus.
      'multitable-probe-gated.test.ts': GATED,
    }
    for (const [name, body] of Object.entries(files)) {
      const full = join(dir, name)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body)
    }
    const carried = new Set([
      'tests/integration/attendance-probe-wired.db.test.ts',
      'tests/integration/attendance-probe-carried-unexcluded.test.ts',
    ])
    const excluded = new Set([
      'tests/integration/attendance-probe-wired.db.test.ts',
      'tests/integration/attendance-probe-excluded-uncarried.db.test.ts',
    ])
    const residue = collectAttendanceResidue({
      dir,
      carried,
      excluded,
      includeRegexes: suiteIncludeRegexes(),
    })
    assert.deepEqual(
      residue.map((r) => r.file).sort(),
      [
        'attendance-probe-carried-unexcluded.test.ts',
        'attendance-probe-excluded-uncarried.db.test.ts',
        'attendance-probe-loose-gated.test.ts',
        'attendance-probe-loose-helper.test.ts',
        'attendance-probe-spec.spec.ts',
        'sub/attendance-probe-nested.test.ts',
      ],
      'exactly the six broken cells must be residue: the wired one, the PROVEN DB-free one, the '
        + 'non-suite companion and the other family must not',
    )
    const reasonOf = (name) => residue.find((r) => r.file === name).reason
    assert.match(reasonOf('attendance-probe-excluded-uncarried.db.test.ts'), /executes NOWHERE/)
    assert.match(reasonOf('attendance-probe-carried-unexcluded.test.ts'), /half-satisfied two-point wiring/)
    assert.match(reasonOf('attendance-probe-loose-gated.test.ts'), /is NOT proven/)
    assert.match(reasonOf('attendance-probe-loose-helper.test.ts'), /imports "\.\/helpers\/db"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Corpus part 2 (wiring → disk): every attendance-prefixed whole-file arg the real-DB run-lists
// carry must exist. Deduplicated.
//
// This block no longer emits its own "…is excluded from the no-DB job" leg. That is not a dropped
// assertion: a carried attendance arg that EXISTS on disk is by construction a member of the
// corpus above, and the corpus leg asserts the exclude in BOTH directions for it (carried ⟺
// excluded), which is strictly stronger than the one-directional check that used to live here. A
// carried arg that does NOT exist on disk is caught by the existence leg below, which is the only
// case the corpus scan cannot see.
{
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

  // The integration config decides what a real-DB step actually collects out of the files it is
  // handed. It carries `include`/`exclude` (and could carry `testNamePattern`), and nothing pinned
  // any of them: narrowing `include`, widening `exclude` or adding a name filter silences every
  // carried suite at once, with the run-lists, the no-DB excludes and the argument allowlist above
  // all still green — the same bypass as `-t`, one file over. Pinned here, attendance-scoped: the
  // assertion is over the attendance args only, not over the approval/multitable corpora.
  test(`${INTEGRATION_CONFIG} still collects every carried attendance suite, and applies no name filter`, () => {
    const cfg = readCoreBackendFile(INTEGRATION_CONFIG)
    const include = directTestArrayEntries(cfg, 'include')
    assert.ok(
      Array.isArray(include) && include.length > 0,
      `${INTEGRATION_CONFIG} must declare a direct test.include — without it this pin cannot be `
        + `evaluated and the real-DB steps' collection is unstated`,
    )
    const includeRe = include.map(globToRegExp)
    const excludeRe = (directTestArrayEntries(cfg, 'exclude') ?? []).map(globToRegExp)
    for (const arg of carried) {
      assert.ok(
        includeRe.some((re) => re.test(arg)),
        `${arg} is carried by a real-DB run-list but matches no test.include glob of `
          + `${INTEGRATION_CONFIG} (${JSON.stringify(include)}) — the step would hand vitest a path `
          + `it does not collect, and vitest exits 0 on it`,
      )
      assert.ok(
        !excludeRe.some((re) => re.test(arg)),
        `${arg} is carried by a real-DB run-list but matches a test.exclude glob of `
          + `${INTEGRATION_CONFIG} — it is removed from the very run that is supposed to execute it`,
      )
    }
    assert.ok(
      !declaresDirectTestKey(cfg, 'testNamePattern'),
      `${INTEGRATION_CONFIG} must not declare test.testNamePattern: a name filter set in the config `
        + `silences every carried suite exactly as \`-t\` does on the command line, and the argument `
        + `allowlist above cannot see it`,
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
  }
}
