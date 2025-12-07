/**
 * ShardedPoolManager Tests
 * Sprint 6 Day 1: Multi-tenant database sharding with physical routing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ShardedPoolManager,
  getShardedPoolManager,
  resetShardedPoolManager
} from '../db/sharding/sharded-pool-manager'
import { TenantHashShardingStrategy } from '../db/sharding/hash-sharding-strategy'
import type { ShardInfo } from '../db/sharding/types'

// Mock pg Pool
vi.mock('pg', () => {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn()
  }

  const MockPool = vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0
  }))

  return { Pool: MockPool }
})

// Mock metrics
vi.mock('../../integration/metrics/metrics', () => ({
  coreMetrics: {
    gauge: vi.fn(),
    increment: vi.fn(),
    histogram: vi.fn()
  }
}))

describe('ShardedPoolManager (Sprint 6 Day 1)', () => {
  let manager: ShardedPoolManager

  const testShards: ShardInfo[] = [
    { shardId: 'shard-0', connectionUrl: 'postgresql://localhost:5432/db0' },
    { shardId: 'shard-1', connectionUrl: 'postgresql://localhost:5433/db1' },
    { shardId: 'shard-2', connectionUrl: 'postgresql://localhost:5434/db2' }
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    resetShardedPoolManager()
  })

  afterEach(async () => {
    if (manager) {
      await manager.close()
    }
  })

  describe('Initialization', () => {
    it('should initialize with provided shards', async () => {
      manager = new ShardedPoolManager({ enableHealthChecks: false })
      await manager.initialize(testShards)

      expect(manager.getShardIds()).toHaveLength(3)
      expect(manager.getShardIds()).toContain('shard-0')
      expect(manager.getShardIds()).toContain('shard-1')
      expect(manager.getShardIds()).toContain('shard-2')
    })

    it('should initialize with default strategy', async () => {
      manager = new ShardedPoolManager({ enableHealthChecks: false })
      await manager.initialize(testShards)

      const strategy = manager.getStrategy()
      expect(strategy.name).toBe('tenant-hash')
    })

    it('should initialize with custom strategy', async () => {
      const customStrategy = new TenantHashShardingStrategy({ defaultShardId: 'custom-default' })
      manager = new ShardedPoolManager({
        strategy: customStrategy,
        enableHealthChecks: false
      })
      await manager.initialize(testShards)

      expect(manager.getStrategy()).toBe(customStrategy)
    })

    it('should handle empty shard configuration gracefully', async () => {
      manager = new ShardedPoolManager({ enableHealthChecks: false })
      await manager.initialize([])

      expect(manager.getShardIds()).toHaveLength(0)
      expect(manager.hasHealthyShards()).toBe(false)
    })

    it('should skip duplicate shards', async () => {
      manager = new ShardedPoolManager({ enableHealthChecks: false })
      await manager.initialize(testShards)
      await manager.addShard(testShards[0]) // Try to add duplicate

      expect(manager.getShardIds()).toHaveLength(3)
    })
  })

  describe('Shard Management', () => {
    beforeEach(async () => {
      manager = new ShardedPoolManager({ enableHealthChecks: false })
      await manager.initialize(testShards)
    })

    it('should add a new shard dynamically', async () => {
      const newShard: ShardInfo = {
        shardId: 'shard-3',
        connectionUrl: 'postgresql://localhost:5435/db3'
      }

      await manager.addShard(newShard)

      expect(manager.getShardIds()).toHaveLength(4)
      expect(manager.getShardIds()).toContain('shard-3')
    })

    it('should remove a shard', async () => {
      const removed = await manager.removeShard('shard-1')

      expect(removed).toBe(true)
      expect(manager.getShardIds()).toHaveLength(2)
      expect(manager.getShardIds()).not.toContain('shard-1')
    })

    it('should return false when removing non-existent shard', async () => {
      const removed = await manager.removeShard('shard-99')

      expect(removed).toBe(false)
      expect(manager.getShardIds()).toHaveLength(3)
    })
  })

  describe('Tenant Routing', () => {
    beforeEach(async () => {
      manager = new ShardedPoolManager({ enableHealthChecks: false })
      await manager.initialize(testShards)
    })

    it('should return consistent shard for same tenant', () => {
      const result1 = manager.getShardForTenant('tenant-123')
      const result2 = manager.getShardForTenant('tenant-123')

      expect(result1.shardId).toBe(result2.shardId)
      expect(result1.shardKey).toBe(result2.shardKey)
    })

    it('should distribute tenants across shards', () => {
      const shardCounts: Record<string, number> = {}

      // Test 100 different tenants
      for (let i = 0; i < 100; i++) {
        const result = manager.getShardForTenant(`tenant-${i}`)
        shardCounts[result.shardId] = (shardCounts[result.shardId] || 0) + 1
      }

      // Should have distributed to multiple shards
      const usedShards = Object.keys(shardCounts).length
      expect(usedShards).toBeGreaterThanOrEqual(2)
    })

    it('should get pool for tenant', () => {
      const pool = manager.getPoolForTenant('tenant-123')
      expect(pool).toBeDefined()
      expect(pool.query).toBeDefined()
    })

    it('should throw when no shards configured', async () => {
      const emptyManager = new ShardedPoolManager({ enableHealthChecks: false })
      await emptyManager.initialize([])

      expect(() => emptyManager.getPoolForTenant('tenant-123')).toThrow('Cannot route tenant')
    })

    it('should throw for invalid shard ID', () => {
      expect(() => manager.getPoolByShardId('shard-99')).toThrow('Shard shard-99 not found')
    })
  })

  describe('Query Execution', () => {
    beforeEach(async () => {
      manager = new ShardedPoolManager({ enableHealthChecks: false })
      await manager.initialize(testShards)
    })

    it('should execute query on correct shard for tenant', async () => {
      const result = await manager.queryForTenant(
        'tenant-123',
        'SELECT * FROM users WHERE tenant_id = $1',
        ['tenant-123']
      )

      expect(result).toBeDefined()
      expect(result.rows).toBeDefined()
    })

    it('should execute transaction for tenant', async () => {
      const result = await manager.transactionForTenant('tenant-123', async (client) => {
        await client.query('INSERT INTO users (name) VALUES ($1)', ['test'])
        return 'success'
      })

      expect(result).toBe('success')
    })
  })

  describe('Shard Status', () => {
    beforeEach(async () => {
      manager = new ShardedPoolManager({ enableHealthChecks: false })
      await manager.initialize(testShards)
    })

    it('should return status for all shards', () => {
      const statuses = manager.getShardStatuses()

      expect(statuses).toHaveLength(3)
      statuses.forEach((status) => {
        expect(['shard-0', 'shard-1', 'shard-2']).toContain(status.shardId)
        expect(status.status).toBe('healthy')
        expect(typeof status.totalConnections).toBe('number')
        expect(typeof status.idleConnections).toBe('number')
      })
    })

    it('should report healthy shards correctly', () => {
      expect(manager.hasHealthyShards()).toBe(true)
    })
  })

  describe('Metrics', () => {
    beforeEach(async () => {
      manager = new ShardedPoolManager({ enableHealthChecks: false })
      await manager.initialize(testShards)
    })

    it('should return metrics snapshot for all shards', () => {
      const metrics = manager.getMetricsSnapshot()

      expect(metrics).toBeDefined()
      expect(Object.keys(metrics).length).toBeGreaterThan(0)

      // Should have metrics for each shard
      expect(metrics['db_shard_total_connections{shard="shard-0"}']).toBeDefined()
      expect(metrics['db_shard_healthy{shard="shard-0"}']).toBe(1)
    })
  })

  describe('Singleton Pattern', () => {
    it('should return same instance from getShardedPoolManager', () => {
      const instance1 = getShardedPoolManager()
      const instance2 = getShardedPoolManager()

      expect(instance1).toBe(instance2)
    })

    it('should reset singleton correctly', () => {
      const instance1 = getShardedPoolManager()
      resetShardedPoolManager()
      const instance2 = getShardedPoolManager()

      expect(instance1).not.toBe(instance2)
    })
  })

  describe('Cleanup', () => {
    it('should close all pools gracefully', async () => {
      manager = new ShardedPoolManager({ enableHealthChecks: false })
      await manager.initialize(testShards)

      await manager.close()

      expect(manager.getShardIds()).toHaveLength(0)
    })
  })
})

describe('ShardedPoolManager with Environment Config', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
    resetShardedPoolManager()
  })

  it('should load shards from environment variables', async () => {
    process.env.SHARD_0_URL = 'postgresql://localhost:5432/db0'
    process.env.SHARD_1_URL = 'postgresql://localhost:5433/db1'
    process.env.SHARD_0_REGION = 'us-east-1'
    process.env.SHARD_1_READONLY = 'true'

    const manager = new ShardedPoolManager({ enableHealthChecks: false })
    await manager.initialize() // No shards passed - should load from env

    expect(manager.getShardIds()).toHaveLength(2)
    expect(manager.getShardIds()).toContain('shard-0')
    expect(manager.getShardIds()).toContain('shard-1')

    await manager.close()
  })

  it('should handle missing environment config gracefully', async () => {
    // Clear all SHARD_* env vars
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith('SHARD_')) {
        delete process.env[key]
      }
    })

    const manager = new ShardedPoolManager({ enableHealthChecks: false })
    await manager.initialize()

    expect(manager.getShardIds()).toHaveLength(0)
    expect(manager.hasHealthyShards()).toBe(false)

    await manager.close()
  })
})
