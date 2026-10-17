import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const SECRET = vi.hoisted(() => 'unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')

const poolMocks = vi.hoisted(() => ({ query: vi.fn() }))
const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  invalidateUserPerms: vi.fn(),
}))
const sessionMocks = vi.hoisted(() => ({
  isUserSessionRevoked: vi.fn(),
  createUserSession: vi.fn(),
  isUserSessionActive: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      query: poolMocks.query,
      getInternalPool: () => null,
    }),
  },
}))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isAdmin,
  listUserPermissions: rbacMocks.listUserPermissions,
  invalidateUserPerms: rbacMocks.invalidateUserPerms,
}))
vi.mock('../../src/auth/session-revocation', () => ({
  isUserSessionRevoked: sessionMocks.isUserSessionRevoked,
}))
vi.mock('../../src/auth/session-registry', () => ({
  createUserSession: sessionMocks.createUserSession,
  isUserSessionActive: sessionMocks.isUserSessionActive,
}))
vi.mock('../../src/security/SecretManager', () => ({
  secretManager: { get: () => SECRET },
}))

import { AuthService } from '../../src/auth/AuthService'
import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { readVerifiedTenantClaim } from '../../src/auth/verified-tenant-claim'
import { createPlmPersonalBomWriteBindingsRouter } from '../../src/routes/plm-personal-bom-write-bindings'

const pinned = usePinnedServer()
const list = vi.fn(async () => [])
let queries: string[] = []
let membership: 'hit' | 'miss' | 'skip' = 'hit'

