import type { Request, Response, NextFunction } from 'express'
import * as crypto from 'crypto'
import { EventEmitter } from 'events'

// Redis client interface - compatible with both redis and ioredis
export interface RedisClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode?: string, duration?: number): Promise<unknown>
  del(...keys: string[]): Promise<number>
  keys(pattern: string): Promise<string[]>
  multi(): RedisMulti
  ttl(key: string): Promise<number>
}

export interface RedisMulti {
  get(key: string): RedisMulti
  ttl(key: string): RedisMulti
  exec(): Promise<Array<[Error | null, unknown]>>
}

// Extended Request types
export interface AuthenticatedUser {
  id: string | number
  [key: string]: unknown
}

export interface RequestWithRateLimit extends Request {
  rateLimit?: RateLimitInfo
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser
}

export interface RateLimitConfig {
  windowMs?: number        // Time window in milliseconds
  maxRequests?: number      // Max requests per window
  keyGenerator?: (req: Request) => string
  skipSuccessfulRequests?: boolean
  skipFailedRequests?: boolean
  standardHeaders?: boolean // Return rate limit headers
  legacyHeaders?: boolean   // Return X-RateLimit headers
  handler?: (req: Request, res: Response) => void
  onLimitReached?: (req: Request, res: Response) => void
  store?: RateLimitStore
  weight?: (req: Request) => number // Dynamic request weight
  skipIf?: (req: Request) => boolean | Promise<boolean>
}

export interface RateLimitInfo {
  limit: number
  remaining: number
  resetTime: Date
  retryAfter?: number
}

export interface RateLimitStore {
  get(key: string): Promise<RateLimitEntry | null>
  set(key: string, entry: RateLimitEntry, ttlMs: number): Promise<void>
  increment(key: string, weight: number): Promise<RateLimitEntry>
  reset(key: string): Promise<void>
  resetAll(): Promise<void>
}

export interface RateLimitEntry {
  count: number
  resetTime: Date
  firstRequest: Date
}

// Memory store for rate limiting
export class MemoryRateLimitStore implements RateLimitStore {
  private store: Map<string, RateLimitEntry> = new Map()
  private timers: Map<string, NodeJS.Timeout> = new Map()

  async get(key: string): Promise<RateLimitEntry | null> {
    const entry = this.store.get(key)
    if (!entry) return null

    if (entry.resetTime < new Date()) {
      this.store.delete(key)
      return null
    }

    return entry
  }

  async set(key: string, entry: RateLimitEntry, ttlMs: number): Promise<void> {
    this.store.set(key, entry)

    // Clear existing timer
    const existingTimer = this.timers.get(key)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Set new timer for cleanup
    const timer = setTimeout(() => {
      this.store.delete(key)
      this.timers.delete(key)
    }, ttlMs)

    this.timers.set(key, timer)
  }

  async increment(key: string, weight: number = 1): Promise<RateLimitEntry> {
    const entry = await this.get(key)

    if (entry) {
      entry.count += weight
      return entry
    }

    // Create new entry
    const windowMs = 60000 // Default 1 minute
    const newEntry: RateLimitEntry = {
      count: weight,
      resetTime: new Date(Date.now() + windowMs),
      firstRequest: new Date()
    }

    await this.set(key, newEntry, windowMs)
    return newEntry
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key)
    const timer = this.timers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
  }

  async resetAll(): Promise<void> {
    this.store.clear()
    this.timers.forEach(timer => clearTimeout(timer))
    this.timers.clear()
  }
}

// Redis store for distributed rate limiting
export class RedisRateLimitStore implements RateLimitStore {
  private redis: RedisClient

  constructor(redisClient: RedisClient) {
    this.redis = redisClient
  }

