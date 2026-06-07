import { beforeEach, describe, expect, it, vi } from 'vitest'

const getRedisClientMock = vi.fn()
vi.mock('../../src/db/redis', () => ({
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
}))

import { consumeEmbedJti, embedJtiKey, EmbedJtiStoreUnavailableError } from '../../src/auth/embed-jti-store'

// A stateful Redis `SET key val EX ttl NX` fake: returns 'OK' the first time a key is set, and null
// while it already exists. The replay result comes from the NX SEMANTICS, not from mockReturnValueOnce
// -- so a regression that drops NX (and thus fail-opens) actually changes the test outcome.
function makeRedis() {
  const store = new Map<string, string>()
  const set = vi.fn(async (key: string, val: string, _ex: string, _ttl: number, nx?: string) => {
    if (nx === 'NX' && store.has(key)) return null
    store.set(key, val)
    return 'OK'
  })
  return { set }
}

describe('embedJtiKey', () => {
  it('is deterministic, scoped, prefixed, and never leaks the bare jti', () => {
    const scope = { aud: 'metasheet2.embed', feature_key: 'bom_multitable', tenant_id: 't1', part_id: 'P1', jti: 'jti-secret-123' }
    const key = embedJtiKey(scope)
    expect(key).toBe(embedJtiKey({ ...scope })) // deterministic
    expect(key.startsWith('plm-embed:jti:')).toBe(true)
    expect(key).not.toContain('jti-secret-123') // hashed -> no bare jti
    // scope binding: changing any scope component changes the key
    expect(embedJtiKey({ ...scope, jti: 'other' })).not.toBe(key)
    expect(embedJtiKey({ ...scope, tenant_id: 't2' })).not.toBe(key)
    expect(embedJtiKey({ ...scope, part_id: 'P2' })).not.toBe(key)
    expect(embedJtiKey({ ...scope, feature_key: 'approval_automation' })).not.toBe(key)
    expect(embedJtiKey({ ...scope, aud: 'other.embed' })).not.toBe(key)
  })
})

describe('consumeEmbedJti', () => {
  beforeEach(() => getRedisClientMock.mockReset())

  it('SET NX EX -> true on first use, false on replay; pins the exact args incl. NX', async () => {
    const redis = makeRedis()
    getRedisClientMock.mockResolvedValue(redis)
    const first = await consumeEmbedJti('k', 120)
    expect(first).toBe(true)
    // pin the args: dropping NX (or wrong EX/NX order) would silently fail-open replay protection
    expect(redis.set).toHaveBeenCalledWith('k', '1', 'EX', 120, 'NX')
    const second = await consumeEmbedJti('k', 120)
    expect(second).toBe(false) // replay, produced by the NX semantics
  })

  it('floors a fractional ttl and never goes below 1 second', async () => {
    const redis = makeRedis()
    getRedisClientMock.mockResolvedValue(redis)
    await consumeEmbedJti('k', 0.4)
    expect(redis.set).toHaveBeenCalledWith('k', '1', 'EX', 1, 'NX')
  })

  it('throws (fail-closed) when the shared store is unavailable (null client)', async () => {
    getRedisClientMock.mockResolvedValue(null)
    await expect(consumeEmbedJti('k', 120)).rejects.toBeInstanceOf(EmbedJtiStoreUnavailableError)
  })

  it('throws (fail-closed) when the SET command itself throws', async () => {
    getRedisClientMock.mockResolvedValue({ set: vi.fn().mockRejectedValue(new Error('redis down')) })
    await expect(consumeEmbedJti('k', 120)).rejects.toBeInstanceOf(EmbedJtiStoreUnavailableError)
  })
})
