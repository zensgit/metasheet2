/**
 * #3365 allowlist⟺guard dual-reachability tripwire (Tier-B gap #5, permission golden matrix —
 * `docs/research/multitable-feishu-refresh-audit-20260629.md` line 58): "pin that the OAPI allowlist
 * set equals the set of `apiTokenAuth`-guarded routes (currently lockstep-by-hand)."
 *
 * `oapi-read-allowlist.ts` is the single fail-closed switch the global JWT gate consults to let an
 * `mst_` API token reach a route's OWN `apiTokenAuth` + `requireScope` guards. Its own module comment
 * says the allowlist must be kept "in exact lockstep" with the routes that mount those guards — today
 * that lockstep is maintained BY HAND (two independently-edited call sites: the allowlist regex/route
 * arrays in `oapi-read-allowlist.ts`, and the `router.<verb>(...)` registrations in `univer-meta.ts` /
 * `comments.ts`). Nothing forces them to move together, so they can silently drift in either direction:
 *
 *   - a route gains `apiTokenAuth` + `requireScope` but nobody adds the matching allowlist entry → the
 *     guard is DEAD (an `mst_` token 401s at the global gate before ever reaching it) — harmless but a
 *     silent regression in whatever the route was meant to expose.
 *   - an allowlist entry is widened (or added) without a route actually mounting BOTH guards → a SILENT
 *     NO-AUTH BYPASS (`requireScope` fail-opens when no token scopes are attached, per its own doc
 *     comment in `middleware/api-token-auth.ts`) — the dangerous direction.
 *
 * This test derives BOTH sides from real source (no hand-duplicated list of its own) and asserts they
 * are the same set, following the same whole-file structural-scan discipline as
 * `multitable-stored-data-taint-chokepoint.guard.test.ts`:
 *
 *   1. Scan every `router.<verb>('<path>', ...)` registration in `routes/univer-meta.ts` and
 *      `routes/comments.ts` — confirmed (via `rg -ln apiTokenAuth packages/core-backend/src`) to be the
 *      ONLY two files where `apiTokenAuth` is ever mounted on a route — and split them into GUARDED
 *      (the registration's own argument list contains both `apiTokenAuth` and `requireScope(`) and
 *      UNGUARDED (every other registered route in the same two files).
 *   2. For each GUARDED route, assert the exported `isOapiAllowlistRequest` (the real gate function,
 *      not a re-typed copy) admits it.
 *   3. For each UNGUARDED route, assert `isOapiAllowlistRequest` REJECTS it — this is what actually
 *      proves the allowlist isn't over-broad: it's checked against every OTHER real route Express would
 *      dispatch on these two routers, not just a few hand-picked "adjacent path" guesses.
 *
 * If this test fails, you added/changed a route's guard-mounting or the allowlist's shape without
 * updating the other — see the two failure messages below for which direction drifted and what to fix.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'

const SRC = join(__dirname, '../../src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** The only two files where `apiTokenAuth` is ever mounted on a route (verified by whole-`src` grep). */
const ROUTE_FILES = ['routes/univer-meta.ts', 'routes/comments.ts'] as const

interface RouteRegistration {
  file: (typeof ROUTE_FILES)[number]
  method: string
  /** The literal Express registration path (e.g. `/records/:recordId`), as written in source. */
  registeredPath: string
  guarded: boolean
}

/**
 * Extract every `router.<verb>('<path>', ...rest)` registration. Both files write each registration as
 * ONE physical source line (`router.verb('path', mw1, mw2, ..., async (req, res) => {`), so a per-line
 * regex is sufficient and mirrors the files' actual style — this is re-verified below by asserting the
 * scan finds a large, non-trivial number of registrations in each file (a style change that broke the
 * regex would silently return an empty/tiny list, which the sanity test below catches).
 */
function extractRoutes(file: (typeof ROUTE_FILES)[number]): RouteRegistration[] {
  const src = read(file)
  const lineRe = /^\s*router\.(get|post|patch|delete|put)\(\s*'([^']+)'\s*,(.*)$/
  const out: RouteRegistration[] = []
  for (const rawLine of src.split('\n')) {
    const m = rawLine.match(lineRe)
    if (!m) continue
    const [, method, registeredPath, restOfArgs] = m
    const guarded = /\bapiTokenAuth\b/.test(restOfArgs) && /\brequireScope\(/.test(restOfArgs)
    out.push({ file, method: method.toUpperCase(), registeredPath, guarded })
  }
  return out
}

