/**
 * Pattern Trie Tests
 * Issue #28: Comprehensive tests for Trie-based pattern matching optimization
 */

import { describe, it, expect, beforeEach } from '@jest/globals'
import { PatternTrie, Subscription } from '../messaging/pattern-trie'

describe('PatternTrie', () => {
  let trie: PatternTrie
  let mockSubscriptions: Subscription[]

  beforeEach(() => {
    trie = new PatternTrie()
    mockSubscriptions = [
      {
        id: 'sub-1',
        pattern: 'user.login',
        callback: jest.fn(),
        createdAt: Date.now(),
        metadata: { test: 'exact' }
      },
      {
        id: 'sub-2',
        pattern: 'user.*',
        callback: jest.fn(),
        createdAt: Date.now(),
        metadata: { test: 'prefix' }
      },
      {
        id: 'sub-3',
        pattern: '*.login',
        callback: jest.fn(),
        createdAt: Date.now(),
        metadata: { test: 'suffix' }
      },
      {
        id: 'sub-4',
        pattern: 'system.*.event',
        callback: jest.fn(),
        createdAt: Date.now(),
        metadata: { test: 'complex' }
      }
    ]
  })

  describe('Basic Pattern Operations', () => {
    it('should add and retrieve exact patterns', () => {
      trie.addPattern('user.login', mockSubscriptions[0])

      const matches = trie.findMatches('user.login')
      expect(matches).toHaveLength(1)
      expect(matches[0].id).toBe('sub-1')
    })

    it('should handle prefix patterns (user.*)', () => {
      trie.addPattern('user.*', mockSubscriptions[1])

      const matches1 = trie.findMatches('user.login')
      const matches2 = trie.findMatches('user.logout')
      const matches3 = trie.findMatches('user.profile.update')

      expect(matches1).toHaveLength(1)
      expect(matches2).toHaveLength(1)
      expect(matches3).toHaveLength(1)
      expect(matches1[0].id).toBe('sub-2')
    })

    it('should handle suffix patterns (*.login)', () => {
      trie.addPattern('*.login', mockSubscriptions[2])

      const matches1 = trie.findMatches('user.login')
      const matches2 = trie.findMatches('admin.login')
      const matches3 = trie.findMatches('system.login')

      expect(matches1).toHaveLength(1)
      expect(matches2).toHaveLength(1)
      expect(matches3).toHaveLength(1)
      expect(matches1[0].id).toBe('sub-3')
    })

    it('should handle complex wildcard patterns', () => {
      trie.addPattern('system.*.event', mockSubscriptions[3])

      const matches1 = trie.findMatches('system.auth.event')
      const matches2 = trie.findMatches('system.database.event')
      const nonMatch = trie.findMatches('system.auth.warning')

      expect(matches1).toHaveLength(1)
      expect(matches2).toHaveLength(1)
      expect(nonMatch).toHaveLength(0)
      expect(matches1[0].id).toBe('sub-4')
    })
  })

  describe('Multiple Pattern Matching', () => {
    it('should match multiple overlapping patterns', () => {
      trie.addPattern('user.login', mockSubscriptions[0])   // exact
      trie.addPattern('user.*', mockSubscriptions[1])       // prefix
      trie.addPattern('*.login', mockSubscriptions[2])      // suffix

      const matches = trie.findMatches('user.login')
      expect(matches).toHaveLength(3)

      const ids = matches.map(m => m.id).sort()
      expect(ids).toEqual(['sub-1', 'sub-2', 'sub-3'])
    })

    it('should handle non-overlapping patterns correctly', () => {
      trie.addPattern('user.*', mockSubscriptions[1])
      trie.addPattern('admin.*', { ...mockSubscriptions[1], id: 'sub-5', pattern: 'admin.*' })

      const userMatches = trie.findMatches('user.login')
      const adminMatches = trie.findMatches('admin.login')
      const noMatches = trie.findMatches('guest.login')

      expect(userMatches).toHaveLength(1)
      expect(adminMatches).toHaveLength(1)
      expect(noMatches).toHaveLength(0)
      expect(userMatches[0].id).toBe('sub-2')
      expect(adminMatches[0].id).toBe('sub-5')
    })
  })

  describe('Pattern Removal', () => {
    it('should remove exact patterns', () => {
      trie.addPattern('user.login', mockSubscriptions[0])

      expect(trie.findMatches('user.login')).toHaveLength(1)

      const removed = trie.removePattern('user.login', 'sub-1')
      expect(removed).toBe(true)
      expect(trie.findMatches('user.login')).toHaveLength(0)
    })

    it('should remove prefix patterns', () => {
      trie.addPattern('user.*', mockSubscriptions[1])

      expect(trie.findMatches('user.login')).toHaveLength(1)

      const removed = trie.removePattern('user.*', 'sub-2')
      expect(removed).toBe(true)
      expect(trie.findMatches('user.login')).toHaveLength(0)
    })

    it('should return false for non-existent patterns', () => {
      const removed = trie.removePattern('nonexistent.*', 'fake-id')
      expect(removed).toBe(false)
    })

    it('should only remove specific subscription when multiple exist', () => {
      const sub5 = { ...mockSubscriptions[1], id: 'sub-5' }
      trie.addPattern('user.*', mockSubscriptions[1])
      trie.addPattern('user.*', sub5)

      expect(trie.findMatches('user.login')).toHaveLength(2)

      const removed = trie.removePattern('user.*', 'sub-2')
      expect(removed).toBe(true)

      const remaining = trie.findMatches('user.login')
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('sub-5')
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty topic', () => {
      trie.addPattern('user.*', mockSubscriptions[1])
      const matches = trie.findMatches('')
      expect(matches).toHaveLength(0)
    })

    it('should handle topics with no matches', () => {
      trie.addPattern('user.*', mockSubscriptions[1])
      const matches = trie.findMatches('admin.login')
      expect(matches).toHaveLength(0)
    })

    it('should handle patterns with multiple asterisks', () => {
      const complexSub = {
        id: 'complex-1',
        pattern: '*.*.event',
        callback: jest.fn(),
        createdAt: Date.now()
      }

      trie.addPattern('*.*.event', complexSub)

      const matches1 = trie.findMatches('system.auth.event')
      const matches2 = trie.findMatches('user.login.event')
      const nonMatch = trie.findMatches('simple.event')

      expect(matches1).toHaveLength(1)
      expect(matches2).toHaveLength(1)
      expect(nonMatch).toHaveLength(0)
    })

    it('should handle single character topics', () => {
      trie.addPattern('*', { ...mockSubscriptions[0], pattern: '*' })
      const matches = trie.findMatches('a')
      expect(matches).toHaveLength(1)
    })

    it('should handle very long topics', () => {
      const longTopic = 'a'.repeat(1000)
      const longPattern = 'a'.repeat(500) + '*'

      trie.addPattern(longPattern, { ...mockSubscriptions[1], pattern: longPattern })
      const matches = trie.findMatches(longTopic)
      expect(matches).toHaveLength(1)
    })
  })

  describe('Statistics and Monitoring', () => {
    it('should provide accurate statistics', () => {
      trie.addPattern('user.login', mockSubscriptions[0])
      trie.addPattern('user.*', mockSubscriptions[1])
      trie.addPattern('*.login', mockSubscriptions[2])

      const stats = trie.getStats()
      expect(stats.totalSubscriptions).toBe(3)
      expect(stats.totalNodes).toBeGreaterThan(1)
      expect(stats.maxDepth).toBeGreaterThan(0)
      expect(stats.memoryUsage).toBeGreaterThan(0)
    })

    it('should track memory usage', () => {
      const initialStats = trie.getStats()
      const initialMemory = initialStats.memoryUsage

      // Add many patterns
      for (let i = 0; i < 100; i++) {
        trie.addPattern(`pattern.${i}.*`, {
          id: `sub-${i}`,
          pattern: `pattern.${i}.*`,
          callback: jest.fn(),
          createdAt: Date.now()
        })
      }

      const finalStats = trie.getStats()
      expect(finalStats.memoryUsage).toBeGreaterThan(initialMemory)
      expect(finalStats.totalSubscriptions).toBe(100)
    })
  })

  describe('Performance Characteristics', () => {
    it('should handle large numbers of patterns efficiently', () => {
      const startTime = process.hrtime.bigint()

      // Add 1000 patterns
      for (let i = 0; i < 1000; i++) {
        trie.addPattern(`category.${i % 10}.*`, {
          id: `sub-${i}`,
          pattern: `category.${i % 10}.*`,
          callback: jest.fn(),
          createdAt: Date.now()
        })
      }

      const addTime = Number(process.hrtime.bigint() - startTime) / 1_000_000
      expect(addTime).toBeLessThan(1000) // Should complete in under 1 second

      // Test matching performance
      const matchStartTime = process.hrtime.bigint()
      const matches = trie.findMatches('category.5.test.event')
      const matchTime = Number(process.hrtime.bigint() - matchStartTime) / 1_000_000

      expect(matchTime).toBeLessThan(10) // Should match in under 10ms
      expect(matches.length).toBeGreaterThan(0)
    })

    it('should maintain performance with deep pattern hierarchies', () => {
      const deepPattern = 'level1.level2.level3.level4.level5.*'
      trie.addPattern(deepPattern, {
        id: 'deep-sub',
        pattern: deepPattern,
        callback: jest.fn(),
        createdAt: Date.now()
      })

      const startTime = process.hrtime.bigint()
      const matches = trie.findMatches('level1.level2.level3.level4.level5.final')
      const matchTime = Number(process.hrtime.bigint() - startTime) / 1_000_000

      expect(matchTime).toBeLessThan(5)
      expect(matches).toHaveLength(1)
    })
  })

  describe('All Subscriptions Retrieval', () => {
    it('should retrieve all subscriptions', () => {
      trie.addPattern('user.login', mockSubscriptions[0])
      trie.addPattern('user.*', mockSubscriptions[1])
      trie.addPattern('*.login', mockSubscriptions[2])

      const allSubs = trie.getAllSubscriptions()
      expect(allSubs).toHaveLength(3)

      const ids = allSubs.map(s => s.id).sort()
      expect(ids).toEqual(['sub-1', 'sub-2', 'sub-3'])
    })
  })

  describe('Clear Operation', () => {
    it('should clear all patterns and reset statistics', () => {
      trie.addPattern('user.*', mockSubscriptions[1])
      trie.addPattern('admin.*', mockSubscriptions[2])

      expect(trie.getStats().totalSubscriptions).toBe(2)
      expect(trie.findMatches('user.login')).toHaveLength(1)

      trie.clear()

      expect(trie.getStats().totalSubscriptions).toBe(0)
      expect(trie.getStats().totalNodes).toBe(1) // Root node remains
      expect(trie.findMatches('user.login')).toHaveLength(0)
    })
  })

  describe('Debug Functionality', () => {
    it('should provide debug output', () => {
      trie.addPattern('user.*', mockSubscriptions[1])
      trie.addPattern('admin.login', mockSubscriptions[0])

      const debugOutput = trie.debug()
      expect(typeof debugOutput).toBe('string')
      expect(debugOutput.length).toBeGreaterThan(0)
      expect(debugOutput).toContain('u') // Should contain trie structure
    })
  })
})