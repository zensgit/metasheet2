import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictLoginGrantError } from '../../src/auth/strict-login-grant-store'

const chain = vi.hoisted(() => ({
  refuseStrictLegacyDingTalkWrite: vi.fn(),
  refuseStrictLiveEvidence: vi.fn(),
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const clientMocks = vi.hoisted(() => ({
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

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))

vi.mock('../../src/db/pg', () => ({
  pool: null,
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  getPoolStats: () => ({ total: 0, idle: 0, waiting: 0 }),
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  exchangeCodeForUserAccessToken: vi.fn(),
  fetchDingTalkAppAccessToken: vi.fn(),
  fetchDingTalkCurrentUser: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
  getDingTalkUserInfoByAuthCode: vi.fn(),
  readDingTalkOauthConfig: clientMocks.readDingTalkOauthConfig,
}))

vi.mock('../../src/auth/strict-credential-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/strict-credential-chain')>()
  return {
    ...actual,
    refuseStrictLegacyDingTalkWrite: chain.refuseStrictLegacyDingTalkWrite,
    refuseStrictLiveEvidence: chain.refuseStrictLiveEvidence,
  }
})

import { StrictCredentialChainError } from '../../src/auth/strict-credential-chain'
import { bindDingTalkIdentityToUser, DingTalkLoginPolicyError } from '../../src/auth/dingtalk-oauth'

const GRANT_STATE_MESSAGE = 'Unable to verify DingTalk login authorization; please retry'
const STRICT_MESSAGE = 'DingTalk legacy login is closed for this connection'
const AMBIGUOUS_MESSAGE = 'DingTalk legacy login cannot choose among strict connections'

function armBind(): void {
  clientMocks.readDingTalkOauthConfig.mockReturnValue({
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    redirectUri: 'https://example.invalid/callback',
    corpId: 'synthetic-corp',
  })
  pgMocks.transaction.mockImplementation(async (work: (client: { query: typeof pgMocks.query }) => Promise<void>) => {
    await work({
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes('FROM users') && String(sql).includes('FOR UPDATE')) {
          return {
            rows: [{
              id: 'user-1',
              name: 'Synthetic',
              email: 'synthetic@example.invalid',
              username: null,
              mobile: null,
              activation_status: 'activated',
              role: 'user',
              is_active: true,
              access_generation: 0,
              deleted_at: null,
              purged_at: null,
            }],
          }
        }
        return { rows: [] }
      }),
    })
  })
}

async function bind(): Promise<void> {
  await bindDingTalkIdentityToUser({
    localUserId: 'user-1',
    dtUser: { unionId: 'union-1', nick: 'Synthetic' },
  })
}

describe('DingTalk strict policy public boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    armBind()
    chain.refuseStrictLegacyDingTalkWrite.mockResolvedValue(null)
    chain.refuseStrictLiveEvidence.mockResolvedValue(undefined)
  })

  it('maps a strict scope refusal to fixed strict_connection 403', async () => {
    chain.refuseStrictLegacyDingTalkWrite.mockRejectedValue(
      new StrictCredentialChainError('strict_connection', 'MARKER corp 203.0.113.9 provider body', 500),
    )

    await expect(bind()).rejects.toMatchObject({
      name: 'DingTalkLoginPolicyError',
      statusCode: 403,
      code: 'strict_connection',
      message: STRICT_MESSAGE,
    })
    await expect(bind()).rejects.toBeInstanceOf(DingTalkLoginPolicyError)
    await bind().catch((error: DingTalkLoginPolicyError) => {
      expect(error.cause).toBeUndefined()
      expect(JSON.stringify({ message: error.message, code: error.code })).not.toContain('MARKER')
      expect(error.message).not.toContain('203.0.113.9')
    })
  })

  it('maps strict ambiguity to fixed strict_connection_ambiguous 503', async () => {
    chain.refuseStrictLiveEvidence.mockRejectedValue(
      new StrictCredentialChainError('strict_connection_ambiguous', 'MARKER raw ambiguity', 409),
    )

    await expect(bind()).rejects.toMatchObject({
      statusCode: 503,
      code: 'strict_connection_ambiguous',
      message: AMBIGUOUS_MESSAGE,
    })
  })

  it.each([
    ['STRICT_LOGIN_GRANT_INSTALLATION_REFUSED'],
    ['STRICT_LOGIN_GRANT_INPUT_REFUSED'],
  ] as const)('maps core %s to fixed grant_state_unavailable 503', async (code) => {
    const thrown = new StrictLoginGrantError(code, { sqlState: '08006', constraint: 'MARKER_CONSTRAINT' })
    chain.refuseStrictLegacyDingTalkWrite.mockRejectedValue(thrown)

    await expect(bind()).rejects.toMatchObject({
      statusCode: 503,
      code: 'grant_state_unavailable',
      message: GRANT_STATE_MESSAGE,
    })
    await bind().catch((error: DingTalkLoginPolicyError) => {
      expect(error.cause).toBeUndefined()
      expect(error.message).not.toContain('08006')
      expect(error.message).not.toContain('MARKER_CONSTRAINT')
      expect(error.message).not.toContain('Strict login grant')
    })
  })

  it('rethrows an internal input error without a public policy code', async () => {
    const thrown = new StrictCredentialChainError('STRICT_CONNECTION_ID', 'Identifier is not a UUID')
    chain.refuseStrictLegacyDingTalkWrite.mockRejectedValue(thrown)

    await expect(bind()).rejects.toBe(thrown)
  })

  it('rethrows a non-read store error', async () => {
    const thrown = new StrictLoginGrantError('STRICT_LOGIN_GRANT_REVOKE_REFUSED')
    chain.refuseStrictLegacyDingTalkWrite.mockRejectedValue(thrown)

    await expect(bind()).rejects.toBe(thrown)
  })

  it('rethrows a non-boundary failure', async () => {
    const thrown = new Error('synthetic local failure')
    chain.refuseStrictLiveEvidence.mockRejectedValue(thrown)

    await expect(bind()).rejects.toBe(thrown)
  })
})