/**
 * `univer-meta.ts` routes are mounted at `/api/multitable` (verified: `index.ts` does
 * `this.app.use('/api/multitable', univerMetaRouter())`, and every registration inside the file uses a
 * bare relative path — zero absolute `/api/...` registrations). `comments.ts` routes already register
 * fully-absolute paths (e.g. `/api/comments`, `/api/multitable/:spreadsheetId/comments/presence`) and
 * its router is mounted with NO prefix (`this.app.use(commentsRouter(...))`).
 */
function fullPath(r: RouteRegistration): string {
  return r.file === 'routes/comments.ts' ? r.registeredPath : `/api/multitable${r.registeredPath}`
}

/**
 * Every allowlist pattern matches a param segment with `[^/]+` (verified by reading
 * `oapi-read-allowlist.ts`), so any single non-slash token is representative — replace every Express
 * `:param` segment with the SAME fixed probe token.
 */
function concretePath(r: RouteRegistration): string {
  return fullPath(r).replace(/:[^/]+/g, 'probe1')
}

const MST = 'Bearer mst_test0000000000000000'

const ALL_ROUTES = ROUTE_FILES.flatMap(extractRoutes)
const GUARDED = ALL_ROUTES.filter((r) => r.guarded)
const UNGUARDED = ALL_ROUTES.filter((r) => !r.guarded)

describe('#3365 OAPI allowlist⟺guard dual-reachability tripwire', () => {
  test('sanity: the source scan found a real population of routes on both sides (guards against a silent scan regression)', () => {
    // Both files register dozens of routes; if a future refactor changes the registration STYLE (e.g.
    // multi-line calls, a route-table object instead of direct `router.verb()` calls), this regex-based
    // scan would silently return near-zero matches and every test below would vacuously pass. Fail loud
    // instead.
    expect(ALL_ROUTES.length).toBeGreaterThan(50)
    expect(GUARDED.length).toBeGreaterThan(0)
    expect(UNGUARDED.length).toBeGreaterThan(0)
  })

  test('every apiTokenAuth+requireScope-guarded route is admitted by the OAPI allowlist', () => {
    const missing = GUARDED.filter((r) => !isOapiAllowlistRequest(r.method, concretePath(r), MST))
    expect(
      missing,
      `${missing.length} route(s) mount BOTH apiTokenAuth + requireScope but are NOT reachable through ` +
        `the OAPI allowlist gate — an mst_ token would 401 at the global gate before ever reaching the ` +
        `route's own guard (a dead guard, likely a forgotten allowlist entry):\n` +
        missing.map((r) => `  - ${r.file}: ${r.method} ${fullPath(r)}`).join('\n') +
        `\n\nAdd a matching entry to OAPI_READ_PATHS / OAPI_WRITE_ROUTES in oapi-read-allowlist.ts, or ` +
        `remove the apiTokenAuth/requireScope mount if the route was never meant to be token-reachable.`,
    ).toEqual([])
  })

  test('every route registered in these two files WITHOUT both guards is rejected by the OAPI allowlist (no silent over-match / bypass)', () => {
    const leaked = UNGUARDED.filter((r) => isOapiAllowlistRequest(r.method, concretePath(r), MST))
    expect(
      leaked,
      `${leaked.length} route(s) are admitted by the OAPI allowlist gate but do NOT mount BOTH ` +
        `apiTokenAuth + requireScope — an mst_ token would reach this route with NO per-route scope ` +
        `check (requireScope fail-opens when absent): a silent no-auth bypass:\n` +
        leaked.map((r) => `  - ${r.file}: ${r.method} ${fullPath(r)}`).join('\n') +
        `\n\nNarrow the matching pattern in OAPI_READ_PATHS / OAPI_WRITE_ROUTES in oapi-read-allowlist.ts, ` +
        `or mount apiTokenAuth + requireScope on this route if it was actually meant to be token-reachable.`,
    ).toEqual([])
  })
})
