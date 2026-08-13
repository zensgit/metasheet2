import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, posix } from 'node:path'
import { tmpdir } from 'node:os'
import {
  REAL_DB_STEP_IDS,
  extractStepById,
  extractTestExcludeArrayBody,
  isQuotedInTestExclude,
  quotedExcludeEntries,
  requireExecutableRealDbStep,
  stepHasEnvDatabaseUrl,
  stepInvokesVitestIntegrationConfig,
  vitestInvocations,
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
//     excluded-but-not-carried executes NOWHERE; and NEITHER is refused outright (below). 87
//     members at this head. The disk walk itself is TOTAL: an entry that is neither a directory nor
//     a regular file — a symlink, a FIFO — is REFUSED, not skipped (see `walkFiles`).
//     "Is a suite" is the UNION of two independent derivations, neither of them a list of names:
//     the file's path matches an `include` glob compiled from a vitest config's own literal, OR
//     its masked source calls a vitest suite API. No suffix and no directory depth is written down
//     here. The narrower predicate this replaced (`/^attendance-.*\.db\.test\.ts$/` over a FLAT
//     readdirSync) was provably narrower than the collector it reconciled against: a `.spec.ts`
//     probe and a subdirectory probe were both collected and skip-greened by the no-DB job while
//     sitting in NO corpus and this guard stayed fully green (both executed, 2026-08-08).
//     "RUNS EXACTLY ONCE" IS NOW LITERALLY ASSERTED, not a way of describing the biconditional: the
//     membership question above is answered off a `Set`, which collapses duplicates, so a second
//     vitest process repeating one file satisfied it while racing itself against one database. The
//     count is asserted `=== 1` separately — see the P2 section. And "EXECUTABLE" is no longer just
//     the four-pin step contract: a command whose execution cannot be PROVEN unconditional carries
//     nothing at all here, because the shared parser discards the operator that separated it (a
//     `true || pnpm … vitest …` rewrite left every file "wired" by a command bash never runs) — see
//     the P1-2 section. Both boundaries — "which argument belongs to this family" (P1-1) and "which
//     command actually executes" (P1-2) — now have exactly ONE definition each in this file.
//   corpus part 2 (wiring → disk): every attendance-prefixed whole-file arg the real-DB run-lists
//     actually carry must exist on disk (vitest exits 0 on an unmatched path argument, so a
//     rename/delete with stale wiring stays green otherwise). Its exclude leg is now part 1's, in
//     both directions. This part also pins vitest.integration.config.ts itself: every carried
//     attendance arg must match that config's `include` and none of its `exclude`, and it must
//     declare no `testNamePattern` — otherwise one config edit silences every carried suite with
//     the run-lists, the excludes and the argument allowlist all still green.
//   corpus part 3 (issue 4828; owner-ruled 2026-08-08, then re-ruled 2026-08-09): the residual
//     cell — a suite that is NEITHER excluded NOR carried — is now simply REFUSED. Two earlier
//     implementations tried to let such a suite argue from its own SOURCE that it needs no
//     database, and both were executed and bypassed: a gate CLASSIFIER waved through ten real gate
//     shapes (including a self-skip on this lane's own ATTENDANCE_TEST_DATABASE_URL and a gate
//     hoisted into a helper module), and its inversion, a DB-independence PROVER, returned
//     `{ proven: true }` for `require(moduleVariable)` and `await import(moduleVariable)` because
//     its specifier scan could only capture string literals. Owner ruling: do not harden the
//     enumeration, remove the thing that needs enumerating. The self-proof exit and its predicate
//     are DELETED; the boundary is now a pure WIRING property with no source analysis in it, so
//     there is no spelling left to recognise and nothing left to fool. Measured at the head this
//     landed on: all 87 members are already carried AND excluded, so no reachable verdict changed.
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
// step that runs this file (plugin-tests.yml, "Attendance W4C-2 CI wiring contract", :453) executes
// BEFORE `Setup pnpm` (:501) and `pnpm install --frozen-lockfile` (:530) — vitest does not exist in
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
/** Every vitest argument this guard reasons about is package-relative to packages/core-backend. */
const INTEGRATION_ARG_PREFIX = 'tests/integration/'
const ATTENDANCE_BASENAME_PREFIX = 'attendance-'

/**
 * THE definition of "this vitest argument names an attendance integration suite" (owner P1-1).
 *
 * There was more than one, and they disagreed. The corpus recognised a member by BASENAME over a
 * RECURSIVE walk (`sub/attendance-x.db.test.ts` is a member), while the run-list "carried"
 * computation and the argument-safety domain each tested the ARGUMENT with
 * `startsWith('tests/integration/attendance-')` — which answers NO for that same file, because the
 * next path segment is `sub`. Owner's probe: a NESTED suite, fully two-point wired, with `-t`
 * applied to the invocation that carried it — this guard stayed 191/191 PASS while that suite
 * executed zero assertions. The nested file was a corpus member (so it got its wiring legs) and was
 * simultaneously invisible to the check that would have rejected the `-t`.
 *
 * So the fix is not a wider regex in the one place the probe happened to enter. It is ONE predicate
 * with three call sites — `attendanceCorpus` (disk → arg), `realDbWholeFileArgUnion`'s consumers
 * (arg → wiring) and `attendanceCarryingInvocations` (arg → command safety). If two callers can
 * disagree about what an attendance argument is, the disagreement IS the defect, and it will keep
 * reappearing wherever the third copy was not updated.
 *
 * DEPTH-INDEPENDENT BY CONSTRUCTION: the family is decided by the BASENAME, exactly as the corpus
 * walk decides it, and the location is decided by the `tests/integration/` root, exactly as the
 * shared `wholeFileVitestArgs` regex decides it. No directory depth is written down.
 *
 * @param {unknown} arg a vitest whole-file argument, package-relative to packages/core-backend
 */
function isAttendanceIntegrationArg(arg) {
  if (typeof arg !== 'string') return false
  if (!arg.startsWith(INTEGRATION_ARG_PREFIX)) return false
  const rel = arg.slice(INTEGRATION_ARG_PREFIX.length)
  if (rel.length === 0 || rel.startsWith('/')) return false
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  return base.startsWith(ATTENDANCE_BASENAME_PREFIX)
}

// ---------------------------------------------------------------------------------------------
// SELECTION — what a vitest invocation actually RUNS, as opposed to what it spells.
//
// `isAttendanceIntegrationArg` above answers a DOMAIN question ("is this argument a member of the
// attendance family, in the canonical spelling this repo writes"). It was also being used as the
// COUNTING KEY of the "executed exactly once" assertion, and as the gate for whether an invocation
// was even examined for narrowing flags. That is a category error, and it was executed: a domain
// predicate is allowed to say NO to a spelling; a counting key that says NO to a spelling vitest
// says YES to simply loses the execution.
//
// Nine spellings were reproduced against vitest 1.6.1, every one of them selecting a real suite
// while the guard stayed green — `tests/integration//attendance-x.db.test.ts`,
// `tests/integration/./…`, `…/sub/../…`, `ATTENDANCE-x.db.test.ts`, the bare directory
// `tests/integration`, the bare basename, the 11-character fragment `attendance-`, and the first of
// those with `-t zzz` attached (the owner's nested-suite probe in a different spelling, invisible
// because an empty filtered list was `continue`d rather than examined).
//
// ENUMERATING THOSE SPELLINGS IS THE MOVE THIS FILE KEEPS DELETING. The fix is to stop asking "is
// this token one of the spellings I recognise" and instead ask vitest's own question: WHICH SUITES
// DOES THIS INVOCATION SELECT? `vitestFilterSelects` below MODELS vitest 1.6.1's `filterFiles()` —
// normalise the filter, lowercase BOTH sides, and match by SUBSTRING — so a directory argument, a
// bare family fragment and every punctuation variant all resolve to the set of corpus suites they
// really select, and each of those suites is counted under its OWN canonical path.
//
// THE THESIS, STATED EXACTLY, because the sentence that used to close this paragraph overstated it.
// It said: "a spelling nobody has thought of is handled because it is never named: it is run through
// THE SAME MATCHER vitest runs it through." That is FALSE, and it was executed as false — the model
// was run differentially against the REAL vitest 1.6.1 binary over one corpus, and 30 filters
// produced NINE divergences (every row frozen below, with the mechanism). It is not the same
// matcher; two pipeline stages are deliberately not modelled, and the docblock names them.
//
// What IS true, and is the whole reason the counting key was rewritten: THE KEY IS SELECTION, NOT
// SPELLING, and every point where this model's selection diverges from vitest's is REFUSED BY NAME
// rather than silently absorbed. A spelling nobody has thought of therefore has exactly two fates:
// the model agrees with vitest and the suite is counted under its own canonical path, or the model
// cannot resolve it — it selects ZERO — and the invocation carrying it REDS, in-domain through the
// positional-safety leg and out-of-domain through the complement leg. What enumerating spellings
// kept producing was a third fate, "counted wrong and green", and that is the one now closed.
// ---------------------------------------------------------------------------------------------

/**
 * Does this guard's model select the corpus suite `suiteArg` when handed the CLI filter `filter`?
 *
 * MODELLED ON, NOT EQUAL TO, vitest 1.6.1 `filterFiles()` (dist/vendor/cli-api.OdDWuB7Y.js), which
 * is transcribed here verbatim:
 *
 *     const testFile = relative(dir, t).toLocaleLowerCase()
 *     return filters.some((f) => {
 *       if (isAbsolute(f) && t.startsWith(f)) return true
 *       const relativePath = f.endsWith('/') ? join(relative(dir, f), '/') : relative(dir, f)
 *       return testFile.includes(f.toLocaleLowerCase())
 *         || testFile.includes(relativePath.toLocaleLowerCase())
 *     })
 *
 * WHAT IS MODELLED. Three properties the previous counting key had none of: the filter is
 * NORMALISED (so `//`, `./` and `sub/..` collapse), both sides are lowercased (so case is
 * irrelevant), and the match is `includes` — a SUBSTRING, which is why a bare directory or a bare
 * `attendance-` fragment selects whole families rather than nothing. `dir` is vitest's root, which
 * is the package directory these args are already relative to (the steps run via
 * `pnpm --filter @metasheet/core-backend exec`, so cwd == root); `test.root`/`test.dir` and the
 * top-level `root` are PINNED absent below so that equivalence cannot silently break.
 *
 * WHAT IS NOT MODELLED — two stages, both stated because the model was measured against the binary
 * rather than read:
 *
 *   (1) `pathe.normalize`. vitest's CLI does not hand raw argv to `filterFiles()`; it runs every
 *       filter through `normalize` from `pathe` first (`dist/vendor/cac.cdAtVkJZ.js`:
 *       `startVitest(mode, cliFilters.map(normalize), …)`), which FOLDS `\` to `/`. This model uses
 *       `posix.normalize`, which does not. So `tests\integration\x.db.test.ts` selects one file in
 *       vitest and NOTHING here.
 *   (2) `relative(dir, f)`. This model substitutes `posix.normalize(f)`. They are different
 *       functions: `relative` RESOLVES against the root, so a filter that escapes and comes back
 *       (`../<pkg>/tests/…`) lands inside the root and matches, while `posix.normalize` keeps the
 *       leading `../` and matches nothing; and a filter that resolves TO the root yields `''`, so
 *       vitest's trailing-slash branch computes `join('', '/')` === `'/'`, a substring of EVERY
 *       collected path — which is why `./` selects the ENTIRE corpus in vitest and nothing here.
 *
 * Modelling (2) faithfully would require the runner's real checkout prefix (`relative` resolves
 * against an absolute root, and whether `../foo/…` returns inside it depends on the directory names
 * above the package). That prefix is exactly the unknowable this file already refuses to guess for
 * absolute filters, so it is not guessed here either.
 *
 * WHAT IS THEREFORE CLAIMED, AND WHAT IS NOT. Claimed: over the 30 filters executed against the real
 * binary, every divergence is one where this model selects ZERO (under) or EVERYTHING (over) — never
 * a non-empty PROPER subset — and both of those are refused by name by the two legs that consume it,
 * so neither can silently under-count. NOT claimed: that no filter exists for which this model
 * selects a non-empty proper subset of vitest's answer. That shape would under-count silently, and
 * the frozen differential below is evidence that none of the 30 executed spellings does it, not a
 * proof that none can. If one is ever found, the fix is another refusal, not another spelling.
 *
 * ABSOLUTE FILTERS ARE NOT MODELLED AT ALL — same missing prefix. Rather than guess, an absolute
 * filter selects EVERYTHING (fail closed: it can only over-count, never hide an execution) and is
 * refused by name in the positional-safety leg below and in the complement leg.
 *
 * @param {string} suiteArg package-relative POSIX path of a corpus suite
 * @param {string} filter one positional CLI argument
 * @returns {boolean}
 */
function vitestFilterSelects(suiteArg, filter) {
  if (filter.startsWith('/')) return true // unmodellable → over-select, and refused by name below
  const haystack = suiteArg.toLocaleLowerCase()
  const normalised = filter.endsWith('/')
    ? `${posix.normalize(filter).replace(/\/+$/, '')}/`
    : posix.normalize(filter)
  return haystack.includes(filter.toLocaleLowerCase()) || haystack.includes(normalised.toLocaleLowerCase())
}

/**
 * ONE traversal of a vitest invocation's argument list, classifying every token — read by BOTH the
 * argument allowlist and the positional extraction the selection model needs.
 *
 * A second copy would let the two disagree, and the disagreement has an obvious shape: the VALUE of
 * `--config` (`vitest.integration.config.ts`) does not start with `-`, so a naive "not a flag" test
 * calls it a file filter that selects nothing. `run` is likewise a substring of several real suite
 * names. Both are consumed here, once.
 *
 * @param {{ args: string[] }} inv
 * @returns {{ token: string, kind: 'subcommand'|'permittedFlag'|'flagValue'|'unknownFlag'|'positional' }[]}
 */
function classifyInvocationArgs(inv) {
  const consumesValue = (flag) => flag === '--config' || flag === '-c' || flag === '--reporter'
  const out = []
  for (let i = 0; i < inv.args.length; i++) {
    const arg = inv.args[i]
    if (arg === 'run') {
      out.push({ token: arg, kind: 'subcommand' })
      continue
    }
    if (consumesValue(arg)) {
      out.push({ token: arg, kind: 'permittedFlag' })
      const value = inv.args[i + 1]
      // A separate-form flag consumes its value ONLY when the next token does not itself start with
      // `-`, so `--reporter -t zzz` cannot swallow the `-t`.
      if (typeof value === 'string' && !value.startsWith('-')) {
        out.push({ token: value, kind: 'flagValue' })
        i += 1
      }
      continue
    }
    if (/^(?:--config|--reporter)=/.test(arg)) {
      out.push({ token: arg, kind: 'permittedFlag' })
      continue
    }
    if (arg.startsWith('-')) {
      out.push({ token: arg, kind: 'unknownFlag' })
      continue
    }
    out.push({ token: arg, kind: 'positional' })
  }
  return out
}

/**
 * The FILE FILTERS of one invocation — the tokens vitest passes to `filterFiles()`.
 *
 * @param {{ args: string[] }} inv
 * @returns {string[]}
 */
function positionalFiltersOfInvocation(inv) {
  return classifyInvocationArgs(inv).filter((t) => t.kind === 'positional').map((t) => t.token)
}

/**
 * The corpus suites one invocation ACTUALLY selects, under vitest's own matching.
 *
 * NO POSITIONAL AT ALL selects EVERYTHING the config collects — that is vitest's behaviour, and it
 * is also the shape a "run the whole integration directory a second time" line would take, so it
 * must count as selecting the whole corpus rather than as selecting nothing.
 *
 * @param {{ args: string[] }} inv
 * @param {string[]} corpusArgs the suites in question, in their canonical package-relative spelling
 * @returns {string[]} a subset of `corpusArgs`, in corpus order
 */
function selectedCorpusSuites(inv, corpusArgs) {
  const filters = positionalFiltersOfInvocation(inv)
  if (filters.length === 0) return [...corpusArgs]
  return corpusArgs.filter((arg) => filters.some((f) => vitestFilterSelects(arg, f)))
}

// ---------------------------------------------------------------------------------------------
// P1-2 (owner): a shell short-circuit hid the whole invocation.
//
// The shared parser splits a run script on `;` / `&&` / `||` / `|` / `&` and keeps the COMMANDS,
// discarding which operator separated them. Control-flow information is therefore lost: owner's
// probe rewrote a real command as `true || pnpm … vitest …` and this guard stayed 190/190 PASS
// while nothing ran — every carried suite still counted as "wired" by a command bash would never
// execute.
//
// WHICH OF THE TWO OFFERED APPROACHES THIS TAKES, AND WHY. The owner offered "preserve control-flow
// information" OR "accept only commands provably executed unconditionally". This takes the SECOND,
// and implements it as a WHOLE-SCRIPT property rather than as per-command operator tracking,
// because per-command tracking cannot see an ENCLOSING construct:
//
//     if false
//     then
//       pnpm … vitest … tests/integration/attendance-x.db.test.ts
//     fi
//
// Every one of those lines, judged on its own, is an unconditional simple command with no operator
// in it — and the vitest command never runs. An operator-tracking fix that looked only at what
// separates commands ON a line would pass this, which is the same bypass one level out. The
// whole-script property proves the absence of every operator AND every compound construct at once,
// and under it per-command tracking is vacuous: a script containing no operator and no reserved
// word is a flat sequence of standalone simple commands, each executed unconditionally in order.
//
// The property is a POSITIVE alphabet, not a list of forbidden spellings (the enumeration failure
// mode this file has been deleting for six amendments). A logical line is accepted only when every
// one of its whitespace-separated words is spelled entirely from characters whose shell meaning is
// FIXED — no operator, no quote, no expansion, no substitution, no redirection, no comment, no
// continuation, no grouping — and no word is a bash reserved word. Anything else is UNPROVABLE.
// A new shell construct nobody has thought of is unrecognised and therefore refused; a denylist
// would fail open on it.
//
// AN UNPROVABLE STEP'S INVOCATIONS ARE TREATED AS NOT EXECUTING, never as executing: its whole-file
// args stop counting as wiring, so its suites become "excluded but carried by NO executable run-list
// — executes NOWHERE" and red per member, and `unprovableRunLines` reds by name so the diagnosis is
// one line rather than 87. It returns a LIST rather than throwing on purpose: the union is computed
// at module scope, and a throw there reports `tests 0 / pass 0 / fail 0` — the count shape this tree
// treats as a false signal.
//
// WHAT IT COSTS, stated rather than left to be discovered: a real-DB step's run script may no longer
// contain a quoted word, a `$`-expansion, a pipeline or a `&&` — an `echo "starting"` added to any
// of the three steps reds this guard until it is rewritten unquoted or the owner widens the
// alphabet. ONE exception is carved out because all three steps already use it and it is a complete,
// anchored description rather than a family: the `: "${VAR:?message}"` precondition line, the `:`
// builtin applied to one double-quoted parameter expansion whose message itself contains no `$`,
// quote, backslash or backtick. It cannot open a construct and cannot conditionally skip anything;
// if VAR is unset the step ABORTS, which is red.
//
// SCOPE (owner ruling, restated): the root fix belongs in `ci-realdb-step-contract.mjs`, whose
// `vitestInvocations` is what discards the operators — but that module is shared by 17 guards and is
// tracked separately as repo-level issue 4829. What lands here is the attendance-scoped gate only;
// the shared module is untouched. Consequence, stated: the shared `stepInvokesVitestIntegrationConfig`
// (pin (c), used by `requireAttendanceRealDbStepExecutable` above) is flatness-BLIND, so
// `true || pnpm … vitest …` still satisfies it. That is why the named leg below exists rather than
// the executability pin being relied on.
// ---------------------------------------------------------------------------------------------

/**
 * Characters whose shell meaning is FIXED in every position: letters, digits, and the punctuation
 * that bash treats as ordinary text. Deliberately absent: `|&;()<>` (operators/redirection/grouping),
 * `'"` (quoting), `` $` `` (expansion/substitution), `\` (escape/continuation), `#` (comment),
 * `*?[]{}~!` (globbing/brace/history/negation).
 */
const INERT_WORD_RE = /^[A-Za-z0-9_@/.:=+,-]+$/

/**
 * The bash reserved words that are SPELLABLE in the inert alphabet above — i.e. the complete residue
 * of bash's own reserved-word list after the alphabet has already excluded `!`, `[[`, `]]`, `{` and
 * `}`. Taken from the language grammar, so it is a CLOSED set rather than a collection of traps
 * somebody thought of; it is iterated by a test below, so every entry is proven refused rather than
 * three of them being spot-checked.
 */
const INERT_ALPHABET_RESERVED_WORDS = Object.freeze([
  'case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function',
  'if', 'in', 'select', 'then', 'time', 'until', 'while',
])

/**
 * The ONE non-inert line shape accepted, anchored end to end: `: "${VAR:?message}"`. The message
 * body is restricted to the inert alphabet plus spaces, so it cannot itself carry an expansion, a
 * quote, a backslash or a backtick.
 */
const PARAM_ASSERT_LINE_RE = /^:[ \t]+"\$\{[A-Za-z_][A-Za-z0-9_]*:\?[A-Za-z0-9 _./-]*\}"$/

/**
 * The commands a real-DB step's run script may execute — an ALLOWLIST, for the same reason the
 * argument check above is one.
 *
 * The inert alphabet and the reserved-word table together prove there is no OPERATOR and no COMPOUND
 * COMMAND in the script. They do NOT prove that an earlier line lets the next one run, because
 * several shell BUILTINS are spelled in that same alphabet and end or hijack the script:
 *
 *     exit 0                      the step goes green having run nothing after this line
 *     exec pnpm --version         replaces the shell; every later line is unreachable
 *     eval exit                   the same, one indirection out
 *     source setup.sh  /  . x.sh  runs arbitrary text that can do either of the above
 *
 * `exit 0` on the line before the vitest command is the same defect as `true || …` with a different
 * spelling, and enumerating those builtins would be the move this file keeps deleting. So the
 * COMMAND NAME is allowlisted instead: `:` (the no-op builtin) and the package runners plus the two
 * binaries these steps actually use. None of them is a builtin that can end the script or replace
 * the shell — an external command cannot make a LATER command not run; it can only fail, which reds
 * the step. Anything else — a builtin nobody has thought of included — is unrecognised and REFUSED.
 *
 * A leading `NAME=value` assignment prefix is skipped before this is applied (the shared
 * `vitestArgsOfCommand` skips them too), and a line that is ONLY assignments is accepted: an
 * assignment cannot stop a later command.
 */
const ALLOWED_COMMAND_WORDS = Object.freeze([
  ':', 'pnpm', 'pnpx', 'npm', 'npx', 'yarn', 'bun', 'bunx', 'corepack', 'vitest', 'node',
])
const ASSIGNMENT_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * A step's `run:` script as LOGICAL lines — the same reconstruction the shared `vitestInvocations`
 * performs (whole-line `#` comments dropped when no continuation is pending; trailing `\` joins the
 * next raw line). Mirrored rather than imported because the shared module exposes only the finished
 * invocation list; the mirror is not asserted in prose — a leg below drives the shared parser over
 * these lines ONE AT A TIME and requires the result to equal the whole-step parse, so a drift
 * between the two reconstructions reds.
 *
 * @param {Record<string, unknown>} step
 * @returns {string[]}
 */
function runLogicalLines(step) {
  const run = step != null && typeof step.run === 'string' ? step.run : ''
  const logical = []
  let pending = null
  for (const line of run.split('\n')) {
    if (pending === null && /^\s*#/.test(line)) continue
    const continued = /\\\s*$/.test(line)
    const text = continued ? line.replace(/\\\s*$/, ' ') : line
    pending = pending === null ? text : pending + text
    if (!continued) {
      logical.push(pending)
      pending = null
    }
  }
  if (pending !== null) logical.push(pending)
  return logical
}

/**
 * Every logical line of a step's run script whose execution this guard CANNOT prove is
 * unconditional, with the reason. Empty ⟺ the whole script is a flat sequence of standalone simple
 * commands, which is the only shape under which "the step carries this file" means "the step runs
 * this file".
 *
 * @param {Record<string, unknown>} step
 * @returns {{ line: string, reason: string }[]}
 */
function unprovableRunLines(step) {
  const out = []
  for (const raw of runLogicalLines(step)) {
    const line = raw.trim()
    if (line === '') continue
    if (PARAM_ASSERT_LINE_RE.test(line)) continue
    const words = line.split(/\s+/)
    const nonInert = words.filter((word) => !INERT_WORD_RE.test(word))
    if (nonInert.length > 0) {
      out.push({
        line,
        reason: `contains ${JSON.stringify(nonInert)}, which is not spelled from the inert alphabet `
          + `${INERT_WORD_RE.source} — it may be a control operator (\`||\`, \`&&\`, \`;\`, \`|\`, `
          + `\`&\`), a quote, an expansion/substitution, a redirection, a comment or a grouping, and `
          + `this guard cannot prove the command on this line executes`,
      })
      continue
    }
    const reserved = words.filter((word) => INERT_ALPHABET_RESERVED_WORDS.includes(word))
    if (reserved.length > 0) {
      out.push({
        line,
        reason: `uses the bash reserved word(s) ${JSON.stringify(reserved)} — a compound command `
          + `(\`if\`/\`while\`/\`for\`/\`case\`/…) can span lines, so the commands it encloses are `
          + `not provably executed even though each of them looks unconditional on its own line`,
      })
      continue
    }
    const command = words.find((word) => !ASSIGNMENT_WORD_RE.test(word))
    if (command !== undefined && !ALLOWED_COMMAND_WORDS.includes(command)) {
      out.push({
        line,
        reason: `runs "${command}", which is not one of the allowed commands `
          + `${JSON.stringify(ALLOWED_COMMAND_WORDS)}. Proving there is no operator and no compound `
          + `command is not enough: shell builtins spelled in the same inert alphabet end or hijack `
          + `the script, and every later line then never executes — \`exit 0\`, \`exec …\`, `
          + `\`eval …\`, \`source …\`, \`. …\`. This is an allowlist so a builtin nobody has thought `
          + `of is refused rather than waved through; adding a genuinely needed command is one owner `
          + `decision`,
      })
    }
  }
  return out
}

