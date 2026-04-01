import { beforeEach, describe, expect, it, vi } from 'vitest'

const jwtMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  sign: vi.fn(),
}))

const poolMocks = vi.hoisted(() => {
  const query = vi.fn()
  return {
    query,
    poolManager: {
      get: () => ({ query, getInternalPool: () => null })
    }
  }
})

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
}))

const sessionMocks = vi.hoisted(() => ({
  isUserSessionRevoked: vi.fn(),
  createUserSession: vi.fn(),
  isUserSessionActive: vi.fn(),
}))

vi.mock('jsonwebtoken', () => jwtMocks)
vi.mock('../../src/integration/db/connection-pool', () => ({ poolManager: poolMocks.poolManager }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isAdmin,
  listUserPermissions: rbacMocks.listUserPermissions,
}))
vi.mock('../../src/auth/session-revocation', () => ({
  isUserSessionRevoked: sessionMocks.isUserSessionRevoked,
}))
vi.mock('../../src/auth/session-registry', () => ({
  createUserSession: sessionMocks.createUserSession,
  isUserSessionActive: sessionMocks.isUserSessionActive,
}))
vi.mock('../../src/security/SecretManager', () => ({
  secretManager: { get: () => 'test-secret' }
}))

import { AuthService } from '../../src/auth/AuthService'

describe('AuthService.verifyToken', () => {
  beforeEach(() => {
    process.env.RBAC_TOKEN_TRUST = 'false'
    jwtMocks.verify.mockReset()
    jwtMocks.sign.mockReset()
    poolMocks.query.mockReset()
    poolMocks.query.mockResolvedValue({ rows: [] })
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
    sessionMocks.isUserSessionRevoked.mockReset()
    sessionMocks.isUserSessionRevoked.mockResolvedValue(false)
    sessionMocks.createUserSession.mockReset()
    sessionMocks.isUserSessionActive.mockReset()
    sessionMocks.isUserSessionActive.mockResolvedValue(true)
  })

  it('sanitizes user and uses RBAC role/permissions', async () => {
    jwtMocks.verify.mockReturnValue({ userId: 'u1', email: 'admin@x', role: 'user', iat: 0, exp: 0 })
    poolMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u1',
        email: 'admin@x',
        name: 'Admin',
        role: 'user',
        permissions: ['spreadsheets:read'],
        password_hash: 'hash',
        created_at: new Date(),
        updated_at: new Date(),
      }]
    })
    rbacMocks.isAdmin.mockResolvedValue(true)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:admin', 'spreadsheets:read'])

    const auth = new AuthService()
    const user = await auth.verifyToken('token')

    expect(user).toBeTruthy()
    expect(user?.role).toBe('admin')
    expect(user?.permissions).toContain('attendance:admin')
    expect((user as any).password_hash).toBeUndefined()
  })

  it('falls back to stored role/permissions when RBAC lookup fails', async () => {
    jwtMocks.verify.mockReturnValue({ userId: 'u2', email: 'user@x', role: 'user', iat: 0, exp: 0 })
    poolMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u2',
        email: 'user@x',
        name: 'User',
        role: 'user',
        permissions: ['spreadsheets:write'],
        password_hash: 'hash',
        created_at: new Date(),
        updated_at: new Date(),
      }]
    })
    rbacMocks.isAdmin.mockRejectedValue(new Error('rbac down'))
    rbacMocks.listUserPermissions.mockRejectedValue(new Error('rbac down'))

    const auth = new AuthService()
    const user = await auth.verifyToken('token')

    expect(user).toBeTruthy()
    expect(user?.role).toBe('user')
    expect(user?.permissions).toEqual(['spreadsheets:write'])
    expect((user as any).password_hash).toBeUndefined()
  })

  it('accepts legacy id claim when userId is missing', async () => {
    jwtMocks.verify.mockReturnValue({ id: 'u3', email: 'legacy@x', role: 'user', iat: 0, exp: 0 })
    poolMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u3',
        email: 'legacy@x',
        name: 'Legacy',
        role: 'user',
        permissions: ['attendance:read'],
        password_hash: 'hash',
        created_at: new Date(),
        updated_at: new Date(),
      }]
    })
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])

    const auth = new AuthService()
    const user = await auth.verifyToken('legacy-token')

    expect(user).toBeTruthy()
    expect(user?.id).toBe('u3')
    expect(user?.permissions).toContain('attendance:read')
  })

  it('trusts token claims and skips DB lookup when RBAC_TOKEN_TRUST is enabled', async () => {
    process.env.RBAC_TOKEN_TRUST = 'true'
    jwtMocks.verify.mockReturnValue({
      id: 'dev-admin',
      roles: ['admin'],
      perms: ['multitable:read', 'multitable:write'],
      sid: 'dev-session',
      iat: 0,
      exp: 0,
    })

    const auth = new AuthService()
    const user = await auth.verifyToken('trusted-token')

    expect(user).toBeTruthy()
    expect(user?.id).toBe('dev-admin')
    expect(user?.role).toBe('admin')
    expect(user?.permissions).toEqual(['multitable:read', 'multitable:write'])
    expect(poolMocks.query).not.toHaveBeenCalled()
    expect(sessionMocks.isUserSessionRevoked).not.toHaveBeenCalled()
    expect(sessionMocks.isUserSessionActive).not.toHaveBeenCalled()
  })
})

describe('AuthService.refreshToken', () => {
  beforeEach(() => {
    jwtMocks.verify.mockReset()
    jwtMocks.sign.mockReset()
    poolMocks.query.mockReset()
    poolMocks.query.mockResolvedValue({ rows: [] })
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
  })

  it('refreshes token when legacy id claim is present', async () => {
    jwtMocks.verify.mockReturnValue({ id: 'u4', email: 'refresh@x', role: 'admin', iat: 0, exp: 0 })
    poolMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u4',
        email: 'refresh@x',
        name: 'Refresh User',
        role: 'admin',
        permissions: ['attendance:admin'],
        password_hash: 'hash',
        created_at: new Date(),
        updated_at: new Date(),
      }]
    })
    rbacMocks.isAdmin.mockResolvedValue(true)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:admin'])
    jwtMocks.sign.mockReturnValue('new-token')

    const auth = new AuthService()
    const refreshed = await auth.refreshToken('old-token')

    expect(refreshed).toBe('new-token')
    expect(jwtMocks.sign).toHaveBeenCalledTimes(1)
    expect(jwtMocks.sign.mock.calls[0]?.[0]).toMatchObject({ userId: 'u4' })
  })
})
