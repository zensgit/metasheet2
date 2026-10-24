import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A DingTalk login proves the person's openId; the directory member row of the same person
 * (same corp, same unionId) must learn it so the directory page can grant DingTalk login.
 * The backfill is best effort: it must never fail or block the login.
 */

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

import { __resetDingTalkOAuthStateStoreForTests, exchangeCodeForUser } from '../../src/auth/dingtalk-oauth'

type Call = { sql: string; params: unknown[] }

const IDENTITY_USER = {
  id: 'user-1',
  email: 'alpha@example.com',
  name: 'Alpha',
  role: 'user',
  is_active: true,
  activation_status: 'activated',
}

function installTransaction(options: { failBackfill?: boolean; failRollback?: boolean; failSavepoint?: boolean } = {}): Call[] {
  const calls: Call[] = []
  pgMocks.transaction.mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => callback({
    query: async (sql: string, params: unknown[] = []) => {
      const statement = String(sql)
      calls.push({ sql: statement, params })
      if (/FROM users[\s\S]*FOR UPDATE/i.test(statement)) {
        return {
          rows: [{
            id: String(params[0]),
            name: 'Alpha',
            email: 'alpha@example.com',
            username: null,
            mobile: null,
            activation_status: 'activated',
            is_active: true,
            access_generation: 0,
          }],
        }
      }
      if (/SELECT COALESCE\(role[\s\S]*FROM users/i.test(statement)) return { rows: [IDENTITY_USER] }
      if (/SELECT enabled[\s\S]*FROM user_external_auth_grants/i.test(statement)) return { rows: [{ enabled: true }] }
      if (/SELECT id,[\s\S]*FROM user_external_identities/i.test(statement)) {
        const corpId = clientMocks.readDingTalkOauthConfig().corpId
        return { rows: [{
          id: 'identity-1', external_key: corpId ? `${corpId}:union-1` : 'union-1',
          provider_union_id: 'union-1', provider_open_id: null, corp_id: corpId || null,
        }] }
      }
      if (/UPDATE users[\s\S]*access_generation/i.test(statement)) return { rows: [{ access_generation: 1 }] }
      if (/INSERT INTO user_external_identities/i.test(statement)) return { rows: [{ id: 'identity-new' }] }
      if (options.failSavepoint && /^SAVEPOINT /.test(statement)) {
        throw new Error('current transaction is aborted')
      }
      if (options.failRollback && /^ROLLBACK TO SAVEPOINT /.test(statement)) {
        throw new Error('connection terminated')
      }
      if (options.failBackfill && statement.includes('UPDATE directory_accounts')) {
        throw new Error('canceling statement due to lock timeout')
      }
      return { rows: [] }
    },
  }))
  return calls
}

function backfillCall(calls: Call[]): Call | undefined {
  return calls.find((call) => call.sql.includes('UPDATE directory_accounts'))
}

function expectScopedBackfill(call: Call | undefined): void {
  expect(call, 'expected the login to backfill the directory member openId').toBeTruthy()
  const sql = call!.sql.replace(/\s+/g, ' ')
  expect(sql).toContain('candidate.provider = $1')
  expect(sql).toContain('candidate.corp_id = $2')
  expect(sql).toContain('candidate.union_id = $3')
  expect(sql).toContain("COALESCE(candidate.open_id, '') = ''")
  expect(sql).toContain('FOR UPDATE SKIP LOCKED')
  expect(call!.params).toEqual(['dingtalk', 'ding-corp', 'union-1', 'open-1'])
}

