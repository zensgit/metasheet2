import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Repo guard — no A-3-owned, non-Markdown source file may reference a `reviews/`-prefixed path.
 *
 * WHY THIS EXISTS. `impl-gate-A3-guarded-down-round1-20260921.md` P3-4 fixed ONE dangling
 * `reviews/design-gate-A3-phase2-20260918.md` reference (a migration file's provenance comment
 * pointing at a path this repository has never had — `ls -d reviews` / `git ls-tree -d HEAD
 * reviews` are both empty; independent design/implementation-gate review records for this slice
 * live in the reviewer's own private review-notes tree, never under a repo `reviews/` directory).
 * `impl-gate-A3-guarded-down-round2-20260921.md` P3-a found the SAME defect class at 10 more
 * committed sites across this one A-3 slice's own source, tests, CI config, and CI-wiring guard —
 * fixed by that round, in the same commit that adds this guard — because a fix that only touches
 * the ONE site a report happened to name, instead of sweeping the whole class, is exactly how the
 * class re-accumulates one call site at a time (`feedback_retraction_must_be_a_sweep_not_an_
 * enumeration` / `feedback_absolute_claim_sweep_must_be_mechanical`).
 *
 * WHY THE TOKEN MUST BE THE BARE PREFIX, NOT A LARGER PHRASE. The prohibited substring is the
 * three characters "review" + "s" + "/" — spelled out here in three pieces so THIS sentence does
 * not itself carry the very token it names (the round-2 gate report's own diagnosis of round 1's
 * :118: a disclaimer that says a path is not under a repo directory of that name can trivially
 * fail to notice it wrote the literal directory name while saying so). Every OTHER doc-comment
 * fix this round made was reworded to avoid the contiguous substring entirely (cite the bare
 * review-record filename plus "a private review record, not tracked in this repository", never a
 * sentence built around the token itself).
 *
 * WHY THIS GUARD'S SCOPE IS A-3's OWN LINEAGE, NOT THE REPO AT LARGE (F2, twice-corrected,
 * 20260921). This guard's population has moved three times; this paragraph states where it
 * lands and why, honestly, rather than repeating an earlier version's claim.
 *
 *   (1) First narrowed to `A3_OWNED_FILES` (below) because a repo-wide `git ls-files` sweep is a
 *       hostage to every sibling lane's own, unrelated, legitimate citations: C-1's
 *       `feat/approval-cancel-round-phase1-r8` carried a code comment at
 *       `ApprovalProductService.ts` citing `` `reviews/设置审批撤销规则.txt:41-43` `` — a DANGLING
 *       reference this repository has never had a `reviews/` directory for, not a real in-repo
 *       target (`impl-gate-aligned-train-subset-round2-20260921.md` P3-1: `git ls-tree -r
 *       origin/main | grep '^reviews/'` ⇒ 0 on main, on r8, and on this branch; the commit
 *       that removed it, titled "drop out-of-repo reviews/ path from C-1 ceiling comment", lands
 *       on `feat/approval-cancel-round-phase1-r8` — not cited by SHA here, since that branch is
 *       still unmerged and a squash or rebase would leave a pinned SHA dangling, the same stale
 *       cross-artifact class this file's own header exists to avoid). A
 *       repo-wide scan would have (correctly) flagged that dangling reference the moment this
 *       branch merged with r8 — each lane alone was green, the merge of the two was not.
 *   (2) Reverted to the repo-wide sweep (`impl-gate-aligned-train-subset-20260921.md` P2-1,
 *       disposition (a)) once r8's follow-up commit removed that one citation, on the reasoning
 *       that the narrowed guard has zero discriminative power against a dangling reference in any
 *       file A-3 itself has not touched — true as a property of the detector, but the revert
 *       bought that property at a cost the round that ordered it did not measure.
 *   (3) Returned here to `A3_OWNED_FILES` because `impl-gate-aligned-train-subset-round2-20260921.
 *       md` measured that cost and found it not worth paying, twice over:
 *         - P2-1 (CONFIRMED): the repo-wide sweep's four top-level directories
 *           (`packages`/`apps`/`plugins`/`scripts`) do not cover `.github/`, so
 *           `.github/workflows/plugin-tests.yml` — an A-3-owned file, entry #1 of
 *           `A3_OWNED_FILES`, named in this very file's own WHY-THIS-EXISTS paragraph as one of
 *           the round-2 defect sites — silently fell out of scope. Proven by injection: the same
 *           planted line in that file reds the `A3_OWNED_FILES` scan and passes the repo-wide one.
 *         - P2-3 (CONFIRMED): a repo-wide scan does not stop at this slice. At measurement time,
 *           11 OTHER `origin/` branches still carried a live, legitimate-for-now `reviews/`
 *           citation that is each of those lines' own cleanup to make, not this guard's — the
 *           cancel-round family (nine branches, `ApprovalProductService.ts`) and PR #5703's
 *           server-form-drafts slice (three files, an entirely different citation family). A
 *           repo-wide guard reds the required check on any of those lines the moment they rebase
 *           onto a main this guard has landed on, for a defect A-3 did not introduce and cannot
 *           fix on another line's behalf.
 *       This guard's scope is therefore **A-3's own lineage files only**
 *       (`A3_OWNED_FILES` below) — stated as a scope, not as a claim that no other `reviews/`
 *       citation exists anywhere in the repository. Other lines' `reviews/` citations are each
 *       line's own responsibility to clean up on their own schedule; this guard neither asserts
 *       they do not exist nor needs to. Should a future need arise to catch a dangling `reviews/`
 *       reference repo-wide, that is a *different*, explicitly repo-wide guard — not a widening of
 *       this one, which exists to keep A-3's own files clean and would (per P2-3) falsely red on
 *       other lines' not-yet-cleaned-up citations if widened the same way again.
 *
 * F2 A-1 CUTPOINT CORRECTION (20260921, `impl-gate-crossstack-guards-f1f2f3-20260921.md` P1-1).
 * The FIRST narrowing's recipe — `git diff --name-only $(git merge-base <A-3 branch> origin/main)
 * <A-3 branch>` — was itself wrong. A-1 (`feat/approval-template-groups-phase1`, #5852) has never
 * been merged into `origin/main`; A-3 carries A-1's ~37 commits directly, not via `origin/main`.
 * Diffing against `origin/main` therefore walks back through the entire A-1 segment too and
 * re-absorbs files A-1 (not A-3) authored, including a migration #5907 later renamed on a
 * different lane descended from A-1 — freezing the old name under that recipe is exactly what
 * collided with the rename the moment the two lanes combined. THE CORRECTED RECIPE anchors the
 * diff at the point where A-3's own work starts on THIS branch, not `origin/main`, and names that
 * point by tracked content rather than by a pinned SHA. The SHA this recipe used to carry is
 * reachable from `feat/approval-template-groups-phase2-backfill` and, by `git merge-base
 * --is-ancestor` (exit 1), unreachable from `feat/approval-template-groups-phase2-backfill-aligned`,
 * which ships this file byte-identical; there the same command still exits 0 and diffs across the
 * whole divergence instead of A-3's own segment — the dangling-pin class this file's own header
 * exists to avoid. THE CORRECTED RECIPE, re-derivable on whichever branch this file sits on:
 *
 *   A3_START=$(git log --diff-filter=A --format=%H HEAD -- packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts | tail -1)
 *   git diff --name-only "$A3_START^..HEAD"
 *
 * — the first commit on this branch that ADDS A-3's own backfill-batches migration, diffed from
 * its parent. Run 2026-09-22 in a worktree of each branch: the two outputs hold the same 27 paths;
 * `A3_OWNED_FILES` below freezes 26 of them, and the 27th,
 * `docs/development/approval-template-groups-phase2-design-20260918.md`, is not frozen here.
 * Re-derive it per branch rather than extrapolating from this paragraph: A-1's migration was
 * already renamed once on a sibling lane, and a rename of A-3's own migration moves this anchor
 * the same way. Re-running the recipe against this frozen list
 * removes exactly 6 of a prior 32-entry list's paths, all A-1-inherited and none A-3-authored:
 * both phase1 `.md` docs, the phase1 migration renamed above, the phase1
 * `approval-template-groups-lifecycle.db.test.ts`, and `scripts/dev/atg-retraction-sweep.sh` /
 * `atg-verification-recount.sh`. Dropping those from THIS list does not un-wire them from CI, but
 * "still runs" does not hold uniformly across the six (verified with `git ls-files` plus a grep
 * of `.github/` and every `package.json`): all six remain `git`-tracked; the phase1 migration and
 * `approval-template-groups-lifecycle.db.test.ts` still run in CI — the migration via
 * `migrate.ts`'s directory scan, the test named explicitly at `plugin-tests.yml:1706`; the two
 * phase1 `.md` docs do not run at all (Markdown), and the two `scripts/dev/atg-*.sh` helpers are
 * developer-invoked only, with zero references in `.github/` or any `package.json`. None of the
 * six is A-3's own file to freeze a path for, either way.
 *
 * `A3_OWNED_FILES` is frozen here; update it only via the corrected recipe above, in the same
 * commit that changes A-3's own file set — never hand-edit an entry
 * (`feedback_record_fix_rounds_only_delete_never_handwrite_numbers`). It is a real `const`, read
 * by every test below — not a historical comment.
 *
 * FAIL CLOSED, NOT FAIL OPEN. If a listed path is no longer tracked (renamed or deleted without
 * updating this list), the guard THROWS rather than silently shrinking the scanned population —
 * see `computeScannedDomain` below and its dedicated test. A silently DROPPED entry (the list
 * still lists it, but it stops being scanned some other way) is a different failure mode, covered
 * by the two `.github/workflows/plugin-tests.yml`-specific tests below (P2-1 regression guard).
 *
 * SELF-EXEMPTION. This file is itself `.ts`, is itself a member of `A3_OWNED_FILES` (A-3 added
 * it), and legitimately needs to WRITE the literal token as data — in the constant below, in two
 * `it()` titles, and in a decoy fixture's file content — none of which is a dangling repo-relative
 * path reference to a nonexistent directory (the defect class this guard exists to catch).
 * Committing this file verbatim reds its own first attempt at "zero hits" (verified once, then
 * fixed): the guard must exclude its OWN path, named explicitly via `__filename` (never a pattern
 * — a pattern could hide something else), and the exclusion's necessity plus narrowness are both
 * proven by a dedicated test below, not asserted in a comment.
 *
 * SCOPE. `A3_OWNED_FILES` (A-3's own touched files), excluding `.md` files (Markdown review/
 * design/verification docs legitimately narrate review-record filenames and paths in prose; this
 * guard is about paths a reader might follow expecting an in-repo target, i.e. non-Markdown
 * source/config/test files) and this guard's own file (see SELF-EXEMPTION above). This is NOT a
 * directory-tree sweep: a file outside this list, however similar its path or directory, is out
 * of scope by design (see WHY THIS GUARD'S SCOPE above) — that is a statement about what this
 * guard checks, not a claim about what exists elsewhere in the repository.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../')
const TOKEN = ['review', 's', '/'].join('')

/** This guard's own repo-relative path, derived from `__filename` rather than hand-typed, so a
 *  future rename cannot leave a stale literal behind — either it still resolves to this file, or
 *  the "self-exemption is exactly one file, and is load-bearing" test below reds. */
const SELF_PATH = path.relative(REPO_ROOT, __filename).split(path.sep).join('/')

const A3_OWNED_FILES = [
  ".github/workflows/plugin-tests.yml",
  "docs/development/approval-template-groups-phase2-backfill-design-20260918.md",
  "docs/development/approval-template-groups-phase2-backfill-rebase-note-20260918.md",
  "docs/development/approval-template-groups-phase2-backfill-verification-20260918.md",
  "packages/core-backend/src/db/migrate.ts",
  "packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts",
  "packages/core-backend/src/routes/approvals.ts",
  "packages/core-backend/src/services/ApprovalTemplateGroupService.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-batches-list.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-down-guard.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-execute.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-preview.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-rollback.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-schema.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-serialization.db.test.ts",
  "packages/core-backend/tests/unit/approval-a3-dangling-reviews-path-sweep.test.ts",
  "packages/core-backend/tests/unit/approval-template-group-backfill-batch-org-nonblank.test.ts",
  "packages/core-backend/vitest.config.ts",
  "plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json",
  "scripts/dev-bootstrap.sh",
  "scripts/ops/approval-template-groups-backfill-batches-list-ci-wiring.test.mjs",
  "scripts/ops/approval-template-groups-backfill-down-guard-ci-wiring.test.mjs",
  "scripts/ops/approval-template-groups-backfill-execute-ci-wiring.test.mjs",
  "scripts/ops/approval-template-groups-backfill-preview-ci-wiring.test.mjs",
  "scripts/ops/approval-template-groups-backfill-rollback-ci-wiring.test.mjs",
  "scripts/ops/approval-template-groups-backfill-schema-ci-wiring.test.mjs",
] as const

/** All paths git currently tracks (cross-check target for `A3_OWNED_FILES` below — the fail-closed
 *  check needs to know whether every listed path still exists in the tree, not just on disk). */
function trackedFilesSet(root: string = REPO_ROOT): Set<string> {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  })
  return new Set(raw.toString('utf8').split('\0').filter((rel) => rel.length > 0))
}

/**
 * Derives the scanned domain from an explicit owned-file list and a tracked-files snapshot:
 * non-Markdown members of `ownedFiles`, minus `exclude`. THROWS if any entry of `ownedFiles` is
 * absent from `tracked` — a listed path git no longer tracks must fail the run loudly, never
 * silently shrink the population (fail closed). Parameterised (rather than reading `A3_OWNED_FILES`
 * and `trackedFilesSet()` directly) so the fail-closed behaviour, the "list is load-bearing"
 * behaviour, and the discriminative control below can each be exercised against a synthetic list,
 * without mutating real git state.
 */
function computeScannedDomain(
  ownedFiles: readonly string[],
  tracked: ReadonlySet<string>,
  exclude: readonly string[] = [SELF_PATH],
): string[] {
  const missing = ownedFiles.filter((rel) => !tracked.has(rel))
  if (missing.length > 0) {
    throw new Error(
      `approval-a3-dangling-reviews-path-sweep: A3_OWNED_FILES lists ${missing.length} path(s) ` +
        `git no longer tracks — update the list via the frozen-diff recipe in the same commit ` +
        `that changes A-3's own file set, do not let it silently shrink: ${missing.join(', ')}`,
    )
  }
  return ownedFiles
    .filter((rel) => path.extname(rel).toLowerCase() !== '.md')
    .filter((rel) => !exclude.includes(rel))
    .slice()
    .sort()
}

