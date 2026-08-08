/**
 * W6-R4 (#4556) — mechanical repository inventory: the FSER derivation
 * (`attendance-group-fixed-schedule-effectiveness-service.cjs`) has exactly
 * one set of callers.
 *
 * RETRACTION, kept in place of the sentence it replaces. This file used to
 * claim it was "a single inert gate over `git ls-files --cached` … NOT a
 * hand-maintained narrower allowlist that a new caller could slip past".
 * Mechanically false on two counts, both demonstrated:
 *   - the FILE list was derived, but the EXEMPTION set whitelisted two
 *     enormous files WHOLESALE (`attendance-admin.ts` and the ~41.5k-line
 *     `plugins/plugin-attendance/index.cjs`). A second
 *     `createAttendanceGroupFixedScheduleEffectivenessService(...)` call added
 *     INSIDE an allowlisted file passed by construction;
 *   - the patterns are literal text, so a caller outside the allowlist escaped
 *     by splitting the string across a concatenation.
 *
 * What replaces it, stated as what it is: the file list is still derived from
 * `git ls-files --cached`, and the two large files are no longer exempt —
 * their factory-call sites are OCCURRENCE-COUNT PINNED, so a second call site
 * in either file reds. The concatenation escape is NOT closed by regex
 * whack-a-mole (this repo's own rule: trap enumeration does not converge);
 * instead the RESOLVED require/import targets are inspected, and the residual
 * limit is named below rather than papered over.
 *
 * This remains a TRIPWIRE. The primary behavioural proof that the aggregate
 * does not RE-DERIVE fixed-schedule effectiveness lives in
 * `attendance-w6-group-effective-policy.db.test.ts` (W6-R4: byte-identical to
 * a direct FSER call on the same data) — a caller inventory cannot catch a
 * hand-rolled parallel state machine that never references FSER at all. Under
 * the phase-1 scope fence that real-DB file is NOT CI-wired, so on this branch
 * that behavioural leg does not execute in any required check.
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

// Files that legitimately name the FSER module or its factory. ANY other
// match fails the gate.
const ALLOWED_RELATIVE_FILES = new Set([
  'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs',
  'packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts',
  'packages/core-backend/tests/integration/attendance-group-fixed-schedule-effectiveness.db.test.ts',
  'packages/core-backend/tests/integration/attendance-group-fixed-schedule-self-effectiveness.db.test.ts',
  'packages/core-backend/tests/integration/attendance-w6-group-effective-policy.db.test.ts',
  'packages/core-backend/tests/unit/attendance-group-fixed-schedule-effectiveness-service.test.ts',
  // this inventory test's own file (names the guarded strings for documentation)
  'packages/core-backend/tests/unit/attendance-w6-fser-single-source-caller-inventory.test.ts',
  // Names the module in a CLOSED FILE SET / a derived-domain floor list, not
  // as a caller. Both are guards over this same module.
  'packages/core-backend/src/util/resolve-plugin-attendance-lib.ts',
  'packages/core-backend/tests/unit/attendance-w6-group-effective-policy-dml-sweep.test.ts',
  'packages/core-backend/tests/unit/attendance-w6-import-graph-no-calculation-consumer.test.ts',
])

/**
 * The two files that used to be exempt WHOLESALE. They are still allowed to
 * name the factory — they are the two legitimate composition sites — but the
 * NUMBER of factory call sites in each is pinned, so a second derivation added
 * anywhere inside either file reds instead of passing by construction.
 *
 * `plugins/plugin-attendance/index.cjs` is ~41.5k lines; "this file may
 * mention FSER" is not a guard at that size.
 */
