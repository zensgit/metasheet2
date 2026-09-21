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
 * WHY THE TOKEN MUST BE THE BARE PREFIX, NOT A LARGER PHRASE. `reviews/` is what a repo-relative
 * path reference to a nonexistent directory actually looks like in a doc comment
 * (`` `reviews/whatever.md` ``); it is also what this guard's own disclaimer wording must NOT
 * contain, on pain of never being able to reach zero hits — round 2's own diagnosis of this: the
 * fix wording MUST be phrased to avoid the literal substring "reviews/" (e.g. cite the bare
 * filename plus "a private review record, not tracked in this repository", never "not under a
 * repo `reviews/` directory" — that disclaimer sentence itself contains the very token it is
 * trying to rule out). This test enforces that discipline going forward: if a future edit
 * reintroduces the substring anywhere in scope — including inside a NEW disclaimer sentence that
 * makes the same mistake — it reddens, rather than silently accepting a "fixed" reference that
 * still isn't clean.
 *
 * SCOPE. Tracked files under `packages/**`, `apps/**`, `plugins/**`, `scripts/**`, excluding
 * `.md` files (Markdown review/design/verification docs legitimately narrate review-record
 * filenames and paths in prose; this guard is about paths a reader might follow expecting an
 * in-repo target, i.e. non-Markdown source/config/test files). `node_modules` is excluded via
 * `git ls-files` (never walks it). This is the exact scope + exclusion the round-2 gate report's
 * own mechanical evidence used: `git grep -n "reviews/" -- 'packages/**' 'apps/**' 'plugins/**'
 * 'scripts/**' | grep -v '\.md:'`.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../')
const SCAN_DIRS = ['packages', 'apps', 'plugins', 'scripts']
const TOKEN = 'reviews/'

/** Domain DERIVED from git, never a hand-maintained list. */
function trackedNonMarkdownFilesUnder(dirs: readonly string[], root: string = REPO_ROOT): string[] {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--', ...dirs], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  })
  return raw
    .toString('utf8')
    .split('\0')
    .filter((rel) => rel.length > 0)
    .filter((rel) => path.extname(rel).toLowerCase() !== '.md')
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

  it('zero tracked non-Markdown file under packages/**, apps/**, plugins/**, scripts/** contains the literal substring "reviews/"', () => {
    const hits = linesContainingToken(trackedNonMarkdownFilesUnder(SCAN_DIRS), TOKEN)
    expect(hits).toEqual([])
  })

  it('POSITIVE CONTROL: a planted `reviews/`-prefixed reference reds the leg', () => {
    const probe = 'packages/core-backend/src/probe-with-dangling-reviews-path.ts'
    withDecoyTree(
      {
        [probe]: "// see `reviews/some-report.md` for the full writeup\nexport const X = 1\n",
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
