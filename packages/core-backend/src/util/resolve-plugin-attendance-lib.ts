import * as fs from 'fs'
import * as path from 'path'

/**
 * Why this module exists at all (#4814 P1): `packages/core-backend`'s compiled
 * output lands ONE DIRECTORY DEEPER than its source tree — `tsconfig.json`
 * sets `"rootDir": "."` (not `"src"`), so `tsc` emits to `dist/src/...`, not
 * `dist/...`. A literal `../../../../` computed from `src/routes/` is correct
 * from the src tree and WRONG once the same file runs compiled from
 * `dist/src/routes/`: it lands one level short of the repo root
 * (`/app/packages/plugins/...` instead of `/app/plugins/...`) and throws
 * `MODULE_NOT_FOUND` at module-init time, which crash-loops the whole backend
 * on first boot after deploy (`src/index.ts` imports the router that does this
 * `require` statically, at module scope, so no route-level catch can save it).
 *
 * Why the FIRST-HIT UPWARD WALK that used to live here was replaced
 * (rebuild review, phase 1): the walk returned the first `existsSync` hit with
 * no canonical-root anchor, no regular-file requirement, no symlink rejection,
 * no `realpath` containment, and no closed file set. All four attack classes
 * SUCCEEDED against it, with execution proven by markers:
 *
 *   A1 shadow root       — a nearer `packages/core-backend/plugins/plugin-attendance/lib/…`
 *                          won from BOTH start dirs and executed. Two tracked
 *                          directories already sit on the walk path ahead of the
 *                          canonical root (`packages/core-backend/src/plugins/`,
 *                          `packages/core-backend/plugins/`) and `Dockerfile.backend`
 *                          ships both into the production image.
 *   A2 directory masquerade — replacing the target file with a DIRECTORY containing
 *                          `index.js` still resolved and executed.
 *   A3a symlinked FILE   — resolved and executed a symlink pointing outside the root.
 *   A3b symlinked PARENT — a symlinked `lib/` component: the final component
 *                          `lstat`s as a regular file, so an `isFile()` check alone
 *                          does NOT close this. That is why all six checks below
 *                          land as ONE mechanism rather than incrementally.
 *   A4 path escape       — `relativeLibPath = '../../../escaped.cjs'` resolved and
 *                          executed outside the plugin root.
 *
 * The ruled replacement shape, in order:
 *   1. unique repo root located by the NAMED `packages/core-backend/package.json`
 *      (walk to the TOP, assert exactly one candidate — not first hit);
 *   2. a FIXED plugin root `<repoRoot>/plugins/plugin-attendance/lib` — no search;
 *   3. a CLOSED literal file set, so traversal is UNREPRESENTABLE rather than
 *      filtered (A4/A5 become "not in the set", not "escaped a regex");
 *   4. `lstat` on EVERY path component from the repo root down — any symlink is
 *      rejected (closes A3a and A3b together);
 *   5. the final `lstat` must be a REGULAR FILE (closes A2);
 *   6. `realpathSync(candidate)` must still start with `realpathSync(repoRoot)` +
 *      separator (defence in depth behind 4).
 *
 * It fails LOUDLY throughout — a named `Error` carrying a diagnosable reason
 * code, never a silent fallback and never a bare `MODULE_NOT_FOUND` from an
 * arbitrary guessed path.
 */

/**
 * The CLOSED set of files this resolver may ever return. Adding a member is a
 * deliberate, reviewable act; `../`, absolute paths, and anything else are not
 * "filtered out", they are simply not in the set.
 *
 * Every entry must be a real file under `plugins/plugin-attendance/lib/` — the
 * hardening test asserts that mechanically, so a typo here becomes a red test
 * rather than a boot crash.
 */
export const PLUGIN_ATTENDANCE_LIB_CLOSED_FILE_SET: readonly string[] = Object.freeze([
  'attendance-group-fixed-schedule-effectiveness-service.cjs',
  'attendance-group-fixed-schedule-producer-key.cjs',
  'attendance-shift-service.cjs',
])

/** Directory name of the backend package whose `package.json` anchors the repo root. */
const REPO_ROOT_ANCHOR_SEGMENTS = ['packages', 'core-backend', 'package.json'] as const
const PLUGIN_ROOT_SEGMENTS = ['plugins', 'plugin-attendance', 'lib'] as const

export class PluginAttendanceLibResolutionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`resolvePluginAttendanceLibPath[${code}]: ${message}`)
    this.name = 'PluginAttendanceLibResolutionError'
    this.code = code
  }
}

/**
 * Walks from `startDir` to the filesystem root collecting EVERY ancestor that
 * contains `packages/core-backend/package.json`, then requires exactly one.
 *
 * Deliberately does NOT return on first hit: "first ancestor that looks right"
 * is the exact defect class this rewrite closes. Two candidates means the tree
 * is ambiguous (a nested checkout, a copied package) and the correct response
 * is to refuse, not to guess.
 */
