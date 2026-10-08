/**
 * O2-A3 (adversarial gate NIT-2) — register()'s `null` is exists-only, BY CONSTRUCTION.
 *
 * routes/auth.ts maps `register() === null` to 409 "User with this email already
 * exists". At the gated head that mapping lied: ANY swallowed transaction failure
 * (42P01, permission errors, …) also surfaced as null → a fabricated "exists" 409.
 *
 * The null-path enumeration at this head (AuthService.register):
 *   1. getUserByEmail pre-check hit                        → null  (exists — truthful)
 *   2. ALIAS_CONFLICT LoginAliasClaimError (email claim)   → null  (exists race twin)
 *   3. Postgres 23505 (users email unique index)           → null  (exists race twin)
 *   4. every OTHER transaction failure                     → RETHROWS (was: null)
 *   5. busy-lease exhaustion                               → UserRoleAssignmentRecoveryBusyError (unchanged)
 *   6. outer failures (e.g. post-commit invalidate throw)  → RETHROWS (was: null)
 *
 * (getUserByIdentifier swallows its OWN infrastructure errors internally and reports
 * "no user" — pre-existing behaviour, untouched here; such a failure then surfaces from
 * the transaction write and takes path 4.)
 *
 * These tests pin each side with exact positive assertions — the discrimination is the
 * mutation target: restoring the old swallow (`return null` for case 4/6) reds the
 * rethrow tests; widening null beyond duplicates reds the 409-truthfulness leg.
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

/** Dispatcher covering register()'s pre-check and in-transaction writes. */
function installRegisterQueries(options: {
  existingUser?: boolean
  usersInsertError?: unknown
  /** The alias-ownership read reports THIS user as the alias owner. */
  aliasOwnedBy?: string
} = {}): void {
  let createdId = ''
  poolMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql)
    if (text.includes('FROM users') && text.includes('lower(email)')) {
      if (options.existingUser) {
        return {
          rows: [{
            id: 'user-existing',
            email: 'taken@example.com',
            name: 'Taken',
            role: 'user',
            permissions: [],
            password_hash: 'hash',
            is_active: true,
            activation_status: 'activated',
            local_password_set: true,
            must_change_password: false,
            created_at: new Date('2026-04-03T00:00:00.000Z'),
            updated_at: new Date('2026-04-03T00:00:00.000Z'),
          }],
        }
      }
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
      return { rows: [{ user_id: options.aliasOwnedBy ?? createdId }] }
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

describe('AuthService.register — null is exists-only (O2-A3)', () => {
  it('email already registered (pre-check) → exactly null, and no transaction ever opens', async () => {
    installRegisterQueries({ existingUser: true })
    const auth = new AuthService()
    const result = await auth.register('taken@example.com', 'WelcomePass9A', 'Taken')
    expect(result).toBeNull()
    expect(poolMocks.transaction).not.toHaveBeenCalled()
  })

  it('concurrent-register race: the email alias is owned by ANOTHER user → null (exists twin, real claim path)', async () => {
    // No injected error object — the REAL claimNonEmptyLoginAliasesOrThrow runs and
    // raises its own ALIAS_CONFLICT LoginAliasClaimError when the alias ownership read
    // returns a different user (the concurrent-register race, end to end).
    installRegisterQueries({ aliasOwnedBy: 'user-somebody-else' })
    const auth = new AuthService()
    const result = await auth.register('new@example.com', 'WelcomePass9A', 'New User')
    expect(result).toBeNull()
  })

  it('a WRITE_FAILED LoginAliasClaimError is NOT a duplicate — it rethrows (never a fabricated "exists")', async () => {
    const original = new LoginAliasClaimError('WRITE_FAILED', 'email')
    installRegisterQueries({ usersInsertError: original })
    const auth = new AuthService()
    await expect(
      auth.register('new@example.com', 'WelcomePass9A', 'New User'),
    ).rejects.toBe(original)
  })

  it('concurrent-register race: 23505 from the users email unique index → null (exists twin)', async () => {
    installRegisterQueries({
      usersInsertError: Object.assign(
        new Error('duplicate key value violates unique constraint "users_email_key"'),
        { code: '23505' },
      ),
    })
    const auth = new AuthService()
    const result = await auth.register('new@example.com', 'WelcomePass9A', 'New User')
    expect(result).toBeNull()
  })

  it('a NON-duplicate transaction failure rethrows the SAME object (never a fabricated "exists" null)', async () => {
    const original = Object.assign(new Error('relation "users" does not exist'), { code: '42P01' })
    installRegisterQueries({ usersInsertError: original })
    const auth = new AuthService()
    await expect(
      auth.register('new@example.com', 'WelcomePass9A', 'New User'),
    ).rejects.toBe(original)
  })

  it('an OUTER (post-transaction) failure rethrows the SAME object', async () => {
    // The registration transaction commits, then the post-commit cache invalidation
    // throws — the outer catch must rethrow it, never swallow it to a fabricated
    // "exists" null.
    const original = new Error('perm cache backend unavailable')
    installRegisterQueries()
    rbacMocks.invalidateUserPerms.mockImplementation(() => {
      throw original
    })
    const auth = new AuthService()
    await expect(
      auth.register('new@example.com', 'WelcomePass9A', 'New User'),
    ).rejects.toBe(original)
  })

  it('POSITIVE CONTROL: a clean registration still resolves to the created user', async () => {
    installRegisterQueries()
    const auth = new AuthService()
    const result = await auth.register('new@example.com', 'WelcomePass9A', 'New User')
    expect(result).toBeTruthy()
    expect(result?.email).toBe('new@example.com')
  })
})
