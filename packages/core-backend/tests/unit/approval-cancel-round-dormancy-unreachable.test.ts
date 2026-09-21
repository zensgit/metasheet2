import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

import ts from 'typescript'
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
 *
 * CENSUS DESIGN UPDATE (round 1 — call-site counting introduced): the original design also pinned
 * the exact SET of production files that so much as MENTION the symbol at all — comments included —
 * on the theory that any new mention should force a human look. That pin broke on first contact with
 * its own stated purpose: a true descendant PR (C-2) added two doc-comment mentions with zero
 * behaviour change, and the pin had no way to distinguish "a new file now calls this" from "a new
 * file's comment now explains why it doesn't". Round 1 replaced it with a count of CALL SITES read
 * from `stripComments` output.
 *
 * CENSUS DESIGN UPDATE (round 2 — this revision, closes gate finding P2-1): round 1's call-site scan
 * was itself a TEXT stripper, not a parser, and `stripComments`' own file-header said so: a `//`
 * inside a string literal, on the same line as and BEFORE a real call, strips the call along with
 * the rest of the line. An independent gate review constructed exactly that shape —
 * `const s = "a//b"; return svc.createCancelRoundInstance(id) + s` on one line — and the round-1
 * scan reported it clean (11/11 green) while the call site was real and undetected. This revision
 * replaces the call-site scan's TEXT layer with the TypeScript compiler's own parser
 * (`ts.createSourceFile` + AST walk, for the extensions it can parse — see `AST_EXTENSIONS` below).
 * A parser tokenizes a string literal as one atomic node regardless of what characters — including
 * `//` — appear inside it, so a call site that follows one on the same line can never be swallowed:
 * this closes the failure mode at the mechanism, not by special-casing the one reported shape.
 *
 * The AST walk also lets "declares the method" and "calls the method" be told apart precisely, which
 * a text pattern (`createCancelRoundInstance(` matches both a method declaration and a call) could
 * not: a `MethodDeclaration`/`FunctionDeclaration` node is never a `CallExpression` node. So round 2
 * asserts, separately: the definition file contains exactly one DECLARATION of the symbol and ZERO
 * call sites of it (nobody, including the method itself, invokes it); every other production file
 * contains zero of each.
 *
 * SCOPE NOTE (intentional, read before extending): a call site is now defined narrowly, matching the
 * gate-approved fix — a `CallExpression` whose callee is either the bare `Identifier` SYMBOL or a
 * `PropertyAccessExpression` named SYMBOL (i.e. `createCancelRoundInstance(...)` or
 * `x.createCancelRoundInstance(...)`). Round 1's text pattern also flagged a bare, uncalled property
 * reference (`const fn = x.createCancelRoundInstance`, no trailing `(`) as a reachability signal —
 * see the POSITIVE CONTROL below that pins this narrowing on purpose so it cannot drift silently.
 * This is a real, reported behavioural narrowing on ONE axis (reference-taking) traded for closing a
 * false-negative on another axis (string-adjacent calls); it has not been separately re-litigated
 * with the reviewer who asked for round 1, and remains open for that reviewer's sign-off.
 *
 * RESIDUAL (also reported, not silently left): the STATIC "no production file other than the
 * definition file mentions the symbol in code" assertion below still reads `stripComments` output —
 * it was not part of the P2-1 finding's remit and is unchanged by this revision. It shares
 * `stripComments`' own honest limit and is not a backstop for the failure mode this revision closes;
 * treat it as the older, coarser, still-present raw-mention check that it always was.
 */

const REPO_ROOT = join(__dirname, '../../../..')

const SYMBOL = 'createCancelRoundInstance'

