/**
 * Sharding Strategy Types
 * Sprint 5 Day 4: Multi-tenant database sharding support
 *
 * This module defines the core interfaces for tenant-based sharding.
 * The actual routing is NOT implemented in this sprint to reduce complexity.
 */

/**
 * Shard information for routing database queries
 */
export interface ShardInfo {
  /** Unique shard identifier (e.g., "shard-0", "shard-1") */
  shardId: string
  /** Database connection URL for this shard */
  connectionUrl: string
  /** Shard weight for load balancing (default: 1) */
  weight?: number
  /** Whether the shard is read-only */
  readOnly?: boolean
  /** Optional region/datacenter hint */
  region?: string
}

/**
 * Result of computing a shard key from tenant information
 */
export interface ShardKeyResult {
  /** Computed shard key (hash value or partition index) */
  shardKey: number
  /** Number of total shards in the ring */
  totalShards: number
  /** Resolved shard ID based on the key */
  shardId: string
}

/**
 * Strategy interface for determining which shard a tenant belongs to
 */
export interface ShardingStrategy {
  /**
   * Name of the sharding strategy
   */
  readonly name: string

  /**
   * Compute the shard key for a given tenant
   * @param tenantId - The tenant identifier
   * @returns ShardKeyResult with shard routing information
   */
  getShardKey(tenantId: string): ShardKeyResult

  /**
   * Get the database URL for a specific shard
   * @param shardId - The shard identifier
   * @returns ShardInfo for the requested shard, or undefined if not found
   */
  getShardInfo(shardId: string): ShardInfo | undefined

  /**
   * Get all available shards
   * @returns Array of all configured shards
   */
  getAllShards(): ShardInfo[]

  /**
   * Register a new shard
   * @param shard - ShardInfo to register
   */
  addShard(shard: ShardInfo): void

  /**
   * Remove a shard from the pool
   * @param shardId - Shard ID to remove
   * @returns true if shard was found and removed
   */
  removeShard(shardId: string): boolean

  /**
   * Check if the strategy can handle the given tenant
   * @param tenantId - The tenant identifier
   * @returns true if this strategy can route the tenant
   */
  canHandle(tenantId: string): boolean
}

/**
 * Configuration options for sharding strategies
 */
export interface ShardingStrategyConfig {
  /** Default shard to use when no matching shard found */
  defaultShardId?: string
  /** Number of virtual nodes for consistent hashing */
  virtualNodes?: number
  /** Whether to enable shard affinity caching */
  enableCache?: boolean
  /** Cache TTL in milliseconds */
  cacheTtlMs?: number
}
