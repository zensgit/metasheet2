/**
 * G44 — THE integration (data-factory) open-API token gate.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * On the multitable surface each token-reachable route mounts its own `apiTokenAuth` + `requireScope`
 * pair. The integration surface cannot do that: its routes are registered by a plugin
 * (`plugins/plugin-integration-core/lib/http-routes.cjs`) through `context.api.http.addRoute`, and that
 * file is provenance-pinned — there is no host-owned router on which to mount a per-route guard. So the
 * guard is mounted ONCE, app-level, on the whole `/api/integration` subtree, immediately after the
 * global JWT gate in `index.ts`. That placement is load-bearing in both directions:
 *   - it runs AFTER the global gate, so every request it sees has already been classified by
 *     `isOapiAllowlistRequest`; and
 *   - it runs BEFORE `correlationContextEnrichmentMiddleware` and the tenant-ALS middleware, so the
 *     identity it builds is the identity every downstream layer (logs, `tenantContext`, the plugin's
 *     own `requireAccess` / `resolveTenantId`) sees.
 *
 * THE TWO DOORS AN `mst_` TOKEN MUST PASS, AND WHY NEITHER IS SKIPPABLE
 * --------------------------------------------------------------------
 * DOOR 1 — THE TOKEN'S OWN SCOPE. `apiTokenAuth` validates the token (revoked/expired/unknown → 401)
 * and attaches `req.apiTokenScopes`. This gate then requires `integration:read` to be present. It does
 * NOT delegate that to `requireScope`: `requireScope` FAIL-OPENS when `req.apiTokenScopes` is absent
 * (`api-token-auth.ts:96-99`), which is safe on a per-route mount reached only by token traffic but is
 * not safe on a subtree middleware that also sees session traffic. The check here is explicit and
 * fail-CLOSED: no scopes attached on an `mst_` bearer → 401, scopes attached without the one we need
 * → 403.
 *
 * DOOR 2 — THE CREATOR'S RBAC. A token carries no permissions of its own. `apiTokenAuth` sets
 * `req.user = { id: <creator>, apiToken: true }` with NO `permissions`, NO `role`, NO `tenantId`
 * (`api-token-auth.ts:80-83`), which means the plugin's `hasPermission` would see an empty permission
 * list and `requireAccess(req, 'read')` would 403 EVERY token — correct, but it would also make the
 * scope useless. So this gate asks the database whether the token's CREATOR independently holds the
 * `integration:read` permission code, using the same `userHasPermission` the `rbacGuard` falls back to
 * (`rbac/rbac.ts:100`). That function already composes namespace admission
 * (`rbac/service.ts:39-41`), so an `integration:read` grant on a deployment whose `integration`
 * namespace is not admitted is refused here exactly as it is refused for a session user. It also
 * returns `false` when there is no pool, so a DB-less process denies rather than admits.
 *
 * The effective authority is therefore min(token scope, creator RBAC) — the same composition
 * `comments.ts` gets from `requireScope` ∘ `rbacGuard` — and the answer to "what if the creator does
 * not hold `integration:read` in RBAC?" is 403, not admission. `tests/unit/integration-api-token-gate.test.ts`
 * pins that case.
 *
 * WHAT THE HYDRATED IDENTITY MAY AND MAY NOT CONTAIN
 * -------------------------------------------------
 * The identity handed downstream is deliberately the NARROWEST one that can satisfy the read tier:
 *
 *   `permissions: ['integration:read']` — exactly the one code, never the creator's full permission
 *   set. Consequences that are the point rather than a side effect:
 *     - the plugin's `isAdmin(user)` is false (it looks for `role:admin` / `integration:admin`), so a
 *       token minted by a platform admin cannot reach an admin-tier behaviour. Concretely,
 *       `deadLettersList` only returns unredacted payloads for `isAdmin` callers
 *       (http-routes.cjs:9677), so a token always gets the redacted rows;
 *     - `isTenantlessPlatformAdmin(user)` is false, so `resolveTenantId`'s cross-tenant branch — the
 *       one that honours a request-supplied `?tenantId=` — is UNREACHABLE for a token. A token is
 *       confined to one tenant even when its creator is not.
 *
 *   NO `role`, NO `roles`. Both would re-open the two branches above.
 *
 *   `tenantId` — derived SERVER-SIDE from the creator's active org membership via
 *   `authService.resolveSessionTenantId(creatorId)` with NO requested tenant, i.e. the same resolution
 *   the creator's own login performs (`AuthService.ts:387-425`). That function returns a tenant only
 *   when the user has EXACTLY ONE active membership and the user row is active; ambiguity or an
 *   inactive user yields `undefined`, and then every tenant-scoped integration route refuses with the
 *   plugin's own `TENANT_CONTEXT_REQUIRED` (http-routes.cjs:1039-1041) because `user.tenantId` is
 *   empty and the tenantless-platform-admin branch is unreachable. Only the four tenant-free catalog
 *   reads keep working.
 *
 *   The `x-tenant-id` REQUEST HEADER IS NEVER CONSULTED. `jwt-middleware.ts:107-109` copies that
 *   header onto `user.tenantId` when a verified token carries no tenant claim — the hole the
 *   stock-prep operator scope was built around. This gate does not run that middleware and does not
 *   reproduce it: a token's tenant has exactly one source, the creator's membership rows.
 *   `req.authenticatedTenantId` is set from the SAME derived value, so the plugin's
 *   `assertVerifiedTenantClaim` sees a claim that is verified in the only sense that matters here —
 *   it came from the server, not from the caller.
 *
 * BLAST RADIUS
 * ------------
 * A request that is an `mst_` bearer on an `/api/integration` path this gate does not admit is refused
 * 401 here rather than being passed along. That is belt-and-braces (the global gate already sends such
 * a request to `jwtAuthMiddleware`, which 401s an `mst_` string), and it means the subtree has one
 * refusal point that a future change to the global gate's ordering cannot silently remove.
 */
