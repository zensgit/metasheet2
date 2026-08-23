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
 *
 * P3-1 upgrade (round-3 adversarial gate, T1) — ONE TAG PER DECLARATION: neither the
 * per-file tag-uniqueness count nor the runtime `currentTestName`-binding stops a SINGLE
 * declaration from carrying TWO different sites' tags in its own name — delete the real
 * `roles:delete` leg outright, graft its tag onto the surviving `roles:update` leg's
 * name, and record both sites from that one running test: each tag still occurs exactly
 * once file-wide, and `currentTestName` legitimately contains both tags, so one PUT test
 * now "proves" a DELETE site whose production call site is dead underneath it. Measured
 * GREEN, 7 files, 200/200, exit 0, before this closure. `auditCensusLegLinkage` now also
 * asserts each tagged declaration's own line carries exactly one census tag.
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
  assertRecordedFromOwnTaggedLeg,
  assertRegisteredCensusFile,
  censusCoverageViolations,
  expectedCensusSites,
} from './lib/recovery-census-recorder'

const SRC_ROOT = path.resolve(__dirname, '../../src')
const TESTS_ROOT = path.resolve(__dirname, '.')
const VITEST_CONFIG = path.resolve(__dirname, '../../vitest.config.ts')

/** The import specifier every census-linked suite must use for the runtime recorder. */
const RECORDER_SPECIFIER = './lib/recovery-census-recorder'

/**
 * Which module DECLARES each classifier entry point a census row may be registered on.
 *
 * The census's property is "every enumerated write surface routes through the classifier",
 * so the import check must be keyed to the module that OWNS the token the row is registered
 * on — not to one hardcoded path. Until the O2-D1 denominator slice every registered token
 * came from db/recovery-conflict.ts, which made a single file-level regex INDISTINGUISHABLE
 * from the real rule. It stopped being indistinguishable when routes/univer-meta.ts and
 * auth/AuthService.ts entered the denominator: both classify with
 * `isRecoveryAuthorityBusyError`, which recovery-authorization-stability.ts declares.
 *
 * routes/admin-users.ts's `sendIfRecoveryAuthorityBusy` maps to the classifier module
 * because it is a file-local alias whose body is exactly one unconditional delegation to
 * `sendIfRecoveryConflict` — the file still imports the classifier (that delegation is
 * pinned by extractFunctionBody below).
 *
 * Fail-closed: a row registered on a token absent from this map is itself a violation, so a
 * new classifier entry point cannot be registered without declaring where it lives.
 */
const CLASSIFIER_DECL_MODULE = 'db/recovery-conflict'
const STABILITY_DECL_MODULE = 'multitable/recovery-authorization-stability'

const TOKEN_DECL_MODULE: ReadonlyMap<string, string> = new Map([
  ['classifyRecoveryConflict', CLASSIFIER_DECL_MODULE],
  ['translateRecoveryConflict', CLASSIFIER_DECL_MODULE],
  ['sendIfRecoveryConflict', CLASSIFIER_DECL_MODULE],
  ['sendIfRecoveryAuthorityBusy', CLASSIFIER_DECL_MODULE],
  ['isRecoveryAuthorityBusyError', STABILITY_DECL_MODULE],
])

function importReFor(moduleTail: string): RegExp {
  return new RegExp(`from\\s+['"][^'"]*/${moduleTail}['"]`)
}

/**
 * P3-1 (round-3 adversarial gate, T1) — matches ANY `[recovery-census:<site>]` tag
 * substring, not scoped to one particular site. Used to count how many tags sit on a
 * single tagged declaration's line (see `auditCensusLegLinkage` below).
 */
const ANY_CENSUS_TAG_RE = /\[recovery-census:[^\]]+\]/g

