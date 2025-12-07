/**
 * Message Shard Interceptor
 * Sprint 6 Day 2: MessageBus integration for automatic tenant-based sharding
 *
 * Intercepts messages with tenant headers and wraps handler execution
 * in the appropriate tenant context for automatic database routing.
 */

import { Logger } from '../../core/logger'
import { coreMetrics } from '../../integration/metrics/metrics'
import { tenantContext, extractTenantFromHeaders } from './tenant-context'
import type { ShardedPoolManager } from './sharded-pool-manager'

const logger = new Logger('MessageShardInterceptor')

/**
 * Message with headers interface
 */
interface MessageWithHeaders {
  id?: string
  topic?: string
  headers?: Record<string, unknown>
  payload?: unknown
}

/**
 * Handler function type
 */
type MessageHandler<T = unknown, R = unknown> = (msg: T) => Promise<R> | R

/**
 * Interceptor configuration
 */
export interface MessageShardInterceptorConfig {
  /** Header name to extract tenant ID from (default: 'x-tenant-id') */
  tenantHeaderName?: string
  /** Whether to require tenant header on all messages (default: false) */
  requireTenant?: boolean
  /** Topics to exclude from tenant routing */
  excludeTopics?: string[]
  /** Enable metrics collection */
  enableMetrics?: boolean
}

/**
 * MessageShardInterceptor wraps message handlers to automatically
 * set up tenant context for database routing.
 */
export class MessageShardInterceptor {
  private readonly config: Required<MessageShardInterceptorConfig>
  private poolManager: ShardedPoolManager | null = null
  private readonly excludeTopicSet: Set<string>

  constructor(config: MessageShardInterceptorConfig = {}) {
    this.config = {
      tenantHeaderName: config.tenantHeaderName ?? 'x-tenant-id',
      requireTenant: config.requireTenant ?? false,
      excludeTopics: config.excludeTopics ?? [],
      enableMetrics: config.enableMetrics ?? true
    }

    this.excludeTopicSet = new Set(this.config.excludeTopics)

    // Add system topics to exclusion list
    this.excludeTopicSet.add('__rpc.reply.*')
    this.excludeTopicSet.add('system.*')
    this.excludeTopicSet.add('health.*')
  }

  /**
   * Set the ShardedPoolManager for routing
   */
  setPoolManager(manager: ShardedPoolManager): void {
    this.poolManager = manager
    tenantContext.setPoolManager(manager)
    logger.info('MessageShardInterceptor configured with ShardedPoolManager')
  }

  /**
   * Check if a topic should be excluded from tenant routing
   */
  private shouldExclude(topic: string): boolean {
    // Check exact match
    if (this.excludeTopicSet.has(topic)) {
      return true
    }

    // Check wildcard patterns
    for (const pattern of this.excludeTopicSet) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1)
        if (topic.startsWith(prefix)) {
          return true
        }
      }
    }

    return false
  }

  /**
   * Wrap a message handler with tenant context
   */
  wrap<T extends MessageWithHeaders, R>(
    handler: MessageHandler<T, R>
  ): MessageHandler<T, R> {
    return async (msg: T): Promise<R> => {
      const topic = msg.topic ?? 'unknown'

      // Skip excluded topics
      if (this.shouldExclude(topic)) {
        return handler(msg)
      }

      // Extract tenant ID from headers
      const tenantId = extractTenantFromHeaders(msg.headers, this.config.tenantHeaderName)

      // Handle missing tenant
      if (!tenantId) {
        if (this.config.requireTenant) {
          if (this.config.enableMetrics) {
            coreMetrics.increment('shard_routing_missing_tenant', { topic })
          }
          throw new Error(`Missing required tenant header '${this.config.tenantHeaderName}' on topic '${topic}'`)
        }

        // No tenant context - execute without routing
        return handler(msg)
      }

      // Execute with tenant context
      const startTime = Date.now()

      try {
        const result = await tenantContext.runAsync(tenantId, async () => handler(msg))

        if (this.config.enableMetrics) {
          const duration = Date.now() - startTime
          const shardId = tenantContext.getShardId() ?? 'unknown'

          coreMetrics.increment('shard_routed_messages', { shard: shardId, topic })
          coreMetrics.histogram('shard_routing_duration_ms', duration, { shard: shardId })
        }

        return result
      } catch (error) {
        if (this.config.enableMetrics) {
          coreMetrics.increment('shard_routing_errors', { topic })
        }
        throw error
      }
    }
  }

  /**
   * Create a sharded subscription wrapper for MessageBus
   *
   * Usage:
   * ```typescript
   * const interceptor = new MessageShardInterceptor()
   * interceptor.setPoolManager(shardedPoolManager)
   *
   * messageBus.subscribe('user.created', interceptor.wrap(async (msg) => {
   *   // Inside here, tenantContext.getTenantId() returns the tenant
   *   // and database queries are automatically routed to the correct shard
   *   const pool = tenantContext.getPoolManager()?.getPoolForTenant(tenantContext.getTenantId()!)
   *   await pool?.query('INSERT INTO audit_log ...')
   * }))
   * ```
   */
  createShardedHandler<T extends MessageWithHeaders, R>(
    handler: MessageHandler<T, R>
  ): MessageHandler<T, R> {
    return this.wrap(handler)
  }

  /**
   * Get shard information for a tenant (for debugging/monitoring)
   */
  getShardInfo(tenantId: string): { shardId: string; totalShards: number } | null {
    if (!this.poolManager) {
      return null
    }

    try {
      const result = this.poolManager.getShardForTenant(tenantId)
      return {
        shardId: result.shardId,
        totalShards: result.totalShards
      }
    } catch {
      return null
    }
  }

  /**
   * Check if the interceptor is properly configured
   */
  isConfigured(): boolean {
    return this.poolManager !== null && this.poolManager.hasHealthyShards()
  }

  /**
   * Get configuration
   */
  getConfig(): Required<MessageShardInterceptorConfig> {
    return { ...this.config }
  }
}

/**
 * Singleton interceptor instance
 */
let shardInterceptor: MessageShardInterceptor | null = null

export function getMessageShardInterceptor(): MessageShardInterceptor {
  if (!shardInterceptor) {
    shardInterceptor = new MessageShardInterceptor()
  }
  return shardInterceptor
}

export function resetMessageShardInterceptor(): void {
  shardInterceptor = null
}

/**
 * Helper: Create a tenant-aware message handler
 *
 * This is a convenience function that combines MessageShardInterceptor
 * with database query routing.
 */
export function createTenantAwareHandler<T extends MessageWithHeaders, R>(
  handler: (msg: T, context: { tenantId: string; shardId: string }) => Promise<R> | R,
  options: { interceptor?: MessageShardInterceptor } = {}
): MessageHandler<T, R> {
  const interceptor = options.interceptor ?? getMessageShardInterceptor()

  return interceptor.wrap(async (msg: T): Promise<R> => {
    const tenantId = tenantContext.getTenantId()
    const shardId = tenantContext.getShardId()

    if (!tenantId || !shardId) {
      throw new Error('Tenant context not available')
    }

    return handler(msg, { tenantId, shardId })
  })
}
