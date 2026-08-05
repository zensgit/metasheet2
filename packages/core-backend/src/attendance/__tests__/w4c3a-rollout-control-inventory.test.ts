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
import { describe, expect, it } from 'vitest'

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
