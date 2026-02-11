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
      get: () => ({ query })
    }
  }
})

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
}))

vi.mock('jsonwebtoken', () => jwtMocks)
vi.mock('../../src/integration/db/connection-pool', () => ({ poolManager: poolMocks.poolManager }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isAdmin,
  listUserPermissions: rbacMocks.listUserPermissions,
}))
vi.mock('../../src/security/SecretManager', () => ({
  secretManager: { get: () => 'test-secret' }
}))

import { AuthService } from '../../src/auth/AuthService'

describe('AuthService.verifyToken', () => {
  beforeEach(() => {
    jwtMocks.verify.mockReset()
    jwtMocks.sign.mockReset()
    poolMocks.query.mockReset()
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
  })

  it('sanitizes user and uses RBAC role/permissions', async () => {
    jwtMocks.verify.mockReturnValue({ userId: 'u1', email: 'admin@x', role: 'user', iat: 0, exp: 0 })
    poolMocks.query.mockResolvedValue({
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
    poolMocks.query.mockResolvedValue({
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
    poolMocks.query.mockResolvedValue({
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
})

describe('AuthService.refreshToken', () => {
  beforeEach(() => {
    jwtMocks.verify.mockReset()
    jwtMocks.sign.mockReset()
    poolMocks.query.mockReset()
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
  })

  it('refreshes token when legacy id claim is present', async () => {
    jwtMocks.verify.mockReturnValue({ id: 'u4', email: 'refresh@x', role: 'admin', iat: 0, exp: 0 })
    poolMocks.query.mockResolvedValue({
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
