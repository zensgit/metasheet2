import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bcrypt from 'bcryptjs'
import { createRequire } from 'node:module'
import * as nodePath from 'node:path'

const jwtMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  sign: vi.fn(),
}))

const poolMocks = vi.hoisted(() => {
  const query = vi.fn()
  // AuthService.createUser uses pool.transaction so alias claim + users insert roll back together.
  const transaction = vi.fn(async (handler: (client: { query: typeof query }) => Promise<unknown>) =>
    handler({ query }),
  )
  return {
    query,
    transaction,
    poolManager: {
      get: () => ({ query, transaction, getInternalPool: () => null })
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

import { AuthService, USER_ROLE_ASSIGNMENT_RETRY_LIMIT, UserRoleAssignmentRecoveryBusyError, authService } from '../../src/auth/AuthService'
import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { createTenantPrincipalDirectoryBoundaryV1 } from '../../src/services/tenant-principal-directory-boundary'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import { censusFile } from './lib/recovery-census-recorder'

// O2-D1 recovery-conflict census: auth/AuthService.ts classifies the 40001 marker with
// `isRecoveryAuthorityBusyError` at TWO call sites (AuthService.ts:499, the register
// transaction retry; AuthService.ts:870, the self-service backfill retry). Both were
// already covered by the discriminating tests below — they were simply never linked to a
// census site, which is why the DISCOVERY guard in recovery-conflict-census.test.ts found
// this file outside the census denominator. The file-level afterAll installed here
// asserts the EXECUTED site set equals this file's registered set exactly.
const census = censusFile('AuthService.test.ts')

function recoveryAuthorityBusyError(): Error & { code: string } {
  const error = new Error(RECOVERY_AUTHORITY_BUSY_MARKER) as Error & { code: string }
  error.code = '40001'
  return error
}

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

  it('lists organization choices using only active memberships and an active authenticated actor', async () => {
    poolMocks.query.mockResolvedValueOnce({ rows: [{ org_id: 'org-a' }, { org_id: 'org-b' }] })
    const auth = new AuthService()
    expect(await auth.listActiveMembershipOrgIds('actor')).toEqual(['org-a', 'org-b'])
    const [sql, values] = poolMocks.query.mock.calls[0]
    expect(sql).toContain('uo.user_id = $1')
    expect(sql).toContain('uo.is_active = true')
    expect(sql).toContain('u.is_active = true')
    expect(values).toEqual(['actor'])
  })

  it('does not turn failed membership lookup into a successful empty organization list', async () => {
    poolMocks.query.mockRejectedValueOnce(new Error('synthetic failure'))
    await expect(new AuthService().listActiveMembershipOrgIds('actor')).rejects.toThrow('synthetic failure')
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
        is_active: true,
        activation_status: 'activated',
        local_password_set: true,
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

  // P23: resolveRbacProfile's attendance self-service backfill calls the SAME assignUserRoles
  // that register() uses. It is reached on every authenticated read for a user missing
  // attendance:* permissions, and it is NOT itself inside a try in the source — so a persistently
  // busy recovery lease must be contained locally rather than failing the whole token verification
  // (that would turn "recovery is busy" into "you are logged out" for a valid session), AND the
  // unpersisted attendance:read/attendance:write permissions must not leak into the returned user.
  it('[recovery-census:auth-service:self-service-backfill] omits unpersisted attendance self-service permissions when backfill role assignment cannot persist under a busy recovery lease', async () => {
    jwtMocks.verify.mockReturnValue({ userId: 'u-backfill', email: 'backfill@x', role: 'user', iat: 0, exp: 0 })
    poolMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u-backfill',
        email: 'backfill@x',
        name: 'Backfill',
        role: 'user',
        permissions: [],
        password_hash: 'hash',
        is_active: true,
        activation_status: 'activated',
        local_password_set: true,
        created_at: new Date(),
        updated_at: new Date(),
      }],
    })
    let userRolesAttempts = 0
    poolMocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('INSERT INTO user_roles')) {
        userRolesAttempts++
        throw recoveryAuthorityBusyError()
      }
      return { rows: [] }
    })
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['spreadsheets:read'])

    const auth = new AuthService()
    const user = await auth.verifyToken('token')

    // The read path itself must still succeed — a busy backfill is a degraded enhancement,
    // not a reason to reject an otherwise-valid session.
    expect(user).toBeTruthy()
    expect(user?.permissions).not.toContain('attendance:read')
    expect(user?.permissions).not.toContain('attendance:write')
    expect(userRolesAttempts).toBe(USER_ROLE_ASSIGNMENT_RETRY_LIMIT)
    expect(rbacMocks.invalidateUserPerms).not.toHaveBeenCalled()
    census.record('auth-service:self-service-backfill')
  })

  it('preserves a verified token tenant only while active membership proves it', async () => {
    jwtMocks.verify.mockReturnValue({
      userId: 'u-tenant',
      email: 'tenant@x',
      role: 'user',
      tenantId: 'tenant_42',
      iat: 0,
      exp: 0,
    })
    poolMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u-tenant',
          email: 'tenant@x',
          name: 'Tenant User',
          role: 'user',
          permissions: ['attendance:read'],
          password_hash: 'hash',
          is_active: true,
          activation_status: 'activated',
          local_password_set: true,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      })
      .mockResolvedValueOnce({ rows: [{ org_id: 'tenant_42' }] })
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])

    const auth = new AuthService()
    const user = await auth.verifyToken('tenant-token')

    expect(user?.tenantId).toBe('tenant_42')
    expect((user as any).password_hash).toBeUndefined()
  })

  it('drops a signed legacy tenant claim when active membership does not prove it', async () => {
    jwtMocks.verify.mockReturnValue({
      userId: 'u-legacy',
      email: 'legacy@x',
      role: 'user',
      tenantId: 'forged-tenant',
      iat: 0,
      exp: 0,
    })
    poolMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u-legacy',
          email: 'legacy@x',
          name: 'Legacy User',
          role: 'user',
          permissions: ['attendance:read'],
          password_hash: 'hash',
          is_active: true,
          activation_status: 'activated',
          local_password_set: true,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])

    const auth = new AuthService()
    const user = await auth.verifyToken('legacy-forged-tenant-token')

    expect(user).toBeTruthy()
    expect(user?.tenantId).toBeUndefined()
    expect(poolMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('uo.org_id = $2'),
      ['u-legacy', 'forged-tenant'],
    )
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
        is_active: true,
        activation_status: 'activated',
        local_password_set: true,
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
        is_active: true,
        activation_status: 'activated',
        local_password_set: true,
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
          activation_status: 'activated',
          local_password_set: true,
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
    // The write now goes through the single role-assignment boundary, which takes a user-id
    // ARRAY (one statement covers the single- and batch-caller shapes). Same table, same user,
    // same role id — the assertion tracks the parameter shape, not a changed behaviour.
    expect(poolMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO user_roles'),
      [['u5'], 'attendance_employee'],
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
        activation_status: 'activated',
        local_password_set: true,
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
        is_active: true,
        activation_status: 'activated',
        local_password_set: true,
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
    poolMocks.transaction.mockReset()
    poolMocks.transaction.mockImplementation(
      async (handler: (client: { query: typeof poolMocks.query }) => Promise<unknown>) =>
        handler({ query: poolMocks.query }),
    )
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
    secretManagerMocks.get.mockReset()
    secretManagerMocks.get.mockReturnValue('unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')
    sessionMocks.isUserSessionRevoked.mockReset()
    sessionMocks.createUserSession.mockReset()
    sessionMocks.isUserSessionActive.mockReset()
  })

  function mockRegisterQueries(opts: {
    id: string
    email: string
    name: string
    permissions: string[]
  }) {
    let createdId = opts.id
    poolMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('FROM users') && text.includes('lower(email)')) {
        return { rows: [] }
      }
      if (text.includes('INSERT INTO users')) {
        createdId = String(params?.[0] ?? opts.id)
        return {
          rows: [{
            id: createdId,
            email: opts.email,
            name: opts.name,
            role: 'user',
            permissions: opts.permissions,
            created_at: new Date('2026-04-03T00:00:00.000Z'),
            updated_at: new Date('2026-04-03T00:00:00.000Z'),
          }],
        }
      }
      // claimLoginAlias: INSERT alias then SELECT owner
      if (text.includes('INSERT INTO user_login_aliases')) return { rows: [] }
      if (text.includes('SELECT user_id FROM user_login_aliases')) {
        return { rows: [{ user_id: createdId }] }
      }
      if (text.includes('INSERT INTO user_permissions')) return { rows: [] }
      if (text.includes('INSERT INTO user_roles')) return { rows: [] }
      return { rows: [] }
    })
  }

  it('assigns attendance self-service permissions and role on attendance-mode registration', async () => {
    process.env.PRODUCT_MODE = 'attendance'
    mockRegisterQueries({
      id: 'user-1',
      email: 'employee@example.com',
      name: 'Employee',
      permissions: [
        'spreadsheet:read',
        'spreadsheet:write',
        'spreadsheets:read',
        'spreadsheets:write',
        'attendance:read',
        'attendance:write',
      ],
    })
    const auth = new AuthService()
    const user = await auth.register('employee@example.com', 'WelcomePass9A', 'Employee')

    expect(user).toBeTruthy()
    expect(user?.permissions).toEqual(expect.arrayContaining(['attendance:read', 'attendance:write']))
    expect(poolMocks.transaction).toHaveBeenCalled()
    expect(poolMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO user_login_aliases'))).toBe(true)
    expect(poolMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO user_roles'))).toBe(true)
  })

  it('assigns attendance self-service permissions and role on platform registration', async () => {
    process.env.PRODUCT_MODE = 'platform'
    mockRegisterQueries({
      id: 'user-2',
      email: 'platform@example.com',
      name: 'Platform User',
      permissions: [
        'spreadsheet:read',
        'spreadsheet:write',
        'spreadsheets:read',
        'spreadsheets:write',
        'attendance:read',
        'attendance:write',
      ],
    })

    const auth = new AuthService()
    const user = await auth.register('platform@example.com', 'WelcomePass9A', 'Platform User')

    expect(user).toBeTruthy()
    expect(user?.permissions).toEqual(expect.arrayContaining(['attendance:read', 'attendance:write']))
    expect(poolMocks.transaction).toHaveBeenCalled()
    expect(poolMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO user_login_aliases'))).toBe(true)
    expect(poolMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO user_roles'))).toBe(true)
  })

  // P23: user_roles is a recovery-authority table. While exact-anchor recovery holds its
  // per-subject lease, a user_roles write fails fast with 40001 (RECOVERY_AUTHORITY_BUSY_MARKER).
  // Before this slice, assignUserRoles caught EVERY error (including this one) and only warned —
  // register() would then return the created user as a "success" with the role silently missing.
  // Assert the opposite now: a persistently-busy lease must NOT resolve register() to a truthy
  // user with no role assigned. It must propagate a retryable, named failure instead.
  it('[recovery-census:auth-service:register-user-roles] does not report a successful registration when the self-service role cannot persist under a busy recovery lease', async () => {
    process.env.PRODUCT_MODE = 'attendance'
    let userRolesAttempts = 0
    let createdId = 'user-busy'
    poolMocks.query.mockReset()
    poolMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('FROM users') && text.includes('lower(email)')) {
        return { rows: [] }
      }
      if (text.includes('INSERT INTO users')) {
        createdId = String(params?.[0] ?? createdId)
        return {
          rows: [{
            id: createdId,
            email: 'busy@example.com',
            name: 'Busy',
            role: 'user',
            permissions: [],
            created_at: new Date('2026-04-03T00:00:00.000Z'),
            updated_at: new Date('2026-04-03T00:00:00.000Z'),
          }],
        }
      }
      // claimLoginAlias: INSERT alias then SELECT owner — the SELECT must echo back the SAME
      // userId that was just inserted (createdId), matching the real login-alias-service
      // ownership check, or the alias claim looks conflicted and createUser rolls back to null
      // BEFORE assignUserRoles is ever reached — silently invalidating this test.
      if (text.includes('INSERT INTO user_login_aliases')) return { rows: [] }
      if (text.includes('SELECT user_id FROM user_login_aliases')) return { rows: [{ user_id: createdId }] }
      if (text.includes('INSERT INTO user_permissions')) return { rows: [] }
      if (text.includes('INSERT INTO user_roles')) {
        userRolesAttempts++
        throw recoveryAuthorityBusyError()
      }
      return { rows: [] }
    })

    const auth = new AuthService()
    await expect(
      auth.register('busy@example.com', 'WelcomePass9A', 'Busy'),
    ).rejects.toBeInstanceOf(UserRoleAssignmentRecoveryBusyError)

    // Bounded: exactly the configured retry limit worth of attempts, never unbounded and never
    // a single silent try. O2-S1 made the retry unit the WHOLE transaction, so each attempt
    // re-runs the users insert too — one user_roles attempt per transaction attempt.
    expect(userRolesAttempts).toBe(USER_ROLE_ASSIGNMENT_RETRY_LIMIT)
    expect(poolMocks.transaction).toHaveBeenCalledTimes(USER_ROLE_ASSIGNMENT_RETRY_LIMIT)
    // The users insert ran inside every attempted transaction (each rolled back on the real
    // pool — zero residue is proven by the real-DB suite,
    // tests/integration/auth-register-atomicity.db.test.ts).
    expect(poolMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO users'))).toBe(true)
    census.record('auth-service:register-user-roles')
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
          activation_status: 'activated',
          local_password_set: true,
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
          activation_status: 'activated',
          local_password_set: true,
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
          activation_status: 'activated',
          local_password_set: true,
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

  it('returns null when one identifier matches different users across account fields', async () => {
    const passwordHash = await bcrypt.hash('WelcomePass9A', 10)
    poolMocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'user-1',
          email: 'shared@example.com',
          username: 'liqing',
          mobile: '13900001234',
          name: '李青',
          role: 'user',
          permissions: ['attendance:read'],
          password_hash: passwordHash,
          activation_status: 'activated',
          local_password_set: true,
          is_active: true,
          must_change_password: false,
          created_at: new Date('2026-04-18T00:00:00.000Z'),
          updated_at: new Date('2026-04-18T00:00:00.000Z'),
        },
        {
          id: 'user-2',
          email: null,
          username: 'shared@example.com',
          mobile: '13900004567',
          name: '林岚',
          role: 'user',
          permissions: ['attendance:read'],
          password_hash: passwordHash,
          activation_status: 'activated',
          local_password_set: true,
          is_active: true,
          must_change_password: false,
          created_at: new Date('2026-04-18T00:00:00.000Z'),
          updated_at: new Date('2026-04-18T00:00:00.000Z'),
        },
      ],
    })

    const auth = new AuthService()
    const result = await auth.login('shared@example.com', 'WelcomePass9A')

    expect(result).toBeNull()
    expect(sessionMocks.createUserSession).not.toHaveBeenCalled()
  })
})

