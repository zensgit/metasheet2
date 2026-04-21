/**
 * Token Bucket Rate Limiter
 * Sprint 6 Day 4: Per-tenant rate limiting for MessageBus protection
 *
 * Implements the classic Token Bucket algorithm:
 * - Bucket holds tokens up to capacity (burst allowance)
 * - Tokens refill at a constant rate (tokens per second)
 * - Each message consumes one token
 * - When bucket is empty, requests are rate-limited
 */

import { Logger } from '../../core/logger'
import { coreMetrics } from '../metrics/metrics'
import type { TokenBucketStore, ConsumeResult } from './token-bucket-store'

const logger = new Logger('TokenBucketRateLimiter')

/**
 * Token bucket state for a single rate-limited entity
 */
interface TokenBucket {
  /** Current number of tokens available */
  tokens: number
  /** Last time tokens were refilled */
  lastRefill: number
  /** Total messages accepted since bucket creation */
  totalAccepted: number
  /** Total messages rejected since bucket creation */
  totalRejected: number
}

/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
  /** Tokens per second refill rate (default: 1000 msg/s) */
  tokensPerSecond?: number
  /** Maximum bucket capacity / burst size (default: tokensPerSecond * 2) */
  bucketCapacity?: number
  /** Enable metrics collection (default: true) */
  enableMetrics?: boolean
  /** Bucket cleanup interval in ms (default: 60000) */
  cleanupIntervalMs?: number
  /** Bucket idle timeout in ms before cleanup (default: 300000 = 5 min) */
  bucketIdleTimeoutMs?: number
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean
  /** Current tokens remaining */
  tokensRemaining: number
  /** Bucket capacity */
  bucketCapacity: number
  /** Time until a token is available (ms), 0 if allowed */
  retryAfterMs: number
  /** Key that was rate limited */
  key: string
}

/**
 * Token Bucket Rate Limiter with per-key buckets
 */
export class TokenBucketRateLimiter {
  private readonly config: Required<RateLimiterConfig>
  private readonly buckets: Map<string, TokenBucket> = new Map()
  private cleanupInterval: NodeJS.Timeout | null = null
  /**
   * Optional pluggable store. When provided, `consumeAsync()` routes
   * through it (typically Redis) for cross-process coordination. The
   * legacy synchronous `consume()` API continues to use the in-process
   * Map so no existing caller needs to change.
   */
  private readonly store: TokenBucketStore | null

  constructor(config: RateLimiterConfig = {}, store?: TokenBucketStore) {
    const tokensPerSecond = config.tokensPerSecond ?? 1000

    this.config = {
      tokensPerSecond,
      bucketCapacity: config.bucketCapacity ?? tokensPerSecond * 2, // 2 second burst
      enableMetrics: config.enableMetrics ?? true,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 60000,
      bucketIdleTimeoutMs: config.bucketIdleTimeoutMs ?? 300000
    }

    this.store = store ?? null

    // Start cleanup interval
    this.startCleanupInterval()

    logger.info('TokenBucketRateLimiter initialized', {
      tokensPerSecond: this.config.tokensPerSecond,
      bucketCapacity: this.config.bucketCapacity,
      store: this.store ? this.store.constructor?.name ?? 'custom' : 'memory-sync'
    })
  }

  /**
   * Asynchronous consume path. When a `TokenBucketStore` was provided to
   * the constructor, the call is dispatched through it (enabling Redis
   * or other cross-process storage). When no store was configured, this
   * method delegates to the synchronous in-process implementation so
   * existing metrics and stats remain consistent.
   */
  async consumeAsync(key: string, tokens = 1): Promise<RateLimitResult> {
    if (!this.store) {
      return this.consume(key, tokens)
    }

    const raw: ConsumeResult = await this.store.consume(
      key,
      this.config.bucketCapacity,
      this.config.tokensPerSecond,
      tokens,
    )

    if (this.config.enableMetrics) {
      coreMetrics.increment(
        raw.allowed ? 'rate_limit_allowed' : 'rate_limit_rejected',
        { key },
      )
      if (!raw.allowed) coreMetrics.increment('rate_limit_total_rejected')
    }

    return {
      allowed: raw.allowed,
      tokensRemaining: raw.tokensRemaining,
      bucketCapacity: this.config.bucketCapacity,
      retryAfterMs: raw.allowed ? 0 : Math.max(0, raw.retryAfterMs),
      key,
    }
  }

  /**
   * Check if a request is allowed and consume a token
   */
  consume(key: string, tokens = 1): RateLimitResult {
    const bucket = this.getOrCreateBucket(key)
    this.refillBucket(bucket)

    const result: RateLimitResult = {
      allowed: false,
      tokensRemaining: bucket.tokens,
      bucketCapacity: this.config.bucketCapacity,
      retryAfterMs: 0,
      key
    }

    if (bucket.tokens >= tokens) {
      // Allow request
      bucket.tokens -= tokens
      bucket.totalAccepted++
      result.allowed = true
      result.tokensRemaining = bucket.tokens

      if (this.config.enableMetrics) {
        coreMetrics.increment('rate_limit_allowed', { key })
      }
    } else {
      // Reject request
      bucket.totalRejected++
      result.allowed = false
      result.retryAfterMs = this.calculateRetryAfter(bucket, tokens)

      if (this.config.enableMetrics) {
        coreMetrics.increment('rate_limit_rejected', { key })
        coreMetrics.increment('rate_limit_total_rejected')
      }

      logger.debug(`Rate limit exceeded for key: ${key}`, {
        tokensRemaining: bucket.tokens,
        retryAfterMs: result.retryAfterMs
      })
    }

    return result
  }

