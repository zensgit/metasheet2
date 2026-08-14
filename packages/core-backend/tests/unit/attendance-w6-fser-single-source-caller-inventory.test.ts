/**
 * W6-R4 (#4556) — mechanical repository inventory: the FSER derivation
 * (`attendance-group-fixed-schedule-effectiveness-service.cjs`) has exactly
 * one set of callers.
 *
 * The file list is derived from `git ls-files --cached`, not hand-maintained.
 * The two large call sites (`attendance-admin.ts` and
 * `plugins/plugin-attendance/index.cjs`) are occurrence-count pinned rather
 * than wholesale-exempt, so a second factory call added anywhere inside
 * either file reds instead of passing by construction. A literal-text pattern
 * cannot catch a caller that assembles the module path from concatenated
 * fragments, so this suite additionally inspects resolved `require`/`import`
 * targets rather than only pattern-matching spellings; the one residual gap
 * that leaves — the closed-file-set seam in
 * `resolve-plugin-attendance-lib.ts` — is named and asserted below rather
 * than silently assumed covered.
 *
 * This is a tripwire, not the primary proof. The behavioural proof that the
 * aggregate does not re-derive fixed-schedule effectiveness lives in
 * `attendance-w6-group-effective-policy.db.test.ts` (byte-identical to a
 * direct FSER call on the same data) — a caller inventory cannot catch a
 * hand-rolled parallel state machine that never references FSER at all.
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
  'packages/core-backend/tests/integration/attendance-group-fixed-schedule-effectiveness.db.test.ts',
  'packages/core-backend/tests/integration/attendance-group-fixed-schedule-self-effectiveness.db.test.ts',
  'packages/core-backend/tests/integration/attendance-w6-group-effective-policy.db.test.ts',
  'packages/core-backend/tests/integration/attendance-w6-group-effective-policy-fixture-matrix.db.test.ts',
  'packages/core-backend/tests/unit/attendance-group-fixed-schedule-effectiveness-service.test.ts',
  // W7-1a (#4556): the group-effective facts resolver's real-PG gate. It loads
  // the FSER module to INJECT the exported PURE derivation
  // (`deriveAttendanceGroupFixedScheduleEffectiveness`) into the resolver, in
  // the same shape `w6-group-effective-policy-aggregate.ts` takes `deps.fser`.
  // Injecting the real predicate rather than stubbing it is the point: a stub
  // would make every `state === 'effective'` leg a test of the stub. The
  // resolver under test defines NO second effectiveness predicate — which is
  // what W6-R4 guards — and makes zero factory calls.
  'packages/core-backend/tests/integration/attendance-w7-1a-resolver.db.test.ts',
  // this inventory test's own file (names the guarded strings for documentation)
  'packages/core-backend/tests/unit/attendance-w6-fser-single-source-caller-inventory.test.ts',
  // Names the module in a CLOSED FILE SET / a derived-domain floor list, not
  // as a caller. Both are guards over this same module.
  'packages/core-backend/tests/unit/attendance-w6-group-effective-policy-dml-sweep.test.ts',
  'packages/core-backend/tests/unit/attendance-w6-import-graph-no-calculation-consumer.test.ts',
  // W7-1a (#4556): the W6-R5 preservation guard's curated classification data.
  // It names the FSER module because that module is one of the 72 files under
  // the guard's pinned roots — a scan-domain entry, not a caller.
  'packages/core-backend/tests/unit/w7-w6r5-guard/classification.ts',
])

/**
 * The two legitimate composition sites. They are allowed to name the
 * factory, but the number of factory call sites in each is pinned, so a
 * second derivation added anywhere inside either file reds instead of
 * passing because the file as a whole is allowed to mention FSER.
 */
