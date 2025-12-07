/**
 * Rate Limiting Tests
 * Sprint 6 Day 4: Token Bucket Rate Limiter and MessageBus Integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  TokenBucketRateLimiter,
  getRateLimiter,
  resetRateLimiter,
  MessageRateLimiter,
  RateLimitError,
  getMessageRateLimiter,
  resetMessageRateLimiter,
  createRateLimitedHandler
} from '../integration/rate-limiting'

describe('TokenBucketRateLimiter', () => {
  let rateLimiter: TokenBucketRateLimiter

  beforeEach(() => {
    rateLimiter = new TokenBucketRateLimiter({
      tokensPerSecond: 10, // 10 tokens/s for fast testing
      bucketCapacity: 20, // 2 second burst
      enableMetrics: false,
      cleanupIntervalMs: 60000,
      bucketIdleTimeoutMs: 300000
    })
  })

  afterEach(() => {
    rateLimiter.shutdown()
    resetRateLimiter()
  })

  describe('Basic Token Consumption', () => {
    it('should allow requests when tokens are available', () => {
      const result = rateLimiter.consume('tenant-1')

      expect(result.allowed).toBe(true)
      expect(result.tokensRemaining).toBe(19) // 20 - 1
      expect(result.bucketCapacity).toBe(20)
      expect(result.retryAfterMs).toBe(0)
      expect(result.key).toBe('tenant-1')
    })

    it('should reject requests when bucket is empty', () => {
      // Consume all tokens
      for (let i = 0; i < 20; i++) {
        rateLimiter.consume('tenant-1')
      }

      // Next request should be rejected
      const result = rateLimiter.consume('tenant-1')

      expect(result.allowed).toBe(false)
      expect(result.tokensRemaining).toBe(0)
      expect(result.retryAfterMs).toBeGreaterThan(0)
    })

    it('should consume multiple tokens at once', () => {
      const result = rateLimiter.consume('tenant-1', 5)

      expect(result.allowed).toBe(true)
      expect(result.tokensRemaining).toBe(15) // 20 - 5
    })

    it('should reject if not enough tokens for multi-token request', () => {
      // Consume most tokens
      rateLimiter.consume('tenant-1', 18)

      // Try to consume 5 more (only 2 left)
      const result = rateLimiter.consume('tenant-1', 5)

      expect(result.allowed).toBe(false)
      expect(result.tokensRemaining).toBe(2)
    })

    it('should maintain separate buckets for different keys', () => {
      // Exhaust tenant-1
      for (let i = 0; i < 20; i++) {
        rateLimiter.consume('tenant-1')
      }

      // tenant-2 should still have full bucket
      const result = rateLimiter.consume('tenant-2')

      expect(result.allowed).toBe(true)
      expect(result.tokensRemaining).toBe(19)
    })
  })

  describe('Token Refill', () => {
    it('should refill tokens over time', async () => {
      // Consume all tokens
      for (let i = 0; i < 20; i++) {
        rateLimiter.consume('tenant-1')
      }

      // Wait 200ms (should refill ~2 tokens at 10/s)
      await new Promise(resolve => setTimeout(resolve, 200))

      const result = rateLimiter.consume('tenant-1')

      expect(result.allowed).toBe(true)
      // Should have refilled at least 1 token
      expect(result.tokensRemaining).toBeGreaterThanOrEqual(0)
    })

    it('should not exceed bucket capacity when refilling', async () => {
      // Wait some time without consuming
      await new Promise(resolve => setTimeout(resolve, 100))

      const result = rateLimiter.consume('tenant-1')

      // Should still be at capacity
      expect(result.tokensRemaining).toBeLessThanOrEqual(20)
    })
  })

  describe('Check Without Consuming', () => {
    it('should check availability without consuming', () => {
      const checkResult = rateLimiter.check('tenant-1')

      expect(checkResult.allowed).toBe(true)
      expect(checkResult.tokensRemaining).toBe(20) // Still full

      // Actually consume
      const consumeResult = rateLimiter.consume('tenant-1')
      expect(consumeResult.tokensRemaining).toBe(19)
    })

    it('should return allowed for non-existent bucket', () => {
      const result = rateLimiter.check('new-tenant')

      expect(result.allowed).toBe(true)
      expect(result.tokensRemaining).toBe(20)
    })
  })

  describe('Reset Operations', () => {
    it('should reset rate limit for specific key', () => {
      // Exhaust tenant-1
      for (let i = 0; i < 20; i++) {
        rateLimiter.consume('tenant-1')
      }

      // Reset
      rateLimiter.reset('tenant-1')

      // Should have full bucket again
      const result = rateLimiter.consume('tenant-1')
      expect(result.allowed).toBe(true)
      expect(result.tokensRemaining).toBe(19)
    })

    it('should reset all rate limits', () => {
      // Exhaust multiple tenants
      for (let i = 0; i < 20; i++) {
        rateLimiter.consume('tenant-1')
        rateLimiter.consume('tenant-2')
      }

      // Reset all
      rateLimiter.resetAll()

      // Both should have full buckets
      expect(rateLimiter.consume('tenant-1').allowed).toBe(true)
      expect(rateLimiter.consume('tenant-2').allowed).toBe(true)
    })
  })

  describe('Statistics', () => {
    it('should track stats for a key', () => {
      // Consume some tokens
      for (let i = 0; i < 5; i++) {
        rateLimiter.consume('tenant-1')
      }

      const stats = rateLimiter.getStats('tenant-1')

      expect(stats).not.toBeNull()
      expect(stats!.totalAccepted).toBe(5)
      expect(stats!.totalRejected).toBe(0)
      expect(stats!.acceptanceRate).toBe(1)
    })

    it('should track rejections', () => {
      // Exhaust and try more
      for (let i = 0; i < 25; i++) {
        rateLimiter.consume('tenant-1')
      }

      const stats = rateLimiter.getStats('tenant-1')

      expect(stats!.totalAccepted).toBe(20)
      expect(stats!.totalRejected).toBe(5)
      expect(stats!.acceptanceRate).toBe(0.8)
    })

    it('should return global stats', () => {
      rateLimiter.consume('tenant-1')
      rateLimiter.consume('tenant-2')
      rateLimiter.consume('tenant-2')

      const stats = rateLimiter.getGlobalStats()

      expect(stats.activeBuckets).toBe(2)
      expect(stats.totalAccepted).toBe(3)
      expect(stats.totalRejected).toBe(0)
    })

    it('should return null for non-existent key', () => {
      const stats = rateLimiter.getStats('non-existent')
      expect(stats).toBeNull()
    })
  })

  describe('Configuration Updates', () => {
    it('should update configuration dynamically', () => {
      rateLimiter.updateConfig({ tokensPerSecond: 20 })

      const config = rateLimiter.getConfig()
      expect(config.tokensPerSecond).toBe(20)
    })
  })

  describe('Retry After Calculation', () => {
    it('should calculate correct retry after time', () => {
      // Exhaust bucket
      for (let i = 0; i < 20; i++) {
        rateLimiter.consume('tenant-1')
      }

      const result = rateLimiter.consume('tenant-1')

      // At 10 tokens/s, 1 token takes 100ms
      expect(result.retryAfterMs).toBe(100)
    })
  })
})

describe('MessageRateLimiter', () => {
  let messageRateLimiter: MessageRateLimiter

  beforeEach(() => {
    messageRateLimiter = new MessageRateLimiter({
      rateLimiterConfig: {
        tokensPerSecond: 10,
        bucketCapacity: 20,
        enableMetrics: false
      },
      enableMetrics: false
    })
  })

  afterEach(() => {
    messageRateLimiter.shutdown()
    resetMessageRateLimiter()
  })

  describe('Handler Wrapping', () => {
    it('should pass through when rate limit not exceeded', async () => {
      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = messageRateLimiter.wrap(handler)

      const msg = {
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: { action: 'test' }
      }

      const result = await wrappedHandler(msg)

      expect(handler).toHaveBeenCalledWith(msg)
      expect(result).toBe('result')
    })

    it('should throw RateLimitError when limit exceeded', async () => {
      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = messageRateLimiter.wrap(handler)

      const msg = {
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: { action: 'test' }
      }

      // Exhaust rate limit
      for (let i = 0; i < 20; i++) {
        await wrappedHandler(msg)
      }

      // Next should throw
      await expect(wrappedHandler(msg)).rejects.toThrow(RateLimitError)
      expect(handler).toHaveBeenCalledTimes(20)
    })

    it('should silently drop when throwOnRateLimit is false', async () => {
      const silentLimiter = new MessageRateLimiter({
        rateLimiterConfig: {
          tokensPerSecond: 5,
          bucketCapacity: 5,
          enableMetrics: false
        },
        throwOnRateLimit: false,
        enableMetrics: false
      })

      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = silentLimiter.wrap(handler)

      const msg = {
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      }

      // Exhaust rate limit
      for (let i = 0; i < 5; i++) {
        await wrappedHandler(msg)
      }

      // Next should return undefined
      const result = await wrappedHandler(msg)
      expect(result).toBeUndefined()

      silentLimiter.shutdown()
    })

    it('should call violation handler on rate limit', async () => {
      const onViolation = vi.fn()
      const limiterWithHandler = new MessageRateLimiter({
        rateLimiterConfig: {
          tokensPerSecond: 5,
          bucketCapacity: 5,
          enableMetrics: false
        },
        onRateLimitViolation: onViolation,
        enableMetrics: false
      })

      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = limiterWithHandler.wrap(handler)

      const msg = {
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      }

      // Exhaust rate limit
      for (let i = 0; i < 5; i++) {
        await wrappedHandler(msg)
      }

      // Trigger violation
      await expect(wrappedHandler(msg)).rejects.toThrow(RateLimitError)

      expect(onViolation).toHaveBeenCalledTimes(1)
      expect(onViolation).toHaveBeenCalledWith(
        'tenant:tenant-1',
        expect.objectContaining({ allowed: false }),
        msg
      )

      limiterWithHandler.shutdown()
    })
  })

  describe('Topic Exclusions', () => {
    it('should exclude system topics by default', async () => {
      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = messageRateLimiter.wrap(handler)

      // Exhaust rate limit for tenant
      const regularMsg = {
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      }

      for (let i = 0; i < 20; i++) {
        await wrappedHandler(regularMsg)
      }

      // System topic should still work
      const systemMsg = {
        topic: '__rpc.reply.123',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      }

      const result = await wrappedHandler(systemMsg)
      expect(result).toBe('result')
    })

    it('should exclude health topics', async () => {
      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = messageRateLimiter.wrap(handler)

      // Exhaust rate limit
      const regularMsg = {
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      }

      for (let i = 0; i < 20; i++) {
        await wrappedHandler(regularMsg)
      }

      // Health topic should still work
      const healthMsg = {
        topic: 'health.check',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      }

      const result = await wrappedHandler(healthMsg)
      expect(result).toBe('result')
    })

    it('should exclude custom topics', async () => {
      const customLimiter = new MessageRateLimiter({
        rateLimiterConfig: {
          tokensPerSecond: 5,
          bucketCapacity: 5,
          enableMetrics: false
        },
        excludeTopics: ['admin.*'],
        enableMetrics: false
      })

      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = customLimiter.wrap(handler)

      // Exhaust rate limit
      const regularMsg = {
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      }

      for (let i = 0; i < 5; i++) {
        await wrappedHandler(regularMsg)
      }

      // Admin topic should still work
      const adminMsg = {
        topic: 'admin.override',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      }

      const result = await wrappedHandler(adminMsg)
      expect(result).toBe('result')

      customLimiter.shutdown()
    })
  })

  describe('Key Extraction', () => {
    it('should not rate limit messages without tenant header', async () => {
      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = messageRateLimiter.wrap(handler)

      const msg = {
        topic: 'user.action',
        payload: {}
        // No headers
      }

      // Should work without rate limiting
      for (let i = 0; i < 30; i++) {
        await wrappedHandler(msg)
      }

      expect(handler).toHaveBeenCalledTimes(30)
    })

    it('should use custom key extractor', async () => {
      const customLimiter = new MessageRateLimiter({
        rateLimiterConfig: {
          tokensPerSecond: 5,
          bucketCapacity: 5,
          enableMetrics: false
        },
        keyExtractor: (msg) => {
          const payload = msg.payload as { userId?: string }
          return payload?.userId ? `user:${payload.userId}` : undefined
        },
        enableMetrics: false
      })

      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = customLimiter.wrap(handler)

      const msg = {
        topic: 'user.action',
        payload: { userId: 'user-1' }
      }

      // Should rate limit by userId
      for (let i = 0; i < 5; i++) {
        await wrappedHandler(msg)
      }

      await expect(wrappedHandler(msg)).rejects.toThrow(RateLimitError)

      customLimiter.shutdown()
    })
  })

  describe('Statistics', () => {
    it('should get stats for a tenant', async () => {
      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = messageRateLimiter.wrap(handler)

      const msg = {
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      }

      for (let i = 0; i < 5; i++) {
        await wrappedHandler(msg)
      }

      const stats = messageRateLimiter.getStatsForTenant('tenant-1')

      expect(stats).not.toBeNull()
      expect(stats!.totalAccepted).toBe(5)
    })

    it('should get global stats', async () => {
      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = messageRateLimiter.wrap(handler)

      await wrappedHandler({
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      })

      await wrappedHandler({
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-2' },
        payload: {}
      })

      const stats = messageRateLimiter.getGlobalStats()

      expect(stats.activeBuckets).toBe(2)
      expect(stats.totalAccepted).toBe(2)
    })
  })

  describe('Reset Operations', () => {
    it('should reset tenant rate limit', async () => {
      const handler = vi.fn().mockResolvedValue('result')
      const wrappedHandler = messageRateLimiter.wrap(handler)

      const msg = {
        topic: 'user.action',
        headers: { 'x-tenant-id': 'tenant-1' },
        payload: {}
      }

      // Exhaust rate limit
      for (let i = 0; i < 20; i++) {
        await wrappedHandler(msg)
      }

      await expect(wrappedHandler(msg)).rejects.toThrow(RateLimitError)

      // Reset tenant
      messageRateLimiter.resetTenant('tenant-1')

      // Should work again
      const result = await wrappedHandler(msg)
      expect(result).toBe('result')
    })
  })
})

describe('RateLimitError', () => {
  it('should contain rate limit details', () => {
    const error = new RateLimitError('tenant:test', {
      allowed: false,
      tokensRemaining: 0,
      bucketCapacity: 20,
      retryAfterMs: 100,
      key: 'tenant:test'
    })

    expect(error.name).toBe('RateLimitError')
    expect(error.key).toBe('tenant:test')
    expect(error.retryAfterMs).toBe(100)
    expect(error.tokensRemaining).toBe(0)
    expect(error.message).toContain('Rate limit exceeded')
  })
})

describe('createRateLimitedHandler', () => {
  afterEach(() => {
    resetMessageRateLimiter()
    resetRateLimiter()
  })

  it('should create a rate-limited handler', async () => {
    const handler = vi.fn().mockResolvedValue('result')
    const rateLimitedHandler = createRateLimitedHandler(handler, {
      tokensPerSecond: 5
    })

    const msg = {
      topic: 'user.action',
      headers: { 'x-tenant-id': 'tenant-1' },
      payload: {}
    }

    for (let i = 0; i < 5; i++) {
      await rateLimitedHandler(msg)
    }

    expect(handler).toHaveBeenCalledTimes(5)
  })
})

describe('Singleton Management', () => {
  afterEach(() => {
    resetRateLimiter()
    resetMessageRateLimiter()
  })

  it('should return same instance from getRateLimiter', () => {
    const limiter1 = getRateLimiter()
    const limiter2 = getRateLimiter()

    expect(limiter1).toBe(limiter2)
  })

  it('should return same instance from getMessageRateLimiter', () => {
    const limiter1 = getMessageRateLimiter()
    const limiter2 = getMessageRateLimiter()

    expect(limiter1).toBe(limiter2)
  })

  it('should create new instance after reset', () => {
    const limiter1 = getRateLimiter()
    resetRateLimiter()
    const limiter2 = getRateLimiter()

    expect(limiter1).not.toBe(limiter2)
  })
})

describe('Stress Test Simulation', () => {
  it('should handle high-frequency requests and trigger rate limiting', async () => {
    const rateLimiter = new TokenBucketRateLimiter({
      tokensPerSecond: 100,
      bucketCapacity: 200, // 2 second burst
      enableMetrics: false
    })

    // Simulate 500 rapid requests
    let allowed = 0
    let rejected = 0

    for (let i = 0; i < 500; i++) {
      const result = rateLimiter.consume('stress-tenant')
      if (result.allowed) {
        allowed++
      } else {
        rejected++
      }
    }

    // Should have accepted ~200 (bucket capacity) and rejected ~300
    expect(allowed).toBe(200)
    expect(rejected).toBe(300)

    const stats = rateLimiter.getStats('stress-tenant')
    expect(stats!.acceptanceRate).toBe(0.4) // 200/500

    rateLimiter.shutdown()
  })

  it('should refill and allow more requests over time', async () => {
    const rateLimiter = new TokenBucketRateLimiter({
      tokensPerSecond: 100,
      bucketCapacity: 100,
      enableMetrics: false
    })

    // Exhaust bucket
    for (let i = 0; i < 100; i++) {
      rateLimiter.consume('refill-tenant')
    }

    // Should be rejected
    expect(rateLimiter.consume('refill-tenant').allowed).toBe(false)

    // Wait 100ms (should refill ~10 tokens)
    await new Promise(resolve => setTimeout(resolve, 100))

    // Should allow some requests now
    let allowedAfterWait = 0
    for (let i = 0; i < 15; i++) {
      if (rateLimiter.consume('refill-tenant').allowed) {
        allowedAfterWait++
      }
    }

    // Should have allowed approximately 10 (100 tokens/s * 0.1s)
    expect(allowedAfterWait).toBeGreaterThanOrEqual(8)
    expect(allowedAfterWait).toBeLessThanOrEqual(12)

    rateLimiter.shutdown()
  })
})
