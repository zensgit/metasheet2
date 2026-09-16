import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * FAIL-0 wiring guard for the P5 transport-copy specs (2026-09-14 field incident).
 *
 * WHY IT EXISTS. `apps/web/tests/*.spec.ts` is collected by NO workflow's default glob. The
 * required `web-tests` context runs `apps/web/scripts/run-required-web-tests.sh`, which passes an
 * explicit, HAND-KEPT list of vitest positional filters; a spec nobody remembers to tokenize there
 * runs nowhere, is green on a laptop, and is indistinguishable from a passing gate. That is not
 * hypothetical here: an adversarial pass over this very change found
 * `apps/web/tests/network-unavailable-copy.spec.ts` -- the ONLY spec covering the "a response
 * EXISTS" arm of the outage-copy discriminator -- selected by no token in any workflow or in that
 * script, so a mutation making `hasHttpResponse()` answer `false` for a real 503 (i.e. telling a
 * user "no response received" when the server plainly answered) was GREEN across every required
 * check. The same footgun is already recorded in that script's own comments for tests/api.spec.ts.
 *
 * WHAT THIS PROVES. Every apps/web spec that imports `src/utils/networkErrors` -- the module that
 * owns both outage sentences and the decision between them -- is selected by the required web lane.
 * The sweep is a live `readdirSync` + content read, not a snapshot, so a NEW transport-copy spec
 * that nobody tokenizes turns this RED on the commit that adds it, not at the next review.
 *
 * WHERE THIS LIVES, AND WHY (same reasoning as approval-ci-coverage-enumeration.test.ts and
 * stock-prep-web-ci-coverage-enumeration.test.ts, which this is modelled on):
 * `packages/core-backend/tests/unit/*.test.ts` is collected by Vitest's DEFAULT include glob
 * (vitest.config.ts declares no `include:` override), which runs via core-backend's
 * `"test": "vitest"` -- invoked by the un-`if:`-guarded "Run core-backend tests" step in
 * plugin-tests.yml's `test` job (matrix [18.x, 20.x]), i.e. BOTH required `test (18.x)` /
 * `test (20.x)` contexts. A new file here needs no workflow edit to be collected, which is exactly
 * what makes this home un-skippable -- and it is why the guard is NOT placed in apps/web/tests,
 * where it would itself need the hand-kept token it is meant to police.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const WEB_TESTS_DIR = join(REPO_ROOT, 'apps', 'web', 'tests')
const REQUIRED_WEB_TESTS_SCRIPT = join(REPO_ROOT, 'apps', 'web', 'scripts', 'run-required-web-tests.sh')
const WEB_TESTS_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'web-tests.yml')

/** The module whose importers must be CI-wired. */
const TRANSPORT_COPY_MODULE = 'utils/networkErrors'

/**
 * Specs deliberately NOT wired into the required lane. Each entry needs a reason. Empty is the
 * honest state today; a PR that adds an entry is making a claim a reviewer can weigh.
 */
const TRANSPORT_COPY_CI_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = Object.freeze([])

/**
 * Every positional filter the required lane actually passes to vitest.
 *
 * Faithful to how the script is really written: comment lines are stripped FIRST (this script
 * carries a great deal of prose that names files it does NOT run -- counting prose as enrolment is
 * the classic false green here), backslash continuations are then joined so the multi-line
 * invocations are read as one logical command, and only the arguments AFTER `vitest run` are taken.
 * Flags are dropped. Both `npx vitest run` and `exec npx vitest run` forms are covered, because the
 * split is on the literal `vitest run`.
 */
function requiredLaneTokens(script: string): string[] {
  const executable = script
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  const joined = executable.replace(/\\\r?\n/g, ' ')
  const tokens: string[] = []
  for (const line of joined.split('\n')) {
    const marker = line.indexOf('vitest run')
    if (marker === -1) continue
    for (const raw of line.slice(marker + 'vitest run'.length).split(/\s+/)) {
      const token = raw.trim()
      if (!token || token.startsWith('-')) continue
      // Short fragments cannot be meaningful filenames and would make the substring test below
      // vacuous; the negative control test pins that no such token exists today.
      if (token.length < 4) continue
      tokens.push(token)
    }
  }
  return tokens
}

/**
 * Vitest positional filters are SUBSTRING matches against the test file path, so membership must be
 * asked as that same substring relation -- not as equality against a token, which would miss a
 * legitimate shorter basename token covering a longer filename.
 */
