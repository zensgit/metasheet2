import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REAL_DB_STEP_IDS,
  requireExecutableRealDbStep,
  wholeFileVitestArgs,
  extractTestExcludeArrayBody,
  quotedExcludeEntries,
} from '../../../../scripts/ops/ci-realdb-step-contract.mjs'
import { APPROVAL_CI_COVERAGE_ALLOWLIST } from './approval-ci-coverage-allowlist'

/**
 * FAIL-0 mechanical enumeration guard for approval CI coverage.
 *
 * WHAT THIS PROVES: every approval spec/test file on disk (four tiers, §-numbered below) is either
 * (a) collected by a named, un-skippable CI lane, or (b) present in the explicit, commented
 * allowlist (`approval-ci-coverage-allowlist.ts`) of deliberate exclusions. A newly-added, unwired
 * approval spec turns the matching `it(...)` below RED by construction — the enumeration is a live
 * `fs.readdirSync` glob, not a snapshot list.
 *
 * WHERE THIS LIVES, AND WHY: `packages/core-backend/tests/unit/*.test.ts` is collected by Vitest's
 * DEFAULT include glob (no `include:` override in vitest.config.ts — see the self-exemption test
 * below), which runs via `packages/core-backend/package.json`'s `"test": "vitest"` — invoked by the
 * "Run core-backend tests" step in `.github/workflows/plugin-tests.yml`'s `test` job (matrix
 * `[18.x, 20.x]`, no `if:` guard on that step), i.e. BOTH required `test (18.x)` / `test (20.x)`
 * contexts. A brand-new file in `tests/unit/` needs NO workflow edit to be collected — that is what
 * makes this home un-skippable. The alternative (a `node:test` `scripts/ops/*.test.mjs` guard) would
 * need an explicit `node --test scripts/ops/…` line inside `plugin-tests.yml`, which is s6a
 * `PINNED_EVIDENCE_FILES`-pinned and must not be touched.
 *
 * DEVIATIONS FROM THE ORIGINAL DESIGN SPEC — every one below was found by reading `origin/main`
 * directly (not trusting the spec's stale-SHA prose) and is load-bearing for correctness:
 *   - W6 (`plugin-tests.yml`'s "Run approval real-DB integration" step) carries NO
 *     `METASHEET_REAL_DB_TEST_STEP` env key (grep confirms exactly one occurrence of that marker in
 *     the whole file, on the UNRELATED multitable real-DB step). This guard does not require it for
 *     W6; it reuses `scripts/ops/ci-realdb-step-contract.mjs` instead, which pins the REAL
 *     executability contract for that step (20.x matrix leg + a literal-shaped `DATABASE_URL` +
 *     a genuine `vitest --config vitest.integration.config.ts` invocation, off a real YAML parse —
 *     strictly stronger than a text-masking regex, and already the proven, CI-exercised mechanism
 *     ~20 other `*-ci-wiring.test.mjs` guards rely on for this exact step).
 *   - W7 (`approval-realdb-*.yml` / `approval-template-policy-carrier-realdb.yml`) sets both
 *     `DATABASE_URL` and `EXPECT_DB` at JOB level (before `steps:`), not step level — every one of
 *     the 7 lanes was read to confirm this. The job-scoped parser below reflects that.
 *   - T2 (`apps/web/verification/approval-*.spec.ts`) does NOT run via named `vitest run <file>`
 *     arguments at all — these are Playwright specs. `approval-browser-verify.yml` runs
 *     `playwright test --config playwright.approval-verification.config.ts`, whose `testMatch` array
 *     (not a `paths:`-listed run-block arg) is the real membership evidence; the sibling
 *     `multitable-browser-verify.yml` runs `playwright.verification.config.ts`, whose `testMatch` is
 *     the WILDCARD `**` + `/*.spec.ts` glob minus a `testIgnore` array — so any `.spec.ts` dropped into
 *     `apps/web/verification/` is swept by construction UNLESS `testIgnore`'d without also being
 *     claimed by the approval lane's `testMatch`. The classifier below matches this real mechanism.
 *   - W1 (`run-required-web-tests.sh`) has FOUR separate `(npx|exec npx) vitest run …` invocations,
 *     including a multi-line backslash-continued one and one 2000+-character single-line invocation
 *     prefixed with `exec` — the scout's scout-time token count was approximate for exactly this
 *     reason. The bash-logical-line joiner below (validated against a dry run that reproduced the
 *     file's own documented "19 pre-existing red + 1 newly-found red" FE quarantine list byte-for-
 *     byte) handles all four forms.
 *   - W3 (`approval-web-guard.yml`) is deliberately NOT parsed: it is path-filtered / non-required,
 *     so per this guard's own T1 rule it can never be the HARD coverage evidence — and a structural
 *     check (dry run against current main) found every T1 file that W3 would additionally match
 *     already carries an explicit W1 token, so parsing it adds parsing surface with zero
 *     discriminating power today. If that ever changes, the guard's own T1 "explicit token" rule
 *     will start reporting soft-uncovered files, which is the correct signal to revisit this.
 *
 * TWO BUGS THE FIRST GUARD RUN CAUGHT IN ITSELF (kept here so the next editor does not reintroduce
 * either — both were found by running the guard against real main and reading its own false
 * failures, not by inspection):
 *   1. W6 initially checked ONLY `REAL_DB_STEP_IDS.approval`. ~10 approval-named suites (e.g.
 *      approval-attachment-gc-realdb, approval-route-preview-api, approval-record-projection) run
 *      inside the SIBLING "Run multitable real-DB integration" step instead (T3-6 approval<->
 *      multitable projection goldens). Fixed by unioning both steps' whole-file args (see w6Step*
 *      below).
 *   2. W7 coverage-inclusion initially required `hasDatabaseUrl && hasExpectDb` on the covering job.
 *      Two real jobs (approval-realdb-k4 / -k5b) deliberately omit EXPECT_DB — DATABASE_URL is
 *      unconditionally hardcoded in their env, so there is no skip-green ambiguity for EXPECT_DB to
 *      guard against, and their suites carry the OTHER anti-skip-green form instead ("sentinel: ...
 *      DATABASE_URL", inside describeIfDatabase). Requiring EXPECT_DB at the inclusion stage falsely
 *      reported both suites as "runs NOWHERE". Fixed by dropping hasExpectDb from the inclusion
 *      condition — the EXPECT_DB-specific concern is handled separately, per-suite, by
 *      hasAntiSkipGreenSentinel (which already accepts either form; see its own disjunction-
 *      discipline tests below).
 *
 * VERIFIED AGAINST: `origin/main` (residual-hardening slice, 2026-08-19).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}

// ---------------------------------------------------------------------------------------------
// §6 scan negative control: repoRoot must be derived from import.meta.url (never bare cwd), and
// must actually resolve to the repo root — never trust it silently.
// ---------------------------------------------------------------------------------------------
describe('repo-root resolution (scan negative control)', () => {
  it('resolves to a directory that actually contains .github/workflows/plugin-tests.yml', () => {
    expect(existsSync(join(repoRoot, '.github/workflows/plugin-tests.yml'))).toBe(true)
  })
})

// =================================================================================================
// Pure parsers (exported implicitly via module scope for the Half-A tests below — this file is not
// imported elsewhere, so "exported" here means "reachable by this file's own describe blocks",
// which is sufficient: Half A drives these functions directly with synthetic fixtures).
// =================================================================================================

/**
 * W1: every non-flag positional token across ALL `(npx|exec npx|pnpm … exec) vitest run …`
 * invocations in `run-required-web-tests.sh`, including multi-line backslash-continued ones. Full-
 * line `#` comments are stripped before joining logical lines, so a token mentioned only in a
 * comment is never extracted (proven in the decoy tests below). Vitest CLI positionals are PATH-
 * SUBSTRING filters, not exact basenames — callers decide EXECUTES (substring) vs EXPLICIT (exact)
 * semantics; this function only tokenizes.
 */
