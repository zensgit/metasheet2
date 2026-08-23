/**
 * O2 NIT-sweep (gate #5018 NIT-5) — CLOSED-WORLD check for the recovery-conflict census
 * denominator.
 *
 * recovery-conflict-census.test.ts audits a HARDCODED table (WIRING_CENSUS) of 13 files /
 * 48 call sites. Its own negative controls prove that a new call site inside an
 * already-enumerated file turns the census red — but nothing there reds if a **14th
 * file** starts calling one of the four adapter tokens. That is the repo's named
 * 枚举陷阱不收敛 shape: a hardcoded enumeration only converges when paired with a
 * closed-world check over the whole population.
 *
 * This suite closes that hole mechanically, from two INDEPENDENT derivations:
 *
 *   A. SCANNER  — walk every .ts/.js file under src/, strip comments, strip
 *      declarations, and count real call sites of the four adapter tokens
 *      (same counting semantics as the census, reimplemented here on purpose so a bug in
 *      one copy cannot hide in both directions of the comparison).
 *   B. REGISTRY — parse WIRING_CENSUS out of tests/unit/lib/recovery-census-table.ts's SOURCE
 *      (that table is the authoritative registered-site ledger; parsing it instead of
 *      duplicating it means there is exactly ONE census to keep current).
 *
 * and assert set-equality: same files, same per-file per-token call counts. A NEW
 * unregistered caller file → red here; a census row whose file no longer calls → red
 * here; a call-count drift in either direction → red here.
 *
 * Anti-vacuity (扫描窗口两头都骗人 / 空读≠不存在): both derivations carry floors pinned
 * to the population independently verified by the #5018 adversarial gate on 2026-08-19
 * (13 files / 48 sites — floors, not exact pins, so legitimate GROWTH lands without
 * touching this file while a scanner/parser collapse or a census shrink goes red), plus
 * fixture-level negative controls for the scanner (a planted unregistered caller MUST be
 * discovered and MUST red the audit) and a loud failure mode for the parser.
 *
 * NOT here: reachability/linkage (that is the census's own per-site leg machinery), and
 * the classifier module itself (src/db/recovery-conflict.ts declares the adapters and
 * internally delegates between them — it is the one file excluded from both sides).
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const SRC_ROOT = path.resolve(__dirname, '../../src')
// P3-1 extracted WIRING_CENSUS out of recovery-conflict-census.test.ts into this shared
// module so the static census and the runtime leg recorder read ONE table. Parse it from
// there — the "exactly one census to keep current" property is unchanged (and stronger:
// the table now has a dedicated home). The parser's fail-loud control proves a wrong or
// emptied path throws instead of silently yielding an empty registry.
const CENSUS_TEST_PATH = path.resolve(__dirname, 'lib/recovery-census-table.ts')

/** The declaration/delegation module — the single file excluded from both derivations. */
const CLASSIFIER_MODULE = 'db/recovery-conflict.ts'

/**
 * The stability module owns ONE classification entry point but also exports lease
 * acquisition and authority resolution, which classify nothing. So that one token is
 * pinned BY NAME rather than derived from the module's export surface — deriving the
 * whole surface would silently widen what the census MEANS (every lease caller would
 * suddenly owe a census row). The pin is fail-loud: if the export is renamed or removed,
 * derivation throws instead of quietly dropping the token.
 */
const STABILITY_MODULE = 'multitable/recovery-authorization-stability.ts'
const STABILITY_CLASSIFIER_TOKEN = 'isRecoveryAuthorityBusyError'

/**
 * Brace-balanced body of a top-level `function <name>(...) { ... }`, or null when the
 * declaration is absent. Balanced rather than lazy-regex so a nested `{ }` cannot
 * truncate the body early and make a long function look like a one-line delegation.
 */
function functionBody(source: string, name: string): string | null {
  const declRe = new RegExp(`\\bfunction\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`)
  const match = declRe.exec(source)
  if (match === null) return null
  const start = match.index + match[0].length
  let depth = 1
  let i = start
  while (depth > 0 && i < source.length) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    i += 1
  }
  return depth === 0 ? source.slice(start, i - 1) : null
}