/**
 * The vitest invocations of a step that are PROVABLY EXECUTED. An unprovable script contributes
 * NONE — fail closed, never "assume it runs".
 *
 * @param {Record<string, unknown>} step
 */
function executableVitestInvocations(step) {
  if (unprovableRunLines(step).length > 0) return []
  return vitestInvocations(step)
}

/**
 * Whole-file vitest args of a step's PROVABLY EXECUTED invocations that run under the integration
 * config — the local, control-flow-aware counterpart of the shared `wholeFileVitestArgs`. Order and
 * DUPLICATES are preserved: the multiplicity leg below needs to see a file carried twice.
 *
 * @param {Record<string, unknown>} step
 * @returns {string[]}
 */
function executableWholeFileArgs(step) {
  return executableIntegrationInvocations(step).flatMap((inv) => inv.wholeFileArgs)
}

/**
 * The provably-executed invocations of a step that run under the integration config — the
 * invocation objects themselves, because the multiplicity counter needs to ask each one WHICH
 * SUITES IT SELECTS, a question its whole-file arg list cannot answer (a bare directory or a bare
 * `attendance-` fragment selects suites and appears in no whole-file arg list at all).
 *
 * @param {Record<string, unknown>} step
 */
function executableIntegrationInvocations(step) {
  return executableVitestInvocations(step).filter((inv) => inv.usesIntegrationConfig)
}
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
  return classifyInvocationArgs(inv)
    .filter((t) => {
      if (t.kind === 'subcommand' || t.kind === 'permittedFlag' || t.kind === 'flagValue') return false
      if (t.kind === 'unknownFlag') return true
      // A POSITIONAL is permitted only when it is one of THIS invocation's canonical whole-file
      // args. Deliberately NOT "any positional that selects at least one suite": `attendance-` and
      // the bare directory `tests/integration` both select real suites, and both must red here as
      // well as in the multiplicity counter — two independent legs, not one.
      return !fileArgs.has(t.token)
    })
    .map((t) => t.token)
}

/**
 * The DERIVED domain: every (stepId, invocation) pair across the three real-DB steps whose
 * invocation actually carries at least one `tests/integration/attendance-*` whole-file arg AND
 * runs under `vitest.integration.config.ts` — i.e. exactly the invocations whose file args
 * `wholeFileVitestArgs()` reports as "wired". Membership is computed from the ARGS; no step is
 * included because of its name.
 */
