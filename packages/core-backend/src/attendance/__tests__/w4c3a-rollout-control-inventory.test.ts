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
import fs from 'node:fs'
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

const TARGET_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs'])

const ROLLOUT_DML_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: 'UPDATE attendance_calculation_rollout_state', pattern: /UPDATE\s+attendance_calculation_rollout_state/i },
  { label: 'INSERT INTO attendance_calculation_rollout_state', pattern: /INSERT\s+INTO\s+attendance_calculation_rollout_state/i },
  { label: 'INSERT INTO attendance_calculation_rollout_events', pattern: /INSERT\s+INTO\s+attendance_calculation_rollout_events/i },
]

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

describe('W4C-5 repository inventory: rollout-state/event DML has exactly one writer', () => {
  it('finds rollout-state/event DML only in the hardened boundary, its migration, and integration fixtures', () => {
    const files: string[] = []
    walk(ROOT, files)
    expect(files.length).toBeGreaterThan(100) // sanity: the walk actually found the repo

    const offenders: Array<{ file: string; label: string }> = []
    for (const absolute of files) {
      const relative = path.relative(ROOT, absolute).split(path.sep).join('/')
      if (ALLOWED_RELATIVE_FILES.has(relative)) continue
      if (ALLOWED_DIRECTORY_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue
      const content = fs.readFileSync(absolute, 'utf8')
      for (const { label, pattern } of ROLLOUT_DML_PATTERNS) {
        if (pattern.test(content)) offenders.push({ file: relative, label })
      }
    }
    expect(offenders).toEqual([])
  })

  it('positive control: the pattern set actually matches the hardened boundary file itself', () => {
    const target = path.join(ROOT, 'packages/core-backend/src/attendance/w4c3a-rollout-control.ts')
    const content = fs.readFileSync(target, 'utf8')
    const matched = ROLLOUT_DML_PATTERNS.filter(({ pattern }) => pattern.test(content))
    expect(matched.length).toBeGreaterThan(0)
  })
})
