/**
 * W4C-5 transition-safety amendment completion gate 9: repository inventory.
 *
 * The hardened boundary in w4c3a-rollout-control.ts is the ONLY place allowed
 * to write attendance_calculation_rollout_state or attendance_calculation_
 * rollout_events. No route, generic plugin service, or second competing
 * transition implementation may exist; tooling may only call this module's
 * exported functions, never write rollout DML directly.
 *
 * This is a mechanical, exhaustive grep over the ENTIRE repository source
 * (excluding node_modules/dist/build output and this module + its migration/
 * test files themselves, which are the one authorized writer + its schema +
 * its own coverage). It is a single inert gate: any match anywhere else fails
 * the test, so a future writer cannot silently slip past a narrower allowlist.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests,
  ATTENDANCE_W4C2_AUTHORITATIVE_ENTRYPOINTS_V1,
  isAttendanceW4C2AuthoritativeEntrypointDeliveredV1,
  type AttendanceW4C2AuthoritativeEntrypointV1,
} from '../w4c2-authoritative-delivery'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')

const EXCLUDED_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.turbo',
  'coverage',
  '.claude',
])

// The one authorized writer (implementation), its append-only migration (schema DDL, not a
// second writer), and this inventory test's own file (whose comment text intentionally names
// the guarded SQL for documentation purposes) are the only allowed matches.
const ALLOWED_RELATIVE_FILES = new Set([
  'packages/core-backend/src/attendance/w4c3a-rollout-control.ts',
  'packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts',
  'packages/core-backend/src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts',
])

// Real-DB integration specs are allowed to directly seed/assert the rollout tables as FIXTURE
// setup (never as production DML) — they exercise the guarded boundary, they do not replace it.
const ALLOWED_DIRECTORY_PREFIXES = ['packages/core-backend/tests/integration/']

// Raw-SQL text is not the only DML surface: a Kysely query-builder call never spells the SQL
// verb as text, and a shell script driving `psql -c "..."` or a standalone `.sql` file is common
// operator-tooling shape (repo doctrine 写入点审计要双语法 — a writer-inventory audit that only
// greps one syntax is a landmine the amendment's own §5 warns about: "Preparation must not add
// direct rollout DML, a raw SQL escape hatch" — and operator tooling is exactly what ships as
// `.sql`/`.sh`/psql).
const TARGET_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.sql', '.sh'])

const ROLLOUT_DML_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: 'UPDATE attendance_calculation_rollout_state', pattern: /UPDATE\s+attendance_calculation_rollout_state/i },
  { label: 'INSERT INTO attendance_calculation_rollout_state', pattern: /INSERT\s+INTO\s+attendance_calculation_rollout_state/i },
  { label: 'INSERT INTO attendance_calculation_rollout_events', pattern: /INSERT\s+INTO\s+attendance_calculation_rollout_events/i },
  // Kysely query-builder syntax over the same two tables — never spells UPDATE/INSERT as text.
  { label: 'Kysely updateTable(attendance_calculation_rollout_state)', pattern: /\.updateTable\(\s*['"`]attendance_calculation_rollout_state['"`]/i },
  { label: 'Kysely insertInto(attendance_calculation_rollout_state)', pattern: /\.insertInto\(\s*['"`]attendance_calculation_rollout_state['"`]/i },
  { label: 'Kysely insertInto(attendance_calculation_rollout_events)', pattern: /\.insertInto\(\s*['"`]attendance_calculation_rollout_events['"`]/i },
]

/**
 * NIT-3 (PR #4773 exact-head independent gate, 20260805): the real full-repo gate below walks
 * `git ls-files` (git-TRACKED files only), not the raw working tree, so an untracked developer
 * scratch file matching one of the patterns cannot red a required check it was never meant to
 * gate — this test's job is repository inventory, not working-directory hygiene. `git ls-files
 * -z --cached --others --exclude-standard` includes tracked files AND untracked-but-not-ignored
 * files would normally slip in via `--others`; deliberately using `--cached` ONLY (tracked files
 * as of the index/HEAD) is the fix, not an oversight — see the sanity assertion below.
 */
function listGitTrackedFiles(rootDir: string): string[] {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: rootDir, maxBuffer: 64 * 1024 * 1024 })
  return raw
    .toString('utf8')
    .split('\0')
    .filter((relative) => relative.length > 0)
    .filter((relative) => TARGET_EXTENSIONS.has(path.extname(relative)))
    .filter((relative) => !relative.split('/').some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment)))
    .map((relative) => path.join(rootDir, relative))
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_SEGMENTS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (!TARGET_EXTENSIONS.has(path.extname(entry.name))) continue
    out.push(path.join(dir, entry.name))
  }
}