function userRow() {
  return {
    id: 'owner-1',
    email: 'o@x',
    name: 'Owner',
    role: 'user',
    permissions: ['attendance:read'],
    password_hash: 'hash',
    is_active: true,
    activation_status: 'activated',
    local_password_set: true,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  return jwt.sign(payload, secret, { expiresIn: '1h' })
}

describe('signed JWT tenant provenance', () => {
  const app = express()
  app.use(express.json())
  app.get('/probe', jwtAuthMiddleware, (req, res) => {
    res.json({
      claim: req.verifiedTenantClaim ?? null,
      authenticatedTenantId: req.authenticatedTenantId ?? null,
      userTenantId: req.user?.tenantId ?? null,
      onUser: readVerifiedTenantClaim(req.user ?? null),
    })
  })
  app.use('/api/me/plm-bom-write-bindings', createPlmPersonalBomWriteBindingsRouter({
    list,
    bind: vi.fn(),
    unbind: vi.fn(),
    managementUrl: vi.fn(),
    retryRetiredRevocations: vi.fn(),
  } as never))

  const priorNode = process.env.NODE_ENV
  const priorTrust = process.env.RBAC_TOKEN_TRUST

  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    process.env.RBAC_TOKEN_TRUST = 'false'
    queries = []
    membership = 'hit'
    list.mockClear()
    poolMocks.query.mockReset()
    poolMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push(String(sql))
      if (String(sql).includes('FROM users')) return { rows: [userRow()], rowCount: 1 }
      if (String(sql).includes('FROM user_orgs')) {
        if (membership === 'skip') throw new Error('user_orgs was queried')
        if (membership === 'miss') return { rows: [], rowCount: 0 }
        return { rows: [{ org_id: params?.[1] }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    rbacMocks.isAdmin.mockReset()
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    sessionMocks.isUserSessionRevoked.mockReset()
    sessionMocks.isUserSessionRevoked.mockResolvedValue(false)
    sessionMocks.isUserSessionActive.mockReset()
    sessionMocks.isUserSessionActive.mockResolvedValue(true)
    pinned.setApp(app)
  })

  afterEach(() => {
    if (priorNode === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = priorNode
    if (priorTrust === undefined) delete process.env.RBAC_TOKEN_TRUST
    else process.env.RBAC_TOKEN_TRUST = priorTrust
  })

  it('keeps an active verified claim and ignores a forged tenant header', async () => {
    const token = sign({ userId: 'owner-1', email: 'o@x', role: 'user', tenantId: 'tenant-a' })
    const verified = await new AuthService().verifyToken(token)
    expect(readVerifiedTenantClaim(verified)).toEqual({ kind: 'present', value: 'tenant-a' })
    expect(JSON.stringify(verified)).not.toContain('"kind"')
    expect(Object.keys(verified ?? {})).not.toContain('verifiedTenantClaim')

    const probe = await request(pinned.url()).get('/probe').set('Authorization', `Bearer ${token}`).set('x-tenant-id', 'forged-header')
    expect(probe.status).toBe(200)
    expect(probe.body).toEqual({
      claim: { kind: 'present', value: 'tenant-a' },
      authenticatedTenantId: 'tenant-a',
      userTenantId: 'tenant-a',
      onUser: null,
    })
    const listed = await request(pinned.url())
      .get('/api/me/plm-bom-write-bindings')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'forged-header')
    expect(listed.status).toBe(200)
    expect(listed.headers['cache-control']).toBe('no-store')
    expect(list).toHaveBeenCalledWith({ userId: 'owner-1', metaTenantId: 'tenant-a' })
    expect(queries.some((sql) => sql.includes('FROM user_orgs'))).toBe(true)
  })

  it('treats a missing claim as absent legacy and does not adopt the forged header as the Meta tenant', async () => {
    membership = 'skip'
    const token = sign({ userId: 'owner-1', email: 'o@x', role: 'user' })
    const probe = await request(pinned.url()).get('/probe').set('Authorization', `Bearer ${token}`).set('x-tenant-id', 'forged-header')
    expect(probe.status).toBe(200)
    expect(probe.body).toEqual({
      claim: { kind: 'absent' },
      authenticatedTenantId: null,
      userTenantId: 'forged-header',
      onUser: null,
    })
    const listed = await request(pinned.url())
      .get('/api/me/plm-bom-write-bindings')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'forged-header')
    expect(listed.status).toBe(200)
    expect(list).toHaveBeenCalledWith({ userId: 'owner-1', metaTenantId: null })
    expect(queries.some((sql) => sql.includes('FROM user_orgs'))).toBe(false)
  })

  it('keeps a rejected membership claim rejected when a forged header is present', async () => {
    membership = 'miss'
    const token = sign({ userId: 'owner-1', email: 'o@x', role: 'user', tenantId: 'forged-tenant' })
    const probe = await request(pinned.url()).get('/probe').set('Authorization', `Bearer ${token}`).set('x-tenant-id', 'forged-header')
    expect(probe.body).toEqual({
      claim: { kind: 'rejected' },
      authenticatedTenantId: null,
      userTenantId: 'forged-header',
      onUser: null,
    })
    const listed = await request(pinned.url())
      .get('/api/me/plm-bom-write-bindings')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'forged-header')
    expect(listed.status).toBe(403)
    expect(listed.body).toEqual({ ok: false, error: { code: 'PLM_BOM_WRITE_FORBIDDEN' } })
    expect(list).not.toHaveBeenCalled()
    expect(queries.some((sql) => sql.includes('FROM user_orgs'))).toBe(true)
  })

  it.each([
    ['blank', '   '],
    ['malformed', 12],
  ] as const)('does not downgrade a %s claim to absent', async (kind, tenantId) => {
    membership = 'skip'
    const token = sign({ userId: 'owner-1', email: 'o@x', role: 'user', tenantId })
    const probe = await request(pinned.url()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(probe.body.claim).toEqual({ kind })
    expect(probe.body.authenticatedTenantId).toBeNull()
    const listed = await request(pinned.url()).get('/api/me/plm-bom-write-bindings').set('Authorization', `Bearer ${token}`)
    expect(listed.status).toBe(403)
    expect(listed.body.error.code).toBe('PLM_BOM_WRITE_FORBIDDEN')
    expect(list).not.toHaveBeenCalled()
    expect(queries.some((sql) => sql.includes('FROM user_orgs'))).toBe(false)
  })

  it.each([
    ['absent', undefined],
    ['blank', '   '],
    ['malformed', 12],
    ['malformed', null],
  ] as const)('trust-claims mode preserves %s provenance before header fallback', async (kind, tenantId) => {
    process.env.RBAC_TOKEN_TRUST = 'true'
    membership = 'skip'
    const token = sign({
      userId: 'owner-1', email: 'o@x', role: 'user',
      roles: ['user'], perms: ['attendance:read'],
      ...(tenantId === undefined ? {} : { tenantId }),
    })
    const probe = await request(pinned.url()).get('/probe')
      .set('Authorization', `Bearer ${token}`).set('x-tenant-id', 'forged-header')
    expect(probe.status).toBe(200)
    expect(probe.body.claim).toEqual({ kind })
    expect(probe.body.authenticatedTenantId).toBeNull()
    const listed = await request(pinned.url()).get('/api/me/plm-bom-write-bindings')
      .set('Authorization', `Bearer ${token}`).set('x-tenant-id', 'forged-header')
    if (kind === 'absent') {
      expect(listed.status).toBe(200)
      expect(list).toHaveBeenCalledWith({ userId: 'owner-1', metaTenantId: null })
    } else {
      expect(listed.status).toBe(403)
      expect(listed.body.error.code).toBe('PLM_BOM_WRITE_FORBIDDEN')
      expect(list).not.toHaveBeenCalled()
    }
    // Empty queries prove this exercised the trusted early return, not the normal DB path.
    expect(queries).toEqual([])
  })

  it('trust-claims mode still carries the verified tenant and does not query users', async () => {
    process.env.RBAC_TOKEN_TRUST = 'true'
    const token = sign({
      userId: 'owner-1',
      email: 'o@x',
      role: 'user',
      roles: ['user'],
      perms: ['attendance:read'],
      tenantId: 'tenant-trust',
    })
    const probe = await request(pinned.url()).get('/probe').set('Authorization', `Bearer ${token}`).set('x-tenant-id', 'forged-header')
    expect(probe.body).toEqual({
      claim: { kind: 'present', value: 'tenant-trust' },
      authenticatedTenantId: 'tenant-trust',
      userTenantId: 'tenant-trust',
      onUser: null,
    })
    const listed = await request(pinned.url()).get('/api/me/plm-bom-write-bindings').set('Authorization', `Bearer ${token}`)
    expect(listed.status).toBe(200)
    expect(list).toHaveBeenCalledWith({ userId: 'owner-1', metaTenantId: 'tenant-trust' })
    expect(queries).toEqual([])
  })

  it('does not accept a tenant from a token signed with the wrong secret', async () => {
    const token = sign(
      { userId: 'owner-1', email: 'o@x', role: 'user', tenantId: 'should-not-stick' },
      'other-secret-not-the-runtime-secret-xxxx',
    )
    const probe = await request(pinned.url()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(probe.status).toBe(401)
    expect(JSON.stringify(probe.body)).not.toContain('should-not-stick')
    expect(list).not.toHaveBeenCalled()
  })

  it('rejects a purpose token and an API token before list', async () => {
    const purpose = sign({ userId: 'owner-1', email: 'o@x', role: 'user', tenantId: 'tenant-a', aud: 'api' })
    const purposeRes = await request(pinned.url()).get('/api/me/plm-bom-write-bindings').set('Authorization', `Bearer ${purpose}`)
    expect(purposeRes.status).toBe(401)
    expect(purposeRes.headers['cache-control']).toBe('no-store')
    const apiRes = await request(pinned.url()).get('/api/me/plm-bom-write-bindings').set('Authorization', 'Bearer mst_not-a-login')
    expect(apiRes.status).toBe(401)
    expect(apiRes.headers['cache-control']).toBe('no-store')
    expect(list).not.toHaveBeenCalled()
  })
})
