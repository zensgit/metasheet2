import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
}))

import {
  assertAliasCutoverAllowed,
  backfillUserLoginAliases,
  claimLoginAlias,
  findUserIdByLoginAlias,
  hasActiveAdminWithPasswordAlias,
  isAuthLoginAliasCutoverEnabled,
} from '../../src/auth/login-alias-service'

describe('login-alias-service (T2a/T2b)', () => {
  const original = process.env.AUTH_LOGIN_USE_ALIASES

  beforeEach(() => {
    pgMocks.query.mockReset()
    delete process.env.AUTH_LOGIN_USE_ALIASES
  })

  afterEach(() => {
    if (original === undefined) delete process.env.AUTH_LOGIN_USE_ALIASES
    else process.env.AUTH_LOGIN_USE_ALIASES = original
  })

  it('cutover env defaults OFF', () => {
    expect(isAuthLoginAliasCutoverEnabled()).toBe(false)
    process.env.AUTH_LOGIN_USE_ALIASES = 'true'
    expect(isAuthLoginAliasCutoverEnabled()).toBe(true)
  })

  it('findUserIdByLoginAlias queries normalized value only', async () => {
    pgMocks.query.mockResolvedValueOnce({ rows: [{ user_id: 'u1' }] })
    await expect(findUserIdByLoginAlias('  Alice@Example.COM ')).resolves.toBe('u1')
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('user_login_aliases'),
      ['alice@example.com'],
    )
  })

  it('claimLoginAlias inserts and verifies ownership', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [{ user_id: 'u1' }] }) // SELECT owner
    const result = await claimLoginAlias({ userId: 'u1', rawValue: 'Bob@X.com' })
    expect(result).toEqual({ ok: true, normalized: 'bob@x.com' })
  })

  it('claimLoginAlias reports conflict when owned by another user', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'other' }] })
    const result = await claimLoginAlias({ userId: 'u1', rawValue: 'taken@x.com' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ALIAS_CONFLICT')
  })

  it('backfill inserts unique ownership and records multi-user collisions', async () => {
    pgMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('FROM users')) {
        return {
          rows: [
            { id: 'u1', email: 'same@x.com', username: 'alice', mobile: null },
            { id: 'u2', email: 'same@x.com', username: 'bob', mobile: null },
            { id: 'u3', email: null, username: 'unique_user', mobile: null },
          ],
        }
      }
      if (text.includes('user_login_alias_collision_report')) {
        return { rows: [] }
      }
      if (text.includes('INSERT INTO user_login_aliases')) {
        return { rows: [{ id: 'alias-row' }] }
      }
      return { rows: [] }
    })

    const result = await backfillUserLoginAliases()
    // same@x.com → multi-user collision; alice, bob, unique_user each insert once
    expect(result.collisions).toBe(1)
    expect(result.inserted).toBe(3)
    const sqls = pgMocks.query.mock.calls.map((c) => String(c[0] || ''))
    expect(sqls.some((s) => s.includes('user_login_alias_collision_report'))).toBe(true)
    expect(sqls.filter((s) => s.includes('INSERT INTO user_login_aliases')).length).toBe(3)
  })

  it('T2b gate refuses cutover without admin alias', async () => {
    process.env.AUTH_LOGIN_USE_ALIASES = '1'
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
    await expect(assertAliasCutoverAllowed()).rejects.toMatchObject({
      code: 'ALIAS_CUTOVER_BLOCKED',
    })
  })

  it('T2b gate allows cutover when active admin has alias', async () => {
    process.env.AUTH_LOGIN_USE_ALIASES = '1'
    pgMocks.query.mockResolvedValue({ rows: [{ n: 1 }] })
    await expect(assertAliasCutoverAllowed()).resolves.toBeUndefined()
    await expect(hasActiveAdminWithPasswordAlias()).resolves.toBe(true)
  })
})
