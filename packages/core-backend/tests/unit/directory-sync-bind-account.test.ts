import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const authRuntimeMocks = vi.hoisted(() => ({
  getBcryptSaltRounds: vi.fn(() => 10),
}))

const inviteLedgerMocks = vi.hoisted(() => ({
  recordInvite: vi.fn(),
}))

const inviteTokenMocks = vi.hoisted(() => ({
  issueInviteToken: vi.fn(() => 'invite-token-fixed'),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/security/auth-runtime-config', () => ({
  getBcryptSaltRounds: authRuntimeMocks.getBcryptSaltRounds,
}))

vi.mock('../../src/auth/invite-ledger', () => ({
  recordInvite: inviteLedgerMocks.recordInvite,
}))

vi.mock('../../src/auth/invite-tokens', () => ({
  issueInviteToken: inviteTokenMocks.issueInviteToken,
}))

import { admitDirectoryAccountUser, bindDirectoryAccount, unbindDirectoryAccount } from '../../src/directory/directory-sync'

describe('bindDirectoryAccount', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
    inviteLedgerMocks.recordInvite.mockReset()
    inviteLedgerMocks.recordInvite.mockResolvedValue(null)
    inviteTokenMocks.issueInviteToken.mockReset()
    inviteTokenMocks.issueInviteToken.mockReturnValue('invite-token-fixed')
  })

  it('writes an auth-compatible DingTalk identity and linked directory mapping', async () => {
    const clientQuery = vi.fn()
    pgMocks.transaction.mockImplementation(async (handler) => handler({ query: clientQuery }))
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          name: '林岚',
          email: null,
          mobile: '13900001234',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-1',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          account_name: '林岚',
          account_email: null,
          account_mobile: '13900001234',
          account_is_active: true,
          account_updated_at: '2026-04-11T08:00:00.000Z',
          link_status: 'linked',
          match_strategy: 'manual_admin',
          reviewed_by: 'admin-1',
          review_note: null,
          link_updated_at: '2026-04-11T08:00:00.000Z',
          local_user_id: 'user-1',
          local_user_email: 'alpha@example.com',
          local_user_name: 'Alpha',
          department_paths: ['DingTalk CN'],
        }],
      })

    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await bindDirectoryAccount('account-1', {
      localUserRef: 'alpha@example.com',
      adminUserId: 'admin-1',
      enableDingTalkGrant: true,
    })

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_external_identities'),
      expect.arrayContaining([
        'dingtalk',
        'dingcorp:open-1',
        'union-1',
        'open-1',
        'dingcorp',
        'user-1',
      ]),
    )
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_external_auth_grants'),
      ['dingtalk', 'user-1', 'admin-1'],
    )
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_account_links'),
      ['account-1', 'user-1', 'admin-1'],
    )
    expect(result).toMatchObject({
      account: {
        id: 'account-1',
        linkStatus: 'linked',
        matchStrategy: 'manual_admin',
        localUser: {
          id: 'user-1',
          email: 'alpha@example.com',
        },
      },
      previousLocalUser: null,
    })
  })

  it('rejects pre-binding when DingTalk identifiers are missing', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: null,
          open_id: null,
          external_key: '0447654442691174',
          name: '林岚',
          email: null,
          mobile: '13900001234',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
        }],
      })

    await expect(bindDirectoryAccount('account-1', {
      localUserRef: 'alpha@example.com',
      adminUserId: 'admin-1',
      enableDingTalkGrant: true,
    })).rejects.toThrow('cannot be pre-bound')

    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })

  it('fails closed when a mobile binding reference matches multiple local users', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          name: '林岚',
          email: null,
          mobile: '13900001234',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-1',
            email: null,
            username: 'liqing',
            mobile: '13900001234',
            name: '李青',
            role: 'user',
            is_active: true,
          },
          {
            id: 'user-2',
            email: null,
            username: 'linlan',
            mobile: '139 0000 1234',
            name: '林岚',
            role: 'user',
            is_active: true,
          },
        ],
      })

    await expect(bindDirectoryAccount('account-1', {
      localUserRef: '139 0000 1234',
      adminUserId: 'admin-1',
      enableDingTalkGrant: true,
    })).rejects.toThrow('Local user reference is ambiguous')

    expect(pgMocks.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('LIMIT 2'),
      ['139 0000 1234', '139 0000 1234', '13900001234'],
    )
    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })

  it('fails closed when a binding reference matches different users across account fields', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          name: '林岚',
          email: null,
          mobile: '13900001234',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-1',
            email: 'shared@example.com',
            username: 'liqing',
            mobile: '13900001234',
            name: '李青',
            role: 'user',
            is_active: true,
          },
          {
            id: 'user-2',
            email: null,
            username: 'shared@example.com',
            mobile: '13900004567',
            name: '林岚',
            role: 'user',
            is_active: true,
          },
        ],
      })

    await expect(bindDirectoryAccount('account-1', {
      localUserRef: 'shared@example.com',
      adminUserId: 'admin-1',
      enableDingTalkGrant: true,
    })).rejects.toThrow('Local user reference is ambiguous')

    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })

  it('prefers an exact local user id over cross-field identifier ambiguity', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] })
    pgMocks.transaction.mockImplementation(async (handler) => handler({ query: clientQuery }))
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          name: '林岚',
          email: null,
          mobile: '13900001234',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-1',
            email: 'alpha@example.com',
            username: 'alpha',
            mobile: '13900001234',
            name: 'Alpha',
            role: 'user',
            is_active: true,
          },
          {
            id: 'user-2',
            email: 'user-1',
            username: 'user-1',
            mobile: '13900004567',
            name: 'Shadow',
            role: 'user',
            is_active: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-1',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          account_name: '林岚',
          account_email: null,
          account_mobile: '13900001234',
          account_is_active: true,
          account_updated_at: '2026-04-11T08:00:00.000Z',
          link_status: 'linked',
          match_strategy: 'manual_admin',
          reviewed_by: 'admin-1',
          review_note: null,
          link_updated_at: '2026-04-11T08:00:00.000Z',
          local_user_id: 'user-1',
          local_user_email: 'alpha@example.com',
          local_user_name: 'Alpha',
          department_paths: ['DingTalk CN'],
        }],
      })

    const result = await bindDirectoryAccount('account-1', {
      localUserRef: 'user-1',
      adminUserId: 'admin-1',
      enableDingTalkGrant: true,
    })

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_account_links'),
      ['account-1', 'user-1', 'admin-1'],
    )
    expect(result.account.localUser?.id).toBe('user-1')
  })

  it('creates a local user and binds it to a directory account in one server-side admission flow', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] })
    pgMocks.transaction.mockImplementation(async (handler) => handler({ query: clientQuery }))
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-admit-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          name: '李青',
          email: null,
          mobile: '13900001234',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-admit-1',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          account_name: '李青',
          account_email: null,
          account_mobile: '13900001234',
          account_is_active: true,
          account_updated_at: '2026-04-11T08:00:00.000Z',
          link_status: 'linked',
          match_strategy: 'manual_admin',
          reviewed_by: 'admin-1',
          review_note: null,
          link_updated_at: '2026-04-11T08:00:00.000Z',
          local_user_id: 'user-created',
          local_user_email: 'liqing@example.com',
          local_user_name: '李青',
          department_paths: ['DingTalk CN'],
        }],
      })

    const result = await admitDirectoryAccountUser('account-admit-1', {
      adminUserId: 'admin-1',
      name: '李青',
      email: 'liqing@example.com',
      mobile: '13900001234',
      enableDingTalkGrant: true,
    })

    const createUserCall = clientQuery.mock.calls.find((entry) => String(entry[0]).includes('INSERT INTO users'))
    const createdUserId = Array.isArray(createUserCall?.[1]) ? String(createUserCall?.[1]?.[0] || '') : ''
    expect(createdUserId.length).toBeGreaterThan(0)
    expect(createUserCall?.[1]).toEqual(expect.arrayContaining([
      'liqing@example.com',
      '李青',
      '13900001234',
      JSON.stringify([]),
    ]))
    expect(String(createUserCall?.[0])).toContain("'user'")
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_external_auth_grants'),
      ['dingtalk', createdUserId, 'admin-1'],
    )
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_account_links'),
      ['account-admit-1', createdUserId, 'admin-1'],
    )
    expect(inviteLedgerMocks.recordInvite).toHaveBeenCalledWith(expect.objectContaining({
      userId: createdUserId,
      email: 'liqing@example.com',
      inviteToken: 'invite-token-fixed',
    }))
    expect(result).toMatchObject({
      account: {
        id: 'account-admit-1',
        localUser: {
          email: 'liqing@example.com',
          name: '李青',
        },
      },
      user: {
        id: createdUserId,
        email: 'liqing@example.com',
        name: '李青',
        mobile: '13900001234',
      },
      inviteToken: 'invite-token-fixed',
    })
  })

  it('admits a no-email local user with username/mobile and skips invite issuance', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] })
    pgMocks.transaction.mockImplementation(async (handler) => handler({ query: clientQuery }))
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-admit-2',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691188',
          union_id: 'union-2',
          open_id: 'open-2',
          external_key: 'union-2',
          name: '林岚',
          email: null,
          mobile: '13900004567',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: null,
          local_user_email: null,
          local_user_username: null,
          local_user_name: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-admit-2',
          external_user_id: '0447654442691188',
          union_id: 'union-2',
          open_id: 'open-2',
          external_key: 'union-2',
          account_name: '林岚',
          account_email: null,
          account_mobile: '13900004567',
          account_is_active: true,
          account_updated_at: '2026-04-11T08:00:00.000Z',
          link_status: 'linked',
          match_strategy: 'manual_admin',
          reviewed_by: 'admin-1',
          review_note: null,
          link_updated_at: '2026-04-11T08:00:00.000Z',
          local_user_id: 'user-created-2',
          local_user_email: null,
          local_user_username: 'linlan',
          local_user_name: '林岚',
          department_paths: ['DingTalk CN'],
        }],
      })

    const result = await admitDirectoryAccountUser('account-admit-2', {
      adminUserId: 'admin-1',
      name: '林岚',
      username: 'linlan',
      mobile: '13900004567',
      enableDingTalkGrant: true,
    })

    const createUserCall = clientQuery.mock.calls.find((entry) => String(entry[0]).includes('INSERT INTO users'))
    const createdUserId = Array.isArray(createUserCall?.[1]) ? String(createUserCall?.[1]?.[0] || '') : ''
    expect(createUserCall?.[1]).toEqual(expect.arrayContaining([
      null,
      'linlan',
      '林岚',
      '13900004567',
      JSON.stringify([]),
    ]))
    expect(result).toMatchObject({
      user: {
        id: createdUserId,
        email: null,
        username: 'linlan',
        mobile: '13900004567',
      },
      inviteToken: null,
    })
    expect(inviteLedgerMocks.recordInvite).not.toHaveBeenCalled()
    expect(inviteTokenMocks.issueInviteToken).not.toHaveBeenCalled()
  })

  it('removes the bound identity, optionally disables grant, and resets the link on unbind', async () => {
    const clientQuery = vi.fn()
    pgMocks.transaction.mockImplementation(async (handler) => handler({ query: clientQuery }))
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          name: '林岚',
          email: null,
          mobile: '13900001234',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: 'user-1',
          local_user_email: 'alpha@example.com',
          local_user_name: 'Alpha',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-1',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          account_name: '林岚',
          account_email: null,
          account_mobile: '13900001234',
          account_is_active: true,
          account_updated_at: '2026-04-11T08:01:00.000Z',
          link_status: 'unmatched',
          match_strategy: 'manual_unbound',
          reviewed_by: null,
          review_note: null,
          link_updated_at: '2026-04-11T08:01:00.000Z',
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
          department_paths: ['DingTalk CN'],
        }],
      })

    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await unbindDirectoryAccount('account-1', {
      adminUserId: 'admin-1',
      disableDingTalkGrant: true,
    })

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_external_auth_grants'),
      ['dingtalk', 'user-1', 'admin-1'],
    )
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM user_external_identities'),
      ['dingtalk', 'user-1', 'dingcorp:open-1'],
    )
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_account_links'),
      ['account-1', 'admin-1'],
    )
    expect(result).toMatchObject({
      account: {
        id: 'account-1',
        linkStatus: 'unmatched',
        matchStrategy: 'manual_unbound',
        localUser: null,
      },
      previousLocalUser: {
        id: 'user-1',
        email: 'alpha@example.com',
      },
    })
  })

  it('can disable the DingTalk grant while unbinding', async () => {
    const clientQuery = vi.fn()
    pgMocks.transaction.mockImplementation(async (handler) => handler({ query: clientQuery }))
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          name: '林岚',
          email: null,
          mobile: '13900001234',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: 'user-1',
          local_user_email: 'alpha@example.com',
          local_user_name: 'Alpha',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-1',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          account_name: '林岚',
          account_email: null,
          account_mobile: '13900001234',
          account_is_active: true,
          account_updated_at: '2026-04-11T08:01:00.000Z',
          link_status: 'unmatched',
          match_strategy: 'manual_unbound',
          reviewed_by: null,
          review_note: null,
          link_updated_at: '2026-04-11T08:01:00.000Z',
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
          department_paths: ['DingTalk CN'],
        }],
      })

    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    await unbindDirectoryAccount('account-1', {
      adminUserId: 'admin-1',
      disableDingTalkGrant: true,
    })

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_external_auth_grants'),
      ['dingtalk', 'user-1', 'admin-1'],
    )
  })
})
