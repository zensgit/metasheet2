/**
 * Q8 / C4 P1 (2026-09-21) — structural guard for the required web lane's registration block.
 *
 * WHY THIS EXISTS
 * ---------------
 * `apps/web/scripts/run-required-web-tests.sh` ends in the token filter the required `web-tests`
 * context actually runs. Until this change that filter was ONE 11410-byte physical line carrying
 * 397 tokens, and it was the single most contended line in the repo: 76 commits touched it between
 * 2026-09-01 and 2026-09-20, and because every spec-adding branch appends to the same physical
 * line, n concurrent lanes conflict pairwise — O(n²) three-way merges on one line.
 *
 * The fix is the same prescription #5420 applied to the plugin side (package.json `scripts.test`
 * -> `test-chain.txt` + `merge=union`): break the list into ONE TOKEN PER LINE, backslash
 * continued, sorted case-insensitively. Two lanes adding unrelated tokens then touch different
 * physical lines and merge cleanly without any merge driver at all.
 *
 * The alphabetical order is load-bearing, not cosmetic. If new tokens may land anywhere, everyone
 * appends to the tail and the tail becomes the new contended line — the multi-line rewrite would
 * buy nothing. Sorting makes "which line does my token go on" a pure function of its name, so two
 * lanes collide only when their two new token names are alphabetically adjacent. That is why
 * `is sorted` below is an assertion and not a lint preference.
 *
 * `.gitattributes` additionally marks the file `merge=union`. That is a LOCAL rebase/merge
 * fallback only: whether GitHub's server-side merge honours a repository merge driver is NOT
 * something this repo has demonstrated, so it is not claimed here. Union's failure modes are
 * exactly what the four assertions below catch:
 *   - union duplicates a token (both sides added the same one)          -> `no duplicate tokens`
 *   - union interleaves additions out of order                          -> `is sorted`
 *   - union turns a NON-list line both sides edited into two lines      -> `bash -n` + `exactly
 *     one exec logical line` (a duplicated `exec npx vitest run \` header, a duplicated
 *     `--reporter=dot` terminator, or a dangling continuation all red one of the two)
 *
 * PARSING CONTRACT
 * ----------------
 * Every guard that reads this script must: strip whole-line `#` comments, JOIN backslash
 * continuations into logical lines, and only then look for the exec invocation. A physical-line
 * `line.startsWith('exec npx vitest run ')` parse now sees a header whose only "token" is the
 * continuation backslash. This file states that contract and the three guards that used the
 * physical-line form were converted in the same commit:
 *   - packages/core-backend/tests/unit/stock-prep-web-ci-coverage-enumeration.test.ts
 *   - plugins/plugin-integration-core/__tests__/stock-preparation-handoff.test.cjs (G2)
 *   - apps/web/tests/attendance-web-guard-workflow.spec.ts
 * Three other parsers already joined continuations and needed no change (verified, not assumed):
 * approval-ci-coverage-enumeration.test.ts:118-131, network-unavailable-copy-ci-wiring.test.ts:63-66,
 * scripts/ops/elearning-media-ci-wiring.test.mjs:253-268, apps/web/tests/AttendanceReportFieldsSection.spec.ts:137.
 *
 * Values-free: this file reads only repo-tracked script text and asserts on token names.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
const REQUIRED_LANE = join(REPO_ROOT, 'apps', 'web', 'scripts', 'run-required-web-tests.sh')
const SECOND_REGISTRATION_POINT = join(REPO_ROOT, 'scripts', 'ops', 'integration-guard-run-web-specs.sh')
const GITATTRIBUTES = join(REPO_ROOT, '.gitattributes')

/**
 * Strip whole-line `#` comments, then fold backslash continuations into logical lines.
 *
 * Only a line whose LAST non-whitespace character is `\` continues. The backslash is dropped and
 * a single space joins the pieces, which is exactly how bash hands the argv to vitest.
 */
