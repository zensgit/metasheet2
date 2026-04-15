import type { Request, Response, NextFunction } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRateLimiter,
  conditionalPublicRateLimiter,
  MemoryRateLimitStore,
  RedisRateLimitStore,
} from '../../src/middleware/rate-limiter'
import type { RedisClient } from '../../src/middleware/rate-limiter'

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request
}

function createMockResponse(): Response & { _status: number; _body: unknown; _headers: Record<string, string> } {
  const res: any = {
    _status: 200,
    _body: undefined,
    _headers: {} as Record<string, string>,
    status(code: number) {
      res._status = code
      return res
    },
    json(body: unknown) {
      res._body = body
      return res
    },
    set(key: string, value: string) {
      res._headers[key] = value
      return res
    },
  }
  return res
}

// ---------------------------------------------------------------------------
// Helper: run async middleware as a promise
// ---------------------------------------------------------------------------
function runMiddleware(
  mw: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
  res: Response,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    mw(req, res, ((err?: unknown) => {
      if (err) reject(err)
      else resolve()
    }) as NextFunction)
  })
}

// ---------------------------------------------------------------------------
// MemoryRateLimitStore unit tests
// ---------------------------------------------------------------------------

describe('MemoryRateLimitStore', () => {
  it('increments count within the same window', async () => {
    const store = new MemoryRateLimitStore()
    const r1 = await store.increment('k', 60_000)
    expect(r1.count).toBe(1)
    const r2 = await store.increment('k', 60_000)
    expect(r2.count).toBe(2)
    store.destroy()
  })

  it('resets count after window expires', async () => {
    const originalNow = Date.now
    let now = 1_000_000
    Date.now = () => now

    const store = new MemoryRateLimitStore()
    await store.increment('k', 5_000)
    await store.increment('k', 5_000)
    expect((await store.increment('k', 5_000)).count).toBe(3)

    // Advance past window
    now += 6_000
    const r = await store.increment('k', 5_000)
    expect(r.count).toBe(1) // reset
    store.destroy()
    Date.now = originalNow
  })

  it('destroy clears internal state', async () => {
    const store = new MemoryRateLimitStore(1000)
    await store.increment('k', 60_000)
    expect(store._map.size).toBe(1)
    store.destroy()
    expect(store._map.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// RedisRateLimitStore unit tests (mocked Redis)
// ---------------------------------------------------------------------------

describe('RedisRateLimitStore', () => {
  function createMockRedis(): RedisClient & { _counters: Map<string, number> } {
    const counters = new Map<string, number>()
    const ttls = new Map<string, number>()
    return {
      _counters: counters,
      async incr(key: string) {
        const val = (counters.get(key) || 0) + 1
        counters.set(key, val)
        return val
      },
      async expire(key: string, seconds: number) {
        ttls.set(key, seconds * 1000)
        return 1
      },
      async pttl(key: string) {
        return ttls.get(key) ?? -1
      },
    }
  }

  it('increments via Redis INCR and sets expiry on first call', async () => {
    const redis = createMockRedis()
    const store = new RedisRateLimitStore(redis)
    const r1 = await store.increment('ratelimit:test:1.1.1.1', 60_000)
    expect(r1.count).toBe(1)
    expect(r1.ttlMs).toBe(60_000)

    const r2 = await store.increment('ratelimit:test:1.1.1.1', 60_000)
    expect(r2.count).toBe(2)
  })

  it('does not reset expiry on subsequent increments', async () => {
    const redis = createMockRedis()
    const expireSpy = vi.spyOn(redis, 'expire')
    const store = new RedisRateLimitStore(redis)

    await store.increment('k', 30_000)
    expect(expireSpy).toHaveBeenCalledTimes(1)

    await store.increment('k', 30_000)
    // expire should NOT be called again (count > 1)
    expect(expireSpy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// createRateLimiter middleware tests (memory-backed, same as V1)
// ---------------------------------------------------------------------------

describe('createRateLimiter', () => {
  it('allows requests within the limit', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 3, keyPrefix: 'test' })

    for (let i = 0; i < 3; i++) {
      const req = createMockRequest()
      const res = createMockResponse()
      await runMiddleware(limiter, req, res)
      expect(res._status).toBe(200)
    }

    limiter._cleanup()
  })

  it('blocks requests exceeding the limit with 429', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test' })

    // First two should pass
    await runMiddleware(limiter, createMockRequest(), createMockResponse())
    await runMiddleware(limiter, createMockRequest(), createMockResponse())

    // Third should be blocked
    const res = createMockResponse()
    // The middleware calls res.status().json() and does NOT call next, so
    // we need to handle the case where next is never called.
    await new Promise<void>((resolve) => {
      limiter(createMockRequest(), res as any, (() => resolve()) as NextFunction)
      // If next isn't called within a tick, the request was blocked
      setTimeout(resolve, 50)
    })
    expect(res._status).toBe(429)
    expect(res._body).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    })
    expect(res._headers['Retry-After']).toBeDefined()
    expect(Number(res._headers['Retry-After'])).toBeGreaterThan(0)
    limiter._cleanup()
  })

  it('resets after window expires', async () => {
    const originalNow = Date.now
    let now = 1_000_000
    Date.now = () => now

    const limiter = createRateLimiter({ windowMs: 10_000, maxRequests: 1, keyPrefix: 'test' })

    // First request passes
    await runMiddleware(limiter, createMockRequest(), createMockResponse())

    // Second is blocked
    const blockedRes = createMockResponse()
    await new Promise<void>((resolve) => {
      limiter(createMockRequest(), blockedRes as any, (() => resolve()) as NextFunction)
      setTimeout(resolve, 50)
    })
    expect(blockedRes._status).toBe(429)

    // Advance time past window
    now += 10_001
    const passRes = createMockResponse()
    await runMiddleware(limiter, createMockRequest(), passRes)
    expect(passRes._status).toBe(200)

    limiter._cleanup()
    Date.now = originalNow
  })

  it('different keys do not interfere', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'test' })

    // IP 1
    await runMiddleware(limiter, createMockRequest({ ip: '1.1.1.1' } as any), createMockResponse())

    // IP 1 blocked
    const res1 = createMockResponse()
    await new Promise<void>((resolve) => {
      limiter(createMockRequest({ ip: '1.1.1.1' } as any), res1 as any, (() => resolve()) as NextFunction)
      setTimeout(resolve, 50)
    })
    expect(res1._status).toBe(429)

    // IP 2 still passes
    const res2 = createMockResponse()
    await runMiddleware(limiter, createMockRequest({ ip: '2.2.2.2' } as any), res2)
    expect(res2._status).toBe(200)

    limiter._cleanup()
  })

  it('uses userId as key when available', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'test' })

    const authReq = createMockRequest({ ip: '1.1.1.1' } as any)
    ;(authReq as any).userId = 'user-123'
    await runMiddleware(limiter, authReq, createMockResponse())

    // Same userId from different IP should be blocked
    const authReq2 = createMockRequest({ ip: '2.2.2.2' } as any)
    ;(authReq2 as any).userId = 'user-123'
    const res = createMockResponse()
    await new Promise<void>((resolve) => {
      limiter(authReq2, res as any, (() => resolve()) as NextFunction)
      setTimeout(resolve, 50)
    })
    expect(res._status).toBe(429)

    // Different IP without userId should pass
    const res3 = createMockResponse()
    await runMiddleware(limiter, createMockRequest({ ip: '3.3.3.3' } as any), res3)
    expect(res3._status).toBe(200)

    limiter._cleanup()
  })
})

