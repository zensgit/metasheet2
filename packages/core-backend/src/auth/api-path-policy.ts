/**
 * THE single source of truth for two questions the request pipeline keeps asking:
 *
 *   1. "Is this request path part of the HTTP API surface?"  → `isApiPath`
 *   2. "Is this path a declared exception to the global session gate?" → `isGateException`
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Both questions used to be answered independently, by literal path tests copy-pasted across five
 * places: the global session gate (`index.ts`), the gate's exception whitelist (`jwt-middleware.ts`),
 * the attendance audit predicate, the attendance IP allowlist and the attendance rate limiter
 * (`middleware/attendance-production.ts`). Independent copies of a policy drift, and two call sites that
 * answer "is this an API request?" differently produce a request that one layer treats as API traffic
 * and another does not. Consolidating the test into one module makes that class of disagreement
 * impossible to express: there is one predicate, and every layer calls it.
 *
 * `tests/unit/api-path-policy.guard.test.ts` fails the build if a new call site re-implements the test
 * locally instead of importing from here.
 *
 * MATCHING RULES
 * --------------
 * The rules below are chosen so the policy and the Express router agree, by construction, about which
 * requests are API requests:
 *
 *  - **Case-insensitive.** The routers in this app are mounted with Express's default
 *    `caseSensitive: false`, so path matching downstream is case-insensitive. The policy is defined the
 *    same way, so the set of paths the policy calls "API" is exactly the set the router will route.
 *
 *  - **Segment-anchored.** A prefix matches only at a `/` boundary or at end-of-path. `/apifoo` is not
 *    an API path, and a path that merely *resembles* a declared exception (`/api/healthcheck` next to
 *    the `/api/health` exception) does not inherit it. Exceptions are opt-outs from authentication, so
 *    they must cover exactly the paths they name and nothing else.
 *
 *  - **Trailing-slash tolerant.** Express runs with `strict routing` disabled, so `/api/x` and `/api/x/`
 *    reach the same handler. The policy treats them as the same path for the same reason.
 *
 *  - **Not percent-decoded.** Express matches the *undecoded* pathname (`parseUrl(req).pathname`), so
 *    this policy must not decode either. A policy that normalised more aggressively than the router
 *    would be a fresh disagreement of exactly the kind this module exists to prevent.
 *    (`tests/unit/api-path-policy.test.ts` pins this against the real router rather than asserting it.)
 */

/**
 * The API surface: `/api`, and anything below it. Anchored at the start and at a segment boundary.
 * Every layer that needs to know "is this an API request?" MUST use this, never a local literal test.
 */
export const API_PATH_PATTERN = /^\/api(?:\/|$)/i

/**
 * Normalise a request path for policy comparison: case-folded, with a single trailing slash removed.
 * Deliberately does NOT percent-decode — see the module header.
 */
function normalize(path: string): string {
  const lowered = (path || '').toLowerCase()
  if (lowered.length > 1 && lowered.endsWith('/')) return lowered.slice(0, -1)
  return lowered
}

/** True when `path` addresses the HTTP API surface (`/api` or anything under it). */
export function isApiPath(path: string): boolean {
  return API_PATH_PATTERN.test(path || '')
}

/** Exact path comparison under the policy's normalisation rules. */
export function apiPathEquals(path: string, expected: string): boolean {
  return normalize(path) === normalize(expected)
}

/**
 * Segment-anchored prefix comparison: true for the prefix itself and for anything strictly below it.
 * `/api/thing` does NOT match a `/api/thingamajig` request.
 */
export function apiPathHasPrefix(path: string, prefix: string): boolean {
  const p = normalize(path)
  const q = normalize(prefix)
  return p === q || p.startsWith(`${q}/`)
}

/**
 * How far a declared exception reaches.
 *  - `exact`  — that one path only. A path below it is NOT covered and stays behind the gate.
 *  - `prefix` — that path and everything below it. Only for surfaces that own a whole subtree AND
 *               carry their own authentication downstream (or are deliberately public throughout).
 */
export type GateExceptionKind = 'exact' | 'prefix'

export type GateException = {
  /** The path this exception covers, without a trailing slash. */
  readonly path: string
  readonly kind: GateExceptionKind
  /** Why this path is allowed to skip the global session gate, and what authenticates it instead. */
  readonly reason: string
}

