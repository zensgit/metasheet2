/**
 * G44 — the integration (data-factory) READ surface of the `mst_` open-API token, first cut.
 *
 * WHAT THIS IS
 * ------------
 * `multitable/oapi-read-allowlist.ts` is the fail-closed switch that lets an `mst_` bearer skip the
 * global JWT gate (`index.ts`) on a small, anchored, method-bound set of multitable routes. Until now
 * the integration surface had NO such entry at all: every `/api/integration/**` call had to carry a
 * user JWT, which is why `scripts/ops/stock-preparation-scheduled-pull.mjs` runs on an admin Bearer.
 *
 * This module adds the READ half of that surface, and only the read half. It is a SEPARATE module
 * from the multitable one on purpose: the two have different lockstep partners (see below), so a
 * reader auditing "what can an `mst_` token reach" must be able to see which guard each list is
 * paired with without untangling them.
 *
 * THE LOCKSTEP PARTNER IS NOT A ROUTER — IT IS `middleware/integration-api-token-gate.ts`
 * ---------------------------------------------------------------------------------------
 * The multitable list is paired with per-route `apiTokenAuth` + `requireScope` mounts inside
 * `routes/univer-meta.ts` / `routes/comments.ts`. The integration routes are registered by a PLUGIN
 * (`plugins/plugin-integration-core/lib/http-routes.cjs`, a provenance-pinned file this PR does not
 * touch) through `context.api.http.addRoute`, so there is no host-owned router to mount a guard on.
 *
 * The guard is therefore mounted ONCE, app-level, immediately after the global JWT gate:
 * `createIntegrationApiTokenGate()` in `middleware/integration-api-token-gate.ts`. That gate covers
 * the WHOLE `/api/integration` subtree, so the "an allowlist entry with no mounted guard is a silent
 * no-auth bypass" hazard that the multitable module warns about cannot arise here by forgetting a
 * mount: a path this list admits is, by construction, a path the gate also intercepts. What the list
 * still controls is the BLAST RADIUS — the gate refuses (401) any `mst_` bearer on an
 * `/api/integration` path this list does not admit.
 *
 * MATCHING DISCIPLINE — deliberately NARROWER than the Express router
 * ------------------------------------------------------------------
 * Express runs with `caseSensitive: false` and `strict: false`, and matches the UNDECODED pathname.
 * These patterns are anchored `^…$`, CASE-SENSITIVE, reject a trailing slash, and never decode. Every
 * one of those choices can only make this matcher admit FEWER requests than the router dispatches, and
 * under-matching is harmless (the request falls back to the JWT gate → 401 for an `mst_` bearer) while
 * over-matching would be the bypass. Concretely:
 *   - `/API/Integration/pipelines`      → no match → 401 (the router would have dispatched it).
 *   - `/api/integration/pipelines/`     → no match → 401 (ditto).
 *   - `/api/integration/pipelines?x=1`  → `req.path` excludes the query string, so the query is
 *                                          invisible here and cannot be used to shape the match.
 *   - `/api/integration/pipelines/%2e%2e/x` → no match: `%2e%2e` is a literal segment for BOTH the
 *                                          router and this matcher (neither decodes), and the extra
 *                                          segment takes it past every anchored pattern.
 *   - `/api/integration/a/../table-actions/x/apply` → no match (segment count), and the method would
 *                                          have to be GET anyway, which `apply` is not.
 *
 * WHAT IS IN, AND THE ONE RULE THAT DECIDES IT
 * -------------------------------------------
 * Included = every route in the plugin's `ROUTES` table whose method is GET and whose handler's gate
 * is exactly `requireAccess(req, 'read')` — the tier `hasPermission` defines as `integration:read` ∨
 * `integration:write` ∨ `integration:admin` ∨ `role:admin` (http-routes.cjs:896-913) — MINUS the three
 * that construct an adapter and reach the customer's own system:
 *   - `GET /external-systems/:id/objects`  (http-routes.cjs:5250)
 *   - `GET /external-systems/:id/schema`   (http-routes.cjs:5270)
 *   - `GET /stock-preparation/source-preflight` (http-routes.cjs:6571)
 * Those three are read-only and read-TIER, but they are a credentialed OUTBOUND probe of the
 * customer's PLM/ERP. Handing an unattended machine credential the ability to originate traffic into
 * the customer's system is a separate decision from letting it read our own registry, and this PR does
 * not make it. Everything admin-tier (`requireAccess(req, 'admin')`) and everything in the stock-prep
 * vocabulary (`stock-prep:read` / `:operate`) is out for the same reason it is out for the plugin's
 * own tier split — this list never widens a tier, it only narrows which routes a token may attempt.
 *
 * NOT admitted, and deliberately: `GET /api/integration/health` (registered outside the ROUTES table,
 * at `plugins/plugin-integration-core/index.cjs:463`, with NO `requireAccess` call of its own). It is
 * a host-gated route today — it sits behind the global JWT gate — and admitting it here would be the
 * one entry in this file whose only authentication would be the token gate itself.
 */

