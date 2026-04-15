import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

import { bindDirectoryAccount, unbindDirectoryAccount } from '../../src/directory/directory-sync'

describe('bindDirectoryAccount', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
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
          name: '周华',
          email: null,
          mobile: '13758875801',
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
          account_name: '周华',
          account_email: null,
          account_mobile: '13758875801',
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
          name: '周华',
          email: null,
          mobile: '13758875801',
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

  it('removes the bound identity and resets the link on unbind', async () => {
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
          name: '周华',
          email: null,
          mobile: '13758875801',
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
          account_name: '周华',
          account_email: null,
          account_mobile: '13758875801',
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

    const result = await unbindDirectoryAccount('account-1', {
      adminUserId: 'admin-1',
    })

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
          name: '周华',
          email: null,
          mobile: '13758875801',
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
          account_name: '周华',
          account_email: null,
          account_mobile: '13758875801',
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
