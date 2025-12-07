/**
 * Tenant Context for Sharded Database Routing
 * Sprint 6 Day 2: Async Local Storage based tenant context propagation
 *
 * Uses AsyncLocalStorage to propagate tenant ID through async call chains,
 * enabling automatic database routing without explicit parameter passing.
 */

import { AsyncLocalStorage } from 'async_hooks'
import { Logger } from '../../core/logger'
import type { ShardKeyResult } from './types'
import type { ShardedPoolManager } from './sharded-pool-manager'

const logger = new Logger('TenantContext')

/**
 * Tenant context data propagated through async calls
 */
export interface TenantContextData {
  /** Tenant identifier */
  tenantId: string
  /** Pre-computed shard routing result */
  shardResult?: ShardKeyResult
  /** Request correlation ID for tracing */
  correlationId?: string
  /** Additional context metadata */
  metadata?: Record<string, unknown>
}

/**
 * Tenant context storage
 */
class TenantContextStorage {
  private readonly storage = new AsyncLocalStorage<TenantContextData>()
  private poolManager: ShardedPoolManager | null = null

  /**
   * Set the ShardedPoolManager for automatic shard routing
   */
  setPoolManager(manager: ShardedPoolManager): void {
    this.poolManager = manager
    logger.info('TenantContext configured with ShardedPoolManager')
  }

  /**
   * Get current pool manager
   */
  getPoolManager(): ShardedPoolManager | null {
    return this.poolManager
  }

  /**
   * Run a function within a tenant context
   */
  run<T>(tenantId: string, fn: () => T, metadata?: Record<string, unknown>): T {
    const contextData: TenantContextData = {
      tenantId,
      metadata
    }

    // Pre-compute shard routing if pool manager is available
    if (this.poolManager) {
      try {
        contextData.shardResult = this.poolManager.getShardForTenant(tenantId)
      } catch (error) {
        logger.warn(`Failed to compute shard for tenant ${tenantId}:`, error as Error)
      }
    }

    return this.storage.run(contextData, fn)
  }

  /**
   * Run an async function within a tenant context
   */
  async runAsync<T>(
    tenantId: string,
    fn: () => Promise<T>,
    metadata?: Record<string, unknown>
  ): Promise<T> {
    const contextData: TenantContextData = {
      tenantId,
      metadata
    }

    // Pre-compute shard routing if pool manager is available
    if (this.poolManager) {
      try {
        contextData.shardResult = this.poolManager.getShardForTenant(tenantId)
      } catch (error) {
        logger.warn(`Failed to compute shard for tenant ${tenantId}:`, error as Error)
      }
    }

    return this.storage.run(contextData, fn)
  }

  /**
   * Get the current tenant context
   */
  getContext(): TenantContextData | undefined {
    return this.storage.getStore()
  }

  /**
   * Get the current tenant ID
   */
  getTenantId(): string | undefined {
    return this.storage.getStore()?.tenantId
  }

  /**
   * Get the current shard result (if pre-computed)
   */
  getShardResult(): ShardKeyResult | undefined {
    return this.storage.getStore()?.shardResult
  }

  /**
   * Get the current shard ID
   */
  getShardId(): string | undefined {
    return this.storage.getStore()?.shardResult?.shardId
  }

  /**
   * Check if running within a tenant context
   */
  hasTenantContext(): boolean {
    return this.storage.getStore() !== undefined
  }

  /**
   * Require tenant context - throws if not in a tenant context
   */
  requireTenantId(): string {
    const tenantId = this.getTenantId()
    if (!tenantId) {
      throw new Error('Operation requires tenant context but none is set')
    }
    return tenantId
  }

  /**
   * Require shard result - throws if not in a tenant context with routing
   */
  requireShardResult(): ShardKeyResult {
    const result = this.getShardResult()
    if (!result) {
      throw new Error('Operation requires shard routing but none is available')
    }
    return result
  }
}

/**
 * Singleton tenant context storage
 */
export const tenantContext = new TenantContextStorage()

/**
 * Decorator/middleware helper for extracting tenant from message headers
 */
export function extractTenantFromHeaders(
  headers: Record<string, unknown> | undefined,
  headerName = 'x-tenant-id'
): string | undefined {
  if (!headers) return undefined

  const tenantId = headers[headerName]
  if (typeof tenantId === 'string' && tenantId.length > 0) {
    return tenantId
  }

  return undefined
}

/**
 * Middleware function type for tenant context wrapping
 */
export type TenantContextMiddleware = <T>(
  tenantId: string,
  handler: () => Promise<T>
) => Promise<T>

/**
 * Create a tenant context middleware
 */
export function createTenantMiddleware(): TenantContextMiddleware {
  return async <T>(tenantId: string, handler: () => Promise<T>): Promise<T> => {
    return tenantContext.runAsync(tenantId, handler)
  }
}

/**
 * Higher-order function to wrap any async function with tenant context
 */
export function withTenantContext<TArgs extends unknown[], TReturn>(
  tenantId: string,
  fn: (...args: TArgs) => Promise<TReturn>
): (...args: TArgs) => Promise<TReturn> {
  return (...args: TArgs) => tenantContext.runAsync(tenantId, () => fn(...args))
}
