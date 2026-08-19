/**
 * O2-A1 / P3-1 — RUNTIME leg recorder: linkage proves EXECUTION, not text presence.
 *
 * The defect this closes (adversarial gate P3-1, the L0 blocker): the census proved
 * row ↔ leg linkage by a TAG SUBSTRING check (`content.includes('[recovery-census:X]')`).
 * A tag is inert text, so a leg could be hollowed out while the census stayed green:
 *
 *   (i)  `it.skip` the roles:update leg + dead-branch src/routes/roles.ts:66
 *        → "174 passed | 1 skipped", exit 0 — GREEN with a dead call site.
 *   (ii) a single `.only` anywhere in a surfaces suite skipped 19 of 20 legs
 *        → "156 passed | 19 skipped", exit 0 — GREEN with a dead src/routes/roles.ts:43.
 *
 * The mechanism: every tagged leg calls `census.record('<site>')` as its LAST statement
 * (so it only runs when the leg's assertions passed), and a file-level `afterAll` hook —
 * installed by `censusFile()` at collection time — asserts that the set of sites actually
 * RECORDED during this file's run is EXACTLY the set the census table assigns to it.
 *
 * P3-1 residual (2nd adversarial gate, still against the L0 blocker) — a SOURCE-WINDOW
 * structural check ("record() sits between the tag line and the next test declaration")
 * is satisfiable WITHOUT the leg ever running, by moving the recorder call into a sibling
 * statement that shares the window:
 *
 *   (iii) `it.each([] as unknown[])(...)` registers ZERO test instances, so the tagged
 *         leg never runs; moving `census.record('roles:update')` one line down — past the
 *         leg's closing `})`, still inside the linkage window — runs it at COLLECTION
 *         time instead. Over a dead src/routes/roles.ts:66: exit 0, ALL FILES PASSED,
 *         0 skipped — no skip signal at all.
 *   (iv)  `it.skipIf(true)(...)` never runs the leg either; a `beforeEach(() => {
 *         census.record('roles:update') })` fires on every OTHER test in the file instead.
 *         Over the same dead call site: exit 0, "N passed | 1 skipped".
 *
 * `record()` therefore no longer trusts WHERE in the source it was called from — it binds
 * to vitest's own ground truth for "which test is executing right now",
 * `expect.getState().currentTestName`, and throws unless the running test's name contains
 * this exact `[recovery-census:<site>]` tag. A call from a hook, a describe-body
 * statement (collection time — no test is running, `currentTestName` is `undefined`), or
 * a neighbouring test can never satisfy that, regardless of which skip/data-driven idiom
 * suppressed the leg — so this closes the whole window/idiom family at once instead of
 * enumerating members to ban.
 *
 * Fail-closed properties, each one deliberate:
 *   - MISSING site  → skip / only / partial run / deleted leg  → the file reds.
 *   - EXTRA site    → a leg recording someone else's site       → the file reds.
 *   - unknown FILE  → `censusFile('typo.test.ts')` throws, so a copy-pasted installer
 *                     can never yield a vacuously empty expected set.
 *   - foreign SITE  → `record()` throws when the site is not owned by this file.
 *   - WRONG test    → `record()` throws unless the running test is the tagged leg itself.
 *   - deleted installer → every `census.record(...)` call becomes a ReferenceError.
 *
 * `afterAll` runs even when tests are skipped by `.only`/`.skip`, which is exactly why
 * the hook (not a final `it`) carries the assertion — a focused test cannot skip it.
 * Verified empirically under `pool: 'forks'` before this module was written.
 *
 * Why in-process and per-file rather than a cross-file registry: vitest's `forks` pool
 * gives each test FILE its own process, and file execution order is not deterministic,
 * so a shared registry read by a final census file would be a race. Per-file coverage is
 * deterministic, needs zero wiring, and is auto-collected.
 */

import { afterAll, expect } from 'vitest'
import { censusSitesByTestFile } from './recovery-census-table'

export type CensusFileRecorder = {
  /** The test file this recorder is bound to. */
  readonly testFile: string
  /** Record that this leg actually EXECUTED. Call it last in the leg body. */
  record(site: string): void
  /** Sites recorded so far (test-only introspection). */
  recorded(): string[]
}

/** The sites the census table assigns to `testFile`, or undefined if it owns none. */
export function expectedCensusSites(testFile: string): ReadonlySet<string> | undefined {
  return censusSitesByTestFile().get(testFile)
}

/**
 * PURE coverage predicate: the violations for `recorded` against the census table's
 * expectation for `testFile`. `[]` means the file executed exactly its registered legs.
 *
 * Kept pure and exported so the census suite can attack it directly with planted
 * missing/extra/unknown-file inputs — neutering it reds those unit tests.
 */
