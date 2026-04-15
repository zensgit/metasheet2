/**
 * Generic sliding-window rate limiter middleware with pluggable store.
 *
 * V1 used an in-memory Map.
 * V2 adds a RateLimitStore interface with Redis and Memory implementations.
 * If a Redis store is provided but becomes unavailable, the middleware
 * falls back to the in-memory store automatically.
 */

import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface RateLimitStore {
  /**
   * Increment the counter for `key` within the given window.
   * Returns the current count and remaining TTL in milliseconds.
   * Implementations must create the key with the given windowMs if it
   * does not already exist.
   */
  increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>

  /**
   * Optional cleanup hook (e.g. clear timers).
   */
  destroy?(): void
}

// ---------------------------------------------------------------------------
// In-memory store (default / fallback)
// ---------------------------------------------------------------------------

interface MemoryEntry {
  count: number
  /** epoch-ms when the window expires */
  expiresAt: number
}

export class MemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, MemoryEntry>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(cleanupIntervalMs?: number) {
    if (cleanupIntervalMs && cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        const now = Date.now()
        for (const [key, entry] of this.store.entries()) {
          if (now >= entry.expiresAt) {
            this.store.delete(key)
          }
        }
      }, cleanupIntervalMs)
      if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
        this.cleanupTimer.unref()
      }
    }
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const now = Date.now()
    let entry = this.store.get(key)

    if (!entry || now >= entry.expiresAt) {
      entry = { count: 0, expiresAt: now + windowMs }
      this.store.set(key, entry)
    }

    entry.count += 1
    const ttlMs = Math.max(0, entry.expiresAt - now)
    return { count: entry.count, ttlMs }
  }

  /** Expose the internal map for testing purposes */
  get _map(): Map<string, MemoryEntry> {
    return this.store
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.store.clear()
  }
}

// ---------------------------------------------------------------------------
// Redis store (ioredis compatible)
// ---------------------------------------------------------------------------

/**
 * Minimal ioredis-compatible interface so callers can pass any Redis client
 * that supports incr + expire + ttl.
 */
export interface RedisClient {
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number | boolean>
  pttl(key: string): Promise<number>
}

export class RedisRateLimitStore implements RateLimitStore {
  private redis: RedisClient

  constructor(redis: RedisClient) {
    this.redis = redis
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const count = await this.redis.incr(key)

    // If this is the first increment (count === 1), set the expiry.
    if (count === 1) {
      const ttlSeconds = Math.max(1, Math.ceil(windowMs / 1000))
      await this.redis.expire(key, ttlSeconds)
    }

    const pttl = await this.redis.pttl(key)
    // pttl returns -1 if no expiry, -2 if key doesn't exist
    const ttlMs = pttl > 0 ? pttl : windowMs

    return { count, ttlMs }
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  /** Time window in milliseconds */
  windowMs: number
  /** Maximum number of requests allowed within the window */
  maxRequests: number
  /** Prefix used to namespace keys (e.g. 'public-form-submit') */
  keyPrefix: string
  /** Optional Redis client — enables distributed rate limiting.
   *  If omitted or if Redis operations fail, falls back to in-memory store. */
  redis?: RedisClient
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create a rate limiter middleware with the given options.
 *
 * Key extraction:
 * - Anonymous requests: keyed by `req.ip`
 * - Authenticated requests: keyed by `(req as any).userId`
 *
 * When a Redis client is provided, it is used as the primary store.
 * If any Redis operation throws, the middleware logs a warning and
 * transparently falls back to the in-memory store for that request.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const { windowMs, maxRequests, keyPrefix, redis } = options

  const memoryStore = new MemoryRateLimitStore(windowMs)
  const redisStore = redis ? new RedisRateLimitStore(redis) : null

  let redisFallbackWarned = false

  function middleware(req: Request, res: Response, next: NextFunction): void {
    const userId = (req as any).userId as string | undefined
    const rawKey = userId || req.ip || 'unknown'
    const key = `ratelimit:${keyPrefix}:${rawKey}`

    const handleResult = (result: { count: number; ttlMs: number }) => {
      if (result.count > maxRequests) {
        const retryAfterSeconds = Math.ceil(result.ttlMs / 1000)
        res.set('Retry-After', String(retryAfterSeconds))
        res.status(429).json({
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Please try again later.',
            retryAfter: retryAfterSeconds,
          },
        })
        return
      }

      next()
    }

    const primaryStore = redisStore || memoryStore

    // Synchronous wrapper that handles the async store call
    primaryStore.increment(key, windowMs).then(handleResult).catch((err) => {
      // Redis failed — fall back to memory store
      if (!redisFallbackWarned) {
        console.warn(
          `[rate-limiter] Redis unavailable for prefix "${keyPrefix}", falling back to in-memory store:`,
          err instanceof Error ? err.message : err,
        )
        redisFallbackWarned = true
      }
      memoryStore.increment(key, windowMs).then(handleResult).catch(() => {
        // Memory store should never fail, but just in case, let the request through
        next()
      })
    })
  }

  // Expose internals for testing
  middleware._memoryStore = memoryStore
  middleware._redisStore = redisStore
  middleware._cleanup = () => memoryStore.destroy()

  return middleware
}

// ---------------------------------------------------------------------------
// Pre-configured instances for public form endpoints
// ---------------------------------------------------------------------------

/** Public form submissions: 10 requests per 15 minutes per IP */
export const publicFormSubmitLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'public-form-submit',
})

/** Public form context loading: 60 requests per 15 minutes per IP */
export const publicFormContextLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 60,
  keyPrefix: 'public-form-context',
})

/**
 * Wrap a rate limiter so it only fires when `publicToken` is present
 * on the request (query string or body). Authenticated users bypass
 * the limiter entirely.
 */
export function conditionalPublicRateLimiter(
  limiter: ReturnType<typeof createRateLimiter>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hasPublicToken =
      (typeof req.query.publicToken === 'string' && req.query.publicToken.trim() !== '') ||
      (req.body && typeof req.body.publicToken === 'string' && req.body.publicToken.trim() !== '')

    if (hasPublicToken) {
      limiter(req, res, next)
    } else {
      next()
    }
  }
}
