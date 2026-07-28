/**
 * Alias full-writer coverage — unit tests (design lock Rev 4.2 §4 + closeout P1 writers gap).
 *
 * Load-bearing mutation notes:
 * - Remove claimNonEmptyLoginAliases / applyMobileLoginAliasChange from login-alias-service → these fail.
 * - Remove each production writer hook (AuthService.createUser, POST /api/admin/users,
 *   createDirectoryAdmittedUserInTransaction activated branch, createProvisionedUser real-id claims,
 *   PATCH profile mobile applyMobileLoginAliasChangeOrThrow) → the matching dedicated test below
 *   (or the real-DB suite) must fail.
 *
 * All lifecycle flags remain OFF; no T3 batch/SSO, deprovision, docs, env, or flag changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: vi.fn(async (handler: (c: { query: typeof pgMocks.query }) => Promise<unknown>) =>
    handler({ query: pgMocks.query }),
  ),
}))

import {
  applyMobileLoginAliasChange,
  applyMobileLoginAliasChangeOrThrow,
  claimNonEmptyLoginAliases,
  claimNonEmptyLoginAliasesOrThrow,
  LoginAliasClaimError,
} from '../../src/auth/login-alias-service'
import { normalizeLoginIdentifier } from '../../src/auth/login-identifier'

describe('claimNonEmptyLoginAliases (reusable fail-closed helper)', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
  })

  it('claims non-empty email/username/mobile through normalizeLoginIdentifier + claimLoginAlias', async () => {
    const client = { query: pgMocks.query }
    const owner = 'u-writer-1'
    pgMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('INSERT INTO user_login_aliases')) return { rows: [] }
      if (text.includes('SELECT user_id FROM user_login_aliases')) {
        return { rows: [{ user_id: owner }] }
      }
      return { rows: [] }
    })

    const result = await claimNonEmptyLoginAliases({
      userId: owner,
      email: '  Bob@Example.COM ',
      username: 'AliceUser',
      mobile: '13800138000',
      source: 'unit_helper',
      client,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claimed.map((c) => c.normalized).sort()).toEqual(
        [
          normalizeLoginIdentifier('Bob@Example.COM'),
          normalizeLoginIdentifier('AliceUser'),
          normalizeLoginIdentifier('13800138000'),
        ].sort(),
      )
    }
    const insertParams = pgMocks.query.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO user_login_aliases'))
      .map(([, params]) => params)
    expect(insertParams).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([owner, 'email', 'bob@example.com', 'unit_helper']),
        expect.arrayContaining([owner, 'username', 'aliceuser', 'unit_helper']),
        expect.arrayContaining([owner, 'mobile', '+8613800138000', 'unit_helper']),
      ]),
    )
  })

  it('skips empty fields and does not require at least one claim', async () => {
    const client = { query: pgMocks.query }
    const result = await claimNonEmptyLoginAliases({
      userId: 'u1',
      email: '  ',
      username: null,
      mobile: undefined,
      client,
    })
    expect(result).toEqual({ ok: true, claimed: [] })
    expect(pgMocks.query).not.toHaveBeenCalled()
  })

  it('maps conflict without leaking raw PG text', async () => {
    const client = { query: pgMocks.query }
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [{ user_id: 'other-user' }] }) // SELECT owner

    const result = await claimNonEmptyLoginAliases({
      userId: 'u1',
      email: 'taken@x.com',
      client,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ALIAS_CONFLICT')
      expect(result.message).toBe('A login identifier is already claimed by another account')
      expect(result.message).not.toMatch(/DETAIL|duplicate key|5432|relation/i)
    }
  })

  it('maps WRITE_FAILED without echoing claim.message driver text', async () => {
    const client = { query: pgMocks.query }
    pgMocks.query.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "user_login_aliases" DETAIL: secret-pg'),
    )

    const result = await claimNonEmptyLoginAliases({
      userId: 'u1',
      email: 'a@x.com',
      client,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ALIAS_WRITE_FAILED')
      expect(result.message).toBe('Failed to claim login alias')
      expect(result.message).not.toMatch(/DETAIL|secret-pg|duplicate key/i)
    }
  })

  it('claimNonEmptyLoginAliasesOrThrow throws LoginAliasClaimError with safe message', async () => {
    const client = { query: pgMocks.query }
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'other' }] })

    let thrown: unknown
    try {
      await claimNonEmptyLoginAliasesOrThrow({ userId: 'u1', email: 'x@y.com', client })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LoginAliasClaimError)
    expect(thrown).toMatchObject({ code: 'ALIAS_CONFLICT' })
    expect(String((thrown as Error).message)).not.toMatch(/DETAIL|secret|relation/i)
  })
})

describe('applyMobileLoginAliasChange (profile mobile claim-then-replace)', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
  })

  it('claims new mobile before afterNewClaim and retires prior only when normalized values differ', async () => {
    const client = { query: pgMocks.query }
    const order: string[] = []
    pgMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('INSERT INTO user_login_aliases')) {
        order.push('claim_insert')
        return { rows: [] }
      }
      if (text.includes('SELECT user_id FROM user_login_aliases')) {
        order.push('claim_select')
        return { rows: [{ user_id: 'u1' }] }
      }
      if (text.includes('DELETE FROM user_login_aliases')) {
        order.push('delete_prior')
        return { rows: [] }
      }
      return { rows: [] }
    })

    const result = await applyMobileLoginAliasChange({
      userId: 'u1',
      previousMobile: '13800138000',
      nextMobile: '13900139000',
      client,
      afterNewClaim: async () => {
        order.push('profile_update')
      },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claimed).toEqual([
        { kind: 'mobile', normalized: normalizeLoginIdentifier('13900139000') },
      ])
      expect(result.retiredNormalized).toBe(normalizeLoginIdentifier('13800138000'))
    }
    expect(order).toEqual(['claim_insert', 'claim_select', 'profile_update', 'delete_prior'])

    const deleteCall = pgMocks.query.mock.calls.find(([sql]) =>
      String(sql).includes('DELETE FROM user_login_aliases'),
    )
    expect(deleteCall?.[1]).toEqual([
      'u1',
      normalizeLoginIdentifier('13800138000'),
    ])
    // Ownership guard: DELETE always scopes user_id = this user.
    expect(String(deleteCall?.[0])).toMatch(/user_id\s*=\s*\$1/)
    expect(String(deleteCall?.[0])).toMatch(/kind\s*=\s*'mobile'/)
  })

  it('does not delete prior alias when normalized mobile is unchanged', async () => {
    const client = { query: pgMocks.query }
    const result = await applyMobileLoginAliasChange({
      userId: 'u1',
      previousMobile: '138 0013 8000',
      nextMobile: '13800138000',
      client,
      afterNewClaim: async () => undefined,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claimed).toEqual([])
      expect(result.retiredNormalized).toBeNull()
    }
    expect(pgMocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE'))).toBe(false)
    expect(pgMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT'))).toBe(false)
  })

  it('rolls back path: conflict before afterNewClaim (afterNewClaim not invoked)', async () => {
    const client = { query: pgMocks.query }
    let afterCalled = false
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'other' }] })

    const result = await applyMobileLoginAliasChange({
      userId: 'u1',
      previousMobile: '13800138000',
      nextMobile: '13900139000',
      client,
      afterNewClaim: async () => {
        afterCalled = true
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ALIAS_CONFLICT')
      expect(result.message).not.toMatch(/DETAIL|duplicate/i)
    }
    expect(afterCalled).toBe(false)
    expect(pgMocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE'))).toBe(false)
  })

  it('applyMobileLoginAliasChangeOrThrow surfaces LoginAliasClaimError', async () => {
    const client = { query: pgMocks.query }
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'other' }] })

    await expect(
      applyMobileLoginAliasChangeOrThrow({
        userId: 'u1',
        previousMobile: null,
        nextMobile: '13900139000',
        client,
        afterNewClaim: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'ALIAS_CONFLICT', name: 'LoginAliasClaimError' })
  })
})

describe('writer hook call contracts (load-bearing mutation notes)', () => {
  /**
   * Source-level pins: removing each production writer hook must red its dedicated case.
   * Real-DB suite (`login-alias-writers.db.test.ts`) proves rows + rollback end-to-end.
   */
  it('AuthService.createUser wires claimNonEmptyLoginAliasesOrThrow (auth_register)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(new URL('../../src/auth/AuthService.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/claimNonEmptyLoginAliasesOrThrow/)
    expect(src).toMatch(/source:\s*'auth_register'/)
    expect(src).toMatch(/pool\.transaction/)
  })

  it('POST /api/admin/users wires claimNonEmptyLoginAliasesOrThrow (admin_create)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(new URL('../../src/routes/admin-users.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/claimNonEmptyLoginAliasesOrThrow/)
    expect(src).toMatch(/source:\s*'admin_create'/)
    expect(src).toMatch(/applyMobileLoginAliasChangeOrThrow/)
    expect(src).toMatch(/source:\s*'admin_profile_mobile'/)
  })

  it('directory admit claims only when activationStatus=activated (directory_admit)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('../../src/directory/directory-sync.ts', import.meta.url),
      'utf8',
    )
    expect(src).toMatch(/claimNonEmptyLoginAliasesOrThrow/)
    expect(src).toMatch(/activationStatus === 'activated'/)
    expect(src).toMatch(/source:\s*'directory_admit'/)
  })

  it('dingtalk JIT claims real identifiers only; never placeholder (dingtalk_jit)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(new URL('../../src/auth/dingtalk-oauth.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/claimNonEmptyLoginAliasesOrThrow/)
    expect(src).toMatch(/source:\s*'dingtalk_jit'/)
    expect(src).toMatch(/isDingTalkPlaceholderEmail/)
    expect(src).toMatch(/@placeholder\.local/)
    // Placeholder email must not be passed as the email claim field.
    expect(src).toMatch(/realEmail/)
    expect(src).toMatch(/realMobile/)
    // Real mobile must be persisted on users.mobile in the same INSERT as the claim.
    expect(src).toMatch(/mobile, password_hash/)
    expect(src).toMatch(/\[userId, email, name, realMobile, passwordHash\]/)
  })

  it('admin profile mobile path locks FOR UPDATE and derives previous from lock', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(new URL('../../src/routes/admin-users.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/applyMobileLoginAliasChangeOrThrow/)
    expect(src).toMatch(/FOR UPDATE/)
    expect(src).toMatch(/previousMobileFromLock/)
    expect(src).toMatch(/previousMobile:\s*previousMobileFromLock/)
    // Must not pass the pre-transaction profile.mobile into the retire path.
    expect(src).not.toMatch(/previousMobile:\s*profile\.mobile/)
  })

  it('directory admit internals still export createDirectoryAdmittedUserInTransaction', async () => {
    const { __directorySyncInternalsForTests } = await import('../../src/directory/directory-sync')
    expect(typeof __directorySyncInternalsForTests.createDirectoryAdmittedUserInTransaction).toBe(
      'function',
    )
  })

  it('dingtalk OAuth internals still export createProvisionedUser', async () => {
    const { __dingtalkOAuthInternalsForTests } = await import('../../src/auth/dingtalk-oauth')
    expect(typeof __dingtalkOAuthInternalsForTests.createProvisionedUser).toBe('function')
  })
})
