import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const clientMocks = vi.hoisted(() => ({
  exchangeCodeForUserAccessToken: vi.fn(),
  fetchDingTalkCurrentUser: vi.fn(),
  fetchDingTalkAppAccessToken: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
  getDingTalkUserInfoByAuthCode: vi.fn(),
  isDingTalkConfigured: vi.fn(),
  readDingTalkOauthConfig: vi.fn(),
}))

vi.mock('ioredis', () => {
  class MockRedis {
    constructor(_url: string, _opts: Record<string, unknown>) {}
    async connect() {}
    on(_event: string, _cb: (...args: unknown[]) => void) {}
    async quit() {}
    disconnect() {}
  }

  return { default: MockRedis }
})

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  exchangeCodeForUserAccessToken: clientMocks.exchangeCodeForUserAccessToken,
  fetchDingTalkCurrentUser: clientMocks.fetchDingTalkCurrentUser,
  fetchDingTalkAppAccessToken: clientMocks.fetchDingTalkAppAccessToken,
  getDingTalkUserDetail: clientMocks.getDingTalkUserDetail,
  getDingTalkUserInfoByAuthCode: clientMocks.getDingTalkUserInfoByAuthCode,
  isDingTalkConfigured: clientMocks.isDingTalkConfigured,
  readDingTalkOauthConfig: clientMocks.readDingTalkOauthConfig,
}))

import {
  __resetDingTalkOAuthStateStoreForTests,
  bindDingTalkIdentityToUser,
  exchangeCodeForUser,
  exchangeEnterpriseAuthCodeForUser,
  getDingTalkRuntimeStatus,
} from '../../src/auth/dingtalk-oauth'

function createDefaultTransactionQuery() {
  return vi.fn(async (sql: string, params: unknown[] = []) => {
    const statement = String(sql)
    if (/FROM users[\s\S]*FOR UPDATE/i.test(statement)) {
      return {
        rows: [{
          id: String(params[0]),
          name: 'Alpha',
          email: 'alpha@example.com',
          username: null,
          mobile: '13800000000',
          activation_status: 'activated',
          is_active: true,
          access_generation: 0,
        }],
      }
    }
    if (/INSERT INTO user_external_identities/i.test(statement)) {
      return { rows: [{ id: 'identity-new' }] }
    }
    if (/INSERT INTO user_external_auth_grants/i.test(statement)) {
      return { rows: [{ local_user_id: String(params[1]) }] }
    }
    if (/UPDATE users[\s\S]*access_generation/i.test(statement)) {
      return { rows: [{ access_generation: 1 }] }
    }
    return { rows: [] }
  })
}

