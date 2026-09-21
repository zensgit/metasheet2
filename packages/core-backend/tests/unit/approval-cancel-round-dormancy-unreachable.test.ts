import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * C-1 "dormant merge" condition 2 — an EXECUTABLE unreachability check for
 * `ApprovalProductService.createCancelRoundInstance`.
 *
 * WHY THIS EXISTS (and why "the function has no callers" is not by itself the claim): the PR that
 * introduces `createCancelRoundInstance` also edits shipped production files — two legacy approval
 * routes, the generic bridge dispatch, the attendance approval hooks module, the attendance plugin's
 * `attendance_requests` writers, and the frontend batch-transfer skip-reason union. A reviewer is
 * right that "one function has no callers" cannot carry "this PR does not affect users". THIS file
 * therefore makes exactly ONE narrow claim, mechanically, and says so out loud:
 *
 *   CLAIM: no production source file in this repository can reach `createCancelRoundInstance` —
 *          not by a direct call, not by a string-keyed dynamic dispatch, not via a route path,
 *          plugin hook key, or event name that embeds the method name.
 *
 * It does NOT claim the PR is behaviour-free. The migration-side and code-side behaviour deltas are
 * measured separately (see the dormancy verification report accompanying this file).
 *
 * HOW THE POPULATION IS BUILT (the part that usually rots): mechanically, by walking real
 * directories, NOT by a hand-written file list. A glob typo would otherwise yield zero files and a
 * green test, so this file asserts a POPULATION FLOOR and a SENTINEL — the scan must find at least
 * `MIN_PRODUCTION_FILES` files AND must actually contain the one file that defines the method. Both
 * are positive controls for the scan itself.
 *
 * THE EXCLUSION IS DATA, NOT AN AD-HOC FILTER: the PR's own `*.db.test.ts` suites legitimately call
 * `createCancelRoundInstance`, so the scan must exclude test sources — which is precisely where a
 * silent hole would hide. `TEST_PATH_MARKERS` is therefore an asserted-on constant, and the test
 * pins the exact set of excluded files that DO call the method, so a production file that ever
 * starts calling it cannot be waved away as "just a test".
 */

const REPO_ROOT = join(__dirname, '../../../..')

const SYMBOL = 'createCancelRoundInstance'

/** Extensions that can execute in production. `.vue` included: SFC `<script>` blocks are code. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.cjs', '.mjs', '.vue']

/**
 * Roots walked. Chosen to cover every place a caller could live: backend services + routes, the
 * web frontend, every runtime-loaded plugin (`PluginLoader` scans `cwd/plugins` at runtime, so a
 * plugin with zero static imports is still live), and the ops/scripts surface.
 */
const PRODUCTION_ROOTS = [
  'packages',
  'apps',
  'plugins',
  'scripts',
]

/** Directory names never walked. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.turbo',
  '.next',
  '.vite',
])

/**
 * Path markers that make a file a TEST source rather than a production source. Exported as data (and
 * asserted on below) rather than inlined into the filter, so the exclusion itself is auditable:
 * `feedback_exemption_reasons_rot_make_them_data`.
 */
const TEST_PATH_MARKERS = [
  `${sep}tests${sep}`,
  `${sep}test${sep}`,
  `${sep}__tests__${sep}`,
  `${sep}e2e${sep}`,
  '.test.',
  '.spec.',
]

/**
 * Floor for the mechanically enumerated production population. A glob/typo regression that walks
 * nothing yields 0 and would otherwise make every "zero occurrences" assertion below vacuously true.
 * Set well under the real count (measured ~4.4k at the commit this landed on) so unrelated file
 * churn does not red it, but far enough above zero to catch a broken walk.
 */
const MIN_PRODUCTION_FILES = 1500

/** The single file allowed to contain the symbol at all, and the exact form it may take. */
const DEFINITION_FILE = join('packages', 'core-backend', 'src', 'services', 'ApprovalProductService.ts')
const DEFINITION_FORM = `async ${SYMBOL}(`

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full, out)
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full)
    }
  }
}

function isTestPath(relPath: string): boolean {
  const normalized = `${sep}${relPath}`
  return TEST_PATH_MARKERS.some((marker) => normalized.includes(marker))
}

