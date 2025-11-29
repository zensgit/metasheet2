/**
 * Pattern Manager Tests
 * Issue #28: Tests for high-performance pattern matching with Trie optimization
 * Migrated from Jest to Vitest
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { PatternManager } from '../messaging/pattern-manager'
import { Logger } from '../core/logger'
import { CoreMetrics } from '../metrics/core-metrics'

// Mock dependencies
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
} as unknown as Logger

const mockMetrics = {
  increment: vi.fn(),
  histogram: vi.fn(),
  gauge: vi.fn()
} as unknown as CoreMetrics

describe('PatternManager', () => {
  let patternManager: PatternManager
  let mockCallback: Mock

  beforeEach(() => {
    vi.clearAllMocks()
    mockCallback = vi.fn()
    patternManager = new PatternManager(mockLogger, mockMetrics, {
      enableMetrics: true,
      optimizationMode: 'balanced',
      maxPatterns: 1000,
      cleanupIntervalMs: 100
    })
  })

  afterEach(async () => {
    await patternManager.shutdown()
  })

  describe('Subscription Management', () => {
    it('should subscribe to exact patterns', () => {
      const subscriptionId = patternManager.subscribe('user.login', mockCallback, { test: 'data' })

      expect(subscriptionId).toMatch(/^sub-\d+-\w+$/)
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Subscribed to pattern: user.login')
      )
      expect(mockMetrics.increment).toHaveBeenCalledWith('pattern_subscribe', {
        pattern: 'user.login',
        subscriptionId
      })
    })

    it('should subscribe to wildcard patterns', () => {
      const subscriptionId = patternManager.subscribe('user.*', mockCallback)

      expect(subscriptionId).toBeDefined()
      const stats = patternManager.getStats()
      expect(stats.trie.totalSubscriptions).toBe(1)
    })

    it('should emit subscribed event', () => new Promise<void>((done) => {
      patternManager.on('subscribed', (data) => {
        expect(data.pattern).toBe('test.pattern')
        expect(data.subscriptionId).toBeDefined()
        expect(data.subscription).toBeDefined()
        done()
      })

      patternManager.subscribe('test.pattern', mockCallback)
    }))

    it('should handle subscription errors gracefully', () => {
      // Mock trie to throw error
      vi.spyOn(patternManager['trie'], 'addPattern').mockImplementation(() => {
        throw new Error('Trie error')
      })

      expect(() => {
        patternManager.subscribe('error.pattern', mockCallback)
      }).toThrow('Trie error')

      expect(mockLogger.error).toHaveBeenCalled()
      expect(mockMetrics.increment).toHaveBeenCalledWith('pattern_subscribe_error', {
        pattern: 'error.pattern',
        error: 'Trie error'
      })
    })
  })

  describe('Unsubscription', () => {
    it('should unsubscribe from patterns', () => {
      const subscriptionId = patternManager.subscribe('user.logout', mockCallback)

      const removed = patternManager.unsubscribe('user.logout', subscriptionId)

      expect(removed).toBe(true)
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Unsubscribed from pattern: user.logout')
      )
      expect(mockMetrics.increment).toHaveBeenCalledWith('pattern_unsubscribe', {
        pattern: 'user.logout',
        subscriptionId
      })
    })

    it('should handle non-existent subscriptions', () => {
      const removed = patternManager.unsubscribe('nonexistent.pattern', 'fake-id')

      expect(removed).toBe(false)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Subscription not found')
      )
      expect(mockMetrics.increment).toHaveBeenCalledWith('pattern_unsubscribe_not_found', {
        pattern: 'nonexistent.pattern',
        subscriptionId: 'fake-id'
      })
    })

    it('should emit unsubscribed event', () => new Promise<void>((done) => {
      const subscriptionId = patternManager.subscribe('test.unsubscribe', mockCallback)

      patternManager.on('unsubscribed', (data) => {
        expect(data.pattern).toBe('test.unsubscribe')
        expect(data.subscriptionId).toBe(subscriptionId)
        done()
      })

      patternManager.unsubscribe('test.unsubscribe', subscriptionId)
    }))
  })

  describe('Pattern Matching', () => {
    beforeEach(() => {
      patternManager.subscribe('user.login', mockCallback, { type: 'exact' })
      patternManager.subscribe('user.*', mockCallback, { type: 'prefix' })
      patternManager.subscribe('*.login', mockCallback, { type: 'suffix' })
    })

    it('should find exact matches', () => {
      const result = patternManager.findMatches('user.login')

      expect(result.subscriptions).toHaveLength(3) // exact + prefix + suffix
      expect(result.matchTime).toBeGreaterThan(0)
      expect(result.cacheHit).toBe(false)
    })

    it('should find prefix matches', () => {
      const result = patternManager.findMatches('user.profile')

      expect(result.subscriptions).toHaveLength(1) // only prefix match
      expect(result.subscriptions[0].metadata.type).toBe('prefix')
    })

    it('should find suffix matches', () => {
      const result = patternManager.findMatches('admin.login')

      // Only *.login matches 'admin.login' (not user.login which is exact match)
      expect(result.subscriptions).toHaveLength(1) // suffix only
      const types = result.subscriptions.map(s => s.metadata.type).sort()
      expect(types).toEqual(['suffix'])
    })

    it('should use cache for repeated matches', () => {
      const result1 = patternManager.findMatches('user.login')
      expect(result1.cacheHit).toBe(false)

      const result2 = patternManager.findMatches('user.login')
      expect(result2.cacheHit).toBe(true)
      expect(mockMetrics.increment).toHaveBeenCalledWith('pattern_match_cache_hit', {
        topic: 'user.login',
        matchTime: expect.any(Number)
      })
    })

    it('should invalidate cache on subscription changes', () => {
      patternManager.findMatches('user.test') // Prime cache

      patternManager.subscribe('user.test', mockCallback) // Should invalidate cache

      const result = patternManager.findMatches('user.test')
      expect(result.cacheHit).toBe(false)
    })
  })

  describe('Message Publishing', () => {
    it('should publish to matching subscribers', async () => {
      patternManager.subscribe('user.action', mockCallback)

      const publishedCount = await patternManager.publish('user.action', { userId: '123' })

      expect(publishedCount).toBe(1)
      expect(mockCallback).toHaveBeenCalledWith('user.action', { userId: '123' })
      expect(mockMetrics.increment).toHaveBeenCalledWith('pattern_publish', {
        topic: 'user.action',
        matchCount: 1,
        successCount: 1,
        errorCount: 0,
        publishTime: expect.any(Number),
        cacheHit: expect.any(Boolean)
      })
    })

    it('should handle callback errors gracefully', async () => {
      const errorCallback = vi.fn().mockRejectedValue(new Error('Callback error'))
      patternManager.subscribe('error.topic', errorCallback)

      const publishedCount = await patternManager.publish('error.topic', { test: 'data' })

      expect(publishedCount).toBe(0) // No successful callbacks
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Callback error'),
        expect.any(Error)
      )
      expect(mockMetrics.increment).toHaveBeenCalledWith('pattern_callback_error', {
        subscriptionId: expect.any(String),
        topic: 'error.topic',
        pattern: 'error.topic',
        error: 'Callback error'
      })
    })

    it('should handle no matches', async () => {
      const publishedCount = await patternManager.publish('no.matches', { test: 'data' })

      expect(publishedCount).toBe(0)
      expect(mockMetrics.increment).toHaveBeenCalledWith('pattern_publish_no_matches', {
        topic: 'no.matches'
      })
    })

    it('should emit published event', () => new Promise<void>((done) => {
      patternManager.subscribe('event.topic', mockCallback)

      patternManager.on('published', (data) => {
        expect(data.topic).toBe('event.topic')
        expect(data.matchCount).toBe(1)
        expect(data.successCount).toBe(1)
        expect(data.errorCount).toBe(0)
        done()
      })

      patternManager.publish('event.topic', { test: 'data' })
    }))
  })

  describe('Performance and Caching', () => {
    it('should respect cache size limits', async () => {
      const manager = new PatternManager(mockLogger, mockMetrics, {
        optimizationMode: 'memory' // Lower cache size
      })

      // Create many cache entries
      for (let i = 0; i < 1500; i++) {
        manager.findMatches(`topic.${i}`)
      }

      const stats = manager.getStats()
      expect(stats.cache.size).toBeLessThan(1500) // Should have been limited

      await manager.shutdown()
    })

    it('should clean up expired cache entries', () => new Promise<void>((done) => {
      const manager = new PatternManager(mockLogger, mockMetrics, {
        cleanupIntervalMs: 50
      })

      manager.findMatches('test.topic')
      const initialSize = manager.getStats().cache.size

      setTimeout(() => {
        const finalSize = manager.getStats().cache.size
        expect(finalSize).toBeLessThanOrEqual(initialSize)
        manager.shutdown().then(() => done())
      }, 100)
    }))

    it('should provide optimization mode configurations', async () => {
      const speedManager = new PatternManager(mockLogger, mockMetrics, {
        optimizationMode: 'speed'
      })

      const memoryManager = new PatternManager(mockLogger, mockMetrics, {
        optimizationMode: 'memory'
      })

      // Speed mode should have longer cache validity
      expect(speedManager['isCacheValid'](Date.now() - 20000)).toBe(true)
      expect(memoryManager['isCacheValid'](Date.now() - 20000)).toBe(false)

      await speedManager.shutdown()
      await memoryManager.shutdown()
    })
  })

  describe('Statistics and Monitoring', () => {
    it('should provide comprehensive statistics', () => {
      patternManager.subscribe('stats.test', mockCallback)
      patternManager.findMatches('stats.test')

      const stats = patternManager.getStats()

      expect(stats.trie).toBeDefined()
      expect(stats.trie.totalSubscriptions).toBe(1)
      expect(stats.cache.size).toBeGreaterThan(0)
      expect(stats.cache.hitRate).toBeGreaterThanOrEqual(0)
      expect(stats.performance.averageMatchTime).toBeGreaterThan(0)
      expect(stats.performance.averagePublishTime).toBeGreaterThan(0)
    })

    it('should track all active subscriptions', () => {
      patternManager.subscribe('all.test1', mockCallback)
      patternManager.subscribe('all.test2', mockCallback)
      patternManager.subscribe('all.*', mockCallback)

      const allSubs = patternManager.getAllSubscriptions()
      expect(allSubs).toHaveLength(3)
    })
  })

  describe('Cleanup and Shutdown', () => {
    it('should clear all patterns and cache', () => {
      patternManager.subscribe('clear.test', mockCallback)
      patternManager.findMatches('clear.test')

      expect(patternManager.getStats().trie.totalSubscriptions).toBe(1)
      expect(patternManager.getStats().cache.size).toBeGreaterThan(0)

      patternManager.clear()

      expect(patternManager.getStats().trie.totalSubscriptions).toBe(0)
      expect(patternManager.getStats().cache.size).toBe(0)
      expect(mockLogger.info).toHaveBeenCalledWith('Pattern manager cleared')
    })

    it('should emit cleared event', () => new Promise<void>((done) => {
      patternManager.on('cleared', () => {
        done()
      })

      patternManager.clear()
    }))

    it('should shutdown gracefully', async () => {
      patternManager.subscribe('shutdown.test', mockCallback)

      await patternManager.shutdown()

      expect(mockLogger.info).toHaveBeenCalledWith('Pattern manager shutdown complete')
      expect(patternManager.getStats().trie.totalSubscriptions).toBe(0)
    })

    it('should emit shutdown event', () => new Promise<void>((done) => {
      patternManager.on('shutdown', () => {
        done()
      })

      patternManager.shutdown()
    }))
  })

  describe('Debug Information', () => {
    it('should provide debug information', () => {
      patternManager.subscribe('debug.test', mockCallback)
      patternManager.findMatches('debug.test')

      const debugInfo = patternManager.debug()

      expect(debugInfo.trie).toBeDefined()
      expect(debugInfo.cache).toBeDefined()
      expect(debugInfo.stats).toBeDefined()
      expect(Array.isArray(debugInfo.cache)).toBe(true)
    })
  })

  describe('Configuration Options', () => {
    it('should respect maxPatterns configuration', async () => {
      const limitedManager = new PatternManager(mockLogger, mockMetrics, {
        maxPatterns: 2
      })

      limitedManager.subscribe('pattern1', mockCallback)
      limitedManager.subscribe('pattern2', mockCallback)

      const stats = limitedManager.getStats()
      expect(stats.trie.totalSubscriptions).toBeLessThanOrEqual(2)

      await limitedManager.shutdown()
    })

    it('should disable metrics when configured', async () => {
      const noMetricsManager = new PatternManager(mockLogger, undefined, {
        enableMetrics: false
      })

      noMetricsManager.subscribe('no.metrics', mockCallback)

      // Should not throw errors even without metrics
      expect(() => {
        noMetricsManager.findMatches('no.metrics')
      }).not.toThrow()

      await noMetricsManager.shutdown()
    })
  })
})