function extractVitestTokensFromBashScript(scriptSrc: string): Set<string> {
  const kept = scriptSrc.split('\n').filter((line) => !/^\s*#/.test(line))
  const logicalLines: string[] = []
  let buf = ''
  for (const rawLine of kept) {
    const trimmedRight = rawLine.replace(/\s+$/, '')
    buf = buf ? `${buf} ${trimmedRight.trim()}` : trimmedRight
    if (buf.endsWith('\\')) {
      buf = buf.slice(0, -1).trim()
    } else {
      logicalLines.push(buf)
      buf = ''
    }
  }
  if (buf) logicalLines.push(buf)

  const tokens = new Set<string>()
  for (const line of logicalLines) {
    const match = line.match(/vitest run\s+(.*)$/)
    if (!match) continue
    for (const token of match[1].split(/\s+/).filter(Boolean)) {
      if (token.startsWith('-')) continue
      tokens.add(token)
    }
  }
  return tokens
}

/** W2: pins the authority — web-tests.yml (required, unfiltered) actually executes W1's script. */
function webTestsYmlInvokesRequiredWebGate(src: string): boolean {
  return src
    .split('\n')
    .some((line) => !/^\s*#/.test(line) && line.includes('bash apps/web/scripts/run-required-web-tests.sh'))
}

/**
 * W4a/b: a flat `key: [ '...', '...' ]` array (playwright `testMatch`/`testIgnore` in this repo's
 * two verification configs are always single-level, never nested), stripped of a leading `**` + `/`
 * glob prefix so entries compare equal to bare basenames.
 */
function extractFlatStringArray(src: string, keyName: string): string[] {
  const re = new RegExp(`\\b${keyName}\\s*:\\s*\\[([^\\]]*)\\]`, 's')
  const match = re.exec(src)
  if (!match) return []
  return [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)]
    .map((entry) => entry[1] ?? entry[2])
    .map((value) => value.replace(/^\*\*\//, ''))
}

/** W4c/d: true iff `literal` appears as its OWN YAML sequence item line (never inside a comment). */
function yamlPathsListContainsLiteral(workflowSrc: string, literal: string): boolean {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*-\\s*['"]${escaped}['"]\\s*$`, 'm')
  return re.test(workflowSrc)
}

/** W7: splits a workflow's `jobs:` block into top-level (2-space-indented) job bodies. */
function splitYamlTopLevelJobs(workflowSrc: string): { name: string; body: string }[] {
  const lines = workflowSrc.split('\n')
  const jobsIdx = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  if (jobsIdx < 0) return []
  const jobs: { name: string; body: string }[] = []
  let current: { name: string; lines: string[] } | null = null
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (match) {
      if (current) jobs.push({ name: current.name, body: current.lines.join('\n') })
      current = { name: match[1], lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) jobs.push({ name: current.name, body: current.lines.join('\n') })
  return jobs
}

function hasNonCommentLineMatching(body: string, re: RegExp): boolean {
  return body.split('\n').some((line) => !/^\s*#/.test(line) && re.test(line))
}

/** W7 job-level env pins — DATABASE_URL / EXPECT_DB sit on the JOB, not any one step, in every lane. */
function jobHasDatabaseUrl(body: string): boolean {
  return hasNonCommentLineMatching(body, /^\s*DATABASE_URL:\s*\S/)
}
function jobHasExpectDb(body: string): boolean {
  return hasNonCommentLineMatching(body, /^\s*EXPECT_DB:\s*'1'/)
}

/** W7 whole-file vitest args, joint with a real `--config vitest.integration.config.ts` in the job. */
function jobWholeFileVitestArgs(body: string): string[] {
  if (!/--config\s+vitest\.integration\.config\.ts/.test(body)) return []
  const args: string[] = []
  for (const line of body.split('\n')) {
    if (/^\s*#/.test(line)) continue
    const match = line.match(/^\s+(tests\/integration\/\S+\.(?:test|spec)\.[tj]sx?)\s*(?:\\)?\s*$/)
    if (match) args.push(match[1])
  }
  return args
}

/** T3 suite-content probes (read the SUITE file itself, not any wiring text). */
function isDescribeIfDatabaseGated(content: string): boolean {
  return /\bdescribeIfDatabase\s*\(/.test(content)
}
function hasAntiSkipGreenSentinel(content: string): boolean {
  return /EXPECT_DB\s*===\s*'1'/.test(content) || /sentinel:[^\n]*DATABASE_URL/.test(content)
}

// =================================================================================================
// classify() — pure per-tier verdict functions. Kept free of I/O so Half A can drive them with
// synthetic fixtures directly (no real files, no real wiring text).
// =================================================================================================

interface Verdict {
  covered: boolean
  reason: string
}

function classifyT1(repoRelativePath: string, basename: string, w1Tokens: ReadonlySet<string>): Verdict {
  let executes = false
  let explicit = false
  for (const token of w1Tokens) {
    if (repoRelativePath.includes(token)) executes = true
    if (token === basename) explicit = true
  }
  if (!executes) {
    return {
      covered: false,
      reason: `no run-required-web-tests.sh token is a substring of "${repoRelativePath}" — this spec is collected by NO required lane`,
    }
  }
  if (!explicit) {
    return {
      covered: false,
      reason:
        'covered only incidentally by a substring token (no token exactly equals the basename) — '
        + 'a future rename/narrowing of that token would silently drop this spec; add an explicit basename token',
    }
  }
  return { covered: true, reason: 'explicit basename token present in run-required-web-tests.sh' }
}

function classifyT2(
  file: string,
  opts: {
    approvalTestMatch: ReadonlySet<string>
    multitableTestIgnore: ReadonlySet<string>
    approvalPathsHasFile: boolean
    multitablePathsHasVerificationGlob: boolean
  },
): Verdict {
  if (opts.approvalTestMatch.has(file)) {
    return opts.approvalPathsHasFile
      ? { covered: true, reason: 'testMatch-listed in playwright.approval-verification.config.ts and listed in approval-browser-verify.yml "paths"' }
      : {
          covered: false,
          reason:
            'testMatch-listed in the approval playwright lane, but NOT listed in approval-browser-verify.yml '
            + '"paths" — a change to only this file would never trigger the workflow that runs it',
        }
  }
  if (!opts.multitableTestIgnore.has(file)) {
    return opts.multitablePathsHasVerificationGlob
      ? {
          covered: true,
          reason:
            'matched by the WILDCARD testMatch of playwright.verification.config.ts (not testIgnore-listed) '
            + 'and multitable-browser-verify.yml "paths" includes apps/web/verification/**',
        }
      : {
          covered: false,
          reason: 'would be matched by the multitable playwright wildcard, but multitable-browser-verify.yml no longer triggers on apps/web/verification/**',
        }
  }
  return {
    covered: false,
    reason: 'testIgnore-listed in the multitable playwright lane and NOT testMatch-listed in the approval lane — wired nowhere',
  }
}

function classifyT3(opts: {
  excluded: boolean
  inW6: boolean
  inW7: boolean
  describeIfDatabaseGated: boolean
  hasAntiSkipGreenSentinel: boolean
}): Verdict {
  const { excluded, inW6, inW7, describeIfDatabaseGated, hasAntiSkipGreenSentinel: hasSentinel } = opts
  const w7Only = inW7 && !inW6
  if (excluded && !inW6 && !inW7) {
    return {
      covered: false,
      reason:
        'excluded from the no-DB job (vitest.config.ts test.exclude) but NOT wired as a whole-file arg into '
        + 'plugin-tests.yml\'s approval real-DB step or any approval-realdb-*.yml EXPECT_DB lane — this suite runs NOWHERE',
    }
  }
  if (!excluded && describeIfDatabaseGated && !inW6 && !inW7) {
    return {
      covered: false,
      reason:
        'NOT excluded from the no-DB job, but describeIfDatabase-gated with no real-DB lane wiring — it will '
        + 'skip-green forever in the required test job and never run for real',
    }
  }
  if (w7Only && !hasSentinel) {
    return {
      covered: false,
      reason:
        'wired only into an EXPECT_DB real-DB lane (approval-realdb-*.yml), but the suite carries no anti-skip-green '
        + 'sentinel (an EXPECT_DB===\'1\'-gated test, or a "sentinel: ... DATABASE_URL" test) — a broken/missing '
        + 'DATABASE_URL in that lane could skip-green silently',
    }
  }
  return {
    covered: true,
    reason: excluded
      ? 'excluded from the no-DB job and wired as a whole file into a real-DB lane'
      : 'not excluded — runs in the required no-DB job by default Vitest collection',
  }
}

function classifyT4(excluded: boolean): Verdict {
  return excluded
    ? { covered: false, reason: 'present in vitest.config.ts test.exclude — removed from the required no-DB job with no compensating lane (unit tests have none)' }
    : { covered: true, reason: 'not excluded — runs in the required no-DB job by default Vitest collection' }
}

// =================================================================================================
// Wiring bundle — every text this guard reads, loaded once.
// =================================================================================================

const w1Tokens = extractVitestTokensFromBashScript(read('apps/web/scripts/run-required-web-tests.sh'))
const w2Wired = webTestsYmlInvokesRequiredWebGate(read('.github/workflows/web-tests.yml'))

const w4ApprovalTestMatch = new Set(extractFlatStringArray(read('apps/web/playwright.approval-verification.config.ts'), 'testMatch'))
const w4MultitableTestIgnore = new Set(extractFlatStringArray(read('apps/web/playwright.verification.config.ts'), 'testIgnore'))
const w4ApprovalBrowserVerifySrc = read('.github/workflows/approval-browser-verify.yml')
const w4MultitableBrowserVerifySrc = read('.github/workflows/multitable-browser-verify.yml')

const vitestConfigSrc = read('packages/core-backend/vitest.config.ts')
const w5ExcludeArrayBody = extractTestExcludeArrayBody(vitestConfigSrc)
const w5ExcludeEntries: Set<string> = new Set(w5ExcludeArrayBody ? quotedExcludeEntries(w5ExcludeArrayBody) : [])

const pluginTestsSrc = read('.github/workflows/plugin-tests.yml')
// W6 evidence is the UNION of BOTH plugin-tests.yml real-DB steps, not just the "approval" one: a
// primary-source read found ~10 approval-named suites (e.g. approval-attachment-gc-realdb,
// approval-route-preview-api, approval-record-projection) actually run inside the SIBLING
// "Run multitable real-DB integration" step (T3-6 approval<->multitable projection goldens etc.),
// never the approval-named step. Checking only REAL_DB_STEP_IDS.approval undercounted real coverage
// and produced false UNCOVERED verdicts for those files — caught by running this guard once and
// reading its own failures against `git grep`, not by trusting the design spec's step-name prose.
const w6ApprovalStep = requireExecutableRealDbStep(pluginTestsSrc, REAL_DB_STEP_IDS.approval)
const w6MultitableStep = requireExecutableRealDbStep(pluginTestsSrc, REAL_DB_STEP_IDS.multitable)
const w6WholeFileArgs: Set<string> = new Set([
  ...(wholeFileVitestArgs(w6ApprovalStep) as string[]),
  ...(wholeFileVitestArgs(w6MultitableStep) as string[]),
])

const w7WorkflowFileNames = readdirSync(join(repoRoot, '.github/workflows'))
  .filter((name) => /^approval-realdb-.*\.yml$/.test(name))
  .concat('approval-template-policy-carrier-realdb.yml')
  .sort()

interface W7JobRecord {
  workflow: string
  job: string
  hasDatabaseUrl: boolean
  hasExpectDb: boolean
  wholeFileArgs: string[]
}

const w7Jobs: W7JobRecord[] = []
for (const workflowFile of w7WorkflowFileNames) {
  const src = read(`.github/workflows/${workflowFile}`)
  for (const job of splitYamlTopLevelJobs(src)) {
    w7Jobs.push({
      workflow: workflowFile,
      job: job.name,
      hasDatabaseUrl: jobHasDatabaseUrl(job.body),
      hasExpectDb: jobHasExpectDb(job.body),
      wholeFileArgs: jobWholeFileVitestArgs(job.body),
    })
  }
}
// "Covered" (the file genuinely runs against real Postgres) requires only DATABASE_URL + a real
// --config vitest.integration.config.ts invocation (the latter is already joint-required inside
// jobWholeFileVitestArgs). EXPECT_DB is NOT required here: two real jobs (approval-realdb-k4 /
// -k5b) deliberately omit it — DATABASE_URL is unconditionally hardcoded in their job env, so
// there is no environment ambiguity for EXPECT_DB to guard against, and their suites instead carry
// the OTHER anti-skip-green form ("sentinel: ... DATABASE_URL", inside describeIfDatabase). Gating
// inclusion in w7CoveredFiles on hasExpectDb would falsely red those two files as "runs NOWHERE"
// even though they demonstrably execute in CI — verified by running this guard once and finding
// exactly that false verdict before this fix. The EXPECT_DB-specific sentinel-pair concern is
// handled separately, per-suite, by hasAntiSkipGreenSentinel below (which accepts EITHER form).
const w7CoveredFiles = new Set<string>()
for (const job of w7Jobs) {
  if (job.hasDatabaseUrl) {
    for (const file of job.wholeFileArgs) w7CoveredFiles.add(file)
  }
}

// =================================================================================================
// Allowlist lookup + coverage assertion.
// =================================================================================================

function allowlistEntryFor(repoPath: string) {
  return APPROVAL_CI_COVERAGE_ALLOWLIST.find((entry) => entry.file === repoPath)
}

function assertCoverage(repoPath: string, verdict: Verdict): void {
  const entry = allowlistEntryFor(repoPath)
  if (verdict.covered) {
    if (entry) {
      // eslint-disable-next-line no-console
      console.warn(
        `approval-ci-coverage-enumeration: allowlist entry for "${repoPath}" is no longer needed `
        + `(the file is now covered) — consider removing it. Recorded why: "${entry.why}"`,
      )
    }
    return
  }
  if (entry) return // deliberately exempted
  throw new Error(`${repoPath}: UNCOVERED — ${verdict.reason}`)
}

// =================================================================================================
// §2 T1 — apps/web/tests/approval*.{test,spec}.ts (FE unit/spec)
// =================================================================================================

describe('T1 — apps/web/tests/approval*.{test,spec}.ts (FE unit/spec)', () => {
  const files = readdirSync(join(repoRoot, 'apps/web/tests')).filter((name) => /^approval.*\.(test|spec)\.ts$/.test(name))

  it('tier glob returns a non-zero file count (scan negative control)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`is wired: apps/web/tests/${file}`, () => {
      const repoPath = `apps/web/tests/${file}`
      const basename = file.replace(/\.(test|spec)\.ts$/, '')
      const verdict = classifyT1(`tests/${file}`, basename, w1Tokens)
      assertCoverage(repoPath, verdict)
    })
  }
})

// =================================================================================================
// §2 T2 — apps/web/verification/approval-*.spec.ts (FE browser / Playwright)
// =================================================================================================

describe('T2 — apps/web/verification/approval-*.spec.ts (FE browser)', () => {
  const files = readdirSync(join(repoRoot, 'apps/web/verification')).filter((name) => /^approval-.*\.spec\.ts$/.test(name))

  it('tier glob returns a non-zero file count (scan negative control)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`is wired: apps/web/verification/${file}`, () => {
      const repoPath = `apps/web/verification/${file}`
      const verdict = classifyT2(file, {
        approvalTestMatch: w4ApprovalTestMatch,
        multitableTestIgnore: w4MultitableTestIgnore,
        approvalPathsHasFile: yamlPathsListContainsLiteral(w4ApprovalBrowserVerifySrc, repoPath),
        multitablePathsHasVerificationGlob: yamlPathsListContainsLiteral(w4MultitableBrowserVerifySrc, 'apps/web/verification/**'),
      })
      assertCoverage(repoPath, verdict)
    })
  }
})

// =================================================================================================
// §2 T3 — packages/core-backend/tests/integration/approval-*.{test,spec}.ts (backend integration)
// =================================================================================================

describe('T3 — packages/core-backend/tests/integration/approval-*.{test,spec}.ts (backend integration)', () => {
  const files = readdirSync(join(repoRoot, 'packages/core-backend/tests/integration')).filter((name) => /^approval-.*\.(test|spec)\.ts$/.test(name))

  it('tier glob returns a non-zero file count (scan negative control)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`is wired: packages/core-backend/tests/integration/${file}`, () => {
      const repoPath = `packages/core-backend/tests/integration/${file}`
      const w5Key = `tests/integration/${file}`
      const content = read(repoPath)
      const verdict = classifyT3({
        excluded: w5ExcludeEntries.has(w5Key),
        inW6: w6WholeFileArgs.has(w5Key),
        inW7: w7CoveredFiles.has(w5Key),
        describeIfDatabaseGated: isDescribeIfDatabaseGated(content),
        hasAntiSkipGreenSentinel: hasAntiSkipGreenSentinel(content),
      })
      assertCoverage(repoPath, verdict)
    })
  }
})

// =================================================================================================
// §2 T4 — packages/core-backend/tests/unit/approval-*.{test,spec}.ts (backend unit)
// =================================================================================================

describe('T4 — packages/core-backend/tests/unit/approval-*.{test,spec}.ts (backend unit)', () => {
  // Excludes this guard's own file: its self-exemption is separately pinned below (§6), and
  // classifying itself here would be a trivially-true tautology (a guard is never excluded from
  // the very job that collects it), not a meaningful coverage proof.
  const files = readdirSync(join(repoRoot, 'packages/core-backend/tests/unit'))
    .filter((name) => /^approval-.*\.(test|spec)\.ts$/.test(name))
    .filter((name) => name !== 'approval-ci-coverage-enumeration.test.ts')

  it('tier glob returns a non-zero file count (scan negative control)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`is wired: packages/core-backend/tests/unit/${file}`, () => {
      const repoPath = `packages/core-backend/tests/unit/${file}`
      const w5Key = `tests/unit/${file}`
      const verdict = classifyT4(w5ExcludeEntries.has(w5Key))
      assertCoverage(repoPath, verdict)
    })
  }
})

