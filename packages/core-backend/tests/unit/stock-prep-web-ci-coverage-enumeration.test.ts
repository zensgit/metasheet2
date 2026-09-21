import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * FAIL-0 mechanical enumeration guard for the stock-preparation WEB specs.
 *
 * WHY IT EXISTS. `apps/web/tests/*.spec.ts` is NOT collected by any workflow's default glob: the
 * required `web-tests` context runs `apps/web/scripts/run-required-web-tests.sh`, which passes an
 * explicit, HAND-KEPT list of vitest positional filters. A spec that nobody remembers to tokenize
 * there therefore runs nowhere — it is green on a developer's laptop, absent from CI, and
 * indistinguishable from a passing gate.
 *
 * That is not hypothetical. An adversarial pass over #5460 found THREE brand-new board specs
 * (StockPreparationProjectBoard / ProjectSync / ProjectSyncPanel) running in no workflow at all —
 * every web-side witness in that PR was dark — and, once the sweep below was written, FOUR MORE
 * stock-prep specs that had been dark since the day they landed (LargeBomPull, LargeBomPullPanel,
 * OperatorProjectDirectory, SourceBinding). A hand-kept list cannot be trusted to notice its own
 * omissions; only an enumeration off the filesystem can.
 *
 * WHAT THIS PROVES: every `apps/web/tests/StockPreparation*.spec.ts` file ON DISK is tokenized in
 * the required web lane. The sweep is a live `readdirSync`, not a snapshot, so a newly added
 * stock-prep spec turns this RED by construction — the failure arrives with the spec, not with the
 * next adversarial review.
 *
 * WHERE THIS LIVES, AND WHY (same reasoning as approval-ci-coverage-enumeration.test.ts, which this
 * is modelled on): `packages/core-backend/tests/unit/*.test.ts` is collected by Vitest's DEFAULT
 * include glob, which runs via core-backend's `"test": "vitest"` — invoked by the un-`if:`-guarded
 * "Run core-backend tests" step in plugin-tests.yml's `test` job (matrix [18.x, 20.x]), i.e. BOTH
 * required `test (18.x)` / `test (20.x)` contexts. A new file here needs no workflow edit to be
 * collected, which is exactly what makes this home un-skippable.
 *
 * THE ALLOWLIST IS EMPTY, DELIBERATELY. Every stock-prep spec on disk is wired. An entry added here
 * must carry a reason in its comment; an empty list is the honest state and the one worth defending.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const WEB_TESTS_DIR = join(REPO_ROOT, 'apps', 'web', 'tests')
const REQUIRED_WEB_TESTS_SCRIPT = join(REPO_ROOT, 'apps', 'web', 'scripts', 'run-required-web-tests.sh')

/**
 * Specs deliberately NOT wired into the required lane. Each entry needs a reason. Empty is correct
 * today and a PR that adds an entry is making a claim a reviewer can weigh.
 */
const STOCK_PREP_WEB_CI_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = Object.freeze([])

function stockPrepSpecFiles(): string[] {
  return readdirSync(WEB_TESTS_DIR)
    .filter((name) => name.startsWith('StockPreparation') && name.endsWith('.spec.ts'))
    .sort()
}

/**
 * Does the runner script actually SELECT this file?
 *
 * Vitest positional filters are SUBSTRING matches against the test file path, so the check must be
 * the same substring relation the runner will perform at run time — not an equality test against a
 * token, which would miss `StockPreparationProjectSync` legitimately covering
 * `StockPreparationProjectSyncPanel.spec.ts`. Comment lines are stripped first: a filename that
 * appears only inside the script's prose (and this script has a lot of prose, naming files it does
 * NOT run) must not count as enrolment.
 */
function isSelectedByRequiredLane(script: string, fileName: string): boolean {
  return requiredLaneTokens(script).some((token) => fileName.includes(token))
}

/**
 * Tokens the required lane actually passes to vitest.
 *
 * Q8 (2026-09-21): the lane's final `exec npx vitest run …` used to be one 11410-byte physical
 * line and is now one token per line, backslash-continued and alphabetised (that rewrite exists to
 * stop n concurrent spec-adding branches conflicting pairwise on a single line). The contract for
 * every reader of this script is therefore: strip whole-line `#` comments, JOIN continuations into
 * logical lines, and only then tokenize — never `line.startsWith('exec npx vitest run ')`, which
 * now sees a header whose sole "token" is the continuation backslash.
 *
 * Before this change the function below happened to survive the rewrite by accident, because it
 * whitespace-split the entire uncommented body and kept only `StockPreparation*` fragments — a
 * lone `\` is simply filtered out. That is luck, not a contract: the moment a caller wants the
 * flags, the invocation boundary, or a token family whose names could collide with a continuation
 * artifact, the accidental version is wrong. It is written explicitly here so the next reader
 * copies the right shape. Comment stripping stays load-bearing: this script carries a great deal
 * of prose naming files it does NOT run.
 */
