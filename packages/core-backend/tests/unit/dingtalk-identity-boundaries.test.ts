import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }))
const clientMocks = vi.hoisted(() => ({
  exchangeCodeForUserAccessToken: vi.fn(), fetchDingTalkCurrentUser: vi.fn(),
  fetchDingTalkAppAccessToken: vi.fn(), getDingTalkUserDetail: vi.fn(),
  getDingTalkUserInfoByAuthCode: vi.fn(), isDingTalkConfigured: vi.fn(),
  readDingTalkOauthConfig: vi.fn(),
}))
vi.mock('../../src/db/pg', () => pgMocks)
vi.mock('../../src/integrations/dingtalk/client', () => clientMocks)

import { bindDingTalkIdentityToUser, exchangeCodeForUser } from '../../src/auth/dingtalk-oauth'

const ID = 'synthetic-boundary-user'
const profile = { openId: 'synthetic-open', unionId: 'synthetic-union', nick: 'Synthetic', email: 'boundary@example.test' }
let user: Record<string, unknown>
let grantEnabled: boolean | undefined
let managed: boolean
let failGrantRead: boolean
const writes: string[] = []
const txQuery = vi.fn(async (sql: string) => {
  if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes.push(sql)
  if (/FROM users\b/i.test(sql)) return { rows: [user] }
  if (/FROM directory_account_links\b/i.test(sql)) return { rows: managed ? [{ linked: 1 }] : [] }
  if (/FROM user_external_auth_grants\b/i.test(sql)) {
    if (failGrantRead) throw new Error('simulated grant read failure')
    return { rows: grantEnabled === undefined ? [] : [{ enabled: grantEnabled }] }
  }
  if (/INSERT INTO user_external_identities\b/i.test(sql)) return { rows: [{ id: 'synthetic-identity' }] }
  if (/INSERT INTO user_external_auth_grants\b/i.test(sql)) return { rows: [{ local_user_id: ID }] }
  if (/UPDATE users[\s\S]*access_generation/i.test(sql)) return { rows: [{ access_generation: 1 }] }
  return { rows: [] }
})

function bind() {
  return bindDingTalkIdentityToUser({ localUserId: ID, boundBy: ID, enableGrant: true, dtUser: profile })
}

describe('DingTalk identity write-boundary policy', () => {
  beforeEach(() => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '0')
    user = {
      id: ID, email: profile.email, name: 'Synthetic', role: 'user', is_active: true,
      activation_status: 'activated', access_generation: 0, username: null, mobile: null,
    }
    grantEnabled = true
    managed = false
    failGrantRead = false
    writes.length = 0
    txQuery.mockClear()
    pgMocks.query.mockReset().mockImplementation(async (sql: string) => {
      if (/FROM user_external_identities\b/i.test(sql)) return { rows: [] }
      if (/FROM users\b/i.test(sql)) return { rows: [user] }
      if (/FROM user_external_auth_grants\b/i.test(sql)) return { rows: [{ enabled: true }] }
      return { rows: [] }
    })
    pgMocks.transaction.mockReset().mockImplementation(async (callback: (client: { query: typeof txQuery }) => Promise<unknown>) => callback({ query: txQuery }))
    clientMocks.readDingTalkOauthConfig.mockReturnValue({
      clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
      corpId: 'synthetic-corp', redirectUri: 'https://example.test/callback',
    })
    clientMocks.exchangeCodeForUserAccessToken.mockResolvedValue({ accessToken: 'synthetic-token' })
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue(profile)
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each(['1', '0'])('self-bind honors an explicit disabled grant in require-grant mode %s', async mode => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', mode)
    grantEnabled = false
    await expect(bind()).rejects.toMatchObject({ statusCode: 403, code: 'grant_disabled' })
    expect(writes).toEqual([])
  })

  it('self-bind refuses a current managed-directory association before any write', async () => {
    managed = true
    await expect(bind()).rejects.toMatchObject({ statusCode: 409, code: 'directory_managed_identity' })
    expect(writes).toEqual([])
  })

  it.each([
    { change: { is_active: false }, code: 'local_user_disabled' },
    { change: { role: 'disabled' }, code: 'local_user_disabled' },
    { change: { activation_status: 'pending_activation' }, code: 'ACCOUNT_PENDING_ACTIVATION' },
    { change: { activation_status: 'unexpected_status' }, code: 'ACCOUNT_ACTIVATION_INVALID' },
  ])('self-bind respects the current account gate: $change', async ({ change, code }) => {
    Object.assign(user, change)
    await expect(bind()).rejects.toMatchObject({ statusCode: 403, code })
    expect(writes).toEqual([])
  })

  it('ambiguous lookup returns a values-free policy error without email fallback or writes', async () => {
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '1')
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', 'synthetic-corp')
    clientMocks.readDingTalkOauthConfig.mockReturnValue({ corpId: null })
    pgMocks.query.mockResolvedValue({ rows: [user, { ...user, id: 'synthetic-other', role: 'admin' }] })
    const error = await exchangeCodeForUser('synthetic-code').catch(value => value)
    expect({ statusCode: error.statusCode, code: error.code, message: error.message }).toEqual({
      statusCode: 409, code: 'identity_ambiguous',
      message: 'DingTalk identity matches multiple accounts; configure the intended enterprise',
    })
    expect(pgMocks.query).toHaveBeenCalledTimes(1)
    expect(pgMocks.transaction).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('self-bind fails closed when its in-transaction grant read fails', async () => {
    failGrantRead = true
    await expect(bind()).rejects.toMatchObject({ statusCode: 503, code: 'grant_state_unavailable' })
    expect(writes).toEqual([])
  })

  it('email association uses the transaction grant read even after its earlier authorization succeeds', async () => {
    failGrantRead = true
    await expect(exchangeCodeForUser('synthetic-code')).rejects.toMatchObject({ statusCode: 503, code: 'grant_state_unavailable' })
    expect(writes).toEqual([])
  })
})