export function logicalLines(scriptSrc: string): string[] {
  const kept = scriptSrc
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => !/^\s*#/.test(line))

  const out: string[] = []
  let buf: string | null = null
  for (const raw of kept) {
    const trimmedRight = raw.replace(/\s+$/, '')
    const continued = trimmedRight.endsWith('\\')
    const body = continued ? trimmedRight.slice(0, -1).trim() : trimmedRight.trim()
    buf = buf === null ? body : `${buf} ${body}`.trim()
    if (!continued) {
      out.push(buf)
      buf = null
    }
  }
  // A trailing continuation with nothing after it: keep what we have so the caller can still see
  // (and fail on) the malformed invocation rather than silently losing it.
  if (buf !== null) out.push(buf)
  return out
}

/** The one logical line that `exec`s vitest. Throws if there is not exactly one. */
export function execLogicalLine(scriptSrc: string): string {
  const matches = logicalLines(scriptSrc).filter((line) => /^exec\s+npx\s+vitest\s+run\b/.test(line))
  if (matches.length !== 1) {
    throw new Error(`expected exactly 1 exec logical line, found ${matches.length}`)
  }
  return matches[0]
}

/** Positional filter tokens (flags dropped) of a `… vitest run …` logical line. */
export function tokensOf(logicalLine: string): string[] {
  const after = logicalLine.replace(/^.*?\bvitest\s+run\b\s*/, '')
  return after.split(/\s+/).filter((token) => token.length > 0 && !token.startsWith('-'))
}

/** Trailing flags of a `… vitest run …` logical line, in order. */
function flagsOf(logicalLine: string): string[] {
  const after = logicalLine.replace(/^.*?\bvitest\s+run\b\s*/, '')
  return after.split(/\s+/).filter((token) => token.startsWith('-'))
}

/**
 * Resolve a runnable `bash`.
 *
 * CI (`ubuntu-latest`) always has one on PATH. A Windows dev checkout often does NOT — vitest
 * inherits the PowerShell PATH, where Git-for-Windows' bash is not registered even though the same
 * machine runs bash fine from a Git Bash shell (measured 2026-09-21: `spawnSync('bash')` from a
 * vitest worker launched by PowerShell throws ENOENT while `bash -n` from Git Bash exits 0). So
 * probe PATH first, then the two standard Git-for-Windows locations.
 *
 * Returns null when none is runnable. The caller then FAILS on CI — where bash is guaranteed and a
 * missing one means something is genuinely wrong — and SKIPS locally, rather than painting every
 * Windows checkout red over a shell that is not the thing under test. CI is the judge here.
 */
function resolveBash(): string | null {
  const candidates = [
    'bash',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
  ]
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'exit 0'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0) return candidate
  }
  return null
}

const BASH = resolveBash()