// =================================================================================================
// §5 Allowlist integrity
// =================================================================================================

describe('allowlist integrity', () => {
  for (const entry of APPROVAL_CI_COVERAGE_ALLOWLIST) {
    it(`allowlist entry still points at a file that exists on disk: ${entry.file}`, () => {
      expect(existsSync(join(repoRoot, entry.file))).toBe(true)
    })
    it(`allowlist entry has a real "why" and a parseable "date": ${entry.file}`, () => {
      expect(entry.why.trim().length).toBeGreaterThan(10)
      expect(entry.why.trim().toLowerCase()).not.toBe('n/a')
      expect(/^\d{4}-\d{2}-\d{2}$/.test(entry.date)).toBe(true)
      expect(Number.isNaN(Date.parse(entry.date))).toBe(false)
    })
  }
})

// =================================================================================================
// §6 Self-exemption closure — pins that this guard's own home cannot be quietly removed.
// =================================================================================================

describe('self-exemption closure (§6) — this guard\'s own home cannot be silently removed', () => {
  it('the guard itself is absent from vitest.config.ts test.exclude (not self-excluded)', () => {
    expect(w5ExcludeEntries.has('tests/unit/approval-ci-coverage-enumeration.test.ts')).toBe(false)
  })

  it('packages/core-backend/package.json "scripts.test" is EXACTLY "vitest" (the default config, not narrowed to a subset that would drop this guard\'s home)', () => {
    const pkg = JSON.parse(read('packages/core-backend/package.json')) as { scripts?: Record<string, string> }
    expect(pkg.scripts?.test).toBe('vitest')
  })

  it('.github/workflows/web-tests.yml still executes run-required-web-tests.sh (the T1/T2 authority this guard relies on)', () => {
    expect(w2Wired).toBe(true)
  })
})