/**
 * THE exception table. Every path that is allowed past the global session gate without a session JWT is
 * declared here, once, with its kind — `exact` unless a whole subtree genuinely needs to be exempt.
 *
 * Adding an entry opts a path OUT of authentication. Two rules for anyone editing this list:
 *   1. Prefer `exact`. Use `prefix` only when the whole subtree must be exempt, and say in `reason`
 *      what authenticates the subtree instead of the session JWT.
 *   2. An entry must correspond to a route that is *meant* to be reachable without a session. Do not
 *      add one because a path happens to 404 today — a later commit can make it a real route, and the
 *      exception would silently start covering it.
 *
 * NOTE — this table is the whole of the *path-prefix* exception surface, but it is not the only way a
 * request can reach a handler without a session JWT. The gate in `index.ts` also consults two
 * request-shaped exceptions that cannot be expressed as a path: `isPublicFormAuthBypass`
 * (jwt-middleware.ts — public-form token in the query/body) and `isOapiAllowlistRequest`
 * (multitable/oapi-read-allowlist.ts — `mst_` API-token bearer on an anchored, method-bound route
 * allowlist whose entries each mount their own `apiTokenAuth` + `requireScope`). Both are anchored and
 * fail closed on a miss. When auditing "what can skip the gate", read all three.
 */
export const GLOBAL_GATE_EXCEPTIONS: readonly GateException[] = [
  { path: '/health', kind: 'exact', reason: 'Liveness probe. Public by design; serves no tenant data.' },
  { path: '/api/health', kind: 'exact', reason: 'Liveness probe (API alias). Public by design; serves no tenant data.' },
  { path: '/internal/metrics', kind: 'exact', reason: 'Internal metrics scrape endpoint; not part of the API surface.' },

  // --- Pre-authentication auth endpoints: these are how a caller OBTAINS a session, so they cannot
  // --- require one. Each is `exact`: a new path under /api/auth is authenticated unless declared here.
  { path: '/api/auth/login', kind: 'exact', reason: 'Password login — issues the session; cannot require one.' },
  {
    path: '/api/auth/login/dingtalk/container',
    kind: 'exact',
    reason:
      'DingTalk in-container 免登 login. Pre-authentication by definition (it exchanges an authCode for a ' +
      'session) and gated separately by DINGTALK_CONTAINER_LOGIN_ENABLED. Declared explicitly because it ' +
      'sits below /api/auth/login, which is an `exact` exception and does not cover its children.',
  },
  { path: '/api/auth/register', kind: 'exact', reason: 'Self-registration — pre-authentication.' },
  { path: '/api/auth/invite/preview', kind: 'exact', reason: 'Invite preview — authenticated by the invite token in the request.' },
  { path: '/api/auth/invite/accept', kind: 'exact', reason: 'Invite acceptance — authenticated by the invite token in the request.' },
  { path: '/api/auth/refresh', kind: 'exact', reason: 'Session refresh — authenticated by the refresh token, not the access token.' },
  { path: '/api/auth/refresh-token', kind: 'exact', reason: 'Session refresh (alias) — authenticated by the refresh token.' },
  { path: '/api/auth/dev-token', kind: 'exact', reason: 'Development/test token issuance — pre-authentication.' },
  { path: '/api/auth/dingtalk/launch', kind: 'exact', reason: 'DingTalk OAuth launch — pre-authentication redirect.' },
  { path: '/api/auth/dingtalk/callback', kind: 'exact', reason: 'DingTalk OAuth callback — authenticated by the OAuth code, not a session.' },

  // --- Non-tenant informational endpoints.
  { path: '/api/plugins', kind: 'exact', reason: 'Plugin inventory summary. `exact`: routes that plugins register under /api/plugins/** are NOT covered and stay behind the gate.' },
  { path: '/api/permissions/health', kind: 'exact', reason: 'Permission-subsystem liveness probe; serves no tenant data.' },
  { path: '/api/v2/hello', kind: 'exact', reason: 'Static protocol-version probe; serves no tenant data.' },
  { path: '/api/v2/rpc-test', kind: 'exact', reason: 'Static RPC transport probe; serves no tenant data.' },

  // --- Subtrees that are exempt as a whole.
  {
    path: '/api/cache-test',
    kind: 'prefix',
    reason:
      'Cache diagnostics router (dev-only endpoints: /simulate, /warm, /metrics). `prefix` because the ' +
      'router owns the whole subtree and no individual path under it is separately reachable.',
  },
  {
    path: '/api/plm-embed',
    kind: 'prefix',
    reason:
      'PLM embed surface. Authenticated by the EdDSA embed token (`embedTokenAuth`) rather than the ' +
      'session JWT, so the whole subtree must bypass the session gate; embedTokenAuth is its sole auth. ' +
      '/api/plm-embed/config is intentionally public (it serves only the origin allowlist).',
  },
] as const

/** The declared exception covering `path`, or null when the path is behind the gate. */
export function matchGateException(path: string): GateException | null {
  for (const entry of GLOBAL_GATE_EXCEPTIONS) {
    const hit = entry.kind === 'exact' ? apiPathEquals(path, entry.path) : apiPathHasPrefix(path, entry.path)
    if (hit) return entry
  }
  return null
}

/** True when `path` is a declared exception to the global session gate. */
export function isGateException(path: string): boolean {
  return matchGateException(path) !== null
}
