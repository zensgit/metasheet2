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
 * #4814 P3-3: the original prefix list excluded `plugins/plugin-attendance/
 * index.cjs` (the 41.5k-line file that owns most attendance calculation
 * writes -- exactly where this line's runtime has historically been wired)
 * and `packages/core-backend/src/services/`. A W7 consumer wired in either
 * place would have escaped this gate entirely. Both are now in scope.
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
// attendance_calculation_rollout_state), the canonical shift/segment
// calculation service, the plugin's main entry file (the historical home
// of most attendance calculation wiring), and every core-backend service
// module (where a W7 consumer could equally be wired). W6-1's own files
// are intentionally NOT in this list (they are the thing being scanned
// FOR, not scanned).
const CALCULATION_PATH_PREFIXES = [
  'packages/core-backend/src/attendance/',
  'packages/core-backend/src/services/',
  'plugins/plugin-attendance/lib/attendance-shift-service.cjs',
  'plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs',
  'plugins/plugin-attendance/lib/attendance-work-date-adapters.cjs',
  'plugins/plugin-attendance/index.cjs',
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

/** Same idiom as `attendance-w6-fser-single-source-caller-inventory.test.ts`'s
 * `findOffenders`: runs the REAL classifier + REAL marker scan against an
 * explicit file list, so a positive control can exercise this exact
 * function (not a re-typed copy of its predicates) against a file that was
 * never `git add`ed. */
function findOffenders(rootDir: string, absoluteFiles: readonly string[]): Array<{ file: string; marker: string }> {
  const offenders: Array<{ file: string; marker: string }> = []
  for (const absolute of absoluteFiles) {
    const relative = path.relative(rootDir, absolute).split(path.sep).join('/')
    if (!isCalculationPathFile(relative)) continue
    const content = fs.readFileSync(absolute, 'utf8')
    for (const marker of W6_MODULE_MARKERS) {
      if (content.includes(marker)) offenders.push({ file: relative, marker })
    }
  }
  return offenders
}

describe('W6-R5 repository inventory: no calculation-path file imports the W6 aggregate', () => {
  it('zero calculation-write-path files reference either W6-1 module', () => {
    const relativeFiles = listGitTrackedFiles(ROOT)
    expect(relativeFiles.length).toBeGreaterThan(100)

    const calculationFiles = relativeFiles.filter(isCalculationPathFile)
    expect(calculationFiles.length).toBeGreaterThan(5) // sanity: the calculation path itself is non-trivially sized

    const offenders = findOffenders(
      ROOT,
      calculationFiles.map((relative) => path.join(ROOT, relative)),
    )
    expect(offenders).toEqual([])
  })

  it('#4814 P3-3: the widened prefixes are actually in scope (index.cjs and src/services/, not just src/attendance/)', () => {
    expect(isCalculationPathFile('plugins/plugin-attendance/index.cjs')).toBe(true)
    expect(isCalculationPathFile('packages/core-backend/src/services/AnyCalculationConsumer.ts')).toBe(true)
    // sanity: an out-of-scope file (this test's own directory tree, outside
    // the prefixes above) is NOT swept -- proves the classifier is not
    // vacuously true.
    expect(isCalculationPathFile('packages/core-backend/tests/unit/some-unrelated-file.ts')).toBe(false)
  })

  it('positive control: a decoy under the NEW src/services/ prefix that imports W6 is caught', () => {
    const scratchPath = path.join(ROOT, 'packages/core-backend/src/services/zz-w6r5-decoy-services-scratch.ts')
    fs.writeFileSync(scratchPath, "import { createAttendanceGroupEffectivePolicyAggregateService } from '../attendance/w6-group-effective-policy-aggregate'\n")
    try {
      const relative = 'packages/core-backend/src/services/zz-w6r5-decoy-services-scratch.ts'
      const files = listGitTrackedFiles(ROOT) // untracked scratch file — proves the git-tracked-only scope too
      expect(files.includes(relative)).toBe(false)
      // Directly exercise findOffenders (the REAL detector, not a re-typed
      // predicate copy) against the untracked file.
      const offenders = findOffenders(ROOT, [scratchPath])
      expect(offenders).toEqual([{ file: relative, marker: 'w6-group-effective-policy-aggregate' }])
    } finally {
      fs.unlinkSync(scratchPath)
    }
  })

  it('positive control: a decoy under the (pre-existing) src/attendance/ prefix that imports W6 is caught', () => {
    const scratchPath = path.join(ROOT, 'packages/core-backend/src/attendance/zz-w6r5-decoy-scratch.ts')
    fs.writeFileSync(scratchPath, "import { createAttendanceGroupEffectivePolicyAggregateService } from './w6-group-effective-policy-aggregate'\n")
    try {
      const relative = 'packages/core-backend/src/attendance/zz-w6r5-decoy-scratch.ts'
      const files = listGitTrackedFiles(ROOT)
      expect(files.includes(relative)).toBe(false)
      const offenders = findOffenders(ROOT, [scratchPath])
      expect(offenders).toEqual([{ file: relative, marker: 'w6-group-effective-policy-aggregate' }])
    } finally {
      fs.unlinkSync(scratchPath)
    }
  })

  // `plugins/plugin-attendance/index.cjs` is matched by an EXACT-path rule
  // (single real 41.5k-line production file, not a directory prefix) — a
  // decoy cannot safely fabricate content there the way the two directory-
  // prefix decoys above do. Its coverage is therefore split into two
  // independently-proven halves: (1) the "in scope" assertion above proves
  // `isCalculationPathFile` classifies this EXACT path as a calculation-
  // path file: (2) the two decoys above prove `findOffenders`'s
  // marker-scan fires for any file `isCalculationPathFile` accepts. A file
  // that is in scope, scanned by a scanner proven to fire on in-scope
  // matches, is covered without touching the real file's content.
})
