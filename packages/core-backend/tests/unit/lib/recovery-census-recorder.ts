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
 * Fail-closed properties, each one deliberate:
 *   - MISSING site  → skip / only / partial run / deleted leg  → the file reds.
 *   - EXTRA site    → a leg recording someone else's site       → the file reds.
 *   - unknown FILE  → `censusFile('typo.test.ts')` throws, so a copy-pasted installer
 *                     can never yield a vacuously empty expected set.
 *   - foreign SITE  → `record()` throws when the site is not owned by this file.
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

import { afterAll } from 'vitest'
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
      seen.add(site)
    },
    recorded(): string[] {
      return [...seen].sort()
    },
  }
}