/**
 * P3-1 (round-3 gate, T1) — a CLOSED, hand-reviewed allowlist of the only site pairs
 * legitimately allowed to share one declaration. This is not a general permission for
 * "two tags is fine sometimes": every entry here must be a pair of DIFFERENT ADAPTER
 * TOKENS where the outer call site's own implementation UNCONDITIONALLY invokes the
 * inner one, so hitting one call site in a running test deterministically also runs
 * the other — not two independent, mutually-exclusive call sites (which is exactly
 * what the T1 counterexample forges by grafting a dead `roles:delete` tag onto the
 * unrelated, mutually-exclusive `roles:update` leg).
 *
 * Today's one member: `sendIfRecoveryAuthorityBusy` (registered site-by-site, six
 * legs including `admin-users:role-assign` — the NIT-1 upgrade above) delegates, as
 * its own single internal statement, to `sendIfRecoveryConflict` (the ONE call site
 * registered as `admin-users:busy-delegation`) — see that row's own comment in
 * tests/unit/lib/recovery-census-table.ts. Exercising the role-assign route therefore
 * genuinely, unconditionally runs both call sites in the same request, which is why
 * `admin-users-routes.test.ts`'s one test for it carries both tags and records both
 * sites — verified to be the ONLY multi-tag declaration in the pristine census family
 * (checked by direct grep over every linked suite before this allowlist was written).
 *
 * A new multi-tag declaration NOT listed here reds — adding one requires a human to
 * add it here explicitly, alongside the same delegation justification.
 *
 * NIT-2 (round-4 gate): the "unconditionally invokes the inner one" claim above is
 * PINNED, not just prose — see the `NIT-2 (round-4 gate) — the allowlisted delegation
 * is pinned, not just asserted in prose` describe block further down in this file. It
 * reads the REAL `sendIfRecoveryAuthorityBusy` body and reds if it ever grows a branch
 * or guard (or loses the delegation), which is exactly the condition this entry's
 * justification requires and which nothing before NIT-2 mechanically checked.
 */
const ALLOWED_MULTI_TAG_SITE_SETS: readonly (readonly string[])[] = [
  ['admin-users:busy-delegation', 'admin-users:role-assign'],
]

/** Whether every tag on one declaration line matches an entry in the allowlist above. */
function isAllowedMultiTagDeclaration(tags: readonly string[]): boolean {
  const sites = tags
    .map((entry) => entry.slice('[recovery-census:'.length, -1))
    .slice()
    .sort()
    .join(' ')
  return ALLOWED_MULTI_TAG_SITE_SETS.some(
    (allowed) => [...allowed].sort().join(' ') === sites,
  )
}

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
 * NIT-2 (round-4 adversarial gate) — extracts the exact body text of a top-level named
 * function declaration (`function <name>(...) { ... }`), using BRACE BALANCING rather
 * than a lazy regex, so a nested `{ }` inside the body cannot truncate the match early.
 * Used to pin `sendIfRecoveryAuthorityBusy`'s body as EXACTLY the single unconditional
 * delegation statement the multi-tag allowlist's rationale depends on (see
 * `ALLOWED_MULTI_TAG_SITE_SETS` below and its "pinned by" pointer) — a substring check
 * would still match `if (x) return sendIfRecoveryConflict(res, error)`, so the caller
 * must compare against the WHOLE returned body, not merely check it `.includes(...)`.
 */
function extractFunctionBody(source: string, name: string): string {
  const declRe = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`)
  const match = declRe.exec(source)
  if (!match) {
    throw new Error(`extractFunctionBody: no declaration found for ${name}`)
  }
  const bodyStart = match.index + match[0].length
  let depth = 1
  let i = bodyStart
  while (depth > 0) {
    if (i >= source.length) {
      throw new Error(`extractFunctionBody: unbalanced braces scanning ${name}`)
    }
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(bodyStart, i - 1)
}

/**
 * A vitest test/suite declaration line, with its whole member chain captured so the
 * focus/skip scan can inspect the chain MECHANICALLY instead of enumerating spellings
 * (`it.only`, `describe.skip`, `it.concurrent.only`, …).
 */
const DECL_RE = /^\s*(?:it|test|describe|suite)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/

/**
 * P3-2 (adversarial gate) — the ban scan's chain must also see BRACKET-notation members,
 * quote-enclosed after `it`/`test`/`describe`/`suite` (e.g. a bracket spelling of
 * `.skip`), not just `.dot` ones: `DECL_SCAN_RE` used to require at least one DOTTED
 * member, so the bracket spelling on an UNTAGGED family test was invisible to it — a
 * real safety negative control silently disabled, "N passed | 1 skipped", exit 0.
 * `MEMBER_SEGMENT_RE` accepts either form per chain link; `DECL_SCAN_RE` requires at
 * least one link of EITHER form so a bracket-only chain still counts as "has a member
 * chain". `DECL_RE` (above) is left dot-only on purpose — it is what makes a
 * bracket-form TAGGED leg fail to read as "a test declaration" at all, which is the
 * existing (and still-wanted) incidental catch route for that case via the linkage
 * audit; widening it would only change which audit names the same violation.
 *
 * Deliberately NOT chasing fully computed member access (a variable holding the member
 * name, or a variable holding a reference to the suppressing function itself, called
 * later under a different name): no regex can resolve an arbitrary expression to "which
 * vitest member this is" without evaluating it, so trying converges nowhere (枚举陷阱不
 * 收敛) — the same reason the ban scans raw source instead of a stripped one. Literal
 * bracket notation (single- or double-quoted) is the concrete, closeable escape; the
 * fully-dynamic form is a disclosed residual, not a gap this regex claims to close.
 *
 * (This comment avoids spelling out the bracket examples literally — like the module
 * header above, doing so would make this very file trip its own ban scan.)
 */
const MEMBER_SEGMENT_RE = String.raw`(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:'[^']*'|"[^"]*")\s*\])`
const DECL_SCAN_RE = new RegExp(
  `\\b(?:it|test|describe|suite)((?:\\s*${MEMBER_SEGMENT_RE})+)\\s*\\(`,
  'g',
)
/** Pulls each member NAME out of a captured chain, dot or bracket form alike. */
const MEMBER_TOKEN_RE = /\.\s*([A-Za-z_$][\w$]*)|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]/g

