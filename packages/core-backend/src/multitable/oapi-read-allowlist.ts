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
 * creator's row-deny + field-permission stack per-request (Option A). `comments:read` (a narrow set in
 * `comments.ts`) is also allowlisted now and composes `requireScope` with the existing `rbacGuard` =
 * min(token scope, creator RBAC); its per-user surfaces (inbox/unread-count/mention-*) stay deferred.
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
  // comments:read — narrow set (`comments.ts`, behind rbacGuard). GET /api/comments (list), /api/comments/summary,
  // and /api/multitable/:spreadsheetId/comments/presence. The presence handler forces includeViewers=false on the
  // token path. DEFERRED (NOT matched): /api/comments/inbox, /unread-count, /mention-candidates, /mention-summary,
  // and /api/multitable/:id/mention-candidates — per-user / out-of-scope surfaces.
  /^\/api\/comments$/,
  /^\/api\/comments\/summary$/,
  /^\/api\/multitable\/[^/]+\/comments\/presence$/,
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

/**
 * OAPI-2a write routes — **method-bound** (design-lock
 * `docs/development/multitable-oapi2-write-designlock-20260628.md` §2, RATIFIED 2026-06-28).
 *
 * Unlike the read allowlist (GET-only), a write route is opened ONLY for its specific write method: a write
 * path is never opened for GET, and a read path is never opened for a write method. Each entry is an anchored
 * `^…$` `(method, path)` pair in **exact lockstep** with a route that mounts BOTH `apiTokenAuth` +
 * `requireScope` (univer-meta.ts / comments.ts) — the same over-match hazard as the read list: an entry
 * without a mounted `requireScope` is a silent no-auth bypass (`requireScope` fail-opens with no scopes).
 *
 * `DELETE /records/:id` is intentionally **absent** — it is OAPI-2b, gated after 2a (design-lock §4). So are
 * `/records/:id/lock`, `/records/:id/restore`, comment edit/delete (`PATCH`/`DELETE /api/comments/:id`), and
 * the public-form submit path `POST /api/multitable/views/:id/submit` (its own `publicToken` gate, disjoint).
 */
const OAPI_WRITE_ROUTES: readonly { method: string; pattern: RegExp }[] = [
  // records:write — POST /records (create). Exactly /records: not /records/:id, not /records/:id/lock.
  { method: 'POST', pattern: /^\/api\/multitable\/records$/ },
  // records:write — PATCH /records/:recordId (update). Exactly one id segment: not /records/:id/lock.
  { method: 'PATCH', pattern: /^\/api\/multitable\/records\/[^/]+$/ },
  // records:write — POST /patch (batch upsert).
  { method: 'POST', pattern: /^\/api\/multitable\/patch$/ },
  // comments:write — POST /api/comments (comment CREATE only). NOT PATCH/DELETE /api/comments/:id (edit/delete).
  { method: 'POST', pattern: /^\/api\/comments$/ },
]

/**
 * True only for an `mst_`-token request whose `(method, path)` matches an OAPI-2a write route. Fail-closed:
 * a wrong method on a write path, any read path, a non-token bearer, `DELETE` (2b), or any unlisted path →
 * false → the normal JWT gate (401 for an `mst_` bearer).
 */
export function isOapiWriteAllowlistRequest(
  method: string,
  path: string,
  authHeader: string | undefined,
): boolean {
  if (!isApiTokenBearer(authHeader)) return false
  return OAPI_WRITE_ROUTES.some((route) => route.method === method && route.pattern.test(path))
}

/**
 * THE single switch the global JWT gate (index.ts) consults: true for any allowlisted OAPI request, read
 * (GET, OAPI-1) or write (method-bound, OAPI-2a). A match lets an `mst_` bearer skip the JWT gate to reach
 * the per-route `apiTokenAuth` + `requireScope`; everything else falls through to a 401.
 */
export function isOapiAllowlistRequest(method: string, path: string, authHeader: string | undefined): boolean {
  return (
    isOapiReadAllowlistRequest(method, path, authHeader) ||
    isOapiWriteAllowlistRequest(method, path, authHeader)
  )
}
