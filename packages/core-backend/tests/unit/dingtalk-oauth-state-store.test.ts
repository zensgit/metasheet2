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
import { exchangeCodeForUserAccessToken, fetchDingTalkCurrentUser } from '../../src/integrations/dingtalk/client'

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
})