// =================================================================================================
// Half A — classifier + parser positive/negative controls (pure, no real files touched).
// =================================================================================================

describe('Half A — classify() positive/negative controls (synthetic fixtures)', () => {
  it('T1 UNCOVERED: no wiring token is a substring of the file', () => {
    const verdict = classifyT1(
      'tests/approval-totally-unwired-canary.spec.ts',
      'approval-totally-unwired-canary',
      new Set(['approval-center', 'approval-form-draft']),
    )
    expect(verdict.covered).toBe(false)
  })

  it('T1 UNCOVERED (comment-only decoy): a mention inside a `#` comment of the real script never reaches the parsed token set', () => {
    const script = [
      '#!/usr/bin/env bash',
      '# approval-comment-only-canary is mentioned here but never actually run',
      'npx vitest run approval-center --reporter=dot',
    ].join('\n')
    const tokens = extractVitestTokensFromBashScript(script)
    expect(tokens.has('approval-comment-only-canary')).toBe(false)
    const verdict = classifyT1('tests/approval-comment-only-canary.spec.ts', 'approval-comment-only-canary', tokens)
    expect(verdict.covered).toBe(false)
  })

  it('T1 COVERED: a genuinely wired explicit token (not vacuously red)', () => {
    const verdict = classifyT1('tests/approval-center.spec.ts', 'approval-center', new Set(['approval-center']))
    expect(verdict.covered).toBe(true)
  })

  it('T1 soft-fail collision proof: "approval-center" already substring-matches TWO real sibling files that genuinely run — an exact-basename-only check would falsely red them, so EXECUTES uses substring while EXPLICIT requires the exact token', () => {
    const substringOnly = classifyT1('tests/approval-center-master-detail.spec.ts', 'approval-center-master-detail', new Set(['approval-center']))
    expect(substringOnly.covered).toBe(false)
    expect(substringOnly.reason).toMatch(/incidentally/)
    const withExplicitToken = classifyT1(
      'tests/approval-center-master-detail.spec.ts',
      'approval-center-master-detail',
      new Set(['approval-center', 'approval-center-master-detail']),
    )
    expect(withExplicitToken.covered).toBe(true)
  })

  it('T3 UNCOVERED: excluded but wired nowhere (the exact pack1a shape, replayed synthetically)', () => {
    const verdict = classifyT3({ excluded: true, inW6: false, inW7: false, describeIfDatabaseGated: true, hasAntiSkipGreenSentinel: false })
    expect(verdict.covered).toBe(false)
  })

  it('T3 COVERED: excluded and wired into W6', () => {
    const verdict = classifyT3({ excluded: true, inW6: true, inW7: false, describeIfDatabaseGated: true, hasAntiSkipGreenSentinel: false })
    expect(verdict.covered).toBe(true)
  })

  it('T3 UNCOVERED: not excluded, describeIfDatabase-gated, no real-DB lane (skip-green risk)', () => {
    const verdict = classifyT3({ excluded: false, inW6: false, inW7: false, describeIfDatabaseGated: true, hasAntiSkipGreenSentinel: false })
    expect(verdict.covered).toBe(false)
  })

  it('T3 COVERED: not excluded, plain describe (runs for real — loudly, without a DB — which is a product concern, not a coverage-blindness one)', () => {
    const verdict = classifyT3({ excluded: false, inW6: false, inW7: false, describeIfDatabaseGated: false, hasAntiSkipGreenSentinel: false })
    expect(verdict.covered).toBe(true)
  })

  it('T3 UNCOVERED: W7-only with no anti-skip-green sentinel in the suite itself', () => {
    const verdict = classifyT3({ excluded: true, inW6: false, inW7: true, describeIfDatabaseGated: true, hasAntiSkipGreenSentinel: false })
    expect(verdict.covered).toBe(false)
  })

  it('T3 COVERED: W7-only WITH an anti-skip-green sentinel in the suite itself', () => {
    const verdict = classifyT3({ excluded: true, inW6: false, inW7: true, describeIfDatabaseGated: true, hasAntiSkipGreenSentinel: true })
    expect(verdict.covered).toBe(true)
  })

  it('T4 UNCOVERED: excluded unit test has no compensating lane', () => {
    expect(classifyT4(true).covered).toBe(false)
  })

  it('T4 COVERED: not excluded', () => {
    expect(classifyT4(false).covered).toBe(true)
  })
})

