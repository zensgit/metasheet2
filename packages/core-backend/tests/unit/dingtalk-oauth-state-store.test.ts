import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const redisMockState = vi.hoisted(() => {
  const kv = new Map<string, { value: string; expiresAt: number | null }>()
  const zsets = new Map<string, Map<string, number>>()
  const behavior = {
    connectFail: false,
    opsFail: false,
    execTupleError: false,
  }

  function readZset(key: string): Map<string, number> {
    let zset = zsets.get(key)
    if (!zset) {
      zset = new Map<string, number>()
      zsets.set(key, zset)
    }
    return zset
  }

  function isExpired(record: { expiresAt: number | null }): boolean {
    return record.expiresAt !== null && Date.now() > record.expiresAt
  }

  return {
    behavior,
    kv,
    zsets,
    reset() {
      kv.clear()
      zsets.clear()
      behavior.connectFail = false
      behavior.opsFail = false
      behavior.execTupleError = false
    },
    readZset,
    isExpired,
  }
})

vi.mock('ioredis', () => {
  class MockRedis {
    constructor(_url: string, _opts: Record<string, unknown>) {}

    async connect() {
      if (redisMockState.behavior.connectFail) {
        throw new Error('connect fail')
      }
    }

    on(_event: string, _cb: (...args: unknown[]) => void) {}

    async quit() {}

    disconnect() {}

    private assertHealthy() {
      if (redisMockState.behavior.opsFail) {
        throw new Error('redis op fail')
      }
    }

    async get(key: string) {
      this.assertHealthy()
      const record = redisMockState.kv.get(key)
      if (!record) return null
      if (redisMockState.isExpired(record)) {
        redisMockState.kv.delete(key)
        return null
      }
      return record.value
    }

    async set(key: string, value: string, mode?: string, ttlMs?: number) {
      this.assertHealthy()
      const expiresAt = mode === 'PX' && typeof ttlMs === 'number'
        ? Date.now() + ttlMs
        : null
      redisMockState.kv.set(key, { value, expiresAt })
      return 'OK'
    }

    async del(...keys: string[]) {
      this.assertHealthy()
      let deleted = 0
      for (const key of keys) {
        if (redisMockState.kv.delete(key)) deleted += 1
      }
      return deleted
    }

    async zadd(key: string, score: number, member: string) {
      this.assertHealthy()
      const zset = redisMockState.readZset(key)
      zset.set(member, Number(score))
      return 1
    }

    async zcard(key: string) {
      this.assertHealthy()
      return redisMockState.readZset(key).size
    }

    async zrange(key: string, start: number, stop: number) {
      this.assertHealthy()
      const values = Array.from(redisMockState.readZset(key).entries())
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member)
      const normalizedStop = stop < 0 ? values.length - 1 : stop
      return values.slice(start, normalizedStop + 1)
    }

    async zrangebyscore(key: string, min: number, max: number) {
      this.assertHealthy()
      return Array.from(redisMockState.readZset(key).entries())
        .filter(([, score]) => score >= Number(min) && score <= Number(max))
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member)
    }

    async zrem(key: string, ...members: string[]) {
      this.assertHealthy()
      const zset = redisMockState.readZset(key)
      let deleted = 0
      for (const member of members) {
        if (zset.delete(member)) deleted += 1
      }
      return deleted
    }

    multi() {
      const ops: Array<() => Promise<unknown>> = []
      const chain = {
        get: (key: string) => {
          ops.push(() => this.get(key))
          return chain
        },
        del: (...keys: string[]) => {
          ops.push(() => this.del(...keys))
          return chain
        },
        zrem: (key: string, ...members: string[]) => {
          ops.push(() => this.zrem(key, ...members))
          return chain
        },
        set: (key: string, value: string, mode?: string, ttlMs?: number) => {
          ops.push(() => this.set(key, value, mode, ttlMs))
          return chain
        },
        zadd: (key: string, score: number, member: string) => {
          ops.push(() => this.zadd(key, score, member))
          return chain
        },
        exec: async () => {
          if (redisMockState.behavior.execTupleError) {
            return ops.map(() => [new Error('redis exec tuple error'), null] as [Error, null])
          }
          const results: Array<[Error | null, unknown]> = []
          for (const op of ops) {
            try {
              results.push([null, await op()])
            } catch (error) {
              results.push([error instanceof Error ? error : new Error(String(error)), null])
            }
          }
          return results
        },
      }
      return chain
    }
  }

  return { default: MockRedis }
})

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  exchangeCodeForUserAccessToken: vi.fn(),
  fetchDingTalkCurrentUser: vi.fn(),
  isDingTalkConfigured: vi.fn(() => true),
  readDingTalkOauthConfig: vi.fn(() => ({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/login/dingtalk/callback',
    corpId: null,
  })),
}))

import {
  __resetDingTalkOAuthStateStoreForTests,
  exchangeCodeForUser,
  generateState,
  validateState,
} from '../../src/auth/dingtalk-oauth'
import { query, transaction } from '../../src/db/pg'
import {
  exchangeCodeForUserAccessToken,
  fetchDingTalkCurrentUser,
  readDingTalkOauthConfig,
} from '../../src/integrations/dingtalk/client'

