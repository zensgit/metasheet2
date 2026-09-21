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
 * WHY THE POPULATION IS A-3's OWN FILE SET, NOT THE WHOLE REPO (F2 narrowing, 20260921). This
 * guard originally scanned every tracked non-Markdown file under `packages/**`, `apps/**`,
 * `plugins/**`, `scripts/**` via `git ls-files`. That is a repo-wide population, and it does not
 * survive contact with any sibling lane that legitimately writes the token as a citation: C-1's
 * `feat/approval-cancel-round-phase1-r8` adds a code comment at
 * `packages/core-backend/src/services/ApprovalProductService.ts:347` citing
 * `` `reviews/设置审批撤销规则.txt:41-43` `` — a real, in-repo review-record citation, not a bug in
 * C-1. On main, this guard does not exist yet; on A-3's own branch, that comment does not exist —
 * each lane alone is green. Merge the two and the repo-wide scan goes red on a file A-3 never
 * touched (`merge-train-dry-run-v2-20260921.md` §4 F2). A repo-wide population makes A-3's own
 * guard a hostage to every other lane's unrelated, legitimate citations.
 *
 * The fix narrows the scanned population to `A3_OWNED_FILES` below — the closed, FROZEN set of
 * repo-relative paths A-3's own commits (`feat/approval-template-groups-phase2-backfill`, #5866)
 * added or modified relative to its fork point off `origin/main`. This is a static list, not a
 * live `git diff origin/main` computed at test time, for two reasons proven empirically while
 * fixing F2:
 *   (1) SELF-DEFEATING ON MERGE. On a HEAD that has since been merged with a sibling lane (e.g.
 *       C-1 r8), a live `git diff origin/main --name-only` re-absorbs every sibling lane's files
 *       into the population — including `ApprovalProductService.ts`, the exact file whose
 *       comment caused F2 — making the narrowing a no-op the moment this branch is merged with
 *       anything. This was verified empirically: running the dynamic form against the merged tree
 *       reintroduces the file and reds the guard again.
 *   (2) `origin/main` DOES NOT RELIABLY RESOLVE. Shallow/CI checkouts frequently lack a local
 *       `origin/main` ref (`feedback_shallow_clone_ancestry_lies`); a missing ref silently
 *       collapses the diff to empty — a vacuous, always-green guard — rather than failing loudly.
 * `A3_OWNED_FILES` was produced once via
 * `git diff --name-only $(git merge-base <A-3 branch> origin/main) <A-3 branch>` and is frozen
 * here; update it only via that same recipe, in the same commit that changes A-3's own file set —
 * never hand-edit an entry (`feedback_record_fix_rounds_only_delete_never_handwrite_numbers`).
 *
 * FAIL CLOSED, NOT FAIL OPEN. If a listed path is no longer tracked (renamed or deleted without
 * updating this list), the guard THROWS rather than silently shrinking the scanned population —
 * see `computeScannedDomain` below and its dedicated test.
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
 * source/config/test files) and this guard's own file (see SELF-EXEMPTION above).
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../')
const TOKEN = ['review', 's', '/'].join('')

/** This guard's own repo-relative path, derived from `__filename` rather than hand-typed, so a
 *  future rename cannot leave a stale literal behind — either it still resolves to this file, or
 *  the "self-exemption is exactly one file, and is load-bearing" test below reds. */
const SELF_PATH = path.relative(REPO_ROOT, __filename).split(path.sep).join('/')

const A3_OWNED_FILES = [
  ".github/workflows/plugin-tests.yml",
  "docs/development/approval-template-groups-phase1-design-20260918.md",
  "docs/development/approval-template-groups-phase1-verification-20260918.md",
  "docs/development/approval-template-groups-phase2-backfill-design-20260918.md",
  "docs/development/approval-template-groups-phase2-backfill-rebase-note-20260918.md",
  "docs/development/approval-template-groups-phase2-backfill-verification-20260918.md",
  "packages/core-backend/src/db/migrate.ts",
  "packages/core-backend/src/db/migrations/zzzz20260918090000_create_approval_template_groups.ts",
  "packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts",
  "packages/core-backend/src/routes/approvals.ts",
  "packages/core-backend/src/services/ApprovalTemplateGroupService.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-batches-list.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-down-guard.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-execute.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-preview.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-rollback.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-backfill-schema.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-lifecycle.db.test.ts",
  "packages/core-backend/tests/integration/approval-template-groups-serialization.db.test.ts",
  "packages/core-backend/tests/unit/approval-a3-dangling-reviews-path-sweep.test.ts",
  "packages/core-backend/tests/unit/approval-template-group-backfill-batch-org-nonblank.test.ts",
  "packages/core-backend/vitest.config.ts",
  "plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json",
  "scripts/dev-bootstrap.sh",
  "scripts/dev/atg-retraction-sweep.sh",
  "scripts/dev/atg-verification-recount.sh",
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
 * and `trackedFilesSet()` directly) so the fail-closed behaviour and the "list is load-bearing"
 * behaviour below can each be exercised against a synthetic list, without mutating real git state.
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
 *  positive control below can exercise THIS function against a decoy tree, not a re-typed copy. */
function linesContainingToken(files: readonly string[], token: string, root: string = REPO_ROOT): Hit[] {
  const hits: Hit[] = []
  for (const rel of files) {
    const abs = path.join(root, rel)
    let content: string
    try {
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      // Binary or unreadable-as-utf8 file (e.g. an image under scripts/ fixtures) — not a
      // candidate for a doc-comment path reference; skip rather than throw.
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(token)) hits.push({ file: rel, line: i + 1, text: lines[i].trim() })
    }
  }
  return hits
}

/** Writes files into an isolated temp tree that mirrors repo-relative paths, for the positive
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

  it('the list is load-bearing: removing an entry shrinks the scanned domain by exactly one, not zero', () => {
    const droppedPath = 'packages/core-backend/src/routes/approvals.ts'
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

  it('POSITIVE CONTROL: a planted dangling-reviews-path reference reds the leg', () => {
    const probe = 'packages/core-backend/src/probe-with-dangling-reviews-path.ts'
    withDecoyTree(
      {
        [probe]: `// see \`${TOKEN}some-report.md\` for the full writeup\nexport const X = 1\n`,
        'packages/core-backend/src/clean.ts':
          '// see the private review record `some-report.md` (not tracked in this repository)\nexport const Y = 1\n',
      },
      (decoyRoot) => {
        const files = [probe, 'packages/core-backend/src/clean.ts']
        const hits = linesContainingToken(files, TOKEN, decoyRoot)
        expect(hits.map((h) => h.file)).toEqual([probe])
        expect(hits[0].line).toBe(1)
      },
    )
  })
})
