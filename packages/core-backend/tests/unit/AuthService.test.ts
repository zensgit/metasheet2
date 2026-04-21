import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as bcrypt from 'bcryptjs'

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
  invalidateUserPerms: vi.fn(),
}))

const sessionMocks = vi.hoisted(() => ({
  isUserSessionRevoked: vi.fn(),
  createUserSession: vi.fn(),
  isUserSessionActive: vi.fn(),
}))

const secretManagerMocks = vi.hoisted(() => ({
  get: vi.fn(() => 'unit-test-secret-abcdefghijklmnopqrstuvwxyz123456'),
}))

vi.mock('jsonwebtoken', () => jwtMocks)
vi.mock('../../src/integration/db/connection-pool', () => ({ poolManager: poolMocks.poolManager }))
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
  secretManager: { get: secretManagerMocks.get }
}))

import { AuthService } from '../../src/auth/AuthService'

describe('AuthService.verifyToken', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    process.env.RBAC_TOKEN_TRUST = 'false'
    jwtMocks.verify.mockReset()
    jwtMocks.sign.mockReset()
    poolMocks.query.mockReset()
    poolMocks.query.mockResolvedValue({ rows: [] })
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.invalidateUserPerms.mockReset()
    secretManagerMocks.get.mockReset()
    secretManagerMocks.get.mockReturnValue('unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')
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
    process.env.PRODUCT_MODE = 'plm-workbench'
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

  it('backfills attendance self-service permissions for platform users without attendance roles', async () => {
    process.env.PRODUCT_MODE = 'platform'
    jwtMocks.verify.mockReturnValue({ userId: 'u5', email: 'worker@x', role: 'user', iat: 0, exp: 0 })
    poolMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u5',
          email: 'worker@x',
          name: 'Worker',
          role: 'user',
          permissions: ['spreadsheet:read', 'spreadsheet:write'],
          password_hash: 'hash',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        }]
      })
      .mockResolvedValueOnce({ rows: [] })
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockResolvedValue([])

    const auth = new AuthService()
    const user = await auth.verifyToken('platform-user-token')

    expect(user).toBeTruthy()
    expect(user?.permissions).toEqual(expect.arrayContaining(['attendance:read', 'attendance:write']))
    expect(poolMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO user_roles'),
      ['u5', 'attendance_employee'],
    )
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('u5')
  })

  it('trusts token claims and skips DB lookup when RBAC_TOKEN_TRUST is enabled', async () => {
    process.env.RBAC_TOKEN_TRUST = 'true'
    jwtMocks.verify.mockReturnValue({
      id: 'dev-admin',
      roles: ['admin'],
      perms: ['multitable:read', 'multitable:write'],
      tenantId: 'tenant_42',
      sid: 'dev-session',
      iat: 0,
      exp: 0,
    })

    const auth = new AuthService()
    const user = await auth.verifyToken('trusted-token')

    expect(user).toBeTruthy()
    expect(user?.id).toBe('dev-admin')
    expect(user?.tenantId).toBe('tenant_42')
    expect(user?.role).toBe('admin')
    expect(user?.permissions).toEqual(['multitable:read', 'multitable:write'])
    expect(poolMocks.query).not.toHaveBeenCalled()
    expect(sessionMocks.isUserSessionRevoked).not.toHaveBeenCalled()
    expect(sessionMocks.isUserSessionActive).not.toHaveBeenCalled()
  })

  it('disables trusted token fast path in production even when RBAC_TOKEN_TRUST is enabled', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PRODUCT_MODE = 'plm-workbench'
    process.env.RBAC_TOKEN_TRUST = 'true'
    jwtMocks.verify.mockReturnValue({
      id: 'prod-admin',
      roles: ['admin'],
      perms: ['multitable:read', 'multitable:write'],
      sid: 'prod-session',
      iat: 123,
      exp: 456,
    })
    poolMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'prod-admin',
        email: 'prod-admin@example.com',
        name: 'Prod Admin',
        role: 'user',
        permissions: ['multitable:read'],
        password_hash: 'hash',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      }]
    })
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['multitable:read'])

    const auth = new AuthService()
    const user = await auth.verifyToken('trusted-prod-token')

    expect(user).toBeTruthy()
    expect(user?.id).toBe('prod-admin')
    expect(user?.role).toBe('user')
    expect(user?.permissions).toEqual(['multitable:read'])
    expect(poolMocks.query).toHaveBeenCalled()
    expect(sessionMocks.isUserSessionRevoked).toHaveBeenCalledWith('prod-admin', 123)
    expect(sessionMocks.isUserSessionActive).toHaveBeenCalledWith('prod-admin', 'prod-session')
  })

  it('fails fast in production when JWT_SECRET is weak', () => {
    process.env.NODE_ENV = 'production'
    secretManagerMocks.get.mockReturnValueOnce('test')

    expect(() => new AuthService()).toThrow(/Invalid JWT_SECRET for production/)
  })
})