// Shared by the real full-repo gate and the isolated decoy tests below, so a decoy test proves
// the exact same detection code the real gate runs — not a re-implementation that could drift.
function findRolloutDmlOffenders(
  rootDir: string,
  files: readonly string[],
  options: { allowedRelativeFiles?: ReadonlySet<string>; allowedDirectoryPrefixes?: readonly string[] } = {},
): Array<{ file: string; label: string }> {
  const allowedRelativeFiles = options.allowedRelativeFiles ?? new Set<string>()
  const allowedDirectoryPrefixes = options.allowedDirectoryPrefixes ?? []
  const offenders: Array<{ file: string; label: string }> = []
  for (const absolute of files) {
    const relative = path.relative(rootDir, absolute).split(path.sep).join('/')
    if (allowedRelativeFiles.has(relative)) continue
    if (allowedDirectoryPrefixes.some((prefix) => relative.startsWith(prefix))) continue
    const content = fs.readFileSync(absolute, 'utf8')
    for (const { label, pattern } of ROLLOUT_DML_PATTERNS) {
      if (pattern.test(content)) offenders.push({ file: relative, label })
    }
  }
  return offenders
}

describe('W4C-5 repository inventory: rollout-state/event DML has exactly one writer', () => {
  it('finds rollout-state/event DML only in the hardened boundary, its migration, and integration fixtures', () => {
    const files = listGitTrackedFiles(ROOT)
    expect(files.length).toBeGreaterThan(100) // sanity: git ls-files actually found the repo

    const offenders = findRolloutDmlOffenders(ROOT, files, {
      allowedRelativeFiles: ALLOWED_RELATIVE_FILES,
      allowedDirectoryPrefixes: ALLOWED_DIRECTORY_PREFIXES,
    })
    expect(offenders).toEqual([])
  })

  it('NIT-3: an untracked scratch file matching the pattern is NOT walked by the real gate (git-tracked only)', () => {
    // Positive proof the fix actually changed behavior: write a real untracked file INSIDE the
    // repo tree (not an isolated os.tmpdir() decoy) containing an offending pattern, confirm the
    // real gate's file list does not include it, then clean up. If this ever regresses back to
    // a raw filesystem walk, this file WOULD appear in `files` and the assertion below reds.
    const scratchPath = path.join(ROOT, 'packages/core-backend/src/attendance/zz-nit3-untracked-scratch.ts')
    fs.writeFileSync(scratchPath, "export const x = 'UPDATE attendance_calculation_rollout_state SET state = 1'\n")
    try {
      const files = listGitTrackedFiles(ROOT)
      const relatives = files.map((absolute) => path.relative(ROOT, absolute).split(path.sep).join('/'))
      expect(relatives).not.toContain('packages/core-backend/src/attendance/zz-nit3-untracked-scratch.ts')
    } finally {
      fs.rmSync(scratchPath, { force: true })
    }
  })

  it('positive control: the pattern set actually matches the hardened boundary file itself', () => {
    const target = path.join(ROOT, 'packages/core-backend/src/attendance/w4c3a-rollout-control.ts')
    const content = fs.readFileSync(target, 'utf8')
    const matched = ROLLOUT_DML_PATTERNS.filter(({ pattern }) => pattern.test(content))
    expect(matched.length).toBeGreaterThan(0)
  })
})

