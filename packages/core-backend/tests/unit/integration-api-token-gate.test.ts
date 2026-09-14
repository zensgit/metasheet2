/**
 * G44 — the integration open-API token gate: the TWO DOORS, and what the admitted identity may carry.
 *
 * `createIntegrationApiTokenGate` is the only thing standing between an `mst_` bearer and the plugin's
 * `/api/integration` read handlers. Its contract:
 *
 *   DOOR 1  the token itself validates AND its scope list contains `integration:read`  (401 / 403)
 *   DOOR 1c a base/sheet-FENCED token (OAPI-4a) is refused outright on this surface   (403 OUT_OF_SCOPE)
 *   DOOR 2  the token's CREATOR independently holds the `integration:read` RBAC code   (403)
 *   TENANT  derived server-side from the creator's membership — never from the request, never from
 *           the `x-tenant-id` header
 *   IDENTITY  exactly `permissions: ['integration:read']`; no `role`, no `roles`, so the plugin's
 *           `isAdmin` and `isTenantlessPlatformAdmin` branches stay unreachable for a token
 *
 * Every one of those is a separate refusal here, because a guard whose failure modes are untested is a
 * claim rather than a guard.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Request, Response } from 'express'

import { beforeEach, describe, expect, test, vi } from 'vitest'

import { INTEGRATION_OAPI_READ_ROUTES } from '../../src/integration/oapi-integration-read-allowlist'
import { createIntegrationApiTokenGate } from '../../src/middleware/integration-api-token-gate'

const CREATOR = 'user_creator_1'
const TENANT = 'tenant_alpha'
const OTHER_TENANT = 'tenant_bravo'
const MST = 'Bearer mst_test0000000000000000'

interface Harness {
  req: Request
  res: Response
  next: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
  body: () => { ok: boolean; error?: { code: string; message: string } } | undefined
  statusCode: () => number | undefined
}

function harness(
  init: { method?: string; path?: string; authorization?: string | undefined; headers?: Record<string, string> } = {},
): Harness {
  const json = vi.fn()
  const status = vi.fn()
  const res = {
    headersSent: false,
    status: (code: number) => {
      status(code)
      ;(res as { headersSent: boolean }).headersSent = true
      return res
    },
    json: (b: unknown) => {
      json(b)
      return res
    },
  } as unknown as Response
  const req = {
    method: init.method ?? 'GET',
    path: init.path ?? '/api/integration/pipelines',
    headers: {
      ...(init.headers ?? {}),
      ...(init.authorization === undefined && !('authorization' in (init as object))
        ? { authorization: MST }
        : init.authorization !== undefined
          ? { authorization: init.authorization }
          : {}),
    },
  } as unknown as Request
  return {
    req,
    res,
    next: vi.fn(),
    status,
    json,
    body: () => json.mock.calls[0]?.[0] as never,
    statusCode: () => status.mock.calls[0]?.[0] as number | undefined,
  }
}

/** A stand-in for the real `apiTokenAuth`: attaches what a VALID token would attach. */
function tokenAuthAttaching(scopes: string[], creatorId: string = CREATOR) {
  return vi.fn(async (req: Request) => {
    req.apiTokenScopes = scopes as never
    req.apiTokenUserId = creatorId
    req.apiTokenId = 'tok_1'
    req.user = { id: creatorId, apiToken: true } as Express.Request['user']
  })
}

/**
 * The same stand-in, plus the OAPI-4a per-base/sheet whitelists the REAL `apiTokenAuth` attaches at
 * `api-token-auth.ts:76-77` (`req.apiTokenBaseIds` / `req.apiTokenSheetIds`).
 */
function tokenAuthAttachingFenced(
  scopes: string[],
  fence: { baseIds?: string[]; sheetIds?: string[] },
  creatorId: string = CREATOR,
) {
  return vi.fn(async (req: Request) => {
    req.apiTokenScopes = scopes as never
    req.apiTokenUserId = creatorId
    req.apiTokenId = 'tok_1'
    req.apiTokenBaseIds = fence.baseIds
    req.apiTokenSheetIds = fence.sheetIds
    req.user = { id: creatorId, apiToken: true } as Express.Request['user']
  })
}

