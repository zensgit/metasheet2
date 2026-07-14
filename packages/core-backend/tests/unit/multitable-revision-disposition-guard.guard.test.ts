/**
 * OD-6 REVISION-DISPOSITION GUARD — "every `meta_records` mutation site must declare a revision
 * disposition, or CI goes red."
 *
 * D-1c (design-lock `docs/development/multitable-global-history-d1c-form-submit-edit-uncaptured-
 * revision-design-lock-20260712.md`) found EIGHT live `meta_records` mutation sites (A1-A8, §7a) that
 * wrote no `recordRecordRevision(...)` — each found by a DIFFERENT human audit (rank-8, D-1, this one),
 * years apart, each fixing only the sinks it happened to be looking at. `reconstructRecordsAtT` (the PIT
 * view / revert / reset primitive) derives record existence AND data purely from `meta_record_revisions`
 * — a mutation that skips it is invisible forever, and a sheet revert/reset can silently and
 * irrecoverably destroy or resurrect real data (§0/§1/§2 of the lock). Five runtime slices (①-⑤, landed
 * as #4245/#4246/#4247/#4248/#4249) fixed all eight. This guard is the OD-6 "separate rung" that lands
 * LAST (§10 of the lock): it prevents a NINTH uncaptured sink from EVER being added silently again, by
 * forcing every `meta_records` INSERT/UPDATE/DELETE site — anywhere in the runtime tree — to carry an
 * explicit disposition marker within `MARKER_WINDOW` lines:
 *
 *   • `// revision-emitted:<why>`  — this site calls `recordRecordRevision(...)` in the same transaction.
 *   • `// revision-exempt:<why>`   — a trusted derived/system/config-channel write with no user actor, OR
 *                                    (field-delete/field-undelete) captured on the CONFIG revision channel
 *                                    instead, per the design-lock's §7a Bucket C classification.
 *   • `// revision-pending:<why>`  — an OWNER-RULED must-write site that does NOT yet emit a revision.
 *                                    Reserved EXCLUSIVELY for `KNOWN_REVISION_GAPS` entries (see below) —
 *                                    a contributor cannot self-declare "pending" to dodge the guard.
 *
 * Recycled from the #4227 draft PR, with its adversarial review's two proven blockers fixed (see
 * `lib/multitable-revision-disposition-scanner.ts`'s docstring for the defeat-then-fix detail):
 *   1. the #4227 scanner was line-by-line and case-sensitive — an unmarked UPPERCASE `UPDATE meta_records`
 *      reddened it, but the lowercase twin passed 11/11 undetected, and a verb/table split across lines
 *      was invisible. This guard's scanner is whole-file, case-insensitive, and multiline-aware.
 *   2. the #4227 scanner keyed its pending-site allowlist by literal `(file, line)` — any edit above a
 *      pending site silently drifted its line number. This guard keys every site by a stable content hash
 *      (`siteId` — file + enclosing anchor + statement fingerprint + occurrence index), immune to edits
 *      elsewhere in the file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { enumerateSites, listRuntimeTsFiles, readSrcFile, type Site } from './lib/multitable-revision-disposition-scanner'

const SRC = join(__dirname, '../../src')

/**
 * The SOLE currently-known MUST-WRITE-but-not-yet-emitting site: `univer-meta.ts` `recreateFieldFromConfig`
 * (field-undelete rehydration). The design-lock's audit (§7a Bucket D) had flagged it debatable-EXEMPT;
 * the owner's OD-6 ruling (§0.5, 2026-07-13) directs MUST-WRITE instead — it rehydrates real captured user
 * cell values from tombstones (`data = data || jsonb_build_object(...)`), which is exactly the fingerprint
 * of the bug class this guard exists to catch. It is OUT of scope for D-1c's five slices (those are A1-A8,
 * the bucket-A user-write-entry-point sweep; this is a field-op, not one of the eight) and is NOT silently
 * exempted — it is a loud, named, pinned, tracked gap. A site may use `revision-pending:` ONLY if its
 * `siteId` is listed here; see the hygiene test below for both directions of that check.
 *
 * To regenerate a siteId after a legitimate edit to this exact statement/anchor: run the scanner against
 * `src/routes/univer-meta.ts` and read the `recreateFieldFromConfig` UPDATE's `siteId` — see
 * `multitable-revision-disposition-scanner.test.ts` for how to call `enumerateSites` directly.
 */
const KNOWN_REVISION_GAPS: ReadonlySet<string> = new Set([
  '456ec0c986a1b1af', // routes/univer-meta.ts recreateFieldFromConfig — field-undelete rehydration (OD-6 owner ruling: MUST-WRITE, not yet implemented)
])

