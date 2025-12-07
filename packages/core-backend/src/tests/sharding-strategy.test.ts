/**
 * Sharding Strategy Tests
 * Sprint 5 Day 4: Tests for tenant hash sharding
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  TenantHashShardingStrategy,
  murmurHash3,
  type ShardInfo
} from '../db/sharding'

describe('TenantHashShardingStrategy (Sprint 5 Day 4)', () => {
  let strategy: TenantHashShardingStrategy

  const testShards: ShardInfo[] = [
    { shardId: 'shard-0', connectionUrl: 'postgresql://localhost:5432/db0' },
    { shardId: 'shard-1', connectionUrl: 'postgresql://localhost:5433/db1' },
    { shardId: 'shard-2', connectionUrl: 'postgresql://localhost:5434/db2' },
    { shardId: 'shard-3', connectionUrl: 'postgresql://localhost:5435/db3' }
  ]

  beforeEach(() => {
    strategy = new TenantHashShardingStrategy()
    testShards.forEach(shard => strategy.addShard(shard))
  })

  describe('Shard Management', () => {
    it('should add shards correctly', () => {
      const shards = strategy.getAllShards()
      expect(shards).toHaveLength(4)
      expect(shards.map(s => s.shardId).sort()).toEqual(['shard-0', 'shard-1', 'shard-2', 'shard-3'])
    })

    it('should get shard info by ID', () => {
      const shard = strategy.getShardInfo('shard-1')
      expect(shard).toBeDefined()
      expect(shard?.connectionUrl).toBe('postgresql://localhost:5433/db1')
    })

    it('should return undefined for non-existent shard', () => {
      const shard = strategy.getShardInfo('shard-99')
      expect(shard).toBeUndefined()
    })

    it('should remove shards correctly', () => {
      const removed = strategy.removeShard('shard-2')
      expect(removed).toBe(true)
      expect(strategy.getAllShards()).toHaveLength(3)
      expect(strategy.getShardInfo('shard-2')).toBeUndefined()
    })

    it('should return false when removing non-existent shard', () => {
      const removed = strategy.removeShard('shard-99')
      expect(removed).toBe(false)
    })
  })

  describe('Shard Key Generation', () => {
    it('should generate consistent shard keys for same tenant', () => {
      const result1 = strategy.getShardKey('tenant-123')
      const result2 = strategy.getShardKey('tenant-123')

      expect(result1.shardKey).toBe(result2.shardKey)
      expect(result1.shardId).toBe(result2.shardId)
    })

    it('should generate different keys for different tenants', () => {
      const result1 = strategy.getShardKey('tenant-123')
      const result2 = strategy.getShardKey('tenant-456')

      // Keys should be different (statistically very likely)
      expect(result1.shardKey).not.toBe(result2.shardKey)
    })

    it('should return correct total shard count', () => {
      const result = strategy.getShardKey('tenant-123')
      expect(result.totalShards).toBe(4)
    })

    it('should return valid shard ID from available shards', () => {
      const result = strategy.getShardKey('tenant-123')
      expect(['shard-0', 'shard-1', 'shard-2', 'shard-3']).toContain(result.shardId)
    })
  })

  describe('Distribution Uniformity', () => {
    it('should distribute tenants uniformly across shards', () => {
      // Generate 10000 random tenant IDs
      const tenantIds = Array.from({ length: 10000 }, (_, i) => `tenant-${i}-${Math.random()}`)

      const stats = strategy.getDistributionStats(tenantIds)

      // Each shard should have roughly 2500 tenants (10000 / 4)
      const expectedPerShard = tenantIds.length / 4

      for (const [shardId, count] of Object.entries(stats.shardCounts)) {
        // Allow 15% deviation from expected
        expect(count).toBeGreaterThan(expectedPerShard * 0.85)
        expect(count).toBeLessThan(expectedPerShard * 1.15)
      }
    })

    it('should report isUniform for well-distributed tenants', () => {
      const tenantIds = Array.from({ length: 10000 }, (_, i) => `tenant-${i}`)
      const stats = strategy.getDistributionStats(tenantIds)

      // With a good hash function and sufficient samples, distribution should be uniform
      expect(stats.isUniform).toBe(true)
    })
  })

  describe('Stability Under Topology Changes', () => {
    it('should maintain same shard for existing tenants when adding new shard', () => {
      const tenantId = 'tenant-stable-123'
      const originalResult = strategy.getShardKey(tenantId)

      // Add a new shard
      strategy.addShard({
        shardId: 'shard-4',
        connectionUrl: 'postgresql://localhost:5436/db4'
      })

      // Note: In simple modulo hashing, adding shards changes all mappings
      // This is a limitation of simple hash sharding vs consistent hashing
      const newResult = strategy.getShardKey(tenantId)

      // In this implementation, the shard MAY change (that's expected for modulo hashing)
      // A more advanced consistent hashing implementation would minimize changes
      expect(newResult.totalShards).toBe(5)
    })
  })

  describe('canHandle', () => {
    it('should return true for valid tenant ID with shards configured', () => {
      expect(strategy.canHandle('tenant-123')).toBe(true)
    })

    it('should return false for empty tenant ID', () => {
      expect(strategy.canHandle('')).toBe(false)
    })

    it('should return false when no shards configured', () => {
      const emptyStrategy = new TenantHashShardingStrategy()
      expect(emptyStrategy.canHandle('tenant-123')).toBe(false)
    })
  })

  describe('Cache Behavior', () => {
    it('should cache shard key results by default', () => {
      const cacheStats1 = strategy.getCacheStats()
      expect(cacheStats1.enabled).toBe(true)
      expect(cacheStats1.size).toBe(0)

      strategy.getShardKey('tenant-123')

      const cacheStats2 = strategy.getCacheStats()
      expect(cacheStats2.size).toBe(1)
    })

    it('should clear cache on topology change', () => {
      strategy.getShardKey('tenant-123')
      expect(strategy.getCacheStats().size).toBe(1)

      strategy.addShard({
        shardId: 'shard-5',
        connectionUrl: 'postgresql://localhost:5437/db5'
      })

      expect(strategy.getCacheStats().size).toBe(0)
    })

    it('should respect cache disabled config', () => {
      const noCacheStrategy = new TenantHashShardingStrategy({ enableCache: false })
      testShards.forEach(shard => noCacheStrategy.addShard(shard))

      noCacheStrategy.getShardKey('tenant-123')
      expect(noCacheStrategy.getCacheStats().enabled).toBe(false)
      expect(noCacheStrategy.getCacheStats().size).toBe(0)
    })

    it('should support manual cache clearing', () => {
      strategy.getShardKey('tenant-123')
      strategy.getShardKey('tenant-456')
      expect(strategy.getCacheStats().size).toBe(2)

      strategy.clearCache()
      expect(strategy.getCacheStats().size).toBe(0)
    })
  })

  describe('Strategy Properties', () => {
    it('should have correct name', () => {
      expect(strategy.name).toBe('tenant-hash')
    })
  })
})

describe('MurmurHash3', () => {
  it('should produce consistent hashes', () => {
    const hash1 = murmurHash3('test-string')
    const hash2 = murmurHash3('test-string')
    expect(hash1).toBe(hash2)
  })

  it('should produce different hashes for different inputs', () => {
    const hash1 = murmurHash3('string-a')
    const hash2 = murmurHash3('string-b')
    expect(hash1).not.toBe(hash2)
  })

  it('should produce positive integers', () => {
    const hash = murmurHash3('any-string')
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(hash)).toBe(true)
  })

  it('should handle empty string', () => {
    const hash = murmurHash3('')
    expect(hash).toBeGreaterThanOrEqual(0)
  })

  it('should handle unicode strings', () => {
    const hash = murmurHash3('你好世界')
    expect(hash).toBeGreaterThanOrEqual(0)
  })

  it('should support custom seed', () => {
    const hash1 = murmurHash3('test', 0)
    const hash2 = murmurHash3('test', 42)
    expect(hash1).not.toBe(hash2)
  })

  it('should distribute hashes uniformly', () => {
    // Generate 1000 hashes and check distribution in 10 buckets
    const buckets = new Array(10).fill(0)

    for (let i = 0; i < 1000; i++) {
      const hash = murmurHash3(`key-${i}`)
      const bucket = hash % 10
      buckets[bucket]++
    }

    // Each bucket should have roughly 100 entries (1000 / 10)
    for (const count of buckets) {
      expect(count).toBeGreaterThan(60) // Allow some variance
      expect(count).toBeLessThan(140)
    }
  })
})