// ---------------------------------------------------------------------------
// Redis-backed createRateLimiter tests
// ---------------------------------------------------------------------------

describe('createRateLimiter with Redis', () => {
  function createMockRedis(): RedisClient & { _counters: Map<string, number> } {
    const counters = new Map<string, number>()
    const ttls = new Map<string, number>()
    return {
      _counters: counters,
      async incr(key: string) {
        const val = (counters.get(key) || 0) + 1
        counters.set(key, val)
        return val
      },
      async expire(key: string, seconds: number) {
        ttls.set(key, seconds * 1000)
        return 1
      },
      async pttl(key: string) {
        return ttls.get(key) ?? -1
      },
    }
  }

  it('uses Redis store when redis option is provided', async () => {
    const redis = createMockRedis()
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'redis-test', redis })

    expect(limiter._redisStore).not.toBeNull()

    await runMiddleware(limiter, createMockRequest(), createMockResponse())
    await runMiddleware(limiter, createMockRequest(), createMockResponse())

    // Should have 2 entries in Redis mock
    expect(redis._counters.get('ratelimit:redis-test:127.0.0.1')).toBe(2)

    limiter._cleanup()
  })

  it('falls back to memory when Redis throws', async () => {
    const failingRedis: RedisClient = {
      async incr() { throw new Error('Connection refused') },
      async expire() { throw new Error('Connection refused') },
      async pttl() { throw new Error('Connection refused') },
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'fallback', redis: failingRedis })

    // Should still work via memory fallback
    await runMiddleware(limiter, createMockRequest(), createMockResponse())
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('Redis unavailable')

    // Second call should not warn again
    await runMiddleware(limiter, createMockRequest(), createMockResponse())
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // Third should be blocked (memory store has count 2 now, limit is 2)
    const res = createMockResponse()
    await new Promise<void>((resolve) => {
      limiter(createMockRequest(), res as any, (() => resolve()) as NextFunction)
      setTimeout(resolve, 50)
    })
    expect(res._status).toBe(429)

    warnSpy.mockRestore()
    limiter._cleanup()
  })
})

// ---------------------------------------------------------------------------
// conditionalPublicRateLimiter tests
// ---------------------------------------------------------------------------

describe('conditionalPublicRateLimiter', () => {
  it('applies rate limiter when publicToken is in query', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'cond' })
    const conditional = conditionalPublicRateLimiter(limiter)

    // First request with publicToken passes
    await runMiddleware(
      conditional,
      createMockRequest({ query: { publicToken: 'abc123' } } as any),
      createMockResponse(),
    )

    // Second is blocked
    const res = createMockResponse()
    await new Promise<void>((resolve) => {
      conditional(
        createMockRequest({ query: { publicToken: 'abc123' } } as any),
        res as any,
        (() => resolve()) as NextFunction,
      )
      setTimeout(resolve, 50)
    })
    expect(res._status).toBe(429)
    limiter._cleanup()
  })

  it('skips rate limiter when no publicToken', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'cond' })
    const conditional = conditionalPublicRateLimiter(limiter)

    // Multiple requests without publicToken should all pass
    for (let i = 0; i < 5; i++) {
      await runMiddleware(conditional, createMockRequest(), createMockResponse())
    }

    limiter._cleanup()
  })

  it('applies rate limiter when publicToken is in body', async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'cond-body' })
    const conditional = conditionalPublicRateLimiter(limiter)

    await runMiddleware(
      conditional,
      createMockRequest({ body: { publicToken: 'token123' } } as any),
      createMockResponse(),
    )

    const res = createMockResponse()
    await new Promise<void>((resolve) => {
      conditional(
        createMockRequest({ body: { publicToken: 'token123' } } as any),
        res as any,
        (() => resolve()) as NextFunction,
      )
      setTimeout(resolve, 50)
    })
    expect(res._status).toBe(429)
    limiter._cleanup()
  })
})
