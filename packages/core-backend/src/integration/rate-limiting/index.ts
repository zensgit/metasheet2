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

// Pluggable storage backends (memory default, optional Redis)
export {
  MemoryTokenBucketStore
} from './token-bucket-store'

export type {
  TokenBucketStore,
  ConsumeResult
} from './token-bucket-store'

export {
  RedisTokenBucketStore,
  TOKEN_BUCKET_LUA,
  applyTokenBucketScript
} from './redis-token-bucket-store'

export type {
  RedisTokenBucketStoreOptions,
  RedisScriptClient,
  ApplyTokenBucketArgs,
  ApplyTokenBucketResult
} from './redis-token-bucket-store'

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
