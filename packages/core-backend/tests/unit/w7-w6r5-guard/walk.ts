/**
 * W7-1a (#4556) STEP 4 — the W6-R5 preservation guard's DOMAIN WALKER
 * (design-lock red line W7-R10).
 *
 * Ported from the P16 DML-inventory collector's DERIVED scan domain
 * (`scripts/attendance/w4c0-dml-inventory/collector.cjs`: `isScannablePath`
 * :53-68, `buildRawCensus` :807-825, and `listAllFiles` in the sibling
 * `sources.cjs:35-58`) — NOT from P16's exact-allowlist CLAIM side. Pinning a
 * derived domain rather than a hand-maintained file list is the whole point:
 * "a helper module outside the list walked straight through it" is the defect
 * the roots-not-files shape replaces.
 *
 * SELF-EXCLUSION (W7-R10 port fix 2), with a named reason: this guard's own
 * directory holds the curated classification file and the probe fixtures,
 * which contain the banned route literal and the banned module specifier as
 * MATCH-PREDICATE DATA, not as runtime consumption. Excluding it is currently
 * REDUNDANT TWICE OVER — none of the three pinned roots contains
 * `packages/core-backend/tests/`, and `/tests/` is an excluded segment anyway
 * — and it is kept so that adding a fourth root cannot silently turn the
 * guard's own data into a false positive against itself. Recorded as
 * belt-and-braces rather than claimed as load-bearing today.
 *
 * `__tests__` IS OUT, STATED EXPLICITLY (W7-R10 port fix 3). The P16-faithful
 * `isScannablePath` drops `/__tests__/`, `/tests/`, `/test/`, and any basename
 * containing `.test.`, `.spec.`, or `.d.ts`. So the 41 W7-0/W4C contract test
 * files under `packages/core-backend/src/attendance/__tests__/` are NOT in the
 * walked domain, and neither is anything under `tests/`. The consequence that
 * must be stated rather than discovered: a probe planted in a `__tests__`
 * directory is a DEAD GATE — it would look planted and prove nothing. The
 * positive control therefore plants under a pinned root OUTSIDE those
 * directories and mechanically asserts the probe's path entered the walked
 * domain BEFORE asserting any leg reds.
 */
import fs from 'node:fs'
import path from 'node:path'

import { ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1 } from '../../../src/attendance/w7-w6r5-guard-root-set'

// --- Ported verbatim in behaviour from collector.cjs:27-44 ------------------

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.js', '.cjs', '.mjs', '.sql', '.sh'])

const EXCLUDED_PATH_SEGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/coverage/',
  '/.turbo/',
  '/__tests__/',
  '/tests/',
  '/test/',
  '/__fixtures__/',
  // This guard's own tooling directory — see the SELF-EXCLUSION note in the
  // file header. Its classification data and probe fixtures contain the banned
  // route literal and the banned module specifier as data, not as consumption.
  // Doubly redundant today (it also sits under the already-excluded `/tests/`),
  // and named anyway so the redundancy is a recorded fact, not an accident.
  '/w7-w6r5-guard/',
]

const EXCLUDED_FILENAME_MARKERS = ['.test.', '.spec.', '.d.ts']

export function isScannablePath(relPath: string): boolean {
  const posixPath = relPath.split(path.sep).join('/')
  const withSlashes = `/${posixPath}/`
  for (const seg of EXCLUDED_PATH_SEGMENTS) {
    if (withSlashes.includes(seg)) return false
  }
  const base = posixPath.slice(posixPath.lastIndexOf('/') + 1)
  for (const marker of EXCLUDED_FILENAME_MARKERS) {
    if (base.includes(marker)) return false
  }
  const ext = path.extname(base)
  return SCANNABLE_EXTENSIONS.has(ext)
}

/** The recorded roots carry a `/**` glob suffix; `fs.readdirSync` does not
 *  accept one. Stripping it here rather than re-spelling the roots keeps the
 *  landed `ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1` record the single source. */
export function stripGlobSuffix(root: string): string {
  return root.replace(/\/\*\*$/, '').replace(/\/$/, '')
}

/** Ported from `sources.cjs:35-58`: recursive walk, pruning `node_modules` and
 *  `.git` during traversal, returning repo-relative paths WITH the root prefix. */
export function listAllFiles(repoRoot: string, rootDir: string): string[] {
  const out: string[] = []
  function walk(dirAbs: string, dirRel: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childAbs = path.join(dirAbs, entry.name)
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(childAbs, childRel)
      } else if (entry.isFile()) {
        out.push(childRel)
      }
    }
  }
  walk(path.join(repoRoot, rootDir), rootDir)
  return out
}