/** `computeScannedDomain` against the real repo's real tracked files — the guard's actual domain. */
function a3ScannedDomain(exclude: readonly string[] = [SELF_PATH]): string[] {
  return computeScannedDomain(A3_OWNED_FILES, trackedFilesSet(), exclude)
}

type Hit = { file: string; line: number; text: string }

/** Lines containing the token, across the given files. Parameterised by root + file list so the
 *  discriminative control below can exercise THIS function against a decoy tree, not a re-typed
 *  copy. */
function linesContainingToken(files: readonly string[], token: string, root: string = REPO_ROOT): Hit[] {
  const hits: Hit[] = []
  for (const rel of files) {
    const abs = path.join(root, rel)
    let content: string
    try {
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      // A read failure (e.g. a tracked path absent from the checkout, or a directory) — skip it
      // rather than throw. Undecodable bytes do not arrive here: `fs.readFileSync(abs, 'utf8')`
      // substitutes U+FFFD for them and returns.
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(token)) hits.push({ file: rel, line: i + 1, text: lines[i].trim() })
    }
  }
  return hits
}

/** Writes files into an isolated temp tree that mirrors repo-relative paths, for the discriminative
 *  control below. Never plants into the real tree. */
function withDecoyTree(files: Record<string, string>, run: (decoyRoot: string) => void): void {
  const decoyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-path-guard-decoy-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(decoyRoot, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
    run(decoyRoot)
  } finally {
    fs.rmSync(decoyRoot, { recursive: true, force: true })
  }
}