function requiredLaneTokens(script: string): string[] {
  const kept = script
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => !/^\s*#/.test(line))

  const logical: string[] = []
  let buf: string | null = null
  for (const raw of kept) {
    const trimmedRight = raw.replace(/\s+$/, '')
    const continued = trimmedRight.endsWith('\\')
    const body = continued ? trimmedRight.slice(0, -1).trim() : trimmedRight.trim()
    buf = buf === null ? body : `${buf} ${body}`.trim()
    if (!continued) {
      logical.push(buf)
      buf = null
    }
  }
  if (buf !== null) logical.push(buf)

  const tokens: string[] = []
  for (const line of logical) {
    const marker = line.indexOf('vitest run')
    if (marker === -1) continue
    for (const raw of line.slice(marker + 'vitest run'.length).split(/\s+/)) {
      const token = raw.trim()
      if (!token || token.startsWith('-')) continue
      tokens.push(token)
    }
  }
  return tokens.filter((token) => token.startsWith('StockPreparation'))
}

describe('stock-preparation web specs are enrolled in a required CI lane', () => {
  const script = readFileSync(REQUIRED_WEB_TESTS_SCRIPT, 'utf8')
  const specs = stockPrepSpecFiles()
  const allowed = new Set(STOCK_PREP_WEB_CI_ALLOWLIST.map((entry) => entry.file))

  it('finds stock-prep web specs on disk at all (the sweep is live, not a snapshot)', () => {
    // A guard that silently enumerates nothing proves nothing. If this ever reads zero, the
    // directory moved and every assertion below became vacuous.
    expect(specs.length).toBeGreaterThan(10)
  })

  it('every StockPreparation*.spec.ts is selected by the required web lane', () => {
    const dark = specs.filter((file) => !allowed.has(file) && !isSelectedByRequiredLane(script, file))
    expect(
      dark,
      'these stock-prep web specs run in NO required workflow — add a vitest filter token for each '
      + 'to apps/web/scripts/run-required-web-tests.sh (checking substring collisions in BOTH '
      + 'directions, as that file requires), or allowlist them here with a reason',
    ).toEqual([])
  })

  it('the allowlist names only files that exist, so it cannot rot into a blanket exemption', () => {
    const onDisk = new Set(specs)
    const stale = STOCK_PREP_WEB_CI_ALLOWLIST.filter((entry) => !onDisk.has(entry.file))
    expect(stale, 'allowlist entries for files that no longer exist must be deleted').toEqual([])
  })

  it('the board specs this guard was written for are individually enrolled', () => {
    // Named literally, so that deleting the sweep above without noticing still leaves the three
    // specs an adversarial pass found dark pinned by name.
    for (const file of [
      'StockPreparationProjectBoard.spec.ts',
      'StockPreparationProjectSync.spec.ts',
      'StockPreparationProjectSyncPanel.spec.ts',
    ]) {
      expect(specs, `${file} must exist`).toContain(file)
      expect(isSelectedByRequiredLane(script, file), `${file} must run in the required web lane`).toBe(true)
    }
  })

  it('reads the multi-line registration block, and still refuses tokens that live only in prose', () => {
    // Q8 decoy: pins the two properties the parser rewrite has to hold at once. A physical-line
    // reader would see the header's lone continuation backslash and enrol nothing; a reader that
    // forgot to strip comments would enrol a file the lane demonstrably does not run.
    const fixture = [
      '#!/usr/bin/env bash',
      '# StockPreparationCommentOnlyDecoy is named here in prose but is NOT run.',
      'exec npx vitest run \\',
      '  StockPreparationFromAContinuedLine \\',
      '  --reporter=dot',
    ].join('\n')
    expect(isSelectedByRequiredLane(fixture, 'StockPreparationFromAContinuedLine.spec.ts')).toBe(true)
    expect(isSelectedByRequiredLane(fixture, 'StockPreparationCommentOnlyDecoy.spec.ts')).toBe(false)

    // And against the real file: the block is genuinely multi-line, so the physical-line form the
    // repo used before this change would now read zero stock-prep tokens.
    const physical = script.split('\n').find((line) => line.startsWith('exec npx vitest run '))
    expect(physical, 'the lane still has an exec header').toBeTruthy()
    expect(
      (physical as string).split(/\s+/).filter((token) => token.startsWith('StockPreparation')),
      'a physical-line parse of the new shape yields nothing — this is why the parser was rewritten',
    ).toEqual([])
  })
})
