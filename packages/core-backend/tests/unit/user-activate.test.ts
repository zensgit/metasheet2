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

import { activatePendingUser, isActivateMode } from '../../src/auth/user-activate'

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

  it('keeps the runtime activation mode set closed', () => {
    expect(['temp_password', 'sso', 'admin_no_password'].map(isActivateMode)).toEqual([
      true,
      true,
      true,
    ])
    for (const value of ['', 'passwordish', 'SSO', null, 1, {}, []]) {
      expect(isActivateMode(value)).toBe(false)
    }
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
      .mockResolvedValueOnce({ rows: [] }) // supersede effects
      .mockResolvedValueOnce({ rows: [] }) // supersede events
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] }) // generation

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
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE directory_deprovision_effects'))).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE directory_deprovision_events'))).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('access_generation = COALESCE'))).toBe(true)
    // Alias claims must run inside the transaction client
    expect(claimLoginAlias).toHaveBeenCalled()
    expect(vi.mocked(claimLoginAlias).mock.calls[0]?.[0]).toMatchObject({
      userId: 'u1',
      kind: 'email',
      client: expect.objectContaining({ query: expect.any(Function) }),
    })
  })

  it('maps alias conflict to ACTIVATE_ALIAS_CONFLICT without echoing claim.message', async () => {
    const { claimLoginAlias } = await import('../../src/auth/login-alias-service')
    vi.mocked(claimLoginAlias).mockResolvedValueOnce({
      ok: false,
      code: 'ALIAS_CONFLICT',
      message: 'relation "user_login_aliases" does not exist DETAIL: secret',
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

    let thrown: unknown
    try {
      await activatePendingUser({ userId: 'u1', mode: 'temp_password', temporaryPassword: 'TempPass9A!' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'ACTIVATE_ALIAS_CONFLICT' })
    expect(String((thrown as Error).message)).not.toMatch(/relation|DETAIL|secret/i)
    expect(claimLoginAlias).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.anything() }),
    )
  })

  it('maps ALIAS_WRITE_FAILED to ACTIVATE_ALIAS_FAILED (not conflict)', async () => {
    const { claimLoginAlias } = await import('../../src/auth/login-alias-service')
    vi.mocked(claimLoginAlias).mockResolvedValueOnce({
      ok: false,
      code: 'ALIAS_WRITE_FAILED',
      message: 'connection refused 5432',
    })
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'u1',
        email: 'a@x.com',
        username: null,
        mobile: null,
        activation_status: 'pending_activation',
        is_active: false,
      }],
    }).mockResolvedValueOnce({ rows: [{ id: 'u1' }] })

    await expect(
      activatePendingUser({ userId: 'u1', mode: 'temp_password', temporaryPassword: 'TempPass9A!' }),
    ).rejects.toMatchObject({
      code: 'ACTIVATE_ALIAS_FAILED',
      message: 'Failed to claim login alias during activation',
    })
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
          account_provider: 'dingtalk',
          integration_provider: 'dingtalk',
          account_corp_id: 'corp-1',
          integration_corp_id: 'corp-1',
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

  it('rejects an explicit account whose link row is missing or unlinked', async () => {
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
          account_active: true,
          integration_status: 'active',
          local_user_id: null,
          link_status: null,
          account_provider: 'dingtalk',
          integration_provider: 'dingtalk',
          account_corp_id: 'corp-1',
          integration_corp_id: 'corp-1',
        }],
      })

    await expect(
      activatePendingUser({
        userId: 'u1',
        mode: 'sso',
        directoryAccountId: 'da-1',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_MISSING' })
  })

  it('rejects an explicit account linked to another local user', async () => {
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
          account_active: true,
          integration_status: 'active',
          local_user_id: 'u-other',
          link_status: 'linked',
          account_provider: 'dingtalk',
          integration_provider: 'dingtalk',
          account_corp_id: 'corp-1',
          integration_corp_id: 'corp-1',
        }],
      })

    await expect(
      activatePendingUser({
        userId: 'u1',
        mode: 'sso',
        directoryAccountId: 'da-1',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_LINK_MISMATCH' })
  })

  it.each([
    {
      label: 'account provider is not DingTalk',
      account_provider: 'local',
      integration_provider: 'dingtalk',
      account_corp_id: 'corp-1',
      integration_corp_id: 'corp-1',
    },
    {
      label: 'account and integration corp ids differ',
      account_provider: 'dingtalk',
      integration_provider: 'dingtalk',
      account_corp_id: 'corp-a',
      integration_corp_id: 'corp-b',
    },
  ])('rejects SSO when $label', async (source) => {
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
          account_active: true,
          integration_status: 'active',
          local_user_id: 'u1',
          link_status: 'linked',
          ...source,
        }],
      })

    await expect(
      activatePendingUser({
        userId: 'u1',
        mode: 'sso',
        directoryAccountId: 'da-1',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_INELIGIBLE' })
  })

  it('accepts an implicit SSO source when at least one linked DingTalk source is active', async () => {
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
        rows: [
          {
            account_active: false,
            integration_status: 'active',
            local_user_id: 'u1',
            link_status: 'linked',
            account_provider: 'dingtalk',
            integration_provider: 'dingtalk',
            account_corp_id: 'corp-1',
            integration_corp_id: 'corp-1',
            integration_org_id: 'org-1',
          },
          {
            account_active: true,
            integration_status: 'active',
            local_user_id: 'u1',
            link_status: 'linked',
            account_provider: 'dingtalk',
            integration_provider: 'dingtalk',
            account_corp_id: 'corp-2',
            integration_corp_id: 'corp-2',
            integration_org_id: 'org-2',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })

    await expect(
      activatePendingUser({
        userId: 'u1',
        mode: 'sso',
      }),
    ).resolves.toMatchObject({
      userId: 'u1',
      activationStatus: 'activated',
      localPasswordSet: false,
    })
    const membershipWrite = pgMocks.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO user_orgs'))
    expect(membershipWrite?.[1]).toEqual(['u1', 'org-2'])
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
