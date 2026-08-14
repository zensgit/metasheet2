/**
 * Repo guard — no source file may contain a raw NUL byte.
 *
 * WHY THIS EXISTS, and why it is a repository-level guard rather than a
 * per-file fix (see SCOPE below for exactly which files it reaches).
 *
 * A literal `U+0000` inside a source file (typically typed into a string
 * literal instead of the escape `\u0000`) makes git classify the whole file as
 * BINARY. The consequences are entirely to the REVIEW surface, and they are
 * severe out of proportion to the typo:
 *
 *   - the GitHub PR diff renders the file as `0+/0-` with the patch ABSENT;
 *   - `git diff --stat` reports `Bin 0 -> N bytes`, `0 insertions`;
 *   - `git grep` answers `Binary file … matches` — never a line, never content;
 *   - plain `grep` produces NO output and exits 1, which is INDISTINGUISHABLE
 *     from "the pattern is genuinely absent".
 *
 * That last one is the dangerous one: an empty grep over such a file is a lie,
 * not an absence.
 *
 * THIS IS THE SECOND OCCURRENCE OF THE CLASS in this line, which is why the
 * remedy is one mechanical gate rather than another point fix. The first was
 * caught in the Gate D2 round; the second shipped in W7-1a's
 * `w7-group-effective-context-issuance.ts` — a 379-line module implementing a
 * security boundary (W7-R1) — and it was invisible to the PR diff for the
 * entire review window. It also caused a concrete, demonstrated miss: a
 * deliberate, otherwise-rigorous file-by-file citation sweep that used `grep`
 * silently skipped that one file, leaving a stale citation in the only module
 * nobody could see. A careful author doing the right thing still lost, because
 * the tool lied. A third builder would repeat it.
 *
 * NOTHING ELSE IN CI CATCHES THIS. `packages/core-backend` has no `lint`
 * script, and the repo's only lint step resolves to a hardcoded `apps/web`
 * eslint file list, so backend sources are unlinted. `tsc` accepts a NUL
 * inside a string literal without complaint. This test is the only mechanical
 * defence.
 *
 * SCOPE — stated precisely, because an earlier draft of this paragraph
 * overclaimed it as "EVERY tracked source file … NO exclusions".
 *
 * What the NUL leg actually covers: every tracked file whose extension is one
 * of `.ts .tsx .js .cjs .mjs .sql .sh` — **4154** of the repository's 10954
 * tracked files at the time of writing, all clean, which is why the leg needs
 * no allowlist WITHIN that domain. The absence of exclusions is real; the
 * "every source file" part was not.
 *
 * What sits OUTSIDE it, counted rather than hand-waved: **267 hand-authored
 * files** — 242 `.vue`, 22 `.ps1`, 3 `.py` — plus non-source tracked files
 * (docs, JSON, YAML, assets). A raw NUL in any of those would make that file
 * binary to git and grep exactly as it did here, and this guard would not see
 * it. The 7-extension domain is where THIS defect actually occurred (a string
 * literal in a `.ts` module) and it is what shipped; widening it to `.vue`
 * and the scripting extensions is a straightforward, deliberately deferred
 * FOLLOW-UP, because widening a guard's domain is a behaviour change and this
 * commit is text-only. Whoever widens it should re-measure first: the
 * no-exclusions property above is a measured fact about the CURRENT domain,
 * not a promise that a larger one is equally clean.
 *
 * WHY NOT BAN ALL C0 CONTROL BYTES REPO-WIDE. Because `0x01` is a deliberate,
 * pre-existing in-repo delimiter in three files that this guard does not own
 * (`src/attendance/w4c1-segment-calculator.ts` and two plugin-integration
 * tests), plus one vendored minified bundle. Banning C0 repo-wide would
 * therefore need an exclusion list on day one. Instead the stricter
 * "no C0 at all" leg is scoped to the W7 slice's own directory, where the
 * escape convention is established and the set is genuinely empty — and where
 * a raw `U+001F` was very nearly shipped in the composite lock helper before
 * being caught by hand.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../../')

/** Extensions where this defect class lands: hand-authored source. Binary
 *  assets (images, fonts, archives) legitimately contain NUL and are not
 *  source, so they are not in the domain at all. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.sql', '.sh'])

/** Tab, LF and CR are the only control bytes a text source legitimately holds. */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d])

const W7_SLICE_DIR = 'packages/core-backend/src/attendance/w7-resolver'

/** Domain DERIVED from git, never a hand-maintained list — a file nobody
 *  listed is exactly what this guard has to see. */
function trackedSourceFiles(root: string = REPO_ROOT): string[] {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  })
  return raw
    .toString('utf8')
    .split('\0')
    .filter((rel) => rel.length > 0)
    .filter((rel) => SOURCE_EXTENSIONS.has(path.extname(rel)))
    .sort()
}

/** Files containing a raw NUL. Parameterised by root + list so the positive
 *  control can exercise THIS function — not a re-typed copy of it — against a
 *  decoy tree. */
function filesContainingRawNul(files: readonly string[], root: string = REPO_ROOT): string[] {
  return files.filter((rel) => fs.readFileSync(path.join(root, rel)).includes(0x00)).sort()
}

