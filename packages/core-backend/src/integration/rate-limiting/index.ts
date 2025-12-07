/**
 * Rate Limiting Module
 * Sprint 6 Day 4: Token Bucket Rate Limiting for MessageBus
 */

// Token Bucket Rate Limiter
export {
  TokenBucketRateLimiter,
  getRateLimiter,
  resetRateLimiter
} from './token-bucket'

export type {
  RateLimiterConfig,
  RateLimitResult
} from './token-bucket'

// Message Rate Limiter (MessageBus integration)
export {
  MessageRateLimiter,
  RateLimitError,
  getMessageRateLimiter,
  resetMessageRateLimiter,
  createRateLimitedHandler
} from './message-rate-limiter'

export type {
  MessageRateLimiterConfig,
  RateLimitViolationHandler
} from './message-rate-limiter'