describe('DingTalk login backfills the directory member openId', () => {
  beforeEach(async () => {
    vi.unstubAllEnvs()
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
    clientMocks.exchangeCodeForUserAccessToken.mockReset()
    clientMocks.fetchDingTalkCurrentUser.mockReset()
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
    await __resetDingTalkOAuthStateStoreForTests()
  })

  it('a successful login writes the openId into the same corp+union directory member, in the identity transaction', async () => {
    const calls = installTransaction()
    pgMocks.query
      .mockResolvedValueOnce({ rows: [IDENTITY_USER] }) // findIdentityUser: HIT
      .mockResolvedValueOnce({ rows: [{ enabled: true }] }) // readGrantState

    const result = await exchangeCodeForUser('code-backfill')
    expect(result.localUserId).toBe('user-1')

    expectScopedBackfill(backfillCall(calls))
    // behind a savepoint, after the identity write, released on success
    const savepointIndex = calls.findIndex((call) => /^SAVEPOINT /.test(call.sql))
    const identityIndex = calls.findIndex((call) => /INSERT INTO user_external_identities|UPDATE user_external_identities/.test(call.sql))
    const backfillIndex = calls.findIndex((call) => call.sql.includes('UPDATE directory_accounts'))
    expect(identityIndex).toBeGreaterThan(-1)
    expect(savepointIndex).toBeGreaterThan(identityIndex)
    expect(backfillIndex).toBeGreaterThan(savepointIndex)
    expect(calls.some((call) => /^RELEASE SAVEPOINT /.test(call.sql))).toBe(true)
  })

  it('a login REJECTED for a missing grant still backfills the proven openId (the directory page needs it to grant)', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    const calls = installTransaction()
    pgMocks.query
      .mockResolvedValueOnce({ rows: [IDENTITY_USER] }) // findIdentityUser: HIT
      .mockResolvedValueOnce({ rows: [] }) // readGrantState → absent

    await expect(exchangeCodeForUser('code-rejected')).rejects.toMatchObject({ code: 'grant_required' })
    expectScopedBackfill(backfillCall(calls))
  })

  it('a failing ROLLBACK TO SAVEPOINT is NOT swallowed (else COMMIT would silently roll back the identity write)', async () => {
    installTransaction({ failBackfill: true, failRollback: true })
    pgMocks.query
      .mockResolvedValueOnce({ rows: [IDENTITY_USER] })
      .mockResolvedValueOnce({ rows: [{ enabled: true }] })

    await expect(exchangeCodeForUser('code-rollback-fails')).rejects.toThrow('connection terminated')
  })

  it('a failing SAVEPOINT is NOT swallowed either (the transaction is already unusable)', async () => {
    installTransaction({ failSavepoint: true })
    pgMocks.query
      .mockResolvedValueOnce({ rows: [IDENTITY_USER] })
      .mockResolvedValueOnce({ rows: [{ enabled: true }] })

    await expect(exchangeCodeForUser('code-savepoint-fails')).rejects.toThrow('current transaction is aborted')
  })

  it('a failing backfill is rolled back to its savepoint and the login still succeeds', async () => {
    const calls = installTransaction({ failBackfill: true })
    pgMocks.query
      .mockResolvedValueOnce({ rows: [IDENTITY_USER] })
      .mockResolvedValueOnce({ rows: [{ enabled: true }] })

    const result = await exchangeCodeForUser('code-backfill-fails')
    expect(result.localUserId).toBe('user-1')
    expect(backfillCall(calls)).toBeTruthy()
    expect(calls.some((call) => /^ROLLBACK TO SAVEPOINT /.test(call.sql))).toBe(true)
    expect(calls.some((call) => /^RELEASE SAVEPOINT /.test(call.sql))).toBe(false)
  })

  it('no corp configured → no backfill (corp-less identities are unionId-keyed and need no openId)', async () => {
    clientMocks.readDingTalkOauthConfig.mockReturnValue({
      clientId: 'dt-client',
      clientSecret: 'dt-secret',
      redirectUri: 'https://app.example.com/login/dingtalk/callback',
      corpId: '',
      baseUrl: 'https://oapi.dingtalk.com',
    })
    const calls = installTransaction()
    pgMocks.query
      .mockResolvedValueOnce({ rows: [IDENTITY_USER] })
      .mockResolvedValueOnce({ rows: [{ enabled: true }] })

    await exchangeCodeForUser('code-no-corp')
    expect(backfillCall(calls)).toBeUndefined()
  })
})