/**
 * DERIVED token set (was a hardcoded list of four until this slice).
 *
 * The hardcoded list is what let `routes/univer-meta.ts` and `auth/AuthService.ts` sit
 * outside the denominator entirely — both score ZERO on the old four, so the closed-world
 * check was closed over the wrong world. A hand-maintained mirror of a token surface is a
 * claim, not a check (枚举陷阱不收敛), so the set is derived from the source of truth.
 *
 * The rule: **a token belongs iff OMITTING it would hide a classification site.**
 *
 *   (a) every exported function of the ONE classifier module — its whole exported
 *       function surface IS the classification API;
 *   (b) `isRecoveryAuthorityBusyError`, pinned by name (see STABILITY_MODULE above);
 *   (c) every NON-EXPORTED file-local function whose body is EXACTLY one unconditional
 *       delegation to an (a)/(b) token — a local alias for a classifier call.
 *
 * (c) is narrow on purpose, in both directions:
 *
 *   - "exactly one unconditional delegation", not "the body mentions a token somewhere":
 *     the loose form promotes every ENCLOSING function (whole router factories like
 *     `rolesRouter`) to a token and inflates the population to nonsense.
 *   - "non-exported", because an exported function is a MODULE BOUNDARY: its callers
 *     consume an already-classified API and the classification site inside it is already
 *     counted. `directory/deprovision-ledger.ts`'s exported
 *     `applyDirectoryDeprovisionCandidate` is exactly this shape — a one-line
 *     `translateRecoveryConflict(...)` delegation whose single site is already registered.
 *     Counting it would make every consumer of every classified service owe a leg.
 *     `routes/admin-users.ts`'s non-exported `sendIfRecoveryAuthorityBusy` is the opposite:
 *     `sendIfRecoveryConflict` appears there only ONCE (inside the wrapper) while SIX real
 *     HTTP surfaces route through it, so omitting the alias hides six sites.
 *
 * A pure RESPONDER is not a token. `routes/univer-meta.ts`'s `sendRecoveryAuthorityBusy`
 * is `res.status(409).json(...)` — it classifies nothing and calls no classifier, and all
 * five of its sites are already visible through the `isRecoveryAuthorityBusyError` on the
 * same line. Registering it would demand a second leg per behaviour plus five new
 * `ALLOWED_MULTI_TAG_SITE_SETS` entries, each needing its own mechanical rationale, and
 * would buy nothing the behaviour legs do not already assert (they pin the exact 409 body,
 * so deleting the responder reds them).
 */
function deriveAdapterTokens(srcRoot: string): readonly string[] {
  const classifierSource = readFileSync(path.join(srcRoot, CLASSIFIER_MODULE), 'utf8')
  const exported = [
    ...classifierSource.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm),
  ].map((m) => m[1])
  if (exported.length < 3) {
    throw new Error(
      `token derivation: ${CLASSIFIER_MODULE} yielded ${exported.length} exported function(s) — `
      + 'refusing a collapsed token set (the classifier API cannot have shrunk below its '
      + 'classify/translate/send surface without this guard being reconsidered)',
    )
  }

  const stabilitySource = readFileSync(path.join(srcRoot, STABILITY_MODULE), 'utf8')
  if (!new RegExp(`export\\s+function\\s+${STABILITY_CLASSIFIER_TOKEN}\\b`).test(stabilitySource)) {
    throw new Error(
      `token derivation: ${STABILITY_CLASSIFIER_TOKEN} is no longer exported from `
      + `${STABILITY_MODULE} — the by-name pin is stale, so the census would silently stop `
      + 'seeing every surface that classifies through it',
    )
  }

  const base = [...new Set([...exported, STABILITY_CLASSIFIER_TOKEN])]
  const aliases = new Set<string>()
  for (const file of walkSourceFiles(srcRoot)) {
    const rel = path.relative(srcRoot, file).split(path.sep).join('/')
    if (rel === CLASSIFIER_MODULE) continue
    const stripped = stripComments(readFileSync(file, 'utf8'))
    for (const match of stripped.matchAll(
      /(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    )) {
      if (match[1] !== undefined) continue // exported = module boundary, not a local alias
      const name = match[2]
      if (base.includes(name) || aliases.has(name)) continue
      const body = functionBody(stripped, name)
      if (body === null) continue
      const normalized = body.replace(/\s+/g, ' ').trim().replace(/;$/, '')
      if (base.some((token) => new RegExp(`^return\\s+${token}\\s*\\(`).test(normalized))) {
        aliases.add(name)
      }
    }
  }
  return [...new Set([...base, ...aliases])].sort()
}