export interface AttendanceW7GuardDomainV1 {
  /**
   * PRE-DEDUPE per-root scannable file counts (W7-R10 port fix 1 — the nesting
   * trap). Root 3 (`.../attendance/w7-resolver/**`) is NESTED inside root 2
   * (`.../attendance/**`), and roots are walked in recorded order, so P16's
   * shared-`seen` first-root-wins dedupe would attribute every `w7-resolver`
   * file to root 2 and report root 3 as contributing ZERO — permanently, and
   * silently, exactly when the non-empty-domain leg is supposed to be proving
   * root 3 became real. These counts therefore come from an INDEPENDENT walk
   * per root, with no shared `seen` at all.
   */
  readonly perRootScannableCounts: ReadonlyMap<string, number>
  /** Deduped union across all roots — the domain the partition and both ban
   *  legs run over. Dedupe is required here: without it every nested file
   *  would be classified and scanned twice. */
  readonly union: readonly string[]
}

export function walkAttendanceW7GuardDomain(repoRoot: string): AttendanceW7GuardDomainV1 {
  const perRootScannableCounts = new Map<string, number>()

  // Pass 1 — INDEPENDENT per-root walks, no shared `seen`.
  for (const entry of ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1) {
    const dir = stripGlobSuffix(entry.root)
    const scannable = listAllFiles(repoRoot, dir).filter((relPath) => isScannablePath(relPath))
    perRootScannableCounts.set(entry.root, scannable.length)
  }

  // Pass 2 — deduped union for the partition and ban legs.
  const seen = new Set<string>()
  const union: string[] = []
  for (const entry of ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1) {
    const dir = stripGlobSuffix(entry.root)
    for (const relPath of listAllFiles(repoRoot, dir)) {
      if (seen.has(relPath)) continue
      seen.add(relPath)
      if (!isScannablePath(relPath)) continue
      union.push(relPath)
    }
  }
  union.sort()

  return { perRootScannableCounts, union }
}

// ---------------------------------------------------------------------------
// Leg (i): reference ban by RESOLVED module path.
// ---------------------------------------------------------------------------

/**
 * The banned W6 modules. W7-R10 bans "the W6 aggregate service/route modules".
 *
 * DELIBERATELY EXCLUDES the W6 types-only contract modules
 * (`w6-group-effective-policy-contract.ts`,
 * `w6-group-effective-policy-response-contract.ts`). Whether a compile-erased
 * `import type` of those counts as a live dependency is an OPEN question that
 * the W7 ratification (#4556 comments 5293034619 (ruling) + 5293478713 (owner first-person confirmation))
 * did NOT rule on. Banning them
 * here would settle an unruled question by implementation; not banning them
 * leaves a narrower guard. The resolution actually taken is neither: the W7
 * resolver imports NOTHING from any W6 module at all, so the question stays
 * genuinely moot for this slice and is reported as still unruled.
 */
export const ATTENDANCE_W7_BANNED_W6_MODULES_V1: readonly string[] = Object.freeze([
  'packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts',
])

const SPECIFIER_RE = /(?:\bimport\s*\(|\brequire\s*\(|\bfrom\s+)\s*['"]([^'"]+)['"]/g

/** Resolved targets of every relative `import` / `require` / `import()` in a
 *  file. Judged on WHAT IT LOADS, not on how the specifier is spelled — a
 *  literal-text ban is defeated by any alternate spelling, and enumerating
 *  spellings does not converge. */
export function resolvedRelativeModuleTargets(repoRoot: string, relPath: string): string[] {
  const abs = path.join(repoRoot, relPath)
  const text = fs.readFileSync(abs, 'utf8')
  const targets: string[] = []
  for (const match of text.matchAll(SPECIFIER_RE)) {
    const specifier = match[1]
    if (!specifier.startsWith('.')) continue
    const base = path.resolve(path.dirname(abs), specifier)
    for (const candidate of [base, `${base}.ts`, `${base}.cjs`, `${base}.js`, `${base}.mjs`]) {
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) {
        targets.push(path.relative(repoRoot, candidate).split(path.sep).join('/'))
        break
      }
    }
  }
  return targets
}

// ---------------------------------------------------------------------------
// Leg (ii): transport ban.
// ---------------------------------------------------------------------------

/**
 * BOTH spellings of the W6 aggregate route, matched exactly as the repo writes
 * them — never through a home-grown path normalizer. A normalizer is itself a
 * parser, and "validate then normalize" is the ordering bug; the repo already
 * contains both literals, so the positive whitelist of spellings is taken from
 * the repo instead of re-derived.
 *
 *  - express spelling:  `packages/core-backend/src/routes/attendance-admin.ts:1731`
 *  - OpenAPI spelling:  `packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml:25`
 */
export const ATTENDANCE_W7_BANNED_W6_ROUTE_LITERALS_V1: readonly string[] = Object.freeze([
  '/api/attendance/groups/:groupId/effective-policy',
  '/api/attendance/groups/{groupId}/effective-policy',
])

/** HTTP transport call shapes. Presence of one of these AND a banned route
 *  literal in the same file is the Leg (ii) violation. */
export const ATTENDANCE_W7_TRANSPORT_CALL_PATTERNS_V1: readonly RegExp[] = Object.freeze([
  /\bfetch\s*\(/,
  /\baxios\b/,
  /\brequest\s*\(/,
  /\bgot\s*\(/,
  /\bundici\b/,
])
