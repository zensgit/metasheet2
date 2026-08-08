import * as fs from 'fs'
import * as path from 'path'

/**
 * `packages/core-backend`'s compiled output lands ONE DIRECTORY DEEPER than
 * its source tree: `tsconfig.json` sets `"rootDir": "."` (not `"src"`), so
 * `tsc` emits to `dist/src/...`, not `dist/...`. A literal `../../../../`
 * computed from `src/routes/` is therefore correct from the src tree and
 * WRONG once the same file runs compiled from `dist/src/routes/` — it lands
 * one level short of the repo root (`/app/packages/plugins/...` instead of
 * `/app/plugins/...`) and throws `MODULE_NOT_FOUND` at module-init time,
 * which crash-loops the whole backend on first boot after deploy (#4814 P1;
 * `src/index.ts` imports the router that does this require statically, at
 * module scope, so there is no route-level catch that can save it).
 *
 * This walks upward from the caller's `__dirname` looking for the first
 * ancestor that actually contains `plugins/plugin-attendance/lib/`, so the
 * SAME source resolves correctly from both the src tree (local dev, vitest)
 * and the dist tree (production) without hard-coding a depth. It fails
 * loudly — a named `Error`, not a silent fallback — if no ancestor within
 * the search bound has the directory, rather than letting a bare
 * `MODULE_NOT_FOUND` from an arbitrary guessed path stand in for it.
 */
export function resolvePluginAttendanceLibPath(startDir: string, relativeLibPath: string): string {
  const MAX_ANCESTOR_LEVELS = 12
  let dir = path.resolve(startDir)
  for (let level = 0; level <= MAX_ANCESTOR_LEVELS; level += 1) {
    const candidate = path.join(dir, 'plugins', 'plugin-attendance', 'lib', relativeLibPath)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `resolvePluginAttendanceLibPath: cannot locate plugins/plugin-attendance/lib/${relativeLibPath} ` +
      `by walking up from ${startDir} (searched ${MAX_ANCESTOR_LEVELS + 1} ancestor levels)`,
  )
}

/**
 * `require()`s a module inside `plugins/plugin-attendance/lib/`, resolved
 * depth-tolerantly from the caller's `__dirname`. See
 * {@link resolvePluginAttendanceLibPath} for why a hard-coded relative depth
 * is unsafe here.
 */
export function requirePluginAttendanceLib<T>(startDir: string, relativeLibPath: string): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require(resolvePluginAttendanceLibPath(startDir, relativeLibPath)) as T
}
