/**
 * Message Rate Limiter
 * Sprint 6 Day 4: MessageBus integration for tenant-based rate limiting
 *
 * Intercepts messages and applies rate limiting based on tenant ID
 * extracted from message headers.
 */

import { Logger } from '../../core/logger'
import { coreMetrics } from '../metrics/metrics'
import { TokenBucketRateLimiter, getRateLimiter } from './token-bucket'
import type { RateLimiterConfig, RateLimitResult } from './token-bucket'

const logger = new Logger('MessageRateLimiter')

/**
 * Message with headers interface
 */
interface MessageWithHeaders {
  id?: string
  topic?: string
  headers?: Record<string, unknown>
  payload?: unknown
}

/**
 * Handler function type
 */
type MessageHandler<T = unknown, R = unknown> = (msg: T) => Promise<R> | R

/**
 * Rate limit violation handler
 */
export type RateLimitViolationHandler = (
  key: string,
  result: RateLimitResult,
  msg: MessageWithHeaders
) => void | Promise<void>

/**
 * Message rate limiter configuration
 */
export interface MessageRateLimiterConfig {
  /** Header name to extract tenant ID from (default: 'x-tenant-id') */
  tenantHeaderName?: string
  /** Topics to exclude from rate limiting */
  excludeTopics?: string[]
  /** Custom key extractor for rate limiting */
  keyExtractor?: (msg: MessageWithHeaders) => string | undefined
  /** Handler called when rate limit is violated */
  onRateLimitViolation?: RateLimitViolationHandler
  /** Whether to throw on rate limit (default: true) */
  throwOnRateLimit?: boolean
  /** Token bucket configuration */
  rateLimiterConfig?: RateLimiterConfig
  /** Enable metrics (default: true) */
  enableMetrics?: boolean
}

/**
 * Rate limit error thrown when message exceeds rate limit
 */
export class RateLimitError extends Error {
  readonly key: string
  readonly retryAfterMs: number
  readonly tokensRemaining: number

  constructor(key: string, result: RateLimitResult) {
    super(`Rate limit exceeded for ${key}. Retry after ${result.retryAfterMs}ms`)
    this.name = 'RateLimitError'
    this.key = key
    this.retryAfterMs = result.retryAfterMs
    this.tokensRemaining = result.tokensRemaining
  }
}

/**
 * MessageRateLimiter wraps message handlers with rate limiting
 */
export class MessageRateLimiter {
  private readonly config: Required<Omit<MessageRateLimiterConfig, 'keyExtractor' | 'onRateLimitViolation' | 'rateLimiterConfig'>> & {
    keyExtractor?: (msg: MessageWithHeaders) => string | undefined
    onRateLimitViolation?: RateLimitViolationHandler
  }
  private rateLimiter: TokenBucketRateLimiter
  private readonly excludeTopicSet: Set<string>

  constructor(config: MessageRateLimiterConfig = {}) {
    this.config = {
      tenantHeaderName: config.tenantHeaderName ?? 'x-tenant-id',
      excludeTopics: config.excludeTopics ?? [],
      throwOnRateLimit: config.throwOnRateLimit ?? true,
      enableMetrics: config.enableMetrics ?? true,
      keyExtractor: config.keyExtractor,
      onRateLimitViolation: config.onRateLimitViolation
    }

    this.excludeTopicSet = new Set(this.config.excludeTopics)

    // Add system topics to exclusion list
    this.excludeTopicSet.add('__rpc.reply.*')
    this.excludeTopicSet.add('system.*')
    this.excludeTopicSet.add('health.*')

    // Create or get rate limiter
    this.rateLimiter = config.rateLimiterConfig
      ? new TokenBucketRateLimiter(config.rateLimiterConfig)
      : getRateLimiter()

    logger.info('MessageRateLimiter initialized', {
      tokensPerSecond: this.rateLimiter.getConfig().tokensPerSecond,
      excludeTopics: this.config.excludeTopics.length
    })
  }

  /**
   * Set a custom rate limiter instance
   */
  setRateLimiter(limiter: TokenBucketRateLimiter): void {
    this.rateLimiter = limiter
    logger.info('MessageRateLimiter configured with custom rate limiter')
  }

