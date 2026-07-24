import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(async (handler: (c: { query: typeof pgMocks.query }) => Promise<unknown>) =>
    handler({ query: pgMocks.query }),
  ),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/auth/login-alias-service', () => ({
  claimLoginAlias: vi.fn(async () => ({ ok: true, normalized: 'x' })),
}))

import { activatePendingUser } from '../../src/auth/user-activate'

describe('activatePendingUser (T3)', () => {
  beforeEach(async () => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockImplementation(
      async (handler: (c: { query: typeof pgMocks.query }) => Promise<unknown>) =>
        handler({ query: pgMocks.query }),
    )
    const { claimLoginAlias } = await import('../../src/auth/login-alias-service')
    vi.mocked(claimLoginAlias).mockReset()
    vi.mocked(claimLoginAlias).mockResolvedValue({ ok: true, normalized: 'x' })
  })

  it('promotes pending → activated with temp password in one transaction', async () => {
    const { claimLoginAlias } = await import('../../src/auth/login-alias-service')
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: 'a@x.com',
          username: 'alice',
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      }) // FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] }) // UPDATE users RETURNING

    const result = await activatePendingUser({
      userId: 'u1',
      mode: 'temp_password',
      temporaryPassword: 'TempPass9A!',
    })
    expect(result.activationStatus).toBe('activated')
    expect(result.isActive).toBe(true)
    expect(result.temporaryPassword).toBe('TempPass9A!')
    expect(result.localPasswordSet).toBe(true)
    expect(pgMocks.transaction).toHaveBeenCalled()
    const updateSql = String(pgMocks.query.mock.calls.find((c) => String(c[0]).includes('UPDATE users'))?.[0] || '')
    expect(updateSql).toContain("activation_status = 'activated'")
    expect(updateSql).toContain('local_password_set')
    // Alias claims must run inside the transaction client
    expect(claimLoginAlias).toHaveBeenCalled()
    expect(vi.mocked(claimLoginAlias).mock.calls[0]?.[0]).toMatchObject({
      userId: 'u1',
      kind: 'email',
      client: expect.objectContaining({ query: expect.any(Function) }),
    })
  })

  it('rolls back activate when in-txn alias claim fails (shared transaction)', async () => {
    const { claimLoginAlias } = await import('../../src/auth/login-alias-service')
    vi.mocked(claimLoginAlias).mockResolvedValueOnce({
      ok: false,
      code: 'ALIAS_CONFLICT',
      message: 'taken',
    })
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u1',
        email: 'taken@x.com',
        username: null,
        mobile: null,
        activation_status: 'pending_activation',
        is_active: false,
      }],
    }).mockResolvedValueOnce({ rows: [{ id: 'u1' }] })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'temp_password', temporaryPassword: 'TempPass9A!' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_ALIAS_CONFLICT' })
    // claim used the txn client — failure aborts before commit returns
    expect(claimLoginAlias).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.anything() }),
    )
  })

  it('rejects non-pending users', async () => {
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u1',
        email: 'a@x.com',
        username: null,
        mobile: null,
        activation_status: 'activated',
        is_active: true,
      }],
    })
    await expect(
      activatePendingUser({ userId: 'u1', mode: 'temp_password' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_NOT_PENDING' })
  })

  it('rejects SSO activate when directory account inactive', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: null,
          username: 'x',
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          account_active: false,
          integration_status: 'active',
          local_user_id: 'u1',
          link_status: 'linked',
        }],
      })

    await expect(
      activatePendingUser({
        userId: 'u1',
        mode: 'sso',
        directoryAccountId: 'da-1',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_INACTIVE' })
  })

  it('rejects activate when user has no claimable identifier', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'u1',
          email: null,
          username: null,
          mobile: null,
          activation_status: 'pending_activation',
          is_active: false,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'admin_no_password' }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_ALIAS_REQUIRED' })
  })
})
