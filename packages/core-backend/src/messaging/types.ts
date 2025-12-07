/**
 * Messaging System Type Definitions
 * Sprint 5: Pattern Matching Performance Optimization
 */

import type { Subscription } from './pattern-trie'

/**
 * Extended subscription interface for MessageBus integration
 * Adds plugin field for lifecycle management (subscribe/unsubscribe by plugin)
 */
export interface MessageBusSubscription extends Subscription {
  /** Plugin identifier for lifecycle management */
  plugin?: string
}

/**
 * Handler function signature for MessageBus
 */
export type MessageHandler<T = unknown, R = unknown> = (
  msg: InternalMessage<T>
) => Promise<R> | R

/**
 * Message priority levels
 */
export type MessagePriority = 'low' | 'normal' | 'high'

/**
 * Internal message structure used by MessageBus
 */
export interface InternalMessage<T = unknown> {
  id: string
  topic: string
  payload: T
  priority: MessagePriority
  attempts: number
  maxRetries: number
  correlationId?: string
  replyTo?: string
  source?: string
  createdAt: number
  expiresAt?: number
  backoff?: BackoffOptions
  headers?: Record<string, unknown>
}

/**
 * Backoff configuration options
 */
export interface BackoffOptions {
  type: 'fixed' | 'exponential' | 'linear'
  initialDelayMs: number
  maxDelayMs?: number
  multiplier?: number
}

/**
 * Options for publishing messages
 */
export interface PublishOptions {
  priority?: MessagePriority
  correlationId?: string
  replyTo?: string
  maxRetries?: number
  timeoutMs?: number
  expiryMs?: number
  expiresAt?: number
  delay?: number
  backoff?: BackoffOptions
  headers?: Record<string, unknown>
}

/**
 * Subscription metadata for pattern subscriptions
 */
export interface PatternSubscriptionMetadata extends Record<string, unknown> {
  plugin?: string
  createdBy?: string
  description?: string
}

/**
 * Result of a pattern match operation
 */
export interface PatternMatchResult {
  subscriptions: MessageBusSubscription[]
  matchTime: number
  cacheHit: boolean
}

/**
 * Feature flags for MessageBus
 */
export interface MessageBusFeatureFlags {
  /** Enable PatternTrie for O(log N) matching instead of O(N) regex */
  enablePatternTrie: boolean
  /** Enable metrics collection */
  enableMetrics: boolean
  /** Enable dead letter queue */
  enableDLQ: boolean
}

/**
 * MessageBus configuration options
 */
export interface MessageBusConfig {
  /** Default number of retries for failed messages */
  defaultRetries?: number
  /** Feature flags */
  features?: Partial<MessageBusFeatureFlags>
  /** Pattern manager configuration */
  patternManagerConfig?: {
    maxCacheSize?: number
    cacheTtlMs?: number
    optimizationMode?: 'memory' | 'speed' | 'balanced'
  }
}