describe('Half A — parser decoy rejection', () => {
  it('W1 bash tokenizer handles exec-prefixed AND multi-line backslash-continued invocations (the two forms the scout-time parse missed)', () => {
    const script = [
      '#!/usr/bin/env bash',
      'npx vitest run \\',
      '  approval-multiline-token-a \\',
      '  approval-multiline-token-b --reporter=dot',
      'exec npx vitest run approval-exec-token --reporter=dot',
    ].join('\n')
    const tokens = extractVitestTokensFromBashScript(script)
    expect(tokens.has('approval-multiline-token-a')).toBe(true)
    expect(tokens.has('approval-multiline-token-b')).toBe(true)
    expect(tokens.has('approval-exec-token')).toBe(true)
    expect(tokens.has('--reporter=dot')).toBe(false) // flags are never tokens
  })

  it('W7 job parser: a file mentioned only in a `#` comment inside a job body is not reported as a whole-file arg (comment-only decoy)', () => {
    const workflow = [
      'jobs:',
      '  decoy-job:',
      '    env:',
      '      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/db',
      "      EXPECT_DB: '1'",
      '    steps:',
      '      - name: run',
      '        run: >-',
      '          pnpm exec vitest',
      '          --config vitest.integration.config.ts run',
      '          # tests/integration/approval-decoy.test.ts',
      '          tests/integration/approval-real.test.ts',
      '          --reporter=verbose',
    ].join('\n')
    const jobs = splitYamlTopLevelJobs(workflow)
    expect(jobs).toHaveLength(1)
    const args = jobWholeFileVitestArgs(jobs[0].body)
    expect(args).toContain('tests/integration/approval-real.test.ts')
    expect(args).not.toContain('tests/integration/approval-decoy.test.ts')
  })

  it('W7 job parser: a job missing EXPECT_DB is correctly detected as NOT sentinel-armed (wrong-job decoy)', () => {
    const workflow = [
      'jobs:',
      '  no-expect-db-job:',
      '    env:',
      '      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/db',
      '    steps:',
      '      - name: run',
      '        run: >-',
      '          pnpm exec vitest',
      '          --config vitest.integration.config.ts run',
      '          tests/integration/approval-real.test.ts',
    ].join('\n')
    const jobs = splitYamlTopLevelJobs(workflow)
    expect(jobHasDatabaseUrl(jobs[0].body)).toBe(true)
    expect(jobHasExpectDb(jobs[0].body)).toBe(false)
  })

  it('W7 job parser: whole-file args require a REAL --config vitest.integration.config.ts in the SAME job (a file named with no integration config nearby is not reported)', () => {
    const workflow = [
      'jobs:',
      '  default-config-job:',
      '    env:',
      '      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/db',
      "      EXPECT_DB: '1'",
      '    steps:',
      '      - name: run',
      '        run: |',
      '          pnpm exec vitest run',
      '          tests/integration/approval-real.test.ts',
    ].join('\n')
    const jobs = splitYamlTopLevelJobs(workflow)
    expect(jobWholeFileVitestArgs(jobs[0].body)).toEqual([])
  })
})