const caseInsensitive = (a: string, b: string): number => {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

describe('required web lane registration block — structural shape', () => {
  const script = readFileSync(REQUIRED_LANE, 'utf8')

  it('passes `bash -n` (union or a bad rebase cannot leave the script unparseable)', (ctx) => {
    if (!BASH) {
      expect(process.env.CI, 'CI must always have a runnable bash — a missing one there is a real failure').toBeFalsy()
      ctx.skip()
      return
    }
    const result = spawnSync(BASH, ['-n', REQUIRED_LANE], { encoding: 'utf8' })
    expect(result.error, `could not spawn bash: ${result.error?.message ?? ''}`).toBeUndefined()
    expect(`${result.status} ${result.stderr ?? ''}`.trim()).toBe('0')
  })

  it('has exactly one `exec npx vitest run` LOGICAL line (bash only ever reaches the first exec)', () => {
    const matches = logicalLines(script).filter((line) => /^exec\s+npx\s+vitest\s+run\b/.test(line))
    expect(
      matches.length,
      'a second exec invocation is dead code — bash replaces the process at the first one, so every '
      + 'token registered on a later copy runs in no CI job at all',
    ).toBe(1)
  })

  it('is written one token per physical line, continued with a trailing backslash', () => {
    const lines = script.split('\n').map((line) => line.replace(/\r$/, ''))
    const header = lines.findIndex((line) => line === 'exec npx vitest run \\')
    expect(header, 'the exec block must open with the bare `exec npx vitest run \\` header').toBeGreaterThan(-1)

    // Walk the continued block and require exactly one argument per physical line. This is what
    // makes concurrent registrations land on different lines; a single line carrying two tokens is
    // the shape that reintroduces the conflict.
    const body: string[] = []
    let i = header + 1
    for (; i < lines.length; i += 1) {
      const line = lines[i]
      body.push(line)
      if (!line.replace(/\s+$/, '').endsWith('\\')) break
    }
    expect(i, 'the exec block must terminate (a dangling continuation at EOF)').toBeLessThan(lines.length)

    for (const line of body) {
      const payload = line.replace(/\s+$/, '').replace(/\\$/, '').trim()
      expect(
        payload.split(/\s+/).filter(Boolean).length,
        `exec block line carries more than one argument: ${JSON.stringify(line)}`,
      ).toBe(1)
      expect(line.startsWith('  '), `exec block line must be indented two spaces: ${JSON.stringify(line)}`).toBe(true)
    }
    expect(body[body.length - 1].trim(), 'the block must end on the reporter flag').toBe('--reporter=dot')
  })

  it('carries no duplicate token (the literal artifact a union merge of two identical additions leaves)', () => {
    const tokens = tokensOf(execLogicalLine(script))
    expect(tokens.length).toBeGreaterThan(300)
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const token of tokens) {
      if (seen.has(token)) duplicates.push(token)
      seen.add(token)
    }
    expect(duplicates, 'a duplicate token is dead weight and a sign a merge went wrong').toEqual([])
  })

  it('is sorted case-insensitively (so a new token\'s line is a pure function of its name)', () => {
    const tokens = tokensOf(execLogicalLine(script))
    const sorted = [...tokens].sort(caseInsensitive)
    const firstBreak = tokens.findIndex((token, index) => token !== sorted[index])
    expect(
      firstBreak === -1 ? null : { at: firstBreak, found: tokens[firstBreak], expected: sorted[firstBreak] },
      'insert new tokens in case-insensitive alphabetical position — appending to the tail rebuilds '
      + 'the contended line this block exists to remove',
    ).toBeNull()
  })

  it('ends with `--reporter=dot` and no other flag (a stray -t/--testNamePattern would silently narrow the lane)', () => {
    expect(flagsOf(execLogicalLine(script))).toEqual(['--reporter=dot'])
  })

  it('is pinned in .gitattributes as `text eol=lf merge=union`', () => {
    const attrs = readFileSync(GITATTRIBUTES, 'utf8')
    const rule = attrs
      .split('\n')
      .map((line) => line.replace(/\r$/, '').trim())
      .find((line) => line.startsWith('apps/web/scripts/run-required-web-tests.sh '))
    expect(rule, '.gitattributes must pin the lane script').toBeTruthy()
    expect(rule).toContain('eol=lf')
    expect(rule).toContain('merge=union')
  })

  it('the second registration point is still live and readable under the SAME parsing contract', () => {
    // The two-point discipline names scripts/ops/integration-guard-run-web-specs.sh as the other
    // place a web spec gets registered, so this guard pins that it still exists as a single vitest
    // invocation with a positional token filter, parsed by the very function this file exports.
    //
    // MEASURED, AND DELIBERATELY NOT ASSERTED (2026-09-21): the two token sets are NOT equal and
    // neither contains the other. Of the second point's 54 tokens, 37 collect spec files that the
    // required lane's 397 tokens do not collect at all (e.g. tests/IntegrationWorkbenchView.spec.ts,
    // tests/fieldHints.spec.ts, tests/bomSnapshotDiff.spec.ts). Those specs therefore run only in
    // the path-filtered integration guard, never in the always-on required lane. That is a real
    // coverage gap, but it predates this change and closing it means adding 37 tokens to the
    // required lane — a coverage decision, not a shape one, and it belongs in its own PR with its
    // own green-in-isolation evidence per token. Asserting equality or containment here would make
    // this guard red against a clean origin/main on day one, which is exactly the failure mode
    // #5898's own comment calls out. So: assert the second point is live, record the gap, move on.
    const second = readFileSync(SECOND_REGISTRATION_POINT, 'utf8')
    const invocations = logicalLines(second).filter((line) => /\bvitest\s+run\b/.test(line))
    expect(invocations.length, 'the integration guard must have exactly one vitest invocation').toBe(1)

    const secondTokens = tokensOf(invocations[0])
    expect(secondTokens.length, 'a token filter that parsed to nothing would make this vacuous').toBeGreaterThan(30)
    expect(new Set(secondTokens).size, 'the second point must not carry duplicate tokens either').toBe(secondTokens.length)

    // A name filter here would silently narrow what the guard runs while still looking green.
    expect(/\s-t(?:\s|=|$)/.test(invocations[0])).toBe(false)
    expect(invocations[0].includes('--testNamePattern')).toBe(false)

    // The overlap is non-empty — if it ever hit zero the two points would have drifted into
    // unrelated files and the "two-point discipline" prose above would be describing nothing.
    const laneTokens = new Set(tokensOf(execLogicalLine(script)))
    const shared = secondTokens.filter((token) => laneTokens.has(token))
    expect(shared.length, 'the two registration points must still overlap').toBeGreaterThan(0)
  })
})