describe('AuthService.resolveSessionTenantId', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    poolMocks.query.mockReset()
    secretManagerMocks.get.mockReset()
    secretManagerMocks.get.mockReturnValue('unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('uses one active organization when the login request has no tenant hint', async () => {
    poolMocks.query.mockResolvedValue({ rows: [{ org_id: 'tenant_42' }] })

    const auth = new AuthService()
    await expect(auth.resolveSessionTenantId('user-1')).resolves.toBe('tenant_42')
    expect(poolMocks.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT 2'), ['user-1'])
  })

  it('fails closed when a user has multiple active organizations and no tenant hint', async () => {
    poolMocks.query.mockResolvedValue({ rows: [{ org_id: 'tenant_a' }, { org_id: 'tenant_b' }] })

    const auth = new AuthService()
    await expect(auth.resolveSessionTenantId('user-1')).resolves.toBeUndefined()
  })

  it('accepts a requested organization only when active membership proves it', async () => {
    poolMocks.query
      .mockResolvedValueOnce({ rows: [{ org_id: 'tenant_42' }] })
      .mockResolvedValueOnce({ rows: [] })

    const auth = new AuthService()
    await expect(auth.resolveSessionTenantId('user-1', 'tenant_42')).resolves.toBe('tenant_42')
    await expect(auth.resolveSessionTenantId('user-1', 'tenant_other')).resolves.toBeUndefined()
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

// ---------------------------------------------------------------------------------------------
// THE REAL SIGN-IN CHAIN, INTO THE STOCK-PREP SOURCE PREFLIGHT (PR #6151 review, follow-up 7).
//
// Every other suite that exercises the plugin route sets `req.authenticatedTenantId` by hand. That
// is the one input whose ORIGIN decides who is admitted, so it is driven here through the real
// code instead: AuthService.login (real bcrypt, real jsonwebtoken sign) -> the token -> the real
// jwtAuthMiddleware (real verifyToken, which re-resolves the claim against user_orgs) -> the real
// plugin handler, whose tenant proof asks the REAL host directory boundary
// (tenant-principal-directory-boundary.ts). The users/user_orgs tables are a fake pool that answers
// the exact statements those three pieces issue, so the claim, the re-check and the directory all
// read ONE membership table. The source side (registry, adapter) is a fake; the binding store is the
// plugin's real one over an in-memory db. Synthetic tenants, accounts and project numbers only.
// ---------------------------------------------------------------------------------------------
describe('AuthService tenant claim -> jwtAuthMiddleware -> stock-prep source preflight (the real sign-in chain)', () => {
  const PASSWORD = 'Chain-Passw0rd-6151'
  const TENANT_A = 'tenant-a'
  const TENANT_B = 'tenant-b'
  const BOUND_SOURCE = 'sys_chain_bound'
  const SAMPLE = 'P-TEST-001'
  const ROUTE = '/api/integration/stock-preparation/source-preflight'

  type ChainAccount = { id: string; username: string; perms: string[] }
  const ACCOUNTS: ChainAccount[] = [
    { id: 'u_chain_owner', username: 'chainowner', perms: ['integration:read'] },
    { id: 'u_chain_none', username: 'chainnone', perms: ['integration:read'] },
    { id: 'u_chain_two', username: 'chaintwo', perms: ['integration:read'] },
  ]
  let passwordHash = ''
  let memberships: Array<{ userId: string; orgId: string; active: boolean }> = []

  const account = (id: unknown) => ACCOUNTS.find((entry) => entry.id === id)
  const activeOrgs = (userId: unknown) => memberships
    .filter((row) => row.userId === userId && row.active)
    .map((row) => row.orgId)
    .sort()

  // The statements AuthService (login / verifyToken / resolveSessionTenantId) and the host directory
  // boundary issue, answered from ONE membership table. Anything else answers no rows.
  async function chainQuery(sqlText: string, params: unknown[] = []) {
    const sql = String(sqlText).replace(/\s+/g, ' ').trim()
    const userRow = (entry: ChainAccount) => ({
      id: entry.id,
      email: `${entry.username}@example.invalid`,
      username: entry.username,
      mobile: null,
      name: entry.username,
      role: 'user',
      permissions: [],
      password_hash: passwordHash,
      is_active: true,
      must_change_password: false,
      activation_status: 'activated',
      local_password_set: true,
      created_at: new Date(0),
      updated_at: new Date(0),
    })
    if (/FROM users WHERE lower\(email\) = \$1/.test(sql)) {
      const identifier = String(params[0])
      return { rows: ACCOUNTS.filter((entry) => entry.username === identifier || `${entry.username}@example.invalid` === identifier).map(userRow) }
    }
    if (/FROM users WHERE id = \$1/.test(sql)) {
      const found = account(params[0])
      return { rows: found ? [userRow(found)] : [] }
    }
    if (/FROM user_orgs uo JOIN users u .* AND uo\.org_id = \$2/.test(sql)) {
      return { rows: activeOrgs(params[0]).includes(String(params[1])) ? [{ org_id: String(params[1]) }] : [] }
    }
    if (/FROM user_orgs uo JOIN users u .* ORDER BY uo\.org_id ASC LIMIT 2/.test(sql)) {
      return { rows: activeOrgs(params[0]).slice(0, 2).map((org_id) => ({ org_id })) }
    }
    if (sql === 'SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE LIMIT 1') {
      return { rows: activeOrgs(params[0]).includes(String(params[1])) ? [{ '?column?': 1 }] : [] }
    }
    return { rows: [] }
  }

  // ---- the plugin half -------------------------------------------------------------------------
  const requireCjs = createRequire(import.meta.url)
  const PLUGIN_LIB = nodePath.resolve(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib')
  type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>
  type BindingStore = { set(input: Record<string, unknown>): Promise<unknown>; get(scope: Record<string, unknown>): Promise<unknown> }
  // The CommonJS plugin modules this block drives, typed to the members it uses.
  let plugin: {
    routes: { registerIntegrationRoutes(input: Record<string, unknown>): void }
    bindingStore: { createStockPreparationSourceBindingStore(input: Record<string, unknown>): BindingStore }
    preflight: { SOURCE_PREFLIGHT_ROUTE_PATH: string }
    tableActions: { PLM_STOCK_PREPARATION_ACTION_ID: string }
  }

  beforeAll(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 4)
    plugin = {
      routes: requireCjs(nodePath.join(PLUGIN_LIB, 'http-routes.cjs')),
      bindingStore: requireCjs(nodePath.join(PLUGIN_LIB, 'stock-preparation-source-binding-store.cjs')),
      preflight: requireCjs(nodePath.join(PLUGIN_LIB, 'stock-preparation-source-preflight.cjs')),
      tableActions: requireCjs(nodePath.join(PLUGIN_LIB, 'stock-preparation-table-actions.cjs')),
    }
    expect(plugin.preflight.SOURCE_PREFLIGHT_ROUTE_PATH).toBe(ROUTE)
  })

  function inert(methods: string[]) {
    return Object.fromEntries(methods.map((method) => [method, async () => { throw new Error(`unexpected service call: ${method}`) }]))
  }

  function fakePluginDb() {
    const rows: Array<Record<string, unknown>> = []
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([column, value]) => (row[column] ?? null) === (value ?? null))
    const handle: Record<string, unknown> = {
      async selectOne(table: string, where: Record<string, unknown>) {
        return rows.find((row) => row.__table === table && matches(row, where)) || null
      },
      async select(table: string, { where }: { where?: Record<string, unknown> } = {}) {
        return rows.filter((row) => row.__table === table && matches(row, where || {}))
      },
      async insertOne(table: string, row: Record<string, unknown>) {
        const stored = { __table: table, created_at: 't0', updated_at: 't0', ...row }
        rows.push(stored)
        return { rows: [{ ...stored }] }
      },
      async updateRow(table: string, set: Record<string, unknown>, where: Record<string, unknown>) {
        const target = rows.find((row) => row.__table === table && matches(row, where))
        if (!target) return { rows: [] }
        Object.assign(target, set)
        return { rows: [{ ...target }] }
      },
      async selectOneForKeyShare(_table: string, where: Record<string, unknown>) {
        return { id: where.id, tenant_id: where.tenant_id }
      },
      async transaction(callback: (db: unknown) => unknown) { return callback(handle) },
      async setTransactionIsolationLevel() {},
    }
    return { handle, size: () => rows.length }
  }

  async function mountSourcePreflight(ownerId: string) {
    const routes = new Map<string, RouteHandler>()
    const calls = { bindingGets: [] as string[], loads: [] as Array<{ tenantId: string; principal: string }>, reads: 0 }
    const system = {
      id: BOUND_SOURCE,
      tenantId: TENANT_A,
      workspaceId: null,
      kind: 'data-source:sql-readonly',
      connectionId: 'conn_chain',
      status: 'active',
      config: { dataSourceOwnerId: ownerId },
    }
    const find = (input: { tenantId?: string; id?: string }) => (input.id === system.id && input.tenantId === system.tenantId ? system : null)
    const notFound = () => Object.assign(new Error('external system not found'), { name: 'ExternalSystemNotFoundError' })
    const registry = {
      ...inert(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystem(input: { tenantId?: string; id?: string }) {
        const found = find(input)
        if (!found) throw notFound()
        return { ...found, config: { ...found.config } }
      },
      async getExternalSystemAdapterConfig(input: { tenantId?: string; id?: string }) {
        const found = find(input)
        if (!found) throw notFound()
        return { id: found.id, kind: found.kind, connectionId: found.connectionId, config: { ...found.config } }
      },
      async getExternalSystemForAdapter(input: { tenantId: string; id: string; principal: string }) {
        calls.loads.push({ tenantId: input.tenantId, principal: input.principal })
        const found = find(input)
        if (!found) throw notFound()
        if (input.principal !== found.config.dataSourceOwnerId) {
          // The host facade's rule, restated: strict owner equality, one uniform refusal.
          throw Object.assign(new Error('canonical connection is unavailable'), {
            name: 'ExternalSystemValidationError',
            code: 'CONNECTION_CANONICAL_UNAVAILABLE',
            details: { field: 'connectionId', code: 'CONNECTION_CANONICAL_UNAVAILABLE' },
          })
        }
        return { ...found, config: { ...found.config } }
      },
    }
    const catalog: Record<string, Array<Record<string, unknown>>> = {
      DN_PDM_PathExAttrInfo: [{ ID: 1, FileCode: SAMPLE, Parent_OBJ_ID: 'PATH-1', NodeType: 2 }],
      DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1', Parent_OBJ_ID: null }],
      DN_PDM_BomHeadInfo: [{ ID: 1, part_id: 'PART-1', bom_id: 'BOM-1', SysVer: 'V1', bom_able: 1 }],
      DN_PDM_BomDetailsInfo: [{ ID: 1, bom_pid: 'BOM-1', part_id: 'PART-1', sort_id: 0, Bom_ExAttr1: '2' }],
    }
    const adapterRegistry = {
      listAdapterKinds() { return ['data-source:sql-readonly'] },
      createAdapter() {
        return {
          async read(request: { object: string; limit?: number }) {
            calls.reads += 1
            const key = Object.keys(catalog).find((name) => name.toLowerCase() === String(request.object).toLowerCase())
            if (!key) throw Object.assign(new Error('Invalid object name.'), { code: 'EREQUEST' })
            return { records: catalog[key].slice(0, request.limit) }
          },
        }
      },
    }
    const db = fakePluginDb()
    const realStore = plugin.bindingStore.createStockPreparationSourceBindingStore({ db: db.handle, idGenerator: () => `bind_${db.size() + 1}` })
    await realStore.set({ tenantId: TENANT_A, workspaceId: null, externalSystemId: BOUND_SOURCE, actionId: plugin.tableActions.PLM_STOCK_PREPARATION_ACTION_ID, actor: 'seed' })
    plugin.routes.registerIntegrationRoutes({
      context: {
        api: {
          http: { addRoute(method: string, routePath: string, handler: RouteHandler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
          multitable: { provisioning: {}, records: {} },
        },
        storage: new Map(),
        config: {
          stockPreparationTableActions: [{
            actionId: plugin.tableActions.PLM_STOCK_PREPARATION_ACTION_ID,
            source: { externalSystemId: 'sys_chain_deploy_default', kind: 'data-source:sql-readonly' },
            target: { sheetId: 'sheet_chain', objectId: 'stockPreparationMain' },
          }],
        },
      },
      services: {
        externalSystemRegistry: registry,
        adapterRegistry,
        pipelineRegistry: inert(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
        pipelineRunner: inert(['runPipeline']),
        deadLetterStore: inert(['listDeadLetters']),
        stagingInstaller: inert(['installStaging', 'listStagingDescriptors']),
        templateRegistry: inert(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
        readSourceConfigStore: inert(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
        readSourceCompositionConfigStore: inert(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
        bridgeAgentChecklistStore: inert(['saveVersion', 'approve', 'retire', 'getForApply']),
        // THE HOST's directory, the same factory index.ts wires for this plugin, over the same pool.
        tenantPrincipalDirectory: createTenantPrincipalDirectoryBoundaryV1({ query: chainQuery as never }),
        stockPreparationSourceBindingStore: {
          async get(scope: Record<string, unknown>) { calls.bindingGets.push(String(scope.tenantId)); return realStore.get(scope) },
          set: realStore.set,
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    })
    const handler = routes.get(`GET ${ROUTE}`)
    expect(handler).toBeTypeOf('function')
    return { handler: handler!, calls }
  }

  // ---- the host half ---------------------------------------------------------------------------
  async function signIn(username: string, hint?: string) {
    const result = await authService.login(username, PASSWORD, { tenantId: hint ?? null })
    expect(result, `${username} signs in`).toBeTruthy()
    return result!.token
  }

  async function throughMiddleware(token: string, header?: string) {
    const req: Record<string, unknown> = {
      method: 'GET',
      path: ROUTE,
      originalUrl: ROUTE,
      url: ROUTE,
      headers: { authorization: `Bearer ${token}`, ...(header ? { 'x-tenant-id': header } : {}) },
      query: {},
      body: {},
      params: {},
    }
    const res = { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this }, json(body: unknown) { this.body = body; return this } }
    let passed = false
    await jwtAuthMiddleware(req as never, res as never, () => { passed = true })
    expect(passed, 'the middleware lets the request through').toBe(true)
    return req
  }

  async function pressCheck(req: Record<string, unknown>, ownerId = 'u_chain_owner') {
    const mounted = await mountSourcePreflight(ownerId)
    const res = { statusCode: 200, body: undefined as { ok?: boolean; data?: { checks?: { projectData?: { livenessSamples?: string[] } } }; error?: { code?: string } } | undefined, status(code: number) { this.statusCode = code; return this }, json(body: never) { this.body = body; return this } }
    await mounted.handler(req, res)
    return { status: res.statusCode, code: res.body?.error?.code ?? null, body: res.body, calls: mounted.calls }
  }

  beforeEach(async () => {
    process.env.NODE_ENV = 'test'
    process.env.RBAC_TOKEN_TRUST = 'false'
    delete process.env.MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED
    const realJwt = await vi.importActual<typeof import('jsonwebtoken')>('jsonwebtoken')
    jwtMocks.sign.mockReset()
    jwtMocks.sign.mockImplementation(realJwt.sign as never)
    jwtMocks.verify.mockReset()
    jwtMocks.verify.mockImplementation(realJwt.verify as never)
    secretManagerMocks.get.mockReset()
    secretManagerMocks.get.mockReturnValue('unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')
    poolMocks.query.mockReset()
    poolMocks.query.mockImplementation(chainQuery as never)
    rbacMocks.isAdmin.mockReset()
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.listUserPermissions.mockImplementation(async (userId: string) => account(userId)?.perms ?? [])
    sessionMocks.isUserSessionRevoked.mockReset()
    sessionMocks.isUserSessionRevoked.mockResolvedValue(false)
    sessionMocks.createUserSession.mockReset()
    sessionMocks.createUserSession.mockResolvedValue(undefined)
    sessionMocks.isUserSessionActive.mockReset()
    sessionMocks.isUserSessionActive.mockResolvedValue(true)
    memberships = [
      { userId: 'u_chain_owner', orgId: TENANT_A, active: true },
      { userId: 'u_chain_two', orgId: TENANT_A, active: true },
      { userId: 'u_chain_two', orgId: TENANT_B, active: true },
    ]
  })

  afterEach(() => {
    jwtMocks.sign.mockReset()
    jwtMocks.verify.mockReset()
  })

  it('one active membership: sign-in mints the claim, the middleware keeps it, the owner is answered from their own tenant', async () => {
    const token = await signIn('chainowner')
    expect(realPayloadTenant(token)).toBe(TENANT_A)
    for (const header of [undefined, TENANT_A, TENANT_B]) {
      const req = await throughMiddleware(token, header)
      expect(req.authenticatedTenantId, `header ${header}`).toBe(TENANT_A)
      const answer = await pressCheck(req)
      expect(answer.status, `header ${header}: ${answer.code}`).toBe(200)
      expect(answer.calls.bindingGets, `header ${header}`).toEqual([TENANT_A])
      expect(answer.body?.data?.checks?.projectData?.livenessSamples).toEqual([SAMPLE])
    }
  })

  it('no membership row (bootstrap / user-management / self-registration shape): no claim, and the header cannot stand in for one', async () => {
    const token = await signIn('chainnone', TENANT_A)
    expect(realPayloadTenant(token)).toBeNull()
    const withHeader = await throughMiddleware(token, TENANT_A)
    expect(withHeader.authenticatedTenantId).toBeUndefined()
    expect((withHeader.user as { tenantId?: string }).tenantId).toBe(TENANT_A)
    const refused = await pressCheck(withHeader, 'u_chain_none')
    expect([refused.status, refused.code]).toEqual([403, 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED'])
    expect(refused.calls).toEqual({ bindingGets: [], loads: [], reads: 0 })

    const noHeader = await pressCheck(await throughMiddleware(token), 'u_chain_none')
    expect([noHeader.status, noHeader.code]).toEqual([403, 'OPERATOR_SCOPE_TENANT_REQUIRED'])
    expect(noHeader.calls).toEqual({ bindingGets: [], loads: [], reads: 0 })
  })

  it('a token minted WITH a tenant claim for a non-member loses the claim at verification', async () => {
    const minted = authService.createToken({
      id: 'u_chain_none',
      email: 'chainnone@example.invalid',
      name: 'chainnone',
      role: 'user',
      permissions: ['integration:read'],
      tenantId: TENANT_A,
      created_at: new Date(0),
      updated_at: new Date(0),
    })
    expect(realPayloadTenant(minted)).toBe(TENANT_A)
    const req = await throughMiddleware(minted, TENANT_A)
    expect(req.authenticatedTenantId, 'verifyToken drops the claim of a non-member').toBeUndefined()
    const refused = await pressCheck(req, 'u_chain_none')
    expect([refused.status, refused.code]).toEqual([403, 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED'])
  })

  it('a stale login hint yields no claim; the host directory still vouches for the header naming the member tenant', async () => {
    const token = await signIn('chainowner', TENANT_B)
    expect(realPayloadTenant(token)).toBeNull()
    const req = await throughMiddleware(token, TENANT_A)
    expect(req.authenticatedTenantId).toBeUndefined()
    const answer = await pressCheck(req)
    expect(answer.status, String(answer.code)).toBe(200)
    expect(answer.calls.bindingGets).toEqual([TENANT_A])

    const elsewhere = await pressCheck(await throughMiddleware(token, TENANT_B))
    expect([elsewhere.status, elsewhere.code]).toEqual([403, 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED'])
    expect(elsewhere.calls).toEqual({ bindingGets: [], loads: [], reads: 0 })
  })

  it('two memberships and no organisation chosen: no claim; a header naming either member tenant is vouched, no header is refused', async () => {
    const token = await signIn('chaintwo')
    expect(realPayloadTenant(token)).toBeNull()
    const none = await pressCheck(await throughMiddleware(token), 'u_chain_two')
    expect([none.status, none.code]).toEqual([403, 'OPERATOR_SCOPE_TENANT_REQUIRED'])
    const own = await pressCheck(await throughMiddleware(token, TENANT_A), 'u_chain_two')
    expect(own.status, String(own.code)).toBe(200)
    expect(own.calls.bindingGets).toEqual([TENANT_A])
    // Not the connection's owner: admitted to the tenant, then refused by the host's owner check.
    const notOwner = await pressCheck(await throughMiddleware(token, TENANT_A), 'u_chain_owner')
    expect([notOwner.status, notOwner.code]).toEqual([400, 'CONNECTION_CANONICAL_UNAVAILABLE'])
    expect(notOwner.calls.reads).toBe(0)
  })

  it('a membership row added after sign-in: the old token has no claim until a fresh sign-in', async () => {
    const before = await signIn('chainnone')
    expect(realPayloadTenant(before)).toBeNull()
    memberships.push({ userId: 'u_chain_none', orgId: TENANT_A, active: true })
    const stale = await pressCheck(await throughMiddleware(before), 'u_chain_none')
    expect([stale.status, stale.code]).toEqual([403, 'OPERATOR_SCOPE_TENANT_REQUIRED'])
    const fresh = await signIn('chainnone')
    expect(realPayloadTenant(fresh)).toBe(TENANT_A)
    const answered = await pressCheck(await throughMiddleware(fresh), 'u_chain_none')
    expect(answered.status, String(answered.code)).toBe(200)

    // …and a membership REMOVED after sign-in takes the claim away on the very next request.
    memberships = memberships.filter((row) => row.userId !== 'u_chain_none')
    const revoked = await throughMiddleware(fresh, TENANT_A)
    expect(revoked.authenticatedTenantId).toBeUndefined()
    const refused = await pressCheck(revoked, 'u_chain_none')
    expect([refused.status, refused.code]).toEqual([403, 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED'])
  })

  function realPayloadTenant(token: string): string | null {
    const [, payload] = token.split('.')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { tenantId?: unknown }
    return typeof decoded.tenantId === 'string' ? decoded.tenantId : null
  }
})
