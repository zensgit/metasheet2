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

import {
  admitDirectoryAccountUser,
  batchAdmitDirectoryAccountUsers,
  batchBindDirectoryAccounts,
  batchUnbindDirectoryAccounts,
  bindDirectoryAccount,
  unbindDirectoryAccount,
} from '../../src/directory/directory-sync'

describe('bindDirectoryAccount', () => {
  function installTransactionMock(
    clientQuery: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>,
    accountOverrides: Record<string, unknown> = {},
    missingAccountIds: ReadonlySet<string> = new Set(),
  ): void {
    pgMocks.transaction.mockImplementation(async (handler) => handler({
      query: async (sql: string, params?: unknown[]) => {
        if (/FROM directory_accounts account\s+JOIN directory_integrations integration/.test(String(sql))) {
          const accountId = String(params?.[0] ?? 'account-1')
          if (missingAccountIds.has(accountId)) return { rows: [] }
          return {
            rows: [{
              id: accountId,
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
              integration_provider: 'dingtalk',
              integration_corp_id: 'dingcorp',
              ...accountOverrides,
            }],
          }
        }
        return clientQuery(sql, params)
      },
    }))
  }

  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
    inviteLedgerMocks.recordInvite.mockReset()
    inviteLedgerMocks.recordInvite.mockResolvedValue(null)
    inviteTokenMocks.issueInviteToken.mockReset()
    inviteTokenMocks.issueInviteToken.mockReturnValue('invite-token-fixed')
  })

  it('writes an auth-compatible DingTalk identity and linked directory mapping', async () => {
    // W4-PRE-1b: applyDirectoryAccountBindInTransaction now ALSO resolves the account's org
    // (`SELECT org_id FROM directory_integrations`), captures any PRIOR holder of this account
    // (`SELECT local_user_id FROM directory_account_links ... link_status = 'linked'`), and
    // upserts `user_orgs` at the end — a SQL-text-inspecting closure (matching the
    // "allows union-only pre-binding" test's existing precedent below) is robust to the added
    // call count/order; a positional `mockResolvedValueOnce` chain is not.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      if (/SELECT local_user_id\s+FROM directory_account_links/.test(String(sql))) {
        return { rows: [] } // no prior holder — this is a fresh bind
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery)
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
    // W4-PRE-1b item A: same-transaction membership upsert for the newly-bound holder.
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_orgs'),
      ['user-1', 'default'],
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

  it('rejects enabling DingTalk grant when a corp-scoped directory account is missing openId', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: null,
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

    await expect(bindDirectoryAccount('account-1', {
      localUserRef: 'alpha@example.com',
      adminUserId: 'admin-1',
      enableDingTalkGrant: true,
    })).rejects.toThrow('missing DingTalk openId')

    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })

  it('allows union-only pre-binding when DingTalk grant is disabled', async () => {
    // W4-PRE-1: createDirectoryAdmittedUserInTransaction now resolves the admission org via
    // `SELECT org_id FROM directory_integrations WHERE id = $1` (§3.3) before writing user_orgs.
    // Tests that never reach admission (bind/unbind) never hit this branch, so this is a
    // superset of the previous always-empty-rows default, not a behavior change for them.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery, { open_id: null })
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: null,
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
          open_id: null,
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
      localUserRef: 'alpha@example.com',
      adminUserId: 'admin-1',
      enableDingTalkGrant: false,
    })

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_external_identities'),
      expect.arrayContaining([
        'dingtalk',
        'union-1',
        'union-1',
        null,
        'dingcorp',
        'user-1',
      ]),
    )
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_external_auth_grants'),
      expect.anything(),
    )
    expect(result.account.localUser?.id).toBe('user-1')
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
    // W4-PRE-1: createDirectoryAdmittedUserInTransaction now resolves the admission org via
    // `SELECT org_id FROM directory_integrations WHERE id = $1` (§3.3) before writing user_orgs.
    // Tests that never reach admission (bind/unbind) never hit this branch, so this is a
    // superset of the previous always-empty-rows default, not a behavior change for them.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery)
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
    // W4-PRE-1: createDirectoryAdmittedUserInTransaction now resolves the admission org via
    // `SELECT org_id FROM directory_integrations WHERE id = $1` (§3.3) before writing user_orgs.
    // Tests that never reach admission (bind/unbind) never hit this branch, so this is a
    // superset of the previous always-empty-rows default, not a behavior change for them.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery)
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
    // W4-PRE-1: createDirectoryAdmittedUserInTransaction now resolves the admission org via
    // `SELECT org_id FROM directory_integrations WHERE id = $1` (§3.3) before writing user_orgs.
    // Tests that never reach admission (bind/unbind) never hit this branch, so this is a
    // superset of the previous always-empty-rows default, not a behavior change for them.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery)
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

  it('admits a no-email union-only DingTalk account when grant is disabled', async () => {
    // W4-PRE-1: createDirectoryAdmittedUserInTransaction now resolves the admission org via
    // `SELECT org_id FROM directory_integrations WHERE id = $1` (§3.3) before writing user_orgs.
    // Tests that never reach admission (bind/unbind) never hit this branch, so this is a
    // superset of the previous always-empty-rows default, not a behavior change for them.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery, { open_id: null })
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-admit-union-only',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691100',
          union_id: 'union-only',
          open_id: null,
          external_key: 'union-only',
          name: 'ddzz',
          email: null,
          mobile: null,
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
          directory_account_id: 'account-admit-union-only',
          external_user_id: '0447654442691100',
          union_id: 'union-only',
          open_id: null,
          external_key: 'union-only',
          account_name: 'ddzz',
          account_email: null,
          account_mobile: null,
          account_is_active: true,
          account_updated_at: '2026-04-11T08:00:00.000Z',
          link_status: 'linked',
          match_strategy: 'manual_admin',
          reviewed_by: 'admin-1',
          review_note: null,
          link_updated_at: '2026-04-11T08:00:00.000Z',
          local_user_id: 'user-created-union-only',
          local_user_email: null,
          local_user_username: 'ddzz142',
          local_user_name: 'ddzz',
          department_paths: ['DingTalk CN'],
        }],
      })

    const result = await admitDirectoryAccountUser('account-admit-union-only', {
      adminUserId: 'admin-1',
      name: 'ddzz',
      username: 'ddzz142',
      enableDingTalkGrant: false,
    })

    const createUserCall = clientQuery.mock.calls.find((entry) => String(entry[0]).includes('INSERT INTO users'))
    // W4-PRE-1b's own new prior-holder capture query ALSO starts with `SELECT local_user_id`
    // (`... FROM directory_account_links ...`) and runs BEFORE this one — disambiguate by the
    // table this ORIGINAL identity-conflict query actually reads.
    const conflictIdentityCall = clientQuery.mock.calls.find((entry) => String(entry[0]).includes('FROM user_external_identities'))
    const conflictLinkCall = clientQuery.mock.calls.find((entry) => String(entry[0]).includes('JOIN directory_accounts'))
    const linkCall = clientQuery.mock.calls.find((entry) => String(entry[0]).includes('INSERT INTO directory_account_links'))
    const membershipUpsertCall = clientQuery.mock.calls.find((entry) => String(entry[0]).includes('INSERT INTO user_orgs'))

    expect(createUserCall?.[1]).toEqual(expect.arrayContaining([
      null,
      'ddzz142',
      'ddzz',
      null,
      JSON.stringify([]),
    ]))
    expect(String(conflictIdentityCall?.[0])).toContain('$3::text IS NOT NULL')
    expect(String(conflictIdentityCall?.[0])).toContain('provider_union_id = $3::text')
    expect(String(conflictIdentityCall?.[0])).toContain('$6::text IS NOT NULL')
    expect(String(conflictIdentityCall?.[0])).toContain('external_key = $7::text')
    expect(String(conflictLinkCall?.[0])).toContain('l.directory_account_id <> $3::uuid')
    expect(String(linkCall?.[0])).toContain('VALUES ($1::uuid, $2::text')
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_external_auth_grants'),
      expect.anything(),
    )
    // W4-PRE-1b item A: the new user created here is bound in the SAME transaction — membership
    // upsert must still fire even though the DingTalk auth grant itself is disabled. The userId
    // is a fresh crypto.randomUUID() generated INSIDE the function (not mock-controllable), so
    // compare against the freshly-created user's own returned id, matching whatever createUserCall
    // actually inserted.
    expect(membershipUpsertCall?.[1]).toEqual([createUserCall?.[1]?.[0], 'default'])
    expect(result).toMatchObject({
      user: {
        email: null,
        username: 'ddzz142',
        mobile: null,
      },
      inviteToken: null,
    })
  })

  it('rejects manual admission with DingTalk grant when the directory account is missing openId', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-admit-3',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691199',
          union_id: 'union-3',
          open_id: null,
          external_key: 'union-3',
          name: '王松松',
          email: null,
          mobile: '13900007890',
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

    await expect(admitDirectoryAccountUser('account-admit-3', {
      adminUserId: 'admin-1',
      name: '王松松',
      username: 'wss142',
      mobile: '13900007890',
      enableDingTalkGrant: true,
    })).rejects.toThrow('missing DingTalk openId')

    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })

  it('removes the bound identity, optionally disables grant, and resets the link on unbind', async () => {
    // W4-PRE-1b item B: unbindDirectoryAccount now ALSO resolves the account's org and
    // deactivates the previously-linked user's user_orgs row (org-scoped sibling check) in the
    // SAME transaction — SQL-text-inspecting closure, matching this file's own established
    // precedent for the analogous bind-side change above.
    //
    // #4526 review fix: the previously-linked-user read moved INSIDE the transaction (`FOR
    // UPDATE OF l` locks the `directory_account_links` row — closes a stale-read race; see the
    // function's doc comment) — it is now served by `clientQuery`, not the outer `pgMocks.query`.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      if (String(sql).includes('FOR UPDATE OF l')) {
        return { rows: [{ local_user_id: 'user-1', local_user_email: 'alpha@example.com', local_user_name: 'Alpha' }] }
      }
      if (String(sql).includes('FROM user_external_identities') && String(sql).includes('FOR UPDATE')) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111', corp_id: 'dingcorp' }] }
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery)
    pgMocks.query
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

    const result = await unbindDirectoryAccount('account-1', {
      adminUserId: 'admin-1',
      disableDingTalkGrant: true,
    })

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_external_auth_grants'),
      ['dingtalk', 'user-1', 'admin-1'],
    )
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM user_external_identities'),
      ['dingtalk', 'user-1', 'dingcorp:open-1', 'union-1', 'open-1', 'union-1'],
    )
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM user_external_identities'),
      [['11111111-1111-4111-8111-111111111111']],
    )
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_account_links'),
      ['account-1', 'admin-1'],
    )
    // W4-PRE-1b item B: same-transaction org-scoped deactivation of the just-unbound user.
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE user_orgs'),
      ['user-1', 'default'],
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
    // W4-PRE-1b item B: see the analogous comment on the previous test. #4526 review fix: see
    // the analogous `FOR UPDATE OF l` note on the previous test too.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      if (String(sql).includes('FOR UPDATE OF l')) {
        return { rows: [{ local_user_id: 'user-1', local_user_email: 'alpha@example.com', local_user_name: 'Alpha' }] }
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery)
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

    await unbindDirectoryAccount('account-1', {
      adminUserId: 'admin-1',
      disableDingTalkGrant: true,
    })

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_external_auth_grants'),
      ['dingtalk', 'user-1', 'admin-1'],
    )
  })

  // DT-HARDEN-04: each account commits in its own transaction. A fail-fast loop threw on
  // the first bad item, so the caller never learned which items had already COMMITTED —
  // and the route, auditing only after the whole batch returned, dropped their audit trail.
  it('isolates a failing item so already-committed items are still returned (batch unbind)', async () => {
    // W4-PRE-1: createDirectoryAdmittedUserInTransaction now resolves the admission org via
    // `SELECT org_id FROM directory_integrations WHERE id = $1` (§3.3) before writing user_orgs.
    // Tests that never reach admission (bind/unbind) never hit this branch, so this is a
    // superset of the previous always-empty-rows default, not a behavior change for them.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      // #4526 review fix: the previously-linked-user read moved INSIDE the transaction
      // (`FOR UPDATE OF l`) — served here now, not via the outer `pgMocks.query`.
      if (String(sql).includes('FOR UPDATE OF l')) {
        return { rows: [{ local_user_id: 'user-1', local_user_email: 'alpha@example.com', local_user_name: 'Alpha' }] }
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery, {}, new Set(['account-2']))
    pgMocks.query
      // account-1 unbinds and reloads its summary
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-1',
          external_user_id: 'ext-1',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          account_name: '林岚',
          account_email: null,
          account_mobile: null,
          account_is_active: true,
          account_updated_at: '2026-07-08T00:00:00.000Z',
          link_status: 'unmatched',
          match_strategy: 'manual_unbound',
          reviewed_by: null,
          review_note: null,
          link_updated_at: '2026-07-08T00:00:00.000Z',
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
          department_paths: [],
        }],
      })

    const outcome = await batchUnbindDirectoryAccounts(['account-1', 'account-2'], {
      adminUserId: 'admin-1',
    })

    // The load-bearing invariant: the committed item survives the later failure.
    expect(outcome.succeeded).toHaveLength(1)
    expect(outcome.succeeded[0].account.id).toBe('account-1')
    expect(outcome.failed).toEqual([
      { accountId: 'account-2', error: expect.stringMatching(/not found/i) },
    ])
    // account-1 committed; account-2 opened its authoritative lookup transaction and failed
    // before any mutation.
    expect(pgMocks.transaction).toHaveBeenCalledTimes(2)
  })

  it('batch-admits no-email directory accounts with generated usernames and grant disabled by default', async () => {
    // W4-PRE-1: createDirectoryAdmittedUserInTransaction now resolves the admission org via
    // `SELECT org_id FROM directory_integrations WHERE id = $1` (§3.3) before writing user_orgs.
    // Tests that never reach admission (bind/unbind) never hit this branch, so this is a
    // superset of the previous always-empty-rows default, not a behavior change for them.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery)
    pgMocks.query
      // batch service preloads account-1 to derive name/username
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-bulk-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: null,
          external_key: 'union-1',
          name: '林岚',
          email: null,
          mobile: '13900001234',
        }],
      })
      // P2-1 eligibility gate: no existing directory_account_links row for account-bulk-1
      .mockResolvedValueOnce({ rows: [] })
      // P2-1 eligibility gate: no active user matches account-bulk-1's mobile
      .mockResolvedValueOnce({ rows: [] })
      // admitDirectoryAccountUser reloads account-1 + previous link
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-bulk-1',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: null,
          external_key: 'union-1',
          name: '林岚',
          email: null,
          mobile: '13900001234',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ local_user_id: null, local_user_email: null, local_user_username: null, local_user_name: null }] })
      // summary reload
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-bulk-1',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: null,
          external_key: 'union-1',
          account_name: '林岚',
          account_email: null,
          account_mobile: '13900001234',
          account_is_active: true,
          account_updated_at: '2026-07-08T00:00:00.000Z',
          link_status: 'linked',
          match_strategy: 'manual_admin',
          reviewed_by: 'admin-1',
          review_note: null,
          link_updated_at: '2026-07-08T00:00:00.000Z',
          local_user_id: 'user-created',
          local_user_email: null,
          local_user_username: 'dt_0447654442691174_accountb',
          local_user_name: '林岚',
          department_paths: ['DingTalk CN'],
        }],
      })
      // account-2 does not exist → second item fails without affecting account-1
      .mockResolvedValueOnce({ rows: [] })

    const outcome = await batchAdmitDirectoryAccountUsers(['account-bulk-1', 'account-missing'], {
      adminUserId: 'admin-1',
    })

    expect(outcome.succeeded).toHaveLength(1)
    expect(outcome.failed).toEqual([
      { accountId: 'account-missing', error: expect.stringMatching(/not found/i) },
    ])
    const createUserCall = clientQuery.mock.calls.find((entry) => String(entry[0]).includes('INSERT INTO users'))
    const createdUserId = Array.isArray(createUserCall?.[1]) ? String(createUserCall?.[1]?.[0] || '') : ''
    expect(createUserCall?.[1]).toEqual(expect.arrayContaining([
      null,
      'dt_0447654442691174_accountb',
      '林岚',
      '13900001234',
      JSON.stringify([]),
    ]))
    expect(clientQuery.mock.calls.some((entry) => String(entry[0]).includes('INSERT INTO user_external_auth_grants'))).toBe(false)
    expect(outcome.succeeded[0]).toMatchObject({
      account: {
        id: 'account-bulk-1',
      },
      user: {
        id: createdUserId,
        email: null,
        username: 'dt_0447654442691174_accountb',
        mobile: '13900001234',
      },
      inviteToken: null,
    })
    expect(outcome.succeeded[0].temporaryPassword).toMatch(/^Tmp-/)
    expect(pgMocks.transaction).toHaveBeenCalledTimes(1)
    expect(inviteLedgerMocks.recordInvite).not.toHaveBeenCalled()
  })

  // P2-1 (post-#3972 review): a direct batch-admit call bypasses the UI's "no recommendation
  // candidate" filter. The server must reject an account whose email case-insensitively
  // matches an existing active user, instead of creating a duplicate `users` row.
  it('rejects batch-admit for an account whose email case-insensitively matches an existing user', async () => {
    pgMocks.transaction.mockImplementation(async () => {
      throw new Error('transaction should not open for an ineligible account')
    })
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-case-mismatch',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691175',
          union_id: 'union-2',
          open_id: null,
          external_key: 'union-2',
          name: 'Alice',
          email: 'alice@x.com',
          mobile: null,
        }],
      })
      // P2-1 eligibility gate: no existing directory_account_links row
      .mockResolvedValueOnce({ rows: [] })
      // P2-1 eligibility gate: an active user already matches this email case-insensitively
      .mockResolvedValueOnce({ rows: [{ id: 'user-existing' }] })

    const outcome = await batchAdmitDirectoryAccountUsers(['account-case-mismatch'], {
      adminUserId: 'admin-1',
    })

    expect(outcome.succeeded).toEqual([])
    expect(outcome.failed).toEqual([
      { accountId: 'account-case-mismatch', error: expect.stringMatching(/already exists/i) },
    ])
    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })

  // P2-1: an account already linked to a local user must not be silently re-admitted into a
  // brand new user (which would orphan the existing link).
  it('rejects batch-admit for an account already linked to a local user', async () => {
    pgMocks.transaction.mockImplementation(async () => {
      throw new Error('transaction should not open for an ineligible account')
    })
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'account-already-linked',
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          external_user_id: '0447654442691176',
          union_id: 'union-3',
          open_id: null,
          external_key: 'union-3',
          name: 'Bob',
          email: null,
          mobile: null,
        }],
      })
      // P2-1 eligibility gate: this account is already linked
      .mockResolvedValueOnce({ rows: [{ link_status: 'linked', local_user_id: 'user-existing' }] })

    const outcome = await batchAdmitDirectoryAccountUsers(['account-already-linked'], {
      adminUserId: 'admin-1',
    })

    expect(outcome.succeeded).toEqual([])
    expect(outcome.failed).toEqual([
      { accountId: 'account-already-linked', error: expect.stringMatching(/already linked/i) },
    ])
    expect(pgMocks.transaction).not.toHaveBeenCalled()
  })

  // DT-HARDEN-04: symmetric to the batch-unbind isolation test above. A fail-fast bind
  // loop would abort the whole batch on the first bad item, so a valid bind earlier in
  // the batch would never be reported (or even attempted, once the batch is reordered).
  it('isolates a failing item so already-committed items are still returned (batch bind)', async () => {
    // W4-PRE-1: createDirectoryAdmittedUserInTransaction now resolves the admission org via
    // `SELECT org_id FROM directory_integrations WHERE id = $1` (§3.3) before writing user_orgs.
    // Tests that never reach admission (bind/unbind) never hit this branch, so this is a
    // superset of the previous always-empty-rows default, not a behavior change for them.
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT org_id\s+FROM directory_integrations/.test(String(sql))) {
        return { rows: [{ org_id: 'default' }] }
      }
      return { rows: [] }
    })
    installTransactionMock(clientQuery)
    pgMocks.query
      // account-1: loads with no previous link, resolves the local user, binds, and reloads its summary
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
          account_updated_at: '2026-07-08T00:00:00.000Z',
          link_status: 'linked',
          match_strategy: 'manual_admin',
          reviewed_by: 'admin-1',
          review_note: null,
          link_updated_at: '2026-07-08T00:00:00.000Z',
          local_user_id: 'user-1',
          local_user_email: 'alpha@example.com',
          local_user_name: 'Alpha',
          department_paths: ['DingTalk CN'],
        }],
      })
      // account-2 does not exist → bindDirectoryAccount throws before ever opening a transaction
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const outcome = await batchBindDirectoryAccounts([
      { accountId: 'account-1', localUserRef: 'alpha@example.com', enableDingTalkGrant: true },
      { accountId: 'account-2', localUserRef: 'beta@example.com', enableDingTalkGrant: true },
    ], { adminUserId: 'admin-1' })

    // The load-bearing invariant: the committed bind survives the later failure.
    expect(outcome.succeeded).toHaveLength(1)
    expect(outcome.succeeded[0].account.id).toBe('account-1')
    expect(outcome.failed).toEqual([
      { accountId: 'account-2', error: expect.stringMatching(/not found/i) },
    ])
    // account-1 really did commit (its transaction ran); account-2 never opened one.
    expect(pgMocks.transaction).toHaveBeenCalledTimes(1)
  })
})