  async get(key: string): Promise<RateLimitEntry | null> {
    const data = await this.redis.get(`ratelimit:${key}`)
    if (!data) return null

    const entry = JSON.parse(data) as Record<string, unknown>
    const rateLimitEntry: RateLimitEntry = {
      count: typeof entry.count === 'number' ? entry.count : 0,
      resetTime: new Date(entry.resetTime as string | number | Date),
      firstRequest: new Date(entry.firstRequest as string | number | Date)
    }

    if (rateLimitEntry.resetTime < new Date()) {
      await this.redis.del(`ratelimit:${key}`)
      return null
    }

    return rateLimitEntry
  }

  async set(key: string, entry: RateLimitEntry, ttlMs: number): Promise<void> {
    const data = JSON.stringify(entry)
    await this.redis.set(`ratelimit:${key}`, data, 'PX', ttlMs)
  }

  async increment(key: string, weight: number = 1): Promise<RateLimitEntry> {
    const redisKey = `ratelimit:${key}`

    // Use Redis MULTI for atomic operation
    const multi = this.redis.multi()
    multi.get(redisKey)
    multi.ttl(redisKey)

    const results = await multi.exec()
    const [[error1, data], [error2, ttl]] = results

    if (error1 || error2) {
      throw new Error('Redis operation failed')
    }

    if (data && typeof data === 'string') {
      const parsedEntry = JSON.parse(data) as Record<string, unknown>
      const entry: RateLimitEntry = {
        count: (typeof parsedEntry.count === 'number' ? parsedEntry.count : 0) + weight,
        resetTime: new Date(parsedEntry.resetTime as string | number | Date),
        firstRequest: new Date(parsedEntry.firstRequest as string | number | Date)
      }

      const ttlSeconds = typeof ttl === 'number' ? ttl : 60
      await this.redis.set(redisKey, JSON.stringify(entry), 'PX', ttlSeconds * 1000)
      return entry
    }

    // Create new entry
    const windowMs = 60000
    const newEntry: RateLimitEntry = {
      count: weight,
      resetTime: new Date(Date.now() + windowMs),
      firstRequest: new Date()
    }

    await this.set(key, newEntry, windowMs)
    return newEntry
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`ratelimit:${key}`)
  }

  async resetAll(): Promise<void> {
    const keys = await this.redis.keys('ratelimit:*')
    if (keys.length > 0) {
      await this.redis.del(...keys)
    }
  }
}

export class RateLimiter extends EventEmitter {
  private config: Required<RateLimitConfig>
  private store: RateLimitStore

  constructor(config: RateLimitConfig = {}) {
    super()

    this.config = {
      windowMs: config.windowMs || 60000, // 1 minute default
      maxRequests: config.maxRequests || 100,
      keyGenerator: config.keyGenerator || this.defaultKeyGenerator,
      skipSuccessfulRequests: config.skipSuccessfulRequests || false,
      skipFailedRequests: config.skipFailedRequests || false,
      standardHeaders: config.standardHeaders !== false,
      legacyHeaders: config.legacyHeaders || false,
      handler: config.handler || this.defaultHandler,
      onLimitReached: config.onLimitReached || (() => {}),
      store: config.store || new MemoryRateLimitStore(),
      weight: config.weight || (() => 1),
      skipIf: config.skipIf || (() => false)
    }

    this.store = this.config.store
  }

  private defaultKeyGenerator(req: Request): string {
    // Use IP address as default key
    return req.ip ||
           req.headers['x-forwarded-for']?.toString().split(',')[0] ||
           req.connection.remoteAddress ||
           'unknown'
  }