describe('OD-6 revision-disposition guard — durable structural guard (D-1c final rung)', () => {
  const allSites: Site[] = listRuntimeTsFiles(SRC).flatMap((file) => enumerateSites(file, readSrcFile(SRC, file)))

  test('the enumeration finds the expected mutation surface (smoke — not zero, not exploded)', () => {
    // 36 known sites at authoring time (9 INSERT + 22 UPDATE + 5 DELETE, literal grep on origin/main —
    // see PR body for the full reconciliation against the design-lock's audit). Loose bound, mirroring
    // the rank-8 guard's own philosophy: a count change is FINE (you added/removed a mutation site); the
    // per-site disposition assertion below is the real gate.
    expect(allSites.length).toBeGreaterThanOrEqual(30)
    expect(allSites.length).toBeLessThanOrEqual(50)
  })

  test('EVERY meta_records INSERT/UPDATE/DELETE site carries a revision disposition (EMITTED / EXEMPT / PENDING)', () => {
    const undeclared = allSites.filter((s) => s.disposition === null)
    expect(
      undeclared,
      `OD-6 REVISION-DISPOSITION GUARD: ${undeclared.length} meta_records mutation site(s) with NO ` +
        `revision disposition:\n` +
        undeclared.map((s) => `  - ${s.file}:${s.line}  [${s.siteId}]  ${s.sql}`).join('\n') +
        `\n\nYou added or moved a meta_records mutation. Within 3 lines above it, add EITHER a ` +
        `"// revision-emitted:<why>" marker (a recordRecordRevision(...) call executes in the SAME ` +
        `transaction) OR a "// revision-exempt:<why>" marker (trusted derived/system/config-channel write, ` +
        `no user actor — see the design-lock's §7a Bucket C for precedent). Do NOT self-declare ` +
        `"revision-pending" — that marker is reserved for KNOWN_REVISION_GAPS entries only (see hygiene ` +
        `test below). A silently uncaptured meta_records write is exactly the bug class D-1c's five ` +
        `runtime slices (①-⑤, #4245-#4249) closed — this guard exists so a NINTH one can never regress.`,
    ).toEqual([])
  })

  test('every PENDING-labelled site is a KNOWN, TRACKED gap — no self-declared "pending" (both directions)', () => {
    const pendingSites = allSites.filter((s) => s.disposition === 'PENDING')
    const pendingIds = new Set(pendingSites.map((s) => s.siteId))

    // direction 1: every site actually marked revision-pending must be in the allowlist — a contributor
    // cannot dodge the "declare EMITTED or EXEMPT" requirement by writing "pending" on a brand-new site.
    const undeclaredPending = pendingSites.filter((s) => !KNOWN_REVISION_GAPS.has(s.siteId))
    expect(
      undeclaredPending,
      `A site is marked "revision-pending" but is NOT in KNOWN_REVISION_GAPS — pending is reserved for ` +
        `owner-ruled, explicitly tracked gaps, not a way to dodge the guard:\n` +
        undeclaredPending.map((s) => `  - ${s.file}:${s.line}  [${s.siteId}]  ${s.sql}`).join('\n'),
    ).toEqual([])

    // direction 2: every allowlist entry must correspond to a site CURRENTLY marked pending — when the
    // follow-up rung lands and the site flips to revision-emitted, this fails until the stale entry is
    // deleted, closing the loop from the landing side (mirrors the rank-8/#4227 hygiene convention).
    const staleAllowlistEntries = [...KNOWN_REVISION_GAPS].filter((id) => !pendingIds.has(id))
    expect(
      staleAllowlistEntries,
      `KNOWN_REVISION_GAPS lists a siteId with no corresponding revision-pending site — either the gap ` +
        `was fixed (delete the entry) or the site's content changed and its stable id drifted ` +
        `(regenerate it): ${staleAllowlistEntries.join(', ')}`,
    ).toEqual([])

    // exactly one known gap today (field-undelete rehydration) — a bound, not a hardcode of WHICH, so a
    // second legitimate gap can be added without this test needing surgery, but a silent explosion trips it.
    expect(pendingSites.length).toBe(1)
  })

  test('every EMITTED-labelled FILE actually calls recordRecordRevision( somewhere in it (a label cannot fake a call)', () => {
    // Per-FILE cross-check (not per-site — a full call-graph proof is what the real-DB goldens in each of
    // the five landed slices already provide; see their PRs). Mirrors the rank-8 lock guard's own
    // `multitable-record-lock-guard.guard.test.ts` "a label cannot fake a guard" test exactly.
    const emittedFiles = new Set(allSites.filter((s) => s.disposition === 'EMITTED').map((s) => s.file))
    for (const f of [
      'multitable/record-service.ts',
      'multitable/record-write-service.ts',
      'multitable/records.ts',
      'multitable/automation-executor.ts',
      'multitable/automation-service.ts',
      'routes/univer-meta.ts',
    ]) {
      expect(emittedFiles.has(f), `${f} should have at least one EMITTED mutation site`).toBe(true)
    }
    for (const f of emittedFiles) {
      const src = readFileSync(join(SRC, f), 'utf8')
      expect(src.includes('recordRecordRevision('), `${f} is labelled revision-emitted but never calls recordRecordRevision(`).toBe(true)
    }
  })

  test('recordRecordRevision is the single write helper, defined once', () => {
    const src = readFileSync(join(SRC, 'multitable/record-history-service.ts'), 'utf8')
    expect(src).toContain('export async function recordRecordRevision(')
    expect([...src.matchAll(/function recordRecordRevision\(/g)].length).toBe(1)
  })
})