describe('required web lane registration block — parser decoys', () => {
  it('joins continuations and ignores tokens that appear only in comments', () => {
    const fixture = [
      '#!/usr/bin/env bash',
      '# exec npx vitest run decoyFromAComment --reporter=dot',
      'npx vitest run someEarlierBatch --reporter=dot || exit $?',
      'exec npx vitest run \\',
      '  alpha \\',
      '  Beta \\',
      '  --reporter=dot',
    ].join('\n')
    const tokens = tokensOf(execLogicalLine(fixture))
    expect(tokens).toEqual(['alpha', 'Beta'])
    expect(tokens).not.toContain('decoyFromAComment')
    expect(tokens).not.toContain('\\')
    expect(tokens).not.toContain('someEarlierBatch')
  })

  it('a physical-line parse of the new shape yields no usable token (why every guard had to change)', () => {
    const fixture = 'exec npx vitest run \\\n  alpha \\\n  --reporter=dot'
    const physical = fixture.split('\n').find((line) => line.startsWith('exec npx vitest run '))
    const physicalTokens = (physical ?? '')
      .slice('exec npx vitest run '.length)
      .split(/\s+/)
      .filter((t) => t && !t.startsWith('--'))
    expect(physicalTokens).toEqual(['\\'])
    expect(tokensOf(execLogicalLine(fixture))).toEqual(['alpha'])
  })

  it('rejects a union-produced duplicate exec header (both sides edited a non-list line)', () => {
    const fixture = [
      'exec npx vitest run \\',
      '  alpha \\',
      '  --reporter=dot',
      'exec npx vitest run \\',
      '  beta \\',
      '  --reporter=dot',
    ].join('\n')
    expect(() => execLogicalLine(fixture)).toThrow(/found 2/)
  })

  it('a dangling continuation is surfaced by the block walk, because bash itself will NOT reject it', () => {
    // MEASURED (2026-09-21), and the reason the `one token per physical line` test walks to EOF
    // explicitly instead of leaning on `bash -n`: a script whose last line ends in a backslash is
    // ACCEPTED by bash. `printf 'exec npx vitest run \\\n  alpha \\\n' > f; bash -n f` exits 0.
    // The continuation simply runs out at EOF and the command is considered complete. So `bash -n`
    // catches unparseable scripts, not truncated token blocks — a truncation that silently dropped
    // every token after the cut would sail past it. The `toBeLessThan(lines.length)` assertion in
    // the block walk is what actually covers that case.
    const fixture = ['exec npx vitest run \\', '  alpha \\'].join('\n')

    // The parser still materialises the partial logical line, so the caller sees the truncation
    // rather than losing it.
    expect(tokensOf(execLogicalLine(fixture))).toEqual(['alpha'])

    if (!BASH) {
      expect(process.env.CI).toBeFalsy()
      return
    }
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-n', '-s'], { input: fixture, encoding: 'utf8' })
    expect(result.status, 'documented: bash accepts a trailing continuation at EOF').toBe(0)
  })
})

