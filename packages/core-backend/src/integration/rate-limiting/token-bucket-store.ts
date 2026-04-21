/**
 * Pluggable storage backend for the Token Bucket rate limiter.
 *
 * The in-process `TokenBucketRateLimiter` continues to use its own Map
 * for the zero-dependency sync `consume()` path. This store abstraction
 * is additive: callers who need cross-process coordination (multi-node
 * web tier, sidecars, etc.) inject a store — typically
 * `RedisTokenBucketStore` — and call the limiter's async variant.
 *
 * Keeping this as a narrow interface makes unit tests trivial: mock the
 * store, no Redis connection needed.
 */

export interface ConsumeResult {
  /** Whether the requested tokens were available and have been debited. */
  allowed: boolean
  /** Tokens left in the bucket after this call (post-decrement). */
  tokensRemaining: number
  /** Estimated time until the requested token count can be served (ms). */
  retryAfterMs: number
}

export interface TokenBucketStore {
  /**
   * Atomically refill the bucket based on elapsed wall-clock time and,
   * if enough tokens are available, decrement by `tokens`.
   *
   * Implementations must clamp the post-refill balance at `capacity`.
   */
  consume(
    key: string,
    capacity: number,
    refillRate: number,
    tokens: number,
  ): Promise<ConsumeResult>
}

// ---------------------------------------------------------------------------
// Memory implementation — functionally equivalent to the existing inline
// Map-based behaviour in `TokenBucketRateLimiter.consume`, but exposed
// through the `TokenBucketStore` interface so callers can swap it with
// Redis without touching business logic.
// ---------------------------------------------------------------------------

interface MemoryBucket {
  tokens: number
  lastRefill: number
}

export class MemoryTokenBucketStore implements TokenBucketStore {
  private readonly buckets = new Map<string, MemoryBucket>()

  async consume(
    key: string,
    capacity: number,
    refillRate: number,
    tokens: number,
  ): Promise<ConsumeResult> {
    const nowMs = Math.floor(Date.now())
    let bucket = this.buckets.get(key)

    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: nowMs }
      this.buckets.set(key, bucket)
    }

    const elapsed = Math.max(0, nowMs - bucket.lastRefill)
    const refill = (elapsed / 1000) * refillRate
    if (refill > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + refill)
      bucket.lastRefill = nowMs
    }

    let allowed = false
    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens
      allowed = true
    }

    let retryAfterMs = 0
    if (!allowed) {
      const deficit = tokens - bucket.tokens
      retryAfterMs =
        refillRate > 0 ? Math.ceil((deficit / refillRate) * 1000) : -1
    }

    return {
      allowed,
      tokensRemaining: bucket.tokens,
      retryAfterMs,
    }
  }

  /** Clear all buckets. Exposed primarily for tests. */
  reset(): void {
    this.buckets.clear()
  }

  /** Number of active buckets. Exposed primarily for tests. */
  get size(): number {
    return this.buckets.size
  }
}
