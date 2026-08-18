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
 * What the NUL leg covers: every tracked file whose extension is in
 * `SOURCE_EXTENSIONS` below — derive the live count yourself rather than
 * trusting a number pasted into a comment (that is this paragraph's own
 * lesson, twice over now):
 *
 *   git ls-files | grep -cE '\.(ts|tsx|js|cjs|mjs|sql|sh|vue|ps1|py)$'
 *
 * WIDENING HISTORY. Landed as `.ts .tsx .js .cjs .mjs .sql .sh` (7
 * extensions, 4154 of 10954 tracked files at the time). #4908 widened it to
 * add `.vue .ps1 .py` — the three extensions the issue named, and counted
 * OUTSIDE the original domain when it was drafted: 242 + 22 + 3 = 267 files,
 * exactly the "267 hand-authored files" figure #4908 cited. #4908
 * RE-MEASURED the widened set before flipping the switch, per this
 * docstring's own instruction to whoever widens it next: all 267 files were
 * clean of both a raw NUL and every other C0 byte (`git ls-files -z --cached`
 * piped through the same byte scan the tests below run) — a measured fact
 * about that domain at that commit, not a promise that stays true forever.
 *
 * #4908 also went looking for OTHER tracked extensions that might be the same
 * class before writing this section, rather than asserting the three named
 * ones were the only candidates — the earlier overclaim this paragraph
 * already warns about, reincarnated one level up, is exactly the mistake of
 * saying "nothing else qualifies" without having looked:
 *   - `.yml`/`.yaml` (133 tracked): structured config consumed by a parser,
 *     not code with this defect class's string-literal escape idiom. NOT
 *     byte-scanned — excluded on category, same reasoning as docs/JSON.
 *   - `.bat` (1 file, a Windows batch script — same class as `.sh`/`.ps1`)
 *     and `.rhai` (1 file, a Rhai script): genuinely hand-authored scripting
 *     source, same defect-class risk as what's already in the domain.
 *     Byte-scanned clean (0 NUL, 0 other C0) but left OUT of #4908's
 *     `SOURCE_EXTENSIONS` change because they weren't what the issue asked
 *     for — a deliberate deferral, not an oversight; whoever widens next
 *     should treat them as pending, not re-derive that they exist.
 *   - `.css` (5 files) and `.html` (12 files): hand-authored but declarative
 *     markup/stylesheet, not procedural source in this defect class's sense.
 *     Byte-scanned clean (0 NUL, 0 other C0) anyway and adjudicated OUT on
 *     category, same footing as `.yml`/`.yaml`.
 *
 * What still sits OUTSIDE the (now 10-extension) domain: everything above
 * that was left out, plus non-source tracked files never considered
 * candidates at all — docs, JSON, other assets. A raw NUL in any of those
 * would make that file binary to git and grep exactly as it did here, and
 * this guard would not see it.
 *
 * WHY NOT BAN ALL C0 CONTROL BYTES REPO-WIDE. Because `0x01` is a deliberate,
 * pre-existing in-repo delimiter in three files that this guard does not own
 * (`src/attendance/w4c1-segment-calculator.ts` and two plugin-integration
 * tests), plus one vendored minified bundle (a different, non-`0x01` pair of
 * C0 bytes, already binary-hostile on its own terms and out of this guard's
 * remit either way). Banning C0 repo-wide would therefore need an exclusion
 * list on day one. Instead the stricter "no C0 at all" leg is scoped to the
 * W7 slice's own directory, where the escape convention is established and
 * the set is genuinely empty — and where a raw `U+001F` was very nearly
 * shipped in the composite lock helper before being caught by hand. #4908
 * re-checked `0x01` specifically across the WIDENED domain (the new `.vue
 * .ps1 .py` files included, not just the original 7 extensions): still
 * exactly those same three pre-existing carriers, no new ones introduced by
 * the widening. A test below keeps that an executable fact rather than a
 * comment someone forgets to update.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../../')

