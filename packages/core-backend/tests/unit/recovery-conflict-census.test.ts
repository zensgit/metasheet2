/**
 * O2-S2 / O2-A1 — MECHANICAL census: every enumerated 40001 write surface routes through
 * the ONE classifier module (src/db/recovery-conflict.ts), and every individual call
 * site is linked to a discriminating behaviour leg that PROVABLY EXECUTES.
 *
 * Lesson constraint (枚举陷阱不收敛): per-site try/catch traps do not converge, so the
 * gate is not "did we remember each trap" but a source-level census over a HARDCODED
 * table of the enumerated writers (now shared: tests/unit/lib/recovery-census-table.ts).
 *
 * O2-A1 upgrade: a token count alone proves PRESENCE, not reachability — `if (false &&
 * sendIfRecoveryConflict(...))` kept the old census green. The census therefore pins,
 * per row and per adapter token:
 *
 *   1. EXACT call-site count == the number of registered behaviour legs (a new call
 *      site without a registered leg turns this red — and so does deleting a site);
 *   2. declarations (`function <token>(`) never satisfy a count — only call sites do.
 *
 * P3-1 upgrade (adversarial gate, the L0 blocker) — LINKAGE NOW PROVES EXECUTION:
 * the previous linkage check was a TAG SUBSTRING test (`content.includes('[recovery-
 * census:<site>]')`). A tag is inert text, so a leg could be hollowed out while the
 * census stayed green. Both reproductions were replayed on this branch before the fix:
 *
 *   (i)  `it.skip` the roles:update leg + dead-branch src/routes/roles.ts:66
 *        → 7 files passed, "174 passed | 1 skipped", exit 0 — GREEN with a dead site.
 *   (ii) one `.only` in the rbac surfaces suite + dead-branch src/routes/roles.ts:43
 *        → 7 files passed, "156 passed | 19 skipped", exit 0 — GREEN with a dead site.
 *
 * The load-bearing gate is now RUNTIME, not textual: every tagged leg calls
 * `census.record('<site>')` as its last statement, and a file-level `afterAll` installed
 * by `censusFile()` asserts the EXECUTED site set equals that file's registered set
 * EXACTLY (missing OR extra reds it). `afterAll` still runs when tests are skipped by
 * `.only`/`.skip`, which is why the assertion lives in a hook and not in a final `it`.
 *
 * This file keeps the STATIC half — the inventory index that makes the per-site legs
 * mechanically complete — and adds three structural guards over the linked suites:
 *   - each leg's `census.record('<site>')` sits INSIDE its own tagged test body
 *     (bounded by the next test declaration), so a misplaced recorder cannot cover for
 *     a hollowed neighbour;
 *   - each linked suite imports the recorder and installs it under its OWN file name;
 *   - no focused/skipped test (`.only` / `.skip` / `.todo`) exists in this family.
 *
 * NIT-1 closure: routes/admin-users.ts's six platform-admin writer sites call the local
 * `sendIfRecoveryAuthorityBusy` wrapper (which delegates to sendIfRecoveryConflict), so
 * they are counted under their OWN token with six site-level legs — the single
 * delegation call inside the helper can no longer satisfy the row for all of them.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ADMUSR,
  RBAC,
  WIRING_CENSUS,
  allCensusLegs,
  censusSitesByTestFile,
  censusTestFiles,
} from './lib/recovery-census-table'
import {
  assertCensusCoverage,
  assertOwnedCensusSite,
  assertRegisteredCensusFile,
  censusCoverageViolations,
  expectedCensusSites,
} from './lib/recovery-census-recorder'

const SRC_ROOT = path.resolve(__dirname, '../../src')
const TESTS_ROOT = path.resolve(__dirname, '.')
const VITEST_CONFIG = path.resolve(__dirname, '../../vitest.config.ts')

/** The import specifier every census-linked suite must use for the runtime recorder. */
const RECORDER_SPECIFIER = './lib/recovery-census-recorder'