describe('AuthService.refreshToken', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    process.env.RBAC_TOKEN_TRUST = 'false'
    jwtMocks.verify.mockReset()
    jwtMocks.sign.mockReset()
    poolMocks.query.mockReset()
    poolMocks.query.mockResolvedValue({ rows: [] })
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.invalidateUserPerms.mockReset()
    secretManagerMocks.get.mockReset()
    secretManagerMocks.get.mockReturnValue('unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')
    sessionMocks.isUserSessionRevoked.mockReset()
    sessionMocks.isUserSessionRevoked.mockResolvedValue(false)
    sessionMocks.createUserSession.mockReset()
    sessionMocks.isUserSessionActive.mockReset()
    sessionMocks.isUserSessionActive.mockResolvedValue(true)
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

describe('AuthService.register', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    process.env.PRODUCT_MODE = 'platform'
    jwtMocks.verify.mockReset()
    jwtMocks.sign.mockReset()
    poolMocks.query.mockReset()
    poolMocks.query.mockResolvedValue({ rows: [] })
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
    secretManagerMocks.get.mockReset()
    secretManagerMocks.get.mockReturnValue('unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')
    sessionMocks.isUserSessionRevoked.mockReset()
    sessionMocks.createUserSession.mockReset()
    sessionMocks.isUserSessionActive.mockReset()
  })

  it('assigns attendance self-service permissions and role on attendance-mode registration', async () => {
    process.env.PRODUCT_MODE = 'attendance'
    poolMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'employee@example.com',
          name: 'Employee',
          role: 'user',
          permissions: [
            'spreadsheet:read',
            'spreadsheet:write',
            'spreadsheets:read',
            'spreadsheets:write',
            'attendance:read',
            'attendance:write',
          ],
          created_at: new Date('2026-04-03T00:00:00.000Z'),
          updated_at: new Date('2026-04-03T00:00:00.000Z'),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const auth = new AuthService()
    const user = await auth.register('employee@example.com', 'WelcomePass9A', 'Employee')

    expect(user).toBeTruthy()
    expect(user?.permissions).toEqual(expect.arrayContaining(['attendance:read', 'attendance:write']))
    expect(poolMocks.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO user_roles'),
      [expect.any(String), 'attendance_employee'],
    )
  })

  it('assigns attendance self-service permissions and role on platform registration', async () => {
    process.env.PRODUCT_MODE = 'platform'
    poolMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'platform@example.com',
          name: 'Platform User',
          role: 'user',
          permissions: [
            'spreadsheet:read',
            'spreadsheet:write',
            'spreadsheets:read',
            'spreadsheets:write',
            'attendance:read',
            'attendance:write',
          ],
          created_at: new Date('2026-04-03T00:00:00.000Z'),
          updated_at: new Date('2026-04-03T00:00:00.000Z'),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const auth = new AuthService()
    const user = await auth.register('platform@example.com', 'WelcomePass9A', 'Platform User')

    expect(user).toBeTruthy()
    expect(user?.permissions).toEqual(expect.arrayContaining(['attendance:read', 'attendance:write']))
    expect(poolMocks.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO user_roles'),
      [expect.any(String), 'attendance_employee'],
    )
  })
})

