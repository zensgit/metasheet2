/**
 * W6-R5 (#4556) — no calculation writer consumes the W6 aggregate. The
 * aggregate is a read layer; winner selection, policy precedence, and any
 * calculation-chain consumption of group policy remain W7 (design lock §0,
 * §2.3; parent lock §9.8).
 *
 * Mechanical proof: a repository-wide, git-tracked-only scan (same idiom as
 * `w4c3a-rollout-control-inventory.test.ts` /
 * `attendance-w6-fser-single-source-caller-inventory.test.ts`) asserts that
 * NOTHING under the known calculation-write-path source trees imports or
 * requires either W6-1 module. Today that is trivially true (the modules
 * are new); this test exists to catch a FUTURE regression, not to prove
 * anything about the present.
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

// The calculation write-path source trees: W4/W4C durable-storage,
// rollout-control, scheduled-run, and record-effects modules (the ONLY
// places that write attendance_records/attendance_record_calculations/
// attendance_calculation_rollout_state), plus the canonical shift/segment
// calculation service. W6-1's own files are intentionally NOT in this list
// (they are the thing being scanned FOR, not scanned).
const CALCULATION_PATH_PREFIXES = [
  'packages/core-backend/src/attendance/',
  'plugins/plugin-attendance/lib/attendance-shift-service.cjs',
  'plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs',
  'plugins/plugin-attendance/lib/attendance-work-date-adapters.cjs',
]

const W6_MODULE_MARKERS = ['w6-group-effective-policy-aggregate', 'w6-group-effective-policy-response-contract']

function listGitTrackedFiles(rootDir: string): string[] {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: rootDir, maxBuffer: 64 * 1024 * 1024 })
  return raw
    .toString('utf8')
    .split('\0')
    .filter((relative) => relative.length > 0)
    .filter((relative) => TARGET_EXTENSIONS.has(path.extname(relative)))
    .filter((relative) => !relative.split('/').some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment)))
}

function isCalculationPathFile(relative: string): boolean {
  if (relative.includes('__tests__') || relative.includes('/tests/')) return false // tests are allowed to reference W6 as a test subject
  // W6-1's OWN two files live in the same directory as the calculation-path
  // modules; they are the thing being scanned FOR (they naturally
  // cross-reference each other's names in doc comments and imports), not a
  // calculation-path consumer of themselves.
  if (relative.endsWith('/w6-group-effective-policy-aggregate.ts') || relative.endsWith('/w6-group-effective-policy-response-contract.ts')) {
    return false
  }
  return CALCULATION_PATH_PREFIXES.some((prefix) =>
    prefix.endsWith('.cjs') ? relative === prefix : relative.startsWith(prefix),
  )
}

describe('W6-R5 repository inventory: no calculation-path file imports the W6 aggregate', () => {
  it('zero calculation-write-path files reference either W6-1 module', () => {
    const relativeFiles = listGitTrackedFiles(ROOT)
    expect(relativeFiles.length).toBeGreaterThan(100)

    const calculationFiles = relativeFiles.filter(isCalculationPathFile)
    expect(calculationFiles.length).toBeGreaterThan(5) // sanity: the calculation path itself is non-trivially sized

    const offenders: Array<{ file: string; marker: string }> = []
    for (const relative of calculationFiles) {
      const content = fs.readFileSync(path.join(ROOT, relative), 'utf8')
      for (const marker of W6_MODULE_MARKERS) {
        if (content.includes(marker)) offenders.push({ file: relative, marker })
      }
    }
    expect(offenders).toEqual([])
  })

  it('positive control: the detector DOES catch a decoy calculation-path file that imports W6', () => {
    const scratchPath = path.join(ROOT, 'packages/core-backend/src/attendance/zz-w6r5-decoy-scratch.ts')
    fs.writeFileSync(scratchPath, "import { createAttendanceGroupEffectivePolicyAggregateService } from './w6-group-effective-policy-aggregate'\n")
    try {
      const relative = 'packages/core-backend/src/attendance/zz-w6r5-decoy-scratch.ts'
      expect(isCalculationPathFile(relative)).toBe(true)
      const content = fs.readFileSync(scratchPath, 'utf8')
      expect(W6_MODULE_MARKERS.some((marker) => content.includes(marker))).toBe(true)
    } finally {
      fs.unlinkSync(scratchPath)
    }
  })
})