// This domain deliberately keeps the SHARED `vitestInvocations` rather than the flatness-gated
// `executableVitestInvocations`: a narrowing flag on a command whose execution cannot be proven is
// still worth reporting, and reporting it is strictly more conservative than dropping it. The two
// mechanisms are orthogonal and each keeps its own red — a `$NAME_FILTER` on a real-DB step reds
// BOTH the argument allowlist (unrecognised token) and the control-flow leg (non-inert word).
function attendanceCarryingInvocations({ steps = realDbSteps(), corpusArgs = attendanceCorpusArgs() } = {}) {
  const out = []
  for (const [stepId, step] of steps) {
    for (const inv of vitestInvocations(step)) {
      if (!inv.usesIntegrationConfig) continue
      // MEMBERSHIP IS BY SELECTION, not by spelling. This filter was
      // `inv.wholeFileArgs.filter(isAttendanceIntegrationArg)` with a `continue` on the empty
      // result, so an invocation that selected attendance suites through ANY spelling the domain
      // predicate declined — `tests/integration//attendance-x.db.test.ts`, `ATTENDANCE-x…`, the
      // bare directory, the bare `attendance-` fragment — was never examined at all, and the `-t`
      // sitting next to it went unread. Asking vitest's own question instead means there is no
      // spelling left to decline.
      const attendanceFiles = selectedCorpusSuites(inv, corpusArgs)
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
/**
 * The hole-2 detector over a synthetic run script: the SAME derivation the live assertion uses
 * (same shared parser, same shared `isAttendanceIntegrationArg`, same `unpermittedArgsOfInvocation`)
 * — an inlined re-implementation would test a copy of the predicate rather than the shipped one.
 * Module-level rather than inline in one test so the P1-1 leg drives the identical path.
 *
 * @param {string} runScript
 * @returns {string[]}
 */
function detectUnpermittedAttendanceArgs(runScript, corpusArgs = SYNTHETIC_CORPUS) {
  // THE SHIPPED ROUTINE, over a synthetic step — not a re-implementation of it. This used to be its
  // own loop with its own copy of the domain test, and the copies could be fixed independently: a
  // reverted `continue` in the LIVE routine left every control here green, which is precisely the
  // "green test against nothing" shape (proved by mutation — reverting the live domain test reddened
  // nothing until these were collapsed into one).
  return attendanceCarryingInvocations({ steps: [['synthetic', { run: runScript }]], corpusArgs })
    .flatMap(({ inv }) => unpermittedArgsOfInvocation(inv))
}

/**
 * The corpus the synthetic controls are driven over: two attendance suites (one TOP-LEVEL, one
 * NESTED — the owner's P1-1 probe shape) and one suite of another family, so "selects an attendance
 * suite" and "selects some suite" are distinguishable.
 */
const SYNTHETIC_CORPUS = Object.freeze([
  'tests/integration/attendance-x.db.test.ts',
  'tests/integration/sub/attendance-y.db.test.ts',
])

test('issue 4828 hole 2 detector positive control: the allowlist accepts the real argument vocabulary and rejects every executed bypass family', () => {
  const detect = detectUnpermittedAttendanceArgs
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
// P1-1 (owner) — PERMANENT ENCODING of the owner's nested-suite probe.
//
// The probe: a NESTED suite (`tests/integration/sub/attendance-*.db.test.ts`), fully two-point
// wired, carried by an invocation that also carried `-t`. The guard stayed 191/191 PASS and that
// suite executed zero assertions, because the corpus claimed it by BASENAME while the argument
// safety check tested the ARGUMENT with a `tests/integration/attendance-` prefix that a nested path
// cannot match. The three derivations are driven over ONE nested argument below and must agree.
// ---------------------------------------------------------------------------------------------
test('P1-1: isAttendanceIntegrationArg is basename-scoped and depth-independent, and the prefix test it replaced was not', () => {
  assert.ok(isAttendanceIntegrationArg('tests/integration/attendance-x.db.test.ts'))
  assert.ok(isAttendanceIntegrationArg('tests/integration/sub/attendance-x.db.test.ts'))
  assert.ok(isAttendanceIntegrationArg('tests/integration/a/b/attendance-x.spec.ts'))
  // Other families, other roots, and the degenerate spellings.
  assert.ok(!isAttendanceIntegrationArg('tests/integration/multitable-x.db.test.ts'))
  assert.ok(!isAttendanceIntegrationArg('tests/integration/sub/multitable-x.db.test.ts'))
  assert.ok(!isAttendanceIntegrationArg('tests/integration/sub/attendance/x.db.test.ts'))
  assert.ok(!isAttendanceIntegrationArg('tests/unit/attendance-x.test.ts'))
  assert.ok(!isAttendanceIntegrationArg('tests/integration-extra/attendance-x.test.ts'))
  assert.ok(!isAttendanceIntegrationArg('tests/integration/'))
  assert.ok(!isAttendanceIntegrationArg(undefined))
  // The DEFECT, asserted rather than described: the predicate this replaced answers NO for the
  // nested suite the corpus already claims — that disagreement is what the owner's probe walked
  // through.
  assert.ok(
    !'tests/integration/sub/attendance-x.db.test.ts'.startsWith(
      `${INTEGRATION_ARG_PREFIX}${ATTENDANCE_BASENAME_PREFIX}`,
    ),
    'the old prefix test must be shown to disagree with the corpus, or this leg proves nothing',
  )
})

test('P1-1: the corpus, the carried-arg computation and the argument-safety domain all recognise a NESTED attendance suite', () => {
  const NESTED = 'tests/integration/sub/attendance-probe-nested.db.test.ts'
  const GATED = "const describeDb = process.env.DATABASE_URL ? describe : describe.skip\ndescribeDb('x', () => { it('y', () => {}) })\n"
  const dir = mkdtempSync(join(tmpdir(), 'w4c2-p11-'))
  try {
    // (1) corpus derivation (disk → arg)
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub/attendance-probe-nested.db.test.ts'), GATED)
    const derived = attendanceCorpus({ dir }).map((e) => e.arg)
    assert.deepEqual(derived, [NESTED], 'the recursive corpus walk claims the nested suite')
    // (2) the run-list "carried" computation (arg → wiring)
    const step = { run: `pnpm exec vitest --config vitest.integration.config.ts run ${NESTED}` }
    assert.deepEqual(
      executableWholeFileArgs(step).filter(isAttendanceIntegrationArg),
      [NESTED],
      'the carried-arg computation must see the same file the corpus claimed',
    )
    // (3) the argument safety check (arg → command safety). THIS is the leg the owner's probe
    // walked through: with the prefix test in place the `-t` was invisible here. The domain is now
    // entered by SELECTION over the corpus derived in (1), so the three steps are chained rather
    // than each re-deciding what an attendance argument is.
    assert.deepEqual(
      detectUnpermittedAttendanceArgs(`${step.run} -t zzz`, derived),
      ['-t', 'zzz'],
      'a name filter on an invocation carrying ONLY nested attendance suites must be caught',
    )
    // Negative control on the same three legs: another family at the same depth is claimed by none
    // of them, so the agreement above is not "everything matches".
    rmSync(join(dir, 'sub/attendance-probe-nested.db.test.ts'))
    writeFileSync(join(dir, 'sub/multitable-probe-nested.db.test.ts'), GATED)
    assert.deepEqual(attendanceCorpus({ dir }), [])
    const other = { run: 'pnpm exec vitest --config vitest.integration.config.ts run tests/integration/sub/multitable-probe-nested.db.test.ts' }
    assert.deepEqual(executableWholeFileArgs(other).filter(isAttendanceIntegrationArg), [])
    assert.deepEqual(detectUnpermittedAttendanceArgs(`${other.run} -t zzz`, derived), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// P1-2 (owner) — the control-flow legs. See the long rationale above `INERT_WORD_RE`.
// ---------------------------------------------------------------------------------------------

/** The three real-DB steps, as (id, parsed step) pairs. Located by exact id, never by title. */
function realDbSteps() {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  return [
    [STEP_ID, requireAttendanceRealDbStepExecutable()],
    [REAL_DB_STEP_IDS.approval, requireExecutableRealDbStep(wf, REAL_DB_STEP_IDS.approval)],
    [REAL_DB_STEP_IDS.multitable, requireExecutableRealDbStep(wf, REAL_DB_STEP_IDS.multitable)],
  ]
}

test('P1-2: every real-DB step run script is a provably unconditional flat command sequence', () => {
  const offenders = realDbSteps().flatMap(([stepId, step]) => unprovableRunLines(step).map((o) => ({ stepId, ...o })))
  assert.deepEqual(
    offenders,
    [],
    'a real-DB step run script may contain only standalone simple commands spelled from the inert '
      + 'alphabet (plus the anchored `: "${VAR:?msg}"` precondition line). The shared parser splits '
      + 'on `;`/`&&`/`||`/`|`/`&` and DISCARDS which operator separated the commands, so a rewrite '
      + 'to `true || pnpm … vitest …` left every carried suite reported as "wired" by a command bash '
      + 'never executes (owner probe: 190/190 PASS while nothing ran). An invocation whose execution '
      + 'this guard cannot prove is treated as NOT executing, so the suites it carries stop counting '
      + 'as wired and red per member as well — this leg exists so the diagnosis is one named line '
      + 'instead of 87. Rewrite the script as flat unconditional commands, or take an owner ruling '
      + 'to widen the alphabet (the shared-helper root fix is repo-level issue 4829)',
  )
})

test('P1-2: the local logical-line reconstruction agrees with the shared parser on every real-DB step', () => {
  for (const [stepId, step] of realDbSteps()) {
    const whole = vitestInvocations(step)
    const perLine = runLogicalLines(step).flatMap((line) => vitestInvocations({ run: line }))
    assert.deepEqual(
      perLine,
      whole,
      `${stepId}: the logical lines this guard classifies must be the same logical lines the shared `
        + `parser extracts invocations from — otherwise the flatness verdict is about a different `
        + `script than the wiring verdict`,
    )
    assert.ok(whole.length > 0, `${stepId}: no invocation parsed at all — the drift check is vacuous`)
  }
})

test('P1-2 control-flow classifier positive control: the real vocabulary is accepted and every hiding shape is refused', () => {
  const unprovable = (run) => unprovableRunLines({ run }).map((o) => o.line)
  const CMD = 'pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-x.db.test.ts --reporter=dot'
  // The REAL shape of all three steps at this head — accepted, or this leg would red the live
  // workflow and be neutered on arrival.
  assert.deepEqual(unprovable(`: "\${DATABASE_URL:?DATABASE_URL is required for attendance integration}"\n${CMD}\n`), [])
  assert.deepEqual(unprovable(`: "\${DATABASE_URL:?DATABASE_URL is required for multitable real-DB integration}"\n${CMD}\n`), [])
  // Continuation-joined exactly as the workflow writes it.
  assert.deepEqual(
    unprovable('pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \\\n  tests/integration/attendance-x.db.test.ts \\\n  --reporter=dot\n'),
    [],
  )
  // Blank lines and whole-line comments are inert.
  assert.deepEqual(unprovable(`\n# a comment\n${CMD}\n`), [])
  // (a) THE OWNER'S PROBE — the short-circuit. One line, refused.
  assert.equal(unprovable(`true || ${CMD}`).length, 1)
  // (b) the rest of the operator family: they all lose the same information.
  for (const script of [
    `false && ${CMD}`,
    `${CMD} || true`,
    `true; ${CMD}`,
    `echo x | ${CMD}`,
    `${CMD} &`,
    `( ${CMD} )`,
    `{ ${CMD} ; }`,
    `$(${CMD})`,
    '`' + CMD + '`',
    `${CMD} > /dev/null`,
    `${CMD} 2>&1`,
    `RUN_IT=0\nif false\nthen\n${CMD}\nfi`,
    `for f in a b\ndo\n${CMD}\ndone`,
    `while false\ndo\n${CMD}\ndone`,
    `case x in\ny)\n${CMD}\nesac`,
    `CMD="${CMD}"\n$CMD`,
    `run_them() {\n${CMD}\n}\nrun_them`,
  ]) {
    assert.ok(unprovable(script).length > 0, `must be refused: ${JSON.stringify(script)}`)
  }
  // (c) the SCRIPT-ENDING builtins. Every one of these is spelled entirely in the inert alphabet and
  // carries no operator and no reserved word, so the alphabet alone would wave them through — and
  // each makes the vitest command on the NEXT line unreachable exactly as `true ||` does.
  for (const script of [
    `exit 0\n${CMD}`,
    `exec pnpm --version\n${CMD}`,
    `eval exit\n${CMD}`,
    `source scripts/setup.sh\n${CMD}`,
    `. scripts/setup.sh\n${CMD}`,
    `return 0\n${CMD}`,
    `${CMD}\nexit 0`,
  ]) {
    assert.ok(unprovable(script).length > 0, `script-ending builtin must be refused: ${JSON.stringify(script)}`)
  }
  // A leading assignment prefix does not hide the command it prefixes…
  assert.equal(unprovable(`FOO=1 exit 0\n${CMD}`).length, 1)
  // …and a line that is ONLY assignments is accepted (it cannot stop a later command).
  assert.deepEqual(unprovable(`FOO=1\n${CMD}`), [])
  // The anchored `:` exception cannot be widened into a general quoting escape hatch.
  assert.equal(unprovable(': "${DATABASE_URL:?msg}" || true').length, 1)
  assert.equal(unprovable(': "${DATABASE_URL:-$(curl evil)}"').length, 1)
  assert.equal(unprovable(': "${DATABASE_URL:?msg}" ; true').length, 1)
  // THE LOAD-BEARING PART: the shared parser still reports the short-circuited invocation as a real
  // vitest command carrying the file — and this guard refuses to count it as executed. Without this
  // pair the leg above would be an assertion about a classifier nobody consults.
  const shortCircuited = { run: `true || ${CMD}` }
  assert.equal(vitestInvocations(shortCircuited).length, 1, 'the shared parser sees the invocation')
  assert.deepEqual(
    vitestInvocations(shortCircuited)[0].wholeFileArgs,
    ['tests/integration/attendance-x.db.test.ts'],
    'and reports the file as a whole-file arg — this is the bypass',
  )
  assert.deepEqual(executableVitestInvocations(shortCircuited), [], 'but it is NOT provably executed')
  assert.deepEqual(executableWholeFileArgs(shortCircuited), [], 'so it carries NOTHING')
  // Positive control on the same pair: unmutated, the file IS carried.
  assert.deepEqual(executableWholeFileArgs({ run: CMD }), ['tests/integration/attendance-x.db.test.ts'])
})

test('P1-2: every bash reserved word spellable in the inert alphabet is refused, iterated from the table', () => {
  const CMD = 'pnpm exec vitest --config vitest.integration.config.ts run tests/integration/attendance-x.db.test.ts'
  assert.ok(INERT_ALPHABET_RESERVED_WORDS.length >= 17, 'the reserved-word table lost entries')
  for (const word of INERT_ALPHABET_RESERVED_WORDS) {
    assert.equal(
      unprovableRunLines({ run: `${word} ${CMD}` }).length,
      1,
      `bash reserved word "${word}" must be refused as a command word — it can open a compound `
        + `command whose enclosed commands are not provably executed`,
    )
    assert.equal(
      unprovableRunLines({ run: `${CMD}\n${word}` }).length,
      1,
      `bash reserved word "${word}" must be refused wherever it sits, not only as a first line`,
    )
  }
  // Negative control: the refusal is keyed on the reserved-word table, not on "the line has more
  // than one word" — an allowed command with arguments of the same shape is accepted.
  assert.deepEqual(unprovableRunLines({ run: 'node --test scripts/ops/x.test.mjs' }), [])
})

test('P1-2: every allowed command word is accepted, and the allowlist is what refuses everything else', () => {
  const ARGS = 'exec vitest --config vitest.integration.config.ts run tests/integration/attendance-x.db.test.ts'
  for (const word of ALLOWED_COMMAND_WORDS) {
    assert.deepEqual(
      unprovableRunLines({ run: word === ':' ? ':' : `${word} ${ARGS}` }),
      [],
      `"${word}" is on the command allowlist and must be accepted`,
    )
  }
  // The real vocabulary the three steps use is a SUBSET of the allowlist — asserted, so a future
  // edit that empties the allowlist cannot leave this leg passing over nothing.
  for (const word of [':', 'pnpm']) assert.ok(ALLOWED_COMMAND_WORDS.includes(word))
  // Everything else is refused, including the script-ending builtins the alphabet cannot see.
  for (const word of ['exit', 'exec', 'eval', 'source', '.', 'env', 'bash', 'sh', 'trap', 'shopt', 'alias']) {
    assert.equal(
      unprovableRunLines({ run: `${word} ${ARGS}` }).length,
      1,
      `"${word}" is not on the command allowlist and must be refused`,
    )
  }
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

// P1-2 FROZEN ROWS: the config resolver, driven over synthetic steps. `governingIntegrationConfig`
// on the LIVE workflow is asserted separately below; this leg proves the resolver can actually SEE
// the shapes it claims to refuse, including the exact executed bypass
// (`--config tests/vitest.integration.config.ts`, a real second file with the same basename).
test('P1-2 config-resolution positive control: same-basename decoys, escapes and ambiguity all fail CLOSED', () => {
  const step = (run) => [['probe', { run }]]
  const CMD = 'pnpm exec vitest run tests/integration/attendance-x.db.test.ts'
  // The canonical shape resolves, in all three spellings the argument allowlist permits.
  assert.equal(governingIntegrationConfig(step(`${CMD} --config vitest.integration.config.ts`)), INTEGRATION_CONFIG)
  assert.equal(governingIntegrationConfig(step(`${CMD} --config=vitest.integration.config.ts`)), INTEGRATION_CONFIG)
  assert.equal(governingIntegrationConfig(step(`${CMD} -c vitest.integration.config.ts`)), INTEGRATION_CONFIG)
  // Punctuation that normalises to the canonical path is the SAME file, and resolves to it — the
  // resolver is not a string comparison wearing a different hat.
  assert.equal(governingIntegrationConfig(step(`${CMD} --config ./vitest.integration.config.ts`)), INTEGRATION_CONFIG)
  // THE EXECUTED BYPASS: a different file with the SAME BASENAME, which the shared
  // `argsUseIntegrationConfig` cannot tell apart from the canonical one. The resolver keeps them
  // apart — it resolves the decoy to ITSELF — which is what makes the pin below able to fire and
  // what makes every config leg read the decoy rather than a bystander.
  for (const decoy of [
    'tests/vitest.integration.config.ts',
    'decoy/vitest.integration.config.js',
    './tests/../tests/vitest.integration.config.ts',
  ]) {
    const resolvedDecoy = resolvePackageRelativeConfig(decoy)
    assert.notEqual(resolvedDecoy, null, `${decoy} must resolve to a package-relative path, not be discarded`)
    assert.notEqual(
      resolvedDecoy,
      INTEGRATION_CONFIG,
      `${decoy} must NOT resolve to the canonical config — the shared basename regex says true for `
        + `it, and conflating the two is exactly the executed bypass`,
    )
  }
  // …and end to end: a resolvable config that is NOT the canonical one is returned as itself, so
  // the canonical pin reds instead of the guard silently reading the file it wished had been used.
  assert.equal(governingIntegrationConfig(step(`${CMD} --config vitest.config.ts`)), NO_DB_CONFIG)
  assert.notEqual(governingIntegrationConfig(step(`${CMD} --config vitest.config.ts`)), INTEGRATION_CONFIG)
  // A same-basename decoy that does not exist on disk is refused outright rather than falling back.
  assert.throws(
    () => governingIntegrationConfig(step(`${CMD} --config tests/vitest.integration.config.ts`)),
    /not a regular file/,
  )
  // Unresolvable / ambiguous shapes throw rather than defaulting to the canonical file.
  assert.throws(() => governingIntegrationConfig(step(`${CMD} --config /abs/vitest.integration.config.ts`)), /failing CLOSED/)
  assert.throws(() => governingIntegrationConfig(step(`${CMD} --config ../outside/vitest.integration.config.ts`)), /failing CLOSED/)
  // …INCLUDING the `..` path that names the canonical file and, on the real runner, resolves to it.
  // Refused deliberately (see the header): whether the escape returns depends on directory names
  // above the package, which is the same unknowable checkout prefix that makes absolute values
  // unmodellable. This row exists so the refusal is a decision on record rather than a surprise.
  assert.throws(
    () => governingIntegrationConfig(step(`${CMD} --config ../core-backend/vitest.integration.config.ts`)),
    /failing CLOSED/,
    'the escapes-and-returns spelling must stay refused; accepting it would require guessing the '
      + 'runner checkout layout, and a wrong guess admits a DIFFERENT file under the canonical name',
  )
  assert.throws(() => governingIntegrationConfig(step(CMD)), /failing CLOSED/)
  assert.throws(
    () => governingIntegrationConfig(step(`${CMD} --config vitest.integration.config.ts --config other.config.ts`)),
    /failing CLOSED/,
  )
  assert.throws(
    () => governingIntegrationConfig([
      ['a', { run: `${CMD} --config vitest.integration.config.ts` }],
      ['b', { run: `${CMD} --config vitest.config.ts` }],
    ]),
    /different configs/,
  )
  // A config that resolves but does not EXIST is refused — the pin cannot read a file that is not
  // there, and silently falling back to the canonical one is exactly the substitution P1-2 is about.
  assert.throws(() => governingIntegrationConfig(step(`${CMD} --config vitest.nonexistent.config.ts`)), /not a regular file/)
})

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
// INTEGRATION_ARG_PREFIX now lives with `isAttendanceIntegrationArg` at the top of this file — one
// definition of where an integration argument lives, next to the one definition of what makes it
// an attendance one.
/** The config the NO-DB job runs under (`pnpm test` in packages/core-backend). */
const NO_DB_CONFIG = 'vitest.config.ts'
/** The config every real-DB step runs under. */
const INTEGRATION_CONFIG = 'vitest.integration.config.ts'

const readCoreBackendFile = (rel) => readFileSync(join(CORE_BACKEND_DIR, rel), 'utf8')

// ---------------------------------------------------------------------------------------------
// P1-2 — THE CONFIG THE GUARD INSPECTS MUST BE THE CONFIG THAT GOVERNS EXECUTION.
//
// Every leg that "pins vitest.integration.config.ts itself" — the include/exclude reconciliation,
// the `testNamePattern` refusal, the suffix vocabulary the corpus leans on — read a HARDCODED
// `packages/core-backend/vitest.integration.config.ts`, while the invocation was admitted to the
// domain by the shared `argsUseIntegrationConfig`, which matches the BASENAME:
//
//     vitest.integration.config.ts          -> true
//     tests/vitest.integration.config.ts    -> true       <-- a DIFFERENT FILE
//     ../decoy/vitest.integration.config.js -> true       <-- a different file, outside the package
//
// So the file the guard inspected and the file vitest loaded could simply be two different files.
// Executed: pointing the attendance step at `tests/vitest.integration.config.ts` carrying
// `testNamePattern: 'no-such-test-zz'` left the guard at 199/199, while behaviourally a config-level
// `testNamePattern` yields `Test Files 3 skipped (3)` and exit 0 — all 87 carried suites executing
// zero assertions with required CI green.
//
// The fix is not to widen the basename regex. It is to RESOLVE the `--config` argument the
// invocation actually passes and to read THAT file. Since the resolved path is then what every pin
// inspects, a decoy is inspected too — its `testNamePattern` reds the very leg it was meant to slip
// past — and separately the resolved path is pinned to the canonical one so the move itself is a
// named, one-line red rather than a silent relocation.
//
// FAIL CLOSED, stated with its cost: a value this guard cannot resolve to a package-relative file
// (absolute, escaping `..`, absent, or two `--config` flags on one command) is REFUSED, and so is a
// real-DB vitest invocation running under any config other than the governing one. Adding such a
// line to a real-DB step reds this guard until an owner widens the rule — the same polarity as the
// inert alphabet, and for the same reason: a config this guard has not read is a config whose
// collection it cannot vouch for.
//
// ONE CASE IS WORTH NAMING because it looks like a false positive and is not (gate NIT @ d72cf7dcdf):
// `--config ../core-backend/vitest.integration.config.ts` NAMES THE CANONICAL FILE — on the real
// runner it resolves to exactly the file this guard reads — and it is REFUSED ANYWAY. That is a
// decision, not an oversight, and it is kept: whether a `..` path comes back to the same file
// depends on the names of the directories ABOVE the package, which are the runner's checkout layout
// and are not knowable from here — the same missing prefix that makes absolute `--config` values
// and absolute file FILTERS unmodellable. Resolving it "equal enough" would mean guessing that
// prefix, and a guess that is wrong admits a DIFFERENT file under the canonical name, which is
// precisely the same-basename decoy this section exists to close. The cost is one owner decision if
// a real-DB step ever needs that spelling; the fix is to write the config path package-relative.
// Asserted as a named row below, so the refusal cannot quietly become an acceptance.
// ---------------------------------------------------------------------------------------------

/**
 * Every `--config` / `-c` / `--config=` VALUE of one invocation, in order. A flag with no usable
 * value contributes `null` so "present but unresolvable" is distinguishable from "absent".
 *
 * @param {{ args: string[] }} inv
 * @returns {(string | null)[]}
 */
function configValuesOfInvocation(inv) {
  const out = []
  for (let i = 0; i < inv.args.length; i++) {
    const arg = inv.args[i]
    if (arg === '--config' || arg === '-c') {
      const value = inv.args[i + 1]
      if (typeof value === 'string' && !value.startsWith('-')) {
        out.push(value)
        i += 1
      } else {
        out.push(null)
      }
      continue
    }
    if (arg.startsWith('--config=')) out.push(arg.slice('--config='.length))
  }
  return out
}

/**
 * A `--config` value resolved to a package-relative POSIX path, or `null` when it names a file this
 * guard cannot read as one (absolute — the runner's checkout prefix is unknowable here; escaping
 * the package root; empty).
 *
 * @param {string | null} value
 * @returns {string | null}
 */
function resolvePackageRelativeConfig(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  if (value.startsWith('/')) return null
  const rel = posix.normalize(value)
  if (rel === '' || rel === '..' || rel.startsWith('../')) return null
  return rel
}

/**
 * THE config file the real-DB steps actually load — derived from the invocations, never assumed.
 *
 * Throws (fail closed) unless every provably-executed vitest invocation across the three real-DB
 * steps names exactly one resolvable config, they all name the SAME one, and that file exists as a
 * regular file in the package. The return value is what every config pin below reads.
 *
 * @param {[string, Record<string, unknown>][]} steps (id, parsed step) pairs; the live three by default
 * @returns {string} package-relative POSIX path
 */
function governingIntegrationConfig(steps = realDbSteps()) {
  const problems = []
  const resolved = new Set()
  for (const [stepId, step] of steps) {
    for (const inv of executableVitestInvocations(step)) {
      const values = configValuesOfInvocation(inv)
      if (values.length !== 1) {
        problems.push(
          `step "${stepId}" has a vitest invocation with ${values.length} \`--config\` arguments `
            + `(${JSON.stringify(values)}); exactly one is required, because with none vitest picks a `
            + `config this guard never read and with two it uses the last`,
        )
        continue
      }
      const rel = resolvePackageRelativeConfig(values[0])
      if (rel == null) {
        problems.push(
          `step "${stepId}" runs vitest with \`--config ${JSON.stringify(values[0])}\`, which does not `
            + `resolve to a file inside packages/core-backend (absolute paths and \`..\` escapes are `
            + `refused: this guard cannot read what it cannot locate)`,
        )
        continue
      }
      resolved.add(rel)
    }
  }
  if (problems.length > 0) {
    throw new Error(`governing vitest config: failing CLOSED —\n  ${problems.join('\n  ')}`)
  }
  if (resolved.size !== 1) {
    throw new Error(
      `governing vitest config: failing CLOSED — the real-DB steps run vitest under `
        + `${resolved.size} different configs (${JSON.stringify([...resolved])}). Every pin below `
        + `inspects ONE config file; with more than one, some carried suite is governed by a file `
        + `this guard did not read`,
    )
  }
  const [rel] = [...resolved]
  const abs = join(CORE_BACKEND_DIR, rel)
  if (!existsSync(abs) || !lstatSync(abs).isFile()) {
    throw new Error(
      `governing vitest config: failing CLOSED — the real-DB steps pass \`--config ${rel}\`, but `
        + `packages/core-backend/${rel} is not a regular file on disk`,
    )
  }
  return rel
}

/**
 * Source with comments AND string/template bodies blanked, positions preserved. It is used for the
 * two STRUCTURAL questions this file still asks — does this source call a vitest suite API
 * (`attendanceCorpus`), and does this config declare a direct `test.<key>` (`directTestArrayEntries`
 * / `declaresDirectTestKey`) — so a mention inside a comment or a test title can never answer one.
 *
 * It KEEPS EARNING ITS PLACE after the 2026-08-09 deletion of `proveNoDatabaseDependence`: it was
 * never only that predicate's helper. It no longer answers "does this file read the environment",
 * because nothing asks — the part-3 verdict does not read suite source at all any more.
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
 * Source with COMMENTS blanked but STRING BODIES INTACT, positions preserved.
 *
 * The counterpart of `maskSourceNoise`, and the reason both exist: entry extraction needs the
 * quoted text (that IS the entry) but must not see text that is commented out, while structural
 * questions need the opposite. Reading entries off the ORIGINAL source — which is what this file
 * did, on purpose, with the comment "Slice the ORIGINAL source so quoted entries survive the mask."
 * — meant a `/* 'tests/integration/attendance-X.db.test.ts', *​/` line still read as an exclude
 * entry while vitest cheerfully collected the file. Executed: 199/199 green with the suite
 * collected again by the no-DB job.
 *
 * String-aware, so a `//` or `/*` INSIDE a quoted path is not mistaken for a comment.
 */
function stripCommentsPreservingStrings(src) {
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
      out += src[i]
      i += 1
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          out += src[i] + src[i + 1]
          i += 2
          continue
        }
        out += src[i]
        i += 1
      }
      if (i < src.length) {
        out += src[i]
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
 * The `[ … ]` span of a direct `test.<key>` array, as indices into the source, or `null` when the
 * key is not a direct property of `test` (a nested `coverage.exclude`, a commented-out key, or a
 * free-text mention does not count).
 */
function directTestArraySpan(masked, key) {
  const keyRe = new RegExp(`^${key}\\s*:\\s*\\[`)
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
        const open = i + m[0].length - 1
        return { open, close: matchingBracket(masked, open, '[', ']') }
      }
    }
    i += 1
  }
  return null
}

/** Depth-0 element spans of a bracketed body, split on commas that are not inside a nested group. */
function topLevelElementSpans(masked, start, end) {
  const spans = []
  let depth = 0
  let elementStart = start
  for (let i = start; i < end; i++) {
    const ch = masked[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) {
      spans.push([elementStart, i])
      elementStart = i + 1
    }
  }
  spans.push([elementStart, end])
  return spans
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * The literal string entries of an array body — with every element that is NOT a literal string
 * either RESOLVED (a spread of a `const` array literal in the same file) or REFUSED.
 *
 * The old parser returned only the quoted literals it could see and silently ignored everything
 * else, so `exclude: [ …, ...HIDDEN_EXCLUDE ]` hid an entry completely: the suite was removed from
 * the very run meant to execute it while the guard reported the wiring as satisfied (executed:
 * 199/199 green). Reading what you can and ignoring the rest is fail-OPEN; this reads what it can,
 * resolves what it can resolve, and refuses the rest.
 */
function arrayEntriesInSpan(stripped, masked, start, end, seen) {
  const entries = []
  for (const [a, b] of topLevelElementSpans(masked, start, end)) {
    const raw = stripped.slice(a, b).trim()
    const code = masked.slice(a, b).trim()
    if (raw === '') continue // empty element, trailing comma, or an element that was ALL comment
    if (code === '') {
      // No code outside quotes: the element is one quoted literal, and nothing else.
      const m = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/.exec(raw)
      if (!m) {
        throw new Error(
          `vitest config array: failing CLOSED — element ${JSON.stringify(raw)} is quoted but is not `
            + `a single ordinary string literal (a template literal or concatenation cannot be read `
            + `statically, and guessing at its value is how an entry goes missing)`,
        )
      }
      entries.push(m[2].replace(/\\(.)/g, '$1'))
      continue
    }
    if (code.startsWith('...')) {
      const ident = code.slice(3).trim()
      if (!IDENTIFIER_RE.test(ident)) {
        throw new Error(
          `vitest config array: failing CLOSED — cannot resolve the spread ${JSON.stringify(raw)}; `
            + `only a spread of a plain \`const\` array literal in the same file can be read here`,
        )
      }
      entries.push(...resolveConstArrayEntries(stripped, masked, ident, seen))
      continue
    }
    throw new Error(
      `vitest config array: failing CLOSED — element ${JSON.stringify(raw)} is not a string literal `
        + `and not a resolvable spread. An identifier, a call or a computed entry is invisible to a `
        + `static read, and an entry this guard cannot see is an entry it cannot reconcile`,
    )
  }
  return entries
}

/** Entries of `const IDENT = [ … ]` in the same source. Throws when it cannot be resolved. */
function resolveConstArrayEntries(stripped, masked, ident, seen) {
  if (seen.has(ident)) {
    throw new Error(`vitest config array: failing CLOSED — spread of ${ident} is self-referential`)
  }
  const decl = new RegExp(`\\bconst\\s+${ident}\\s*(?::[^=;]*)?=\\s*\\[`).exec(masked)
  if (!decl) {
    throw new Error(
      `vitest config array: failing CLOSED — spread \`...${ident}\` has no \`const ${ident} = [ … ]\` `
        + `array literal in the same file, so its entries cannot be read`,
    )
  }
  const open = decl.index + decl[0].length - 1
  const close = matchingBracket(masked, open, '[', ']')
  return arrayEntriesInSpan(stripped, masked, open + 1, close, new Set([...seen, ident]))
}

/**
 * Entries of the DIRECT `test.<key>: [ … ]` array of a vitest config, or `null` when the key is
 * absent as a direct property of `test`.
 */
function directTestArrayEntries(src, key) {
  const masked = maskSourceNoise(src)
  const span = directTestArraySpan(masked, key)
  if (span == null) return null
  return arrayEntriesInSpan(stripCommentsPreservingStrings(src), masked, span.open + 1, span.close, new Set())
}

/**
 * True when an object declares a direct `<key>` of ANY value shape — SEEING THROUGH SPREADS.
 *
 * `test: { ...NARROW, globals: true, … }` carries `testNamePattern` without spelling it, and the
 * key scan that only looked for the literal spelling returned false: executed, 199/199 green, with
 * every carried suite running zero assertions. So a spread is resolved to its source object and
 * searched too, and a spread that cannot be resolved is REFUSED rather than passed over — the
 * failure direction matters, because "I did not find the key" and "I could not look" were being
 * reported as the same answer.
 *
 * @param {string} src
 * @param {string} key
 * @param {RegExp} objectOpener matches the object whose direct keys are in question
 */
function declaresDirectTestKey(src, key, objectOpener = /\btest\s*:\s*\{/) {
  const masked = maskSourceNoise(src)
  const opener = objectOpener.exec(masked)
  if (!opener) return false
  const openBrace = masked.indexOf('{', opener.index + opener[0].length - 1)
  if (openBrace < 0) return false
  return objectDeclaresKey(masked, openBrace, key, new Set())
}

function objectDeclaresKey(masked, openBrace, key, seen) {
  const keyRe = new RegExp(`^${key}\\s*:`)
  const close = matchingBracket(masked, openBrace, '{', '}')
  for (const [a, b] of topLevelElementSpans(masked, openBrace + 1, close)) {
    const code = masked.slice(a, b).trim()
    if (code === '') continue
    if (keyRe.test(code)) return true
    if (!code.startsWith('...')) continue
    const ident = code.slice(3).trim()
    if (!IDENTIFIER_RE.test(ident)) {
      throw new Error(
        `vitest config object: failing CLOSED — cannot resolve the spread ${JSON.stringify(code)} `
          + `while looking for \`${key}\`; a spread carries keys without spelling them, so an `
          + `unreadable one cannot be reported as "the key is absent"`,
      )
    }
    if (seen.has(ident)) {
      throw new Error(`vitest config object: failing CLOSED — spread of ${ident} is self-referential`)
    }
    const decl = new RegExp(`\\bconst\\s+${ident}\\s*(?::[^=;]*)?=\\s*\\{`).exec(masked)
    if (!decl) {
      throw new Error(
        `vitest config object: failing CLOSED — spread \`...${ident}\` has no `
          + `\`const ${ident} = { … }\` object literal in the same file, so whether it carries `
          + `\`${key}\` cannot be read`,
      )
    }
    const nested = masked.indexOf('{', decl.index + decl[0].length - 1)
    if (objectDeclaresKey(masked, nested, key, new Set([...seen, ident]))) return true
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

/**
 * A human-readable name for a filesystem entry's type, for the REFUSAL MESSAGE ONLY. The decision
 * in `walkFiles` does not consult this list — it is a two-way partition (directory | regular file |
 * refused), so a type nobody named here is still refused, and the octal `mode` is always printed so
 * even an unnamed type is diagnosable.
 */
function describeStatType(st) {
  const named = [
    ['symbolic link', () => st.isSymbolicLink()],
    ['FIFO / named pipe', () => st.isFIFO()],
    ['socket', () => st.isSocket()],
    ['block device', () => st.isBlockDevice()],
    ['character device', () => st.isCharacterDevice()],
  ].filter(([, is]) => is())
  const label = named.length > 0 ? named.map(([n]) => n).join('+') : 'an unnamed non-regular type'
  return `${label} (mode 0o${(st.mode & 0o170000).toString(8)})`
}

/**
 * Package-relative POSIX paths of every REGULAR file under `dir`, RECURSIVELY. Throws on a missing
 * dir, and FAILS CLOSED on anything that is neither a directory nor a regular file.
 *
 * The previous shape was `if (isDirectory()) … else if (isFile()) …` with NO else: a symlink is
 * neither, so it silently vanished — no corpus member was generated for it, the whole two-point
 * wiring assertion was never registered for that path, and the guard exited 0 (owner reproduced
 * this by dropping an attendance test symlink into the corpus root, 2026-08-09). "Skipped because
 * unclassifiable" is the same skip-green shape this entire file exists to delete, one layer below
 * the suites.
 *
 * The classification is taken from `lstat`, NOT from the `Dirent`, for two independent reasons:
 *   • `Dirent` reports `UNKNOWN` on filesystems that do not fill in `d_type`, and in that state
 *     EVERY `is*()` predicate answers false — a refusal keyed on Dirent would red the whole guard
 *     on such a filesystem for ordinary regular files. `lstat` never answers "unknown".
 *   • `statSync` would FOLLOW a symlink, so a link to a regular file would be classified as a file
 *     and admitted to the corpus under the link's own name. That is the "resolve then validate"
 *     option, and it is refused deliberately: the corpus maps a disk path to a vitest ARGUMENT
 *     (`tests/integration/<rel>`) that is then compared against the no-DB `test.exclude` and the
 *     real-DB run-lists, both of which are literal strings. A link and its target are two distinct
 *     argument spellings for one suite, so admitting the link would let a file be "wired" under one
 *     name and collected under another, and a link pointing OUT of the package (`../../..`) would
 *     mint an argument no run-list could ever legitimately carry. An outright refusal is the
 *     stricter option and it is also the only one whose right answer this static guard can know.
 *
 * The refusal is not scoped to `attendance-`-prefixed names: a name-scoped refusal would be exactly
 * the narrowing that produced every allowlist this file has been deleting.
 */
function walkFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = join(dir, entry.name)
    const st = lstatSync(full)
    if (st.isDirectory()) {
      out.push(...walkFiles(full, rel))
      continue
    }
    if (st.isFile()) {
      out.push(rel)
      continue
    }
    throw new Error(
      `corpus walk: refusing to classify "${rel}" under ${dir} — it is ${describeStatType(st)}, `
        + `neither a directory nor a regular file. An entry the walk cannot classify is REFUSED, `
        + `never skipped: skipping it would generate no wiring assertion for that path and the `
        + `guard would exit 0 over a suite no CI job executes. Replace it with a regular file (a `
        + `symlink is not resolved: a link and its target are two different vitest argument `
        + `spellings for one suite, and only one of them can be the wired one).`,
    )
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
function integrationSuiteCorpus({ dir = INTEGRATION_DIR, includeRegexes = suiteIncludeRegexes() } = {}) {
  const out = []
  for (const rel of walkFiles(dir)) {
    const arg = `${INTEGRATION_ARG_PREFIX}${rel}`
    const source = readFileSync(join(dir, rel), 'utf8')
    const matchesInclude = includeRegexes.some((re) => re.test(arg))
    if (!matchesInclude && !SUITE_API_CALL_RE.test(maskSourceNoise(source))) continue
    out.push({ rel, arg })
  }
  return out
}

/**
 * The attendance family, as the same union restricted by the family predicate.
 *
 * The restriction happens HERE and nowhere downstream: the corpus cannot claim a file that the
 * run-list and argument-safety derivations would then decline to recognise — that disagreement is
 * exactly what the nested-suite probe walked through.
 */
function attendanceCorpus(options) {
  // The SHARED predicate (owner P1-1).
  return integrationSuiteCorpus(options).filter((e) => isAttendanceIntegrationArg(e.arg))
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
    // The GOVERNING config (P1-2), resolved from the invocation — not the hardcoded name, which
    // could be a bystander while vitest loaded a different file with the same basename.
    ...(directTestArrayEntries(readCoreBackendFile(governingIntegrationConfig()), 'include') ?? []),
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
 * multitable steps (shared four-pin contract — `requireExecutableRealDbStep` throws unless the
 * step exists AND is executable, so a file cannot count as "wired" into a deleted or disabled
 * step).
 *
 * P1-2: the extraction is `executableWholeFileArgs`, NOT the shared `wholeFileVitestArgs` — a
 * command whose execution cannot be proven (`true || pnpm … vitest …`, or anything inside an `if`)
 * carries NOTHING here. DUPLICATES ARE PRESERVED so the P2 multiplicity leg can see a file carried
 * by two executable invocations; callers that only need membership build their own Set.
 */
function realDbWholeFileArgUnion() {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  return [
    ...executableWholeFileArgs(requireAttendanceRealDbStepExecutable()),
    ...executableWholeFileArgs(requireExecutableRealDbStep(wf, REAL_DB_STEP_IDS.approval)),
    ...executableWholeFileArgs(requireExecutableRealDbStep(wf, REAL_DB_STEP_IDS.multitable)),
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

// ---------------------------------------------------------------------------------------------
// P2-2 — the non-vacuity FLOORS had 17-27 members of slack, and the slack was executed.
//
// The three floors were `corpus.length >= 70`, `carried.length >= 60` and `counts.size >= 70`
// against a real 87 / 87 / 87. Narrowing the family predicate by `&& !base.startsWith(
// 'attendance-w4c2-')` — dropping the twelve suites this guard is NAMED after out of the corpus,
// the carried set, the multiplicity domain and every per-member leg at once — left it at
// 175 tests / 175 pass / 0 fail. FULLY GREEN. The only observable difference was the test count
// falling 199 → 175, and no CI step compares that against anything.
//
// A floor cannot fix this: any floor low enough to survive a legitimate deletion is high enough to
// hide one. So the family is PINNED as an exact set.
//
// WHY THIS IS NOT THE 33-ENTRY `FILES` ALLOWLIST COMING BACK. That allowlist WAS the corpus: a file
// it had never been told about was invisible, got no wiring legs, and the guard stayed green — the
// defect the OBS-1 conversion exists to have removed. This list is not the corpus and is never read
// as one. The corpus is still derived TOTALLY from disk, every derived member still registers its
// own two-point wiring leg whether or not it appears below, and this pin is a tripwire ACROSS that
// derivation: it reds in BOTH directions, so a new suite is announced rather than absorbed and a
// disappearing suite cannot be absorbed either. The old failure mode — a file nobody listed being
// silently unguarded — is not reachable through it.
//
// Updating it is deliberate and cheap: `EMIT_ATTENDANCE_CORPUS=1 node --test <this file>` prints the
// derived set, which is the value that belongs here. Same discipline as the s6a hash pin.
// ---------------------------------------------------------------------------------------------
const EXPECTED_ATTENDANCE_SUITES = Object.freeze([
  'tests/integration/attendance-approval-action-authorization.db.test.ts',
  'tests/integration/attendance-approval-dept-head-s7-3.db.test.ts',
  'tests/integration/attendance-approval-direct-manager-s7-2.db.test.ts',
  'tests/integration/attendance-approval-flow-dynamic-kind-s7-1.db.test.ts',
  'tests/integration/attendance-approval-manager-at-level-s7-4.db.test.ts',
  'tests/integration/attendance-calculation-group-membership-w1.db.test.ts',
  'tests/integration/attendance-comp-time-expiry-reminder.test.ts',
  'tests/integration/attendance-csv-export-bom.test.ts',
  'tests/integration/attendance-decision-trace-w5-0.db.test.ts',
  'tests/integration/attendance-expiry-service.test.ts',
  'tests/integration/attendance-files-acl.test.ts',
  'tests/integration/attendance-group-fixed-schedule-config-consume.db.test.ts',
  'tests/integration/attendance-group-fixed-schedule-config-migration.db.test.ts',
  'tests/integration/attendance-group-fixed-schedule-effectiveness.db.test.ts',
  'tests/integration/attendance-group-fixed-schedule-self-effectiveness.db.test.ts',
  'tests/integration/attendance-import-template-prefs.test.ts',
  'tests/integration/attendance-legacy-membership-overlap-audit.db.test.ts',
  'tests/integration/attendance-makeup-punch-policy.test.ts',
  'tests/integration/attendance-notification-deliveries.test.ts',
  'tests/integration/attendance-notification-redelivery-route.db.test.ts',
  'tests/integration/attendance-notification-redelivery.db.test.ts',
  'tests/integration/attendance-outdoor-punch.test.ts',
  'tests/integration/attendance-plugin.test.ts',
  'tests/integration/attendance-result-edit.test.ts',
  'tests/integration/attendance-schedule-dispatch.test.ts',
  'tests/integration/attendance-settlement-table-v1-5a.db.test.ts',
  'tests/integration/attendance-setup-readiness-w4-0.db.test.ts',
  'tests/integration/attendance-shift-flex-policy-migration.db.test.ts',
  'tests/integration/attendance-shift-segments-migration.db.test.ts',
  'tests/integration/attendance-shift-segments-writer-matrix.db.test.ts',
  'tests/integration/attendance-shift-swap.test.ts',
  'tests/integration/attendance-unscheduled-reminder.test.ts',
  'tests/integration/attendance-w4c0-concurrency-gates-e3.db.test.ts',
  'tests/integration/attendance-w4c0-db-gates-e1.db.test.ts',
  'tests/integration/attendance-w4c0-durable-storage-smoke.db.test.ts',
  'tests/integration/attendance-w4c0-identity-gates-e2.db.test.ts',
  'tests/integration/attendance-w4c0-identity-golden-parity.db.test.ts',
  'tests/integration/attendance-w4c0-operation-registry.db.test.ts',
  'tests/integration/attendance-w4c2-gate-matrix-e5.db.test.ts',
  'tests/integration/attendance-w4c2-live-scheduled-boundary.db.test.ts',
  'tests/integration/attendance-w4c2-outbox-dispatcher.db.test.ts',
  'tests/integration/attendance-w4c2-p12-durable-lock-gates.db.test.ts',
  'tests/integration/attendance-w4c2-p12-migration-schema-gates.db.test.ts',
  'tests/integration/attendance-w4c2-p12-run-transactions.db.test.ts',
  'tests/integration/attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts',
  'tests/integration/attendance-w4c2-p2-remediation.db.test.ts',
  'tests/integration/attendance-w4c2-posture-matrix.db.test.ts',
  'tests/integration/attendance-w4c2-sweep-call-through.db.test.ts',
  'tests/integration/attendance-w4c2-sweep-fairness.db.test.ts',
  'tests/integration/attendance-w4c2-timezone-write-guard.db.test.ts',
  'tests/integration/attendance-w4c3a-auth-recovery.db.test.ts',
  'tests/integration/attendance-w4c3a-canonical-import-kernel.db.test.ts',
  'tests/integration/attendance-w4c3a-commit-token-ordering.db.test.ts',
  'tests/integration/attendance-w4c3a-durable-legacy-plan-migration.db.test.ts',
  'tests/integration/attendance-w4c3a-durable-plan-enqueue.db.test.ts',
  'tests/integration/attendance-w4c3a-group-effects.db.test.ts',
  'tests/integration/attendance-w4c3a-group-preconditions.db.test.ts',
  'tests/integration/attendance-w4c3a-import-rollback.db.test.ts',
  'tests/integration/attendance-w4c3a-item-effects.db.test.ts',
  'tests/integration/attendance-w4c3a-p06-sync-import.db.test.ts',
  'tests/integration/attendance-w4c3a-p08-child-process.db.test.ts',
  'tests/integration/attendance-w4c3a-p09-p10-p24-routes.db.test.ts',
  'tests/integration/attendance-w4c3a-record-effects.db.test.ts',
  'tests/integration/attendance-w4c3a-record-preconditions.db.test.ts',
  'tests/integration/attendance-w4c3a-rollout-control.db.test.ts',
  'tests/integration/attendance-w4c3b-approved-leave-cancellation.db.test.ts',
  'tests/integration/attendance-w4c3b-central-approval.db.test.ts',
  'tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts',
  'tests/integration/attendance-w4c3b-request-snapshots.db.test.ts',
  'tests/integration/attendance-w4c3c-manual-recompute-retirement.db.test.ts',
  'tests/integration/attendance-w4c3c-record-operation-routes.db.test.ts',
  'tests/integration/attendance-w4c4-calculation-detail.db.test.ts',
  'tests/integration/attendance-w4c5-rollout-transition-tool.db.test.ts',
  'tests/integration/attendance-w4pre1-user-orgs-admission.db.test.ts',
  'tests/integration/attendance-w4pre1-user-orgs-directory-sync.db.test.ts',
  'tests/integration/attendance-w4pre1-user-orgs-policy.db.test.ts',
  'tests/integration/attendance-w4pre1b-admin-users-explicit-org.db.test.ts',
  'tests/integration/attendance-w4pre1b-api-tokens-org-member-access.db.test.ts',
  'tests/integration/attendance-w4pre1b-directory-readiness-gate.db.test.ts',
  'tests/integration/attendance-w4pre1b-user-orgs-backfill-migration.db.test.ts',
  'tests/integration/attendance-w4pre1b-user-orgs-lifecycle.db.test.ts',
  'tests/integration/attendance-w4pre1b-user-orgs-sync-automatch.db.test.ts',
  'tests/integration/attendance-w4pre1c-departure-org-scoped.db.test.ts',
  'tests/integration/attendance-w4pre1c-departure-permission-negative.db.test.ts',
  'tests/integration/attendance-w4pre1c-departure-sweep-deprovision.db.test.ts',
  'tests/integration/attendance-w4pre1c-manual-review-pending.db.test.ts',
  'tests/integration/attendance-w4pre1d-departure-candidate-split.db.test.ts',
  'tests/integration/attendance-w6-group-effective-policy-fixture-matrix.db.test.ts',
  'tests/integration/attendance-w6-group-effective-policy-membership-overlap.db.test.ts',
  'tests/integration/attendance-w6-group-effective-policy.db.test.ts',
  'tests/integration/attendance-work-date-resolver-w2.db.test.ts',
])

// P1-1, the other half: "this argument selects nothing" was treated as "this argument is harmless".
// It is not — vitest exits 0 on a filter that matches no file, so a stale, typo'd or renamed path
// leaves the run-list looking fully wired while the suite runs nowhere, and the previous domain
// entered by SPELLING skipped the whole invocation rather than reporting it. Every positional of
// every provably-executed real-DB invocation must therefore select at least one COLLECTED suite,
// across all families — not just the attendance ones, because the attendance step carries ~20
// non-attendance suites and the multitable step ~230, none of which had an existence leg at all.
//
// Absolute filters are refused rather than modelled: vitest matches them with
// `isAbsolute(f) && t.startsWith(f)` against the runner's real checkout prefix, which is not
// knowable from here. They over-select in the counter (fail closed) and red by name here.
/**
 * Reasons a real-DB positional is refused. ONE definition, read by the live leg below AND by the
 * frozen differential rows, so a row cannot claim a consequence the shipped predicate does not have.
 *
 * The zero-selection wording is deliberate and was CORRECTED: it used to read "selects no collected
 * integration suite", which is an assertion about VITEST that the differential proved false — `./`
 * resolves to zero here and selects the ENTIRE corpus there. The refusal is a statement about this
 * model's ability to resolve the argument, not a claim about what vitest would run.
 */
const REAL_DB_POSITIONAL_REASONS = Object.freeze({
  absolute: 'absolute path — this guard cannot resolve the runner checkout prefix',
  zero: "this guard's selection model resolves it to ZERO collected integration suites — measured "
    + 'against the real vitest 1.6.1 binary, an argument in that class selects nothing, or ONE file '
    + '(`tests\\integration\\…`, `../<pkg>/…`), or the WHOLE corpus (`./`, `tests/../`, `./././`), '
    + 'and all three are inadmissible on a real-DB run-list',
})

/**
 * @param {string} positional one file filter of a real-DB invocation
 * @param {string[]} suiteArgs the collected integration corpus
 * @returns {string|null} the refusal reason, or null when the positional is admissible
 */
function realDbPositionalRefusal(positional, suiteArgs) {
  if (positional.startsWith('/')) return REAL_DB_POSITIONAL_REASONS.absolute
  if (!suiteArgs.some((arg) => vitestFilterSelects(arg, positional))) return REAL_DB_POSITIONAL_REASONS.zero
  return null
}

test("P1-1: every positional of the three real-DB steps' invocations is package-relative and selects at least one collected suite", () => {
  const suiteArgs = integrationSuiteCorpus().map((e) => e.arg)
  assert.ok(suiteArgs.length > 0, 'the integration suite corpus is empty — an empty scan is not an absence')
  const offenders = []
  for (const [stepId, step] of realDbSteps()) {
    for (const inv of executableIntegrationInvocations(step)) {
      for (const positional of positionalFiltersOfInvocation(inv)) {
        const reason = realDbPositionalRefusal(positional, suiteArgs)
        if (reason != null) offenders.push({ stepId, positional, reason })
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a real-DB file filter this guard cannot resolve to at least one COLLECTED suite is not a no-op '
      + 'that can be waved through. If vitest also matches nothing, it exits 0 on it — so the '
      + 'run-list still reads as wiring while the suite it was meant to name executes nowhere, which '
      + 'is the direction a rename or a deletion breaks in. And if vitest matches something this '
      + 'model cannot see, the count is wrong in the other direction: `./` resolves to zero here and '
      + 'selects the ENTIRE collected corpus in real vitest 1.6.1 (executed; frozen below). Both are '
      + 'refused by the same rule, which is why the rule is "resolves to zero" and not "vitest would '
      + 'run nothing"',
  )
})

test('P1-1 positional-safety positive control: the leg can see a dead filter and an absolute one', () => {
  const CORPUS_ARGS = ['tests/integration/attendance-x.db.test.ts']
  const dead = (positional) => !CORPUS_ARGS.some((arg) => vitestFilterSelects(arg, positional))
  assert.ok(dead('tests/integration/attendance-renamed-away.db.test.ts'), 'a stale path selects nothing')
  assert.ok(dead('tests/integration/attendance-x.db.test.tsx'), 'a near-miss suffix selects nothing')
  assert.ok(dead('../outside/attendance-x.db.test.ts'), 'an escaping relative path selects nothing')
  // …and the same leg does NOT fire on the spellings that really do select, or the check would be
  // reporting everything and proving nothing.
  assert.ok(!dead('tests/integration/attendance-x.db.test.ts'))
  assert.ok(!dead('tests/integration//attendance-x.db.test.ts'))
  assert.ok(!dead('tests/integration/ATTENDANCE-x.db.test.ts'))
  assert.ok(!dead('attendance-'))
  assert.ok(!dead('tests/integration'))
})

// ---------------------------------------------------------------------------------------------
// FROZEN DIFFERENTIAL — `vitestFilterSelects` vs the REAL vitest 1.6.1 binary (gate finding P2).
//
// The docblock beside `vitestFilterSelects` used to claim the model was "the same matcher vitest
// runs it through". It is not. This table is the executed evidence of exactly where it is not, and
// it is a GATE rather than a transcript: every row asserts the model's own count AND the
// CONSEQUENCE — which refusal the shipped predicates return for that spelling. A row cannot go
// stale by quietly becoming wrong; changing the model without changing the table reds here.
//
// HOW IT WAS MEASURED (executed 2026-08-09, not read off the source). A sandbox with the REAL
// `vitest@1.6.1` binary, a byte-equivalent `include` (`tests/integration/**/*.{test,spec}.?(c|m)
// [jt]s?(x)`, no `root`, no `dir`) and the six suites below at the corpus's real path shapes (one
// NESTED). Each filter was run as `vitest --config … run --reporter=json --passWithNoTests <filter>`
// and the selected files read out of `testResults[].name`. The model was NOT retyped: the
// `vitestFilterSelects` function body was sliced byte-for-byte out of THIS file and imported.
// Result: 30 filters, 21 MATCH, 9 DIVERGE.
//
// Both divergence directions are represented, and neither can under-count silently:
//   • model 0 / vitest ≥1  → `realDbPositionalRefusal` returns `zero` and the complement returns
//     `zero`, so the invocation carrying it REDS in both domains.
//   • model ALL / vitest 1 → absolute filters, refused by name as `absolute` in both domains.
// The shape that WOULD under-count silently — model selects a non-empty PROPER subset of vitest's
// answer — does not occur in any of the 30, and that is evidence, not proof (docblock).
// ---------------------------------------------------------------------------------------------

/** The sandbox corpus the differential was executed over, in its canonical package-relative form. */
const DIFFERENTIAL_CORPUS = Object.freeze([
  'tests/integration/attendance-plugin.test.ts',
  'tests/integration/attendance-w4c2-posture-matrix.db.test.ts',
  'tests/integration/attendance-w4c2-sweep-fairness.db.test.ts',
  'tests/integration/multitable-context.api.test.ts',
  'tests/integration/sealed-export-s3-private-ingestion-realdb.test.ts',
  'tests/integration/sub/attendance-nested.db.test.ts',
])

/**
 * The executed table. `vitest` and `model` are the number of files each SELECTED out of the six.
 * `refusal` is the reason the shipped predicates must return — `null` for an admissible filter.
 */
const VITEST_161_DIFFERENTIAL = Object.freeze([
  // ---- DIVERGE, model under-selects: it resolves to zero, vitest selects one file or all six ----
  { id: 'C23', filter: './', vitest: 6, model: 0, refusal: 'zero', why: "relative(dir,'./')='' → join('','/')='/' → substring of every path" },
  { id: 'D01', filter: 'tests/../', vitest: 6, model: 0, refusal: 'zero', why: 'resolves to the root, same as C23' },
  { id: 'D02', filter: './././', vitest: 6, model: 0, refusal: 'zero', why: 'resolves to the root, same as C23' },
  { id: 'D05', filter: 'nope/../', vitest: 6, model: 0, refusal: 'zero', why: 'resolves to the root even through a directory that does not exist' },
  { id: 'C10', filter: 'tests\\integration\\attendance-w4c2-posture-matrix.db.test.ts', vitest: 1, model: 0, refusal: 'zero', why: 'pathe.normalize folds \\ to / before filterFiles; posix.normalize does not' },
  { id: 'C08', filter: '../gt-vitest/tests/integration/attendance-w4c2-posture-matrix.db.test.ts', vitest: 1, model: 0, refusal: 'zero', why: 'relative() resolves the escape back inside the root; posix.normalize keeps the ../' },
  { id: 'C29', filter: '../gt-vitest/../gt-vitest/tests/integration/attendance-plugin.test.ts', vitest: 1, model: 0, refusal: 'zero', why: 'same as C08, through two escapes' },
  // ---- DIVERGE, model over-selects: absolute filters are not modelled at all (fail closed) ----
  { id: 'C07', filter: '<ABS>/tests/integration/attendance-w4c2-posture-matrix.db.test.ts', vitest: 1, model: 6, refusal: 'absolute', why: 'the runner checkout prefix is unknowable here' },
  { id: 'C27', filter: '<ABS>//tests/integration/attendance-w4c2-posture-matrix.db.test.ts', vitest: 1, model: 6, refusal: 'absolute', why: 'same, with a doubled separator' },
  // ---- MATCH, including every spelling this file advertises ----
  { id: 'M01', filter: 'tests/integration/attendance-w4c2-posture-matrix.db.test.ts', vitest: 1, model: 1, refusal: null },
  { id: 'M02', filter: 'tests/integration//attendance-w4c2-posture-matrix.db.test.ts', vitest: 1, model: 1, refusal: null },
  { id: 'M03', filter: 'tests/integration/./attendance-w4c2-posture-matrix.db.test.ts', vitest: 1, model: 1, refusal: null },
  { id: 'M04', filter: 'tests/integration/sub/../attendance-w4c2-posture-matrix.db.test.ts', vitest: 1, model: 1, refusal: null },
  { id: 'M05', filter: 'tests/integration/ATTENDANCE-w4c2-posture-matrix.db.test.ts', vitest: 1, model: 1, refusal: null },
  { id: 'M06', filter: 'tests/integration', vitest: 6, model: 6, refusal: null },
  { id: 'M07', filter: 'tests/integration/', vitest: 6, model: 6, refusal: null },
  { id: 'M08', filter: 'attendance-', vitest: 4, model: 4, refusal: null },
  { id: 'M09', filter: 'attendance-w4c2-posture-matrix.db.test.ts', vitest: 1, model: 1, refusal: null },
  { id: 'M10', filter: 'TESTS/INTEGRATION', vitest: 6, model: 6, refusal: null },
  { id: 'M11', filter: '.', vitest: 6, model: 6, refusal: null },
  { id: 'M12', filter: '..', vitest: 0, model: 0, refusal: 'zero' },
  { id: 'M13', filter: 'no-such-suite-zzz', vitest: 0, model: 0, refusal: 'zero' },
  { id: 'M14', filter: 'tests/integratio', vitest: 6, model: 6, refusal: null },
  { id: 'M15', filter: '.db.test.ts', vitest: 3, model: 3, refusal: null },
  { id: 'M16', filter: 'multitable-', vitest: 1, model: 1, refusal: null },
  { id: 'M17', filter: 'sub/attendance-nested.db.test.ts', vitest: 1, model: 1, refusal: null },
  { id: 'M18', filter: 'tests/integration/sub', vitest: 1, model: 1, refusal: null },
  { id: 'M19', filter: 'tests/integration/attendance-w4c2-posture-matrix.db.test.tsx', vitest: 0, model: 0, refusal: 'zero' },
  { id: 'M20', filter: 'attendance-w4c2', vitest: 2, model: 2, refusal: null },
  { id: 'M21', filter: 'tests/integration/attendance-w4c2-posture-matrix.db.test.ts/..', vitest: 6, model: 6, refusal: null },
])

test('P2 frozen differential: every executed vitest-1.6.1 divergence is reproduced by the model AND refused by both consumers', () => {
  // Sanity on the table itself, so a row cannot be silently dropped or duplicated.
  assert.equal(VITEST_161_DIFFERENTIAL.length, 30, 'the executed differential had 30 rows')
  assert.equal(new Set(VITEST_161_DIFFERENTIAL.map((r) => r.id)).size, 30, 'row ids must be unique')
  const diverging = VITEST_161_DIFFERENTIAL.filter((r) => r.vitest !== r.model)
  assert.equal(diverging.length, 9, 'the executed differential found 9 divergences over 30 filters')
  assert.ok(
    diverging.every((r) => r.model === 0 || r.model === DIFFERENTIAL_CORPUS.length),
    'every divergence must be a total under-select or a total over-select — a non-empty PROPER '
      + 'subset would under-count silently, and no leg would see it',
  )

  const ABS_PREFIXES = ['/checkout', '/home/runner/work/metasheet2/metasheet2/packages/core-backend', '/a']
  const expand = (filter, abs) => filter.replace('<ABS>', abs)

  for (const row of VITEST_161_DIFFERENTIAL) {
    for (const abs of row.filter.includes('<ABS>') ? ABS_PREFIXES : ['']) {
      const filter = expand(row.filter, abs)
      // (1) the MODEL's own answer, over the same corpus the binary was run against.
      const selected = DIFFERENTIAL_CORPUS.filter((arg) => vitestFilterSelects(arg, filter))
      assert.equal(
        selected.length,
        row.model,
        `${row.id} ${JSON.stringify(filter)}: the model selected ${selected.length}, the frozen row `
          + `says ${row.model}. Real vitest 1.6.1 selected ${row.vitest} when this was executed — if `
          + `the model changed, re-run the differential and re-freeze BOTH columns`,
      )
      // (2) the CONSEQUENCE in the in-domain leg: which refusal the shipped predicate returns.
      const expected = row.refusal == null ? null : REAL_DB_POSITIONAL_REASONS[row.refusal]
      assert.equal(
        realDbPositionalRefusal(filter, DIFFERENTIAL_CORPUS),
        expected,
        `${row.id} ${JSON.stringify(filter)}: expected the real-DB positional refusal `
          + `${JSON.stringify(row.refusal)}. A divergence that is NOT refused is a silent miscount`,
      )
      // (3) …and in the COMPLEMENT leg, over a synthetic non-domain invocation. Args are supplied
      // directly rather than through a run script: the shared `shellTokens` reads `\` as bash's
      // escape and would drop it before the model ever saw C10, which is a property of the shell,
      // not of the matcher this table is about.
      const complement = outOfDomainPositionalOffenders({
        invocations: [{
          file: 'probe.yml',
          job: 'probe',
          index: 0,
          id: null,
          inv: { args: ['--config', INTEGRATION_CONFIG, 'run', filter] },
        }],
        corpusArgs: DIFFERENTIAL_CORPUS.filter(isAttendanceIntegrationArg),
        suiteArgs: DIFFERENTIAL_CORPUS,
      }).map((o) => o.reason)
      if (row.refusal === 'absolute') {
        assert.deepEqual(complement, [OUT_OF_DOMAIN_REASONS.absolute], `${row.id}: complement must refuse the absolute filter`)
      } else if (row.refusal === 'zero') {
        assert.deepEqual(complement, [OUT_OF_DOMAIN_REASONS.zero], `${row.id}: complement must refuse the unresolvable filter`)
      } else if (selected.length === DIFFERENTIAL_CORPUS.length) {
        assert.deepEqual(complement, [OUT_OF_DOMAIN_REASONS.wholeCorpus], `${row.id}: a whole-corpus widener must be refused`)
      } else if (selected.some((arg) => isAttendanceIntegrationArg(arg))) {
        assert.deepEqual(complement, [OUT_OF_DOMAIN_REASONS.attendance], `${row.id}: a second attendance execution must be refused`)
      } else {
        assert.deepEqual(complement, [], `${row.id}: a filter selecting only other families is admissible outside the domain`)
      }
    }
  }

  // NEGATIVE CONTROL on the table's discriminating power: the corpus must actually distinguish the
  // rows, or "model = 0" and "model = 6" would be the only two answers and the M-rows would prove
  // nothing. Three distinct non-trivial counts are present.
  assert.deepEqual(
    [...new Set(VITEST_161_DIFFERENTIAL.map((r) => r.model))].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 6],
  )
})

test('P2-2: the derived attendance family is EXACTLY the pinned member set', () => {
  assert.deepEqual(
    attendanceCorpus().map((e) => e.arg).sort(),
    [...EXPECTED_ATTENDANCE_SUITES],
    'the attendance corpus derived from disk no longer equals the pinned family. Both directions '
      + 'are deliberate. FEWER members: the family predicate, the disk walk or the suite-API '
      + 'detector narrowed, and every dropped suite silently left the corpus, the carried set, the '
      + 'multiplicity domain and its own per-member wiring leg — the floors this replaced tolerated '
      + '17 such members. MORE members: a new attendance suite landed, which is fine and expected — '
      + 're-run `EMIT_ATTENDANCE_CORPUS=1 node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs` '
      + 'and paste the printed set here in the same commit that wires it',
  )
})

test('OBS-1 corpus derivation is non-vacuous and both wiring sides parse', () => {
  const corpus = attendanceCorpus()
  assert.equal(
    corpus.length,
    EXPECTED_ATTENDANCE_SUITES.length,
    `attendance corpus scan under tests/integration found ${corpus.length} suites, pinned at `
      + `${EXPECTED_ATTENDANCE_SUITES.length} — a scan that shrank means the directory path, the `
      + `include globs or the suite-API detector broke, not that the family shrank by that much`,
  )
  const union = realDbWholeFileArgUnion()
  assert.ok(union.length > 0, 'real-DB steps carry no whole-file args at all — run-list parsing broke')
  const excluded = noDbExcludedArgs()
  assert.ok(excluded.size > 0, 'vitest.config.ts test.exclude parsed as empty — the config parse broke')
  // This file parses `test.exclude` locally (it needs `test.include` too, which the shared module
  // does not expose), and cross-checks the result against the shared, already-gated
  // `isQuotedInTestExclude` on every corpus member.
  //
  // P2-1: this leg USED TO SHARE THE BUG IT EXISTS TO CATCH. Both sides read entries off the
  // original source with only `//` line comments stripped, so a `/* … */`-commented entry read as
  // excluded on BOTH sides, they agreed, and the leg confirmed the defect instead of catching it —
  // a consistency check between two copies of one mistake is not a second opinion. The local side
  // now strips block comments and resolves (or refuses) spreads; the shared side still does
  // neither, which is deliberate — the shared module is untouched here (repo-level issue 4829).
  // A DISAGREEMENT IS THEREFORE A REAL FINDING in either direction — but the member it SURFACES on
  // is not necessarily the member that CAUSED it (gate finding P3-1), so the cause is derived from
  // the config and reported first. See `excludeCrossReadCauses`.
  const cfg = readCoreBackendFile(NO_DB_CONFIG)
  const disagreements = corpus
    .map(({ arg }) => ({ arg, local: excluded.has(arg), shared: isQuotedInTestExclude(cfg, arg) }))
    .filter((d) => d.local !== d.shared)
  assert.deepEqual(
    disagreements,
    [],
    `the two test.exclude reads disagree. WHY (derived from the config, not from the member the `
      + `disagreement happened to surface on):\n  ${excludeCrossReadCauses(cfg).join('\n  ')}\n`
      + `Either way the exclude side of the two-point wiring is not what it reads like`,
  )
})

/**
 * WHY the local `test.exclude` read and the shared `isQuotedInTestExclude` disagree — named from
 * the CONFIG.
 *
 * P3-1 (gate @ d72cf7dcdf): this leg used to `assert.equal` per corpus member, so the FIRST member
 * whose two answers differed became the whole diagnosis. Executed: adding one legitimate glob whose
 * string contains `//` (`'tests/integration/de//coy.ts'`) reddened while naming
 * `attendance-comp-time-expiry-reminder.test.ts`, a suite with nothing wrong with it. Fail-closed,
 * so never a bypass — but the reader is sent to the wrong file, and the actual mechanism is one line
 * away in a module they were told is out of scope.
 *
 * The mechanism, read off the shared source rather than guessed: `quotedExcludeEntries` does
 * `line.replace(/\/\/.*$/, '')` with NO string-awareness. A quoted entry containing `//` is
 * therefore TRUNCATED mid-string; the surviving opening quote pairs with the NEXT entry's opening
 * quote, and every entry after it is mis-paired. So ONE such entry desyncs an arbitrary suffix of
 * the array, and the corpus member that happens to be reported is downstream collateral.
 *
 * Three causes are distinguished, and each names its own entries:
 *   (a) an entry whose string contains `//` — the truncation above (this is the executed case);
 *   (b) an entry the SHARED side sees and the local side does not — a `/* … *\/` block comment,
 *       which vitest ignores while the shared parser counts it (the P2-1 bypass);
 *   (c) an entry the LOCAL side sees and the shared side does not — reached through a spread the
 *       shared parser cannot follow.
 *
 * @param {string} cfgSrc source of the no-DB config
 * @returns {string[]} one line per cause, most specific first; never empty
 */
function excludeCrossReadCauses(cfgSrc) {
  const local = directTestArrayEntries(cfgSrc, 'exclude') ?? []
  const body = extractTestExcludeArrayBody(cfgSrc)
  const shared = body == null ? [] : quotedExcludeEntries(body)
  const causes = []
  const truncating = local.filter((entry) => entry.includes('//'))
  if (truncating.length > 0) {
    causes.push(
      `(a) THE CAUSE IS THE ENTRY, NOT THE SUITE: ${JSON.stringify(truncating)} — the shared `
        + `quotedExcludeEntries() strips \`//\` to end of line with no string-awareness, so this `
        + `entry is TRUNCATED mid-string and its surviving quote pairs with the next entry's `
        + `opening quote. Every entry after it in the array is mis-read, which is why the members `
        + `listed above may have nothing wrong with them. Rewrite the glob without \`//\` (or take `
        + `the shared-parser fix, repo-level issue 4829)`,
    )
  }
  const onlyShared = shared.filter((entry) => !local.includes(entry))
  if (onlyShared.length > 0) {
    causes.push(
      `(b) present to the SHARED read but not in effect: ${JSON.stringify(onlyShared.slice(0, 5))}`
        + `${onlyShared.length > 5 ? ` (+${onlyShared.length - 5} more)` : ''} — a block comment `
        + `around an entry, which vitest ignores while the shared parser (which strips only \`//\`) `
        + `counts it, so the suite is collected by the no-DB job and skip-greened there`,
    )
  }
  const onlyLocal = local.filter((entry) => !shared.includes(entry))
  if (onlyLocal.length > 0) {
    causes.push(
      `(c) in effect but invisible to the SHARED read: ${JSON.stringify(onlyLocal.slice(0, 5))}`
        + `${onlyLocal.length > 5 ? ` (+${onlyLocal.length - 5} more)` : ''} — reached through a `
        + `spread the shared parser cannot follow (or truncated by (a) above)`,
    )
  }
  if (causes.length === 0) {
    causes.push(
      '(none found) — the two entry LISTS agree, so the disagreement is in the membership question '
        + 'rather than in the parse: check `directTestArrayEntries` and `isQuotedInTestExclude` for a '
        + 'normalisation difference on the reported member',
    )
  }
  return causes
}

test('P3-1: the exclude cross-read names the entry that caused the desync, not a downstream suite', () => {
  const ENTRY = 'tests/integration/attendance-x.db.test.ts'
  const cfg = (body) => `import { defineConfig } from 'vitest/config'\nexport default defineConfig({\n  test: {\n    exclude: [\n${body}\n    ],\n  },\n})\n`
  // (a) THE EXECUTED CASE — one legitimate glob containing `//`, followed by an ordinary entry.
  const desynced = cfg(`      'tests/integration/de//coy.ts',\n      '${ENTRY}',`)
  // The desync is real: the two reads disagree about a suite that is not the offending entry.
  assert.equal(directTestArrayEntries(desynced, 'exclude').includes(ENTRY), true)
  assert.equal(isQuotedInTestExclude(desynced, ENTRY), false, 'the shared read must actually desync, or this row proves nothing')
  const causes = excludeCrossReadCauses(desynced)
  assert.match(causes[0], /^\(a\) THE CAUSE IS THE ENTRY/, 'the truncating entry must be reported FIRST')
  assert.match(causes[0], /de\/\/coy\.ts/, 'the cause must name the entry that truncates')
  assert.ok(
    !causes[0].includes(ENTRY),
    'the leading cause must not name the downstream suite — that is the misdiagnosis this row exists for',
  )
  // (b) a block-commented entry: the shared side sees it, the local side does not.
  const blockCommented = cfg(`      /* '${ENTRY}', */\n      'tests/integration/other.test.ts',`)
  const bCauses = excludeCrossReadCauses(blockCommented)
  assert.ok(bCauses.some((c) => c.startsWith('(b)') && c.includes(ENTRY)), `got ${JSON.stringify(bCauses)}`)
  assert.ok(!bCauses.some((c) => c.startsWith('(a)')), 'no `//` entry is present, so (a) must not fire')
  // (c) an entry reached through a spread the shared parser cannot follow.
  const spread = `import { defineConfig } from 'vitest/config'\nconst HIDDEN = ['${ENTRY}']\nexport default defineConfig({\n  test: {\n    exclude: ['**/dist/**', ...HIDDEN],\n  },\n})\n`
  const cCauses = excludeCrossReadCauses(spread)
  assert.ok(cCauses.some((c) => c.startsWith('(c)') && c.includes(ENTRY)), `got ${JSON.stringify(cCauses)}`)
  // NEGATIVE CONTROL: a healthy config produces no cause at all, so the diagnosis is not "always
  // blame something".
  assert.deepEqual(
    excludeCrossReadCauses(cfg(`      '${ENTRY}',\n      'tests/integration/other.test.ts',`)).filter((c) => /^\([abc]\)/.test(c)),
    [],
  )
  // …and the live config is healthy today, which is what makes the leg above meaningful rather than
  // permanently red.
  assert.deepEqual(
    excludeCrossReadCauses(readCoreBackendFile(NO_DB_CONFIG)).filter((c) => /^\([abc]\)/.test(c)),
    [],
  )
})

// P2-1 FROZEN ROWS: the executed bypasses, driven over synthetic configs so the parsers are proven
// to SEE them rather than proven to agree with themselves.
test('P2-1: the config array parser sees through block comments and refuses what it cannot resolve', () => {
  const ENTRY = 'tests/integration/attendance-x.db.test.ts'
  const cfg = (body) => `import { defineConfig } from 'vitest/config'\nexport default defineConfig({\n  test: {\n    exclude: [\n${body}\n    ],\n  },\n})\n`
  // Baseline: a plain entry is read.
  assert.deepEqual(directTestArrayEntries(cfg(`      '${ENTRY}',`), 'exclude'), [ENTRY])
  // ROW: a BLOCK-commented entry is NOT an exclude entry — vitest collects the file, and so must
  // this parser conclude. This is the row that was 199/199 green.
  assert.deepEqual(directTestArrayEntries(cfg(`      /* '${ENTRY}', */`), 'exclude'), [])
  assert.deepEqual(directTestArrayEntries(cfg(`      /*\n       * '${ENTRY}',\n       */`), 'exclude'), [])
  // …and the line-comment case the shared parser already handled stays handled.
  assert.deepEqual(directTestArrayEntries(cfg(`      // '${ENTRY}',`), 'exclude'), [])
  // A `//` or `/*` INSIDE a quoted path is part of the path, not a comment — the stripper is
  // string-aware, or fixing the comment bug would have introduced a truncation bug.
  assert.deepEqual(directTestArrayEntries(cfg(`      'tests/integration//attendance-x.db.test.ts',`), 'exclude'), [
    'tests/integration//attendance-x.db.test.ts',
  ])
  // ROW: a spread is RESOLVED when it can be, so a hidden entry is still an entry…
  const withConst = `import { defineConfig } from 'vitest/config'\nconst HIDDEN = ['${ENTRY}']\nexport default defineConfig({\n  test: {\n    exclude: ['**/dist/**', ...HIDDEN],\n  },\n})\n`
  assert.deepEqual(directTestArrayEntries(withConst, 'exclude'), ['**/dist/**', ENTRY])
  // …and REFUSED when it cannot, rather than silently reading only the literals in view.
  assert.throws(() => directTestArrayEntries(cfg('      ...ELSEWHERE,'), 'exclude'), /failing CLOSED/)
  assert.throws(() => directTestArrayEntries(cfg('      ...loadExcludes(),'), 'exclude'), /failing CLOSED/)
  assert.throws(() => directTestArrayEntries(cfg('      SOME_ENTRY,'), 'exclude'), /failing CLOSED/)
  assert.throws(() => directTestArrayEntries(cfg('      `tests/${dir}/x.test.ts`,'), 'exclude'), /failing CLOSED/)
  // Absent key is still `null`, not `[]` — the two mean different things to every caller.
  assert.equal(directTestArrayEntries(cfg(`      '${ENTRY}',`), 'include'), null)
})

test('P1-2 face (b): the direct-key scan sees a narrowing key carried by a spread', () => {
  const withSpread = "import { defineConfig } from 'vitest/config'\nconst NARROW = { testNamePattern: 'no-such-test-zz' }\nexport default defineConfig({\n  test: { ...NARROW, globals: true },\n})\n"
  assert.ok(
    declaresDirectTestKey(withSpread, 'testNamePattern'),
    'a `testNamePattern` reached through `test: { ...NARROW }` must be found — this shape was '
      + '199/199 green while every carried suite executed zero assertions',
  )
  // Nested one level deeper, and via a spread inside the spread source.
  const nested = "const INNER = { testNamePattern: 'zz' }\nconst NARROW = { ...INNER }\nexport default defineConfig({ test: { ...NARROW } })\n"
  assert.ok(declaresDirectTestKey(nested, 'testNamePattern'))
  // Directly spelled still works, and an unrelated config still answers false — the scan has not
  // simply been widened to "true".
  assert.ok(declaresDirectTestKey("export default defineConfig({ test: { testNamePattern: 'zz' } })", 'testNamePattern'))
  assert.ok(!declaresDirectTestKey("export default defineConfig({ test: { globals: true } })", 'testNamePattern'))
  // A key that only appears NESTED or in a comment/string is still not a direct key.
  assert.ok(!declaresDirectTestKey("export default defineConfig({ test: { coverage: { testNamePattern: 'zz' } } })", 'testNamePattern'))
  assert.ok(!declaresDirectTestKey("export default defineConfig({ test: { /* testNamePattern: 'zz' */ globals: true } })", 'testNamePattern'))
  // An unresolvable spread is REFUSED — "I could not look" must not be reported as "absent".
  assert.throws(
    () => declaresDirectTestKey('export default defineConfig({ test: { ...imported, globals: true } })', 'testNamePattern'),
    /failing CLOSED/,
  )
  assert.throws(
    () => declaresDirectTestKey('export default defineConfig({ test: { ...makeNarrow(), globals: true } })', 'testNamePattern'),
    /failing CLOSED/,
  )
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

// The corpus is derived at REGISTRATION time (one test per member), so a walk that fails closed
// throws before any test exists. A bare module-load throw reports `tests 0 / pass 0 / fail 0` —
// non-zero exit, but the exact counts shape this tree treats as a false signal — so the failure is
// captured and re-thrown from a NAMED test instead. It is not swallowed: the error is rethrown
// verbatim, the per-member legs disappear (a visible count drop), and the non-vacuity leg above
// re-derives the corpus independently and reds on the same throw.
// The name below says "derivation" rather than naming only the walk, because this catch is what any
// registration-time failure lands in — a non-regular entry (the P2 case, and the common one) but
// equally an unparseable vitest config or an unsupported glob. Naming it after just the walk would
// be an assertion the test does not make. The captured error is rethrown VERBATIM, so whichever it
// was is stated in the failure itself.
let CORPUS = null
let CORPUS_DERIVATION_ERROR = null
try {
  CORPUS = attendanceCorpus()
} catch (err) {
  CORPUS_DERIVATION_ERROR = err
}
if (process.env.EMIT_ATTENDANCE_CORPUS === '1') {
  console.log(JSON.stringify((CORPUS ?? []).map((e) => e.arg).sort(), null, 2))
}

/**
 * The derived corpus as plain args. Throws if the derivation failed, so nothing downstream can
 * quietly reason over an empty family — the named leg below reports the captured error verbatim.
 */
function attendanceCorpusArgs() {
  if (CORPUS_DERIVATION_ERROR != null) throw CORPUS_DERIVATION_ERROR
  return (CORPUS ?? []).map((e) => e.arg)
}

test('attendance corpus derivation succeeds — the walk REFUSES (never skips) any non-regular entry', () => {
  if (CORPUS_DERIVATION_ERROR != null) throw CORPUS_DERIVATION_ERROR
  assert.ok(
    Array.isArray(CORPUS) && CORPUS.length > 0,
    'the corpus walk produced no members at all — an empty scan is not an absence',
  )
})

// Corpus part 1 (disk → wiring), TOTAL over the family: for every attendance suite on disk,
// "excluded from the no-DB job" and "carried by an executable real-DB run-list" must be the SAME
// answer, and BOTH must be true. See the part-3 header below for why the directions are one
// assertion and why "neither" is now simply refused.
for (const entry of CORPUS ?? []) {
  test(`${entry.arg} runs exactly once, with a database (no-DB exclude ⟺ real-DB run-list)`, () => {
    const reason = attendanceSuiteResidueReason({
      arg: entry.arg,
      carried: new Set(realDbWholeFileArgUnion()),
      excluded: noDbExcludedArgs(),
    })
    assert.equal(reason, null, `${entry.arg}: ${reason}`)
  })
}

// ---------------------------------------------------------------------------------------------
// P2 (owner): "executed exactly once" was UNPROVEN. The per-member leg above answers a MEMBERSHIP
// question — it builds a `Set` from the union, and a Set collapses duplicates. Owner's probe: a
// SECOND independent vitest process repeating the same file, and the guard stayed 190/190 PASS.
//
// Twice is as wrong as zero. Two vitest processes running one suite against ONE database is a race
// — the same fixtures, the same rows, the same shared-DB collision this tree has been bitten by
// before — not extra safety. So the count is asserted STRICTLY `=== 1`, and both failing directions
// are inside one assertion because the domain is seeded from the CORPUS as well as from the union:
// a suite carried zero times has a key with count 0, so `=== 1` catches "never" and "twice" alike
// rather than only the direction the probe happened to enter.
// ---------------------------------------------------------------------------------------------

/**
 * How many times each attendance suite is SELECTED, over the provably-executed real-DB invocations.
 *
 * THE KEY IS THE SUITE, NOT THE ARGUMENT. It used to be the argument string, filtered by
 * `isAttendanceIntegrationArg` — so `tests/integration/./attendance-x.db.test.ts` and
 * `tests/integration/attendance-x.db.test.ts` were two keys each counting 1 (executed: 200/200
 * green), and `ATTENDANCE-x.db.test.ts`, `tests/integration` and `attendance-` were counted under
 * no key at all because the domain predicate declined them (executed: 199/199 green) while vitest
 * ran the suites. Counting what vitest SELECTS collapses every spelling onto the one suite it
 * names, so a second execution is a second count whatever it is spelled like.
 *
 * @param {{ args: string[] }[]} invocations provably-executed invocations under the pinned config
 * @param {string[]} corpusArgs every attendance suite on disk — seeded at 0 so "never" is in domain
 * @returns {Map<string, number>}
 */
function attendanceExecutionCounts(invocations, corpusArgs) {
  const counts = new Map()
  for (const arg of corpusArgs) counts.set(arg, 0)
  for (const inv of invocations) {
    for (const arg of selectedCorpusSuites(inv, corpusArgs)) {
      counts.set(arg, (counts.get(arg) ?? 0) + 1)
    }
  }
  return counts
}

/** Every provably-executed integration-config invocation across the three real-DB steps. */
function realDbExecutableInvocations() {
  return realDbSteps().flatMap(([, step]) => executableIntegrationInvocations(step))
}

// SCOPE OF THIS UNIVERSAL, said in its own title: the domain is `realDbSteps()` — three step ids —
// and NOT every invocation that runs the governing config. Eleven steps of plugin-tests.yml and six
// more across three other workflow files do; the COMPLEMENT leg below asserts that none of those
// fourteen selects an attendance suite or widens to the whole corpus. The two together are total
// over the pinned config; neither on its own is, and an earlier revision of this title said it was.
test("P2: every attendance suite is executed EXACTLY ONCE across the three real-DB steps' provably-executed invocations (the COMPLEMENT leg covers every other invocation under the same config)", () => {
  const corpusArgs = attendanceCorpusArgs()
  const counts = attendanceExecutionCounts(realDbExecutableInvocations(), corpusArgs)
  assert.equal(
    counts.size,
    EXPECTED_ATTENDANCE_SUITES.length,
    `the multiplicity domain holds ${counts.size} attendance suites, but the pinned family has `
      + `${EXPECTED_ATTENDANCE_SUITES.length} — a domain that shrank silently would make \`=== 1\` `
      + `pass over the members it dropped`,
  )
  const offenders = [...counts.entries()]
    .filter(([, executions]) => executions !== 1)
    .map(([arg, executions]) => ({ arg, executions }))
    .sort((a, b) => (a.arg < b.arg ? -1 : 1))
  assert.deepEqual(
    offenders,
    [],
    'each attendance suite must be selected by EXACTLY ONE provably-executed invocation OF THE THREE '
      + 'REAL-DB STEPS (invocations elsewhere under the same config are the COMPLEMENT leg\'s domain, '
      + 'and it requires them to select none). `executions: 0` — it is carried by nothing that runs '
      + '(a deleted run-list entry, '
      + 'or a command this guard cannot prove executes). `executions: 2` — it runs in two vitest '
      + 'processes against ONE database, which is a fixture race, not extra coverage; the `Set` the '
      + 'per-member leg builds collapses that to a single membership answer, which is why the count '
      + 'is asserted here instead',
  )
})

const CFG_FLAG = '--config vitest.integration.config.ts'
const PROBE_ONE = 'tests/integration/attendance-x.db.test.ts'
const PROBE_NESTED = 'tests/integration/sub/attendance-y.db.test.ts'
const PROBE_OTHER = 'tests/integration/multitable-z.db.test.ts'
const PROBE_CORPUS = Object.freeze([PROBE_ONE, PROBE_NESTED])

/** Counts for a synthetic run script over the two-member probe corpus. */
const probeCounts = (run, corpus = PROBE_CORPUS) =>
  [...attendanceExecutionCounts(executableIntegrationInvocations({ run }), corpus).entries()].sort()

test('P2 multiplicity counter positive control: it distinguishes 0, 1 and 2, and ignores other families', () => {
  assert.deepEqual(
    probeCounts(`pnpm exec vitest ${CFG_FLAG} run ${PROBE_ONE} ${PROBE_NESTED} ${PROBE_OTHER}`),
    [[PROBE_ONE, 1], [PROBE_NESTED, 1]],
    'the clean shape must count 1 for both, including the NESTED suite (P1-1 predicate)',
  )
  // Two SEPARATE executable invocations repeating one file — the owner's probe shape.
  assert.deepEqual(
    probeCounts(`pnpm exec vitest ${CFG_FLAG} run ${PROBE_ONE} ${PROBE_NESTED}\npnpm exec vitest ${CFG_FLAG} run ${PROBE_ONE}`),
    [[PROBE_ONE, 2], [PROBE_NESTED, 1]],
    'a file carried by two executable invocations must count 2 — a Set would have said 1',
  )
  // Selected zero times: the corpus seed is what makes this visible at all.
  assert.deepEqual([...attendanceExecutionCounts([], [PROBE_ONE]).entries()], [[PROBE_ONE, 0]])
  // Another family is not counted, and a short-circuited second invocation contributes nothing.
  assert.equal(
    attendanceExecutionCounts(
      executableIntegrationInvocations({ run: `pnpm exec vitest ${CFG_FLAG} run ${PROBE_ONE}` }),
      [],
    ).has(PROBE_OTHER),
    false,
  )
  assert.deepEqual(
    probeCounts(`pnpm exec vitest ${CFG_FLAG} run ${PROBE_ONE}\ntrue || pnpm exec vitest ${CFG_FLAG} run ${PROBE_ONE}`, [PROBE_ONE]),
    [[PROBE_ONE, 0]],
    'an unprovable script carries NOTHING at all — including the line that would have been fine, '
      + 'because the flatness verdict is a property of the whole script',
  )
})

// ---------------------------------------------------------------------------------------------
// P1-1 FROZEN ROWS — every spelling that was executed against vitest 1.6.1 and found to select a
// real suite while this guard stayed green (199/199 or 200/200). Each is a SECOND selection of a
// suite the clean run-list already selects once, so the correct answer is 2, and each is asserted
// here rather than left to a transcript: the transcripts age out, these do not.
//
// They are NOT the mechanism. The mechanism is `vitestFilterSelects`, which asks vitest's own
// question; these rows are its non-vacuity proof — evidence that the transcription actually matches
// the behaviour that was measured, on the exact inputs that were measured. A tenth spelling nobody
// has written down is handled by the matcher, not by this list growing.
// ---------------------------------------------------------------------------------------------
test('P1-1 frozen rows: every executed bypass spelling now counts as the SECOND execution of the suite it selects', () => {
  const clean = `pnpm exec vitest ${CFG_FLAG} run ${PROBE_ONE} ${PROBE_NESTED}`
  /** @param {string} spelling the positional appended as a second, independent invocation */
  const withSecondInvocation = (spelling) => probeCounts(`${clean}\npnpm exec vitest ${CFG_FLAG} run ${spelling}`)

  // 1. double slash — normalised away by `relative(dir, f)`; the OLD key rejected `rel` starting `/`
  assert.deepEqual(withSecondInvocation('tests/integration//attendance-x.db.test.ts'), [[PROBE_ONE, 2], [PROBE_NESTED, 1]])
  // 2. `./` — normalised; the OLD key made it a SECOND map entry counting 1
  assert.deepEqual(withSecondInvocation('tests/integration/./attendance-x.db.test.ts'), [[PROBE_ONE, 2], [PROBE_NESTED, 1]])
  // 3. `sub/..` — normalised, same as 2
  assert.deepEqual(withSecondInvocation('tests/integration/sub/../attendance-x.db.test.ts'), [[PROBE_ONE, 2], [PROBE_NESTED, 1]])
  // 4. case variant — vitest lowercases BOTH sides; the OLD key compared case-sensitively
  assert.deepEqual(withSecondInvocation('tests/integration/ATTENDANCE-x.db.test.ts'), [[PROBE_ONE, 2], [PROBE_NESTED, 1]])
  // 5. bare directory — selects EVERY integration suite, and was not a whole-file arg at all
  assert.deepEqual(withSecondInvocation('tests/integration'), [[PROBE_ONE, 2], [PROBE_NESTED, 2]])
  // 6. the 11-character family fragment — selects the WHOLE family, invisible to every old leg
  assert.deepEqual(withSecondInvocation('attendance-'), [[PROBE_ONE, 2], [PROBE_NESTED, 2]])
  // …and its relatives: a bare basename, a trailing-slash directory, and NO positional at all
  assert.deepEqual(withSecondInvocation('attendance-x.db.test.ts'), [[PROBE_ONE, 2], [PROBE_NESTED, 1]])
  assert.deepEqual(withSecondInvocation('tests/integration/'), [[PROBE_ONE, 2], [PROBE_NESTED, 2]])
  assert.deepEqual(probeCounts(`${clean}\npnpm exec vitest ${CFG_FLAG} run`), [[PROBE_ONE, 2], [PROBE_NESTED, 2]])
  // An absolute filter is not modellable here, so it OVER-selects (fail closed) and is refused by
  // name in the positional-safety leg below — it can never quietly reduce a count.
  assert.deepEqual(withSecondInvocation('/checkout/tests/integration/attendance-x.db.test.ts'), [[PROBE_ONE, 2], [PROBE_NESTED, 2]])
  // NEGATIVE CONTROL — the counter is not simply saying 2 to everything: a fragment that selects
  // nothing, and another family's suite, leave the clean counts alone.
  assert.deepEqual(withSecondInvocation('multitable-'), [[PROBE_ONE, 1], [PROBE_NESTED, 1]])
  assert.deepEqual(withSecondInvocation(PROBE_OTHER), [[PROBE_ONE, 1], [PROBE_NESTED, 1]])
})

// The other half of row 8 of the executed table: a `-t` on an invocation that selects an attendance
// suite through a spelling the domain predicate declines. The `-t` was never even read, because the
// domain was entered by spelling and the empty filtered list was `continue`d.
test('P1-1 frozen rows: a narrowing flag is READ on an invocation that selects attendance suites by ANY spelling', () => {
  const BASE = `pnpm exec vitest ${CFG_FLAG} run`
  for (const spelling of [
    'tests/integration//attendance-x.db.test.ts',
    'tests/integration/./attendance-x.db.test.ts',
    'tests/integration/sub/../attendance-x.db.test.ts',
    'tests/integration/ATTENDANCE-x.db.test.ts',
    'tests/integration',
    'attendance-',
    'attendance-x.db.test.ts',
  ]) {
    assert.deepEqual(
      detectUnpermittedAttendanceArgs(`${BASE} ${spelling} -t zzz`),
      spelling === 'tests/integration//attendance-x.db.test.ts' || spelling === 'tests/integration/./attendance-x.db.test.ts'
        || spelling === 'tests/integration/sub/../attendance-x.db.test.ts' || spelling === 'tests/integration/ATTENDANCE-x.db.test.ts'
        ? ['-t', 'zzz']
        : [spelling, '-t', 'zzz'],
      `the \`-t\` must be REPORTED on an invocation selecting attendance suites spelled "${spelling}"`,
    )
  }
  // NEGATIVE CONTROL: a spelling that selects NO attendance suite is still not reported, so this
  // leg has not simply been widened to "report every invocation".
  assert.deepEqual(detectUnpermittedAttendanceArgs(`${BASE} ${PROBE_OTHER} -t zzz`), [])
  assert.deepEqual(detectUnpermittedAttendanceArgs(`${BASE} multitable- -t zzz`), [])
})

// ---------------------------------------------------------------------------------------------
// THE COMPLEMENT of `realDbSteps()` (gate finding @ d72cf7dcdf, P1).
//
// Every leg above this line has ONE domain: the three step ids `realDbSteps()` names. That domain
// is right for what those legs assert about attendance WIRING — the three steps are where the
// family is wired and where the executability contract is held. It is NOT the set of places a
// SECOND execution can come from. Measured here with the PyYAML walk below, not estimated:
// ELEVEN steps of plugin-tests.yml run vitest under the governing config, and six more do across
// three other workflow files — SEVENTEEN invocations, of which `realDbSteps()` contributes three.
//
// THE ATTACK, executed against the head this leg lands on. Add ONE line to the EXISTING
// `sealed-export-s3-real-db` step — same workflow, same job, same Postgres service, already
// carrying `DATABASE_URL`, already invoking `--config vitest.integration.config.ts run`:
//
//       tests/integration/sealed-export-s3-private-ingestion-realdb.test.ts \
//     + tests/integration/attendance-w4c2-posture-matrix.db.test.ts \
//       --reporter=verbose
//
// → the guard was 208/208 GREEN while that suite ran in TWO vitest processes against ONE database.
// Replace the added line with the single positional `./` → 208/208 GREEN again, while real vitest
// 1.6.1 expands `./` to the ENTIRE collected corpus (executed; see the differential table beside
// `vitestFilterSelects`). Both are verbatim the hazard the multiplicity leg names — "two vitest
// processes against ONE database, which is a fixture race, not extra coverage" — entered through
// the axis the counting-key rewrite did not touch. The enumeration of SPELLINGS was deleted; the
// enumeration of STEPS was not, and the step one was the one still open.
//
// THE TWO LEGS ARE JOINTLY TOTAL, and each is now qualified so neither claims the other's ground.
// The multiplicity leg says: across the three real-DB steps' provably-executed invocations, each
// attendance suite is selected EXACTLY ONCE. This leg says: across EVERY OTHER invocation under
// the same governing config, in every workflow file that names it, no attendance suite is selected
// at all and no positional widens to the whole corpus. Together they cover every vitest invocation
// under the pinned config in `.github/workflows`, which is the universe the "exactly once" claim
// needs — and neither sentence is an unqualified universal over a domain of three.
//
// WHAT THIS DELIBERATELY IS NOT: the fully DERIVED domain (take every step that runs the governing
// config and apply the three real-DB steps' rules to it). That is the better end state and it is
// NOT taken here, on purpose: those rules include the inert-alphabet flatness property, which is
// currently held against three CURATED run scripts. Applying it to the fourteen foreign
// invocations would red scripts that are not this change's to rewrite (sealed-export S3/S4,
// after-sales, BPMN ×2, real-app assembly, snapshot-protection, comment-reaction, and three
// sealed-export workflows), so it is an OWNER RULING on alphabet scope, deferred and stated rather
// than taken silently.
//
// Consequences of that choice, stated rather than left to be found:
//   • This leg reads the SHARED `vitestInvocations`, never the flatness-gated
//     `executableVitestInvocations`. Gating it would fail OPEN precisely where it matters: a
//     foreign script that this guard cannot prove flat would contribute NO invocations and its
//     duplicate attendance argument would pass unseen. More invocations examined is the
//     conservative direction here, and it is the opposite direction from the in-domain legs, where
//     an unprovable command must not count as wiring.
//   • It reds on a FOREIGN step whose positional this guard's model cannot resolve to a definite,
//     non-empty, proper subset of the collected corpus — the same polarity, and the same cost, as
//     the inert alphabet: a widening is an owner decision, not a silent one.
//   • The domain is invocations whose `--config` argument SPELLS the governing config's basename,
//     which is what the shared `argsUseIntegrationConfig` matches. A config named through a shell
//     variable (`--config $CFG`) is outside it — and outside every other leg in this file too,
//     because the shared helper cannot see it either. Stated, not hidden.
//   • ALSO OUTSIDE IT, and stated for the same reason: a foreign step running the attendance suites
//     under a DIFFERENT config file of its own. The three real-DB steps cannot do that (the
//     governing-config resolver pins their `--config` to the canonical file by name), and the no-DB
//     job cannot (every family member is excluded there), but nothing in this file forbids a
//     fifteenth step from introducing a third config whose `include` collects
//     `tests/integration/attendance-*`. Closing that needs the DERIVED domain deferred above plus a
//     rule about which configs may collect the family — one owner ruling, not a reviewer-local
//     widening. MEASURED at this head rather than assumed, and the measurement is not "there are
//     none": packages/core-backend holds SEVEN vitest configs, five besides the two this file
//     reads, and two of those five (`vitest.collab-ux-flow.config.ts`, `vitest.comment-flow.
//     config.ts`) DO collect under tests/integration. Each names exactly one non-attendance file in
//     its `include`, and NO workflow step invokes either (nothing under .github/workflows names
//     their basenames — checked with a positive control on the governing config's own basename, so
//     the empty result is an absence rather than an unread path). That is a measurement of today,
//     explicitly not a gate.
// ---------------------------------------------------------------------------------------------

/** The three step ids `realDbSteps()` covers — the set this leg is the complement OF. */
const IN_DOMAIN_STEP_IDS = Object.freeze([STEP_ID, REAL_DB_STEP_IDS.approval, REAL_DB_STEP_IDS.multitable])

/**
 * The ONE workflow file whose steps can be "covered" by `realDbSteps()`.
 *
 * `realDbSteps()` resolves the three ids with `extractStepById` over
 * `.github/workflows/plugin-tests.yml` and nothing else, so covered-ness is FILE-SCOPED. Deciding it
 * on the id alone would let a decoy step carrying an in-domain id, in ANOTHER workflow file that
 * sorts earlier, consume the coverage slot — and then the REAL attendance step would land in this
 * complement and red under the decoy's name. Fail-closed either way, but the diagnosis would point
 * at the legitimate step: the same misdiagnosis class as the `//`-truncation above, one leg over.
 * The non-vacuity leg additionally asserts each id occurs EXACTLY ONCE across the discovered files
 * and in THIS file, so a cross-file duplicate reds by its own name rather than being merely absorbed.
 */
const COVERED_WORKFLOW_FILE = 'plugin-tests.yml'

const WORKFLOWS_DIR = join(repoRoot, '.github/workflows')

/**
 * Reasons a non-domain invocation is refused. Each is a DISTINCT string so the offender list
 * discriminates the failure shapes rather than collapsing them into one indistinguishable red —
 * a mutation matrix whose rows share a signature proves less than one whose rows do not.
 */
const OUT_OF_DOMAIN_REASONS = Object.freeze({
  noPositional: 'no positional at all — vitest then runs the ENTIRE collected corpus of the governing config',
  absolute: 'absolute path — this guard cannot resolve the runner checkout prefix, so what it selects is unknown',
  attendance: 'selects attendance suites, which are already executed by the three real-DB steps — a SECOND execution',
  wholeCorpus: 'selects the WHOLE collected corpus, so every attendance suite runs a second time',
  zero: "resolves to ZERO collected suites under this guard's selection model, which cannot be "
    + 'admitted here — an argument in that class selects nothing, or one file, or (`./`) the WHOLE '
    + 'corpus in real vitest 1.6.1, and the last of those double-runs every attendance suite',
})

/**
 * Workflow files that NAME the governing config's basename, read as `{ file, text }`.
 *
 * The text pre-filter is not a shortcut: an invocation whose `--config` value does not spell that
 * basename is not in this leg's domain in the first place (the shared `argsUseIntegrationConfig`
 * matches the basename and nothing else), so a file that never contains the string cannot hold a
 * member. It keeps the YAML bridge's blast radius proportional to real usage instead of coupling
 * this guard to the parseability of all 81 workflow files.
 *
 * The directory scan REFUSES a non-regular entry rather than skipping it, on the same principle as
 * `walkFiles` — a SYMLINKED workflow is a file this guard has not read. It follows that helper's
 * treatment of DIRECTORIES too, which is not refusal: GitHub Actions does not read nested workflow
 * directories at all, so a subdirectory here cannot hold a step that runs, and refusing it would red
 * this guard over something that can never execute.
 */
function workflowFilesNamingGoverningConfig(basename, dir = WORKFLOWS_DIR) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const st = lstatSync(join(dir, name))
    if (st.isDirectory()) continue
    if (!st.isFile()) {
      throw new Error(
        `workflow scan: failing CLOSED — .github/workflows/${name} is ${describeStatType(st)}, not a `
          + `regular file; this guard reads workflow text and cannot vouch for what it did not read`,
      )
    }
    if (!/\.ya?ml$/.test(name)) continue
    const text = readFileSync(join(dir, name), 'utf8')
    if (!text.includes(basename)) continue
    out.push({ file: name, text })
  }
  return out
}

/**
 * Every step carrying a `run:` script across the given workflow files, in document order, off the
 * PARSED YAML — one fail-closed python3+PyYAML bridge for all of them (stdin = JSON `[{file,text}]`).
 * A file that does not parse aborts, naming itself: an unparseable workflow is not "no steps".
 *
 * @returns {{ file: string, job: string, index: number, id: string|null, run: string }[]}
 */
function workflowStepsWithRun(files) {
  const py = [
    'import json, sys',
    'try:',
    '    import yaml',
    'except Exception as exc:',
    "    sys.stderr.write('PYYAML_MISSING: %r' % (exc,))",
    '    sys.exit(3)',
    'entries = json.loads(sys.stdin.read())',
    'out = []',
    'for entry in entries:',
    '    try:',
    '        doc = yaml.safe_load(entry["text"])',
    '    except Exception as exc:',
    '        sys.stderr.write("YAML_PARSE_ERROR in %s: %r" % (entry["file"], exc))',
    '        sys.exit(4)',
    '    jobs = doc.get("jobs") if isinstance(doc, dict) else None',
    '    if not isinstance(jobs, dict):',
    '        continue',
    '    for job_name, job in jobs.items():',
    '        steps = job.get("steps") if isinstance(job, dict) else None',
    '        if not isinstance(steps, list):',
    '            continue',
    '        for index, step in enumerate(steps):',
    '            if not isinstance(step, dict):',
    '                continue',
    '            run = step.get("run")',
    '            if not isinstance(run, str):',
    '                continue',
    '            step_id = step.get("id")',
    '            out.append({',
    '                "file": entry["file"],',
    '                "job": str(job_name),',
    '                "index": index,',
    '                "id": step_id if isinstance(step_id, str) else None,',
    '                "run": run,',
    '            })',
    'json.dump(out, sys.stdout)',
  ].join('\n')
  const res = spawnSync('python3', ['-c', py], {
    input: JSON.stringify(files),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  })
  if (res.error) {
    throw new Error(`workflow step walk: failing CLOSED — python3 could not be spawned (${res.error.message})`)
  }
  if (res.status !== 0) {
    throw new Error(
      `workflow step walk: failing CLOSED — PyYAML bridge exited ${res.status}: `
        + `${(res.stderr || '').trim() || '(no stderr)'}`,
    )
  }
  return JSON.parse(res.stdout)
}

/**
 * Every vitest invocation under the governing config that `realDbSteps()` does NOT cover.
 *
 * "Covered" is the FIRST step in document order carrying each of the three ids — which is the step
 * the shared first-match-wins lookup resolves. A DUPLICATE id later in the document is therefore
 * NOT waved through as in-domain: it lands here, where it is judged on its arguments.
 *
 * @param {{ file: string, job: string, index: number, id: string|null, run: string }[]} steps
 */
function outOfDomainIntegrationInvocations(steps) {
  const claimed = new Set()
  const out = []
  for (const step of steps) {
    // FILE-SCOPED, then first-in-document-order. See `COVERED_WORKFLOW_FILE`.
    const claimable = step.file === COVERED_WORKFLOW_FILE
      && typeof step.id === 'string'
      && IN_DOMAIN_STEP_IDS.includes(step.id)
    const isCovered = claimable && !claimed.has(step.id)
    if (claimable) claimed.add(step.id)
    if (isCovered) continue
    for (const inv of vitestInvocations(step)) {
      if (!inv.usesIntegrationConfig) continue
      out.push({ file: step.file, job: step.job, index: step.index, id: step.id, inv })
    }
  }
  return out
}

/**
 * The refusals. A positional of a non-domain invocation is admissible ONLY when it resolves to a
 * NON-EMPTY, PROPER subset of the collected integration corpus that contains no attendance suite.
 *
 * The zero-selection rule is not pedantry, and it is where this leg absorbs the one place the
 * selection model is known to diverge from vitest: every divergent spelling measured against the
 * real binary makes this model select ZERO while vitest selects one file or the entire corpus
 * (`./` is the worst case). Refusing "resolves to zero" therefore refuses the whole divergence
 * class by name instead of relying on a model that would have to guess the runner's checkout path.
 *
 * @param {object} o
 * @param {{ file: string, job: string, index: number, id: string|null, inv: { args: string[] } }[]} o.invocations
 * @param {string[]} o.corpusArgs the attendance family
 * @param {string[]} o.suiteArgs the whole collected integration corpus
 */
function outOfDomainPositionalOffenders({ invocations, corpusArgs, suiteArgs }) {
  const offenders = []
  const at = (m) => ({ file: m.file, job: m.job, index: m.index, id: m.id })
  for (const member of invocations) {
    const filters = positionalFiltersOfInvocation(member.inv)
    if (filters.length === 0) {
      offenders.push({ ...at(member), positional: null, reason: OUT_OF_DOMAIN_REASONS.noPositional })
      continue
    }
    for (const positional of filters) {
      // The "absolute" and "resolves to zero" boundaries have ONE definition in this file — the
      // same `realDbPositionalRefusal` the in-domain positional-safety leg uses. Two copies could
      // be fixed independently, and the disagreement would be the defect. Only the WORDING differs,
      // so the two legs stay distinguishable in a failure diff.
      const shared = realDbPositionalRefusal(positional, suiteArgs)
      if (shared === REAL_DB_POSITIONAL_REASONS.absolute) {
        offenders.push({ ...at(member), positional, reason: OUT_OF_DOMAIN_REASONS.absolute })
        continue
      }
      const selected = suiteArgs.filter((arg) => vitestFilterSelects(arg, positional))
      if (selected.length === suiteArgs.length) {
        offenders.push({ ...at(member), positional, reason: OUT_OF_DOMAIN_REASONS.wholeCorpus })
        continue
      }
      const attendance = corpusArgs.filter((arg) => vitestFilterSelects(arg, positional))
      if (attendance.length > 0) {
        offenders.push({ ...at(member), positional, reason: OUT_OF_DOMAIN_REASONS.attendance })
        continue
      }
      if (shared === REAL_DB_POSITIONAL_REASONS.zero) {
        offenders.push({ ...at(member), positional, reason: OUT_OF_DOMAIN_REASONS.zero })
      }
    }
  }
  return offenders
}

/** The live complement domain, derived end to end. */
function liveOutOfDomainInvocations() {
  return outOfDomainIntegrationInvocations(
    workflowStepsWithRun(workflowFilesNamingGoverningConfig(posix.basename(governingIntegrationConfig()))),
  )
}

test('COMPLEMENT discovery scan positive control: it selects by text, skips directories, and REFUSES a non-regular entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w4c2-wfscan-'))
  try {
    writeFileSync(join(dir, 'b-names-it.yml'), 'jobs:\n  x:\n    steps:\n      - run: vitest --config vitest.integration.config.ts run a\n')
    writeFileSync(join(dir, 'a-names-it.yaml'), '# vitest.integration.config.ts mentioned in a comment\n')
    writeFileSync(join(dir, 'c-does-not.yml'), 'jobs: {}\n')
    writeFileSync(join(dir, 'd-names-it.yml.example'), 'vitest.integration.config.ts\n')
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts/nested.yml'), 'vitest.integration.config.ts\n')
    // SELECTION: by extension AND by text, sorted; the `.yml.example` and the non-naming file are out,
    // and a NESTED file is out because GitHub never reads it.
    assert.deepEqual(
      workflowFilesNamingGoverningConfig('vitest.integration.config.ts', dir).map((e) => e.file),
      ['a-names-it.yaml', 'b-names-it.yml'],
    )
    // NEGATIVE CONTROL on the text filter itself — a basename nothing names selects nothing, so the
    // filter is doing work rather than always answering "all".
    assert.deepEqual(workflowFilesNamingGoverningConfig('vitest.nowhere.config.ts', dir), [])
    // REFUSAL: a symlink is a file this guard has not read. Proven to fire, not asserted to.
    symlinkSync(join(dir, 'b-names-it.yml'), join(dir, 'e-link.yml'))
    assert.throws(
      () => workflowFilesNamingGoverningConfig('vitest.integration.config.ts', dir),
      /failing CLOSED/,
      'a symlinked workflow must be refused rather than followed or skipped',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('COMPLEMENT is non-vacuous: workflow steps outside the three real-DB steps do run the governing config', () => {
  const invocations = liveOutOfDomainInvocations()
  assert.ok(
    invocations.length > 0,
    'no invocation outside the three real-DB steps runs the governing config at all — either the '
      + 'workflow walk broke or the file pre-filter did, and the complement assertion below would '
      + 'pass over an empty set forever. An empty scan is not an absence',
  )
  // The three in-domain steps must be EXCLUDED from it, or the leg is asserting over the wrong set.
  const ids = new Set(invocations.map((m) => m.id))
  for (const id of IN_DOMAIN_STEP_IDS) {
    assert.ok(!ids.has(id), `${id} is covered by realDbSteps() and must not appear in its complement`)
  }
  // The invocation set must include the workflow the rest of this file reads — the one carrying the
  // required `test (20.x)` context, the shared Postgres service, and therefore the executed attack.
  assert.ok(
    invocations.some((m) => m.file === 'plugin-tests.yml'),
    'plugin-tests.yml contributes no non-domain invocation of the governing config — that is where '
      + 'the executed double-run attack lives, so a domain without it is asserting over the wrong set',
  )
  // The DISCOVERY scan must not be truncating. Cross-checked against an independent readdir+text
  // pass rather than pinned to a count: "more than one file" would red the day the sealed-export
  // workflows are legitimately retired, while a scan that silently returned only its first hit
  // would satisfy a count pin just as well. Equality with the independent pass catches the
  // truncation and survives the retirement.
  const basename = posix.basename(governingIntegrationConfig())
  const namingFiles = readdirSync(WORKFLOWS_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .filter((name) => readFileSync(join(WORKFLOWS_DIR, name), 'utf8').includes(basename))
    .sort()
  assert.ok(namingFiles.length > 0, `no workflow file names ${basename} at all — an empty scan is not an absence`)
  assert.deepEqual(
    workflowFilesNamingGoverningConfig(basename).map((e) => e.file),
    namingFiles,
    'the shipped discovery scan and an independent readdir+text pass disagree about which workflow '
      + 'files name the governing config — a scan that stops early would make this leg total over a '
      + 'subset while reading as total over the repository',
  )
  // COVERAGE IS FILE-SCOPED, and that assumption is asserted rather than assumed: each in-domain id
  // must occur EXACTLY ONCE across every discovered file, and in the file `realDbSteps()` resolves
  // it in. A duplicate id anywhere else reds HERE, by its own file and index, instead of silently
  // consuming the coverage slot and making the legitimate step look like the offender.
  const discovered = workflowStepsWithRun(workflowFilesNamingGoverningConfig(basename))
  for (const id of IN_DOMAIN_STEP_IDS) {
    assert.deepEqual(
      discovered.filter((s) => s.id === id).map((s) => `${s.file}#${s.index}`).map((k) => k.split('#')[0]),
      [COVERED_WORKFLOW_FILE],
      `step id "${id}" must occur exactly once across the workflow files that name the governing `
        + `config, and in ${COVERED_WORKFLOW_FILE} — the only file realDbSteps() resolves it in. A `
        + `second step carrying this id elsewhere is a decoy: realDbSteps() would still resolve the `
        + `original while the complement's coverage slot was consumed by whichever sorted first`,
    )
  }
})

test('COMPLEMENT: no invocation outside the three real-DB steps selects an attendance suite or widens to the whole corpus', () => {
  const suiteArgs = integrationSuiteCorpus().map((e) => e.arg)
  assert.ok(suiteArgs.length > 0, 'the integration suite corpus is empty — an empty scan is not an absence')
  const offenders = outOfDomainPositionalOffenders({
    invocations: liveOutOfDomainInvocations(),
    corpusArgs: attendanceCorpusArgs(),
    suiteArgs,
  })
  assert.deepEqual(
    offenders,
    [],
    'the multiplicity leg counts executions across the THREE real-DB steps only. Seventeen vitest '
      + 'invocations run the governing config across this repository\'s workflows, so "executed '
      + 'exactly once" is only true if the other fourteen execute NO attendance suite and widen to '
      + 'nothing. Adding `tests/integration/attendance-*.db.test.ts` to any of them — e.g. the '
      + '`sealed-export-s3-real-db` step, which shares this job and its Postgres service — runs '
      + 'that suite in a SECOND vitest process against ONE database: a fixture race, not extra '
      + 'coverage. A positional resolving to zero or to the whole corpus is refused for the same '
      + 'reason one step over: `./` selects nothing in this guard\'s model and EVERYTHING in real '
      + 'vitest 1.6.1. If a foreign step must legitimately carry one of these shapes, that is an '
      + 'owner decision (and the derived-domain rewrite this leg defers), not a silent widening',
  )
})

/**
 * The `sealed-export-s3-real-db` step's run script, VERBATIM at the head the gate attacked — the
 * exact foreign step both 208/208-green mutations were applied to.
 *
 * A frozen copy rather than a live read, deliberately: this test is the POSITIVE CONTROL for the
 * live leg above, and a control whose fixture is the very thing under attack reds twice for one
 * defect and can be pushed off its own expectations by the mutation it is meant to detect (the
 * MUT-A probe, applied on top of a workflow already carrying MUT-A, would see the argument twice).
 * The live side is asserted by the leg above, over all fourteen invocations; this side proves the
 * detector can SEE the two shapes, which an "assert absent" leg cannot prove about itself.
 */
const S3_STEP_RUN_AT_GATE_HEAD = ': "${DATABASE_URL:?DATABASE_URL is required for sealed-export S3 real-DB proof}"\n'
  + 'pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \\\n'
  + '  tests/integration/sealed-export-s3-private-ingestion-realdb.test.ts \\\n'
  + '  --reporter=verbose\n'

// FROZEN PROBES — the two mutations that were 208/208 GREEN at the head this leg lands on, each
// driven through the SHIPPED routines over a foreign step of the real shape.
test('COMPLEMENT frozen probes: the two executed 208/208-green mutations are now refused, each with its own signature', () => {
  const corpusArgs = attendanceCorpusArgs()
  const suiteArgs = integrationSuiteCorpus().map((e) => e.arg)
  const VICTIM = 'tests/integration/attendance-w4c2-posture-matrix.db.test.ts'
  assert.ok(corpusArgs.includes(VICTIM), 'the probe victim must be a real corpus member')
  const S3 = { file: 'plugin-tests.yml', job: 'test', index: 54, id: 'sealed-export-s3-real-db' }
  const CARRIED = 'tests/integration/sealed-export-s3-private-ingestion-realdb.test.ts'
  /** The shipped routines over ONE foreign step. */
  const probe = (run) =>
    outOfDomainPositionalOffenders({
      invocations: outOfDomainIntegrationInvocations([{ ...S3, run }]),
      corpusArgs,
      suiteArgs,
    }).map((o) => ({ positional: o.positional, reason: o.reason }))
  /** …with one extra positional appended to its run-list, exactly as the mutations did it. */
  const withExtraPositional = (extra) =>
    probe(S3_STEP_RUN_AT_GATE_HEAD.replace(CARRIED, `${CARRIED} \\\n  ${extra}`))

  // The step's REAL script, unmutated, is admissible — so every red below is the mutation, not the
  // shape. (The live leg above asserts the same thing over the live text of all fourteen.)
  assert.deepEqual(probe(S3_STEP_RUN_AT_GATE_HEAD), [])

  // PROBE 1 (MUT-A): one extra line naming an attendance suite, in the same run-list, same job,
  // same Postgres service. Guard was 208/208 green.
  assert.deepEqual(withExtraPositional(VICTIM), [{ positional: VICTIM, reason: OUT_OF_DOMAIN_REASONS.attendance }])
  // …and through SPELLINGS the domain predicate declines, so the probe is not testing one literal.
  for (const spelling of [
    'tests/integration//attendance-w4c2-posture-matrix.db.test.ts',
    'tests/integration/./attendance-w4c2-posture-matrix.db.test.ts',
    'tests/integration/ATTENDANCE-w4c2-posture-matrix.db.test.ts',
    'attendance-w4c2-posture-matrix',
  ]) {
    assert.deepEqual(
      withExtraPositional(spelling),
      [{ positional: spelling, reason: OUT_OF_DOMAIN_REASONS.attendance }],
      `a second execution spelled "${spelling}" must be refused by NAME`,
    )
  }

  // PROBE 2 (MUT-B): the `./` positional. Guard was 208/208 green, while real vitest 1.6.1 expands
  // `./` to the ENTIRE collected corpus (executed — see the differential table).
  assert.deepEqual(withExtraPositional('./'), [{ positional: './', reason: OUT_OF_DOMAIN_REASONS.zero }])
  // …its relatives in the same divergence class, all of which this model resolves to zero.
  for (const spelling of ['tests/../', './././', 'nope/../']) {
    assert.deepEqual(
      withExtraPositional(spelling),
      [{ positional: spelling, reason: OUT_OF_DOMAIN_REASONS.zero }],
      `"${spelling}" resolves to zero here and is refused rather than admitted`,
    )
  }
  // The Windows-separator spelling too — noting what the shared tokeniser does to it on the way in:
  // `shellTokens` reads `\` as bash's escape character and DROPS it, so the token that reaches the
  // model is `testsintegrationattendance-…`, not the path. It resolves to zero either way, and zero
  // is refused, which is the point: the refusal does not depend on recognising the spelling.
  assert.deepEqual(
    withExtraPositional('tests\\integration\\attendance-w4c2-posture-matrix.db.test.ts').map((o) => o.reason),
    [OUT_OF_DOMAIN_REASONS.zero],
  )
  // …and the wideners this model DOES see as wideners: a bare directory, a trailing-slash one, the
  // family fragment, and the invocation with no positional at all.
  for (const spelling of ['tests/integration', 'tests/integration/', '.']) {
    assert.deepEqual(
      withExtraPositional(spelling),
      [{ positional: spelling, reason: OUT_OF_DOMAIN_REASONS.wholeCorpus }],
      `"${spelling}" selects the whole corpus and must be refused as a widener`,
    )
  }
  assert.deepEqual(
    withExtraPositional('attendance-'),
    [{ positional: 'attendance-', reason: OUT_OF_DOMAIN_REASONS.attendance }],
    'the 11-character family fragment selects the whole family and is refused as attendance, not as a widener',
  )
  assert.deepEqual(
    probe(S3_STEP_RUN_AT_GATE_HEAD.replace(` \\\n  ${CARRIED}`, '')),
    [{ positional: null, reason: OUT_OF_DOMAIN_REASONS.noPositional }],
  )
  // …and an absolute one, which this model cannot resolve at all.
  assert.deepEqual(
    withExtraPositional('/checkout/tests/integration'),
    [{ positional: '/checkout/tests/integration', reason: OUT_OF_DOMAIN_REASONS.absolute }],
  )

  // NEGATIVE CONTROL — the leg is not refusing everything: a second legitimate non-attendance file
  // is admissible, so a real foreign step can still grow a real argument.
  assert.deepEqual(withExtraPositional('tests/integration/comment-reactions.api.test.ts'), [])

  // A step carrying one of the three ids is skipped only for its FIRST occurrence: a duplicate
  // decoy id later in the document is judged HERE, not waved through as covered.
  const withVictim = S3_STEP_RUN_AT_GATE_HEAD.replace(CARRIED, `${CARRIED} \\\n  ${VICTIM}`)
  const duplicateDecoy = outOfDomainIntegrationInvocations([
    { file: COVERED_WORKFLOW_FILE, job: 'test', index: 0, id: STEP_ID, run: S3_STEP_RUN_AT_GATE_HEAD },
    { file: COVERED_WORKFLOW_FILE, job: 'other', index: 1, id: STEP_ID, run: withVictim },
  ])
  assert.equal(duplicateDecoy.length, 1, 'the SECOND step with an in-domain id must not be treated as covered')
  assert.deepEqual(
    outOfDomainPositionalOffenders({ invocations: duplicateDecoy, corpusArgs, suiteArgs }).map((o) => o.reason),
    [OUT_OF_DOMAIN_REASONS.attendance],
  )
  // …and coverage is FILE-SCOPED as well as first-wins. A decoy carrying an in-domain id in ANOTHER
  // workflow file — one that sorts BEFORE plugin-tests.yml, so it is walked first — must NOT consume
  // the coverage slot: `realDbSteps()` resolves the three ids over plugin-tests.yml alone, so the
  // decoy is not the step the in-domain legs judge. Getting this wrong is silent in the polarity
  // that matters least (still red) and loud in the wrong place: the LEGITIMATE step would be the one
  // reported. Both steps below carry the attendance argument, and BOTH must be judged here.
  const crossFileDecoy = outOfDomainIntegrationInvocations([
    { file: 'aaa-decoy.yml', job: 'decoy', index: 0, id: STEP_ID, run: withVictim },
    { file: COVERED_WORKFLOW_FILE, job: 'test', index: 9, id: STEP_ID, run: withVictim },
  ])
  assert.deepEqual(
    crossFileDecoy.map((m) => m.file),
    ['aaa-decoy.yml'],
    'a step with an in-domain id in a DIFFERENT workflow file must be judged by the complement, and '
      + `the ${COVERED_WORKFLOW_FILE} one must still be the covered step`,
  )
  assert.deepEqual(
    outOfDomainPositionalOffenders({ invocations: crossFileDecoy, corpusArgs, suiteArgs })
      .map((o) => `${o.file}:${o.reason}`),
    [`aaa-decoy.yml:${OUT_OF_DOMAIN_REASONS.attendance}`],
  )

  // The frozen copy is a copy of something REAL: a step with this id, running the governing config,
  // exists in the live workflow. What its script says today is the live leg's business, not this
  // control's — but that the scenario exists at all is asserted rather than assumed.
  const liveIds = new Set(liveOutOfDomainInvocations().map((m) => m.id))
  assert.ok(
    liveIds.has('sealed-export-s3-real-db'),
    'the foreign step these probes are named for must still be a live non-domain invocation of the '
      + 'governing config, or this control is frozen against a scenario that no longer exists',
  )
})

// ---------------------------------------------------------------------------------------------
// Corpus part 3 (issue 4828, owner-ruled): the hiding place the first two corpora leave open —
// closed by a TOTAL partition instead of by classifying gate shapes.
//
// The slot: a suite that IS DB-gated but is NOT named `*.db.test.ts` and is carried by NO real-DB
// run-list was invisible to a `*.db.test.ts` disk glob (misses it by name) and to a run-list
// derivation (misses it because it is in no run-list) alike. That is exactly the slot
// `attendance-settlement-table-v1-5a.test.ts` occupied until this PR renamed it.
//
// TWO earlier implementations of this leg tried to answer that by READING THE SOURCE, and both were
// executed and bypassed:
//
//   1. `classifyDbGate` asked "does this file contain a DB gate?" from a four-entry list of
//      gate-ADJACENT patterns and called everything else gate-free. Review executed fourteen real
//      gate shapes; TEN came back safe-to-run-with-no-database, including a self-skip on this lane's
//      OWN `ATTENDANCE_TEST_DATABASE_URL` (invisible to `/\bDATABASE_URL\b/` — the preceding `_` is
//      a word character, so there is no word boundary) and a `beforeAll(ctx => ctx.skip())`.
//   2. `proveNoDatabaseDependence` inverted it: it enumerated what DB-INDEPENDENCE looks like and
//      called everything else unknown. Better polarity, same class of defect one level in — its
//      module-specifier requirement ("import nothing but 'vitest'") could only see a STRING LITERAL
//      specifier, so the owner executed `require(moduleVariable)` → `{ proven: true }` and
//      `await import(moduleVariable)` → `{ proven: true }` (both reproduced 2026-08-09). A dynamic
//      DB-helper suite dropped into a temp corpus with no exclude and no run-list left the guard
//      PASSING. Teaching it those two spellings would have been the third round of the same move.
//
// OWNER RULING (2026-08-09): do not harden the enumeration — REMOVE the thing that needs
// enumerating. The self-proof exit is DELETED, along with the whole predicate that served it. This
// leg no longer reads suite source at all. It asks only WHERE THE FILE RUNS, which is stated in two
// machine-readable places and nowhere else, and it requires BOTH:
//
//   excluded from the no-DB job's vitest.config.ts   ∧   carried by an executable real-DB run-list
//
// Each of the other three cells is a distinct way to execute nothing:
//   • carried but NOT excluded — the no-DB job collects it too and its gate skip-greens it there,
//     a half-satisfied two-point wiring.
//   • excluded but NOT carried — removed from the only job that would have collected it and put in
//     no run-list: it executes NOWHERE, whatever its source says.
//   • NEITHER — the file sits in the no-DB job with no run-list behind it. This used to be the cell
//     a suite could argue its way out of; there is no argument any more. The boundary is now a pure
//     WIRING property with no source analysis in it, so the entire question "can this guard
//     recognise that gate/import/require spelling" ceases to exist — there is nothing left for a new
//     spelling to fool.
//
// WHAT THAT COSTS, stated rather than left to be discovered: no-DB residency is no longer available
// to an attendance integration suite at all. A genuinely database-free one must be two-point wired
// like every other member (it will simply run under the real-DB step and pass), or live outside
// tests/integration, or outside the `attendance-` family. Widening this back — for that suite or any
// other — is an owner ruling, never a reviewer-local convenience.
//
// REACHABILITY at the head this landed on: measured, not asserted. Forcing the exit to always FAIL
// reddened exactly two tests, both synthetic (the proof unit test and the temp-dir sweep); ZERO of
// the 87 per-member wiring legs moved, because every one of the 87 is already carried AND excluded.
// So the deletion changes no reachable verdict here — it removes a bypass, not a capability.
//
// BOTH SIDES ARE DERIVED. The file set is the recursive disk scan above (which now REFUSES any entry
// that is not a directory or a regular file, rather than skipping it); "carried" is the SAME
// `realDbWholeFileArgUnion()` the other corpora use; "excluded" is parsed out of the same
// `test.exclude` the shared `isQuotedInTestExclude` reads (and proven to agree with it, above).
// Nothing is hand-listed — a hand-listed domain is the defect class this guard exists to delete.
// ---------------------------------------------------------------------------------------------

/**
 * The part-3 verdict for one attendance suite: `null` when it runs exactly once with a database,
 * otherwise the reason it does not. `carried` and `excluded` are INJECTED so the temp-dir mutation
 * below can drive all four cells — on the live tree every member is carried+excluded, which would
 * otherwise leave the three failing directions green against nothing.
 *
 * TOTAL and SOURCE-FREE. Three of the four cells fail, and the file's contents are not consulted in
 * any of them: `source` is deliberately NOT a parameter. That is the whole point of the 2026-08-09
 * ruling — for as long as a suite could argue "I need no database" from its own text, the guard had
 * to RECOGNISE the argument, and every recogniser shipped so far was executed and bypassed (a gate on
 * `ATTENDANCE_TEST_DATABASE_URL`, a gate hoisted into a helper, and finally
 * `require(moduleVariable)` / `await import(moduleVariable)`, which the literal-only specifier scan
 * could not see at all). With no self-proof exit there is no recogniser and nothing to bypass.
 */
function attendanceSuiteResidueReason({ arg, carried, excluded }) {
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
  return 'neither excluded from the no-DB job nor carried by a real-DB run-list — the no-DB job '
    + 'collects it, a DB gate in any spelling skip-greens it there, and no CI job ever executes it. '
    + "Every attendance integration suite must satisfy BOTH wiring points: a real-DB step's "
    + 'run-list AND the no-DB test.exclude. There is no self-proof exit: a suite may no longer '
    + 'argue from its own source that it needs no database (that exit was deleted 2026-08-09 after '
    + '`require(moduleVariable)` and `await import(moduleVariable)` were executed and returned '
    + '"proven"). A genuinely database-free suite is wired like the rest, or lives outside '
    + 'tests/integration / outside the attendance- family. Adding an exclusion to this guard '
    + 'instead is a contract change requiring an owner ruling (issue 4828)'
}

/**
 * The whole part-3 sweep as a pure-ish function of (directory, carried set, excluded set) so the
 * permanent mutation test below can drive it over a SYNTHETIC temp-dir corpus — no probe fixture
 * is shipped in the real tree.
 */
function collectAttendanceResidue({ dir, carried, excluded, includeRegexes }) {
  const residue = []
  for (const entry of attendanceCorpus({ dir, includeRegexes })) {
    const reason = attendanceSuiteResidueReason({ arg: entry.arg, carried, excluded })
    if (reason != null) residue.push({ file: entry.rel, reason })
  }
  return residue
}

// PERMANENT ENCODING of the owner-named mutations, over all four cells of the partition. Driven
// over a temp-dir corpus, so no probe fixture ever lives in packages/core-backend/tests/integration
// — and, critically, so the three FAILING cells, which are LIVE-VACUOUS on the real tree (every real
// member is carried AND excluded), still have a test that can go red when they break.
//
// This is also the standing regression test for the DELETED self-proof exit. SEVEN probes below sit
// in the ¬excluded ∧ ¬carried cell, spanning FIVE different source shapes: an inline env gate, a gate
// imported from a helper, a `require(moduleVariable)`, an `await import(moduleVariable)` (those two
// are what the owner executed against the old predicate — it returned `{ proven: true }` for both),
// and a completely self-contained vitest-only suite, which the old predicate accepted as DB-free.
// All seven must be residue and all seven must carry the IDENTICAL reason, asserted by equality. If
// a future change reintroduces any source-reading exit, at least one of them either drops out of the
// residue list or gets a different reason, and this test reds either way.
test('issue 4828 residue sweep: all four cells of (excluded × carried) behave, and the verdict is source-independent, over a temp-dir corpus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w4c2-part3-'))
  try {
    const GATED = "const describeDb = process.env.DATABASE_URL ? describe : describe.skip\ndescribeDb('x', () => { it('y', () => {}) })\n"
    const SELF_CONTAINED = "import { describe, it } from 'vitest'\ndescribe('pure', () => { it('x', () => {}) })\n"
    const HELPER_GATED = "import { describeDb } from './helpers/db'\ndescribeDb('x', () => { it('y', () => {}) })\n"
    // The two shapes the deleted `proveNoDatabaseDependence` returned `{ proven: true }` for: the
    // module specifier is a VARIABLE, so a scan that could only capture a string literal saw no
    // import at all and let an unwired DB-helper suite through.
    const REQUIRE_VAR = "const spec = './hel' + 'pers/db'\nconst h = require(spec)\nit('y', () => { h.q() })\n"
    const IMPORT_VAR = "const spec = './hel' + 'pers/db'\nconst h = await import(spec)\nit('y', () => { h.q() })\n"
    const files = {
      // excluded ∧ carried — the only clean cell.
      'attendance-probe-wired.db.test.ts': GATED,
      // excluded ∧ ¬carried — executes NOWHERE.
      'attendance-probe-excluded-uncarried.db.test.ts': GATED,
      // ¬excluded ∧ carried — the no-DB job collects it too and skip-greens it.
      'attendance-probe-carried-unexcluded.test.ts': GATED,
      // ¬excluded ∧ ¬carried — six sources, one verdict.
      'attendance-probe-loose-gated.test.ts': GATED,
      'attendance-probe-loose-helper.test.ts': HELPER_GATED,
      'attendance-probe-loose-require-var.test.ts': REQUIRE_VAR,
      'attendance-probe-loose-import-var.test.ts': IMPORT_VAR,
      'attendance-probe-loose-selfcontained.test.ts': SELF_CONTAINED,
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
        'attendance-probe-loose-import-var.test.ts',
        'attendance-probe-loose-require-var.test.ts',
        'attendance-probe-loose-selfcontained.test.ts',
        'attendance-probe-spec.spec.ts',
        'sub/attendance-probe-nested.test.ts',
      ],
      'exactly these nine probes must be residue — including the self-contained suite and the two '
        + 'variable-specifier probes, which the deleted self-proof exit waved through; only the '
        + 'two-point-wired one, the non-suite companion and the other family must not',
    )
    const reasonOf = (name) => residue.find((r) => r.file === name).reason
    assert.match(reasonOf('attendance-probe-excluded-uncarried.db.test.ts'), /executes NOWHERE/)
    assert.match(reasonOf('attendance-probe-carried-unexcluded.test.ts'), /half-satisfied two-point wiring/)
    // Source-independence, asserted as EQUALITY rather than as five separate pattern matches: the
    // unwired cell returns one reason, and it cannot vary with what the file contains.
    const UNWIRED = reasonOf('attendance-probe-loose-gated.test.ts')
    assert.match(UNWIRED, /neither excluded from the no-DB job nor carried by a real-DB run-list/)
    assert.match(UNWIRED, /There is no self-proof exit/)
    for (const name of [
      'attendance-probe-loose-helper.test.ts',
      'attendance-probe-loose-require-var.test.ts',
      'attendance-probe-loose-import-var.test.ts',
      'attendance-probe-loose-selfcontained.test.ts',
      'attendance-probe-spec.spec.ts',
      'sub/attendance-probe-nested.test.ts',
    ]) {
      assert.equal(
        reasonOf(name),
        UNWIRED,
        `${name} must get the IDENTICAL unwired verdict as the plainly-gated probe — the verdict is `
          + `a wiring property, and nothing in a file's source may change it`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// P2 positive control on the walk's refusal, driven over a temp dir: the classification must be
// TOTAL. A regular file and a directory are walked; a symlink — even one pointing at a perfectly
// good regular file in the same directory — is REFUSED rather than resolved, and so is a FIFO where
// the platform can make one. Without this, "walkFiles throws on a symlink" would be a claim about
// code rather than an executed fact, and the earlier `else if (isFile())` shape (which silently
// dropped both) would pass every other leg in this file.
test('P2: the corpus walk refuses symlinks and other non-regular entries instead of skipping them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w4c2-walk-'))
  try {
    writeFileSync(join(dir, 'attendance-real.test.ts'), "it('x', () => {})\n")
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub/attendance-nested.test.ts'), "it('x', () => {})\n")
    // Control: with only directories and regular files, the walk succeeds and finds both.
    assert.deepEqual(walkFiles(dir).sort(), ['attendance-real.test.ts', 'sub/attendance-nested.test.ts'])

    symlinkSync('attendance-real.test.ts', join(dir, 'attendance-link.test.ts'))
    assert.throws(
      () => walkFiles(dir),
      (err) => /refusing to classify "attendance-link\.test\.ts"/.test(err.message)
        && /symbolic link/.test(err.message)
        && /mode 0o120000/.test(err.message),
      'a symlink must red the walk with a message naming the entry and its type — never vanish',
    )
    rmSync(join(dir, 'attendance-link.test.ts'))
    // A symlink pointing OUT of the corpus root is refused for the same reason (it would mint a
    // vitest argument spelling no run-list could legitimately carry).
    symlinkSync(join(dir, 'sub/attendance-nested.test.ts'), join(dir, 'attendance-abs-link.test.ts'))
    assert.throws(() => walkFiles(dir), /refusing to classify "attendance-abs-link\.test\.ts"/)
    rmSync(join(dir, 'attendance-abs-link.test.ts'))
    // …and the refusal is not scoped to the attendance- prefix: any unclassifiable entry reds.
    symlinkSync('attendance-real.test.ts', join(dir, 'zz-other-family.test.ts'))
    assert.throws(() => walkFiles(dir), /refusing to classify "zz-other-family\.test\.ts"/)
    rmSync(join(dir, 'zz-other-family.test.ts'))

    // FIFO: same refusal, different type. Skipped only where mkfifo is unavailable — and the skip is
    // reported, never silent (the symlink legs above already prove the refusal branch executes).
    const fifo = join(dir, 'attendance-fifo.test.ts')
    const mk = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
    if (mk.status === 0) {
      assert.throws(
        () => walkFiles(dir),
        (err) => /refusing to classify "attendance-fifo\.test\.ts"/.test(err.message)
          && /FIFO \/ named pipe/.test(err.message),
      )
      rmSync(fifo)
    } else {
      console.log(`# note: mkfifo unavailable on this platform (${mk.status}), FIFO leg not executed`)
    }

    // Restored to a clean corpus, the walk succeeds again — so the throws above were the entries,
    // not a latched failure.
    assert.deepEqual(walkFiles(dir).sort(), ['attendance-real.test.ts', 'sub/attendance-nested.test.ts'])
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
  // P3-2 (gate @ d72cf7dcdf): this computation used to run BARE at module scope, so any
  // registration-time failure escaped as a module-load throw and node reported the whole FILE as
  // one failing test — `tests 1 / pass 0 / fail 1`. That is the degenerate count shape this very
  // file argues against beside `unprovableRunLines` ("a throw there reports tests 0 / pass 0 /
  // fail 0 — the count shape this tree treats as a false signal"), and it was reachable: pointing
  // a real-DB step's `--config` at a SYMLINK aliasing the canonical config produced exactly it.
  //
  // It is captured the same way the corpus derivation above is: the error is held and re-thrown
  // from a NAMED test, so the failure arrives as an ordinary red inside a full run (the per-member
  // legs disappear, which is a visible count drop, and the named leg says what happened) instead of
  // as a one-line file-level abort with the other 200-odd assertions never evaluated.
  //
  // The SHARED predicate (owner P1-1): the prefix test this replaced dropped every SUBDIRECTORY
  // attendance suite out of the existence + integration-config legs below, while the corpus above
  // claimed it — the third of the three places that could disagree about what an attendance
  // argument is.
  let carried = null
  let carriedError = null
  try {
    carried = [...new Set(realDbWholeFileArgUnion())]
      .filter(isAttendanceIntegrationArg)
      .sort()
  } catch (err) {
    carriedError = err
  }

  test('OBS-1 corpus part 2 derivation succeeds — the real-DB run-list union is readable', () => {
    if (carriedError != null) throw carriedError
    assert.ok(
      Array.isArray(carried) && carried.length > 0,
      'the real-DB run-list union produced no attendance args at all — an empty scan is not an absence',
    )
  })

  test('OBS-1 corpus part 2 is non-vacuous (real-DB run-lists carry attendance files)', () => {
    if (carriedError != null) throw carriedError
    // P2-2: was `>= 60` against a real 87 — 27 members of slack, so the run-list side could lose a
    // third of the family without a red. Pinned to the same exact set as the disk side, which also
    // makes the two sides unable to shrink together and still agree.
    assert.deepEqual(
      carried,
      [...EXPECTED_ATTENDANCE_SUITES],
      `real-DB run-lists carry ${carried.length} attendance files; the pinned family has `
        + `${EXPECTED_ATTENDANCE_SUITES.length}. A shortfall means the run-list parsing broke or `
        + `wiring was deleted, not that the family shrank by that much`,
    )
  })

  // The integration config decides what a real-DB step actually collects out of the files it is
  // handed. It carries `include`/`exclude` (and could carry `testNamePattern`), and nothing pinned
  // any of them: narrowing `include`, widening `exclude` or adding a name filter silences every
  // carried suite at once, with the run-lists, the no-DB excludes and the argument allowlist above
  // all still green — the same bypass as `-t`, one file over. Pinned here, attendance-scoped: the
  // assertion is over the attendance args only, not over the approval/multitable corpora.
  test(`the GOVERNING integration config still collects every carried attendance suite, and applies no name filter`, () => {
    if (carriedError != null) throw carriedError
    // P1-2: the config is RESOLVED from the invocation, so this pin can no longer be pointed at a
    // bystander with the same basename while vitest loads a different file.
    const governing = governingIntegrationConfig()
    const cfg = readCoreBackendFile(governing)
    const include = directTestArrayEntries(cfg, 'include')
    assert.ok(
      Array.isArray(include) && include.length > 0,
      `${governing} must declare a direct test.include — without it this pin cannot be `
        + `evaluated and the real-DB steps' collection is unstated`,
    )
    const includeRe = include.map(globToRegExp)
    const excludeRe = (directTestArrayEntries(cfg, 'exclude') ?? []).map(globToRegExp)
    for (const arg of carried) {
      assert.ok(
        includeRe.some((re) => re.test(arg)),
        `${arg} is carried by a real-DB run-list but matches no test.include glob of `
          + `${governing} (${JSON.stringify(include)}) — the step would hand vitest a path `
          + `it does not collect, and vitest exits 0 on it`,
      )
      assert.ok(
        !excludeRe.some((re) => re.test(arg)),
        `${arg} is carried by a real-DB run-list but matches a test.exclude glob of `
          + `${governing} — it is removed from the very run that is supposed to execute it`,
      )
    }
    assert.ok(
      !declaresDirectTestKey(cfg, 'testNamePattern'),
      `${governing} must not declare test.testNamePattern: a name filter set in the config `
        + `silences every carried suite exactly as \`-t\` does on the command line, and the argument `
        + `allowlist above cannot see it`,
    )
    // The selection model (`vitestFilterSelects`) stands in for vitest's `relative(dir, f)` on the
    // assumption that `dir` — vitest's root — IS the package directory these arguments are already
    // relative to. That holds because the steps run through `pnpm --filter @metasheet/core-backend
    // exec`, so cwd == root. It is PINNED rather than assumed: a `root`/`dir` in the config would
    // re-base every filter and every corpus path at once, silently, underneath a matcher that
    // would go on comparing the old strings.
    for (const [key, opener, where] of [
      ['root', undefined, 'test'],
      ['dir', undefined, 'test'],
      ['root', /\bdefineConfig\s*\(\s*\{/, 'the top-level config object'],
    ]) {
      assert.ok(
        !declaresDirectTestKey(cfg, key, opener),
        `${governing} must not declare \`${key}\` on ${where}: it re-bases vitest's \`dir\`, and `
          + `every path this guard reasons about — the run-list arguments, the corpus, the `
          + `include/exclude globs — is relative to packages/core-backend. Changing the root without `
          + `re-deriving them makes the whole selection model compare strings from two coordinate `
          + `systems`,
      )
    }
  })

  // The resolved path is ALSO pinned to the canonical one. The resolution above already makes a
  // decoy self-defeating (its own `testNamePattern` reds the leg it was meant to slip past), but a
  // relocation should be a named one-line red rather than something a reader has to infer from a
  // leg that happens to still pass. `INTEGRATION_CONFIG` is now used ONLY here — as the pinned
  // value, never as the thing that gets read.
  test('P1-2: the config the real-DB steps actually load is the canonical integration config', () => {
    assert.equal(
      governingIntegrationConfig(),
      INTEGRATION_CONFIG,
      `the real-DB steps' \`--config\` resolves to a different file than `
        + `packages/core-backend/${INTEGRATION_CONFIG}. The shared \`argsUseIntegrationConfig\` `
        + `matches only the BASENAME — \`tests/vitest.integration.config.ts\` and `
        + `\`../decoy/vitest.integration.config.js\` both satisfy it — so a same-basename file `
        + `elsewhere in the tree used to be admitted while every pin inspected the canonical one. `
        + `Moving the config is an owner decision: update this pin in the same commit`,
    )
  })

  // `?? []` because the derivation may have failed above: the per-member legs then simply do not
  // register (a visible count drop) and the named leg reports the captured error verbatim — which
  // is the whole point of capturing it rather than letting the module-load throw eat the file.
  for (const file of carried ?? []) {
    test(`${file} (carried by a real-DB run-list) exists on disk`, () => {
      // Both wiring texts can stay intact while the suite is renamed/deleted — vitest exits 0
      // on an unmatched path argument, so CI stays green and the suite never executes.
      assert.ok(
        existsSync(join(repoRoot, 'packages/core-backend', file)),
        `wired suite packages/core-backend/${file} must exist on disk`,
      )
    })
  }
}
