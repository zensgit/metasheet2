/**
 * Sharding Module Exports
 * Sprint 5 Day 4: Multi-tenant database sharding
 * Sprint 6 Day 1: Multi-pool manager with physical routing
 * Sprint 6 Day 2: MessageBus integration for tenant routing
 */

// Types
export type {
  ShardInfo,
  ShardKeyResult,
  ShardingStrategy,
  ShardingStrategyConfig
} from './types'

// Sharding Strategy Implementations
export {
  TenantHashShardingStrategy,
  murmurHash3
} from './hash-sharding-strategy'

// Sharded Pool Manager (Sprint 6 Day 1)
export type {
  ShardPoolConfig,
  ShardedPoolManagerConfig,
  ShardStatus
} from './sharded-pool-manager'

export {
  ShardedPoolManager,
  getShardedPoolManager,
  resetShardedPoolManager
} from './sharded-pool-manager'

// Tenant Context (Sprint 6 Day 2)
export type {
  TenantContextData,
  TenantContextMiddleware
} from './tenant-context'

export {
  tenantContext,
  extractTenantFromHeaders,
  createTenantMiddleware,
  withTenantContext
} from './tenant-context'

// Message Shard Interceptor (Sprint 6 Day 2)
export type {
  MessageShardInterceptorConfig
} from './message-shard-interceptor'

export {
  MessageShardInterceptor,
  getMessageShardInterceptor,
  resetMessageShardInterceptor,
  createTenantAwareHandler
} from './message-shard-interceptor'
