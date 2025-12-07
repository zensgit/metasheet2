
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { poolManager } from '../integration/db/connection-pool'

describe('Connection Pool Sharding (Sprint 6 Day 1)', () => {
  beforeEach(() => {
    // Reset pools before each test
    // We need to cast to any to access private properties for testing
    const pm = poolManager as any
    pm.pools.clear()
    if (pm.main) {
      pm.pools.set('main', pm.main)
    }
  })

  afterEach(async () => {
    // Clean up any created pools
    const pm = poolManager as any
    for (const [name, pool] of pm.pools.entries()) {
      if (name !== 'main') {
        await pool.getInternalPool().end()
      }
    }
  })

  it('should initialize multiple shard pools', () => {
    const shardConfigs = [
      {
        id: 'shard-0',
        config: {
          connectionString: 'postgres://user:pass@localhost:5432/shard0',
          max: 5
        }
      },
      {
        id: 'shard-1',
        config: {
          connectionString: 'postgres://user:pass@localhost:5432/shard1',
          max: 5
        }
      }
    ]

    poolManager.initializeShards(shardConfigs)

    const shard0 = poolManager.get('shard-0')
    const shard1 = poolManager.get('shard-1')
    const main = poolManager.get('main')

    expect(shard0).toBeDefined()
    expect(shard1).toBeDefined()
    expect(main).toBeDefined()

    expect(shard0.name).toBe('shard-0')
    expect(shard1.name).toBe('shard-1')
    expect(main.name).toBe('main')

    expect(shard0).not.toBe(shard1)
    expect(shard0).not.toBe(main)
  })

  it('should return main pool for unknown shard if configured to fallback', () => {
    // Default behavior of get() is to return main if not found? 
    // Let's check implementation: return this.pools.get(name) || this.main
    // So yes, it falls back to main.
    
    const unknownShard = poolManager.get('shard-999')
    const main = poolManager.get('main')
    
    expect(unknownShard).toBe(main)
  })

  it('should allow retrieving specific shard by name', () => {
    poolManager.createPool('specific-shard', {
      connectionString: 'postgres://localhost:5432/db',
    })

    const pool = poolManager.get('specific-shard')
    expect(pool.name).toBe('specific-shard')
  })
  
  it('should include shard metrics in snapshot', () => {
    poolManager.createPool('metrics-shard', {
      connectionString: 'postgres://localhost:5432/db',
    })
    
    const metrics = poolManager.getMetricsSnapshot()
    
    // Check for keys containing the pool name
    const shardKeys = Object.keys(metrics).filter(k => k.includes('pool="metrics-shard"'))
    expect(shardKeys.length).toBeGreaterThan(0)
    expect(metrics[`db_pool_total_connections{pool="metrics-shard"}`]).toBeDefined()
  })
})