const IMPORT_RE = /from\s+['"][^'"]*\/db\/recovery-conflict['"]/

/** Comments must not satisfy the census — strip them before counting call tokens. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

/** A declaration is not a call — strip `function <token>(` before counting. */
function countCalls(strippedSource: string, token: string): number {
  const withoutDeclarations = strippedSource.replace(
    new RegExp(`\\bfunction\\s+${token}\\s*\\(`, 'g'),
    '',
  )
  const matches = withoutDeclarations.match(new RegExp(`\\b${token}\\s*\\(`, 'g'))
  return matches ? matches.length : 0
}

/**
 * A vitest test/suite declaration line, with its whole member chain captured so the
 * focus/skip scan can inspect the chain MECHANICALLY instead of enumerating spellings
 * (`it.only`, `describe.skip`, `it.concurrent.only`, …).
 */
const DECL_RE = /^\s*(?:it|test|describe|suite)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/
const DECL_SCAN_RE = /\b(?:it|test|describe|suite)((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/g

/** Chain members that suppress execution. `skipIf`/`runIf` are gating idioms, not bans. */
const EXECUTION_SUPPRESSING_MEMBERS = new Set(['only', 'skip', 'todo'])

/**
 * The ban scan runs over RAW source — deliberately NOT over `stripComments()` output.
 *
 * `stripComments` is a regex line-comment stripper with no string awareness, so
 * a focused declaration placed after `const note = 'see // below';` on ONE line had
 * its tail deleted and the focused declaration evaded the scan. That was proven live
 * on this branch before this note was written: the planted focused test produced
 * "25 passed" — a clean green over a hollowed-out suite.
 *
 * A string-aware stripper would just move the attack surface onto the stripper itself
 * (判据本身也要被攻击 — regex literals containing quotes reopen the same hole). Scanning
 * raw source has NO such surface: the scan is fail-closed by construction. The stated
 * cost is that a comment or string literally spelling out a banned declaration also
 * reds; that is the safe direction, and the fix is to reword it (this file's own header
 * was reworded for exactly that reason). It therefore builds its own
 * planted controls by concatenation (`${'it'}.only(` never matches, since `it` is
 * followed by a quote, not by the member chain).
 */

/**
 * The census core, over CONTENT (not paths) so the negative controls can run the exact
 * same logic against mutated copies. Returns human-readable violations; [] means wired.
 */
function auditRecoveryConflictWiring(contents: ReadonlyMap<string, string>): string[] {
  const violations: string[] = []
  for (const requirement of WIRING_CENSUS) {
    const source = contents.get(requirement.file)
    if (source === undefined) {
      violations.push(`${requirement.file}: MISSING from the provided content map`)
      continue
    }
    // Guard the scan itself (扫描窗口教训): an empty read is indistinguishable from an
    // unwired file, so fail loudly on it rather than counting zero occurrences.
    if (source.trim().length === 0) {
      violations.push(`${requirement.file}: EMPTY source — census scan itself is broken`)
      continue
    }
    if (!IMPORT_RE.test(source)) {
      violations.push(`${requirement.file}: no import from db/recovery-conflict`)
    }
    const stripped = stripComments(source)
    for (const call of requirement.calls) {
      const count = countCalls(stripped, call.token)
      if (count !== call.legs.length) {
        violations.push(
          `${requirement.file}: expected exactly ${call.legs.length} call site(s) of `
          + `${call.token}() (one per registered behaviour leg), found ${count} — `
          + 'register a [recovery-census:<site>] leg for every call site',
        )
      }
    }
  }
  return violations
}

/**
 * STRUCTURAL row ↔ behaviour-leg linkage. Over CONTENT so the negative controls can run
 * the same logic on mutated copies.
 *
 * For every registered leg this requires, in its named test file:
 *   1. a `[recovery-census:<site>]` tag that sits on an actual test DECLARATION line
 *      (a tag in a comment or a bare string can no longer satisfy the census);
 *   2. a `census.record('<site>')` call inside THAT test's body — bounded above by the
 *      tag line and below by the next test declaration, so a recorder that drifted into
 *      a neighbouring test cannot cover for a hollowed leg.
 *
 * Text presence alone still proves nothing; the runtime `afterAll` coverage assertion
 * (tests/unit/lib/recovery-census-recorder.ts) is what proves the leg EXECUTED. This
 * structural half is what makes the runtime half unskippable and correctly attributed.
 */
function auditCensusLegLinkage(testContents: ReadonlyMap<string, string>): string[] {
  const violations: string[] = []
  const seenSites = new Set<string>()
  for (const leg of allCensusLegs()) {
    if (seenSites.has(leg.site)) {
      violations.push(`${leg.site}: DUPLICATE site id in the census table`)
      continue
    }
    seenSites.add(leg.site)
    const content = testContents.get(leg.testFile)
    if (content === undefined) {
      violations.push(`${leg.site}: linked test file ${leg.testFile} MISSING from the content map`)
      continue
    }
    if (content.trim().length === 0) {
      violations.push(`${leg.site}: linked test file ${leg.testFile} is EMPTY — linkage scan broken`)
      continue
    }
    const lines = content.split('\n')
    const tag = `[recovery-census:${leg.site}]`
    const tagLine = lines.findIndex((line) => line.includes(tag) && DECL_RE.test(line))
    if (tagLine === -1) {
      violations.push(
        `${leg.site}: no test DECLARATION tagged ${tag} in ${leg.testFile}`,
      )
      continue
    }
    let bodyEnd = lines.length
    for (let i = tagLine + 1; i < lines.length; i += 1) {
      if (DECL_RE.test(lines[i])) {
        bodyEnd = i
        break
      }
    }
    const recordRe = new RegExp(
      `\\bcensus\\s*\\.\\s*record\\s*\\(\\s*'${leg.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*\\)`,
    )
    const recorded = lines
      .slice(tagLine, bodyEnd)
      .some((line) => recordRe.test(line))
    if (!recorded) {
      violations.push(
        `${leg.site}: the tagged leg in ${leg.testFile} does not call `
        + `census.record('${leg.site}') inside its OWN body — runtime execution of this `
        + 'site is therefore unproven',
      )
    }
  }
  return violations
}

/**
 * The runtime recorder must actually be installed, under the file's OWN name. Without
 * this, deleting the `censusFile(...)` binding would remove the execution proof (every
 * `census.record` would become a ReferenceError, but only for legs that still run).
 */
function auditRecorderInstallation(testContents: ReadonlyMap<string, string>): string[] {
  const violations: string[] = []
  for (const testFile of censusTestFiles()) {
    const content = testContents.get(testFile)
    if (content === undefined || content.trim().length === 0) {
      violations.push(`${testFile}: MISSING or EMPTY — recorder-installation scan broken`)
      continue
    }
    const stripped = stripComments(content)
    const importRe = new RegExp(
      `import\\s*\\{[^}]*\\bcensusFile\\b[^}]*\\}\\s*from\\s*['"]${RECORDER_SPECIFIER}['"]`,
    )
    if (!importRe.test(stripped)) {
      violations.push(
        `${testFile}: does not import { censusFile } from '${RECORDER_SPECIFIER}'`,
      )
    }
    const installRe = new RegExp(`\\bcensusFile\\s*\\(\\s*'${testFile.replace(/\./g, '\\.')}'\\s*\\)`)
    if (!installRe.test(stripped)) {
      violations.push(
        `${testFile}: does not install the runtime coverage hook via censusFile('${testFile}')`,
      )
    }
  }
  return violations
}

/**
 * Mechanical focus/skip ban over the whole census family (this file included).
 *
 * Deliberately NOT an enumeration of spellings: it walks every `it|test|describe|suite`
 * member chain in the source and reds on any member that suppresses execution. Gating
 * idioms (`skipIf`, `runIf`) and data-driven idioms (`each`) are untouched.
 */
function auditNoSuppressedTests(testContents: ReadonlyMap<string, string>): string[] {
  const violations: string[] = []
  for (const [file, content] of testContents) {
    if (content.trim().length === 0) {
      violations.push(`${file}: EMPTY — focus/skip scan broken`)
      continue
    }
    for (const match of content.matchAll(DECL_SCAN_RE)) {
      const members = match[1].split('.').map((part) => part.trim()).filter(Boolean)
      for (const member of members) {
        if (EXECUTION_SUPPRESSING_MEMBERS.has(member)) {
          violations.push(
            `${file}: focused/skipped test declaration \`${match[0].trim()}\` — `
            + `\`.${member}\` suppresses execution and would hollow out a census leg`,
          )
        }
      }
    }
  }
  return violations
}

/** Every quoted string literal in the vitest exclude arrays. */
function vitestExcludeEntries(configSource: string): string[] {
  return [...configSource.matchAll(/'([^'\n]+)'/g)].map((match) => match[1])
}

function isExcluded(entries: readonly string[], testFile: string): boolean {
  return entries.some((entry) => entry === testFile || entry.endsWith(`/${testFile}`))
}

function loadRealContents(): Map<string, string> {
  const contents = new Map<string, string>()
  for (const requirement of WIRING_CENSUS) {
    contents.set(requirement.file, readFileSync(path.join(SRC_ROOT, requirement.file), 'utf8'))
  }
  return contents
}

function loadRealTestContents(): Map<string, string> {
  const contents = new Map<string, string>()
  for (const testFile of censusTestFiles()) {
    contents.set(testFile, readFileSync(path.join(TESTS_ROOT, testFile), 'utf8'))
  }
  return contents
}

/** The census family for the focus/skip ban = the linked suites PLUS this file. */
function loadFocusScanContents(): Map<string, string> {
  const contents = loadRealTestContents()
  const self = 'recovery-conflict-census.test.ts'
  contents.set(self, readFileSync(path.join(TESTS_ROOT, self), 'utf8'))
  return contents
}

describe('O2-S2/O2-A1 recovery-conflict wiring census', () => {
  it('every enumerated write surface routes through the single classifier module, one call site per registered leg', () => {
    expect(auditRecoveryConflictWiring(loadRealContents())).toEqual([])
  })

  it('every census row is linked to a tagged behaviour leg that records its own execution', () => {
    expect(auditCensusLegLinkage(loadRealTestContents())).toEqual([])
  })

  it('every census-linked suite installs the runtime coverage hook under its own file name', () => {
    expect(auditRecorderInstallation(loadRealTestContents())).toEqual([])
  })

  it('no focused or skipped test declaration exists anywhere in the census family', () => {
    expect(auditNoSuppressedTests(loadFocusScanContents())).toEqual([])
  })

  it('no census-linked suite is excluded from the default vitest run', () => {
    const config = readFileSync(VITEST_CONFIG, 'utf8')
    expect(config.trim().length).toBeGreaterThan(0)
    const entries = vitestExcludeEntries(config)
    // Positive control for the scan itself: a file that IS excluded must be detected,
    // otherwise "nothing is excluded" could just mean the parse returned nothing.
    expect(entries.length).toBeGreaterThan(0)
    expect(isExcluded(entries, 'admin-users.api.test.ts')).toBe(true)
    const excluded = censusTestFiles().filter((file) => isExcluded(entries, file))
    expect(excluded).toEqual([])
  })

  it('NEGATIVE CONTROL: fully unwiring one surface turns the census red', () => {
    const contents = loadRealContents()
    const target = 'routes/roles.ts'
    const original = contents.get(target) as string
    // Mutation anchor: the wiring must actually be present before we strip it —
    // otherwise this control proves nothing (无效mutation教训).
    expect(original).toMatch(/\bsendIfRecoveryConflict\b/)

    const mutated = original.replace(/\bsendIfRecoveryConflict\b/g, 'neverClassifiedHere')
    expect(mutated).not.toBe(original)
    contents.set(target, mutated)

    const violations = auditRecoveryConflictWiring(contents)
    expect(violations.some((entry) => entry.startsWith(`${target}:`))).toBe(true)
    // And ONLY that surface regressed — the control must not pass by breaking the world.
    expect(violations.filter((entry) => !entry.startsWith(`${target}:`))).toEqual([])
  })

  it('NEGATIVE CONTROL: dropping a single call site from a multi-site surface turns the census red', () => {
    const contents = loadRealContents()
    const target = 'routes/attendance-admin.ts'
    const original = contents.get(target) as string
    const callRe = /\bsendIfRecoveryConflict\s*\(/
    expect(callRe.test(stripComments(original))).toBe(true)

    // Neutralize exactly one call site (rename its identifier; the import stays).
    const mutated = original.replace(callRe, 'sendIfRecoveryConflictDisabled(')
    expect(mutated).not.toBe(original)
    contents.set(target, mutated)

    const violations = auditRecoveryConflictWiring(contents)
    expect(
      violations.some((entry) =>
        entry.startsWith(`${target}:`) && entry.includes('sendIfRecoveryConflict'),
      ),
    ).toBe(true)
  })

  it('NEGATIVE CONTROL: a NEW call site without a registered behaviour leg turns the census red', () => {
    const contents = loadRealContents()
    const target = 'routes/roles.ts'
    const original = contents.get(target) as string
    expect(countCalls(stripComments(original), 'sendIfRecoveryConflict')).toBe(3)

    // A hypothetical new handler adds a 4th call site but nobody registers a leg.
    const mutated = `${original}\nexport function newHandlerHook(res: never, error: never) { if (sendIfRecoveryConflict(res, error)) return }\n`
    contents.set(target, mutated)

    const violations = auditRecoveryConflictWiring(contents)
    expect(
      violations.some((entry) =>
        entry.startsWith(`${target}:`)
        && entry.includes('found 4')
        && entry.includes('behaviour leg'),
      ),
    ).toBe(true)
  })

  it('NEGATIVE CONTROL: a declaration cannot satisfy a site count (only call sites count)', () => {
    // The helper's own declaration line must be inert…
    expect(countCalls('function sendIfRecoveryAuthorityBusy(res: Response, error: unknown): boolean {', 'sendIfRecoveryAuthorityBusy')).toBe(0)
    // …while a real call site still counts (positive control for the counter).
    expect(countCalls('if (sendIfRecoveryAuthorityBusy(res, error)) return', 'sendIfRecoveryAuthorityBusy')).toBe(1)
    // And the REAL admin-users source counts exactly its six writer sites, not seven
    // (six calls + one declaration).
    const source = stripComments(
      readFileSync(path.join(SRC_ROOT, 'routes/admin-users.ts'), 'utf8'),
    )
    expect(countCalls(source, 'sendIfRecoveryAuthorityBusy')).toBe(6)
  })

  it('NEGATIVE CONTROL: a comment cannot satisfy the census (call counting ignores comments)', () => {
    const stripped = stripComments(
      '// sendIfRecoveryConflict(res, error)\n/* translateRecoveryConflict(() => op()) */\nconst x = 1\n',
    )
    expect(countCalls(stripped, 'sendIfRecoveryConflict')).toBe(0)
    expect(countCalls(stripped, 'translateRecoveryConflict')).toBe(0)
    // Positive control for the counter itself.
    expect(countCalls('await sendIfRecoveryConflict(res, error)', 'sendIfRecoveryConflict')).toBe(1)
  })

  it('NEGATIVE CONTROL: deleting a behaviour-leg tag from its test file turns the linkage audit red', () => {
    const testContents = loadRealTestContents()
    const tag = '[recovery-census:roles:update]'
    const original = testContents.get(RBAC) as string
    // Anchor: the tag must exist before we delete it.
    expect(original.includes(tag)).toBe(true)

    testContents.set(RBAC, original.replace(tag, ''))
    const violations = auditCensusLegLinkage(testContents)
    expect(violations).toEqual([
      `roles:update: no test DECLARATION tagged ${tag} in ${RBAC}`,
    ])
  })

  it('NEGATIVE CONTROL: deleting a leg’s census.record(...) call turns the linkage audit red', () => {
    const testContents = loadRealTestContents()
    const original = testContents.get(RBAC) as string
    const call = "census.record('roles:update')"
    // Anchor: the recorder call must exist before we delete it.
    expect(original.includes(call)).toBe(true)

    testContents.set(RBAC, original.replace(call, ''))
    const violations = auditCensusLegLinkage(testContents)
    expect(violations.length).toBe(1)
    expect(violations[0]).toContain('roles:update')
    expect(violations[0]).toContain("does not call census.record('roles:update') inside its OWN body")
  })

  it('NEGATIVE CONTROL: a recorder call that drifts into the NEXT test cannot satisfy its own leg', () => {
    const testContents = loadRealTestContents()
    const original = testContents.get(RBAC) as string
    const lines = original.split('\n')
    const call = "census.record('roles:update')"
    const callLine = lines.findIndex((line) => line.includes(call))
    expect(callLine).toBeGreaterThan(-1)
    // Move it out of its own body into the FOLLOWING test — text presence is unchanged,
    // so only a body-bounded (structural) check can tell the difference.
    const nextDecl = lines.findIndex((line, index) => index > callLine && DECL_RE.test(line))
    expect(nextDecl).toBeGreaterThan(callLine)
    const moved = [...lines]
    moved.splice(callLine, 1)
    moved.splice(nextDecl, 0, `    ${call}`)
    const mutated = moved.join('\n')
    expect(mutated.includes(call)).toBe(true) // still textually present…
    expect(mutated).not.toBe(original)

    testContents.set(RBAC, mutated)
    const violations = auditCensusLegLinkage(testContents)
    // …yet the leg is now unproven.
    expect(violations.length).toBe(1)
    expect(violations[0]).toContain('roles:update')
    expect(violations[0]).toContain('inside its OWN body')
  })

  it('NEGATIVE CONTROL: a tag in a COMMENT cannot satisfy the linkage audit', () => {
    const testContents = loadRealTestContents()
    const original = testContents.get(RBAC) as string
    const lines = original.split('\n')
    const tagLine = lines.findIndex(
      (line) => line.includes('[recovery-census:roles:update]') && DECL_RE.test(line),
    )
    expect(tagLine).toBeGreaterThan(-1)
    // Demote the real declaration's tag, and leave the tag behind in a comment.
    lines[tagLine] = lines[tagLine].replace('[recovery-census:roles:update]', 'PUT role')
    lines.splice(tagLine, 0, '  // [recovery-census:roles:update] handled below')
    const mutated = lines.join('\n')
    expect(mutated.includes('[recovery-census:roles:update]')).toBe(true)

    testContents.set(RBAC, mutated)
    const violations = auditCensusLegLinkage(testContents)
    expect(violations.some((entry) => entry.startsWith('roles:update: no test DECLARATION tagged'))).toBe(true)
  })

  it('NEGATIVE CONTROL: removing the censusFile(...) installation turns the installation audit red', () => {
    const testContents = loadRealTestContents()
    const original = testContents.get(RBAC) as string
    const install = `censusFile('${RBAC}')`
    expect(original.includes(install)).toBe(true)

    testContents.set(RBAC, original.replace(install, 'noopRecorder()'))
    const violations = auditRecorderInstallation(testContents)
    expect(violations).toEqual([
      `${RBAC}: does not install the runtime coverage hook via censusFile('${RBAC}')`,
    ])
  })

  it('NEGATIVE CONTROL: installing under ANOTHER suite’s file name turns the installation audit red', () => {
    const testContents = loadRealTestContents()
    const original = testContents.get(RBAC) as string
    testContents.set(RBAC, original.replace(`censusFile('${RBAC}')`, `censusFile('${ADMUSR}')`))
    const violations = auditRecorderInstallation(testContents)
    expect(violations).toEqual([
      `${RBAC}: does not install the runtime coverage hook via censusFile('${RBAC}')`,
    ])
  })

  it('NEGATIVE CONTROL: a planted focused/skipped declaration is caught, and the gating idioms are not', () => {
    // Built by concatenation so this file never literally contains a banned declaration
    // (the scanner runs over this file too).
    const focused = `${'it'}.only('planted', () => {})`
    const skipped = `${'describe'}.skip('planted', () => {})`
    const todo = `${'test'}.todo('planted')`
    const chained = `${'it'}.concurrent.only('planted', () => {})`
    for (const planted of [focused, skipped, todo, chained]) {
      const violations = auditNoSuppressedTests(new Map([['planted.test.ts', `${planted}\n`]]))
      expect(violations.length).toBe(1)
      expect(violations[0]).toContain('planted.test.ts')
      expect(violations[0]).toContain('suppresses execution')
    }
    // Positive control for the OTHER direction: plain and conditionally-gated
    // declarations must NOT be flagged, or the ban would be unusable and its green
    // would mean nothing.
    const allowed = [
      `${'it'}('plain', () => {})`,
      `${'describe'}.skipIf(false)('gated', () => {})`,
      `${'it'}.runIf(true)('gated', () => {})`,
      `${'it'}.each([1])('data %s', () => {})`,
    ]
    for (const source of allowed) {
      expect(auditNoSuppressedTests(new Map([['planted.test.ts', `${source}\n`]]))).toEqual([])
    }
  })

  it('NEGATIVE CONTROL: a focused declaration hidden behind a // inside a STRING is still caught', () => {
    // The evasion that a comment-stripping scan permits: the regex line-comment stripper
    // is not string-aware, so it deletes from the `//` to end of line and eats the
    // declaration. Proven live on this branch (planted `it.only` → "25 passed") before
    // the scan was moved onto raw source.
    const evasion = `const note = 'see // below'; ${'it'}.only('planted', () => { void note })\n`
    const violations = auditNoSuppressedTests(new Map([['planted.test.ts', evasion]]))
    expect(violations.length).toBe(1)
    expect(violations[0]).toContain('suppresses execution')
    // The stripper this scan used to depend on really does destroy that line — this is
    // the mechanism of the evasion, asserted rather than asserted-about.
    expect(stripComments(evasion)).not.toContain('only')
    // Positive control for the same stripper on the shape it DOES handle (`://`).
    expect(stripComments(`const u = 'https://x/y'; ${'it'}.only('p', () => {})\n`)).toContain('only')
  })

  it('NEGATIVE CONTROL: excluding a census-linked suite from vitest would be caught', () => {
    const entries = vitestExcludeEntries("exclude: [\n  'tests/unit/recovery-conflict-surfaces-routes-rbac.test.ts',\n]")
    expect(isExcluded(entries, RBAC)).toBe(true)
    // Positive control: an unrelated exclude entry must NOT match.
    expect(isExcluded(vitestExcludeEntries("['tests/unit/some-other.test.ts']"), RBAC)).toBe(false)
  })
})

/**
 * P3-1 — the RUNTIME mechanism itself under attack. These pin the fail-closed predicate
 * that the per-file `afterAll` hook calls; neutering `censusCoverageViolations` (return
 * `[]`) or `assertCensusCoverage` (make it a no-op) turns this block red.
 */
describe('P3-1 runtime census recorder — the execution-proof mechanism', () => {
  it('the census table and the recorder agree on which sites each suite owns', () => {
    const byFile = censusSitesByTestFile()
    expect(byFile.size).toBeGreaterThan(0)
    let total = 0
    for (const testFile of censusTestFiles()) {
      const sites = expectedCensusSites(testFile)
      expect(sites).toBeDefined()
      expect([...(sites as ReadonlySet<string>)].sort()).toEqual([...(byFile.get(testFile) as ReadonlySet<string>)].sort())
      total += (sites as ReadonlySet<string>).size
    }
    // The whole enumerated surface: 48 call sites ⇒ 48 registered legs, no duplicates.
    expect(total).toBe(allCensusLegs().length)
    expect(new Set(allCensusLegs().map((leg) => leg.site)).size).toBe(total)
    expect(total).toBe(48)
  })

  it('a COMPLETE executed set is clean (positive control for the coverage predicate)', () => {
    const sites = [...(expectedCensusSites(RBAC) as ReadonlySet<string>)]
    expect(sites.length).toBeGreaterThan(1)
    expect(censusCoverageViolations(RBAC, sites)).toEqual([])
    expect(() => assertCensusCoverage(RBAC, sites)).not.toThrow()
  })

  it('a MISSING site (skipped / focused-out / deleted leg) reds, naming that exact site', () => {
    const sites = [...(expectedCensusSites(RBAC) as ReadonlySet<string>)]
    const dropped = 'roles:update'
    expect(sites).toContain(dropped)
    const partial = sites.filter((site) => site !== dropped)

    const violations = censusCoverageViolations(RBAC, partial)
    expect(violations.length).toBe(1)
    expect(violations[0]).toContain(`census site "${dropped}" was NEVER executed`)
    expect(() => assertCensusCoverage(RBAC, partial)).toThrowError(
      new RegExp(`census site "${dropped}" was NEVER executed`),
    )
  })

  it('EVERY registered leg is individually load-bearing: dropping any one site reds its own file', () => {
    // Mechanical sweep over the exported table (遍历导出表的机械断言) — not a spot check.
    let checked = 0
    for (const testFile of censusTestFiles()) {
      const sites = [...(expectedCensusSites(testFile) as ReadonlySet<string>)]
      for (const dropped of sites) {
        const violations = censusCoverageViolations(
          testFile,
          sites.filter((site) => site !== dropped),
        )
        expect(violations.length).toBe(1)
        expect(violations[0]).toContain(`"${dropped}" was NEVER executed`)
        checked += 1
      }
    }
    expect(checked).toBe(48)
  })

  it('an EXTRA / foreign recorded site reds too (the set comparison is exact, not a subset test)', () => {
    const sites = [...(expectedCensusSites(RBAC) as ReadonlySet<string>)]
    const violations = censusCoverageViolations(RBAC, [...sites, 'admin-users:status'])
    expect(violations.length).toBe(1)
    expect(violations[0]).toContain('recorded UNREGISTERED census site "admin-users:status"')
  })

  it('an UNREGISTERED file name can never be vacuously green', () => {
    const violations = censusCoverageViolations('not-a-census-suite.test.ts', [])
    expect(violations.length).toBe(1)
    expect(violations[0]).toContain('NOT a registered census test file')
    expect(() => assertCensusCoverage('not-a-census-suite.test.ts', [])).toThrowError(
      /NOT a registered census test file/,
    )
    // And the collection-time guard refuses to hand back a recorder at all.
    expect(() => assertRegisteredCensusFile('not-a-census-suite.test.ts')).toThrowError(
      /not a registered census test file/,
    )
    // Positive control: a real one is accepted.
    expect(assertRegisteredCensusFile(RBAC).size).toBeGreaterThan(0)
  })

  it('a suite cannot record a site that belongs to another suite', () => {
    const expected = assertRegisteredCensusFile(RBAC)
    expect(() => assertOwnedCensusSite(RBAC, expected, 'admin-users:status')).toThrowError(
      /is not registered to this file/,
    )
    // Positive control: its own site is accepted.
    expect(() => assertOwnedCensusSite(RBAC, expected, 'roles:update')).not.toThrow()
  })
})