function isSelectedByRequiredLane(tokens: readonly string[], repoRelativePath: string): boolean {
  return tokens.some((token) => repoRelativePath.includes(token))
}

/** Live sweep: apps/web specs that import the transport-copy module. */
function transportCopySpecFiles(): string[] {
  return readdirSync(WEB_TESTS_DIR)
    .filter((name) => name.endsWith('.spec.ts') || name.endsWith('.test.ts'))
    .filter((name) => readFileSync(join(WEB_TESTS_DIR, name), 'utf8').includes(TRANSPORT_COPY_MODULE))
    .sort()
}

describe('P5 transport-copy web specs are enrolled in a required CI lane', () => {
  const script = readFileSync(REQUIRED_WEB_TESTS_SCRIPT, 'utf8')
  const tokens = requiredLaneTokens(script)
  const specs = transportCopySpecFiles()
  const allowed = new Set(TRANSPORT_COPY_CI_ALLOWLIST.map((entry) => entry.file))

  it('the token extractor really parses the script (a parser that returns nothing proves nothing)', () => {
    expect(tokens.length).toBeGreaterThan(50)
    // Known-good anchors, one multi-line-continued and one single-line invocation, so a regression
    // in the continuation joining or in the comment stripping is caught here rather than showing up
    // as a confusing "everything is dark" failure below.
    expect(tokens).toContain('tests/api.spec.ts')
    expect(tokens).toContain('meta-api-error-labels')
  })

  it('NEGATIVE CONTROL: a filename nobody wired is reported as NOT selected', () => {
    // If any token were short or generic enough to match arbitrary paths, every assertion in this
    // file would pass vacuously. This is the check that forbids that.
    expect(isSelectedByRequiredLane(tokens, 'tests/zzz-not-a-real-spec-qxj.spec.ts')).toBe(false)
  })

  it('finds transport-copy web specs on disk at all (the sweep is live, not a snapshot)', () => {
    // A guard that silently enumerates nothing proves nothing. If this reads zero, the directory
    // moved or the module was renamed, and every assertion below became vacuous.
    expect(specs.length).toBeGreaterThanOrEqual(4)
  })

  it('every apps/web spec importing utils/networkErrors is selected by the required web lane', () => {
    const dark = specs.filter(
      (file) => !allowed.has(file) && !isSelectedByRequiredLane(tokens, `tests/${file}`),
    )
    expect(
      dark,
      'these transport-copy web specs run in NO required workflow — add a vitest filter token for '
      + 'each to apps/web/scripts/run-required-web-tests.sh (checking substring collisions in BOTH '
      + 'directions, as that file requires), or allowlist them here with a reason',
    ).toEqual([])
  })

  it('the spec carrying the "a response EXISTS" arm is enrolled BY NAME', () => {
    // Named literally, so that weakening or deleting the sweep above still leaves the one spec an
    // adversarial pass found dark pinned here. This is the blocker this file was written for.
    const file = 'network-unavailable-copy.spec.ts'
    expect(specs, `${file} must exist and must import ${TRANSPORT_COPY_MODULE}`).toContain(file)
    expect(
      isSelectedByRequiredLane(tokens, `tests/${file}`),
      `${file} must run in the required web lane`,
    ).toBe(true)
  })

  it('the allowlist names only files that exist, so it cannot rot into a blanket exemption', () => {
    const onDisk = new Set(specs)
    const stale = TRANSPORT_COPY_CI_ALLOWLIST.filter((entry) => !onDisk.has(entry.file))
    expect(stale, 'allowlist entries for files that no longer exist must be deleted').toEqual([])
  })

  it('web-tests.yml still executes run-required-web-tests.sh, unconditionally (the authority this guard leans on)', () => {
    const workflow = readFileSync(WEB_TESTS_WORKFLOW, 'utf8')
    const executes = workflow
      .split('\n')
      .some((line) => !line.trim().startsWith('#') && line.includes('bash apps/web/scripts/run-required-web-tests.sh'))
    expect(executes, 'web-tests.yml must run the required web lane script').toBe(true)
    // A `paths:` filter would turn this required context into the path-filtered-required footgun
    // that workflow's own header warns about, and would silently un-gate every spec above.
    const triggerBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\njobs:'))
    expect(triggerBlock).not.toContain('paths:')
  })
})