/**
 * MUTATION SELF-PROOF (2026-09-21).
 *
 * The four assertions above are only worth their runtime if each one actually reds on the damage
 * it claims to catch. These cases apply that damage to the REAL lane script IN MEMORY — the file
 * on disk is never touched, so this suite is safe to run concurrently with anything else in this
 * worktree — and assert the corresponding detector fires.
 *
 * Each case re-implements nothing: it calls the same exported `logicalLines` / `execLogicalLine` /
 * `tokensOf` the assertions use, plus a local copy of the sortedness and duplicate predicates, so
 * a regression in the parser reds here too.
 */
describe('required web lane registration block — mutation self-proof', () => {
  const script = readFileSync(REQUIRED_LANE, 'utf8')
  const lines = script.split('\n').map((line) => line.replace(/\r$/, ''))
  const headerIndex = lines.findIndex((line) => line === 'exec npx vitest run \\')

  const hasDuplicate = (tokens: string[]): boolean => new Set(tokens).size !== tokens.length
  const isSorted = (tokens: string[]): boolean =>
    tokens.every((token, index) => index === 0 || caseInsensitive(tokens[index - 1], token) <= 0)

  /** Sanity: the unmutated file is clean under both predicates, so a red below is the mutation. */
  it('baseline: the real file is duplicate-free and sorted', () => {
    const tokens = tokensOf(execLogicalLine(script))
    expect(hasDuplicate(tokens)).toBe(false)
    expect(isSorted(tokens)).toBe(true)
    expect(headerIndex).toBeGreaterThan(-1)
  })

  it('M1 duplicated token -> the duplicate detector reds', () => {
    // Exactly what a union merge leaves when two branches add the same token.
    const mutated = [...lines.slice(0, headerIndex + 2), lines[headerIndex + 1], ...lines.slice(headerIndex + 2)]
      .join('\n')
    const tokens = tokensOf(execLogicalLine(mutated))
    expect(hasDuplicate(tokens), 'M1 must be caught by `no duplicate tokens`').toBe(true)
  })

  it('M2 out-of-order token -> the sortedness detector reds', () => {
    // A branch that appends to the tail instead of inserting alphabetically: the exact habit that
    // would rebuild the contended line this block exists to remove.
    const first = lines[headerIndex + 1]
    const withoutFirst = [...lines.slice(0, headerIndex + 1), ...lines.slice(headerIndex + 2)]
    // Scan from the header onward. The script already contains TWO earlier multi-line vitest
    // invocations (apps/web/scripts/run-required-web-tests.sh:501-538 and :566-596), and the
    // second one's bare `--reporter=dot` terminator would otherwise be picked up first. Those two
    // blocks are also independent evidence that the one-token-per-line shape generalised here was
    // already precedented in this very file.
    const terminator = withoutFirst.findIndex((line, index) => index > headerIndex && line.trim() === '--reporter=dot')
    expect(terminator).toBeGreaterThan(headerIndex)
    // Re-insert the alphabetically-first token just before the reporter flag, keeping the
    // continuation shape valid so ONLY the ordering assertion can catch it.
    const mutated = [
      ...withoutFirst.slice(0, terminator),
      first,
      ...withoutFirst.slice(terminator),
    ].join('\n')

    const tokens = tokensOf(execLogicalLine(mutated))
    expect(hasDuplicate(tokens), 'M2 is an ordering fault only — the duplicate detector must NOT fire').toBe(false)
    expect(tokens.length, 'M2 must not change the token set size').toBe(tokensOf(execLogicalLine(script)).length)
    expect(isSorted(tokens), 'M2 must be caught by `is sorted`').toBe(false)
  })

  it('M3 continuation joining removed -> every token-reading guard goes blind', () => {
    // Not a mutation of the script but of the PARSER: what happens to a guard that keeps the old
    // physical-line form. It reads one "token" (the backslash) instead of 397, so the enumeration
    // guards' `fileName.includes(token)` enrolment checks all fail.
    const physical = lines.find((line) => line.startsWith('exec npx vitest run '))
    const physicalTokens = (physical ?? '')
      .slice('exec npx vitest run '.length)
      .split(/\s+/)
      .filter((token) => token.length > 0 && !token.startsWith('-'))
    expect(physicalTokens).toEqual(['\\'])
    expect(physicalTokens.filter((token) => token.startsWith('StockPreparation'))).toEqual([])
    // The joined parse is what keeps those guards honest.
    expect(tokensOf(execLogicalLine(script)).filter((token) => token.startsWith('StockPreparation')).length)
      .toBeGreaterThan(20)
  })

  it('M4 union duplicates the exec HEADER (both sides edited it) -> the exec-count detector reds', () => {
    const terminator = lines.findIndex((line, index) => index > headerIndex && line.trim() === '--reporter=dot')
    expect(terminator).toBeGreaterThan(headerIndex)
    const block = lines.slice(headerIndex, terminator + 1)
    const mutated = [...lines.slice(0, terminator + 1), ...block, ...lines.slice(terminator + 1)].join('\n')
    expect(() => execLogicalLine(mutated), 'M4 must be caught by `exactly one exec logical line`').toThrow(/found 2/)
  })

  it('M5 union duplicates a non-list line -> caught only when that line is syntax-bearing', () => {
    // SCOPED CLAIM, measured rather than asserted from theory. "bash -n plus the exec-count guard
    // catch any union two-line artifact" is FALSE. Union splices both sides' versions of a line it
    // could not merge; whether that is detectable depends entirely on which line:
    //
    //   (a) a syntax-bearing line (an `if`/`fi`, a `for`/`done`) -> unbalanced -> `bash -n` reds.
    //   (b) the exec header or a token line              -> M4 / M1 / M2 above.
    //   (c) a self-contained simple command              -> NOT caught, and NOT harmful: the
    //       duplicate either runs the same guarded batch twice (idempotent) or, when it lands
    //       after the exec, is unreachable dead code — bash replaces the process at the exec.
    //
    // (c) is the honest residual. It is recorded here so nobody later reads the four assertions as
    // a total guarantee over union's output.
    if (!BASH) {
      expect(process.env.CI).toBeFalsy()
      return
    }
    const syntaxBearing = ['if true; then', '  echo ok', 'fi'].join('\n')
    const unionSplitsIt = ['if true; then', 'if false; then', '  echo ok', 'fi'].join('\n')
    expect(spawnSync(BASH, ['--noprofile', '--norc', '-n', '-s'], { input: syntaxBearing, encoding: 'utf8' }).status)
      .toBe(0)
    expect(
      spawnSync(BASH, ['--noprofile', '--norc', '-n', '-s'], { input: unionSplitsIt, encoding: 'utf8' }).status,
      '(a) an unbalanced block from a union splice is caught by bash -n',
    ).not.toBe(0)

    const benign = ['npx vitest run someBatch --reporter=dot || exit $?'].join('\n')
    const benignDoubled = [benign, benign].join('\n')
    expect(
      spawnSync(BASH, ['--noprofile', '--norc', '-n', '-s'], { input: benignDoubled, encoding: 'utf8' }).status,
      '(c) documented residual: a doubled self-contained command is syntactically fine',
    ).toBe(0)
  })
})
