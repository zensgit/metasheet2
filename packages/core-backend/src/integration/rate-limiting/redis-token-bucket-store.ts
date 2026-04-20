/**
 * Redis-backed Token Bucket store (Sprint 6 / Redis runtime).
 *
 * Atomically consumes tokens from a bucket stored in Redis using a Lua
 * script. The script reads current `tokens` + `lastRefill`, refills based
 * on elapsed time, decrements by the requested count (when enough are
 * available), writes the new state back, and refreshes the TTL.
 *
 * The limiter itself continues to default to the in-process MemoryStore;
 * callers explicitly opt into Redis by constructing
 * `TokenBucketRateLimiter` with `{ store: new RedisTokenBucketStore(...) }`.
 *
 * Graceful degradation: if the Redis call throws, the caller is expected
 * to fall back to memory — see `message-rate-limiter.ts` for the pattern.
 */

import type { TokenBucketStore, ConsumeResult } from './token-bucket-store'

// ---------------------------------------------------------------------------
// Shared Lua script source.
// Exported so unit tests can assert the contents (and so the pure-JS twin
// below stays in sync).
//
// KEYS[1]      bucket key
// ARGV[1]      bucket capacity          (number)
// ARGV[2]      tokensPerSecond          (number)
// ARGV[3]      tokensRequested          (number)
// ARGV[4]      nowMs                    (integer, ms since epoch)
// ARGV[5]      ttlSeconds               (integer)
//
// HASH fields stored at KEYS[1]:
//   tokens           current token balance (float serialised as string)
//   lastRefill       timestamp in ms of the most recent refill
// ---------------------------------------------------------------------------
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
local ttlSeconds = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  lastRefill = nowMs
end

local elapsed = nowMs - lastRefill
if elapsed < 0 then elapsed = 0 end
local refill = (elapsed / 1000.0) * refillRate
if refill > 0 then
  tokens = math.min(capacity, tokens + refill)
  lastRefill = nowMs
end

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
redis.call('EXPIRE', key, ttlSeconds)

local retryAfterMs = 0
if allowed == 0 then
  local deficit = requested - tokens
  if refillRate > 0 then
    retryAfterMs = math.ceil((deficit / refillRate) * 1000)
  else
    retryAfterMs = -1
  end
end

return { allowed, tostring(tokens), tostring(retryAfterMs) }
`.trim()

// ---------------------------------------------------------------------------
// Pure-JS twin used by tests so we never need to run a real Lua VM.
// Mirrors the Lua transformation exactly — same formulas, same rounding.
// ---------------------------------------------------------------------------

export interface ApplyTokenBucketArgs {
  /** Previous bucket state; undefined when the key does not yet exist. */
  state: { tokens: number; lastRefill: number } | undefined
  capacity: number
  refillRate: number
  requested: number
  nowMs: number
}

export interface ApplyTokenBucketResult {
  allowed: boolean
  tokens: number
  lastRefill: number
  retryAfterMs: number
}

/**
 * Deterministic JS equivalent of TOKEN_BUCKET_LUA — used by unit tests
 * and (optionally) by a future non-Redis code-path that wants the same
 * semantics without a network call.
 */
export function applyTokenBucketScript(args: ApplyTokenBucketArgs): ApplyTokenBucketResult {
  const { capacity, refillRate, requested } = args
  const nowMs = Math.floor(args.nowMs)

  let tokens: number
  let lastRefill: number

  if (!args.state) {
    tokens = capacity
    lastRefill = nowMs
  } else {
    tokens = args.state.tokens
    lastRefill = args.state.lastRefill
  }

  let elapsed = nowMs - lastRefill
  if (elapsed < 0) elapsed = 0

  const refill = (elapsed / 1000) * refillRate
  if (refill > 0) {
    tokens = Math.min(capacity, tokens + refill)
    lastRefill = nowMs
  }

  let allowed = false
  if (tokens >= requested) {
    tokens = tokens - requested
    allowed = true
  }

  let retryAfterMs = 0
  if (!allowed) {
    const deficit = requested - tokens
    retryAfterMs =
      refillRate > 0 ? Math.ceil((deficit / refillRate) * 1000) : -1
  }

  return { allowed, tokens, lastRefill, retryAfterMs }
}

// ---------------------------------------------------------------------------
// Minimal ioredis-compatible client shape (eval/evalsha/script).
// Keeping this narrow means tests can provide a tiny shim without pulling
// in ioredis at all.
// ---------------------------------------------------------------------------

export interface RedisScriptClient {
  evalsha(
    sha1: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>
  script(subcommand: 'LOAD', script: string): Promise<string>
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RedisTokenBucketStoreOptions {
  /** ioredis-compatible client exposing eval/evalsha/script. */
  redis: RedisScriptClient
  /** Key prefix used to namespace bucket keys. Default: `tb:` */
  keyPrefix?: string
  /** TTL (seconds) used when touching the bucket hash. Default: 3600. */
  ttlSeconds?: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function parseLuaResult(raw: unknown): ConsumeResult {
  // Lua returns [allowed(int), tokens(string), retryAfterMs(string)]
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error(
      `[RedisTokenBucketStore] unexpected Lua return shape: ${JSON.stringify(raw)}`,
    )
  }
  const allowed = Number(raw[0]) === 1
  const tokens = Number(String(raw[1]))
  const retryAfterMs = Number(String(raw[2]))
  return {
    allowed,
    tokensRemaining: tokens,
    retryAfterMs,
  }
}

export class RedisTokenBucketStore implements TokenBucketStore {
  private readonly redis: RedisScriptClient
  private readonly keyPrefix: string
  private readonly ttlSeconds: number
  private scriptSha: string | null = null

  constructor(options: RedisTokenBucketStoreOptions) {
    this.redis = options.redis
    this.keyPrefix = options.keyPrefix ?? 'tb:'
    this.ttlSeconds = options.ttlSeconds ?? 3600
  }

  /** The Lua source this store runs on Redis. */
  get luaSource(): string {
    return TOKEN_BUCKET_LUA
  }

  async consume(
    key: string,
    capacity: number,
    refillRate: number,
    tokens: number,
  ): Promise<ConsumeResult> {
    const nowMs = Math.floor(Date.now())
    const redisKey = this.keyPrefix + key
    const args: (string | number)[] = [
      capacity,
      refillRate,
      tokens,
      nowMs,
      this.ttlSeconds,
    ]

    // Fast path: run cached sha.
    if (this.scriptSha) {
      try {
        const raw = await this.redis.evalsha(this.scriptSha, 1, redisKey, ...args)
        return parseLuaResult(raw)
      } catch (err) {
        // NOSCRIPT happens when Redis has been flushed/restarted.
        // Re-load and retry once below.
        if (!isNoScriptError(err)) throw err
        this.scriptSha = null
      }
    }

    // Load + fall back to EVAL to guarantee progress on first call.
    try {
      this.scriptSha = await this.redis.script('LOAD', TOKEN_BUCKET_LUA)
      const raw = await this.redis.evalsha(
        this.scriptSha,
        1,
        redisKey,
        ...args,
      )
      return parseLuaResult(raw)
    } catch (err) {
      // If SCRIPT LOAD itself fails (e.g. cluster mode quirk), fall back
      // to inline EVAL — slower but always correct.
      const raw = await this.redis.eval(TOKEN_BUCKET_LUA, 1, redisKey, ...args)
      return parseLuaResult(raw)
    }
  }
}

function isNoScriptError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /NOSCRIPT/i.test(message)
}
