import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Repo guard — no tracked, non-Markdown source file under packages/**, apps/**, plugins/**, or
 * scripts/** may reference a `reviews/`-prefixed path.
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
 * WHY THIS GUARD SCANS THE WHOLE REPO DOMAIN AGAIN (F2 narrowing REVERTED, 20260921, gate report
 * `impl-gate-aligned-train-subset-20260921.md` P2-1, disposition (a)). This guard originally
 * scanned every tracked non-Markdown file under `packages/**`, `apps/**`, `plugins/**`,
 * `scripts/**` via `git ls-files` — the scan implemented below. For one review window it was
 * narrowed instead to a frozen list of A-3's own touched files (`A3_OWNED_FILES`, kept a few
 * paragraphs down as a HISTORICAL COMMENT ONLY — no function in this file reads it any more),
 * because C-1's `feat/approval-cancel-round-phase1-r8` carried a citation at
 * `packages/core-backend/src/services/ApprovalProductService.ts` naming a real, in-repo
 * review-record path (`reviews/设置审批撤销规则.txt`) — not a bug in C-1 — that a repo-wide scan
 * would flag the moment this branch merged with that one. That was a real conflict at the time:
 * on `main` this guard did not exist yet, and on A-3's own branch that citation did not exist, so
 * each lane alone was green while a repo-wide scan on the merge of the two was not.
 *
 * C-1 r8's own follow-up commit (`ecb3be788`, comment-only, 1 file / +1 / -1, landed alongside
 * this revert) deletes that citation from `ApprovalProductService.ts` rather than moving it to an
 * in-repo target — see the companion fix to that file, which replaces the deleted pointer with an
 * in-repo documentation citation instead of leaving it deleted. Mechanically, as of that commit,
 * and on every tree that merges it: a `git grep` for the literal `reviews/`, restricted to every
 * tracked path with a `src` path component, returns **zero** hits, repo-wide. The one conflict
 * the narrowing existed to avoid therefore no longer exists anywhere
 * it could recur, so the narrowing has nothing left to buy — while it still had a real, measured
 * cost: an isolated injection check (gate report §3.1) planted a dangling `reviews/`-path
 * reference in a production file OUTSIDE `A3_OWNED_FILES` and found the narrowed guard GREEN on
 * it — zero discriminative power against exactly the defect class this guard exists to catch, the
 * moment the offending file is not one A-3 itself happens to have touched. A guard whose scanned
 * population is "the files I already know about" cannot catch a NEW dangling reference in any
 * OTHER file — which is the only kind of dangling reference this guard could ever be needed to
 * catch, since a known one would already have been fixed. The population is therefore reverted to
 * the full repo-wide scan below.
 *
 * Should some future sibling lane introduce another genuine `reviews/`-prefixed in-repo citation
 * that collides with this scan, THAT is the moment to narrow again — naming the actual
 * conflicting file at the time it actually exists, not preemptively against a conflict that may
 * never recur, and not by resurrecting a list frozen against paths that may since have moved,
 * been renamed, or been deleted.
 *
 * `A3_OWNED_FILES` — kept immediately below PURELY as a historical record of which 26 paths that
 * one narrowed review window scanned. It is a comment, not a `const`; nothing in this file reads
 * it, and it is not maintained against renames or deletions:
 *   .github/workflows/plugin-tests.yml
 *   docs/development/approval-template-groups-phase2-backfill-design-20260918.md
 *   docs/development/approval-template-groups-phase2-backfill-rebase-note-20260918.md
 *   docs/development/approval-template-groups-phase2-backfill-verification-20260918.md
 *   packages/core-backend/src/db/migrate.ts
 *   packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts
 *   packages/core-backend/src/routes/approvals.ts
 *   packages/core-backend/src/services/ApprovalTemplateGroupService.ts
 *   packages/core-backend/tests/integration/approval-template-groups-backfill-batches-list.db.test.ts
 *   packages/core-backend/tests/integration/approval-template-groups-backfill-down-guard.db.test.ts
 *   packages/core-backend/tests/integration/approval-template-groups-backfill-execute.db.test.ts
 *   packages/core-backend/tests/integration/approval-template-groups-backfill-preview.db.test.ts
 *   packages/core-backend/tests/integration/approval-template-groups-backfill-rollback.db.test.ts
 *   packages/core-backend/tests/integration/approval-template-groups-backfill-schema.db.test.ts
 *   packages/core-backend/tests/integration/approval-template-groups-serialization.db.test.ts
 *   packages/core-backend/tests/unit/approval-a3-dangling-reviews-path-sweep.test.ts
 *   packages/core-backend/tests/unit/approval-template-group-backfill-batch-org-nonblank.test.ts
 *   packages/core-backend/vitest.config.ts
 *   plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
 *   scripts/dev-bootstrap.sh
 *   scripts/ops/approval-template-groups-backfill-batches-list-ci-wiring.test.mjs
 *   scripts/ops/approval-template-groups-backfill-down-guard-ci-wiring.test.mjs
 *   scripts/ops/approval-template-groups-backfill-execute-ci-wiring.test.mjs
 *   scripts/ops/approval-template-groups-backfill-preview-ci-wiring.test.mjs
 *   scripts/ops/approval-template-groups-backfill-rollback-ci-wiring.test.mjs
 *   scripts/ops/approval-template-groups-backfill-schema-ci-wiring.test.mjs
 *
 * ON THE DELETED CITATION'S LINE NUMBER. Three prior documents each asserted a different line
 * number for the (now-deleted) `ApprovalProductService.ts` comment — `:343` in one gate report,
 * `:347` in another and in an earlier revision of this very comment — and mechanical re-derivation
 * against the commit that actually carried the citation showed neither number was ever correct.
 * This comment does not assert a line number for it: C-1 r8's `ecb3be788` deleted the citation
 * outright, so there is no live line left for a citation to be wrong about. The citation is
 * identified here by the commit SHA that removed it, not by a position in a file that no longer
 * contains it.
 *
 * SELF-EXEMPTION. This file is itself `.ts`, lives under `packages/**`, and legitimately needs to
 * WRITE the literal token as data — in the constant below, in two `it()` titles, and in a decoy
 * fixture's file content — none of which is a dangling repo-relative path reference to a
 * nonexistent directory (the defect class this guard exists to catch). Committing this file
 * verbatim reds its own first attempt at "zero hits" (verified once, then fixed): the guard must
 * exclude its OWN path, named explicitly via `__filename` (never a pattern — a pattern could hide
 * something else), and the exclusion's necessity plus narrowness are both proven by a dedicated
 * test below, not asserted in a comment.
 *
 * SCOPE. Tracked files under `packages/**`, `apps/**`, `plugins/**`, `scripts/**`, excluding
 * `.md` files (Markdown review/design/verification docs legitimately narrate review-record
 * filenames and paths in prose; this guard is about paths a reader might follow expecting an
 * in-repo target, i.e. non-Markdown source/config/test files) and this guard's own file (see
 * SELF-EXEMPTION above). `node_modules` is excluded via `git ls-files` (never walks it).
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../')
const SCAN_DIRS = ['packages', 'apps', 'plugins', 'scripts']
const TOKEN = ['review', 's', '/'].join('')

/** This guard's own repo-relative path, derived from `__filename` rather than hand-typed, so a
 *  future rename cannot leave a stale literal behind — either it still resolves to this file, or
 *  the "self-exemption is exactly one file, and is load-bearing" test below reds. */