export function censusCoverageViolations(
  testFile: string,
  recorded: Iterable<string>,
): string[] {
  const expected = expectedCensusSites(testFile)
  if (expected === undefined) {
    return [
      `${testFile}: NOT a registered census test file — the census table owns no site `
      + 'for it, so its coverage assertion would be vacuous',
    ]
  }
  const seen = new Set(recorded)
  const violations: string[] = []
  for (const site of [...expected].sort()) {
    if (!seen.has(site)) {
      violations.push(
        `${testFile}: census site "${site}" was NEVER executed — its tagged behaviour `
        + 'leg did not run (skipped, focused-out, or deleted)',
      )
    }
  }
  for (const site of [...seen].sort()) {
    if (!expected.has(site)) {
      violations.push(
        `${testFile}: recorded UNREGISTERED census site "${site}" — it belongs to a `
        + 'different file or to no census row at all',
      )
    }
  }
  return violations
}

/** Throwing form of {@link censusCoverageViolations}; used by the file-level afterAll. */
export function assertCensusCoverage(testFile: string, recorded: Iterable<string>): void {
  const violations = censusCoverageViolations(testFile, recorded)
  if (violations.length > 0) {
    throw new Error(
      `recovery-census coverage FAILED for ${testFile}:\n  - ${violations.join('\n  - ')}`,
    )
  }
}

/**
 * Collection-time guard: the file name handed to {@link censusFile} MUST be a registered
 * census test file. An unregistered name would produce an empty expectation and make the
 * whole coverage assertion vacuously green — the exact hole this slice closes.
 *
 * Exported (rather than inlined) so the census suite can attack it directly: calling
 * `censusFile()` from inside a test body would register a stray `afterAll` on the census
 * suite itself, so the guards are tested through these pure throwing helpers instead.
 */
export function assertRegisteredCensusFile(testFile: string): ReadonlySet<string> {
  const expected = expectedCensusSites(testFile)
  if (expected === undefined) {
    throw new Error(
      `censusFile("${testFile}"): not a registered census test file. Known files: `
      + `${[...censusSitesByTestFile().keys()].sort().join(', ')}`,
    )
  }
  return expected
}

/** Guard for {@link CensusFileRecorder.record}: a file may only record its OWN sites. */
export function assertOwnedCensusSite(
  testFile: string,
  expected: ReadonlySet<string>,
  site: string,
): void {
  if (!expected.has(site)) {
    throw new Error(
      `census.record("${site}") in ${testFile}: that site is not registered to this `
      + `file. Registered here: ${[...expected].sort().join(', ')}`,
    )
  }
}

/**
 * P3-1 (2nd gate) guard for {@link CensusFileRecorder.record}: the call must be made
 * while vitest is actually RUNNING the test declaration tagged `[recovery-census:<site>]`
 * — not merely from source text that sits between that tag and the next declaration.
 *
 * `expect.getState().currentTestName` is vitest's own runtime ground truth for "which
 * test is executing right now": it is `undefined` during collection (a describe-body
 * statement, or a call moved past a leg's closing `})` by an `it.each([])` that
 * registered zero instances runs HERE, before any test starts), and during any OTHER
 * test's run when a hook such as `beforeEach` fires for a leg that was itself
 * `.skip`/`.skipIf`-suppressed. Neither case can spell the tagged leg's own name, so
 * binding to it closes the whole skip/data-driven-idiom family in one guard instead of
 * enumerating members to ban (the approach `EXECUTION_SUPPRESSING_MEMBERS` takes, and
 * which `skipIf`/`each` deliberately evade by design).
 *
 * Exported (like the sibling guards) so the census suite can attack it directly with a
 * planted `expect.getState()` shape rather than only through a full vitest run.
 */
export function assertRecordedFromOwnTaggedLeg(
  testFile: string,
  site: string,
  currentTestName: string | undefined,
): void {
  const tag = `[recovery-census:${site}]`
  if (currentTestName === undefined || !currentTestName.includes(tag)) {
    throw new Error(
      `census.record("${site}") in ${testFile} was not called from inside its own `
      + `tagged leg ${tag} (current test: "${currentTestName ?? '<no test running>'}") — `
      + 'a recorder call firing from a hook, a describe-body statement, or a '
      + 'neighbouring test cannot satisfy this site',
    )
  }
}

/**
 * Bind this test file to its census legs and install the file-level coverage assertion.
 * Call ONCE at module top level:
 *
 *   const census = censusFile('recovery-conflict-surfaces-routes-rbac.test.ts')
 *
 * then, as the last statement of each `[recovery-census:<site>]` leg:
 *
 *   census.record('<site>')
 */
export function censusFile(testFile: string): CensusFileRecorder {
  // Fail closed at COLLECTION time on an unregistered file name.
  const expected = assertRegisteredCensusFile(testFile)
  const seen = new Set<string>()
  afterAll(() => {
    assertCensusCoverage(testFile, seen)
  })
  return {
    testFile,
    record(site: string): void {
      assertOwnedCensusSite(testFile, expected, site)
      assertRecordedFromOwnTaggedLeg(testFile, site, expect.getState().currentTestName)
      seen.add(site)
    },
    recorded(): string[] {
      return [...seen].sort()
    },
  }
}
