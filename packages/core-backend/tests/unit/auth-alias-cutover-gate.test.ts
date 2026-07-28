import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jwtMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  sign: vi.fn(),
}))

const poolMocks = vi.hoisted(() => {
  const query = vi.fn()
  return {
    query,
    poolManager: {
      get: () => ({ query, getInternalPool: () => null }),
    },
  }
})

const aliasMocks = vi.hoisted(() => ({
  assertAliasCutoverAllowed: vi.fn(),
  findUserIdByLoginAlias: vi.fn(),
  isAuthLoginAliasCutoverEnabled: vi.fn(),
}))

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
vi.mock('../../src/auth/login-alias-service', () => ({
  assertAliasCutoverAllowed: aliasMocks.assertAliasCutoverAllowed,
  findUserIdByLoginAlias: aliasMocks.findUserIdByLoginAlias,
  isAuthLoginAliasCutoverEnabled: aliasMocks.isAuthLoginAliasCutoverEnabled,
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
  secretManager: { get: secretManagerMocks.get },
}))

import { AuthService } from '../../src/auth/AuthService'
import * as bcrypt from 'bcryptjs'

/**
 * Load-bearing: deleting assertAliasCutoverAllowed from getUserByIdentifier must red this suite.
 */
describe('AuthService alias cutover gate (T2b execution path)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    process.env.RBAC_TOKEN_TRUST = 'false'
    jwtMocks.verify.mockReset()
    jwtMocks.sign.mockReset()
    jwtMocks.sign.mockReturnValue('token')
    poolMocks.query.mockReset()
    aliasMocks.assertAliasCutoverAllowed.mockReset()
    aliasMocks.findUserIdByLoginAlias.mockReset()
    aliasMocks.isAuthLoginAliasCutoverEnabled.mockReset()
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    rbacMocks.isAdmin.mockResolvedValue(false)
    sessionMocks.createUserSession.mockReset()
    secretManagerMocks.get.mockReturnValue('unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')
  })

  afterEach(() => {
    delete process.env.AUTH_LOGIN_USE_ALIASES
  })

  it('calls assertAliasCutoverAllowed before alias lookup when cutover env is on', async () => {
    aliasMocks.isAuthLoginAliasCutoverEnabled.mockReturnValue(true)
    aliasMocks.assertAliasCutoverAllowed.mockResolvedValue(undefined)
    aliasMocks.findUserIdByLoginAlias.mockResolvedValue('u1')
    const passwordHash = await bcrypt.hash('WelcomePass9A', 10)
    poolMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u1',
        email: 'a@x.com',
        username: null,
        mobile: null,
        name: 'A',
        role: 'user',
        permissions: [],
        password_hash: passwordHash,
        is_active: true,
        must_change_password: false,
        activation_status: 'activated',
        local_password_set: true,
        created_at: new Date(),
        updated_at: new Date(),
      }],
    })
    jwtMocks.verify.mockReturnValue({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sid: 's1',
    })

    const auth = new AuthService()
    const result = await auth.login('a@x.com', 'WelcomePass9A')
    expect(result).toBeTruthy()
    expect(aliasMocks.assertAliasCutoverAllowed).toHaveBeenCalled()
    expect(aliasMocks.findUserIdByLoginAlias).toHaveBeenCalledWith('a@x.com')
    // Gate before lookup order
    const gateOrder = aliasMocks.assertAliasCutoverAllowed.mock.invocationCallOrder[0]
    const lookupOrder = aliasMocks.findUserIdByLoginAlias.mock.invocationCallOrder[0]
    expect(gateOrder).toBeLessThan(lookupOrder)
  })

  it('does not enter alias path when cutover env is off', async () => {
    aliasMocks.isAuthLoginAliasCutoverEnabled.mockReturnValue(false)
    const passwordHash = await bcrypt.hash('WelcomePass9A', 10)
    poolMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u1',
        email: 'a@x.com',
        username: null,
        mobile: null,
        name: 'A',
        role: 'user',
        permissions: [],
        password_hash: passwordHash,
        is_active: true,
        must_change_password: false,
        activation_status: 'activated',
        local_password_set: true,
        created_at: new Date(),
        updated_at: new Date(),
      }],
    })
    jwtMocks.verify.mockReturnValue({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sid: 's1',
    })

    const auth = new AuthService()
    await auth.login('a@x.com', 'WelcomePass9A')
    expect(aliasMocks.assertAliasCutoverAllowed).not.toHaveBeenCalled()
    expect(aliasMocks.findUserIdByLoginAlias).not.toHaveBeenCalled()
  })

  it('fails login when assertAliasCutoverAllowed throws (mutation: removing gate call would green)', async () => {
    aliasMocks.isAuthLoginAliasCutoverEnabled.mockReturnValue(true)
    const err = Object.assign(new Error('blocked'), { code: 'ALIAS_CUTOVER_BLOCKED' })
    aliasMocks.assertAliasCutoverAllowed.mockRejectedValue(err)

    const auth = new AuthService()
    await expect(auth.login('a@x.com', 'WelcomePass9A')).rejects.toMatchObject({
      code: 'ALIAS_CUTOVER_BLOCKED',
    })
    expect(aliasMocks.findUserIdByLoginAlias).not.toHaveBeenCalled()
  })
})