/** Extensions that can execute in production. `.vue` included: SFC `<script>` blocks are code. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.cjs', '.mjs', '.vue']

/**
 * Extensions whose content is parsed with the real TypeScript compiler API for the call-site /
 * declaration / string-dispatch census below. `.vue` is deliberately EXCLUDED: a Single-File
 * Component mixes template markup with a `<script>` block, and handing the WHOLE file to
 * `ts.createSourceFile` does not throw — it silently returns a best-effort, largely-garbage tree
 * (parse errors are diagnostics, not exceptions). Treating that tree as ground truth would be a
 * NEW fail-open in the exact class of bug (a scan that looks like it works but silently misses
 * real code) this revision exists to close, so `.vue` stays on the pre-existing text-based scan
 * (`stripComments` + `CALL_SITE_PATTERN`, unchanged from round 1) instead.
 *
 * The split is itself asserted below as DATA, not a silent carve-out
 * (`feedback_exemption_reasons_rot_make_them_data`): `SOURCE_EXTENSIONS` minus `AST_EXTENSIONS`
 * must equal exactly `['.vue']`, so a future extension added to one list and not the other reds.
 */
const AST_EXTENSIONS = ['.ts', '.tsx', '.js', '.cjs', '.mjs']

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
 * legacy `.vue` string-keyed-dispatch fallback below needs them.
 *
 * HONEST LIMIT (why round 2 exists): this is a text stripper, not a parser. A `//` inside a string
 * literal or a regex, on the same line as and BEFORE an occurrence of the symbol, strips that
 * occurrence along with the rest of the line — i.e. it can under-report, not only over-report. This
 * function is now used ONLY for: the raw "mentions the symbol in code" STATIC assertion (unchanged
 * scope, see the file-header RESIDUAL note), the definition-file mention-count STATIC assertion, the
 * test-path-caller positive control, and the `.vue` fallback census. Every call-site / declaration /
 * string-dispatch assertion that matters for reachability now reads the real AST instead (see
 * `astCensus` below) for `AST_EXTENSIONS`, and only falls back to this function for `.vue`.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * Legacy (round 1) textual call-site pattern — direct invocation or property access, `\b`-anchored.
 * Retained ONLY as the `.vue` fallback (see `AST_EXTENSIONS`); every other extension now goes
 * through `astCensus`. Kept `stripComments`-fed like it always was for `.vue`'s honest limit to stay
 * exactly as documented and scoped as it was before this revision.
 */
const CALL_SITE_PATTERN = new RegExp(`(?:\\.${SYMBOL}\\b)|(?:\\b${SYMBOL}\\()`, 'g')

function legacyCallSiteCount(strippedCode: string): number {
  const matches = strippedCode.match(CALL_SITE_PATTERN)
  return matches ? matches.length : 0
}

/** The three quoted forms a string-keyed dispatch can take; used only by the `.vue` fallback. */
const STRING_DISPATCH_FORMS = [`'${SYMBOL}'`, `"${SYMBOL}"`, `\`${SYMBOL}\``]

interface FileCensus {
  /** Count of `CallExpression` nodes whose callee names SYMBOL (see `astCensus` doc). */
  callSites: number
  /** Count of `MethodDeclaration` / `FunctionDeclaration` nodes named SYMBOL. */
  declarations: number
  /** Whether a string/no-substitution-template literal whose text is exactly SYMBOL appears. */
  stringDispatch: boolean
}