describe('AuthService.login', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    process.env.RBAC_TOKEN_TRUST = 'false'
    jwtMocks.verify.mockReset()
    jwtMocks.sign.mockReset()
    jwtMocks.sign.mockReturnValue('signed-login-token')
    poolMocks.query.mockReset()
    poolMocks.query.mockResolvedValue({ rows: [] })
    rbacMocks.isAdmin.mockReset()
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    sessionMocks.createUserSession.mockReset()
    sessionMocks.isUserSessionRevoked.mockReset()
    sessionMocks.isUserSessionActive.mockReset()
    secretManagerMocks.get.mockReset()
    secretManagerMocks.get.mockReturnValue('unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('logs in with a username identifier', async () => {
    const passwordHash = await bcrypt.hash('WelcomePass9A', 10)
    poolMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: null,
          username: 'liqing',
          mobile: '13900001234',
          name: '李青',
          role: 'user',
          permissions: ['attendance:read'],
          password_hash: passwordHash,
          is_active: true,
          must_change_password: false,
          created_at: new Date('2026-04-18T00:00:00.000Z'),
          updated_at: new Date('2026-04-18T00:00:00.000Z'),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    jwtMocks.verify.mockReturnValue({
      userId: 'user-1',
      email: '',
      role: 'user',
      exp: Math.floor(new Date('2026-04-19T00:00:00.000Z').getTime() / 1000),
      iat: Math.floor(new Date('2026-04-18T00:00:00.000Z').getTime() / 1000),
      sid: 'session-1',
    })

    const auth = new AuthService()
    const result = await auth.login('liqing', 'WelcomePass9A', {
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    })

    expect(result?.user.username).toBe('liqing')
    expect(result?.user.email).toBeNull()
    expect(sessionMocks.createUserSession).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        sessionId: expect.any(String),
      }),
    )
    expect(poolMocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('lower(username) = $2'),
      ['liqing', 'liqing', 'liqing'],
    )
    const loginSql = String(poolMocks.query.mock.calls[0]?.[0] ?? '')
    expect(loginSql).not.toContain('COALESCE(email')
    expect(loginSql).not.toContain('COALESCE(username')
    expect(loginSql).not.toContain('COALESCE(mobile')
  })

  it('returns null when a mobile identifier matches multiple users', async () => {
    const passwordHash = await bcrypt.hash('WelcomePass9A', 10)
    poolMocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'user-1',
          email: null,
          username: 'liqing',
          mobile: '13900001234',
          name: '李青',
          role: 'user',
          permissions: ['attendance:read'],
          password_hash: passwordHash,
          is_active: true,
          must_change_password: false,
          created_at: new Date('2026-04-18T00:00:00.000Z'),
          updated_at: new Date('2026-04-18T00:00:00.000Z'),
        },
        {
          id: 'user-2',
          email: null,
          username: 'linlan',
          mobile: '13900001234',
          name: '林岚',
          role: 'user',
          permissions: ['attendance:read'],
          password_hash: passwordHash,
          is_active: true,
          must_change_password: false,
          created_at: new Date('2026-04-18T00:00:00.000Z'),
          updated_at: new Date('2026-04-18T00:00:00.000Z'),
        },
      ],
    })

    const auth = new AuthService()
    const result = await auth.login('13900001234', 'WelcomePass9A')

    expect(result).toBeNull()
    expect(sessionMocks.createUserSession).not.toHaveBeenCalled()
  })
})

describe('AuthService.createToken', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    jwtMocks.sign.mockReset()
    jwtMocks.sign.mockReturnValue('signed-token')
    secretManagerMocks.get.mockReset()
    secretManagerMocks.get.mockReturnValue('unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('includes tenantId when present on the authenticated user', () => {
    const auth = new AuthService()

    const token = auth.createToken({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      role: 'admin',
      permissions: ['*:*'],
      tenantId: 'tenant_42',
      created_at: new Date('2026-04-11T00:00:00.000Z'),
      updated_at: new Date('2026-04-11T00:00:00.000Z'),
    })

    expect(token).toBe('signed-token')
    expect(jwtMocks.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant_42',
      }),
      expect.any(String),
      expect.any(Object),
    )
  })
})