describe('DingTalk OAuth state store', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    redisMockState.reset()
    vi.mocked(query).mockReset()
    vi.mocked(transaction).mockReset()
    vi.mocked(exchangeCodeForUserAccessToken).mockReset()
    vi.mocked(fetchDingTalkCurrentUser).mockReset()
    await __resetDingTalkOAuthStateStoreForTests()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    redisMockState.reset()
    await __resetDingTalkOAuthStateStoreForTests()
  })

  it('stores and consumes state via Redis when configured', async () => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379')

    const state = await generateState({ redirectPath: '/attendance' })
    expect(typeof state).toBe('string')

    const firstValidation = await validateState(state)
    expect(firstValidation).toEqual({
      valid: true,
      redirectPath: '/attendance',
    })

    const secondValidation = await validateState(state)
    expect(secondValidation).toEqual({
      valid: false,
      error: 'Invalid or unknown state parameter',
    })
  })

  it('round-trips an activate intent once with both target and administrator bound', async () => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379')

    const state = await generateState({
      redirectPath: '/admin/users',
      intent: 'activate',
      activateUserId: 'pending-user',
      activateAdminUserId: 'platform-admin',
    })

    await expect(validateState(state)).resolves.toEqual({
      valid: true,
      redirectPath: '/admin/users',
      intent: 'activate',
      activateUserId: 'pending-user',
      activateAdminUserId: 'platform-admin',
    })
    await expect(validateState(state)).resolves.toEqual({
      valid: false,
      error: 'Invalid or unknown state parameter',
    })
  })

  it('rejects incomplete activate state generation', async () => {
    await expect(generateState({
      intent: 'activate',
      activateUserId: 'pending-user',
    })).rejects.toThrow('requires target and administrator')
  })

  it('fails closed on a persisted unknown intent', async () => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379')
    const state = await generateState()
    const key = `metasheet:auth:dingtalk:state:${state}`
    const stored = redisMockState.kv.get(key)
    expect(stored).toBeDefined()
    redisMockState.kv.set(key, {
      value: JSON.stringify({
        expiresAt: Date.now() + 60_000,
        intent: 'future-unsafe-intent',
      }),
      expiresAt: stored?.expiresAt ?? null,
    })

    await expect(validateState(state)).resolves.toEqual({
      valid: false,
      error: 'Invalid or unknown state parameter',
    })
  })

  it('returns expired when a Redis-backed state exceeds its logical TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-31T00:00:00.000Z'))
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379')

    const state = await generateState()
    vi.advanceTimersByTime(5 * 60 * 1000 + 1_000)

    const expiredValidation = await validateState(state)
    expect(expiredValidation).toEqual({
      valid: false,
      error: 'State parameter has expired',
    })
  })

  it('falls back to in-memory storage when Redis is unavailable', async () => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379')
    redisMockState.behavior.connectFail = true

    const state = await generateState({ redirectPath: '/workflows' })
    const validation = await validateState(state)

    expect(validation).toEqual({
      valid: true,
      redirectPath: '/workflows',
    })
  })

  it('falls back to in-memory storage when Redis multi exec returns tuple errors', async () => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379')
    redisMockState.behavior.execTupleError = true

    const state = await generateState({ redirectPath: '/attendance' })
    redisMockState.behavior.execTupleError = false

    const validation = await validateState(state)
    expect(validation).toEqual({
      valid: true,
      redirectPath: '/attendance',
    })
  })

  it('refuses auto-provision when a local account already exists with the same email', async () => {
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '0')
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '1')
    // Auto-provision requires a non-empty corp allowlist (DT-HARDEN-09); this
    // test exercises the email-conflict guard downstream of that gate.
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', 'ding-corp-1')
    vi.mocked(exchangeCodeForUserAccessToken).mockResolvedValue({
      accessToken: 'access-token',
    })
    vi.mocked(fetchDingTalkCurrentUser).mockResolvedValue({
      openId: 'open-id-1',
      unionId: 'union-id-1',
      nick: 'Ding User',
      email: 'manager@example.com',
    })
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'manager@example.com',
          name: 'Manager',
          role: 'user',
        }],
      } as any)

    await expect(exchangeCodeForUser('auth-code')).rejects.toThrow(
      'Refusing to auto-provision DingTalk user because a local account already exists with the same email',
    )
  })

  it('rejects external identities linked to inactive local users', async () => {
    vi.mocked(exchangeCodeForUserAccessToken).mockResolvedValue({
      accessToken: 'access-token',
    })
    vi.mocked(fetchDingTalkCurrentUser).mockResolvedValue({
      openId: 'open-id-1',
      unionId: 'union-id-1',
      nick: 'Ding User',
      email: 'manager@example.com',
    })
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        email: 'manager@example.com',
        name: 'Manager',
        role: 'user',
        is_active: false,
      }],
    } as any)

    await expect(exchangeCodeForUser('auth-code')).rejects.toThrow(
      'DingTalk login is disabled for this user',
    )
  })

  it('scopes identity fallback lookups to the configured corp id', async () => {
    vi.mocked(readDingTalkOauthConfig).mockReturnValue({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://example.com/login/dingtalk/callback',
      corpId: 'ding-corp-1',
    })
    vi.mocked(exchangeCodeForUserAccessToken).mockResolvedValue({
      accessToken: 'access-token',
    })
    vi.mocked(fetchDingTalkCurrentUser).mockResolvedValue({
      openId: 'open-id-1',
      unionId: 'union-id-1',
      nick: 'Ding User',
      email: 'manager@example.com',
    })
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)

    await expect(exchangeCodeForUser('auth-code')).rejects.toThrow('is not linked to a local user')

    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain('identity.corp_id = $5')
    expect(vi.mocked(query).mock.calls[0]?.[1]?.[4]).toBe('ding-corp-1')
  })

  it('does not auto-link by email when the flag is unset', async () => {
    vi.mocked(exchangeCodeForUserAccessToken).mockResolvedValue({
      accessToken: 'access-token',
    })
    vi.mocked(fetchDingTalkCurrentUser).mockResolvedValue({
      openId: 'open-id-1',
      unionId: 'union-id-1',
      nick: 'Ding User',
      email: 'manager@example.com',
    })
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as any)

    await expect(exchangeCodeForUser('auth-code')).rejects.toThrow(
      'DingTalk account manager@example.com is not linked to a local user',
    )

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1)
  })

  it('rejects email auto-link when the matched local user is disabled', async () => {
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
    vi.mocked(exchangeCodeForUserAccessToken).mockResolvedValue({
      accessToken: 'access-token',
    })
    vi.mocked(fetchDingTalkCurrentUser).mockResolvedValue({
      openId: 'open-id-1',
      unionId: 'union-id-1',
      nick: 'Ding User',
      email: 'manager@example.com',
    })
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'manager@example.com',
          name: 'Manager',
          role: 'disabled',
          is_active: true,
        }],
      } as any)

    await expect(exchangeCodeForUser('auth-code')).rejects.toThrow(
      'DingTalk login is disabled for this user',
    )
  })

  it('writes a password hash when auto-provisioning a new DingTalk user', async () => {
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '1')
    // Auto-provision requires a non-empty corp allowlist (DT-HARDEN-09).
    vi.stubEnv('DINGTALK_ALLOWED_CORP_IDS', 'ding-corp-1')
    vi.mocked(exchangeCodeForUserAccessToken).mockResolvedValue({
      accessToken: 'access-token',
    })
    vi.mocked(fetchDingTalkCurrentUser).mockResolvedValue({
      openId: 'open-id-1',
      unionId: 'union-id-1',
      nick: 'Ding User',
    })
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as any)

    let insertedUserParams: unknown[] | null = null
    vi.mocked(transaction).mockImplementation(async (callback: (client: { query: typeof query }) => Promise<unknown>) => {
      const aliasOwners = new Map<string, string>()
      const clientQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
        const statement = String(sql)
        if (/INSERT INTO user_login_aliases/i.test(statement)) {
          aliasOwners.set(String(params[2] ?? ''), String(params[0] ?? ''))
          return { rows: [] }
        }
        if (/SELECT user_id FROM user_login_aliases/i.test(statement)) {
          const ownerId = aliasOwners.get(String(params[0] ?? ''))
          return { rows: ownerId ? [{ user_id: ownerId }] : [] }
        }
        if (/INSERT INTO users/i.test(statement)) {
          insertedUserParams = params
          return {
            rows: [{
              id: 'user-new',
              email: 'dingtalk_open-id-1@placeholder.local',
              name: 'Ding User',
              role: 'user',
              is_active: true,
              activation_status: 'activated',
            }],
          }
        }
        if (/FROM users[\s\S]*FOR UPDATE/i.test(statement)) {
          return {
            rows: [{
              id: String(params[0]),
              name: 'Ding User',
              email: 'dingtalk_open-id-1@placeholder.local',
              username: null,
              mobile: null,
              activation_status: 'activated',
              is_active: true,
              access_generation: 0,
            }],
          }
        }
        if (/INSERT INTO users/i.test(statement)) {
          return {
            rows: [{
              id: 'user-new',
              email: 'dingtalk_open-id-1@placeholder.local',
              name: 'Ding User',
              role: 'user',
              is_active: true,
              activation_status: 'activated',
            }],
          }
        }
        if (/INSERT INTO user_external_auth_grants/i.test(statement)) {
          return { rows: [{ local_user_id: String(params[1]) }] }
        }
        if (/INSERT INTO user_external_identities/i.test(statement)) {
          return { rows: [{ id: 'identity-new' }] }
        }
        if (/UPDATE users[\s\S]*access_generation/i.test(statement)) {
          return { rows: [{ access_generation: 1 }] }
        }
        return { rows: [] }
      })
      return callback({ query: clientQuery as unknown as typeof query })
    })

    const result = await exchangeCodeForUser('auth-code')

    expect(result.localUserId).toBe('user-new')
    expect(insertedUserParams?.[4]).toMatch(/^\$2[aby]\$/)
  })
})