describe('G44 gate — pass-through (nothing that is not an mst_ integration request is touched)', () => {
  test('a session/JWT bearer on an integration path passes straight through', async () => {
    const h = harness({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y' })
    const authenticateToken = vi.fn()
    const gate = createIntegrationApiTokenGate({ authenticateToken, hasRbacPermission: vi.fn(), resolveCreatorTenantId: vi.fn() })
    await gate(h.req, h.res, h.next)
    expect(h.next).toHaveBeenCalledTimes(1)
    expect(authenticateToken).not.toHaveBeenCalled()
    expect(h.req.user).toBeUndefined()
  })

  test('no Authorization header at all passes straight through', async () => {
    const h = harness({ authorization: undefined, headers: {} })
    delete (h.req.headers as Record<string, unknown>).authorization
    const gate = createIntegrationApiTokenGate({ authenticateToken: vi.fn(), hasRbacPermission: vi.fn(), resolveCreatorTenantId: vi.fn() })
    await gate(h.req, h.res, h.next)
    expect(h.next).toHaveBeenCalledTimes(1)
  })

  test('an mst_ token on a MULTITABLE path passes through untouched (that surface has its own guards)', async () => {
    const h = harness({ path: '/api/multitable/records' })
    const authenticateToken = vi.fn()
    const gate = createIntegrationApiTokenGate({ authenticateToken, hasRbacPermission: vi.fn(), resolveCreatorTenantId: vi.fn() })
    await gate(h.req, h.res, h.next)
    expect(h.next).toHaveBeenCalledTimes(1)
    expect(authenticateToken).not.toHaveBeenCalled()
  })

  test('a lookalike prefix is not the integration subtree', async () => {
    for (const path of ['/api/integrations/pipelines', '/api/integration-core/pipelines']) {
      const h = harness({ path })
      const authenticateToken = vi.fn()
      const gate = createIntegrationApiTokenGate({ authenticateToken, hasRbacPermission: vi.fn(), resolveCreatorTenantId: vi.fn() })
      await gate(h.req, h.res, h.next)
      expect(h.next).toHaveBeenCalledTimes(1)
      expect(authenticateToken).not.toHaveBeenCalled()
    }
  })
})

describe('G44 gate — the allowlist is enforced BEFORE the token is even looked at', () => {
  const NOT_ADMITTED: ReadonlyArray<readonly [string, string]> = [
    ['POST', '/api/integration/pipelines/p1/run'],
    ['POST', '/api/integration/pipelines/p1/dry-run'],
    ['POST', '/api/integration/table-actions/a1/apply'],
    ['POST', '/api/integration/table-actions/a1/dry-run'],
    ['DELETE', '/api/integration/external-systems/s1'],
    ['PUT', '/api/integration/table-actions/a1/conflict-policies'],
    ['GET', '/api/integration/health'],
    ['GET', '/api/integration/external-systems/s1/objects'],
    ['GET', '/api/integration/external-systems/s1/schema'],
    ['GET', '/api/integration/stock-preparation/source-preflight'],
    ['GET', '/api/integration/stock-preparation/source-binding'],
    ['GET', '/api/integration/stock-preparation/audit'],
    ['HEAD', '/api/integration/pipelines'],
    ['GET', '/API/INTEGRATION/PIPELINES'],
    ['GET', '/api/integration/pipelines/'],
    ['GET', '/api/integration/pipelines/../table-actions/a1/apply'],
  ]

  for (const [method, path] of NOT_ADMITTED) {
    test(`REFUSES 401 and never validates the token: ${method} ${path}`, async () => {
      const h = harness({ method, path })
      const authenticateToken = vi.fn()
      const hasRbacPermission = vi.fn()
      const resolveCreatorTenantId = vi.fn()
      const gate = createIntegrationApiTokenGate({ authenticateToken, hasRbacPermission, resolveCreatorTenantId })
      await gate(h.req, h.res, h.next)
      expect(h.next).not.toHaveBeenCalled()
      expect(h.statusCode()).toBe(401)
      expect(h.body()?.error?.code).toBe('UNAUTHORIZED')
      expect(authenticateToken).not.toHaveBeenCalled()
      expect(hasRbacPermission).not.toHaveBeenCalled()
      expect(resolveCreatorTenantId).not.toHaveBeenCalled()
    })
  }
})

describe('G44 gate — DOOR 1: the token and its scope', () => {
  test('a token that apiTokenAuth already 401d does not continue (no next, no RBAC lookup)', async () => {
    const h = harness()
    const authenticateToken = vi.fn(async (_req: Request, res: Response) => {
      ;(res as { headersSent: boolean }).headersSent = true
    })
    const hasRbacPermission = vi.fn()
    const gate = createIntegrationApiTokenGate({ authenticateToken, hasRbacPermission, resolveCreatorTenantId: vi.fn() })
    await gate(h.req, h.res, h.next)
    expect(h.next).not.toHaveBeenCalled()
    expect(hasRbacPermission).not.toHaveBeenCalled()
  })

  test('NO scopes attached → 401 (the gate does NOT inherit requireScope`s fail-open)', async () => {
    const h = harness()
    const gate = createIntegrationApiTokenGate({
      authenticateToken: vi.fn(async () => undefined),
      hasRbacPermission: vi.fn(),
      resolveCreatorTenantId: vi.fn(),
    })
    await gate(h.req, h.res, h.next)
    expect(h.next).not.toHaveBeenCalled()
    expect(h.statusCode()).toBe(401)
    expect(h.body()?.error?.code).toBe('INVALID_API_TOKEN')
  })

  test('scopes WITHOUT integration:read → 403 INSUFFICIENT_SCOPE, and RBAC is never consulted', async () => {
    for (const scopes of [[], ['records:read'], ['records:read', 'records:write', 'comments:read'], ['integration:write']]) {
      const h = harness()
      const hasRbacPermission = vi.fn(async () => true)
      const gate = createIntegrationApiTokenGate({
        authenticateToken: tokenAuthAttaching(scopes),
        hasRbacPermission,
        resolveCreatorTenantId: vi.fn(async () => TENANT),
      })
      await gate(h.req, h.res, h.next)
      expect(h.next).not.toHaveBeenCalled()
      expect(h.statusCode()).toBe(403)
      expect(h.body()?.error?.code).toBe('INSUFFICIENT_SCOPE')
      expect(hasRbacPermission).not.toHaveBeenCalled()
      expect(h.req.oapiAuditReason).toBe('insufficient_scope')
    }
  })

  test('a scope-denied request leaves the identity UNHYDRATED and never reaches the tenant resolver', async () => {
    const h = harness({ headers: { 'x-tenant-id': OTHER_TENANT } })
    const resolveCreatorTenantId = vi.fn(async () => TENANT)
    const gate = createIntegrationApiTokenGate({
      authenticateToken: tokenAuthAttaching(['records:read', 'comments:read']),
      hasRbacPermission: vi.fn(async () => true),
      resolveCreatorTenantId,
    })
    await gate(h.req, h.res, h.next)
    expect(h.req.user?.permissions).toBeUndefined()
    expect(h.req.user?.tenantId).toBeUndefined()
    expect(h.req.authenticatedTenantId).toBeUndefined()
    expect(resolveCreatorTenantId).not.toHaveBeenCalled()
  })

  test('a token whose creator id is missing/blank → 401', async () => {
    for (const creatorId of ['', '   ']) {
      const h = harness()
      const gate = createIntegrationApiTokenGate({
        authenticateToken: tokenAuthAttaching(['integration:read'], creatorId),
        hasRbacPermission: vi.fn(async () => true),
        resolveCreatorTenantId: vi.fn(async () => TENANT),
      })
      await gate(h.req, h.res, h.next)
      expect(h.next).not.toHaveBeenCalled()
      expect(h.statusCode()).toBe(401)
    }
  })
})

/**
 * DOOR 1c — the OAPI-4a per-base/sheet fence.
 *
 * The ratified design lock (`docs/development/multitable-oapi4-scoped-tokens-designlock-20260629.md:120-122`)
 * states the invariant absolutely: a scoped token can never act outside its `base_ids`/`sheet_ids`
 * "on any route, read or write", and scoping "only tightens". An integration route exposes no
 * base/sheet target the fence could be resolved against, so the only composition that keeps the
 * invariant is to REFUSE — admitting would turn a caller's deliberate least-privilege action into a
 * silent no-op and hand a fenced token the creator-wide integration surface.
 */
describe('G44 gate — DOOR 1c: an OAPI-4a base/sheet-FENCED token cannot use this surface at all', () => {
  const FENCES: ReadonlyArray<readonly [string, { baseIds?: string[]; sheetIds?: string[] }]> = [
    ['sheet-scoped', { sheetIds: ['sheet_only_this_one'] }],
    ['base-scoped', { baseIds: ['base_only_this_one'] }],
    ['both', { baseIds: ['base_1'], sheetIds: ['sheet_1', 'sheet_2'] }],
  ]

  for (const [label, fence] of FENCES) {
    test(`a ${label} token carrying integration:read → 403 OUT_OF_SCOPE, and RBAC is never consulted`, async () => {
      const h = harness()
      const hasRbacPermission = vi.fn(async () => true)
      const resolveCreatorTenantId = vi.fn(async () => TENANT)
      const gate = createIntegrationApiTokenGate({
        authenticateToken: tokenAuthAttachingFenced(['integration:read', 'records:read'], fence),
        hasRbacPermission,
        resolveCreatorTenantId,
      })
      await gate(h.req, h.res, h.next)
      expect(h.next).not.toHaveBeenCalled()
      expect(h.statusCode()).toBe(403)
      expect(h.body()?.error?.code).toBe('OUT_OF_SCOPE')
      expect(hasRbacPermission).not.toHaveBeenCalled()
      expect(resolveCreatorTenantId).not.toHaveBeenCalled()
    })
  }

  test('the refusal leaves the identity UNHYDRATED — no read authority is ever assembled', async () => {
    const h = harness({ headers: { 'x-tenant-id': OTHER_TENANT } })
    const gate = createIntegrationApiTokenGate({
      authenticateToken: tokenAuthAttachingFenced(['integration:read'], { sheetIds: ['s1'] }),
      hasRbacPermission: vi.fn(async () => true),
      resolveCreatorTenantId: vi.fn(async () => TENANT),
    })
    await gate(h.req, h.res, h.next)
    expect(h.req.user?.permissions).toBeUndefined()
    expect(h.req.user?.tenantId).toBeUndefined()
    expect(h.req.authenticatedTenantId).toBeUndefined()
    // the scrubbed reason matches `oapiScopeGuard`'s own (oapi-scope-guard.ts:27), so the audit
    // boundary records one vocabulary for this refusal class across both surfaces.
    expect(h.req.oapiAuditReason).toBe('out_of_base_sheet_scope')
  })

  test('the fence is refused on EVERY declared read path, not just the probe path', async () => {
    for (const path of ['/api/integration/status', '/api/integration/stock-preparation/projects', '/api/integration/hub/overview']) {
      const h = harness({ path })
      const gate = createIntegrationApiTokenGate({
        authenticateToken: tokenAuthAttachingFenced(['integration:read'], { sheetIds: ['s1'] }),
        hasRbacPermission: vi.fn(async () => true),
        resolveCreatorTenantId: vi.fn(async () => TENANT),
      })
      await gate(h.req, h.res, h.next)
      expect(h.statusCode(), `${path} must refuse a fenced token`).toBe(403)
      expect(h.body()?.error?.code).toBe('OUT_OF_SCOPE')
    }
  })

  test('an UNSCOPED token is unaffected — empty/absent whitelists are the legacy creator-wide shape', async () => {
    for (const fence of [{}, { baseIds: [], sheetIds: [] }, { baseIds: [] }, { sheetIds: [] }]) {
      const h = harness()
      const gate = createIntegrationApiTokenGate({
        authenticateToken: tokenAuthAttachingFenced(['integration:read'], fence),
        hasRbacPermission: vi.fn(async () => true),
        resolveCreatorTenantId: vi.fn(async () => TENANT),
      })
      await gate(h.req, h.res, h.next)
      expect(h.next, `${JSON.stringify(fence)} is unscoped and must still be admitted`).toHaveBeenCalledTimes(1)
      expect(h.req.user?.permissions).toEqual(['integration:read'])
    }
  })

  test('the capability-scope refusal still wins when BOTH are wrong (no reordering of DOOR 1b)', async () => {
    const h = harness()
    const gate = createIntegrationApiTokenGate({
      authenticateToken: tokenAuthAttachingFenced(['records:read'], { sheetIds: ['s1'] }),
      hasRbacPermission: vi.fn(async () => true),
      resolveCreatorTenantId: vi.fn(async () => TENANT),
    })
    await gate(h.req, h.res, h.next)
    expect(h.statusCode()).toBe(403)
    expect(h.body()?.error?.code).toBe('INSUFFICIENT_SCOPE')
  })
})

describe('G44 gate — DOOR 2: the creator`s RBAC', () => {
  test('scope present but creator lacks the integration:read permission code → 403 FORBIDDEN', async () => {
    const h = harness()
    const resolveCreatorTenantId = vi.fn(async () => TENANT)
    const gate = createIntegrationApiTokenGate({
      authenticateToken: tokenAuthAttaching(['integration:read']),
      hasRbacPermission: vi.fn(async () => false),
      resolveCreatorTenantId,
    })
    await gate(h.req, h.res, h.next)
    expect(h.next).not.toHaveBeenCalled()
    expect(h.statusCode()).toBe(403)
    expect(h.body()?.error?.code).toBe('FORBIDDEN')
    // the tenant is not even derived for a principal that failed the RBAC door
    expect(resolveCreatorTenantId).not.toHaveBeenCalled()
  })

  test('an RBAC-denied request leaves the identity UNHYDRATED (no permissions, no tenant, no verified claim)', async () => {
    const h = harness({ headers: { 'x-tenant-id': OTHER_TENANT } })
    const gate = createIntegrationApiTokenGate({
      authenticateToken: tokenAuthAttaching(['integration:read']),
      hasRbacPermission: vi.fn(async () => false),
      resolveCreatorTenantId: vi.fn(async () => TENANT),
    })
    await gate(h.req, h.res, h.next)
    // apiTokenAuth's own minimal user may still be attached; what must NOT exist is the read authority.
    expect(h.req.user?.permissions).toBeUndefined()
    expect(h.req.user?.tenantId).toBeUndefined()
    expect(h.req.authenticatedTenantId).toBeUndefined()
  })

  test('the RBAC question asked is exactly (creatorId, "integration:read")', async () => {
    const h = harness()
    const hasRbacPermission = vi.fn(async () => true)
    const gate = createIntegrationApiTokenGate({
      authenticateToken: tokenAuthAttaching(['integration:read']),
      hasRbacPermission,
      resolveCreatorTenantId: vi.fn(async () => TENANT),
    })
    await gate(h.req, h.res, h.next)
    expect(hasRbacPermission).toHaveBeenCalledTimes(1)
    expect(hasRbacPermission).toHaveBeenCalledWith(CREATOR, 'integration:read')
  })

})

/**
 * WHAT A THROWING AUTHORIZATION BACKEND MUST PRODUCE.
 *
 * The previous version of this block asserted `rejects.toThrow` under the title "surfaced to the error
 * handler". That title was FALSE for this repo's Express. Measured against `packages/core-backend`'s own
 * express 4.21.2 on node v25.9.0: an `app.use(async () => { throw })` produced `errorHandler: false`,
 * "NO RESPONSE within 1200ms (socket still open)", and a process-level `unhandledRejection: db down` —
 * Express 4's `Layer.handle_request` only catches a SYNCHRONOUS throw. (`next(err)` in the same app DID
 * reach the error handler and answered 500, which is why the gate's catch answers explicitly instead of
 * depending on an error handler being mounted.) So the assertion here is the refusal itself: 503, a
 * static message, and `next` never called.
 */
describe('G44 gate — the authorization backend itself failing', () => {
  const THROWERS: ReadonlyArray<readonly [string, () => Parameters<typeof createIntegrationApiTokenGate>[0]]> = [
    [
      'DOOR 1a — the token lookup (apiTokenAuth → validateToken → DB)',
      () => ({
        authenticateToken: vi.fn(async () => {
          throw new Error('db down')
        }),
        hasRbacPermission: vi.fn(async () => true),
        resolveCreatorTenantId: vi.fn(async () => TENANT),
      }),
    ],
    [
      'DOOR 2 — the RBAC lookup (userHasPermission rethrows every non-schema DB error)',
      () => ({
        authenticateToken: tokenAuthAttaching(['integration:read']),
        hasRbacPermission: vi.fn(async () => {
          throw new Error('db down')
        }),
        resolveCreatorTenantId: vi.fn(async () => TENANT),
      }),
    ],
    [
      'TENANT — the creator-membership resolver',
      () => ({
        authenticateToken: tokenAuthAttaching(['integration:read']),
        hasRbacPermission: vi.fn(async () => true),
        resolveCreatorTenantId: vi.fn(async () => {
          throw new Error('db down')
        }),
      }),
    ],
  ]

  for (const [label, makeDeps] of THROWERS) {
    test(`${label} → 503, no admission, and the promise does NOT reject (Express 4 would drop it)`, async () => {
      const h = harness()
      const gate = createIntegrationApiTokenGate(makeDeps())
      await expect(gate(h.req, h.res, h.next)).resolves.toBeUndefined()
      expect(h.next).not.toHaveBeenCalled()
      expect(h.statusCode()).toBe(503)
      expect(h.body()?.error?.code).toBe('AUTHZ_UNAVAILABLE')
      // the driver's own text must not be echoed to a caller that has not been authenticated
      expect(JSON.stringify(h.body())).not.toContain('db down')
      // nothing was hydrated: the failure direction is refusal, not admission
      expect(h.req.user?.permissions).toBeUndefined()
      expect(h.req.authenticatedTenantId).toBeUndefined()
    })
  }

  test('a failure AFTER the response was already written does not write a second one', async () => {
    const h = harness()
    const gate = createIntegrationApiTokenGate({
      // answer 401 like the real apiTokenAuth does for a revoked token, then throw
      authenticateToken: vi.fn(async (_req: Request, res: Response) => {
        res.status(401).json({ ok: false, error: { code: 'INVALID_API_TOKEN', message: 'revoked' } })
        throw new Error('db down')
      }),
      hasRbacPermission: vi.fn(),
      resolveCreatorTenantId: vi.fn(),
    })
    await expect(gate(h.req, h.res, h.next)).resolves.toBeUndefined()
    expect(h.next).not.toHaveBeenCalled()
    expect(h.status).toHaveBeenCalledTimes(1)
    expect(h.statusCode()).toBe(401)
  })
})

describe('G44 gate — the admitted identity', () => {
  // NOTE: the tenant is passed in a wrapper object on purpose. A plain default parameter would make
  // `admit(init, undefined)` silently fall back to TENANT, which is exactly the "no creator tenant"
  // case these tests need to exercise.
  async function admit(
    init: Parameters<typeof harness>[0] = {},
    tenantArg: { value: string | undefined } = { value: TENANT },
  ) {
    const h = harness(init)
    const resolveCreatorTenantId = vi.fn(async () => tenantArg.value)
    const gate = createIntegrationApiTokenGate({
      authenticateToken: tokenAuthAttaching(['integration:read', 'records:read']),
      hasRbacPermission: vi.fn(async () => true),
      resolveCreatorTenantId,
    })
    await gate(h.req, h.res, h.next)
    return { h, resolveCreatorTenantId }
  }

  test('admits, and carries EXACTLY one permission code — no role, no roles', async () => {
    const { h } = await admit()
    expect(h.next).toHaveBeenCalledTimes(1)
    expect(h.json).not.toHaveBeenCalled()
    expect(h.req.user?.id).toBe(CREATOR)
    expect(h.req.user?.permissions).toEqual(['integration:read'])
    expect(h.req.user?.role).toBeUndefined()
    expect(h.req.user?.roles).toBeUndefined()
    expect(h.req.user?.apiToken).toBe(true)
  })

  test('the identity cannot satisfy the plugin`s admin or tenantless-platform-admin branches', async () => {
    const { h } = await admit()
    const permissions: string[] = []
    const user = h.req.user as { permissions?: string[]; roles?: string[]; role?: string; tenantId?: string }
    if (Array.isArray(user.permissions)) permissions.push(...user.permissions)
    if (Array.isArray(user.roles)) permissions.push(...user.roles.map((r) => `role:${r}`))
    if (typeof user.role === 'string') permissions.push(`role:${user.role}`)
    // `hasPermission(user, 'read')` (http-routes.cjs:896-913) — satisfied.
    expect(permissions.includes('integration:read') || permissions.includes('integration:write')).toBe(true)
    // `isAdmin(user)` — refused.
    expect(permissions.includes('role:admin') || permissions.includes('integration:admin')).toBe(false)
    // `hasPermission(user, 'write')` and `(user, 'admin')` — refused.
    expect(permissions.includes('integration:write')).toBe(false)
    // `isTenantlessPlatformAdmin(user)` — refused (needs `role:admin`).
    expect(permissions.includes('role:admin')).toBe(false)
  })

  test('the tenant is the SERVER-derived one, and the resolver is asked ONLY for the creator id', async () => {
    const { h, resolveCreatorTenantId } = await admit()
    expect(h.req.user?.tenantId).toBe(TENANT)
    expect(h.req.authenticatedTenantId).toBe(TENANT)
    expect(resolveCreatorTenantId).toHaveBeenCalledTimes(1)
    expect(resolveCreatorTenantId).toHaveBeenCalledWith(CREATOR)
  })

  test('the x-tenant-id REQUEST HEADER is ignored — it never becomes the token`s tenant', async () => {
    const { h } = await admit({ headers: { 'x-tenant-id': OTHER_TENANT } })
    expect(h.req.user?.tenantId).toBe(TENANT)
    expect(h.req.authenticatedTenantId).toBe(TENANT)
    expect(h.req.user?.tenantId).not.toBe(OTHER_TENANT)
  })

  test('the x-tenant-id header cannot supply a tenant when the creator has none', async () => {
    const { h } = await admit({ headers: { 'x-tenant-id': OTHER_TENANT } }, { value: undefined })
    expect(h.next).toHaveBeenCalledTimes(1)
    expect(h.req.user?.tenantId).toBeUndefined()
    expect(h.req.authenticatedTenantId).toBeUndefined()
  })

  test('an ambiguous/absent creator membership yields NO tenant (the plugin then refuses every scoped read)', async () => {
    for (const tenant of [undefined, '', '   ']) {
      const { h } = await admit({}, { value: tenant })
      expect(h.next).toHaveBeenCalledTimes(1)
      expect(h.req.user?.tenantId).toBeUndefined()
      expect(h.req.authenticatedTenantId).toBeUndefined()
      // and this is exactly what `resolveTenantId` refuses on: no user tenant, and the
      // tenantless-platform-admin escape needs `role:admin`, which the identity does not carry.
      expect((h.req.user as { role?: string }).role).toBeUndefined()
    }
  })

  test('every declared read path is admitted through the gate, not just the one probe path', async () => {
    const paths = [
      '/api/integration/status',
      '/api/integration/adapters',
      '/api/integration/hub/overview',
      '/api/integration/external-systems',
      '/api/integration/external-systems/s1',
      '/api/integration/read-source-configs',
      '/api/integration/read-source-configs/c1',
      '/api/integration/read-source-configs/c1/audit',
      '/api/integration/read-source-compositions',
      '/api/integration/read-source-compositions/c1',
      '/api/integration/read-source-compositions/c1/audit',
      '/api/integration/bridge-agent-checklists/b1',
      '/api/integration/pipelines',
      '/api/integration/pipelines/p1',
      '/api/integration/table-actions',
      '/api/integration/table-actions/a1/conflict-policies',
      '/api/integration/templates',
      '/api/integration/templates/references',
      '/api/integration/templates/t1',
      '/api/integration/staging/descriptors',
      '/api/integration/runs',
      '/api/integration/provenance',
      '/api/integration/dead-letters',
      '/api/integration/stock-preparation/projects',
    ]
    expect(paths.length).toBe(24)
    for (const path of paths) {
      const { h } = await admit({ path })
      expect(h.next, `${path} should have been admitted`).toHaveBeenCalledTimes(1)
      expect(h.req.user?.permissions).toEqual(['integration:read'])
    }
  })
})

describe('G44 gate — a stale authenticatedTenantId cannot survive', () => {
  // braces on purpose: a concise body would return `VitestUtils`, which is not an Awaitable<cleanup>
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('a pre-set req.authenticatedTenantId is cleared when the creator resolves to no tenant', async () => {
    const h = harness()
    ;(h.req as { authenticatedTenantId?: string }).authenticatedTenantId = OTHER_TENANT
    const gate = createIntegrationApiTokenGate({
      authenticateToken: tokenAuthAttaching(['integration:read']),
      hasRbacPermission: vi.fn(async () => true),
      resolveCreatorTenantId: vi.fn(async () => undefined),
    })
    await gate(h.req, h.res, h.next)
    expect(h.next).toHaveBeenCalledTimes(1)
    expect(h.req.authenticatedTenantId).toBeUndefined()
  })

  test('a pre-set req.user is fully replaced, not merged', async () => {
    const h = harness()
    h.req.user = { id: 'someone_else', role: 'admin', permissions: ['*:*'], tenantId: OTHER_TENANT } as Express.Request['user']
    const gate = createIntegrationApiTokenGate({
      authenticateToken: tokenAuthAttaching(['integration:read']),
      hasRbacPermission: vi.fn(async () => true),
      resolveCreatorTenantId: vi.fn(async () => TENANT),
    })
    await gate(h.req, h.res, h.next)
    expect(h.req.user?.id).toBe(CREATOR)
    expect(h.req.user?.role).toBeUndefined()
    expect(h.req.user?.permissions).toEqual(['integration:read'])
    expect(h.req.user?.tenantId).toBe(TENANT)
  })
})

/**
 * THE MOUNT ORDER — the load-bearing assumption nobody had pinned.
 *
 * Everything above calls `createIntegrationApiTokenGate()` directly, so all of it stays green even if
 * the gate is never reached by a real request. The gate only protects anything because of a runtime
 * ordering fact: it is mounted app-level inside `setupMiddleware()` (run from the CONSTRUCTOR), while
 * every `/api/integration` route is registered later, when the plugin loader runs inside `start()`.
 * Express dispatches layers in registration order, so the gate wins. Move plugin loading earlier, or
 * move the mount later, and the whole subtree is silently unguarded with every other test still green.
 *
 * Two halves, because either alone proves nothing:
 *   A. the Express semantics, on a REAL express app built from the 24 declared paths;
 *   B. the wiring in `src/index.ts` that puts this repo on the right side of those semantics.
 */
describe('G44 gate — the MOUNT-ORDER assumption the whole design rests on', () => {
  // ---- A. Express semantics, measured, not assumed -------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildApp(order: 'gate-first' | 'routes-first'): { app: any; gate: unknown; reached: string[] } {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express')
    const app = express()
    const reached: string[] = []
    const gate = createIntegrationApiTokenGate({
      // a stand-in for a token `apiTokenAuth` could not authenticate → the gate answers its own 401
      authenticateToken: vi.fn(async () => undefined),
      hasRbacPermission: vi.fn(async () => true),
      resolveCreatorTenantId: vi.fn(async () => TENANT),
    })
    const mountRoutes = () => {
      for (const route of INTEGRATION_OAPI_READ_ROUTES) {
        app.get(route.expressPath, (_req: unknown, res: { json: (b: unknown) => void }) => {
          reached.push(route.handler)
          res.json({ handler: route.handler })
        })
      }
    }
    if (order === 'gate-first') {
      app.use(gate)
      mountRoutes()
    } else {
      mountRoutes()
      app.use(gate)
    }
    return { app, gate, reached }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stackIndexes(app: any, gate: unknown): { gate: number; firstIntegrationRoute: number } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack: any[] = app._router.stack
    const gateIndex = stack.findIndex((layer) => layer.handle === gate)
    const routeIndex = stack.findIndex(
      (layer) => layer.route && String(layer.route.path).startsWith('/api/integration'),
    )
    return { gate: gateIndex, firstIntegrationRoute: routeIndex }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function get(app: any, path: string): Promise<{ status: number; body: string }> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require('node:http')
    const server = await new Promise<{ address: () => { port: number }; close: (cb: () => void) => void }>(
      (resolve) => {
        const s = app.listen(0, () => resolve(s))
      },
    )
    try {
      return await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: server.address().port,
            path,
            method: 'GET',
            headers: { authorization: MST },
          },
          (res: { statusCode: number; on: (e: string, cb: (c?: unknown) => void) => void }) => {
            let body = ''
            res.on('data', (c) => (body += String(c)))
            res.on('end', () => resolve({ status: res.statusCode, body }))
          },
        )
        req.on('error', reject)
        req.end()
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  test('mounted app-level FIRST, the gate precedes EVERY /api/integration layer in the real router stack', () => {
    const { app, gate } = buildApp('gate-first')
    const idx = stackIndexes(app, gate)
    expect(idx.gate).toBeGreaterThanOrEqual(0)
    expect(idx.firstIntegrationRoute).toBeGreaterThanOrEqual(0)
    expect(idx.gate).toBeLessThan(idx.firstIntegrationRoute)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack: any[] = app._router.stack
    const routeIndexes = stack
      .map((layer, i) => (layer.route && String(layer.route.path).startsWith('/api/integration') ? i : -1))
      .filter((i) => i >= 0)
    expect(routeIndexes.length).toBe(INTEGRATION_OAPI_READ_ROUTES.length)
    expect(routeIndexes.every((i) => i > idx.gate)).toBe(true)
  })

  test('and it really intercepts: the route handler never runs, the caller gets the gate 401', async () => {
    const { app, reached } = buildApp('gate-first')
    const res = await get(app, '/api/integration/pipelines')
    expect(res.status).toBe(401)
    expect(JSON.parse(res.body).error.code).toBe('INVALID_API_TOKEN')
    expect(reached).toEqual([])
  })

  test('CONTROL — the same layers in the other order let the handler run (so the two above are not vacuous)', async () => {
    const { app, gate } = buildApp('routes-first')
    expect(stackIndexes(app, gate).gate).toBeGreaterThan(stackIndexes(app, gate).firstIntegrationRoute)
    const { app: app2, reached } = buildApp('routes-first')
    const res = await get(app2, '/api/integration/pipelines')
    expect(res.status).toBe(200)
    expect(reached).toEqual(['pipelinesList'])
  })

  // ---- B. the wiring in src/index.ts that puts this repo on the right side of A ---------------
  describe('src/index.ts wiring', () => {
    const SOURCE = readFileSync(join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8')
    const LINES = SOURCE.split(/\r?\n/)
    const MOUNT = 'this.app.use(createIntegrationApiTokenGate())'

    /**
     * A line that RUNS. Commenting a call out must read as "removed", not as "still present" — the
     * first version of this guard matched raw text and a `// this.app.use(...)` mutation stayed green.
     * (Block-comment interiors are covered by the leading `*` form this file uses throughout.)
     */
    const isCode = (line: string): boolean => !/^\s*(\/\/|\*\/?|\/\*)/.test(line)

    /** Body of a 2-space-indented class member, from its opening line to the first `  }`. */
    function memberBody(openRe: RegExp): { lines: string[]; start: number; end: number } {
      const start = LINES.findIndex((l) => openRe.test(l))
      expect(start, `no class member matched ${openRe}`).toBeGreaterThanOrEqual(0)
      let end = start + 1
      while (end < LINES.length && LINES[end] !== '  }') end += 1
      expect(end, `unterminated member for ${openRe}`).toBeLessThan(LINES.length)
      return { lines: LINES.slice(start + 1, end), start: start + 1, end: end + 1 }
    }

    const ctor = memberBody(/^ {2}constructor\(options: MetaSheetServerOptions/)
    const setup = memberBody(/^ {2}private setupMiddleware\(\): void \{/)
    const startFn = memberBody(/^ {2}async start\(\): Promise<void> \{/)

    test('the scan is not vacuous — all three member bodies were really found', () => {
      expect(LINES.length).toBeGreaterThan(4000)
      expect(ctor.lines.length).toBeGreaterThan(10)
      expect(setup.lines.length).toBeGreaterThan(100)
      expect(startFn.lines.length).toBeGreaterThan(100)
    })

    test('the gate is mounted app-level EXACTLY once, and inside setupMiddleware()', () => {
      const at = LINES.map((l, i) => (isCode(l) && l.includes(MOUNT) ? i + 1 : -1)).filter((i) => i > 0)
      expect(at.length).toBe(1)
      expect(at[0]).toBeGreaterThan(setup.start)
      expect(at[0]).toBeLessThan(setup.end)
    })

    test('setupMiddleware() runs from the CONSTRUCTOR, so the mount happens at construction time', () => {
      expect(ctor.lines.some((l) => isCode(l) && l.includes('this.setupMiddleware()'))).toBe(true)
    })

    test('nothing can register a route before that: the constructor loads no plugin and mounts no route', () => {
      const ctorText = ctor.lines.filter(isCode).join('\n')
      expect(ctorText).not.toContain('loadPlugins')
      expect(ctorText).not.toContain('registerPluginRoute')
      expect(ctorText).not.toMatch(/this\.app\[/)
      expect(ctorText).not.toMatch(/this\.app(?:\.\w+|\[[^\]]*\])\s*\(\s*['"`]\/api\/integration/)
    })

    test('plugin loading lives in start(), which cannot run before the constructor has finished', () => {
      const loads = LINES.map((l, i) =>
        isCode(l) && /this\.pluginLoader\.loadPlugins\(\)/.test(l) ? i + 1 : -1,
      ).filter((i) => i > 0)
      expect(loads.length).toBe(1)
      expect(loads[0]).toBeGreaterThan(startFn.start)
      expect(loads[0]).toBeLessThan(startFn.end)
    })

    test('setupMiddleware() registers no /api/integration route ahead of the gate either', () => {
      const mountAt = setup.lines.findIndex((l) => isCode(l) && l.includes(MOUNT))
      expect(mountAt).toBeGreaterThanOrEqual(0)
      // comment lines are stripped: the block directly above the mount TALKS about /api/integration,
      // and this assertion is about REGISTRATIONS, not prose.
      const before = setup.lines.slice(0, mountAt).filter(isCode).join('\n')
      // any router registration keyed on the subtree, in any of the forms this file uses
      expect(before).not.toMatch(/this\.app(?:\.\w+|\[[^\]]*\])\s*\(\s*['"`]\/api\/integration/)
      expect(before).not.toContain('loadPlugins')
      expect(before).not.toContain('registerPluginRoute')
    })
  })
})

/**
 * THE SEAMS MUST NOT BE STUBS IN PRODUCTION.
 *
 * Every behavioural test above injects `authenticateToken`, so none of them exercises the real
 * `apiTokenAuth`. That matters for one specific guarantee the review asked about: "can a DEACTIVATED
 * creator's token still read?" The answer is no, and the reason lives entirely inside the real
 * `apiTokenAuth` → `ApiTokenService.validateToken`, which fail-closes on the creator's account state
 * BEFORE RBAC is ever consulted (api-token-service.ts:248-267 → auth/user-activation.ts:77, pinned by
 * tests/unit/api-token-webhook.test.ts:241 'validateToken fails when creator is inactive'; the tenant
 * leg independently re-checks `u.is_active = true`, AuthService.ts:401/414).
 *
 * This block does not re-prove that chain — it pins the one link the G44 suite could otherwise lose
 * silently: that the gate's defaults are the real implementations and not a double. It is a wiring
 * assertion, not an end-to-end one; the end-to-end leg is still unrun (see the verification doc).
 */
describe('G44 gate — the default seams are the real implementations', () => {
  const GATE_SRC = readFileSync(
    join(__dirname, '..', '..', 'src', 'middleware', 'integration-api-token-gate.ts'),
    'utf8',
  )
  const SERVICE_SRC = readFileSync(
    join(__dirname, '..', '..', 'src', 'multitable', 'api-token-service.ts'),
    'utf8',
  )

  test('all three seams default to the production implementation', () => {
    expect(GATE_SRC).toMatch(/deps\.authenticateToken\s*\?\?\s*runApiTokenAuth/)
    expect(GATE_SRC).toMatch(/return apiTokenAuth\(req, res, \(\) => undefined\)/)
    expect(GATE_SRC).toMatch(/deps\.hasRbacPermission\s*\?\?\s*userHasPermission/)
    expect(GATE_SRC).toMatch(/authService\.resolveSessionTenantId\(userId\)/)
  })

  test('and the real token validation still fail-closes on the creator account state', () => {
    // if this moves, the "a deactivated creator's token cannot read" claim loses its basis
    expect(SERVICE_SRC).toContain('evaluateUserAuthenticationGate')
    expect(SERVICE_SRC).toContain("return { valid: false, reason: 'Token creator not found' }")
  })
})