import type { Request, RequestHandler, Response } from 'express'

import { authService } from '../auth/AuthService'
import {
  INTEGRATION_OAPI_READ_PERMISSION,
  INTEGRATION_OAPI_READ_SCOPE,
  isIntegrationApiPath,
  isIntegrationApiTokenBearer,
  isIntegrationOapiReadAllowlistRequest,
} from '../integration/oapi-integration-read-allowlist'
import { userHasPermission } from '../rbac/service'
import { apiTokenAuth } from './api-token-auth'

/**
 * Seams, injected only by tests. Production wiring uses the real `apiTokenAuth`, the real RBAC
 * lookup and the real session-tenant resolver — a test double must never be reachable from a request.
 */
export interface IntegrationApiTokenGateDeps {
  /** Validates the `mst_` token and attaches `apiTokenScopes` / `apiTokenUserId` / `user`. */
  authenticateToken?: (req: Request, res: Response) => Promise<void>
  /** DB-backed RBAC check for the token CREATOR (namespace admission included). */
  hasRbacPermission?: (userId: string, permissionCode: string) => Promise<boolean>
  /** Server-side tenant derivation for the token CREATOR. No request input, ever. */
  resolveCreatorTenantId?: (userId: string) => Promise<string | undefined>
}

function deny(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ ok: false, error: { code, message } })
}

/**
 * Runs the existing `apiTokenAuth` middleware to completion. It is `async` and resolves only after it
 * has either answered 401 itself or attached the token context and called its `next` — so awaiting the
 * returned promise is the whole of the handshake, and the no-op `next` below never continues a chain.
 */
function runApiTokenAuth(req: Request, res: Response): Promise<void> {
  return apiTokenAuth(req, res, () => undefined)
}

export function createIntegrationApiTokenGate(deps: IntegrationApiTokenGateDeps = {}): RequestHandler {
  const authenticateToken = deps.authenticateToken ?? runApiTokenAuth
  const hasRbacPermission = deps.hasRbacPermission ?? userHasPermission
  const resolveCreatorTenantId =
    deps.resolveCreatorTenantId ?? ((userId: string) => authService.resolveSessionTenantId(userId))

  return async (req, res, next) => {
    const authHeader = req.headers.authorization
    // Session/JWT traffic and every non-`mst_` bearer is untouched by this gate.
    if (!isIntegrationApiTokenBearer(authHeader)) return next()
    // A token on any other surface is the multitable allowlist's business, not this gate's.
    if (!isIntegrationApiPath(req.path)) return next()

    // Fail-closed on the subtree: an `mst_` bearer may only attempt the declared read routes.
    if (!isIntegrationOapiReadAllowlistRequest(req.method, req.path, authHeader)) {
      return deny(
        res,
        401,
        'UNAUTHORIZED',
        'API tokens may only call the declared integration read routes',
      )
    }

    // DOOR 1a — the token itself must validate. `apiTokenAuth` answers 401 on its own for a revoked /
    // expired / unknown token; if it did, we must not continue.
    await authenticateToken(req, res)
    if (res.headersSent) return

    // DOOR 1b — the scope. Explicit and fail-closed; `requireScope`'s fail-open is not relied on.
    const scopes = req.apiTokenScopes
    if (!Array.isArray(scopes)) {
      return deny(res, 401, 'INVALID_API_TOKEN', 'API token could not be authenticated')
    }
    if (!scopes.includes(INTEGRATION_OAPI_READ_SCOPE)) {
      req.oapiAuditReason = 'insufficient_scope'
      return deny(res, 403, 'INSUFFICIENT_SCOPE', `Required scope: ${INTEGRATION_OAPI_READ_SCOPE}`)
    }

    const creatorId = typeof req.apiTokenUserId === 'string' ? req.apiTokenUserId.trim() : ''
    if (!creatorId) {
      return deny(res, 401, 'INVALID_API_TOKEN', 'API token could not be authenticated')
    }

    // DOOR 2 — the creator's own RBAC. A scope is a capability the creator DELEGATED; it can never
    // exceed what the creator holds. No permission code (or no DB) → refuse.
    const permitted = await hasRbacPermission(creatorId, INTEGRATION_OAPI_READ_PERMISSION)
    if (!permitted) {
      return deny(res, 403, 'FORBIDDEN', 'Insufficient integration permissions')
    }

    // Tenant: derived from the creator's membership, never from the request or the `x-tenant-id`
    // header. `undefined` is a legitimate outcome and leaves every tenant-scoped route refusing.
    const derivedTenantId = await resolveCreatorTenantId(creatorId)
    const tenantId = typeof derivedTenantId === 'string' && derivedTenantId.trim().length > 0
      ? derivedTenantId.trim()
      : undefined

    // The narrowest identity that satisfies the read tier: one permission code, no role, no roles.
    req.user = {
      id: creatorId,
      apiToken: true,
      permissions: [INTEGRATION_OAPI_READ_PERMISSION],
      ...(tenantId ? { tenantId } : {}),
    } as Express.Request['user']
    if (tenantId) req.authenticatedTenantId = tenantId
    else delete req.authenticatedTenantId

    return next()
  }
}