// P2-2 (PR #4773 exact-head independent gate, 20260805): the pre-fix pattern/extension set was
// raw-SQL-text-only and .ts/.tsx/.js/.cjs/.mjs-only, so a Kysely query-builder call, a standalone
// `.sql` file, or a `.sh` script driving `psql -c "..."` all walked straight past the gate
// (repo landmine 写入点审计要双语法 — a writer-inventory audit that only greps one syntax).
// These decoys run against isolated OS-tmp scratch directories (never inside the repo tree, so
// they cannot themselves become an untracked-file false-positive against the real gate above)
// but exercise the exact same `walk` + `findRolloutDmlOffenders` pipeline the real gate uses.
describe('W4C-5 repository inventory gate 9: bypass-syntax decoys are caught (写入点审计要双语法)', () => {
  function withScratchDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w4c5-gate9-decoy-'))
    try {
      fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('decoy: Kysely query-builder DML (.ts) — updateTable(state) + insertInto(events)', () => {
    withScratchDir((dir) => {
      fs.writeFileSync(
        path.join(dir, 'zz-decoy-tooling.ts'),
        [
          "export async function decoyTransition(trx: unknown, orgId: string, targetState: string) {",
          "  await (trx as any).updateTable('attendance_calculation_rollout_state')",
          "    .set({ state: targetState }).where('org_id', '=', orgId).execute()",
          "  await (trx as any).insertInto('attendance_calculation_rollout_events')",
          "    .values({ orgId, targetState }).execute()",
          "}",
        ].join('\n'),
      )
      const files: string[] = []
      walk(dir, files)
      const offenders = findRolloutDmlOffenders(dir, files)
      expect(offenders.map((o) => o.label).sort()).toEqual([
        'Kysely insertInto(attendance_calculation_rollout_events)',
        'Kysely updateTable(attendance_calculation_rollout_state)',
      ])
    })
  })

  it('decoy: standalone .sql file — raw UPDATE/INSERT against both rollout tables', () => {
    withScratchDir((dir) => {
      const file = path.join(dir, 'zz-decoy-tooling.sql')
      fs.writeFileSync(
        file,
        [
          "UPDATE attendance_calculation_rollout_state SET state = 'shadow' WHERE org_id = 'demo';",
          "INSERT INTO attendance_calculation_rollout_events (org_id, prior_state, new_state) VALUES ('demo', 'legacy', 'shadow');",
        ].join('\n'),
      )
      const files: string[] = []
      walk(dir, files)
      expect(files).toEqual([file])
      const offenders = findRolloutDmlOffenders(dir, files)
      expect(offenders.map((o) => o.label).sort()).toEqual([
        'INSERT INTO attendance_calculation_rollout_events',
        'UPDATE attendance_calculation_rollout_state',
      ])
    })
  })

  it('decoy: .sh script driving `psql -c "UPDATE ..."`', () => {
    withScratchDir((dir) => {
      fs.writeFileSync(
        path.join(dir, 'zz-decoy-tooling.sh'),
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'psql "$DATABASE_URL" -c "UPDATE attendance_calculation_rollout_state SET state = '
            + "'shadow' WHERE org_id = 'demo'\"",
        ].join('\n'),
      )
      const files: string[] = []
      walk(dir, files)
      const offenders = findRolloutDmlOffenders(dir, files)
      expect(offenders.map((o) => o.label)).toEqual(['UPDATE attendance_calculation_rollout_state'])
    })
  })

  it('negative control: a plain SELECT in each of the three syntaxes is not flagged', () => {
    withScratchDir((dir) => {
      fs.writeFileSync(
        path.join(dir, 'zz-read.ts'),
        "export const decoyRead = (trx: any) => trx.selectFrom('attendance_calculation_rollout_state').selectAll().execute()",
      )
      fs.writeFileSync(path.join(dir, 'zz-read.sql'), 'SELECT * FROM attendance_calculation_rollout_state;')
      fs.writeFileSync(path.join(dir, 'zz-read.sh'), 'psql -c "SELECT * FROM attendance_calculation_rollout_state"')
      const files: string[] = []
      walk(dir, files)
      expect(files.length).toBe(3)
      const offenders = findRolloutDmlOffenders(dir, files)
      expect(offenders).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Gate D (owner completion gate, PR #4839, 20260810; hardened to per-key + unrepresented-site
// detection in the same PR's fresh-gate round, 20260810). The declaration/code correspondence
// guard.
//
// `w4c2-authoritative-delivery.ts` is a pure, filesystem-free leaf that declares whether each
// W4C-2 authoritative-mode entrypoint is delivered. That declaration is what
// `transitionAttendanceCalculationRolloutV1` refuses promotion on — nothing here re-checks THAT
// behaviourally (the real-DB test in `attendance-w4c3a-rollout-control.db.test.ts` does). This
// suite's job is narrower and complementary: prove the declaration cannot silently disagree with
// the actual refusal-call-site count in `w4c2-live-scheduled-boundary.ts` — the exact drift this
// module's own docblock says is enforced "not here."
//
// P2 (fresh-gate round): the original correspondence assertion compared an AGGREGATE — a
// hand-maintained per-key weight table SUMMED, checked against a single whole-file call count.
// An aggregate is blind to a CROSS-KEY edit: swap the two keys' weights and the sum is
// unchanged, so the guard stays green while the per-key meaning has silently inverted. Fixed by
// attributing each INDIVIDUAL refusal call to the specific function it lexically sits inside
// (brace-matched source-range extraction, never a hand count), then comparing PER KEY —
// `toEqual` on a `{key: count}` object, not a sum — so a cross-key edit now reds (proven directly
// by a dedicated mutation test below, distinct from the pre-existing delivered-flip mutation).
//
// P3 (fresh-gate round): the two-key tuple had no mechanical link to the boundary source — a
// THIRD authoritative-writing dispatch site added later (a new named function containing the
// same refusal call this file's `REFUSAL_CALL_PATTERN` matches — not spelled literally here, to
// avoid this very comment self-matching that pattern, see the "exactly one file" test below)
// would be invisible to both the declaration and the old guard, which would keep reporting
// "fully accounted for" over an incomplete domain. Fixed by attributing EVERY refusal call in
// the file to its innermost enclosing named function (not just the two currently expected) and
// failing closed if that
// discovers a function outside `KEY_TO_FUNCTION_NAME`'s image, OR a call inside no named function
// at all — a bare `continue`/drop on the "no enclosing function found" case would silently
// reopen this exact hole (a module-level arrow function's refusal call would vanish rather than
// count as unrepresented), so it is bucketed as `unattributedCount` and asserted `=== 0`
// explicitly.
//
// P2 (gate-2 round, CHANGES-REQUESTED, PR #4839, 20260810): the previous paragraph claimed this
// bucket had "its own negative control proving the bucket isn't just always empty by
// construction" — untrue at the time: the only assertion touching `unattributedCount` was the
// conservation check below (attributed + unattributed === total occurrences), which passes
// UNCHANGED even if `unattributedCount += 1` is replaced with a silent drop, because production
// content never exercises that branch (all three real refusal calls sit inside a named
// function), so `unattributedCount` is 0 either way and the conservation equation still balances
// at 0 + 3 = 3. Fixed by adding a genuine negative control: a dedicated test drives
// `attributeRefusalCallsV1` over a SYNTHETIC source string containing a refusal call inside a
// top-level arrow function (no enclosing named `function` at all) and asserts it lands in
// `unattributedCount`, not silently dropped. Proven load-bearing directly, not merely asserted:
// deleting the `unattributedCount += 1` increment reds THAT test while the conservation check
// stays green on the REAL file's content — the exact contrast that shows the conservation check
// alone was never sufficient.
//
// P3 (gate-2 round, CHANGES-REQUESTED, PR #4839, 20260810): the attribution pattern used to be
// anchored on the WHOLE call form (`boundaryFail('...', 503)`, single-quoted, status 503
// literal) — a 4th dispatch site spelled `boundaryFail("...", 503)` (double quotes),
// `boundaryFail('...', 500)` (a different status), or with the code hoisted into a local `const`
// (`const CODE = '...'; boundaryFail(CODE, 503)`) was invisible to that pattern and so
// contributed to neither `counts` nor `unattributedCount` — the "unmapped/4th dispatch site
// fails closed" test below stayed green over an undetected dispatch site, broader than what the
// mechanism delivered (its own title claimed more than it covered). Fixed by attributing on the
// quoted error-code NAME's occurrence (`REFUSAL_CALL_CODE_NAME_PATTERN`, matching either quote
// character, in any surrounding call syntax) rather than the surrounding call form — see that
// pattern's own comment for why it is scoped to this file's content only and never reused for
// the repo-wide scan below.
//
// Disclosed scope — what this does NOT cover, stated rather than left for a reader to find:
//   - Only THIS ONE file (`w4c2-live-scheduled-boundary.ts`) is scanned for attribution. A
//     refusal call added to a DIFFERENT file spelled in the CANONICAL form (single-quoted,
//     status 503, literal `boundaryFail(...)` call) is caught by the sibling "exactly one
//     git-tracked src file" test below (which reds if that exact pattern ever appears in a
//     second file), not by the attribution logic here. Since the P2/P3 fix below (gate-2 round)
//     split the attribution pattern from the repo-wide-scan pattern (necessarily — see
//     REFUSAL_CALL_PATTERN's own comment for why widening the repo-wide one is unsafe), this
//     sibling test no longer covers every spelling either: a second file spelling the call
//     double-quoted, with a different status code, or with the code hoisted into a local const
//     evades BOTH the repo-wide scan (strict pattern) AND the attribution logic (single-file
//     scoped) — verified directly. Cross-file addition in a non-canonical spelling is an
//     uncovered combination, named here rather than left for a reader to rediscover.
//   - Attribution is by LEXICAL nesting inside a NAMED `function` declaration, located by regex
//     plus brace-depth counting — not a real parser. It is verified safe for THIS file's actual
//     content (no string/comment hides an unbalanced brace inside either target function's
//     range), not proven safe in general.
//   - Attribution counts LEXICAL occurrences of a matched refusal call, not RUNTIME
//     REACHABILITY. Dead code still counts: wrapping a genuine call in an always-false guard
//     (e.g. `if (false && posture.effectiveState === 'authoritative') { boundaryFail(...) }`)
//     leaves every count and the whole suite unchanged, because nothing here evaluates control
//     flow — it locates text inside brace-matched ranges. This guard proves DECLARATION-vs-
//     CALL-SITE-TEXT correspondence, not that the call path is live (the real-DB behavioural
//     suite in `attendance-w4c3a-rollout-control.db.test.ts` is what exercises actual reachability).
//   - `REFUSAL_CALL_CODE_NAME_PATTERN` (the P2 fix above) still has a residual, disclosed gap
//     rather than a chased one (repo doctrine: enumerating spellings does not converge —
//     feedback_trap_enumeration_does_not_converge.md): a dispatch site spelling the code name
//     BACKTICK-quoted (`` `W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED` ``, the same quoting this
//     module's own header prose uses) or split/concatenated across multiple string literals
//     still evades it. The backtick exclusion is deliberate — it is exactly what keeps this
//     pattern from self-matching the header's own prose mention — but it is also a real hole in
//     the other direction, named here rather than left for a reader to rediscover.
//   - The map from declared key to function name (`KEY_TO_FUNCTION_NAME`) is still a reviewed,
//     hand-maintained pair — a rename of `executeLivePunch`/`executeScheduledRunInternal`
//     without updating that map fails closed (the old name vanishes from the discovered set, the
//     per-key comparison mismatches) rather than being auto-followed.
//   - This proves the DECLARATION does not silently drift from the CALL-SITE COUNT. It does not
//     independently prove those call sites are the semantically correct ones — that is the
//     real-DB behavioural suite's job.
// ---------------------------------------------------------------------------
describe('Gate D: W4C2 authoritative-entrypoint delivery declaration <-> boundary-source correspondence', () => {
  const BOUNDARY_RELATIVE_FILE = 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts'

  // The ONE hand-maintained mapping this guard trusts: which named function in the boundary file
  // implements each declared entrypoint key. Typed as `Record<Key, string>` so TypeScript itself
  // refuses to compile this file if a key is ever added to
  // `ATTENDANCE_W4C2_AUTHORITATIVE_ENTRYPOINTS_V1` without a matching entry added here.
  const KEY_TO_FUNCTION_NAME: Readonly<Record<AttendanceW4C2AuthoritativeEntrypointV1, string>> = Object.freeze({
    live_punch: 'executeLivePunch',
    scheduled: 'executeScheduledRunInternal',
  })

  // Independently counted by reading the boundary source at this PR's reviewed head: `live_punch`
  // (inside `executeLivePunch`) has exactly 0 refusal call sites — Gate D2 (#4844) shipped its
  // authoritative writer and removed the one site it had; `scheduled` (inside
  // `executeScheduledRunInternal`, both its org-wide probe and its per-target loop — the SAME
  // command kind per that module's own header) still has exactly 2. Checked PER KEY against a
  // source-range-scoped count below (`attributeRefusalCallsV1`), never against a whole-file sum.
  //
  // WHY THE WEIGHT ITSELF MOVES (not just the declaration): this table is the "how many sites
  // SHOULD exist while undelivered" side of the correspondence. `expectedByKeyV1()` reads it only
  // for keys declared UNDELIVERED, so once `live_punch` is delivered its expected count is 0 by
  // the delivery declaration alone. Leaving the weight at 1 would still break the cross-key
  // aggregate leg below, which reads the raw weights directly.
  const REFUSAL_SITE_WEIGHT: Readonly<Record<AttendanceW4C2AuthoritativeEntrypointV1, number>> = Object.freeze({
    live_punch: 0,
    scheduled: 2,
  })

  // Exact literal call, not a loose substring: does not match the module header's own prose
  // mention of the bare code string (backticked, never inside a `boundaryFail(...)` call). Used
  // ONLY for (a) the repo-wide "exactly one file" scan below and (b) the whole-file total
  // assertions, both of which want the narrow, literal thing their own titles say: "the EXACT
  // refusal-call pattern" / "each function carries its exact expected count". Deliberately NOT
  // the pattern `attributeRefusalCallsV1` uses for per-key/unmapped-site attribution — see
  // `REFUSAL_CALL_CODE_NAME_PATTERN` below for why widening THIS pattern repo-wide would be
  // unsafe: verified — scanning `packages/core-backend/src/` with a bare quote-name-quote
  // pattern (no call-form anchor) hits THREE files, not one: this test file's own regex-literal
  // definition just below (it spells the quoted code name verbatim to construct the regex), and
  // `w4c2-authoritative-delivery.ts`'s docblock prose (which quotes the call form as a worked
  // example) — the boundary file is only the third.
  const REFUSAL_CALL_PATTERN = /boundaryFail\(\s*'W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED'\s*,\s*503\s*\)/g

  function countRefusalCalls(content: string): number {
    return (content.match(REFUSAL_CALL_PATTERN) ?? []).length
  }

  // P3 fix (gate-2 round, CHANGES-REQUESTED, PR #4839, 20260810): anchors on the quoted
  // error-code NAME's occurrence — either quote character, no requirement on the surrounding
  // call syntax or trailing status code — so a 4th dispatch site written as
  // `boundaryFail("...", 503)` (double quotes), `boundaryFail('...', 500)` (a different status),
  // or `const CODE = '...'; boundaryFail(CODE, 503)` (code hoisted into a local const, attributed
  // to whatever function lexically encloses the `const` declaration) all still attribute/count,
  // where `REFUSAL_CALL_PATTERN` above would see none of them.
  //
  // Safe to apply ONLY to `w4c2-live-scheduled-boundary.ts`'s own content (never repo-wide — see
  // `REFUSAL_CALL_PATTERN`'s comment for the two other files a repo-wide scan would then hit).
  // Within THIS ONE file the code name appears in single/double quotes exclusively at the three
  // genuine dispatch sites; its header-prose mention is backtick-quoted and this pattern only
  // matches `'...'`/`"..."`, never `` `...` `` — verified: exactly 3 matches, none at the header
  // line. Residual, disclosed (not chased) gap: a backtick-quoted or split/concatenated spelling
  // of the code name still evades this pattern too — see the Gate D docblock's "Disclosed scope"
  // list above.
  const REFUSAL_CALL_CODE_NAME_PATTERN = /(['"])W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED\1/g

  function countRefusalCallCodeNameOccurrences(content: string): number {
    return (content.match(REFUSAL_CALL_CODE_NAME_PATTERN) ?? []).length
  }

  // ---- brace-matched function-range extraction: source of truth for per-key attribution ----

  type FunctionRange = { readonly name: string; readonly bodyStart: number; readonly bodyEnd: number }

  /**
   * Every NAMED `function` declaration in `content`, with its brace-matched body range (the
   * opening '{' index through its matching closing '}' index). Deliberately regex + brace-depth
   * counting, not a real parser. A declaration whose parameter list or opening brace cannot be
   * located is skipped, never silently mis-ranged.
   */
  function findAllFunctionRanges(content: string): FunctionRange[] {
    const declPattern = /(?:async\s+)?function\s*\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g
    const ranges: FunctionRange[] = []
    let decl: RegExpExecArray | null
    while ((decl = declPattern.exec(content)) !== null) {
      const name = decl[1]
      const parenOpenIdx = declPattern.lastIndex - 1 // index of the '(' the match just consumed
      let parenDepth = 0
      let i = parenOpenIdx
      for (; i < content.length; i += 1) {
        if (content[i] === '(') parenDepth += 1
        else if (content[i] === ')') {
          parenDepth -= 1
          if (parenDepth === 0) break
        }
      }
      if (parenDepth !== 0) continue // unbalanced parens locating this decl — skip, don't guess
      const braceStart = content.indexOf('{', i + 1)
      if (braceStart === -1) continue
      let braceDepth = 0
      let bodyEnd = -1
      for (let j = braceStart; j < content.length; j += 1) {
        if (content[j] === '{') braceDepth += 1
        else if (content[j] === '}') {
          braceDepth -= 1
          if (braceDepth === 0) {
            bodyEnd = j
            break
          }
        }
      }
      if (bodyEnd === -1) continue
      ranges.push({ name, bodyStart: braceStart, bodyEnd })
    }
    return ranges
  }

  /**
   * Attributes every refusal-call occurrence (matched by `REFUSAL_CALL_CODE_NAME_PATTERN` — see
   * its own comment for why the looser, spelling-tolerant pattern is used here rather than
   * `REFUSAL_CALL_PATTERN`) in `content` to its INNERMOST enclosing named function (the smallest
   * body range among every range that contains the call's index). A call inside NO named-function
   * range at all (e.g. a module-level arrow function body) is counted in `unattributedCount`,
   * never silently dropped — closing the exact fail-open hole a bare `continue` would reopen.
   */
  function attributeRefusalCallsV1(content: string): { counts: Record<string, number>; unattributedCount: number } {
    const ranges = findAllFunctionRanges(content)
    const counts: Record<string, number> = {}
    let unattributedCount = 0
    const re = new RegExp(REFUSAL_CALL_CODE_NAME_PATTERN.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const idx = m.index
      let innermost: FunctionRange | null = null
      for (const range of ranges) {
        if (idx < range.bodyStart || idx > range.bodyEnd) continue
        if (innermost === null || range.bodyEnd - range.bodyStart < innermost.bodyEnd - innermost.bodyStart) {
          innermost = range
        }
      }
      if (innermost === null) {
        unattributedCount += 1
      } else {
        counts[innermost.name] = (counts[innermost.name] ?? 0) + 1
      }
    }
    return { counts, unattributedCount }
  }

  function actualByKeyV1(counts: Record<string, number>): Record<AttendanceW4C2AuthoritativeEntrypointV1, number> {
    return Object.fromEntries(
      ATTENDANCE_W4C2_AUTHORITATIVE_ENTRYPOINTS_V1.map((key) => [key, counts[KEY_TO_FUNCTION_NAME[key]] ?? 0]),
    ) as Record<AttendanceW4C2AuthoritativeEntrypointV1, number>
  }

  function expectedByKeyV1(): Record<AttendanceW4C2AuthoritativeEntrypointV1, number> {
    return Object.fromEntries(
      ATTENDANCE_W4C2_AUTHORITATIVE_ENTRYPOINTS_V1.map((key) => [
        key,
        isAttendanceW4C2AuthoritativeEntrypointDeliveredV1(key) ? 0 : REFUSAL_SITE_WEIGHT[key],
      ]),
    ) as Record<AttendanceW4C2AuthoritativeEntrypointV1, number>
  }

  afterEach(() => {
    __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests(null)
  })

  it('the exact refusal-call pattern occurs in exactly one git-tracked src file: the boundary itself', () => {
    const files = listGitTrackedFiles(ROOT).filter((absolute) =>
      path.relative(ROOT, absolute).split(path.sep).join('/').startsWith('packages/core-backend/src/'),
    )
    const matches = files
      .filter((absolute) => countRefusalCalls(fs.readFileSync(absolute, 'utf8')) > 0)
      .map((absolute) => path.relative(ROOT, absolute).split(path.sep).join('/'))
    expect(matches).toEqual([BOUNDARY_RELATIVE_FILE])
  })

  it('attribution machinery negative control: every refusal call is either attributed or counted unattributed — none silently dropped', () => {
    const content = fs.readFileSync(path.join(ROOT, BOUNDARY_RELATIVE_FILE), 'utf8')
    const { counts, unattributedCount } = attributeRefusalCallsV1(content)
    const attributedTotal = Object.values(counts).reduce((sum, n) => sum + n, 0)
    // Compared against REFUSAL_CALL_CODE_NAME_PATTERN's own total (the pattern the attribution
    // loop actually iterates over), not REFUSAL_CALL_PATTERN's — the two patterns are no longer
    // the same regex (gate-2 fix), and this conservation check needs to prove nothing the
    // ATTRIBUTION LOOP saw was dropped, not compare against an unrelated stricter count.
    expect(attributedTotal + unattributedCount).toBe(countRefusalCallCodeNameOccurrences(content))
  })

  it('P2 negative control (gate-2 round, CHANGES-REQUESTED): a refusal call inside a top-level arrow function — no enclosing named `function` at all — is bucketed as unattributed, not silently dropped', () => {
    // Synthetic source, not the real boundary file: a named function (so `ranges` is non-empty,
    // proving the "innermost enclosing range" search correctly finds nothing enclosing here
    // rather than matching by accident), followed by a refusal call sitting inside a top-level
    // `const ... = () => { ... }` — the one shape the Gate D docblock identifies as landing in
    // `unattributedCount`, since `findAllFunctionRanges` only recognizes NAMED `function`
    // declarations, never arrow functions.
    //
    // The code name is assembled from two separate string literals at runtime, never spelled as
    // one contiguous quoted token in THIS file's own source text — the same self-match hazard
    // `REFUSAL_CALL_PATTERN`'s own comment names: writing the full quoted name literally here
    // would make this file itself turn up in the "exactly one file" scan below.
    const codeName = ['W4C2', 'AUTHORITATIVE_MODE_NOT_DELIVERED'].join('_')
    const synthetic = [
      'function executeLivePunch(x) { return x }',
      '',
      'const topLevelArrowRefusal = () => {',
      `  boundaryFail(${JSON.stringify(codeName)}, 503)`,
      '}',
    ].join('\n')
    const { counts, unattributedCount } = attributeRefusalCallsV1(synthetic)
    expect(counts).toEqual({})
    expect(unattributedCount).toBe(1)
  })

  // Narrowed title (gate-2 round): "fails closed" holds for the spellings
  // REFUSAL_CALL_CODE_NAME_PATTERN actually matches (single- or double-quoted code name, any
  // status code, code hoisted into a const) — not every conceivable spelling. See the Gate D
  // docblock's "Disclosed scope" list above for what still evades this (backtick-quoted or
  // split/concatenated spellings, and any non-canonical spelling added to a DIFFERENT file).
  it('P3: no refusal call is attributed to a function outside the declared entrypoint mapping, and none is unattributed (an unmapped/4th dispatch site in THIS file, single/double-quoted/any-status/const-hoisted, fails closed)', () => {
    const content = fs.readFileSync(path.join(ROOT, BOUNDARY_RELATIVE_FILE), 'utf8')
    const { counts, unattributedCount } = attributeRefusalCallsV1(content)
    const knownFunctionNames = new Set(Object.values(KEY_TO_FUNCTION_NAME))
    const unrepresented = Object.keys(counts).filter((name) => !knownFunctionNames.has(name))
    expect(unrepresented).toEqual([])
    expect(unattributedCount).toBe(0)
  })

  it('P2: declared-undelivered weight equals the ACTUAL per-key call count in the boundary file, key by key (not an aggregate — a single-key mismatch reds this even when the total is unchanged)', () => {
    const content = fs.readFileSync(path.join(ROOT, BOUNDARY_RELATIVE_FILE), 'utf8')
    const { counts } = attributeRefusalCallsV1(content)
    expect(actualByKeyV1(counts)).toEqual(expectedByKeyV1())
  })

  it('positive control (post Gate D2): live_punch is DELIVERED with zero refusal sites, scheduled is undelivered with exactly 2 (total=2)', () => {
    expect(isAttendanceW4C2AuthoritativeEntrypointDeliveredV1('live_punch')).toBe(true)
    expect(isAttendanceW4C2AuthoritativeEntrypointDeliveredV1('scheduled')).toBe(false)
    const content = fs.readFileSync(path.join(ROOT, BOUNDARY_RELATIVE_FILE), 'utf8')
    const { counts } = attributeRefusalCallsV1(content)
    // `executeLivePunch` no longer appears as a key at all — its writer branch contains no
    // refusal call, and the attribution map only records functions that carry at least one.
    expect(counts).toEqual({ executeScheduledRunInternal: 2 })
    expect(countRefusalCalls(content)).toBe(2)
  })

  it('drift guard is load-bearing (delivered-flip class): declaring "scheduled" delivered via the test seam while the boundary source is unchanged mismatches on that key specifically', () => {
    // Retargeted from `live_punch` to `scheduled` by Gate D2 (#4844): this leg needs a key that
    // is STILL undelivered in the shipped declaration AND still carries refusal sites in the
    // source, so that overriding it to `true` produces the expected-0/actual-nonzero mismatch.
    // `live_punch` can no longer serve — after D2 both its expected and actual counts are 0, so
    // the override would be a no-op and the leg would assert nothing.
    __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests({ scheduled: true })
    const content = fs.readFileSync(path.join(ROOT, BOUNDARY_RELATIVE_FILE), 'utf8')
    const { counts } = attributeRefusalCallsV1(content)
    const actual = actualByKeyV1(counts)
    const expected = expectedByKeyV1()
    // scheduled declared delivered => expected drops to 0 for that key, but the boundary source
    // still carries its 2 refusal calls — mismatched on THAT key specifically, demonstrated here
    // directly rather than only asserted by the correspondence test above.
    expect(expected.scheduled).toBe(0)
    expect(actual.scheduled).toBe(2)
    expect(actual).not.toEqual(expected)
  })

  it('P2 fix is load-bearing (cross-key class — the aggregate blind spot the old guard missed): a hand-maintained-weight swap across the two keys preserves the SUM but reds a per-key comparison', () => {
    const content = fs.readFileSync(path.join(ROOT, BOUNDARY_RELATIVE_FILE), 'utf8')
    const { counts } = attributeRefusalCallsV1(content)
    const actual = actualByKeyV1(counts)
    // A mutation of REFUSAL_SITE_WEIGHT that swaps the two keys' weights preserves the aggregate
    // SUM the pre-fix, aggregate-only assertion checked — that old guard would have stayed green
    // on exactly this edit, because add-to-one/remove-from-another leaves the total unchanged.
    // Still discriminating after Gate D2 (#4844) moved the weights to {live_punch:0,scheduled:2}:
    // the swap yields {live_punch:2,scheduled:0}, same sum (2), opposite per-key values.
    const swapped: Record<AttendanceW4C2AuthoritativeEntrypointV1, number> = {
      live_punch: REFUSAL_SITE_WEIGHT.scheduled,
      scheduled: REFUSAL_SITE_WEIGHT.live_punch,
    }
    const realAggregate = actual.live_punch + actual.scheduled
    const swappedAggregate = swapped.live_punch + swapped.scheduled
    expect(realAggregate).toBe(swappedAggregate) // the old aggregate-only check would stay green on this mutation
    expect(actual).not.toEqual(swapped) // the new per-key check reds on the exact same mutation
  })
})