  private defaultHandler(req: Request, res: Response): void {
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded, please try again later',
      retryAfter: Math.ceil(this.config.windowMs / 1000)
    })
  }

  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Check if should skip
        if (await this.config.skipIf(req)) {
          return next()
        }

        const key = this.config.keyGenerator(req)
        const weight = this.config.weight(req)

        // Get current state
        let entry = await this.store.get(key)

        // Check if window expired
        if (!entry || entry.resetTime < new Date()) {
          entry = await this.store.increment(key, 0)
        }

        const info: RateLimitInfo = {
          limit: this.config.maxRequests,
          remaining: Math.max(0, this.config.maxRequests - entry.count),
          resetTime: entry.resetTime,
          retryAfter: Math.ceil((entry.resetTime.getTime() - Date.now()) / 1000)
        }

        // Set headers
        if (this.config.standardHeaders) {
          res.setHeader('RateLimit-Limit', info.limit)
          res.setHeader('RateLimit-Remaining', info.remaining)
          res.setHeader('RateLimit-Reset', entry.resetTime.toISOString())
        }

        if (this.config.legacyHeaders) {
          res.setHeader('X-RateLimit-Limit', info.limit)
          res.setHeader('X-RateLimit-Remaining', info.remaining)
          res.setHeader('X-RateLimit-Reset', Math.floor(entry.resetTime.getTime() / 1000))
        }

        // Check if limit exceeded
        if (entry.count >= this.config.maxRequests) {
          if (info.retryAfter !== undefined) {
            res.setHeader('Retry-After', info.retryAfter)
          }

          this.emit('limitReached', { req, res, key, info })
          this.config.onLimitReached(req, res)

          return this.config.handler(req, res)
        }

        // Increment counter
        await this.store.increment(key, weight)

        // Store info for later use with type assertion
        const extendedReq = req as RequestWithRateLimit
        extendedReq.rateLimit = info

        // Hook to skip counting successful/failed requests
        const originalSend = res.send
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const rateLimiter = this
        res.send = function(this: Response, data: unknown) {
          const shouldSkip = (
            (res.statusCode < 400 && rateLimiter.config.skipSuccessfulRequests) ||
            (res.statusCode >= 400 && rateLimiter.config.skipFailedRequests)
          )

          if (shouldSkip) {
            // Decrement the counter
            rateLimiter.store.increment(key, -weight).catch(() => {})
          }

          return originalSend.call(this, data)
        }

        next()
      } catch (error) {
        this.emit('error', error)
        next(error)
      }
    }
  }

  async reset(key?: string): Promise<void> {
    if (key) {
      await this.store.reset(key)
    } else {
      await this.store.resetAll()
    }
  }

  async getInfo(key: string): Promise<RateLimitInfo | null> {
    const entry = await this.store.get(key)
    if (!entry) return null

    return {
      limit: this.config.maxRequests,
      remaining: Math.max(0, this.config.maxRequests - entry.count),
      resetTime: entry.resetTime,
      retryAfter: Math.ceil((entry.resetTime.getTime() - Date.now()) / 1000)
    }
  }
}

// Utility functions for creating common rate limiters
export function createRateLimiter(options: RateLimitConfig): RateLimiter {
  return new RateLimiter(options)
}

export function createStrictRateLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 60000,  // 1 minute
    maxRequests: 10,  // 10 requests per minute
    standardHeaders: true,
    legacyHeaders: false
  })
}

export function createModerateRateLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 60000,  // 1 minute
    maxRequests: 60,  // 60 requests per minute
    standardHeaders: true,
    legacyHeaders: false
  })
}

export function createRelaxedRateLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 60000,   // 1 minute
    maxRequests: 200,  // 200 requests per minute
    standardHeaders: true,
    legacyHeaders: false
  })
}

// API-specific rate limiters
export function createApiRateLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 100,
    standardHeaders: true,
    keyGenerator: (req) => {
      // Use API key if present, otherwise use IP
      const apiKey = req.headers['x-api-key']?.toString()
      if (apiKey) {
        return `api:${crypto.createHash('sha256').update(apiKey).digest('hex')}`
      }
      return req.ip || 'unknown'
    }
  })
}

export function createUserRateLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 60000,
    maxRequests: 100,
    standardHeaders: true,
    keyGenerator: (req) => {
      // Use user ID if authenticated
      const userReq = req as RequestWithUser
      if (userReq.user?.id) {
        return `user:${userReq.user.id}`
      }
      return req.ip || 'unknown'
    }
  })
}