/** Extensions where this defect class lands: hand-authored source. Binary
 *  assets (images, fonts, archives) legitimately contain NUL and are not
 *  source, so they are not in the domain at all. Widened by #4908 to add
 *  `.vue .ps1 .py` — the three extensions the issue named (re-measured clean
 *  first — see docstring above). `.bat`/`.rhai`/`.css`/`.html`/`.yml`/`.yaml`
 *  were also considered (byte-scanned or category-excluded — see docstring);
 *  none of them were folded into this change. */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.cjs',
  '.mjs',
  '.sql',
  '.sh',
  '.vue',
  '.ps1',
  '.py',
])

/** Tab, LF and CR are the only control bytes a text source legitimately holds. */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d])

const W7_SLICE_DIR = 'packages/core-backend/src/attendance/w7-resolver'

/** The only files anywhere in the (now widened) domain allowed to carry a
 *  deliberate `0x01` delimiter — see "WHY NOT BAN ALL C0 CONTROL BYTES
 *  REPO-WIDE" above. A file added to this set is a design decision, not a
 *  test fixture; anything else that starts carrying `0x01` is either an
 *  accident or needs its own reviewed addition here. */
const KNOWN_0X01_CARRIERS = new Set([
  'packages/core-backend/src/attendance/w4c1-segment-calculator.ts',
  'plugins/plugin-integration-core/__tests__/k3-df-t1-target-payload-preview.test.cjs',
  'plugins/plugin-integration-core/__tests__/read-source-probe-runtime.test.cjs',
])

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
    expect(files.length).toBeGreaterThan(4000)
    expect(files).toContain('packages/core-backend/src/attendance/w4c0-identity.ts')
    expect(files).toContain(`${W7_SLICE_DIR}/w7-group-effective-context-issuance.ts`)
    expect(files).toContain('plugins/plugin-attendance/index.cjs')
    // #4908 widening — proves the filter genuinely reaches the three new
    // extensions rather than just growing SOURCE_EXTENSIONS in the const
    // without the domain function actually picking them up.
    expect(files).toContain('apps/web/src/App.vue')
    expect(files).toContain('apps/web/src/views/AttendanceView.vue')
    expect(files).toContain('scripts/ops/attendance-onprem-deploy-run.ps1')
    expect(files).toContain('scripts/ops/github-dingtalk-oauth-stability-summary.py')
  })

  it('NO tracked .ts/.tsx/.js/.cjs/.mjs/.sql/.sh/.vue/.ps1/.py file contains a raw NUL byte (no exclusions within that domain)', () => {
    expect(filesContainingRawNul(trackedSourceFiles())).toEqual([])
  })

  it('0x01 is confined to exactly the three known pre-existing delimiter carriers, across the WIDENED domain', () => {
    // Turns the docstring's "re-verified, no new 0x01 carriers" claim into an
    // executable fact instead of a comment someone forgets to update the next
    // time the domain widens. Scoped to 0x01 only — the vendored minified
    // bundle legitimately carries other C0 bytes and is out of this guard's
    // remit either way (see docstring).
    const carriers = filesContainingOtherControlBytes(trackedSourceFiles())
      .filter((hit) => hit.byte === '0x01')
      .map((hit) => hit.file)
    expect(new Set(carriers)).toEqual(KNOWN_0X01_CARRIERS)
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

  it('POSITIVE CONTROL (#4908 widening): a planted raw NUL in a .vue SFC reds the leg', () => {
    // Proves the widened domain is actually exercised, not just declared: a
    // NUL inside a Vue single-file component's script block, the format that
    // made up 242 of the 267 files this ticket brought into scope.
    const probe = 'apps/web/src/views/probe-with-nul.vue'
    withDecoyTree(
      {
        [probe]: Buffer.from(
          `<script setup lang="ts">\nconst label = 'x\u0000'\n</script>\n<template><div>{{ label }}</div></template>\n`,
          'utf8',
        ),
        'apps/web/src/views/clean.vue':
          "<script setup lang='ts'>\nconst label = 'x\\u0000'\n</script>\n<template><div>{{ label }}</div></template>\n",
      },
      (decoyRoot) => {
        const files = [probe, 'apps/web/src/views/clean.vue']
        expect(fs.readFileSync(path.join(decoyRoot, probe)).includes(0x00)).toBe(true)
        expect(filesContainingRawNul(files, decoyRoot)).toEqual([probe])
        expect(filesContainingRawNul(files, decoyRoot)).not.toContain('apps/web/src/views/clean.vue')
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