export function resolveCoreBackendRepoRoot(startDir: string): string {
  const candidates: string[] = []
  let dir = path.resolve(startDir)
  // Bounded only by reaching the filesystem root — an ancestor count bound is
  // what let a shadow root win before, so there is no early exit here.
  for (;;) {
    const anchor = path.join(dir, ...REPO_ROOT_ANCHOR_SEGMENTS)
    let anchorStat: fs.Stats | null = null
    try {
      anchorStat = fs.lstatSync(anchor)
    } catch {
      anchorStat = null
    }
    if (anchorStat && anchorStat.isFile()) candidates.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (candidates.length === 0) {
    throw new PluginAttendanceLibResolutionError(
      'REPO_ROOT_NOT_FOUND',
      `no ancestor of ${startDir} contains ${REPO_ROOT_ANCHOR_SEGMENTS.join('/')}`,
    )
  }
  if (candidates.length > 1) {
    throw new PluginAttendanceLibResolutionError(
      'REPO_ROOT_AMBIGUOUS',
      `${candidates.length} ancestors of ${startDir} contain ${REPO_ROOT_ANCHOR_SEGMENTS.join('/')}: ${candidates.join(', ')}`,
    )
  }
  return candidates[0]
}

/** `lstat` (never `stat`) every component from `root` down to `target`, rejecting symlinks. */
function assertNoSymlinkComponents(root: string, target: string): void {
  const relative = path.relative(root, target)
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0)
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(current)
    } catch {
      throw new PluginAttendanceLibResolutionError('COMPONENT_MISSING', `path component does not exist: ${current}`)
    }
    if (stats.isSymbolicLink()) {
      throw new PluginAttendanceLibResolutionError(
        'SYMLINK_COMPONENT_REJECTED',
        `path component is a symbolic link: ${current}`,
      )
    }
  }
}

/**
 * Resolves one member of {@link PLUGIN_ATTENDANCE_LIB_CLOSED_FILE_SET} to an
 * absolute path under the unique repo root's `plugins/plugin-attendance/lib/`.
 *
 * Throws {@link PluginAttendanceLibResolutionError} — with a `code` naming the
 * exact check that refused — on every rejection path. There is no fallback.
 */
export function resolvePluginAttendanceLibPath(startDir: string, relativeLibPath: string): string {
  if (!PLUGIN_ATTENDANCE_LIB_CLOSED_FILE_SET.includes(relativeLibPath)) {
    throw new PluginAttendanceLibResolutionError(
      'FILE_NOT_IN_CLOSED_SET',
      `${JSON.stringify(relativeLibPath)} is not a member of the closed file set ` +
        `[${PLUGIN_ATTENDANCE_LIB_CLOSED_FILE_SET.join(', ')}]`,
    )
  }

  const repoRoot = resolveCoreBackendRepoRoot(startDir)
  const pluginRoot = path.join(repoRoot, ...PLUGIN_ROOT_SEGMENTS)
  const candidate = path.join(pluginRoot, relativeLibPath)

  // Belt and braces behind the closed set: even a set member must not be able
  // to point outside the fixed plugin root (e.g. if a future member were added
  // carelessly). `path.join` normalises `..` away BEFORE this runs, so the
  // containment test is the one that actually catches an escaping member.
  if (!candidate.startsWith(pluginRoot + path.sep)) {
    throw new PluginAttendanceLibResolutionError(
      'ESCAPES_PLUGIN_ROOT',
      `${candidate} is not directly inside ${pluginRoot}`,
    )
  }

  assertNoSymlinkComponents(repoRoot, candidate)

  let finalStats: fs.Stats
  try {
    finalStats = fs.lstatSync(candidate)
  } catch {
    throw new PluginAttendanceLibResolutionError('FILE_MISSING', `${candidate} does not exist`)
  }
  if (!finalStats.isFile()) {
    throw new PluginAttendanceLibResolutionError(
      'NOT_A_REGULAR_FILE',
      `${candidate} exists but is not a regular file (directory masquerade or device node)`,
    )
  }

  // Both sides realpath'd: on macOS the repo itself can live under a symlinked
  // prefix (`/tmp` -> `/private/tmp`), so comparing a realpath'd candidate to a
  // raw root would reject legitimate trees for the wrong reason.
  const realCandidate = fs.realpathSync(candidate)
  const realRoot = fs.realpathSync(repoRoot)
  if (!realCandidate.startsWith(realRoot + path.sep)) {
    throw new PluginAttendanceLibResolutionError(
      'REALPATH_OUTSIDE_REPO_ROOT',
      `${candidate} resolves to ${realCandidate}, which is outside ${realRoot}`,
    )
  }

  return realCandidate
}

/**
 * `require()`s a member of the closed plugin-lib file set, resolved through
 * {@link resolvePluginAttendanceLibPath}. Every rejection is a named,
 * diagnosable throw — a boot crash-loop with a readable reason, never a silent
 * substitution of an attacker- or artifact-supplied module.
 */
export function requirePluginAttendanceLib<T>(startDir: string, relativeLibPath: string): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require(resolvePluginAttendanceLibPath(startDir, relativeLibPath)) as T
}
