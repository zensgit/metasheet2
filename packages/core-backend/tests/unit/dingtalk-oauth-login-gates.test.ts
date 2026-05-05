import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const clientMocks = vi.hoisted(() => ({
  exchangeCodeForUserAccessToken: vi.fn(),
  fetchDingTalkCurrentUser: vi.fn(),
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
  isDingTalkConfigured: clientMocks.isDingTalkConfigured,
  readDingTalkOauthConfig: clientMocks.readDingTalkOauthConfig,
}))

import {
  __resetDingTalkOAuthStateStoreForTests,
  exchangeCodeForUser,
  getDingTalkRuntimeStatus,
} from '../../src/auth/dingtalk-oauth'

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
    clientMocks.readDingTalkOauthConfig.mockReturnValue({
      clientId: 'dt-client',
      clientSecret: 'dt-secret',
      redirectUri: 'https://app.example.com/login/dingtalk/callback',
      corpId: 'ding-corp',
      baseUrl: 'https://oapi.dingtalk.com',
    })
    pgMocks.transaction.mockImplementation(async (callback: (client: { query: typeof pgMocks.query }) => Promise<unknown>) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
      return callback({ query: txQuery })
    })
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
})