  /**
   * Check if a topic should be excluded from rate limiting
   */
  private shouldExclude(topic: string): boolean {
    // Check exact match
    if (this.excludeTopicSet.has(topic)) {
      return true
    }

    // Check wildcard patterns
    for (const pattern of this.excludeTopicSet) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1)
        if (topic.startsWith(prefix)) {
          return true
        }
      }
    }

    return false
  }

  /**
   * Extract rate limit key from message
   */
  private extractKey(msg: MessageWithHeaders): string | undefined {
    // Use custom extractor if provided
    if (this.config.keyExtractor) {
      return this.config.keyExtractor(msg)
    }

    // Extract from headers
    const headers = msg.headers
    if (!headers) return undefined

    const tenantId = headers[this.config.tenantHeaderName]
    if (typeof tenantId === 'string' && tenantId.length > 0) {
      return `tenant:${tenantId}`
    }

    return undefined
  }

  /**
   * Wrap a message handler with rate limiting
   */
  wrap<T extends MessageWithHeaders, R>(
    handler: MessageHandler<T, R>
  ): MessageHandler<T, R> {
    return async (msg: T): Promise<R> => {
      const topic = msg.topic ?? 'unknown'

      // Skip excluded topics
      if (this.shouldExclude(topic)) {
        return handler(msg)
      }

      // Extract rate limit key
      const key = this.extractKey(msg)

      // No key -> no rate limiting
      if (!key) {
        return handler(msg)
      }

      // Check rate limit
      const result = this.rateLimiter.consume(key)

      if (!result.allowed) {
        // Rate limit exceeded
        if (this.config.enableMetrics) {
          coreMetrics.increment('message_rate_limited', { key, topic })
        }

        // Call violation handler if provided
        if (this.config.onRateLimitViolation) {
          await this.config.onRateLimitViolation(key, result, msg)
        }

        // Throw or silently drop
        if (this.config.throwOnRateLimit) {
          throw new RateLimitError(key, result)
        }

        // Return undefined to indicate dropped message
        return undefined as R
      }

      // Rate limit passed - execute handler
      return handler(msg)
    }
  }

  /**
   * Check rate limit without consuming tokens
   */
  check(msg: MessageWithHeaders): RateLimitResult | null {
    const key = this.extractKey(msg)
    if (!key) return null
    return this.rateLimiter.check(key)
  }

  /**
   * Get rate limit stats for a tenant
   */
  getStatsForTenant(tenantId: string): ReturnType<TokenBucketRateLimiter['getStats']> {
    return this.rateLimiter.getStats(`tenant:${tenantId}`)
  }

  /**
   * Get global rate limiter stats
   */
  getGlobalStats(): ReturnType<TokenBucketRateLimiter['getGlobalStats']> {
    return this.rateLimiter.getGlobalStats()
  }

  /**
   * Reset rate limit for a tenant
   */
  resetTenant(tenantId: string): void {
    this.rateLimiter.reset(`tenant:${tenantId}`)
  }

  /**
   * Reset all rate limits
   */
  resetAll(): void {
    this.rateLimiter.resetAll()
  }

  /**
   * Get underlying rate limiter
   */
  getRateLimiter(): TokenBucketRateLimiter {
    return this.rateLimiter
  }

  /**
   * Shutdown the rate limiter
   */
  shutdown(): void {
    this.rateLimiter.shutdown()
    logger.info('MessageRateLimiter shutdown complete')
  }
}

/**
 * Singleton message rate limiter instance
 */
let messageRateLimiter: MessageRateLimiter | null = null

export function getMessageRateLimiter(config?: MessageRateLimiterConfig): MessageRateLimiter {
  if (!messageRateLimiter) {
    messageRateLimiter = new MessageRateLimiter(config)
  }
  return messageRateLimiter
}

export function resetMessageRateLimiter(): void {
  if (messageRateLimiter) {
    messageRateLimiter.shutdown()
    messageRateLimiter = null
  }
}

/**
 * Helper: Create a rate-limited message handler
 *
 * Usage:
 * ```typescript
 * const rateLimiter = new MessageRateLimiter({ rateLimiterConfig: { tokensPerSecond: 100 } })
 *
 * messageBus.subscribe('user.action', rateLimiter.wrap(async (msg) => {
 *   // Handler is rate-limited per tenant
 *   await processUserAction(msg)
 * }))
 * ```
 */
export function createRateLimitedHandler<T extends MessageWithHeaders, R>(
  handler: MessageHandler<T, R>,
  options: {
    rateLimiter?: MessageRateLimiter
    tokensPerSecond?: number
    onViolation?: RateLimitViolationHandler
  } = {}
): MessageHandler<T, R> {
  const limiter = options.rateLimiter ?? getMessageRateLimiter({
    rateLimiterConfig: options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond } : undefined,
    onRateLimitViolation: options.onViolation
  })

  return limiter.wrap(handler)
}
