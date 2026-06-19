/**
 * OAPI-1 read-route allowlist (open-API token auth — design-lock
 * docs/development/multitable-openapi-token-auth-designlock-20260619.md).
 *
 * The global JWT gate (index.ts) 401s any non-JWT bearer. An `mst_` API token must reach the per-route
 * `apiTokenAuth` + `requireScope` guards to authenticate — but ONLY on the exact read routes below.
 * This matcher is the single fail-closed switch the gate consults: an `mst_` bearer on a listed read
 * route passes through (the route then validates the token + enforces scope); an `mst_` bearer ANYWHERE
 * else falls through to `jwtAuthMiddleware` → 401. Keep this in lockstep with the routes that mount
 * `apiTokenAuth` (univer-meta.ts). Read-only by construction: no write/side-effecting path is listed,
 * so a token can never reach one (it 401s there).
 *
 * OAPI-1 scope (univer-meta read surface): `records:read` — GET /records (list), /records/:id (single),
 * /view, /sheets/:sheetId/view-aggregate, /records-summary; and `fields:read` — GET /fields. All apply the
 * creator's row-deny + field-permission stack per-request (Option A). `comments:read` lives in a different
 * router (`comments.ts`, `rbacGuard`-based) and is the remaining OAPI-1 slice — NOT yet allowlisted here.
 */
const TOKEN_BEARER_PREFIX = 'Bearer mst_'

/**
 * THE auth boundary. Each pattern must be in **exact lockstep** with a route that mounts BOTH
 * `apiTokenAuth` + `requireScope` (univer-meta.ts), and every pattern is **anchored `^…$`**. Rationale:
 * a match lets an `mst_` bearer SKIP the global JWT gate to reach those per-route guards. An OVER-match
 * (a path with no guards) would be a silent no-auth bypass — `requireScope` fail-opens when no token
 * scopes are attached. Under-match merely 401s a token (harmless). So: anchor everything; never add a
 * pattern without the matching mounted guards; keep the adjacent-route exclusions below intentional.
 */
const OAPI_READ_PATHS: readonly RegExp[] = [
  // records:read — GET /records (list), /records/:id (single). Exactly 0/1 segment after `records`, so
  // `/records-summary` (own pattern below), `/records/:id/history`, `/records/:id/restore` do NOT match.
  /^\/api\/multitable\/records(?:\/[^/]+)?$/,
  // records:read — GET /records-summary (a SIBLING of /records, not under it).
  /^\/api\/multitable\/records-summary$/,
  // records:read — GET /view. NOT `/views` (list-views), `/views/:id/permissions`, `/sheets/:id/view`.
  /^\/api\/multitable\/view$/,
  // records:read — GET /sheets/:sheetId/view-aggregate (exactly one sheetId segment).
  /^\/api\/multitable\/sheets\/[^/]+\/view-aggregate$/,
  // fields:read — GET /fields ONLY. NOT `/fields/:id/link-options`, NOT `/sheets/:id/person-fields/:id/directory`.
  /^\/api\/multitable\/fields$/,
]

export function isApiTokenBearer(authHeader: string | undefined): boolean {
  return typeof authHeader === 'string' && authHeader.startsWith(TOKEN_BEARER_PREFIX)
}

/**
 * True only for an `mst_`-token GET request to an OAPI-1 read route. Used by the global gate to let such
 * a request through to the per-route `apiTokenAuth`/`requireScope`. Fail-closed: anything not matched
 * here (wrong method, write path, non-token bearer, any other path) returns false → normal JWT gate.
 */
export function isOapiReadAllowlistRequest(method: string, path: string, authHeader: string | undefined): boolean {
  if (!isApiTokenBearer(authHeader)) return false
  if (method !== 'GET') return false
  return OAPI_READ_PATHS.some((pattern) => pattern.test(path))
}
