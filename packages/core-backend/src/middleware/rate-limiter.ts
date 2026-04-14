/**
 * Generic in-memory sliding-window rate limiter middleware.
 *
 * V1 uses a Map-based store (no Redis dependency).
 * Suitable for single-process deployments; swap store for Redis in V2.
 */

import type { Request, Response, NextFunction } from 'express'

export interface RateLimiterOptions {
  /** Time window in milliseconds */
  windowMs: number
  /** Maximum number of requests allowed within the window */
  maxRequests: number
  /** Prefix used to namespace keys (e.g. 'public-form-submit') */
  keyPrefix: string
}

interface WindowEntry {
  /** Timestamps (ms) of requests within the current window */
  timestamps: number[]
}

/**
 * Create a rate limiter middleware with the given options.
 *
 * Key extraction:
 * - Anonymous requests: keyed by `req.ip`
 * - Authenticated requests: keyed by `(req as any).userId`
 *
 * On-access cleanup: expired entries are pruned every time a key is accessed
 * and a periodic sweep runs every `windowMs` to remove stale entries.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const { windowMs, maxRequests, keyPrefix } = options
  const store = new Map<string, WindowEntry>()

  // Periodic cleanup of stale entries
  const cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store.entries()) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs)
      if (entry.timestamps.length === 0) {
        store.delete(key)
      }
    }
  }, windowMs)

  // Allow the timer to not block Node process exit
  if (cleanupInterval && typeof cleanupInterval === 'object' && 'unref' in cleanupInterval) {
    cleanupInterval.unref()
  }

  function middleware(req: Request, res: Response, next: NextFunction): void {
    const userId = (req as any).userId as string | undefined
    const rawKey = userId || req.ip || 'unknown'
    const key = `${keyPrefix}:${rawKey}`

    const now = Date.now()
    let entry = store.get(key)
    if (!entry) {
      entry = { timestamps: [] }
      store.set(key, entry)
    }

    // Prune timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs)

    if (entry.timestamps.length >= maxRequests) {
      const oldestInWindow = entry.timestamps[0]
      const retryAfterMs = windowMs - (now - oldestInWindow)
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000)
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

    entry.timestamps.push(now)
    next()
  }

  // Expose internals for testing
  middleware._store = store
  middleware._cleanup = () => clearInterval(cleanupInterval)

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