const SELF_PATH = path.relative(REPO_ROOT, __filename).split(path.sep).join('/')

/** Domain DERIVED from git, never a hand-maintained list. `exclude` defaults to this guard's own
 *  path (see SELF-EXEMPTION); pass `[]` to get the UNFILTERED domain for the self-exemption test. */
function trackedNonMarkdownFilesUnder(
  dirs: readonly string[],
  root: string = REPO_ROOT,
  exclude: readonly string[] = [SELF_PATH],
): string[] {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--', ...dirs], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  })
  return raw
    .toString('utf8')
    .split('\0')
    .filter((rel) => rel.length > 0)
    .filter((rel) => path.extname(rel).toLowerCase() !== '.md')
    .filter((rel) => !exclude.includes(rel))
    .sort()
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

describe('repo guard: no dangling `reviews/`-prefixed path reference outside Markdown', () => {
  it('the scanned domain is non-vacuous (scan negative control)', () => {
    const files = trackedNonMarkdownFilesUnder(SCAN_DIRS)
    expect(files.length).toBeGreaterThan(1000)
    expect(files).toContain(
      'packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts',
    )
  })

  it('self-exemption is exactly this one file, and is load-bearing (not vestigial)', () => {
    // The exclusion target really exists in the unfiltered domain — not a stale path pointing at
    // nothing (which would make the `exclude` list decorative).
    const unfiltered = trackedNonMarkdownFilesUnder(SCAN_DIRS, REPO_ROOT, [])
    expect(unfiltered).toContain(SELF_PATH)
    // ...and it genuinely WOULD fail the leg below if not excluded — the exemption removes a real
    // hit, not zero hits it never needed to remove.
    const selfHits = linesContainingToken([SELF_PATH], TOKEN)
    expect(selfHits.length).toBeGreaterThan(0)
    // With the default exclusion applied, this file is gone from the scanned domain.
    expect(trackedNonMarkdownFilesUnder(SCAN_DIRS)).not.toContain(SELF_PATH)
  })

  it('zero tracked non-Markdown file (other than this guard itself) under packages/**, apps/**, plugins/**, scripts/** contains the literal substring "review" + "s" + "/"', () => {
    const hits = linesContainingToken(trackedNonMarkdownFilesUnder(SCAN_DIRS), TOKEN)
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
