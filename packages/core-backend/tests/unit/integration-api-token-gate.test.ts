/**
 * G44 — the integration open-API token gate: the TWO DOORS, and what the admitted identity may carry.
 *
 * `createIntegrationApiTokenGate` is the only thing standing between an `mst_` bearer and the plugin's
 * `/api/integration` read handlers. Its contract:
 *
 *   DOOR 1  the token itself validates AND its scope list contains `integration:read`  (401 / 403)
 *   DOOR 2  the token's CREATOR independently holds the `integration:read` RBAC code   (403)
 *   TENANT  derived server-side from the creator's membership — never from the request, never from
 *           the `x-tenant-id` header
 *   IDENTITY  exactly `permissions: ['integration:read']`; no `role`, no `roles`, so the plugin's
 *           `isAdmin` and `isTenantlessPlatformAdmin` branches stay unreachable for a token
 *
 * Every one of those is a separate refusal here, because a guard whose failure modes are untested is a
 * claim rather than a guard.
 */
import type { Request, Response } from 'express'

import { beforeEach, describe, expect, test, vi } from 'vitest'

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

  test('a throwing RBAC lookup rejects rather than admitting (fail-closed, surfaced to the error handler)', async () => {
    const h = harness()
    const gate = createIntegrationApiTokenGate({
      authenticateToken: tokenAuthAttaching(['integration:read']),
      hasRbacPermission: vi.fn(async () => {
        throw new Error('db down')
      }),
      resolveCreatorTenantId: vi.fn(async () => TENANT),
    })
    await expect(gate(h.req, h.res, h.next)).rejects.toThrow('db down')
    expect(h.next).not.toHaveBeenCalled()
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
  beforeEach(() => vi.clearAllMocks())

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