/**
 * Derived ONCE against the REAL src tree, never against the scan root: the negative
 * controls below call scanAdapterCallSites() with synthetic makeFixtureTree() roots whose
 * `db/recovery-conflict.ts` is a stub, and deriving from those would yield a bogus or
 * EMPTY token list — the precise vacuity this file exists to prevent.
 */
const ADAPTER_TOKENS: readonly string[] = deriveAdapterTokens(SRC_ROOT)

// Population floors. #5018's adversarial gate independently swept 13 files / 48 sites
// (2026-08-19, head 1721b45e98) against the then-hardcoded four tokens; this slice's
// derived five-token set was swept to 15 files / 55 sites by three independent scanners
// (2026-08-23, head b2dc438a42) — the two NEW files being routes/univer-meta.ts (5) and
// auth/AuthService.ts (2), which scored ZERO on the old four. Floors so growth is
// frictionless but a both-sides-empty vacuity or a silent census shrink is red.
const GATE_VERIFIED_MIN_FILES = 15
const GATE_VERIFIED_MIN_SITES = 55

/** Same comment-stripping semantics as the census (a comment must never count). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

/** Same call-counting semantics as the census (a declaration must never count). */
function countCalls(strippedSource: string, token: string): number {
  const withoutDeclarations = strippedSource.replace(
    new RegExp(`\\bfunction\\s+${token}\\s*\\(`, 'g'),
    '',
  )
  const matches = withoutDeclarations.match(new RegExp(`\\b${token}\\s*\\(`, 'g'))
  return matches ? matches.length : 0
}

type TokenCounts = Map<string, number>

/** file (posix path relative to root) → token → call-site count (only counts > 0). */
type CallSiteMap = Map<string, TokenCounts>

function walkSourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
      } else if (/\.(ts|js)$/.test(entry) && !entry.endsWith('.d.ts')) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out
}

/** Derivation A: scan a real directory tree for adapter call sites. */
function scanAdapterCallSites(root: string): CallSiteMap {
  const discovered: CallSiteMap = new Map()
  for (const file of walkSourceFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    if (rel === CLASSIFIER_MODULE) continue
    const stripped = stripComments(readFileSync(file, 'utf8'))
    const counts: TokenCounts = new Map()
    for (const token of ADAPTER_TOKENS) {
      const count = countCalls(stripped, token)
      if (count > 0) counts.set(token, count)
    }
    if (counts.size > 0) discovered.set(rel, counts)
  }
  return discovered
}

/**
 * Derivation B: parse the WIRING_CENSUS table out of the census test's source.
 * Throws (loudly, never an empty map) if the table cannot be located or parses to
 * nothing — an empty registry must never silently satisfy an empty scan.
 */