import { apiPathHasPrefix } from '../auth/api-path-policy'

/** The single token scope this list is paired with. Read-only by construction. */
export const INTEGRATION_OAPI_READ_SCOPE = 'integration:read' as const

/** The RBAC permission code the token's CREATOR must independently hold (checked against the DB). */
export const INTEGRATION_OAPI_READ_PERMISSION = 'integration:read' as const

/** The subtree the app-level token gate intercepts. */
const INTEGRATION_SUBTREE = '/api/integration'

/**
 * THE contract. One entry per GET the token may attempt, each paired with the plugin route it stands
 * for. `expressPath` is the literal registration string in `http-routes.cjs`'s ROUTES table, so a test
 * can diff this list against that table mechanically instead of trusting this comment.
 */
export interface IntegrationOapiReadRoute {
  /** The Express registration path exactly as written in the plugin's ROUTES table. */
  readonly expressPath: string
  /** Anchored matcher for the concrete request path. */
  readonly pattern: RegExp
  /** The plugin handler name, for cross-referencing. */
  readonly handler: string
}

export const INTEGRATION_OAPI_READ_ROUTES: readonly IntegrationOapiReadRoute[] = [
  // Catalogs / self-description. No tenant is resolved by these handlers at all.
  { expressPath: '/api/integration/status', handler: 'status', pattern: /^\/api\/integration\/status$/ },
  { expressPath: '/api/integration/adapters', handler: 'adaptersList', pattern: /^\/api\/integration\/adapters$/ },
  { expressPath: '/api/integration/templates/references', handler: 'templatesReferences', pattern: /^\/api\/integration\/templates\/references$/ },
  { expressPath: '/api/integration/staging/descriptors', handler: 'stagingDescriptors', pattern: /^\/api\/integration\/staging\/descriptors$/ },

  // 对接总览 — the one joined read. Tenant-scoped via `scopedInput`.
  { expressPath: '/api/integration/hub/overview', handler: 'integrationHubOverview', pattern: /^\/api\/integration\/hub\/overview$/ },

  // External-system registry (NOT /objects, NOT /schema — those reach the customer's system).
  { expressPath: '/api/integration/external-systems', handler: 'externalSystemsList', pattern: /^\/api\/integration\/external-systems$/ },
  { expressPath: '/api/integration/external-systems/:id', handler: 'externalSystemsGet', pattern: /^\/api\/integration\/external-systems\/[^/]+$/ },

  // Approved read-source configs + their audit trail.
  { expressPath: '/api/integration/read-source-configs', handler: 'readSourceConfigsList', pattern: /^\/api\/integration\/read-source-configs$/ },
  { expressPath: '/api/integration/read-source-configs/:id', handler: 'readSourceConfigsGet', pattern: /^\/api\/integration\/read-source-configs\/[^/]+$/ },
  { expressPath: '/api/integration/read-source-configs/:id/audit', handler: 'readSourceConfigsAudit', pattern: /^\/api\/integration\/read-source-configs\/[^/]+\/audit$/ },

  // Read-source compositions + their audit trail.
  { expressPath: '/api/integration/read-source-compositions', handler: 'readSourceCompositionsList', pattern: /^\/api\/integration\/read-source-compositions$/ },
  { expressPath: '/api/integration/read-source-compositions/:id', handler: 'readSourceCompositionsGet', pattern: /^\/api\/integration\/read-source-compositions\/[^/]+$/ },
  { expressPath: '/api/integration/read-source-compositions/:id/audit', handler: 'readSourceCompositionsAudit', pattern: /^\/api\/integration\/read-source-compositions\/[^/]+\/audit$/ },

  // BA-APPLY approval-gate READ. The approve/retire legs are POST and stay out by method.
  { expressPath: '/api/integration/bridge-agent-checklists/:id', handler: 'bridgeAgentChecklistsGet', pattern: /^\/api\/integration\/bridge-agent-checklists\/[^/]+$/ },

  // Pipelines (definitions only — `POST :id/run` and both external-write legs stay out by method).
  { expressPath: '/api/integration/pipelines', handler: 'pipelinesList', pattern: /^\/api\/integration\/pipelines$/ },
  { expressPath: '/api/integration/pipelines/:id', handler: 'pipelinesGet', pattern: /^\/api\/integration\/pipelines\/[^/]+$/ },

  // Table actions: the registry listing and the conflict-policy READ (PUT/DELETE stay out by method).
  { expressPath: '/api/integration/table-actions', handler: 'tableActionsList', pattern: /^\/api\/integration\/table-actions$/ },
  { expressPath: '/api/integration/table-actions/:actionId/conflict-policies', handler: 'tableActionConflictPoliciesList', pattern: /^\/api\/integration\/table-actions\/[^/]+\/conflict-policies$/ },

  // Integration templates (declarative objects; instantiate/derive/preview are POST).
  { expressPath: '/api/integration/templates', handler: 'templatesList', pattern: /^\/api\/integration\/templates$/ },
  { expressPath: '/api/integration/templates/:id', handler: 'templatesGet', pattern: /^\/api\/integration\/templates\/[^/]+$/ },

  // Run / provenance / dead-letter evidence (the replay leg is POST and stays out by method).
  { expressPath: '/api/integration/runs', handler: 'runsList', pattern: /^\/api\/integration\/runs$/ },
  { expressPath: '/api/integration/provenance', handler: 'provenanceByRow', pattern: /^\/api\/integration\/provenance$/ },
  { expressPath: '/api/integration/dead-letters', handler: 'deadLettersList', pattern: /^\/api\/integration\/dead-letters$/ },

  // 备料 values-free project roster. `requireAccess(req, 'read')`, NOT the stock-prep vocabulary.
  // Its `/:projectNo/board` sibling is stock-prep:operate and has more segments — not matched.
  { expressPath: '/api/integration/stock-preparation/projects', handler: 'stockPreparationProjectList', pattern: /^\/api\/integration\/stock-preparation\/projects$/ },
] as const