/** Files containing any control byte other than tab/LF/CR. */
function filesContainingOtherControlBytes(
  files: readonly string[],
  root: string = REPO_ROOT,
): Array<{ file: string; byte: string }> {
  const out: Array<{ file: string; byte: string }> = []
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(root, rel))
    const seen = new Set<number>()
    for (const byte of bytes) {
      if (byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte) && !seen.has(byte)) {
        seen.add(byte)
        out.push({ file: rel, byte: `0x${byte.toString(16).padStart(2, '0')}` })
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.byte.localeCompare(b.byte))
}

/** Writes files into an isolated temp tree that mirrors repo-relative paths.
 *  Never plants into the real tree: a real file created and deleted under
 *  `src/` races every sibling suite that walks it (a collision this repo has
 *  already hit), and `git ls-files` would not see it anyway. */
function withDecoyTree(files: Record<string, Buffer | string>, run: (decoyRoot: string) => void): void {
  const decoyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-guard-decoy-'))
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

describe('repo guard: source files contain no raw NUL byte', () => {
  it('the scanned domain is non-vacuous and really contains hand-authored source', () => {
    // A zero-length or wrongly-filtered domain would make every leg below pass
    // over nothing — the same "empty read is not an absence" failure this
    // guard exists to prevent, one level up.
    const files = trackedSourceFiles()
    expect(files.length).toBeGreaterThan(3000)
    expect(files).toContain('packages/core-backend/src/attendance/w4c0-identity.ts')
    expect(files).toContain(`${W7_SLICE_DIR}/w7-group-effective-context-issuance.ts`)
    expect(files).toContain('plugins/plugin-attendance/index.cjs')
  })

  it('NO tracked .ts/.tsx/.js/.cjs/.mjs/.sql/.sh file contains a raw NUL byte (no exclusions within that domain)', () => {
    expect(filesContainingRawNul(trackedSourceFiles())).toEqual([])
  })

  it('POSITIVE CONTROL: a planted raw NUL reds the leg', () => {
    // The bypass this guard exists to catch, written exactly as it shipped:
    // a domain-separator string terminated with a literal U+0000.
    const probe = 'packages/core-backend/src/attendance/w7-resolver/probe-with-nul.ts'
    withDecoyTree(
      {
        [probe]: Buffer.from(`export const DOMAIN = 'x\u0000'\n`, 'utf8'),
        'packages/core-backend/src/attendance/clean.ts': "export const DOMAIN = 'x\\u0000'\n",
      },
      (decoyRoot) => {
        const files = [probe, 'packages/core-backend/src/attendance/clean.ts']
        // The probe really does carry the byte (guards against a decoy that
        // silently wrote an escaped form instead).
        expect(fs.readFileSync(path.join(decoyRoot, probe)).includes(0x00)).toBe(true)

        expect(filesContainingRawNul(files, decoyRoot)).toEqual([probe])
        // ...and the ESCAPED sibling — the correct spelling, same visible
        // meaning — does NOT red. Without this the leg could be reading
        // "contains the text \u0000" rather than "contains the byte".
        expect(filesContainingRawNul(files, decoyRoot)).not.toContain(
          'packages/core-backend/src/attendance/clean.ts',
        )
      },
    )
  })
})

describe('repo guard: the W7 slice uses escapes, never raw control bytes', () => {
  it('no file under w7-resolver/ contains any control byte except tab/LF/CR', () => {
    // Stricter than the repo-wide leg and scoped to where the convention is
    // established. A raw U+001F was nearly shipped in the composite lock
    // helper's advisory-key delimiter; it is written `\u001f` today, and this
    // keeps it that way.
    const files = trackedSourceFiles().filter((rel) => rel.startsWith(`${W7_SLICE_DIR}/`))
    expect(files.length).toBeGreaterThanOrEqual(4)
    expect(filesContainingOtherControlBytes(files)).toEqual([])
  })

  it('POSITIVE CONTROL: a planted U+001F reds the stricter leg but NOT the NUL leg', () => {
    const probe = `${W7_SLICE_DIR}/probe-with-unit-separator.ts`
    withDecoyTree(
      { [probe]: Buffer.from(`export const SEP = 'a\u001fb'\n`, 'utf8') },
      (decoyRoot) => {
        expect(filesContainingOtherControlBytes([probe], decoyRoot)).toEqual([
          { file: probe, byte: '0x1f' },
        ])
        // Proves the two legs are independent rather than one firing for both.
        expect(filesContainingRawNul([probe], decoyRoot)).toEqual([])
      },
    )
  })

  it('the composite lock helper spells its delimiter as an escape, and its key still contains U+001F at RUNTIME', async () => {
    // The point is not "the source has no control byte" in isolation — that
    // would be satisfied by deleting the delimiter. The runtime VALUE must be
    // unchanged. Both halves asserted together.
    const source = fs.readFileSync(
      path.join(REPO_ROOT, W7_SLICE_DIR, 'w7-composite-lock-order.ts'),
      'utf8',
    )
    expect(source).toContain("const UNIT_SEPARATOR = '\\u001f'")

    const { buildAttendanceW7MembershipTimelineLockKeyV1 } = await import(
      '../../src/attendance/w7-resolver/w7-composite-lock-order'
    )
    const key = buildAttendanceW7MembershipTimelineLockKeyV1('org', 'user')
    expect(key).toBe('attendance-calc-timeline\u001forg\u001fuser')
    expect(key.includes('\u001f')).toBe(true)
  })
})
