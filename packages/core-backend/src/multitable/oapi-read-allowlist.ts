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
 * OAPI-1 scope: `records:read` only — GET /records (list) and GET /records/:id (single). The remaining
 * read surfaces (view / view-aggregate / records-summary → records:read; fields → fields:read;
 * comments → comments:read) are the same pattern and land as the OAPI-1 continuation.
 */
const TOKEN_BEARER_PREFIX = 'Bearer mst_'

// GET /api/multitable/records (list) and GET /api/multitable/records/<id> (single). Exactly 0 or 1 path
// segment after `records` — so `/records-summary`, `/records/:id/history`, `/records/:id/restore`, etc.
// are NOT matched (they are not part of OAPI-1).
const RECORDS_READ_PATH = /^\/api\/multitable\/records(?:\/[^/]+)?$/

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
  return RECORDS_READ_PATH.test(path)
}