function parseRegisteredCensus(censusSource: string): CallSiteMap {
  const start = censusSource.indexOf('const WIRING_CENSUS')
  const end = censusSource.indexOf('] as const', start)
  if (start === -1 || end === -1) {
    throw new Error('closed-world parser: WIRING_CENSUS table not found in census source')
  }
  const table = stripComments(censusSource.slice(start, end))
  const registry: CallSiteMap = new Map()
  const fileChunks = table.split(/file:\s*'/).slice(1)
  for (const chunk of fileChunks) {
    const file = chunk.slice(0, chunk.indexOf("'"))
    const counts: TokenCounts = new Map()
    for (const tokenChunk of chunk.split(/token:\s*'/).slice(1)) {
      const token = tokenChunk.slice(0, tokenChunk.indexOf("'"))
      const legs = (tokenChunk.match(/site:\s*'/g) ?? []).length
      counts.set(token, (counts.get(token) ?? 0) + legs)
    }
    if (file.length === 0 || counts.size === 0) {
      throw new Error(`closed-world parser: unparseable census row (file='${file}')`)
    }
    registry.set(file, counts)
  }
  if (registry.size === 0) {
    throw new Error('closed-world parser: WIRING_CENSUS parsed to zero rows')
  }
  return registry
}

/** The closed-world audit: discovered call sites must EQUAL the registered census. */
function closedWorldViolations(discovered: CallSiteMap, registry: CallSiteMap): string[] {
  const violations: string[] = []
  for (const [file, counts] of discovered) {
    const registered = registry.get(file)
    if (registered === undefined) {
      violations.push(
        `${file}: UNREGISTERED caller — calls {${[...counts.keys()].join(', ')}} but has no `
        + 'WIRING_CENSUS row (register the file with one [recovery-census:<site>] leg per call site)',
      )
      continue
    }
    for (const [token, count] of counts) {
      const legs = registered.get(token) ?? 0
      if (legs !== count) {
        violations.push(
          `${file}: ${token} has ${count} call site(s) in src but ${legs} registered census leg(s)`,
        )
      }
    }
  }
  for (const [file, registered] of registry) {
    const counts = discovered.get(file)
    if (counts === undefined) {
      violations.push(`${file}: registered in WIRING_CENSUS but the scanner found no adapter calls`)
      continue
    }
    for (const token of registered.keys()) {
      if (!counts.has(token)) {
        violations.push(`${file}: census registers ${token} but the scanner found no call of it`)
      }
    }
  }
  return violations
}

function totalSites(map: CallSiteMap): number {
  let total = 0
  for (const counts of map.values()) {
    for (const count of counts.values()) total += count
  }
  return total
}

const tempDirs: string[] = []
function makeFixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o2-closed-world-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('O2 recovery-conflict census — closed-world denominator (gate #5018 NIT-5)', () => {
  it('CLOSED WORLD: the set of src files calling the four adapter tokens EQUALS the WIRING_CENSUS registry, per-file per-token', () => {
    const discovered = scanAdapterCallSites(SRC_ROOT)
    const registry = parseRegisteredCensus(readFileSync(CENSUS_TEST_PATH, 'utf8'))
    expect(closedWorldViolations(discovered, registry)).toEqual([])
  })

  it('ANTI-VACUITY: both derivations independently reach the gate-verified population floors, and their totals agree', () => {
    const discovered = scanAdapterCallSites(SRC_ROOT)
    const registry = parseRegisteredCensus(readFileSync(CENSUS_TEST_PATH, 'utf8'))
    // Floors (not exact pins): #5018's gate independently verified 13 files / 48 sites.
    // Growth may exceed these without touching this file; a scanner or parser collapse
    // (the empty-read trap) or a census shrink below the landed population goes red.
    expect(discovered.size).toBeGreaterThanOrEqual(GATE_VERIFIED_MIN_FILES)
    expect(registry.size).toBeGreaterThanOrEqual(GATE_VERIFIED_MIN_FILES)
    expect(totalSites(discovered)).toBeGreaterThanOrEqual(GATE_VERIFIED_MIN_SITES)
    expect(totalSites(registry)).toBeGreaterThanOrEqual(GATE_VERIFIED_MIN_SITES)
    // Structural real-number assertion: the two independent derivations agree exactly.
    expect(totalSites(discovered)).toBe(totalSites(registry))
    expect(discovered.size).toBe(registry.size)
  })

  it('SCANNER POSITIVE+NEGATIVE CONTROL (real filesystem): a planted unregistered caller IS discovered; comments, declarations and call-free files are NOT', () => {
    const root = makeFixtureTree({
      'routes/zz-new-surface.ts': [
        "import { sendIfRecoveryConflict } from '../db/recovery-conflict'",
        'export function handler(res: never, error: never): void {',
        '  if (sendIfRecoveryConflict(res, error)) return',
        '}',
        '',
      ].join('\n'),
      // A comment-only mention must not be discovered.
      'routes/zz-comment-only.ts': '// sendIfRecoveryConflict(res, error)\nexport const x = 1\n',
      // A local wrapper DECLARATION alone must not be discovered.
      'routes/zz-declaration-only.ts':
        'function sendIfRecoveryAuthorityBusy(res: never, error: never): boolean { return false }\n',
      // A token-free file must not be discovered.
      'services/zz-unrelated.ts': 'export const y = 2\n',
      // The classifier module itself is excluded even when it contains calls.
      'db/recovery-conflict.ts': 'export function f(): void { classifyRecoveryConflict(null) }\n',
    })
    const discovered = scanAdapterCallSites(root)
    expect([...discovered.keys()]).toEqual(['routes/zz-new-surface.ts'])
    expect(discovered.get('routes/zz-new-surface.ts')).toEqual(
      new Map([['sendIfRecoveryConflict', 1]]),
    )

    // And the audit REDS on it: the planted caller has no census row.
    const registry = parseRegisteredCensus(readFileSync(CENSUS_TEST_PATH, 'utf8'))
    const violations = closedWorldViolations(
      new Map([...scanAdapterCallSites(SRC_ROOT), ...discovered]),
      registry,
    )
    expect(violations).toEqual([
      expect.stringContaining('routes/zz-new-surface.ts: UNREGISTERED caller'),
    ])
  })

  it('NEGATIVE CONTROL: a census row whose file stops calling turns the audit red (both absence directions are load-bearing)', () => {
    const discovered = scanAdapterCallSites(SRC_ROOT)
    const registry = parseRegisteredCensus(readFileSync(CENSUS_TEST_PATH, 'utf8'))
    // Anchor first (无效mutation教训): the row we remove must genuinely be discovered.
    expect(discovered.has('routes/roles.ts')).toBe(true)
    const mutated = new Map(discovered)
    mutated.delete('routes/roles.ts')
    const violations = closedWorldViolations(mutated, registry)
    expect(violations).toEqual([
      expect.stringContaining('routes/roles.ts: registered in WIRING_CENSUS but the scanner found no adapter calls'),
    ])
  })

  it('NEGATIVE CONTROL: a call-count drift (new site in an ALREADY-registered file) turns the audit red', () => {
    const discovered = scanAdapterCallSites(SRC_ROOT)
    const registry = parseRegisteredCensus(readFileSync(CENSUS_TEST_PATH, 'utf8'))
    const counts = discovered.get('routes/roles.ts')
    expect(counts).toBeDefined()
    const current = (counts as TokenCounts).get('sendIfRecoveryConflict')
    expect(current).toBeGreaterThan(0)
    const mutated = new Map(discovered)
    mutated.set(
      'routes/roles.ts',
      new Map([...(counts as TokenCounts), ['sendIfRecoveryConflict', (current as number) + 1]]),
    )
    const violations = closedWorldViolations(mutated, registry)
    expect(violations).toEqual([
      expect.stringContaining(`routes/roles.ts: sendIfRecoveryConflict has ${(current as number) + 1} call site(s)`),
    ])
  })

  it('PARSER POSITIVE CONTROL: a synthetic census source parses to exactly its rows and leg counts', () => {
    const synthetic = [
      'const WIRING_CENSUS: readonly WiringRequirement[] = [',
      '  {',
      "    file: 'routes/example.ts',",
      '    calls: [{',
      "      token: 'sendIfRecoveryConflict',",
      "      legs: [{ site: 'example:one', testFile: X }, { site: 'example:two', testFile: X }],",
      '    }],',
      '  },',
      '] as const',
    ].join('\n')
    const parsed = parseRegisteredCensus(synthetic)
    expect([...parsed.keys()]).toEqual(['routes/example.ts'])
    expect(parsed.get('routes/example.ts')).toEqual(new Map([['sendIfRecoveryConflict', 2]]))
  })

  it('PARSER FAIL-LOUD CONTROL: a source without a parseable WIRING_CENSUS throws instead of returning an empty registry', () => {
    expect(() => parseRegisteredCensus('export const nothingHere = 1')).toThrow(
      /WIRING_CENSUS table not found/,
    )
    expect(() =>
      parseRegisteredCensus('const WIRING_CENSUS = [\n] as const'),
    ).toThrow(/zero rows/)
  })
})