const TOKEN_BEARER_PREFIX = 'Bearer mst_'

/** True for an `Authorization` header carrying an `mst_` open-API token. */
export function isIntegrationApiTokenBearer(authHeader: string | undefined): boolean {
  return typeof authHeader === 'string' && authHeader.startsWith(TOKEN_BEARER_PREFIX)
}

/**
 * True when `path` addresses the integration subtree the app-level token gate intercepts.
 *
 * Delegates to the SHARED policy (`auth/api-path-policy.ts`) rather than carrying its own prefix test,
 * and that is the opposite choice from the anchored route patterns above. The two answer different
 * questions and want opposite error directions:
 *
 *   - THIS one asks "does the token gate get to have an OPINION about this request?" and must therefore
 *     agree with the Express router, which is case-insensitive and trailing-slash tolerant.
 *     `apiPathHasPrefix` is exactly that test, segment-anchored, so `/api/integrations` and
 *     `/api/integration-core` are still NOT the subtree. Being WIDER here can only produce more
 *     REFUSALS: admission additionally requires a case-sensitive route pattern to match, so an
 *     uppercase `/API/INTEGRATION/PIPELINES` is recognised as the subtree and then refused 401 by the
 *     gate, instead of falling through it and depending on the global gate's ordering for its refusal.
 *   - the route patterns ask "is this EXACTLY one declared read route?", where being narrower than the
 *     router is the safe direction, so they stay anchored and case-sensitive.
 */
export function isIntegrationApiPath(path: string): boolean {
  return apiPathHasPrefix(path || '', INTEGRATION_SUBTREE)
}

/**
 * True when `(method, path)` is one of the declared read routes. Method- and path-bound; GET only.
 *
 * The subtree test is repeated here on purpose, as an AND-constraint over the table above. Nothing
 * structurally forces a row's `pattern` to agree with its `expressPath`: the lockstep tests diff the
 * `expressPath` column against the plugin's ROUTES table, so an entry whose `expressPath` is legitimate
 * but whose hand-written `pattern` names a branch OUTSIDE `/api/integration` would pass every existing
 * assertion — and the gate only intercepts the subtree (`integration-api-token-gate.ts`), so such a
 * path would be admitted by the global switch (`multitable/oapi-read-allowlist.ts:129`) with no gate
 * behind it at all. This line makes that construction impossible rather than merely unobserved. It can
 * only ever NARROW: `isIntegrationApiPath` is the wider (case-insensitive, slash-tolerant) predicate,
 * so every path the anchored patterns already match satisfies it.
 */
export function isIntegrationOapiReadPath(method: string, path: string): boolean {
  if (method !== 'GET') return false
  if (!isIntegrationApiPath(path)) return false
  return INTEGRATION_OAPI_READ_ROUTES.some((route) => route.pattern.test(path))
}

/**
 * THE switch. True only for an `mst_`-bearer GET on a declared integration read route. Fail-closed on
 * every other axis: a non-token bearer, a missing header, any non-GET method (HEAD included — Express
 * would dispatch HEAD to the GET handler, and this returns false so such a request falls back to the
 * JWT gate), and any path this list does not name.
 */
export function isIntegrationOapiReadAllowlistRequest(
  method: string,
  path: string,
  authHeader: string | undefined,
): boolean {
  if (!isIntegrationApiTokenBearer(authHeader)) return false
  return isIntegrationOapiReadPath(method, path)
}