/** Every member name in a captured chain string (`.only`, `['skip']`, `["todo"]`, …). */
function chainMembers(chain: string): string[] {
  const members: string[] = []
  for (const token of chain.matchAll(MEMBER_TOKEN_RE)) {
    const name = token[1] ?? token[2] ?? token[3]
    if (name) members.push(name)
  }
  return members
}

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
    const stripped = stripComments(source)
    for (const call of requirement.calls) {
      const declModule = TOKEN_DECL_MODULE.get(call.token)
      if (declModule === undefined) {
        violations.push(
          `${requirement.file}: ${call.token} has no declaring module registered in `
          + 'TOKEN_DECL_MODULE — declare where a new classifier entry point lives before '
          + 'registering census rows on it',
        )
      } else if (!importReFor(declModule).test(source)) {
        violations.push(
          `${requirement.file}: no import from ${declModule} (which declares ${call.token})`,
        )
      }
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
    // P3-1 (2nd adversarial gate) — a DECOY declaration carrying the SAME tag, placed
    // before the real leg, used to satisfy the `findIndex` below (first match) while
    // the real leg was neutered (`it.each([])`) and its production call site left dead:
    // the decoy's own `census.record(site)` ran, so the structural window check AND the
    // runtime `currentTestName`-contains-tag check were both satisfied by a test that
    // exercises nothing.
    //
    // The first fix for this counted DECL_RE-matching LINES, which is itself a name
    // enumeration in disguise: `DECL_RE` is anchored at line start
    // (`^\s*(?:it|test|describe|suite)…`), so a decoy called from inside another
    // expression — `[1].forEach(() => it(tag, …))`, a helper function, a loop body —
    // registers a real, running vitest test whose name still contains the tag while
    // being INVISIBLE to a line-anchored count. That is the exact recurrence this PR's
    // round-2 gate warned about: a newly-banned shape with an immediately unbanned
    // sibling. Counting RAW OCCURRENCES of the tag substring across the whole file
    // closes the family regardless of the calling shape around the `it(...)` — it is a
    // property of the file's CONTENT (how many times this literal string appears), not
    // of which lines are recognised as declarations, so no enumeration of calling forms
    // can evade it. A well-formed leg's tag appears exactly once — inside its own test
    // name — and nowhere else (verified over all 55 currently-registered legs).
    //
    // Disclosed residual, in the same spirit as the `MEMBER_SEGMENT_RE` comment above
    // ("the fully-dynamic form is a disclosed residual, not a gap this regex claims to
    // close"): this count is over the LITERAL tag substring. A decoy whose name is
    // ASSEMBLED rather than written out — `` it(`${'[recovery-census:roles'}:delete] decoy`,
    // …) `` — never puts the literal string in the file, so it is invisible to this
    // count too (confirmed: 8 files, 208/208, GREEN). No string-level scan converges
    // here — pinning the full registered NAME in the census table would only push the
    // identical residual one level deeper (a decoy assembling the full name defeats
    // that identically), so this is not chased further. What still constrains such a
    // decoy: it must live in THIS SAME registered file — `assertOwnedCensusSite` throws
    // on a cross-file attempt before the name check ever runs — and it is a visibly
    // bogus, hand-written test that a diff reviewer sees. The accepted cost in the
    // other direction, matching the raw-source ban-scan's own trade-off above: a
    // comment or string in a registered suite that spells out a tag literally also
    // reds here, and the fix is to reword it. Net: "a leg cannot satisfy its site
    // without executing" is now mechanically true against every CALLING-SHAPE evasion
    // (any idiom, any nesting) — it is NOT true against a NAME constructed to avoid the
    // literal, which remains a disclosed, human-reviewable residual.
    const tagOccurrences = content.split(tag).length - 1
    if (tagOccurrences > 1) {
      violations.push(
        `${leg.site}: tag ${tag} appears ${tagOccurrences} times in ${leg.testFile} — a `
        + 'second test carrying the same tag (in any calling shape) can satisfy the '
        + 'runtime binding while the real leg is suppressed; the tag must be unique per '
        + 'file',
      )
      continue
    }
    const tagLine = lines.findIndex((line) => line.includes(tag) && DECL_RE.test(line))
    if (tagLine === -1) {
      violations.push(
        `${leg.site}: no test DECLARATION tagged ${tag} in ${leg.testFile}`,
      )
      continue
    }
    // P3-1 (round-3 adversarial gate, T1) — a tagged DECLARATION must carry exactly ONE
    // `[recovery-census:<site>]` tag, UNLESS the exact set of tags on it is explicitly
    // allowlisted (`ALLOWED_MULTI_TAG_SITE_SETS` above) as a genuine nested call-site
    // pairing. The occurrence-count guard above (each tag unique FILE-WIDE) does not
    // stop a single test from carrying TWO different sites' tags in its own name:
    // delete the real `roles:delete` leg outright, graft its tag onto the SURVIVING
    // `roles:update` leg's declaration, and record both sites from inside that one
    // test. Each tag still occurs exactly once in the file (satisfies the guard above),
    // `assertRecordedFromOwnTaggedLeg` accepts BOTH `record()` calls because
    // `currentTestName` legitimately contains both tags, and one running PUT test now
    // "proves" the DELETE site while its production call site (`src/routes/roles.ts:91`)
    // is dead underneath it. Measured GREEN, 7 files, 200/200, exit 0, before this check
    // existed (round-2's structural window and round-2's occurrence count are both
    // satisfied; this is a NAMING shape, not a calling shape, and not a constructed
    // name — the prior guards have no row for "one declaration, two sites"). This is
    // NOT a blanket ban, though: `admin-users-routes.test.ts` has one PRISTINE
    // declaration carrying two tags for real (`admin-users:busy-delegation` +
    // `admin-users:role-assign` — a genuinely nested call site, see the allowlist's own
    // comment), which a blanket ban would have falsely flagged. The allowlist keeps the
    // check fail-closed for every OTHER combination while carving out that one, hand-
    // reviewed exception.
    const lineTags = lines[tagLine].match(ANY_CENSUS_TAG_RE) ?? []
    if (lineTags.length > 1 && !isAllowedMultiTagDeclaration(lineTags)) {
      violations.push(
        `${leg.site}: the tagged declaration in ${leg.testFile} carries ${lineTags.length} `
        + `census tags on one line (${lineTags.join(', ')}) — a single declaration may `
        + 'satisfy exactly ONE site (or an explicitly allowlisted nested pair; see '
        + 'ALLOWED_MULTI_TAG_SITE_SETS) — an unlisted extra tag lets one running test '
        + 'forge coverage for a leg that never executed',
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
      for (const member of chainMembers(match[1])) {
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

  it('NEGATIVE CONTROL (P3-1, 2nd adversarial gate): a DECOY declaration carrying the same tag turns the linkage audit red', () => {
    // A decoy test declaration tagged with the SAME site, placed BEFORE the real leg,
    // used to satisfy `findIndex` (first match) while the real leg was neutered
    // elsewhere — this pins the content-level occurrence-count guard directly,
    // independent of any particular suppression idiom on the real leg.
    const testContents = loadRealTestContents()
    const original = testContents.get(RBAC) as string
    const lines = original.split('\n')
    const tag = '[recovery-census:roles:update]'
    const tagLine = lines.findIndex((line) => line.includes(tag) && DECL_RE.test(line))
    expect(tagLine).toBeGreaterThan(-1)

    // Plant a second declaration carrying the identical tag, immediately before the
    // real one, that records the site itself — textually indistinguishable from a
    // second legitimate leg to anything that only checks "does A tagged declaration
    // exist" or "was the site recorded from within a line bearing this tag".
    const decoy = [
      `  it(${JSON.stringify(`${tag} decoy leg that exercises nothing`)}, () => {`,
      "    census.record('roles:update')",
      '  })',
      '',
    ]
    lines.splice(tagLine, 0, ...decoy)
    const mutated = lines.join('\n')
    expect(mutated).not.toBe(original)

    testContents.set(RBAC, mutated)
    const violations = auditCensusLegLinkage(testContents)
    expect(violations).toEqual([
      `roles:update: tag ${tag} appears 2 times in ${RBAC} — a second test carrying the `
      + 'same tag (in any calling shape) can satisfy the runtime binding while the real '
      + 'leg is suppressed; the tag must be unique per file',
    ])
  })

  it('NEGATIVE CONTROL (P3-1, 3rd adversarial pass): a decoy whose it(...) is NOT a DECL_RE-anchored line still turns the linkage audit red', () => {
    // The FIRST fix here counted DECL_RE-matching lines, which only recognises a
    // declaration anchored at the start of its line. A decoy invoked from inside
    // another expression — `[1].forEach(() => it(tag, ...))` — registers a real,
    // running vitest test whose name carries the tag while being invisible to that
    // line-anchored count: measured GREEN (8 files, 207/207, identical to the fixed
    // pristine baseline) before the occurrence-count widening below. This pins that the
    // guard now catches the tag regardless of the calling shape around `it(...)`.
    const testContents = loadRealTestContents()
    const original = testContents.get(RBAC) as string
    const lines = original.split('\n')
    const tag = '[recovery-census:roles:update]'
    const tagLine = lines.findIndex((line) => line.includes(tag) && DECL_RE.test(line))
    expect(tagLine).toBeGreaterThan(-1)

    const decoy = [
      `  ;[1].forEach(() => it(${JSON.stringify(`${tag} decoy`)}, () => census.record('roles:update')))`,
      '',
    ]
    // Sanity: this decoy line does NOT read as a DECL_RE declaration — that is exactly
    // the escape this test exists to close.
    expect(DECL_RE.test(decoy[0])).toBe(false)
    lines.splice(tagLine, 0, ...decoy)
    const mutated = lines.join('\n')
    expect(mutated).not.toBe(original)

    testContents.set(RBAC, mutated)
    const violations = auditCensusLegLinkage(testContents)
    expect(violations).toEqual([
      `roles:update: tag ${tag} appears 2 times in ${RBAC} — a second test carrying the `
      + 'same tag (in any calling shape) can satisfy the runtime binding while the real '
      + 'leg is suppressed; the tag must be unique per file',
    ])
  })

  it('NEGATIVE CONTROL (P3-1, round-3 adversarial gate T1): a declaration carrying TWO census tags for two different sites turns the linkage audit red', () => {
    // Round-3 gate counterexample, exactly: delete the real `roles:delete` leg outright
    // (so its tag occurs nowhere else), graft its tag onto the SURVIVING `roles:update`
    // leg's declaration name, and record both sites from inside that one running test.
    // Each tag still occurs exactly once in the file — the round-2 occurrence-count guard
    // above is satisfied — and `assertRecordedFromOwnTaggedLeg` would accept BOTH
    // `record()` calls, because `currentTestName` legitimately contains both tags (see
    // the "P3-1 (2nd gate) — record() binds to the RUNNING test" suite below: a
    // currentTestName that CONTAINS a tag satisfies that tag's own check). Measured
    // GREEN over a dead `src/routes/roles.ts:91` before this guard existed: 7 files,
    // 200/200, exit 0.
    const testContents = loadRealTestContents()
    const original = testContents.get(RBAC) as string
    const updateTag = '[recovery-census:roles:update]'
    const deleteTag = '[recovery-census:roles:delete]'

    // Delete the real roles:delete leg's whole body — the SAME structural bound the
    // audit itself uses (tag line through the next test declaration) — via the DECL_RE
    // boundary, not a hand-typed literal block, so this stays correct if the leg's
    // assertions are edited later.
    const lines = original.split('\n')
    const deleteTagLine = lines.findIndex((line) => line.includes(deleteTag) && DECL_RE.test(line))
    const updateTagLineBefore = lines.findIndex((line) => line.includes(updateTag) && DECL_RE.test(line))
    expect(deleteTagLine).toBeGreaterThan(-1)
    expect(updateTagLineBefore).toBeGreaterThan(deleteTagLine)
    let deleteLegEnd = lines.length
    for (let i = deleteTagLine + 1; i < lines.length; i += 1) {
      if (DECL_RE.test(lines[i])) {
        deleteLegEnd = i
        break
      }
    }
    // Sanity: the next declaration after the delete leg really is the update leg — this
    // is what makes grafting the tag onto it (below) the round-3 gate's exact shape.
    expect(deleteLegEnd).toBe(updateTagLineBefore)
    const withoutDeleteLeg = [...lines.slice(0, deleteTagLine), ...lines.slice(deleteLegEnd)]

    // Graft the deleted leg's tag onto roles:update's own declaration name, and record
    // both sites from inside that one surviving test.
    const updateTagLine = withoutDeleteLeg.findIndex(
      (line) => line.includes(updateTag) && DECL_RE.test(line),
    )
    expect(updateTagLine).toBeGreaterThan(-1)
    withoutDeleteLeg[updateTagLine] = withoutDeleteLeg[updateTagLine].replace(
      updateTag,
      `${updateTag} ${deleteTag}`,
    )
    const recordLine = withoutDeleteLeg.findIndex((line) => line.includes("census.record('roles:update')"))
    expect(recordLine).toBeGreaterThan(-1)
    withoutDeleteLeg.splice(recordLine + 1, 0, "    census.record('roles:delete')")

    const mutated = withoutDeleteLeg.join('\n')
    expect(mutated).not.toBe(original)
    // Sanity: this really does satisfy the round-2 guard alone — each tag occurs exactly
    // once, so ONLY the new one-tag-per-declaration check can catch this shape.
    expect(mutated.split(updateTag).length - 1).toBe(1)
    expect(mutated.split(deleteTag).length - 1).toBe(1)

    testContents.set(RBAC, mutated)
    const violations = auditCensusLegLinkage(testContents)
    // Both sites resolve to the SAME two-tag declaration, so both are flagged — each
    // violation names the offending declaration's site and BOTH tags found on its line.
    expect(violations.length).toBe(2)
    for (const site of ['roles:update', 'roles:delete']) {
      const violation = violations.find((entry) => entry.startsWith(`${site}:`))
      expect(violation).toBeDefined()
      expect(violation).toContain(RBAC)
      expect(violation).toContain('carries 2 census tags')
      expect(violation).toContain(updateTag)
      expect(violation).toContain(deleteTag)
    }
  })

  it('POSITIVE CONTROL: every REAL registered site has its tag exactly once in its file', () => {
    // The discriminating invariant the occurrence-count guard depends on: this is
    // NOT the same assertion as "linkage is clean overall" (which the pre-existing
    // "every census row is linked…" test already covers) — it isolates the specific
    // per-site occurrence count the new guard reads, over the REAL unmutated sources.
    const testContents = loadRealTestContents()
    const counts = allCensusLegs().map((leg) => {
      const content = testContents.get(leg.testFile) as string
      const tag = `[recovery-census:${leg.site}]`
      return { site: leg.site, occurrences: content.split(tag).length - 1 }
    })
    expect(counts.every((entry) => entry.occurrences === 1)).toBe(true)
    // And the guard itself agrees — no false positive on the pristine suite.
    expect(auditCensusLegLinkage(testContents)).toEqual([])
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

  it('P3-2 (adversarial gate): a BRACKET-notation focused/skipped declaration is caught, not just dot-notation', () => {
    // Built by concatenation so this file never literally contains a banned declaration
    // (the scanner runs over this file too) — same convention as the dot-notation
    // control above.
    const bracketSkipSingle = `${'it'}['skip']('planted', () => {})`
    const bracketOnlyDouble = `${'it'}["only"]('planted', () => {})`
    const bracketTodo = `${'test'}['todo']('planted')`
    const chainedDotThenBracket = `${'it'}.concurrent['only']('planted', () => {})`
    const chainedBracketThenDot = `${'it'}['concurrent'].only('planted', () => {})`
    for (const planted of [
      bracketSkipSingle,
      bracketOnlyDouble,
      bracketTodo,
      chainedDotThenBracket,
      chainedBracketThenDot,
    ]) {
      const violations = auditNoSuppressedTests(new Map([['planted.test.ts', `${planted}\n`]]))
      expect(violations.length).toBe(1)
      expect(violations[0]).toContain('planted.test.ts')
      expect(violations[0]).toContain('suppresses execution')
    }
    // Positive control for the OTHER direction: a bracket-notation chain with NO
    // suppressing member must NOT be flagged, or the widened scan would just red
    // everything bracket-shaped regardless of which member it names.
    const allowedBracket = [
      `${'it'}['concurrent']('gated', () => {})`,
      `${'describe'}["skipIf"](false)('gated', () => {})`,
    ]
    for (const source of allowedBracket) {
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
 * NIT-2 (round-4 adversarial gate) — the multi-tag allowlist's ONLY entry
 * (`ALLOWED_MULTI_TAG_SITE_SETS` above) is justified entirely by a PROSE claim: that
 * `sendIfRecoveryAuthorityBusy`'s body is a single, unconditional delegation to
 * `sendIfRecoveryConflict`, so hitting the outer call site (`admin-users:role-assign`)
 * necessarily also hits the inner one (`admin-users:busy-delegation`) in the SAME
 * request. Nothing before this block pinned that claim mechanically — a helper that
 * later grew a condition true under test and false in production (or true/false on any
 * input the census itself never varies) would leave the call-site COUNTS unchanged, so
 * `auditRecoveryConflictWiring` would stay green, and the allowlist entry would still
 * read as textually valid, while the pair silently stopped being genuinely co-executed
 * (注释断言≠不变量 — a comment is not a check).
 *
 * The criterion: extract the helper's REAL body (brace-balanced via
 * `extractFunctionBody`, not a lazy regex that a nested `{ }` could truncate early) and
 * assert it is EXACTLY the one-line delegation statement — not merely that it CONTAINS
 * that statement. A substring/`.includes()` check would still pass for `if (someFlag)
 * return sendIfRecoveryConflict(res, error)`, which is precisely the shape that would
 * break the allowlist's premise while looking unchanged to a substring test — so this
 * predicate compares the WHOLE trimmed body against the expected text.
 */
describe('NIT-2 (round-4 gate) — the allowlisted delegation is pinned, not just asserted in prose', () => {
  const EXPECTED_DELEGATION_BODY = 'return sendIfRecoveryConflict(res, error)'

  it("sendIfRecoveryAuthorityBusy's body is EXACTLY the single unconditional delegation (pins the ALLOWED_MULTI_TAG_SITE_SETS rationale)", () => {
    const source = stripComments(
      readFileSync(path.join(SRC_ROOT, 'routes/admin-users.ts'), 'utf8'),
    )
    const body = extractFunctionBody(source, 'sendIfRecoveryAuthorityBusy').trim()
    expect(body).toBe(EXPECTED_DELEGATION_BODY)
  })

  it('POSITIVE CONTROL: the extractor really reads the delegation body — not an accidental empty/whitespace match', () => {
    const source = stripComments(
      readFileSync(path.join(SRC_ROOT, 'routes/admin-users.ts'), 'utf8'),
    )
    const body = extractFunctionBody(source, 'sendIfRecoveryAuthorityBusy').trim()
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('sendIfRecoveryConflict')
  })

  it('NEGATIVE CONTROL: extractFunctionBody is brace-balanced — a nested object literal in the body does not truncate the match early', () => {
    const planted = 'function withNested(res, error) {\n  const cfg = { retry: { max: 1 } }\n  return sendIfRecoveryConflict(res, error)\n}\n'
    expect(extractFunctionBody(planted, 'withNested').trim()).toBe(
      'const cfg = { retry: { max: 1 } }\n  return sendIfRecoveryConflict(res, error)',
    )
  })

  it('NEGATIVE CONTROL: wrapping the delegation in a condition reds the pin — a substring check would NOT catch this', () => {
    const planted = 'function sendIfRecoveryAuthorityBusy(res, error) {\n  if (someFlag) return sendIfRecoveryConflict(res, error)\n  return false\n}\n'
    // Mutation anchor (无效mutation教训): this planted body must actually CONTAIN the
    // expected statement as a substring, proving a `.includes()` predicate would be
    // fooled by it — while the exact-match pin below is not.
    expect(planted).toContain(EXPECTED_DELEGATION_BODY)
    const body = extractFunctionBody(planted, 'sendIfRecoveryAuthorityBusy').trim()
    expect(body).not.toBe(EXPECTED_DELEGATION_BODY)
  })

  it('NEGATIVE CONTROL: removing the delegation entirely reds the pin', () => {
    const planted = 'function sendIfRecoveryAuthorityBusy(res, error) {\n  return false\n}\n'
    const body = extractFunctionBody(planted, 'sendIfRecoveryAuthorityBusy').trim()
    expect(body).not.toBe(EXPECTED_DELEGATION_BODY)
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
    // The whole enumerated surface: 55 call sites ⇒ 55 registered legs, no duplicates.
    // (48 until the O2-D1 denominator slice added univer-meta's 5 and AuthService's 2.)
    expect(total).toBe(allCensusLegs().length)
    expect(new Set(allCensusLegs().map((leg) => leg.site)).size).toBe(total)
    expect(total).toBe(55)
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
    expect(checked).toBe(55)
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

/**
 * P3-1 (2nd adversarial gate) — `assertRecordedFromOwnTaggedLeg` under direct attack.
 * Pins the exact class of counterexample the gate demonstrated over a real vitest run
 * (`it.each([])` + a record call moved past the leg's closing brace; `it.skipIf(true)`
 * + a `beforeEach` recorder): both satisfy the OLD source-window linkage check while the
 * leg never executes. This guard closes them by binding to
 * `expect.getState().currentTestName` instead of to source position, so these tests pin
 * the predicate directly rather than only through a full suite run (which the M6/M7
 * mutation-tested reproductions in the PR body additionally cover end to end).
 */
describe('P3-1 (2nd gate) — record() binds to the RUNNING test, not to source position', () => {
  it('a call from inside its own tagged leg is accepted (positive control)', () => {
    expect(() => assertRecordedFromOwnTaggedLeg(
      RBAC,
      'roles:update',
      `${RBAC} > routes/roles.ts > [recovery-census:roles:update] PUT /api/roles/:id: marker 40001 on the UPDATE → exact uniform retryable 409`,
    )).not.toThrow()
  })

  it('a call with NO test running (collection time) reds and says so — the it.each([]) + moved-record shape', () => {
    // This is exactly what `expect.getState().currentTestName` is when a
    // `census.record(...)` statement runs as a bare describe-body statement instead of
    // inside a test body — which is what an `it.each([] as unknown[])` leg (zero
    // registered instances) plus a record call moved past its closing `})` produces.
    expect(() => assertRecordedFromOwnTaggedLeg(RBAC, 'roles:update', undefined)).toThrowError(
      /was not called from inside its own tagged leg .*<no test running>/,
    )
  })

  it('a call from a DIFFERENT, currently-running test reds and NAMES that foreign test — the skipIf + beforeEach shape', () => {
    // This is what happens when a `beforeEach(() => { census.record(site) })` fires for
    // every OTHER test in the file because the tagged leg itself was `.skipIf(true)`-d.
    const foreignTest = `${RBAC} > routes/roles.ts > [recovery-census:roles:create] POST /api/roles: marker 40001 on the write → exact uniform retryable 409`
    expect(() => assertRecordedFromOwnTaggedLeg(RBAC, 'roles:update', foreignTest)).toThrowError(
      /was not called from inside its own tagged leg/,
    )
    try {
      assertRecordedFromOwnTaggedLeg(RBAC, 'roles:update', foreignTest)
      expect.unreachable('must throw')
    } catch (error) {
      expect(String(error)).toContain(foreignTest)
    }
  })

  it('a currentTestName that merely CONTAINS a different site’s tag does not satisfy this one', () => {
    // Guards against a sloppy substring match accepting any tagged test, not specifically
    // the one whose site is being recorded.
    expect(() => assertRecordedFromOwnTaggedLeg(
      RBAC,
      'roles:update',
      `${RBAC} > routes/roles.ts > [recovery-census:roles:create] POST /api/roles`,
    )).toThrowError(/was not called from inside its own tagged leg \[recovery-census:roles:update\]/)
  })
})
