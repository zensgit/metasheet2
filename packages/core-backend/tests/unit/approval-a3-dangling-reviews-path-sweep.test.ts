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
 * SELF-EXEMPTION above). `node_modules` is excluded via `git ls-files` (never walks it). This is
 * the exact scope + exclusion the round-2 gate report's own mechanical evidence used:
 * `git grep -n "reviews/" -- 'packages/**' 'apps/**' 'plugins/**' 'scripts/**' | grep -v '\.md:'`.
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