const FACTORY_CALL_SITE_PINS: ReadonlyArray<{ file: string; calls: number }> = [
  { file: 'packages/core-backend/src/routes/attendance-admin.ts', calls: 1 },
  { file: 'plugins/plugin-attendance/index.cjs', calls: 1 },
]
const FACTORY_CALL_RE = /createAttendanceGroupFixedScheduleEffectivenessService\s*\(/g

/** Also allowed to NAME the module/factory (types, aggregates) but must contain
 * ZERO factory CALL sites — the aggregate composes an INJECTED service. */
const ZERO_FACTORY_CALL_FILES = [
  'packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts',
  'packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts',
  'packages/core-backend/src/util/resolve-plugin-attendance-lib.ts',
  // W7-1a (#4556): the group-effective facts resolver NAMES the FSER module and
  // its derivation function in its header, to document that it composes the
  // EXPORTED PURE derivation as an INJECTED dependency (`deps.deriveFixed-
  // ScheduleEffectiveness`) rather than importing or re-implementing it — the
  // same arrangement as `w6-group-effective-policy-aggregate.ts` above. It
  // loads nothing from the FSER module and calls the factory zero times.
  //
  // What it DOES add, stated rather than implied: a second fact LOADER. FSER's
  // own `loadEffectivenessFacts` is a private closure and its public wrappers
  // read unlocked, so a resolver that must read under its own locks has to
  // reissue those SELECTs. That is a duplicated read, not a duplicated
  // PREDICATE — and the predicate is what W6-R4 makes singular.
  'packages/core-backend/src/attendance/w7-resolver/w7-group-effective-facts-resolver.ts',
]

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

  it('the two composition-site files are occurrence-pinned: exactly one factory call site each', () => {
    for (const { file, calls } of FACTORY_CALL_SITE_PINS) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(text.length, `${file} is empty`).toBeGreaterThan(1000)
      expect(countMatches(text, FACTORY_CALL_RE), `${file} factory call sites`).toBe(calls)
    }
  })

  it('every production file allowed to name FSER without composing it contains zero factory call sites', () => {
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

  it('the FSER module is loaded only by files that are allowed to load it (resolved targets, not spellings)', () => {
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

  it('the backend loads FSER through requirePluginAttendanceLib, whose closed file set is the gate for that seam', () => {
    // `attendance-admin.ts` and the contract module do not `require('./…cjs')`
    // directly — they go through `requirePluginAttendanceLib(__dirname, '<file>')`,
    // whose argument must be a member of a closed literal set enforced in
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
    // SCRATCH LOCATION IS LOAD-BEARING — do not move this back under
    // `src/attendance/`.
    //
    // This decoy must be a REAL file inside the repository, because half of
    // what it proves is that an UNTRACKED repo file is absent from the
    // git-tracked domain (`listGitTrackedFiles`) — an assertion a `mkdtemp`
    // path outside the repo would satisfy vacuously.
    //
    // But it previously lived at `src/attendance/zz-w6r4-decoy-scratch.ts`,
    // which is inside the W7-R10 preservation guard's pinned root 2
    // (`packages/core-backend/src/attendance/**`) and carries a scannable
    // `.ts` extension. That guard's Leg 0 asserts `unclaimed = 0` against the
    // REAL tree, so while this file existed — across a full `git ls-files`
    // spawn — a concurrently scheduled run of
    // `attendance-w7-w6r5-preservation-guard.test.ts` would see an
    // unclassified file and red. Both suites are `tests/unit/*.test.ts` in the
    // same vitest project under `pool: 'forks'`, so the interleaving is
    // scheduler-dependent: an independent gate reproduced the red
    // deterministically by planting the file, and could NOT reproduce it under
    // parallelism — i.e. a latent nondeterministic red, which is worse than a
    // reliable one.
    //
    // `tests/` is excluded by that guard's `isScannablePath` and is under no
    // pinned root, so this location keeps both properties: still a real,
    // untracked, in-repo file; no longer inside anybody's walked domain.
    // Vitest does not collect it either — its name does not match
    // `*.{test,spec}.*`.
    const scratchPath = path.join(ROOT, 'packages/core-backend/tests/unit/zz-w6r4-decoy-scratch.ts')
    fs.writeFileSync(scratchPath, "export const decoy = 'createAttendanceGroupFixedScheduleEffectivenessService'\n")
    try {
      const files = listGitTrackedFiles(ROOT) // untracked scratch file — proves the git-tracked-only scope too
      expect(files.some((f) => f.endsWith('zz-w6r4-decoy-scratch.ts'))).toBe(false)
      // Directly exercise the detector against the untracked file to prove the PATTERN itself
      // would catch it if it were ever committed outside the allowlist.
      const offenders = findOffenders(ROOT, [scratchPath])
      expect(offenders).toEqual([{ file: 'packages/core-backend/tests/unit/zz-w6r4-decoy-scratch.ts', label: 'factory call' }])
    } finally {
      fs.unlinkSync(scratchPath)
    }
  })
})