/**
 * Removes `//` line comments and block comments. Deliberately does NOT strip string literals — the
 * string-keyed-dispatch assertion below needs them.
 *
 * HONEST LIMIT: this is a text stripper, not a parser. A `//` inside a string literal or a regex,
 * on the same line as and BEFORE an occurrence of the symbol, would strip that occurrence along
 * with the rest of the line — i.e. it can under-report, not only over-report. That is why the
 * RAW-TEXT pin below exists and does not use this function at all: it fixes the exact set of
 * production files that mention the symbol in any form, comments included, so a new mention cannot
 * hide behind a stripper edge case.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

function collectSources(): { production: string[]; tests: string[] } {
  const all: string[] = []
  for (const root of PRODUCTION_ROOTS) walk(join(REPO_ROOT, root), all)
  const production: string[] = []
  const tests: string[] = []
  for (const full of all) {
    const rel = relative(REPO_ROOT, full)
    if (isTestPath(rel)) tests.push(rel)
    else production.push(rel)
  }
  return { production, tests }
}

const { production, tests } = collectSources()

function readRel(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

function occurrencesOf(needle: string, haystack: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

describe('cancel-round creation path is unreachable from production code (C-1 dormancy condition 2)', () => {
  it('POSITIVE CONTROL: the mechanical scan enumerates a non-trivial production population', () => {
    expect(
      production.length,
      `production source walk collected ${production.length} files (< ${MIN_PRODUCTION_FILES}); ` +
        'the walk is broken, and every "zero occurrences" assertion below would be vacuous',
    ).toBeGreaterThanOrEqual(MIN_PRODUCTION_FILES)
  })

  it('POSITIVE CONTROL: the scan actually reaches the file that defines the method', () => {
    expect(
      production,
      'the definition file is missing from the enumerated population — the scan is not looking where it claims to',
    ).toContain(DEFINITION_FILE)
    expect(readRel(DEFINITION_FILE)).toContain(DEFINITION_FORM)
  })

  it('POSITIVE CONTROL: the test-path exclusion is real, and the excluded callers are pinned by name', () => {
    expect(TEST_PATH_MARKERS.length).toBeGreaterThan(0)
    const testCallers = tests
      .filter((rel) => stripComments(readRel(rel)).includes(SYMBOL))
      .sort()
    // If this list is ever empty the exclusion has stopped excluding anything real, and the
    // "production has zero" claim below stops being a claim about a partitioned population.
    expect(
      testCallers.length,
      'no excluded test file calls the symbol — the exclusion is no longer partitioning anything',
    ).toBeGreaterThan(0)
    for (const rel of testCallers) {
      expect(isTestPath(rel)).toBe(true)
    }
  })

  it('STATIC: no production file other than the definition file mentions the symbol in code', () => {
    const offenders: string[] = []
    for (const rel of production) {
      if (rel === DEFINITION_FILE) continue
      const code = stripComments(readRel(rel))
      if (code.includes(SYMBOL)) offenders.push(rel)
    }
    expect(
      offenders,
      `production files reference ${SYMBOL} outside its definition file: ${JSON.stringify(offenders)}`,
    ).toEqual([])
  })

  it('STATIC: the definition file contains the symbol exactly once, and that once is the definition', () => {
    const code = stripComments(readRel(DEFINITION_FILE))
    expect(occurrencesOf(SYMBOL, code)).toBe(1)
    expect(code).toContain(DEFINITION_FORM)
  })

  it('STATIC: no string-keyed dynamic dispatch can name the method', () => {
    const quoted = [`'${SYMBOL}'`, `"${SYMBOL}"`, `\`${SYMBOL}\``]
    const offenders: string[] = []
    for (const rel of production) {
      const code = stripComments(readRel(rel))
      if (quoted.some((form) => code.includes(form))) offenders.push(rel)
    }
    expect(
      offenders,
      `the method name appears as a string literal (route path / hook key / event name / ` +
        `bracket-access key) in: ${JSON.stringify(offenders)}`,
    ).toEqual([])
  })

  /**
   * RAW-TEXT PIN — deliberately reads the unstripped source, so it is independent of `stripComments`
   * and of every judgement call in it. The five entries below are prose mentions (doc comments,
   * plus the definition itself in ApprovalProductService.ts); none of the other four is a call. Pinning the SET, not merely "zero calls", means that a new
   * production file which so much as names the method — in a comment, a string, or code — reds this
   * and forces a human look, rather than being silently absorbed by a stripper edge case.
   */
  it('RAW TEXT: the set of production files mentioning the symbol at all is exactly the known set', () => {
    const mentions = production.filter((rel) => readRel(rel).includes(SYMBOL)).sort()
    expect(mentions).toEqual([
      join('packages', 'core-backend', 'src', 'attendance', 'w4c3b-central-approval-hooks.ts'),
      join('packages', 'core-backend', 'src', 'db', 'migrations', 'zzzz20260918090000_create_approval_rounds.ts'),
      join('packages', 'core-backend', 'src', 'services', 'ApprovalAssigneeResolver.ts'),
      join('packages', 'core-backend', 'src', 'services', 'ApprovalProductService.ts'),
      join('packages', 'core-backend', 'vitest.config.ts'),
    ])
  })

  it('STATIC: no HTTP route module mentions the method at all', () => {
    const routeFiles = production.filter((rel) => rel.includes(join('src', 'routes') + sep))
    expect(routeFiles.length, 'route-module population is empty — the filter is broken').toBeGreaterThan(10)
    const offenders = routeFiles.filter((rel) => readRel(rel).includes(SYMBOL))
    expect(offenders, `route modules mention ${SYMBOL}: ${JSON.stringify(offenders)}`).toEqual([])
  })
})