describe('dingtalk oauth login gates', () => {
  beforeEach(async () => {
    vi.unstubAllEnvs()
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
    clientMocks.exchangeCodeForUserAccessToken.mockReset()
    clientMocks.fetchDingTalkCurrentUser.mockReset()
    clientMocks.isDingTalkConfigured.mockReset()
    clientMocks.readDingTalkOauthConfig.mockReset()
    clientMocks.exchangeCodeForUserAccessToken.mockResolvedValue({ accessToken: 'dt-access-token' })
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({
      openId: 'open-1',
      unionId: 'union-1',
      nick: 'Alpha',
      email: 'alpha@example.com',
      mobile: '13800000000',
      avatarUrl: '',
    })
    clientMocks.fetchDingTalkAppAccessToken.mockReset()
    clientMocks.getDingTalkUserDetail.mockReset()
    clientMocks.getDingTalkUserInfoByAuthCode.mockReset()
    clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('app-token')
    clientMocks.getDingTalkUserInfoByAuthCode.mockResolvedValue({
      userId: 'emp-1',
      unionId: undefined,
      source: {},
    })
    clientMocks.getDingTalkUserDetail.mockResolvedValue({
      userId: 'emp-1',
      name: 'Alpha',
      unionId: 'union-1',
      email: 'alpha@example.com',
      mobile: '13800000000',
      avatarUrl: '',
      departmentIds: [],
      source: {},
    })
    clientMocks.readDingTalkOauthConfig.mockReturnValue({
      clientId: 'dt-client',
      clientSecret: 'dt-secret',
      redirectUri: 'https://app.example.com/login/dingtalk/callback',
      corpId: 'ding-corp',
      baseUrl: 'https://oapi.dingtalk.com',
    })
    pgMocks.transaction.mockImplementation(
      async (callback: (client: { query: typeof pgMocks.query }) => Promise<unknown>) =>
        callback({
          query: createDefaultTransactionQuery() as unknown as typeof pgMocks.query,
        }),
    )
    await __resetDingTalkOAuthStateStoreForTests()
  })

  it('rejects email-linked login when strict grant mode is enabled and no grant exists', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          activation_status: 'activated',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    await expect(exchangeCodeForUser('code-1')).rejects.toMatchObject({
      name: 'DingTalkLoginPolicyError',
      statusCode: 403,
      code: 'grant_required',
      message: 'DingTalk login is not enabled for this user',
    })
  })

  it('bootstraps a missing openId for an existing union-linked identity before strict grant rejection', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    const txCalls: Array<{ sql: string; params: unknown[] }> = []
    pgMocks.transaction.mockImplementation(async (callback: (client: { query: typeof pgMocks.query }) => Promise<unknown>) => {
      const fallback = createDefaultTransactionQuery()
      const txQuery = vi.fn(async (sql: string, params: unknown[]) => {
        txCalls.push({ sql: String(sql), params })
        if (String(sql).includes('SELECT local_user_id')) return { rows: [] }
        return fallback(sql, params)
      })
      return callback({ query: txQuery as unknown as typeof pgMocks.query })
    })
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          activation_status: 'activated',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    await expect(exchangeCodeForUser('code-openid-bootstrap')).rejects.toMatchObject({
      name: 'DingTalkLoginPolicyError',
      statusCode: 403,
      code: 'grant_required',
      message: 'DingTalk login is not enabled for this user',
    })

    const update = txCalls.find(call => call.sql.includes('UPDATE user_external_identities'))
    expect(update, 'expected rejected login to enrich the missing openId').toBeTruthy()
    expect(update!.sql).toContain('provider_open_id = $5')
    expect(update!.sql).not.toContain('last_login_at')
    expect(update!.sql).toContain("COALESCE(provider_open_id, '') = ''")
    expect(update!.params).toEqual([
      'dingtalk',
      'user-1',
      'ding-corp:open-1',
      'union-1',
      'open-1',
      'ding-corp',
      expect.stringContaining('"openId":"open-1"'),
    ])
  })

  it('does not bootstrap openId when the OAuth identity already belongs to another local user', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    const txCalls: Array<{ sql: string; params: unknown[] }> = []
    pgMocks.transaction.mockImplementation(async (callback: (client: { query: typeof pgMocks.query }) => Promise<unknown>) => {
      const fallback = createDefaultTransactionQuery()
      const txQuery = vi.fn(async (sql: string, params: unknown[]) => {
        txCalls.push({ sql: String(sql), params })
        if (String(sql).includes('SELECT local_user_id')) {
          return { rows: [{ local_user_id: 'other-user' }] }
        }
        return fallback(sql, params)
      })
      return callback({ query: txQuery as unknown as typeof pgMocks.query })
    })
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          activation_status: 'activated',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    await expect(exchangeCodeForUser('code-openid-conflict')).rejects.toMatchObject({
      name: 'DingTalkLoginPolicyError',
      statusCode: 409,
      code: 'identity_already_bound',
    })

    expect(txCalls.some(call => call.sql.includes('UPDATE user_external_identities'))).toBe(false)
  })

  it('allows email-linked login when strict grant mode is enabled and grant is present', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          activation_status: 'activated',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ enabled: true }] })

    const result = await exchangeCodeForUser('code-2')

    expect(result).toMatchObject({
      localUserId: 'user-1',
      localUserEmail: 'alpha@example.com',
      isNewUser: false,
    })
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO user_external_auth_grants'))).toBe(false)
  })

  it('disables auto-provision when strict grant mode is enabled', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '1')
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({
      openId: 'open-2',
      unionId: 'union-2',
      nick: 'Beta',
      email: 'beta@example.com',
      mobile: '13900000000',
      avatarUrl: '',
    })
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    await expect(exchangeCodeForUser('code-3')).rejects.toMatchObject({
      name: 'DingTalkLoginPolicyError',
      statusCode: 403,
      code: 'unlinked_enabled_local_user',
      message: 'DingTalk account beta@example.com is not linked to an enabled local user',
    })
  })

  it('refuses auto-provision when DINGTALK_ALLOWED_CORP_IDS is unset (unscoped allowlist guard, DT-HARDEN-09)', async () => {
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '1')
    // DINGTALK_ALLOWED_CORP_IDS deliberately left unset: isDingTalkCorpAllowed
    // is permissive when empty, so auto-provision must refuse to create a
    // local user rather than silently onboard any corp's OAuth user.
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] }) // findIdentityUser: no existing identity link

    await expect(exchangeCodeForUser('code-4')).rejects.toMatchObject({
      name: 'DingTalkLoginPolicyError',
      statusCode: 403,
      code: 'unlinked_local_user',
      message: 'DingTalk account alpha@example.com is not linked to a local user',
    })
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO users'))).toBe(false)
  })

  it('auto-provisions a local user when DINGTALK_ALLOWED_CORP_IDS is configured (existing behavior unaffected)', async () => {
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '1')
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', 'ding-corp')
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] }) // findIdentityUser: no existing identity link
      .mockResolvedValueOnce({ rows: [] }) // findUserByEmail: no conflicting local account
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-new',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          activation_status: 'activated',
        }],
      }) // INSERT INTO users

    const result = await exchangeCodeForUser('code-5')

    expect(result).toMatchObject({
      localUserId: 'user-new',
      localUserEmail: 'alpha@example.com',
      isNewUser: true,
    })
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO users'))).toBe(true)
  })

  it('does not supersede evidence for an idempotent explicit bind', async () => {
    const txCalls: Array<{ sql: string; params: unknown[] }> = []
    pgMocks.transaction.mockImplementation(async (callback: (client: { query: typeof pgMocks.query }) => Promise<unknown>) => {
      const fallback = createDefaultTransactionQuery()
      const txQuery = vi.fn(async (sql: string, params: unknown[]) => {
        const statement = String(sql)
        txCalls.push({ sql: statement, params })
        if (statement.includes('SELECT local_user_id')) return { rows: [] }
        if (
          statement.includes('SELECT id,')
          && statement.includes('FROM user_external_identities')
        ) {
          return {
            rows: [{
              id: 'identity-1',
              external_key: 'ding-corp:open-1',
              provider_union_id: 'union-1',
              provider_open_id: 'open-1',
              corp_id: 'ding-corp',
            }],
          }
        }
        if (statement.includes('INSERT INTO user_external_auth_grants')) {
          return { rows: [] }
        }
        return fallback(sql, params)
      })
      return callback({ query: txQuery as unknown as typeof pgMocks.query })
    })

    await bindDingTalkIdentityToUser({
      localUserId: 'user-1',
      boundBy: 'user-1',
      enableGrant: true,
      dtUser: {
        openId: 'open-1',
        unionId: 'union-1',
        nick: 'Alpha',
      },
    })

    expect(txCalls.some((call) => call.sql.includes('UPDATE user_external_identities'))).toBe(true)
    expect(txCalls.some((call) => call.sql.includes('UPDATE directory_deprovision_events'))).toBe(false)
    expect(txCalls.some((call) => /UPDATE users[\s\S]*access_generation/.test(call.sql))).toBe(false)
  })

  it('supersedes evidence when an explicit bind changes the canonical identity', async () => {
    const txCalls: Array<{ sql: string; params: unknown[] }> = []
    pgMocks.transaction.mockImplementation(async (callback: (client: { query: typeof pgMocks.query }) => Promise<unknown>) => {
      const fallback = createDefaultTransactionQuery()
      const txQuery = vi.fn(async (sql: string, params: unknown[]) => {
        const statement = String(sql)
        txCalls.push({ sql: statement, params })
        if (statement.includes('SELECT local_user_id')) return { rows: [] }
        if (
          statement.includes('SELECT id,')
          && statement.includes('FROM user_external_identities')
        ) {
          return {
            rows: [{
              id: 'identity-1',
              external_key: 'ding-corp:old-open',
              provider_union_id: 'old-union',
              provider_open_id: 'old-open',
              corp_id: 'ding-corp',
            }],
          }
        }
        if (statement.includes('INSERT INTO user_external_auth_grants')) {
          return { rows: [] }
        }
        return fallback(sql, params)
      })
      return callback({ query: txQuery as unknown as typeof pgMocks.query })
    })

    await bindDingTalkIdentityToUser({
      localUserId: 'user-1',
      boundBy: 'admin-1',
      enableGrant: true,
      dtUser: {
        openId: 'open-1',
        unionId: 'union-1',
        nick: 'Alpha',
      },
    })

    const lockIndex = txCalls.findIndex((call) => /FROM users[\s\S]*FOR UPDATE/.test(call.sql))
    const identityWriteIndex = txCalls.findIndex((call) => call.sql.includes('UPDATE user_external_identities'))
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(identityWriteIndex).toBeGreaterThan(lockIndex)
    expect(txCalls.some((call) => call.sql.includes('UPDATE directory_deprovision_events'))).toBe(true)
    expect(txCalls.some((call) => call.sql.includes('access_generation = COALESCE'))).toBe(true)
  })

  it('reports runtime status with grant mode and allowlist details', () => {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'dt-client')
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'dt-secret')
    vi.stubEnv('DINGTALK_REDIRECT_URI', 'https://app.example.com/login/dingtalk/callback')
    vi.stubEnv('DINGTALK_CORP_ID', 'ding-corp')
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', 'ding-corp, ding-corp-2')
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '0')
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '0')

    expect(getDingTalkRuntimeStatus()).toEqual({
      configured: true,
      available: true,
      corpId: 'ding-corp',
      allowedCorpIds: ['ding-corp', 'ding-corp-2'],
      requireGrant: true,
      autoLinkEmail: false,
      autoProvision: false,
      unavailableReason: null,
    })
  })

  it('reports a machine-friendly reason when corpId is blocked by the allowlist', () => {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'dt-client')
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'dt-secret')
    vi.stubEnv('DINGTALK_REDIRECT_URI', 'https://app.example.com/login/dingtalk/callback')
    vi.stubEnv('DINGTALK_CORP_ID', 'ding-corp-blocked')
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', 'ding-corp-allowed')

    expect(getDingTalkRuntimeStatus()).toMatchObject({
      configured: true,
      available: false,
      corpId: 'ding-corp-blocked',
      allowedCorpIds: ['ding-corp-allowed'],
      unavailableReason: 'corp_not_allowed',
    })
  })

  describe('E1 exchangeEnterpriseAuthCodeForUser (container 免登)', () => {
    it('resolves via unionId (user/get fallback) and applies the grant gate identically', async () => {
      vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
      vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
      pgMocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
            activation_status: 'activated',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ enabled: true }] })

      const result = await exchangeEnterpriseAuthCodeForUser('auth-code-1')

      expect(clientMocks.fetchDingTalkAppAccessToken).toHaveBeenCalledTimes(1)
      expect(clientMocks.getDingTalkUserInfoByAuthCode).toHaveBeenCalledWith('app-token', 'auth-code-1', expect.anything())
      expect(clientMocks.getDingTalkUserDetail).toHaveBeenCalledWith('app-token', 'emp-1', expect.anything())
      expect(clientMocks.exchangeCodeForUserAccessToken).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        localUserId: 'user-1',
        localUserEmail: 'alpha@example.com',
        isNewUser: false,
      })
      expect(result.dingtalkUser.unionId).toBe('union-1')
      expect(result.dingtalkUser.openId).toBeUndefined()
    })

    it('upsert is non-destructive for the container surface (hasOpenId=false, openId param null)', async () => {
      vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
      vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
      const txCalls: Array<{ sql: string; params: unknown[] }> = []
      pgMocks.transaction.mockImplementation(async (callback: (client: { query: typeof pgMocks.query }) => Promise<unknown>) => {
        const fallback = createDefaultTransactionQuery()
        const txQuery = vi.fn(async (sql: string, params: unknown[]) => {
          txCalls.push({ sql: String(sql), params })
          if (
            String(sql).includes('SELECT id,')
            && String(sql).includes('FROM user_external_identities')
          ) {
            return {
              rows: [{
                id: 'identity-1',
                external_key: 'ding-corp:union-1',
                provider_union_id: 'union-1',
                provider_open_id: null,
                corp_id: 'ding-corp',
              }],
            }
          }
          return fallback(sql, params)
        })
        return callback({ query: txQuery as unknown as typeof pgMocks.query })
      })
      pgMocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
            activation_status: 'activated',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ enabled: true }] })

      await exchangeEnterpriseAuthCodeForUser('auth-code-2')

      const update = txCalls.find(call => call.sql.includes('UPDATE user_external_identities'))
      expect(update, 'expected identity UPDATE').toBeTruthy()
      expect(update!.sql).toContain('CASE WHEN $8::boolean')
      expect(update!.params[4]).toBeNull()
      expect(update!.params[7]).toBe(false)
    })

    it('supersedes evidence when a container login fills a previously missing corp scope', async () => {
      vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
      vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
      const txCalls: Array<{ sql: string; params: unknown[] }> = []
      pgMocks.transaction.mockImplementation(async (callback: (client: { query: typeof pgMocks.query }) => Promise<unknown>) => {
        const fallback = createDefaultTransactionQuery()
        const txQuery = vi.fn(async (sql: string, params: unknown[]) => {
          const statement = String(sql)
          txCalls.push({ sql: statement, params })
          if (
            statement.includes('SELECT id,')
            && statement.includes('FROM user_external_identities')
          ) {
            return {
              rows: [{
                id: 'identity-1',
                external_key: 'ding-corp:union-1',
                provider_union_id: 'union-1',
                provider_open_id: null,
                corp_id: null,
              }],
            }
          }
          return fallback(sql, params)
        })
        return callback({ query: txQuery as unknown as typeof pgMocks.query })
      })
      pgMocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
            activation_status: 'activated',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ enabled: true }] })

      await exchangeEnterpriseAuthCodeForUser('auth-code-corp-fill')

      expect(
        txCalls.some((call) =>
          call.sql.includes('UPDATE directory_deprovision_events')),
      ).toBe(true)
      expect(
        txCalls.some((call) =>
          /UPDATE users[\s\S]*access_generation/.test(call.sql)),
      ).toBe(true)
    })

    it('proceeds on user/get failure when getuserinfo already carried unionid', async () => {
      vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
      clientMocks.getDingTalkUserInfoByAuthCode.mockResolvedValue({ userId: 'emp-2', unionId: 'union-9', source: {} })
      clientMocks.getDingTalkUserDetail.mockRejectedValue(new Error('boom'))
      pgMocks.query
        .mockResolvedValueOnce({
          rows: [{
            id: 'user-9',
            email: 'nine@example.com',
            name: 'Nine',
            role: 'user',
            is_active: true,
            activation_status: 'activated',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ enabled: true }] })

      const result = await exchangeEnterpriseAuthCodeForUser('auth-code-3')
      expect(result.dingtalkUser.unionId).toBe('union-9')
      expect(result.dingtalkUser.nick).toBe('dingtalk-emp-2')
    })

    it('hard-fails with identity_key_unavailable when no unionId can be resolved', async () => {
      clientMocks.getDingTalkUserInfoByAuthCode.mockResolvedValue({ userId: 'emp-3', unionId: undefined, source: {} })
      clientMocks.getDingTalkUserDetail.mockResolvedValue({
        userId: 'emp-3', name: 'NoUnion', unionId: undefined, departmentIds: [], source: {},
      })

      await expect(exchangeEnterpriseAuthCodeForUser('auth-code-4')).rejects.toMatchObject({
        name: 'DingTalkLoginPolicyError',
        statusCode: 502,
        code: 'identity_key_unavailable',
      })
      expect(pgMocks.query).not.toHaveBeenCalled()
    })

    it('keeps the unlinked gate semantics for container logins', async () => {
      vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
      pgMocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })

      await expect(exchangeEnterpriseAuthCodeForUser('auth-code-5')).rejects.toMatchObject({
        name: 'DingTalkLoginPolicyError',
        statusCode: 403,
      })
    })
  })
})
