/**
 * Unit tests for the Redis-backed Token Bucket store.
 *
 * We don't need a real Redis here: the store's core logic lives in the
 * Lua script, and the store file exports a pure-JS twin
 * (`applyTokenBucketScript`) that mirrors it exactly. Tests exercise that
 * twin for deterministic refill/burst behaviour, plus a small shim for
 * the eval/evalsha/script dispatch path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  RedisTokenBucketStore,
  TOKEN_BUCKET_LUA,
  applyTokenBucketScript,
  type RedisScriptClient,
} from '../../src/integration/rate-limiting/redis-token-bucket-store'
import {
  MemoryTokenBucketStore,
} from '../../src/integration/rate-limiting/token-bucket-store'

// ---------------------------------------------------------------------------
// Pure-JS Lua twin
// ---------------------------------------------------------------------------

describe('applyTokenBucketScript (pure-JS twin of TOKEN_BUCKET_LUA)', () => {
  it('initial consume on missing key returns capacity - requested', () => {
    const out = applyTokenBucketScript({
      state: undefined,
      capacity: 10,
      refillRate: 1,
      requested: 3,
      nowMs: 1_000_000,
    })
    expect(out.allowed).toBe(true)
    expect(out.tokens).toBe(7)
    expect(out.lastRefill).toBe(1_000_000)
    expect(out.retryAfterMs).toBe(0)
  })

  it('refills tokens based on elapsed time and clamps at capacity', () => {
    const out = applyTokenBucketScript({
      state: { tokens: 2, lastRefill: 1_000_000 },
      capacity: 10,
      refillRate: 5, // 5 tokens / second
      requested: 1,
      nowMs: 1_010_000, // 10 seconds later → would refill by 50, clamp at 10
    })
    expect(out.allowed).toBe(true)
    expect(out.tokens).toBe(9) // 10 - 1
    expect(out.lastRefill).toBe(1_010_000)
  })

  it('rejects when bucket is empty and reports retryAfterMs', () => {
    const out = applyTokenBucketScript({
      state: { tokens: 0, lastRefill: 2_000_000 },
      capacity: 5,
      refillRate: 2, // 2/s
      requested: 3,
      nowMs: 2_000_000, // no elapsed time
    })
    expect(out.allowed).toBe(false)
    expect(out.tokens).toBe(0)
    // deficit = 3 - 0 = 3; 3/2 * 1000 = 1500
    expect(out.retryAfterMs).toBe(1500)
  })

  it('exhausts bucket in a burst then refuses subsequent requests', () => {
    let state: { tokens: number; lastRefill: number } | undefined
    const capacity = 4
    const nowMs = 3_000_000
    const results = [] as boolean[]
    for (let i = 0; i < 6; i++) {
      const r = applyTokenBucketScript({
        state,
        capacity,
        refillRate: 1,
        requested: 1,
        nowMs,
      })
      state = { tokens: r.tokens, lastRefill: r.lastRefill }
      results.push(r.allowed)
    }
    expect(results.slice(0, 4)).toEqual([true, true, true, true])
    expect(results.slice(4)).toEqual([false, false])
  })

  it('handles refillRate=0 as a never-refilling bucket', () => {
    const out = applyTokenBucketScript({
      state: { tokens: 0, lastRefill: 1_000_000 },
      capacity: 10,
      refillRate: 0,
      requested: 1,
      nowMs: 2_000_000,
    })
    expect(out.allowed).toBe(false)
    expect(out.retryAfterMs).toBe(-1) // signals "never"
  })

  it('parallel consumes on memory store are serialised (atomicity surrogate)', async () => {
    const store = new MemoryTokenBucketStore()
    const capacity = 3
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.consume('k', capacity, 0, 1),
      ),
    )
    const allowed = results.filter(r => r.allowed).length
    const rejected = results.filter(r => !r.allowed).length
    expect(allowed).toBe(3)
    expect(rejected).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Redis dispatch path — verify SCRIPT LOAD → EVALSHA → NOSCRIPT recovery
// ---------------------------------------------------------------------------

function createFakeRedis(opts: { scriptLoadReturns?: string } = {}): RedisScriptClient & {
  _calls: { method: string; args: unknown[] }[]
  _loadedSha: string | null
  _scriptCache: Map<string, string>
  _flushScripts: () => void
} {
  const loadedSha = opts.scriptLoadReturns ?? 'sha-fake-1'
  const calls: { method: string; args: unknown[] }[] = []
  const scriptCache = new Map<string, string>() // sha -> source

  const runScript = (
    source: string,
    _numKeys: number,
    key: string,
    ...args: (string | number)[]
  ) => {
    // Execute via the JS twin so tests get realistic output.
    const [capacity, refillRate, requested, nowMs] = args.map(Number)
    const out = applyTokenBucketScript({
      state: undefined, // test harness doesn't persist
      capacity,
      refillRate,
      requested,
      nowMs,
    })
    // Redis returns numbers as integers and strings as strings
    return [out.allowed ? 1 : 0, String(out.tokens), String(out.retryAfterMs)]
  }

  return {
    _calls: calls,
    _loadedSha: loadedSha,
    _scriptCache: scriptCache,
    _flushScripts() {
      scriptCache.clear()
    },
    async evalsha(sha: string, numKeys: number, ...rest: (string | number)[]) {
      calls.push({ method: 'evalsha', args: [sha, numKeys, ...rest] })
      const source = scriptCache.get(sha)
      if (!source) {
        const err = new Error(
          'NOSCRIPT No matching script. Please use EVAL.',
        )
        throw err
      }
      return runScript(source, numKeys, String(rest[0]), ...rest.slice(1) as (string | number)[])
    },
    async eval(source: string, numKeys: number, ...rest: (string | number)[]) {
      calls.push({ method: 'eval', args: [source, numKeys, ...rest] })
      return runScript(source, numKeys, String(rest[0]), ...rest.slice(1) as (string | number)[])
    },
    async script(subcommand: 'LOAD', source: string) {
      calls.push({ method: 'script', args: [subcommand, source] })
      scriptCache.set(loadedSha, source)
      return loadedSha
    },
  }
}

describe('RedisTokenBucketStore', () => {
  let redis: ReturnType<typeof createFakeRedis>
  let store: RedisTokenBucketStore

  beforeEach(() => {
    redis = createFakeRedis()
    store = new RedisTokenBucketStore({ redis, keyPrefix: 't:', ttlSeconds: 60 })
  })

  it('loads the script on first call, then uses EVALSHA thereafter', async () => {
    const r1 = await store.consume('user-1', 5, 1, 1)
    expect(r1.allowed).toBe(true)

    // First call: SCRIPT LOAD + EVALSHA
    const methods = redis._calls.map(c => c.method)
    expect(methods.slice(0, 2)).toEqual(['script', 'evalsha'])

    const r2 = await store.consume('user-1', 5, 1, 1)
    expect(r2.allowed).toBe(true)
    // Second call: just EVALSHA (no new script load)
    expect(redis._calls[redis._calls.length - 1].method).toBe('evalsha')
    expect(redis._calls.filter(c => c.method === 'script').length).toBe(1)
  })

  it('handles NOSCRIPT by reloading the script', async () => {
    await store.consume('user-1', 5, 1, 1) // loads + evalsha OK

    // Simulate Redis flushing scripts
    redis._flushScripts()

    const r = await store.consume('user-1', 5, 1, 1)
    expect(r.allowed).toBe(true)

    // We should see: evalsha (NOSCRIPT) → script LOAD → evalsha
    const methods = redis._calls.map(c => c.method)
    // Count two script loads (initial + reload) and at least three evalshas
    expect(methods.filter(m => m === 'script').length).toBe(2)
    expect(methods.filter(m => m === 'evalsha').length).toBeGreaterThanOrEqual(3)
  })

  it('falls back to plain EVAL when SCRIPT LOAD throws', async () => {
    // Force SCRIPT LOAD to fail (but still log the attempt)
    const originalScript = redis.script.bind(redis)
    redis.script = async (...args: Parameters<typeof originalScript>) => {
      redis._calls.push({ method: 'script', args })
      throw new Error('cluster: CROSSSLOT')
    }

    const r = await store.consume('user-2', 5, 1, 1)
    expect(r.allowed).toBe(true)

    const methods = redis._calls.map(c => c.method)
    expect(methods).toContain('script')
    expect(methods).toContain('eval')
  })

  it('propagates the bucket key with the configured prefix and TTL arg', async () => {
    await store.consume('user-xyz', 10, 2, 1)
    const evalsha = redis._calls.find(c => c.method === 'evalsha')!
    const args = evalsha.args as (string | number)[]
    // sha, numKeys, key, capacity, refillRate, requested, nowMs, ttlSeconds
    expect(args[1]).toBe(1) // numKeys
    expect(args[2]).toBe('t:user-xyz')
    expect(Number(args[3])).toBe(10) // capacity
    expect(Number(args[4])).toBe(2) // refillRate
    expect(Number(args[5])).toBe(1) // requested
    expect(Number(args[7])).toBe(60) // ttl
  })

  it('exports the Lua script source containing the atomic EXPIRE and HMSET calls', () => {
    expect(TOKEN_BUCKET_LUA).toMatch(/HMSET/)
    expect(TOKEN_BUCKET_LUA).toMatch(/EXPIRE/)
    expect(TOKEN_BUCKET_LUA).toMatch(/redis\.call/)
  })
})
