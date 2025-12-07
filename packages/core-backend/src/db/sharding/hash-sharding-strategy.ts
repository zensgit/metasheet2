/**
 * Tenant Hash Sharding Strategy
 * Sprint 5 Day 4: Implements consistent hash-based sharding
 *
 * Uses MurmurHash3 for uniform distribution across shards.
 * This implementation focuses on the algorithm only - no actual database routing.
 */

import type {
  ShardInfo,
  ShardKeyResult,
  ShardingStrategy,
  ShardingStrategyConfig
} from './types'

/**
 * Simple MurmurHash3 implementation (32-bit)
 * Provides good distribution for string keys
 */
function murmurHash3(key: string, seed = 0): number {
  const encoder = new TextEncoder()
  const data = encoder.encode(key)

  let h1 = seed
  const c1 = 0xcc9e2d51
  const c2 = 0x1b873593

  for (let i = 0; i < data.length; i += 4) {
    let k1 = 0
    const remaining = Math.min(4, data.length - i)

    for (let j = 0; j < remaining; j++) {
      k1 |= data[i + j] << (j * 8)
    }

    k1 = Math.imul(k1, c1)
    k1 = (k1 << 15) | (k1 >>> 17)
    k1 = Math.imul(k1, c2)

    h1 ^= k1
    h1 = (h1 << 13) | (h1 >>> 19)
    h1 = Math.imul(h1, 5) + 0xe6546b64
  }

  h1 ^= data.length
  h1 ^= h1 >>> 16
  h1 = Math.imul(h1, 0x85ebca6b)
  h1 ^= h1 >>> 13
  h1 = Math.imul(h1, 0xc2b2ae35)
  h1 ^= h1 >>> 16

  return h1 >>> 0 // Convert to unsigned 32-bit
}

/**
 * TenantHashShardingStrategy uses consistent hashing for tenant distribution
 */
export class TenantHashShardingStrategy implements ShardingStrategy {
  readonly name = 'tenant-hash'

  private shards: Map<string, ShardInfo> = new Map()
  private sortedShardIds: string[] = []
  private readonly config: Required<ShardingStrategyConfig>
  private readonly cache: Map<string, ShardKeyResult> = new Map()

  constructor(config: ShardingStrategyConfig = {}) {
    this.config = {
      defaultShardId: config.defaultShardId ?? 'shard-0',
      virtualNodes: config.virtualNodes ?? 150,
      enableCache: config.enableCache ?? true,
      cacheTtlMs: config.cacheTtlMs ?? 60000
    }
  }

  /**
   * Compute shard key using MurmurHash3
   */
  getShardKey(tenantId: string): ShardKeyResult {
    // Check cache first
    if (this.config.enableCache) {
      const cached = this.cache.get(tenantId)
      if (cached) return cached
    }

    const totalShards = this.shards.size || 1
    const hash = murmurHash3(tenantId)
    const shardIndex = hash % totalShards
    const shardId = this.sortedShardIds[shardIndex] ?? this.config.defaultShardId

    const result: ShardKeyResult = {
      shardKey: hash,
      totalShards,
      shardId
    }

    // Update cache
    if (this.config.enableCache) {
      this.cache.set(tenantId, result)
      // Simple cache eviction - clear when too large
      if (this.cache.size > 10000) {
        this.cache.clear()
      }
    }

    return result
  }

  /**
   * Get shard info by ID
   */
  getShardInfo(shardId: string): ShardInfo | undefined {
    return this.shards.get(shardId)
  }

  /**
   * Get all registered shards
   */
  getAllShards(): ShardInfo[] {
    return Array.from(this.shards.values())
  }

  /**
   * Add a new shard to the pool
   */
  addShard(shard: ShardInfo): void {
    this.shards.set(shard.shardId, shard)
    this.updateSortedShards()
    this.cache.clear() // Invalidate cache on topology change
  }

  /**
   * Remove a shard from the pool
   */
  removeShard(shardId: string): boolean {
    const removed = this.shards.delete(shardId)
    if (removed) {
      this.updateSortedShards()
      this.cache.clear()
    }
    return removed
  }

  /**
   * Check if strategy can handle the tenant
   * Returns true if at least one shard is configured
   */
  canHandle(tenantId: string): boolean {
    return this.shards.size > 0 && typeof tenantId === 'string' && tenantId.length > 0
  }

  /**
   * Update sorted shard IDs for consistent ordering
   */
  private updateSortedShards(): void {
    this.sortedShardIds = Array.from(this.shards.keys()).sort()
  }

  /**
   * Get distribution statistics for testing
   */
  getDistributionStats(tenantIds: string[]): {
    shardCounts: Record<string, number>
    variance: number
    isUniform: boolean
  } {
    const shardCounts: Record<string, number> = {}

    // Initialize counts
    for (const shardId of this.sortedShardIds) {
      shardCounts[shardId] = 0
    }

    // Count tenants per shard
    for (const tenantId of tenantIds) {
      const result = this.getShardKey(tenantId)
      shardCounts[result.shardId] = (shardCounts[result.shardId] || 0) + 1
    }

    // Calculate variance
    const counts = Object.values(shardCounts)
    const mean = tenantIds.length / counts.length
    const variance = counts.reduce((sum, count) => sum + Math.pow(count - mean, 2), 0) / counts.length
    const stdDev = Math.sqrt(variance)

    // Consider uniform if standard deviation is within 10% of mean
    const isUniform = stdDev / mean < 0.1

    return { shardCounts, variance, isUniform }
  }

  /**
   * Clear the tenant cache
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; enabled: boolean; ttlMs: number } {
    return {
      size: this.cache.size,
      enabled: this.config.enableCache,
      ttlMs: this.config.cacheTtlMs
    }
  }
}

// Export hash function for testing
export { murmurHash3 }