describe('repo guard: no dangling `reviews/`-prefixed path reference in A-3\'s own file set (outside Markdown)', () => {
  it('the scanned domain is non-vacuous, and is a subset of A-3\'s own file set (scan negative control)', () => {
    const files = a3ScannedDomain()
    expect(files.length).toBeGreaterThan(0)
    expect(files).toContain('packages/core-backend/src/routes/approvals.ts')
    expect(files.every((f) => (A3_OWNED_FILES as readonly string[]).includes(f))).toBe(true)
  })

  it('fails closed when a listed path is no longer tracked, instead of silently shrinking', () => {
    const droppedPath = 'packages/core-backend/src/routes/approvals.ts'
    const fakeTracked = new Set(
      (A3_OWNED_FILES as readonly string[]).filter((f) => f !== droppedPath),
    )
    expect(() => computeScannedDomain(A3_OWNED_FILES, fakeTracked)).toThrow(/no longer tracks/)
  })

  it('the list is load-bearing: removing a src entry shrinks the scanned domain by exactly one, not zero', () => {
    const droppedPath = 'packages/core-backend/src/routes/approvals.ts'
    const tracked = trackedFilesSet()
    const full = computeScannedDomain(A3_OWNED_FILES, tracked)
    const reducedOwned = (A3_OWNED_FILES as readonly string[]).filter((f) => f !== droppedPath)
    const reduced = computeScannedDomain(reducedOwned, tracked)
    expect(full).toContain(droppedPath)
    expect(reduced).not.toContain(droppedPath)
    expect(reduced.length).toBe(full.length - 1)
  })

  it('the scanned domain includes .github/workflows/plugin-tests.yml (P2-1 regression guard: A-3 owns this CI config file too, and it is the exact file the repo-wide sweep silently dropped)', () => {
    const files = a3ScannedDomain()
    expect(files).toContain('.github/workflows/plugin-tests.yml')
  })

  it('removing .github/workflows/plugin-tests.yml from A3_OWNED_FILES shrinks the scanned domain by exactly one (a silently-dropped CI-config entry must be caught, the same way a silently-dropped src entry already is)', () => {
    const droppedPath = '.github/workflows/plugin-tests.yml'
    const tracked = trackedFilesSet()
    const full = computeScannedDomain(A3_OWNED_FILES, tracked)
    const reducedOwned = (A3_OWNED_FILES as readonly string[]).filter((f) => f !== droppedPath)
    const reduced = computeScannedDomain(reducedOwned, tracked)
    expect(full).toContain(droppedPath)
    expect(reduced).not.toContain(droppedPath)
    expect(reduced.length).toBe(full.length - 1)
  })

  it('self-exemption is exactly this one file, and is load-bearing (not vestigial)', () => {
    // The exclusion target really exists in the unfiltered domain — not a stale path pointing at
    // nothing (which would make the `exclude` list decorative).
    const unfiltered = a3ScannedDomain([])
    expect(unfiltered).toContain(SELF_PATH)
    // ...and it genuinely WOULD fail the leg below if not excluded — the exemption removes a real
    // hit, not zero hits it never needed to remove.
    const selfHits = linesContainingToken([SELF_PATH], TOKEN)
    expect(selfHits.length).toBeGreaterThan(0)
    // With the default exclusion applied, this file is gone from the scanned domain.
    expect(a3ScannedDomain()).not.toContain(SELF_PATH)
  })

  it('zero file in A-3\'s own scanned domain (other than this guard itself) contains the literal substring "review" + "s" + "/"', () => {
    const hits = linesContainingToken(a3ScannedDomain(), TOKEN)
    expect(hits).toEqual([])
  })

  it('DISCRIMINATIVE CONTROL: a dangling reference inside A-3\'s lineage reds the scanned leg; the identical reference outside it does not, because the miss is a scope decision, not a blind detector (fixes P2-2: the previous round\'s control site was already inside the frozen list — `ApprovalTemplateGroupService.ts` is entry #8 above — so it had zero power to distinguish a repo-wide scan from this one; this cell isolates list membership as the only variable)', () => {
    const insideLineage = 'packages/core-backend/src/services/ApprovalTemplateGroupService.ts'
    const outsideLineage = 'packages/core-backend/src/services/ApprovalBridgeService.ts'
    // Anchor to reality (P2-1): the assertions below only prove the pipeline is discriminative
    // against a SYNTHETIC list. Without this pair, `A3_OWNED_FILES` later growing to include
    // `outsideLineage` (or shrinking to drop `insideLineage`) would leave this whole cell green
    // while the title's central claim — "list membership as the only variable" — goes silently
    // false, exactly as round 3's neuter proof demonstrated.
    expect(A3_OWNED_FILES as readonly string[]).toContain(insideLineage)
    expect(A3_OWNED_FILES as readonly string[]).not.toContain(outsideLineage)
    const injectedLine = `// see \`${TOKEN}design-gate-A3-phase2-20260918.md\` for the writeup\n`
    withDecoyTree(
      {
        [insideLineage]: `${injectedLine}export const PROBE_INSIDE = 1\n`,
        [outsideLineage]: `${injectedLine}export const PROBE_OUTSIDE = 1\n`,
      },
      (decoyRoot) => {
        // Synthetic owned-file list containing ONLY the inside-lineage path: isolates "is this
        // path in A3_OWNED_FILES" as the one variable that differs between the two files below —
        // both are otherwise identical (same injected line, same decoy tree, same real repo
        // paths).
        const syntheticOwned = [insideLineage] as const
        const syntheticTracked = new Set([insideLineage, outsideLineage])
        const scanned = computeScannedDomain(syntheticOwned, syntheticTracked, [])
        expect(scanned).toEqual([insideLineage])

        // Arm A (inside lineage): the guard's actual domain-then-scan pipeline catches it — RED.
        const insideResult = linesContainingToken(scanned, TOKEN, decoyRoot)
        expect(insideResult.map((h) => h.file)).toEqual([insideLineage])

        // Arm B (outside lineage): same file content, but the domain never contains the path, so
        // the pipeline is GREEN on it — not because the detector is blind, but because the file
        // is out of scope by design.
        expect(scanned).not.toContain(outsideLineage)
        expect(linesContainingToken(scanned, TOKEN, decoyRoot).map((h) => h.file)).not.toContain(
          outsideLineage,
        )

        // Discriminator: prove the miss above is a scope decision, not a detector limitation — the
        // identical function, pointed at the outside-lineage file directly, DOES see the line.
        const wouldCatchIfInScope = linesContainingToken([outsideLineage], TOKEN, decoyRoot)
        expect(wouldCatchIfInScope.map((h) => h.file)).toEqual([outsideLineage])
      },
    )
  })
})
