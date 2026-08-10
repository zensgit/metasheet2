import * as fs from 'fs'
import * as path from 'path'

/**
 * Resolves a small, closed set of `plugins/plugin-attendance/lib/*.cjs`
 * modules for `require()` by backend TypeScript code, anchored to the
 * repo root rather than to a literal relative path.
 *
 * Why: `packages/core-backend`'s compiled output lands one directory deeper
 * than its source tree (`tsconfig.json` sets `"rootDir": "."`, so `tsc`
 * emits to `dist/src/...`), so a literal `../../../../` computed from
 * `src/routes/` is only correct for one of the two layouts this file
 * actually runs from. This resolver instead:
 *
 *   1. locates the unique ancestor directory that contains
 *      `packages/core-backend/package.json` (refusing if none, or more
 *      than one, is found — an ambiguous tree should not guess);
 *   2. resolves the target only within the fixed
 *      `<repoRoot>/plugins/plugin-attendance/lib` root;
 *   3. accepts only a file name that is a member of the closed
 *      {@link PLUGIN_ATTENDANCE_LIB_CLOSED_FILE_SET};
 *   4. rejects the path if any component from the repo root down is a
 *      symbolic link, and if the final component is not a regular file;
 *   5. confirms the resolved real path still sits under the repo root's
 *      real path before returning it.
 *
 * Every rejection throws a named, diagnosable {@link PluginAttendanceLibResolutionError}
 * rather than falling back to a guess or surfacing a bare `MODULE_NOT_FOUND`.
 */

/**
 * The closed set of files this resolver may ever return. Adding a member is
 * a deliberate, reviewable edit — every entry must be a real file under
 * `plugins/plugin-attendance/lib/`, which the resolver hardening test
 * asserts mechanically.
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
 * Walks from `startDir` to the filesystem root collecting every ancestor
 * that contains `packages/core-backend/package.json`, then requires there
 * to be exactly one. Two candidates means the tree is ambiguous (a nested
 * checkout, a copied package) and the correct response is to refuse.
 */
export function resolveCoreBackendRepoRoot(startDir: string): string {
  const candidates: string[] = []
  let dir = path.resolve(startDir)
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

/** `lstat` (never `stat`) every path component from `root` down to `target`,
 * rejecting the resolution if any component is a symbolic link. */
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
 * Throws {@link PluginAttendanceLibResolutionError} — with a `code` naming
 * the exact check that refused — on every rejection path. There is no
 * fallback.
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

  // Belt and braces behind the closed set: the resolved path must sit
  // directly inside the fixed plugin root. `path.join` normalises `..` away
  // before this runs, so this is a containment check on the final path.
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
      `${candidate} exists but is not a regular file`,
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
 * diagnosable throw.
 */
export function requirePluginAttendanceLib<T>(startDir: string, relativeLibPath: string): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require(resolvePluginAttendanceLibPath(startDir, relativeLibPath)) as T
}
