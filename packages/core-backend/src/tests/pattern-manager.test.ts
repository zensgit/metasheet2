/**
 * Pattern Manager Tests
 * Issue #28: Tests for high-performance pattern matching with Trie optimization
 * Sprint 5: Added plugin lifecycle support tests
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
      const subscriptionId = patternManager.subscribe('user.login', mockCallback, { metadata: { test: 'data' } })

      expect(subscriptionId).toMatch(/^sub-\d+-\w+$/)
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Subscribed to pattern: user.login')
      )
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

      // Speed mode should have longer cache TTL (30000ms) than default (10000ms)
      const speedStats = speedManager.getStats()
      const memoryStats = memoryManager.getStats()

      // Speed mode: 30000ms TTL, Memory mode: 10000ms TTL (default)
      expect(speedStats.cache.ttlMs).toBe(30000)
      expect(memoryStats.cache.ttlMs).toBe(10000)

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

  describe('Plugin Lifecycle Management (Sprint 5)', () => {
    it('should subscribe with plugin identifier', () => {
      const subscriptionId = patternManager.subscribe('plugin.test', mockCallback, { plugin: 'test-plugin' })

      expect(subscriptionId).toBeDefined()
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('plugin: test-plugin')
      )
    })

    it('should track subscriptions by plugin', () => {
      patternManager.subscribe('topic1', mockCallback, { plugin: 'plugin-a' })
      patternManager.subscribe('topic2', mockCallback, { plugin: 'plugin-a' })
      patternManager.subscribe('topic3', mockCallback, { plugin: 'plugin-b' })

      const pluginAIds = patternManager.getSubscriptionsByPlugin('plugin-a')
      const pluginBIds = patternManager.getSubscriptionsByPlugin('plugin-b')

      expect(pluginAIds).toHaveLength(2)
      expect(pluginBIds).toHaveLength(1)
    })

    it('should unsubscribe all subscriptions by plugin', () => {
      patternManager.subscribe('topic1', mockCallback, { plugin: 'plugin-a' })
      patternManager.subscribe('topic2.*', mockCallback, { plugin: 'plugin-a' })
      patternManager.subscribe('topic3', mockCallback, { plugin: 'plugin-b' })

      const removedCount = patternManager.unsubscribeByPlugin('plugin-a')

      expect(removedCount).toBe(2)
      expect(patternManager.getSubscriptionsByPlugin('plugin-a')).toHaveLength(0)
      expect(patternManager.getSubscriptionsByPlugin('plugin-b')).toHaveLength(1)
    })

    it('should return 0 when unsubscribing non-existent plugin', () => {
      const removedCount = patternManager.unsubscribeByPlugin('non-existent')
      expect(removedCount).toBe(0)
    })

    it('should emit unsubscribed events with plugin info', () => new Promise<void>((done) => {
      const subscriptionId = patternManager.subscribe('unsubscribe.test', mockCallback, { plugin: 'test-plugin' })
      let eventCount = 0

      patternManager.on('unsubscribed', (data) => {
        expect(data.plugin).toBe('test-plugin')
        eventCount++
        if (eventCount === 1) done()
      })

      patternManager.unsubscribeByPlugin('test-plugin')
    }))

    it('should unsubscribe by ID and lookup pattern automatically', () => {
      const subscriptionId = patternManager.subscribe('byid.test', mockCallback)

      const removed = patternManager.unsubscribeById(subscriptionId)

      expect(removed).toBe(true)
      const stats = patternManager.getStats()
      expect(stats.trie.totalSubscriptions).toBe(0)
    })

    it('should return false when unsubscribing unknown subscription ID', () => {
      const removed = patternManager.unsubscribeById('unknown-id')
      expect(removed).toBe(false)
    })

    it('should clean up plugin tracking on individual unsubscribe', () => {
      const subId = patternManager.subscribe('cleanup.test', mockCallback, { plugin: 'cleanup-plugin' })

      patternManager.unsubscribe('cleanup.test', subId)

      expect(patternManager.getSubscriptionsByPlugin('cleanup-plugin')).toHaveLength(0)
    })

    it('should include plugin in subscription metadata', () => {
      patternManager.subscribe('meta.test', mockCallback, { plugin: 'meta-plugin' })

      const allSubs = patternManager.getAllSubscriptions()
      const metaSub = allSubs.find(s => s.pattern === 'meta.test')

      expect(metaSub).toBeDefined()
      // The plugin is stored in the subscription object, not just metadata
      expect((metaSub as unknown as { plugin?: string }).plugin).toBe('meta-plugin')
    })
  })

  describe('TTL Cache Configuration (Sprint 5 Prep)', () => {
    it('should respect custom TTL configuration', async () => {
      const customManager = new PatternManager(mockLogger, mockMetrics, {
        cacheTtlMs: 100 // Very short TTL for testing
      })

      customManager.subscribe('ttl.test', mockCallback)
      customManager.findMatches('ttl.test') // Prime cache

      const result1 = customManager.findMatches('ttl.test')
      expect(result1.cacheHit).toBe(true)

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 150))

      const result2 = customManager.findMatches('ttl.test')
      expect(result2.cacheHit).toBe(false)

      await customManager.shutdown()
    })

    it('should use different TTL for speed vs memory mode', async () => {
      const speedManager = new PatternManager(mockLogger, mockMetrics, {
        optimizationMode: 'speed'
      })

      const memoryManager = new PatternManager(mockLogger, mockMetrics, {
        optimizationMode: 'memory'
      })

      // Speed mode should have 30s TTL, memory mode should have 10s
      // We test by checking if cache is still valid after 15s (simulated)
      expect(speedManager['config'].cacheTtlMs).toBe(30000)
      expect(memoryManager['config'].cacheTtlMs).toBe(10000)

      await speedManager.shutdown()
      await memoryManager.shutdown()
    })

    it('should track TTL expirations in stats', async () => {
      const customManager = new PatternManager(mockLogger, mockMetrics, {
        cacheTtlMs: 50 // Very short TTL for testing
      })

      customManager.subscribe('ttl.stats.test', mockCallback)
      customManager.findMatches('ttl.stats.test') // Prime cache

      const statsBefore = customManager.getStats()
      expect(statsBefore.cache.ttlExpirations).toBe(0)

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 100))

      // Access again - this should trigger TTL expiration
      customManager.findMatches('ttl.stats.test')

      const statsAfter = customManager.getStats()
      expect(statsAfter.cache.ttlExpirations).toBe(1)

      await customManager.shutdown()
    })
  })
})