function scriptKindFor(rel: string): ts.ScriptKind {
  if (rel.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (rel.endsWith('.ts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS // .js / .cjs / .mjs
}

/**
 * Real-parser census for one file's source text (`AST_EXTENSIONS` only — see that constant's doc
 * for why `.vue` cannot go through here). `setParentNodes=false`: this is a one-pass top-down
 * `forEachChild` walk that never needs `.parent`.
 *
 *   - callSites: a `CallExpression` whose callee is the bare `Identifier` SYMBOL, or a
 *     `PropertyAccessExpression` whose `.name` is SYMBOL — i.e. `createCancelRoundInstance(...)` or
 *     `x.createCancelRoundInstance(...)`. A `MethodDeclaration`/`FunctionDeclaration` is never a
 *     `CallExpression`, so the definition itself is never counted here — a parser distinguishes
 *     "this DECLARES the method" from "this INVOKES it", which a text pattern cannot. And because
 *     the parser tokenizes a string literal as one atomic node no matter what characters (including
 *     `//`) sit inside it, a call site that follows one on the same line can never be eaten —
 *     P2-1 closed at the mechanism.
 *   - declarations: a `MethodDeclaration` or `FunctionDeclaration` whose name is the `Identifier`
 *     SYMBOL.
 *   - stringDispatch: a `StringLiteral` or `NoSubstitutionTemplateLiteral` whose `.text` is exactly
 *     SYMBOL. A `TemplateExpression` (a template WITH `${...}` interpolation) is deliberately NOT
 *     matched here: none of its literal spans can, by construction, equal the full symbol name on
 *     their own when the template also contains an expression hole, so a dynamic-partial template
 *     correctly does not false-positive — the same behaviour the old exact-substring form had.
 */
function astCensus(rel: string, code: string): FileCensus {
  const source = ts.createSourceFile(rel, code, ts.ScriptTarget.ES2022, false, scriptKindFor(rel))
  let callSites = 0
  let declarations = 0
  let stringDispatch = false

  const calleeNamesSymbol = (expr: ts.Expression): boolean => {
    if (ts.isIdentifier(expr)) return expr.text === SYMBOL
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text === SYMBOL
    return false
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeNamesSymbol(node.expression)) {
      callSites += 1
    }
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === SYMBOL
    ) {
      declarations += 1
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === SYMBOL
    ) {
      stringDispatch = true
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { callSites, declarations, stringDispatch }
}

/** Census for one production file, dispatching to the AST walk or the `.vue` text fallback. */
function censusOf(rel: string, code: string): FileCensus {
  if (AST_EXTENSIONS.some((ext) => rel.endsWith(ext))) {
    return astCensus(rel, code)
  }
  // `.vue` fallback — unchanged round-1 behaviour, `stripComments`-fed.
  const stripped = stripComments(code)
  return {
    callSites: legacyCallSiteCount(stripped),
    declarations: 0, // no production `.vue` file declares this backend method
    stringDispatch: STRING_DISPATCH_FORMS.some((form) => stripped.includes(form)),
  }
}

function collectSources(): { production: string[]; tests: string[] } {
  const all: string[] = []
  for (const root of ['packages', 'apps', 'plugins', 'scripts']) walk(join(REPO_ROOT, root), all)
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

/**
 * Parsed once at collection time, not per-assertion: five-plus assertions each re-parsing ~4.4k
 * files with `ts.createSourceFile` would multiply real wall-clock cost for no benefit, since the
 * census is a pure function of file content that does not change mid-run.
 */
const productionCensus: Map<string, FileCensus> = new Map(
  production.map((rel) => [rel, censusOf(rel, readRel(rel))]),
)

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

  it('DATA: the AST/legacy extension split is exhaustive and exactly the documented carve-out', () => {
    const legacyOnly = SOURCE_EXTENSIONS.filter((ext) => !AST_EXTENSIONS.includes(ext))
    expect(
      legacyOnly,
      'the set of extensions NOT parsed by the real AST census drifted away from the documented, ' +
        'audited `.vue` carve-out — see AST_EXTENSIONS doc comment',
    ).toEqual(['.vue'])
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

  it('STATIC: no string-keyed dynamic dispatch can name the method (AST string-literal census)', () => {
    const offenders: string[] = []
    for (const rel of production) {
      if (productionCensus.get(rel)?.stringDispatch) offenders.push(rel)
    }
    expect(
      offenders,
      `the method name appears as a string literal (route path / hook key / event name / ` +
        `bracket-access key) in: ${JSON.stringify(offenders)}`,
    ).toEqual([])
  })

  it('POSITIVE CONTROL: the AST string-dispatch census detects every quoted form', () => {
    expect(astCensus('probe.ts', `const a = '${SYMBOL}'`).stringDispatch).toBe(true)
    expect(astCensus('probe.ts', `const b = "${SYMBOL}"`).stringDispatch).toBe(true)
    expect(astCensus('probe.ts', `const c = \`${SYMBOL}\``).stringDispatch).toBe(true)
    // A template WITH interpolation cannot equal the full symbol name in a single literal span —
    // correctly not flagged, same as the old exact-substring form.
    expect(astCensus('probe.ts', 'const d = `${x}' + SYMBOL + '`').stringDispatch).toBe(false)
  })

  it('POSITIVE CONTROL: the AST call-site census detects a real call form', () => {
    expect(astCensus('probe.ts', `service.${SYMBOL}(documentId, { userId })`).callSites).toBe(1)
    // A bare call after destructuring, with no receiver at all.
    expect(astCensus('probe.ts', `${SYMBOL}(documentId)`).callSites).toBe(1)
    // The definition form (a class MethodDeclaration, matching the real definition site's shape)
    // is NOT a call site under AST semantics — declarations are counted separately below.
    const definitionShaped = `class C { async ${SYMBOL}(documentId) {} }`
    expect(astCensus('probe.ts', definitionShaped).callSites).toBe(0)
    expect(astCensus('probe.ts', definitionShaped).declarations).toBe(1)
  })

  it('POSITIVE CONTROL (SCOPE, documented on purpose — see file header): a bare, uncalled property reference is NOT a call site under AST semantics', () => {
    // Round 1's TEXT pattern flagged this (`.SYMBOL` with no trailing `(`) as a reachability
    // signal; round 2's CallExpression-based definition, as specified, does not. This is the one
    // reported narrowing this revision introduces — pinned here so it cannot drift silently.
    expect(astCensus('probe.ts', `const fn = service.${SYMBOL}`).callSites).toBe(0)
  })

  it('POSITIVE CONTROL: the AST call-site census does not count a comment-only or string-only mention', () => {
    const commentedSource = [
      '/**',
      ` * See \`${SYMBOL}\` for the creation path this hook feeds.`,
      ' */',
      `// also referenced here for context: ${SYMBOL}`,
      `const label = "${SYMBOL}"`,
      'export const noop = 1',
    ].join('\n')
    expect(astCensus('probe.ts', commentedSource).callSites).toBe(0)
  })

  it('POSITIVE CONTROL (P2-1 regression): a call site is detected even when a same-line string literal contains "//" before it', () => {
    // The exact shape an independent gate review used to show round 1's stripComments-based scan
    // silently missed a real call site: everything after the "//" inside "a//b" was stripped,
    // taking the real call with it. The AST never tokenizes inside the string literal at all, so
    // this must be 1, not 0.
    const probe = 'const s = "a//b"; return svc.' + SYMBOL + '(id) + s'
    expect(astCensus('probe.ts', probe).callSites).toBe(1)
  })

  it('STATIC: no production file — including the definition file — contains a call site of the symbol', () => {
    // Strictly stronger than round 1's "other than the definition file": under AST semantics the
    // definition itself is a MethodDeclaration, never a CallExpression, so nobody (including the
    // method itself, i.e. no self-recursion) may call it anywhere in the production tree.
    const offenders: string[] = []
    for (const rel of production) {
      if ((productionCensus.get(rel)?.callSites ?? 0) > 0) offenders.push(rel)
    }
    expect(
      offenders,
      `production files contain a call site (${SYMBOL}( or .${SYMBOL}() outside its own definition: ` +
        JSON.stringify(offenders),
    ).toEqual([])
  })

  it('STATIC: the definition file declares the method exactly once, and calls it nowhere', () => {
    const census = productionCensus.get(DEFINITION_FILE)
    expect(census, `${DEFINITION_FILE} was not found in the production census`).toBeDefined()
    expect(census!.declarations, 'the definition file must declare the method exactly once').toBe(1)
    expect(census!.callSites, 'the definition file must not itself call the method').toBe(0)
  })

  it('STATIC: no production file other than the definition file declares a method/function named the symbol', () => {
    const offenders: string[] = []
    for (const rel of production) {
      if (rel === DEFINITION_FILE) continue
      if ((productionCensus.get(rel)?.declarations ?? 0) > 0) offenders.push(rel)
    }
    expect(
      offenders,
      `a production file other than the definition declares a method/function named ${SYMBOL}: ` +
        JSON.stringify(offenders),
    ).toEqual([])
  })

  it('STATIC: no HTTP route module mentions the method at all', () => {
    const routeFiles = production.filter((rel) => rel.includes(join('src', 'routes') + sep))
    expect(routeFiles.length, 'route-module population is empty — the filter is broken').toBeGreaterThan(10)
    const offenders = routeFiles.filter((rel) => readRel(rel).includes(SYMBOL))
    expect(offenders, `route modules mention ${SYMBOL}: ${JSON.stringify(offenders)}`).toEqual([])
  })
})