describe('hasAntiSkipGreenSentinel — disjunction discipline (each arm independently load-bearing)', () => {
  it('EXPECT_DB arm alone is sufficient', () => {
    expect(hasAntiSkipGreenSentinel("const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip")).toBe(true)
  })

  it('"sentinel: ... DATABASE_URL" arm alone is sufficient (the approval-dept-head-chain / approval-dept-head-at-level shape, which carries NO EXPECT_DB text at all)', () => {
    expect(hasAntiSkipGreenSentinel("it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {})")).toBe(true)
  })

  it('neither arm present -> false (not vacuously true)', () => {
    expect(hasAntiSkipGreenSentinel('describeIfDatabase("x", () => { it("y", () => {}) })')).toBe(false)
  })

  it('REAL FILE, single-arm witness: approval-dept-head-chain.db.test.ts has NO "EXPECT_DB" text anywhere, so it can ONLY be caught by the "sentinel: ... DATABASE_URL" arm — deleting that arm from the detector would red this exact real file', () => {
    const content = read('packages/core-backend/tests/integration/approval-dept-head-chain.db.test.ts')
    expect(content.includes('EXPECT_DB')).toBe(false) // sanity: proves this file is a genuine single-arm witness
    expect(hasAntiSkipGreenSentinel(content)).toBe(true)
  })

  it('REAL FILE, single-arm witness: approval-dept-head-at-level.db.test.ts is the same shape', () => {
    const content = read('packages/core-backend/tests/integration/approval-dept-head-at-level.db.test.ts')
    expect(content.includes('EXPECT_DB')).toBe(false)
    expect(hasAntiSkipGreenSentinel(content)).toBe(true)
  })
})
