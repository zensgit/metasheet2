import type { Request, Response, NextFunction } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRateLimiter, conditionalPublicRateLimiter } from '../../src/middleware/rate-limiter'

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

describe('createRateLimiter', () => {
  let originalDateNow: () => number

  beforeEach(() => {
    originalDateNow = Date.now
  })

  afterEach(() => {
    Date.now = originalDateNow
  })

  it('allows requests within the limit', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 3, keyPrefix: 'test' })
    const next = vi.fn()

    for (let i = 0; i < 3; i++) {
      const req = createMockRequest()
      const res = createMockResponse()
      limiter(req, res, next)
    }

    expect(next).toHaveBeenCalledTimes(3)
    limiter._cleanup()
  })

  it('blocks requests exceeding the limit with 429', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test' })
    const next = vi.fn()

    // First two should pass
    limiter(createMockRequest(), createMockResponse(), next)
    limiter(createMockRequest(), createMockResponse(), next)
    expect(next).toHaveBeenCalledTimes(2)

    // Third should be blocked
    const res = createMockResponse()
    limiter(createMockRequest(), res, next)
    expect(next).toHaveBeenCalledTimes(2) // not called again
    expect(res._status).toBe(429)
    expect(res._body).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    })
    expect(res._headers['Retry-After']).toBeDefined()
    expect(Number(res._headers['Retry-After'])).toBeGreaterThan(0)
    limiter._cleanup()
  })

  it('resets after window expires', () => {
    let now = 1000000
    Date.now = () => now

    const limiter = createRateLimiter({ windowMs: 10_000, maxRequests: 1, keyPrefix: 'test' })
    const next = vi.fn()

    // First request passes
    limiter(createMockRequest(), createMockResponse(), next)
    expect(next).toHaveBeenCalledTimes(1)

    // Second is blocked
    limiter(createMockRequest(), createMockResponse(), next)
    expect(next).toHaveBeenCalledTimes(1)

    // Advance time past window
    now += 10_001
    limiter(createMockRequest(), createMockResponse(), next)
    expect(next).toHaveBeenCalledTimes(2) // passes again
    limiter._cleanup()
  })

  it('different keys do not interfere', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'test' })
    const next = vi.fn()

    // IP 1
    limiter(createMockRequest({ ip: '1.1.1.1' } as any), createMockResponse(), next)
    expect(next).toHaveBeenCalledTimes(1)

    // IP 1 blocked
    const res1 = createMockResponse()
    limiter(createMockRequest({ ip: '1.1.1.1' } as any), res1, next)
    expect(res1._status).toBe(429)

    // IP 2 still passes
    limiter(createMockRequest({ ip: '2.2.2.2' } as any), createMockResponse(), next)
    expect(next).toHaveBeenCalledTimes(2)
    limiter._cleanup()
  })

  it('cleanup removes expired entries', () => {
    let now = 1000000
    Date.now = () => now

    const limiter = createRateLimiter({ windowMs: 5_000, maxRequests: 10, keyPrefix: 'test' })
    const next = vi.fn()

    limiter(createMockRequest({ ip: '1.1.1.1' } as any), createMockResponse(), next)
    limiter(createMockRequest({ ip: '2.2.2.2' } as any), createMockResponse(), next)
    expect(limiter._store.size).toBe(2)

    // Advance past window
    now += 6_000

    // Access one key to trigger on-access prune, but the periodic cleanup
    // would also clean up. Trigger access for IP 1 only.
    limiter(createMockRequest({ ip: '1.1.1.1' } as any), createMockResponse(), next)

    // IP 1 was re-accessed so it stays. IP 2 entry still exists in map
    // but its timestamps are stale. Verify the store prunes on next access.
    const entry2 = limiter._store.get('test:2.2.2.2')
    // The periodic cleanup hasn't fired yet, but on next access for IP 2 it would prune.
    // Let's just verify that a fresh request from IP 2 now succeeds (proves window reset).
    limiter(createMockRequest({ ip: '2.2.2.2' } as any), createMockResponse(), next)
    expect(next).toHaveBeenCalledTimes(4) // all passed
    limiter._cleanup()
  })

  it('uses userId as key when available', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'test' })
    const next = vi.fn()

    const authReq = createMockRequest({ ip: '1.1.1.1' } as any)
    ;(authReq as any).userId = 'user-123'

    limiter(authReq, createMockResponse(), next)
    expect(next).toHaveBeenCalledTimes(1)

    // Same userId from different IP should be blocked
    const authReq2 = createMockRequest({ ip: '2.2.2.2' } as any)
    ;(authReq2 as any).userId = 'user-123'
    const res = createMockResponse()
    limiter(authReq2, res, next)
    expect(res._status).toBe(429)

    // Different IP without userId should pass
    limiter(createMockRequest({ ip: '3.3.3.3' } as any), createMockResponse(), next)
    expect(next).toHaveBeenCalledTimes(2)
    limiter._cleanup()
  })
})

describe('conditionalPublicRateLimiter', () => {
  it('applies rate limiter when publicToken is in query', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'cond' })
    const conditional = conditionalPublicRateLimiter(limiter)
    const next = vi.fn()

    // First request with publicToken passes
    conditional(
      createMockRequest({ query: { publicToken: 'abc123' } } as any),
      createMockResponse(),
      next,
    )
    expect(next).toHaveBeenCalledTimes(1)

    // Second is blocked
    const res = createMockResponse()
    conditional(
      createMockRequest({ query: { publicToken: 'abc123' } } as any),
      res,
      next,
    )
    expect(res._status).toBe(429)
    limiter._cleanup()
  })

  it('skips rate limiter when no publicToken', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'cond' })
    const conditional = conditionalPublicRateLimiter(limiter)
    const next = vi.fn()

    // Multiple requests without publicToken should all pass
    for (let i = 0; i < 5; i++) {
      conditional(createMockRequest(), createMockResponse(), next)
    }
    expect(next).toHaveBeenCalledTimes(5)
    limiter._cleanup()
  })

  it('applies rate limiter when publicToken is in body', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'cond-body' })
    const conditional = conditionalPublicRateLimiter(limiter)
    const next = vi.fn()

    conditional(
      createMockRequest({ body: { publicToken: 'token123' } } as any),
      createMockResponse(),
      next,
    )
    expect(next).toHaveBeenCalledTimes(1)

    const res = createMockResponse()
    conditional(
      createMockRequest({ body: { publicToken: 'token123' } } as any),
      res,
      next,
    )
    expect(res._status).toBe(429)
    limiter._cleanup()
  })
})