  /**
   * Check if a request would be allowed without consuming tokens
   */
  check(key: string, tokens = 1): RateLimitResult {
    const bucket = this.buckets.get(key)

    if (!bucket) {
      return {
        allowed: true,
        tokensRemaining: this.config.bucketCapacity,
        bucketCapacity: this.config.bucketCapacity,
        retryAfterMs: 0,
        key
      }
    }

    // Create a copy to check without modifying
    const tempBucket: TokenBucket = { ...bucket }
    this.refillBucket(tempBucket)

    return {
      allowed: tempBucket.tokens >= tokens,
      tokensRemaining: tempBucket.tokens,
      bucketCapacity: this.config.bucketCapacity,
      retryAfterMs: tempBucket.tokens >= tokens ? 0 : this.calculateRetryAfter(tempBucket, tokens),
      key
    }
  }

  /**
   * Reset rate limit for a specific key
   */
  reset(key: string): void {
    this.buckets.delete(key)
    logger.debug(`Rate limit reset for key: ${key}`)
  }

  /**
   * Reset all rate limits
   */
  resetAll(): void {
    this.buckets.clear()
    logger.info('All rate limits reset')
  }

  /**
   * Get statistics for a specific key
   */
  getStats(key: string): {
    tokensRemaining: number
    bucketCapacity: number
    totalAccepted: number
    totalRejected: number
    acceptanceRate: number
  } | null {
    const bucket = this.buckets.get(key)
    if (!bucket) return null

    // Refill to get current state
    this.refillBucket(bucket)

    const total = bucket.totalAccepted + bucket.totalRejected
    return {
      tokensRemaining: bucket.tokens,
      bucketCapacity: this.config.bucketCapacity,
      totalAccepted: bucket.totalAccepted,
      totalRejected: bucket.totalRejected,
      acceptanceRate: total > 0 ? bucket.totalAccepted / total : 1
    }
  }

  /**
   * Get global statistics
   */
  getGlobalStats(): {
    activeBuckets: number
    totalAccepted: number
    totalRejected: number
    averageTokensRemaining: number
  } {
    let totalAccepted = 0
    let totalRejected = 0
    let totalTokens = 0

    for (const bucket of this.buckets.values()) {
      this.refillBucket(bucket)
      totalAccepted += bucket.totalAccepted
      totalRejected += bucket.totalRejected
      totalTokens += bucket.tokens
    }

    return {
      activeBuckets: this.buckets.size,
      totalAccepted,
      totalRejected,
      averageTokensRemaining: this.buckets.size > 0 ? totalTokens / this.buckets.size : 0
    }
  }

  /**
   * Update configuration dynamically
   */
  updateConfig(newConfig: Partial<RateLimiterConfig>): void {
    if (newConfig.tokensPerSecond !== undefined) {
      this.config.tokensPerSecond = newConfig.tokensPerSecond
    }
    if (newConfig.bucketCapacity !== undefined) {
      this.config.bucketCapacity = newConfig.bucketCapacity
    }
    if (newConfig.enableMetrics !== undefined) {
      this.config.enableMetrics = newConfig.enableMetrics
    }

    logger.info('RateLimiter configuration updated', this.config)
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<RateLimiterConfig> {
    return { ...this.config }
  }

  /**
   * Shutdown the rate limiter
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.buckets.clear()
    logger.info('TokenBucketRateLimiter shutdown complete')
  }

  /**
   * Get or create a bucket for a key
   */
  private getOrCreateBucket(key: string): TokenBucket {
    let bucket = this.buckets.get(key)

    if (!bucket) {
      bucket = {
        tokens: this.config.bucketCapacity,
        lastRefill: Date.now(),
        totalAccepted: 0,
        totalRejected: 0
      }
      this.buckets.set(key, bucket)

      if (this.config.enableMetrics) {
        coreMetrics.gauge('rate_limit_active_buckets', this.buckets.size)
      }
    }

    return bucket
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillBucket(bucket: TokenBucket): void {
    const now = Date.now()
    const elapsed = now - bucket.lastRefill
    const tokensToAdd = (elapsed / 1000) * this.config.tokensPerSecond

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(
        this.config.bucketCapacity,
        bucket.tokens + tokensToAdd
      )
      bucket.lastRefill = now
    }
  }

  /**
   * Calculate retry after time in milliseconds
   */
  private calculateRetryAfter(bucket: TokenBucket, tokensNeeded: number): number {
    const tokensDeficit = tokensNeeded - bucket.tokens
    if (tokensDeficit <= 0) return 0

    // Time needed to refill enough tokens
    return Math.ceil((tokensDeficit / this.config.tokensPerSecond) * 1000)
  }

  /**
   * Start periodic cleanup of idle buckets
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleBuckets()
    }, this.config.cleanupIntervalMs)

    // Don't prevent process exit
    this.cleanupInterval.unref()
  }

  /**
   * Remove buckets that have been idle too long
   */
  private cleanupIdleBuckets(): void {
    const now = Date.now()
    const threshold = now - this.config.bucketIdleTimeoutMs
    let cleaned = 0

    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.lastRefill < threshold) {
        this.buckets.delete(key)
        cleaned++
      }
    }

    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} idle rate limit buckets`)
      if (this.config.enableMetrics) {
        coreMetrics.gauge('rate_limit_active_buckets', this.buckets.size)
      }
    }
  }
}

/**
 * Singleton rate limiter instance with default configuration
 */
let defaultRateLimiter: TokenBucketRateLimiter | null = null

export function getRateLimiter(config?: RateLimiterConfig): TokenBucketRateLimiter {
  if (!defaultRateLimiter) {
    defaultRateLimiter = new TokenBucketRateLimiter(config)
  }
  return defaultRateLimiter
}

export function resetRateLimiter(): void {
  if (defaultRateLimiter) {
    defaultRateLimiter.shutdown()
    defaultRateLimiter = null
  }
}