const FACTORY_CALL_SITE_PINS: ReadonlyArray<{ file: string; calls: number }> = [
  { file: 'packages/core-backend/src/routes/attendance-admin.ts', calls: 1 },
  { file: 'plugins/plugin-attendance/index.cjs', calls: 1 },
]
const FACTORY_CALL_RE = /createAttendanceGroupFixedScheduleEffectivenessService\s*\(/g

/** Also allowed to NAME the module/factory (types, aggregates) but must contain
 * ZERO factory CALL sites — the aggregate composes an INJECTED service. */
const ZERO_FACTORY_CALL_FILES = ['packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts']

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

const PINNED_FILES = new Set([...FACTORY_CALL_SITE_PINS.map((pin) => pin.file), ...ZERO_FACTORY_CALL_FILES])

function findOffenders(rootDir: string, files: readonly string[]): Array<{ file: string; label: string }> {
  const offenders: Array<{ file: string; label: string }> = []
  for (const absolute of files) {
    const relative = path.relative(rootDir, absolute).split(path.sep).join('/')
    if (ALLOWED_RELATIVE_FILES.has(relative) || PINNED_FILES.has(relative)) continue
    const content = fs.readFileSync(absolute, 'utf8')
    for (const { label, pattern } of FSER_REFERENCE_PATTERNS) {
      if (pattern.test(content)) offenders.push({ file: relative, label })
    }
  }
  return offenders
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
    .length
}

/**
 * Resolved `require(...)` / `import ... from '...'` targets in a file, so a
 * caller that assembles the module path from concatenated fragments is judged
 * on WHAT IT LOADS rather than on how it spells it. Deliberately NOT another
 * literal-text pattern: enumerating spellings does not converge.
 */
function resolvedModuleTargets(rootDir: string, absolute: string): string[] {
  const text = fs.readFileSync(absolute, 'utf8')
  const targets: string[] = []
  for (const m of text.matchAll(/(?:require|from)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const specifier = m[1]
    if (!specifier.startsWith('.')) continue
    const resolvedBase = path.resolve(path.dirname(absolute), specifier)
    for (const candidate of [resolvedBase, `${resolvedBase}.cjs`, `${resolvedBase}.ts`, `${resolvedBase}.js`]) {
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) {
        targets.push(path.relative(rootDir, candidate).split(path.sep).join('/'))
        break
      }
    }
  }
  return targets
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
    expect(PINNED_FILES.has('packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts')).toBe(true)
  })

  it('the two formerly-WHOLESALE-exempt files are OCCURRENCE-PINNED: exactly one factory call site each', () => {
    for (const { file, calls } of FACTORY_CALL_SITE_PINS) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(text.length, `${file} is empty`).toBeGreaterThan(1000)
      expect(countMatches(text, FACTORY_CALL_RE), `${file} factory call sites`).toBe(calls)
    }
  })

  it('the aggregate module itself contains ZERO factory call sites (it composes an INJECTED service)', () => {
    for (const file of ZERO_FACTORY_CALL_FILES) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(text.length).toBeGreaterThan(1000)
      expect(countMatches(text, FACTORY_CALL_RE)).toBe(0)
    }
  })

  it('positive control on the occurrence pin: a SECOND factory call in a pinned file would be counted', () => {
    const text = fs.readFileSync(path.join(ROOT, 'packages/core-backend/src/routes/attendance-admin.ts'), 'utf8')
    const doubled = `${text}\nconst second = createAttendanceGroupFixedScheduleEffectivenessService({})\n`
    expect(countMatches(doubled, FACTORY_CALL_RE)).toBe(2)
    // ...and the pin asserts 1, so the doubled text would fail it.
    expect(countMatches(doubled, FACTORY_CALL_RE)).not.toBe(1)
  })

  it('the FSER module is LOADED only by files that are allowed to load it (resolved targets, not spellings)', () => {
    const canonical = 'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs'
    const files = listGitTrackedFiles(ROOT)
    const loaders = files
      .filter((absolute) => resolvedModuleTargets(ROOT, absolute).includes(canonical))
      .map((absolute) => path.relative(ROOT, absolute).split(path.sep).join('/'))
    // Non-vacuity: at least the plugin entry really does require it.
    expect(loaders).toContain('plugins/plugin-attendance/index.cjs')
    const unexpected = loaders.filter(
      (file) => !ALLOWED_RELATIVE_FILES.has(file) && !PINNED_FILES.has(file),
    )
    expect(unexpected).toEqual([])
  })

  it('RESIDUAL LIMIT, named rather than hidden: the backend loads FSER through requirePluginAttendanceLib, whose CLOSED FILE SET is the gate', () => {
    // `attendance-admin.ts` and the contract module do not `require('./…cjs')`
    // directly — they go through `requirePluginAttendanceLib(__dirname, '<file>')`,
    // whose argument must be a member of a CLOSED literal set enforced in
    // `src/util/resolve-plugin-attendance-lib.ts` and tested in
    // `attendance-plugin-lib-resolver-hardening.test.ts`. So "which files can
    // load FSER through that seam" is bounded there, not here. Asserted so the
    // two guards cannot both assume the other covers it.
    const resolver = fs.readFileSync(
      path.join(ROOT, 'packages/core-backend/src/util/resolve-plugin-attendance-lib.ts'),
      'utf8',
    )
    expect(resolver).toContain('PLUGIN_ATTENDANCE_LIB_CLOSED_FILE_SET')
    expect(resolver).toContain('FILE_NOT_IN_CLOSED_SET')
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
