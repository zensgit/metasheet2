/**
 * W6-R4 (#4556) — mechanical repository inventory: the FSER derivation
 * (`attendance-group-fixed-schedule-effectiveness-service.cjs`) has exactly
 * one set of callers. Same idiom as
 * `packages/core-backend/src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts`
 * — a single inert gate over `git ls-files --cached` (tracked files only),
 * not a hand-maintained narrower allowlist that a new caller could slip
 * past.
 *
 * This is the CHEAP, literal-text tripwire the design lock's §7.2 wording
 * asks for ("a mechanical inventory pins every caller"). The primary,
 * behavioral proof that the aggregate does not RE-DERIVE fixed-schedule
 * effectiveness lives in
 * `attendance-w6-group-effective-policy.db.test.ts` (W6-R4: byte-identical
 * to a direct FSER call on the same data) — a caller-inventory alone cannot
 * catch a hand-rolled parallel state machine that never references FSER at
 * all; the identity/fidelity real-DB proof does.
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../')

const EXCLUDED_DIR_SEGMENTS = new Set(['node_modules', 'dist', 'build', '.git', '.turbo', 'coverage', '.claude'])
const TARGET_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs'])

// Every file that legitimately names the FSER module or its factory —
// the canonical definition itself, W6-1's own composing module + contract
// doc-comment + route wiring, existing FSER-owning tests, and W6-1's own
// tests. ANY other match fails the gate.
const ALLOWED_RELATIVE_FILES = new Set([
  'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs',
  'plugins/plugin-attendance/index.cjs',
  'packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts',
  'packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts',
  'packages/core-backend/src/routes/attendance-admin.ts',
  'packages/core-backend/tests/integration/attendance-group-fixed-schedule-effectiveness.db.test.ts',
  'packages/core-backend/tests/integration/attendance-group-fixed-schedule-self-effectiveness.db.test.ts',
  'packages/core-backend/tests/integration/attendance-w6-group-effective-policy.db.test.ts',
  'packages/core-backend/tests/unit/attendance-group-fixed-schedule-effectiveness-service.test.ts',
  // this inventory test's own file (names the guarded strings for documentation)
  'packages/core-backend/tests/unit/attendance-w6-fser-single-source-caller-inventory.test.ts',
])

const FSER_REFERENCE_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: 'module path reference', pattern: /attendance-group-fixed-schedule-effectiveness-service\.cjs/ },
  { label: 'factory call', pattern: /createAttendanceGroupFixedScheduleEffectivenessService/ },
  { label: 'derivation function', pattern: /deriveAttendanceGroupFixedScheduleEffectiveness/ },
]

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

function findOffenders(rootDir: string, files: readonly string[]): Array<{ file: string; label: string }> {
  const offenders: Array<{ file: string; label: string }> = []
  for (const absolute of files) {
    const relative = path.relative(rootDir, absolute).split(path.sep).join('/')
    if (ALLOWED_RELATIVE_FILES.has(relative)) continue
    const content = fs.readFileSync(absolute, 'utf8')
    for (const { label, pattern } of FSER_REFERENCE_PATTERNS) {
      if (pattern.test(content)) offenders.push({ file: relative, label })
    }
  }
  return offenders
}

describe('W6-R4 repository inventory: the FSER derivation has exactly one caller set', () => {
  it('finds FSER references only in the allowlisted definition/composition/test files', () => {
    const files = listGitTrackedFiles(ROOT)
    expect(files.length).toBeGreaterThan(100) // sanity: git ls-files actually found the repo

    const offenders = findOffenders(ROOT, files)
    expect(offenders).toEqual([])
  })

  it('the allowlist itself is non-empty and includes the canonical definition (guards against a vacuously-passing empty scan)', () => {
    expect(ALLOWED_RELATIVE_FILES.has('plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs')).toBe(true)
    expect(ALLOWED_RELATIVE_FILES.has('packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts')).toBe(true)
  })

  it('a decoy file referencing the FSER factory OUTSIDE the allowlist is caught (positive control on the detector itself)', () => {
    const scratchPath = path.join(ROOT, 'packages/core-backend/src/attendance/zz-w6r4-decoy-scratch.ts')
    fs.writeFileSync(scratchPath, "export const decoy = 'createAttendanceGroupFixedScheduleEffectivenessService'\n")
    try {
      const files = listGitTrackedFiles(ROOT) // untracked scratch file — proves the git-tracked-only scope too
      expect(files.some((f) => f.endsWith('zz-w6r4-decoy-scratch.ts'))).toBe(false)
      // Directly exercise the detector against the untracked file to prove the PATTERN itself
      // would catch it if it were ever committed outside the allowlist.
      const offenders = findOffenders(ROOT, [scratchPath])
      expect(offenders).toEqual([{ file: 'packages/core-backend/src/attendance/zz-w6r4-decoy-scratch.ts', label: 'factory call' }])
    } finally {
      fs.unlinkSync(scratchPath)
    }
  })
})
