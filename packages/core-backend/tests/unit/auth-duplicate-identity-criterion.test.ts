/**
 * O2 NIT-sweep (gate #5018 NIT-3) — isDuplicateIdentityConflict must be duck-typed on
 * `.code`, not a bare `instanceof LoginAliasClaimError`.
 *
 * The hazard (lesson 判据本身也要被攻击): under a duplicated module instance — two copies
 * of login-alias-service loaded (pnpm double-link, mixed dist/src imports, vi mock realm)
 * — a genuine ALIAS_CONFLICT LoginAliasClaimError fails `instanceof`, is then compared
 * against `'23505'` (a code it never carries), and rethrows: the user-facing result is a
 * generic 500 for a genuine duplicate instead of the truthful 409.
 *
 * These tests drive register() with a CROSS-REALM twin of LoginAliasClaimError (same
 * name/shape, different constructor identity — `instanceof` is false by construction)
 * and pin the classification:
 *   - cross-realm ALIAS_CONFLICT   → null (classified duplicate; the route's 409)
 *   - cross-realm ALIAS_WRITE_FAILED → rethrows the SAME object (never a fabricated
 *     "exists"; the criterion must not widen to "any LoginAliasClaimError-shaped error")
 *
 * Mutation target: restoring the bare-instanceof criterion reds the first test and ONLY
 * the first test; the same-realm legs in auth-register-null-discrimination.test.ts stay
 * green (this file adds the cross-realm discrimination, it does not re-pin those).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const jwtMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  sign: vi.fn(),
}))

const poolMocks = vi.hoisted(() => {
  const query = vi.fn()
  const transaction = vi.fn(async (handler: (client: { query: typeof query }) => Promise<unknown>) =>
    handler({ query }),
  )
  return {
    query,
    transaction,
    poolManager: {
      get: () => ({ query, transaction, getInternalPool: () => null }),
    },
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
  secretManager: { get: secretManagerMocks.get },
}))

import { AuthService } from '../../src/auth/AuthService'
import { LoginAliasClaimError } from '../../src/auth/login-alias-service'

/**
 * A cross-realm twin: byte-for-byte the same class body as LoginAliasClaimError, but a
 * DIFFERENT constructor identity, so `instanceof LoginAliasClaimError` is false. This is
 * exactly what a duplicated module instance produces.
 */
class CrossRealmLoginAliasClaimError extends Error {
  readonly code: 'ALIAS_CONFLICT' | 'ALIAS_WRITE_FAILED'

  constructor(code: 'ALIAS_CONFLICT' | 'ALIAS_WRITE_FAILED') {
    super(code)
    this.name = 'LoginAliasClaimError'
    this.code = code
  }
}

/** Dispatcher covering register()'s pre-check and in-transaction writes. */
function installRegisterQueries(options: { usersInsertError?: unknown } = {}): void {
  let createdId = ''
  poolMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql)
    if (text.includes('FROM users') && text.includes('lower(email)')) {
      return { rows: [] }
    }
    if (text.includes('INSERT INTO users')) {
      if (options.usersInsertError) throw options.usersInsertError
      createdId = String(params?.[0] ?? 'user-new')
      return {
        rows: [{
          id: createdId,
          email: 'new@example.com',
          name: 'New User',
          role: 'user',
          permissions: [],
          created_at: new Date('2026-04-03T00:00:00.000Z'),
          updated_at: new Date('2026-04-03T00:00:00.000Z'),
        }],
      }
    }
    if (text.includes('INSERT INTO user_login_aliases')) return { rows: [] }
    if (text.includes('SELECT user_id FROM user_login_aliases')) {
      return { rows: [{ user_id: createdId }] }
    }
    return { rows: [] }
  })
}

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  process.env.PRODUCT_MODE = 'platform'
  poolMocks.query.mockReset()
  poolMocks.query.mockResolvedValue({ rows: [] })
  poolMocks.transaction.mockClear()
  poolMocks.transaction.mockImplementation(
    async (handler: (client: { query: typeof poolMocks.query }) => Promise<unknown>) =>
      handler({ query: poolMocks.query }),
  )
  rbacMocks.isAdmin.mockReset()
  rbacMocks.isAdmin.mockResolvedValue(false)
  rbacMocks.listUserPermissions.mockReset()
  rbacMocks.listUserPermissions.mockResolvedValue([])
  rbacMocks.invalidateUserPerms.mockReset()
  secretManagerMocks.get.mockReset()
  secretManagerMocks.get.mockReturnValue('unit-test-secret-abcdefghijklmnopqrstuvwxyz123456')
})

describe('isDuplicateIdentityConflict — cross-realm duck-typing (gate #5018 NIT-3)', () => {
  it('SCENARIO GUARD: the cross-realm twin genuinely defeats instanceof while carrying the code', () => {
    // Without this anchor the tests below could pass for the wrong reason (fixture形状
    // must match named scenario): the twin must NOT be an instance of the real class.
    const twin = new CrossRealmLoginAliasClaimError('ALIAS_CONFLICT')
    expect(twin instanceof LoginAliasClaimError).toBe(false)
    expect(twin.code).toBe('ALIAS_CONFLICT')
    expect(twin.name).toBe('LoginAliasClaimError')
  })

  it('a cross-realm ALIAS_CONFLICT still classifies as duplicate → register() returns null', async () => {
    installRegisterQueries({ usersInsertError: new CrossRealmLoginAliasClaimError('ALIAS_CONFLICT') })
    const auth = new AuthService()
    const result = await auth.register('new@example.com', 'WelcomePass9A', 'New User')
    expect(result).toBeNull()
  })

  it('a cross-realm ALIAS_WRITE_FAILED is NOT a duplicate — it rethrows the SAME object', async () => {
    const original = new CrossRealmLoginAliasClaimError('ALIAS_WRITE_FAILED')
    installRegisterQueries({ usersInsertError: original })
    const auth = new AuthService()
    await expect(
      auth.register('new@example.com', 'WelcomePass9A', 'New User'),
    ).rejects.toBe(original)
  })

  it('POSITIVE CONTROL: a same-realm ALIAS_CONFLICT LoginAliasClaimError still classifies → null', async () => {
    installRegisterQueries({ usersInsertError: new LoginAliasClaimError('ALIAS_CONFLICT', 'email') })
    const auth = new AuthService()
    const result = await auth.register('new@example.com', 'WelcomePass9A', 'New User')
    expect(result).toBeNull()
  })

  it('POSITIVE CONTROL: a non-code error object still rethrows (criterion did not widen to "any object")', async () => {
    const original = Object.assign(new Error('relation "users" does not exist'), { code: '42P01' })
    installRegisterQueries({ usersInsertError: original })
    const auth = new AuthService()
    await expect(
      auth.register('new@example.com', 'WelcomePass9A', 'New User'),
    ).rejects.toBe(original)
  })
})
