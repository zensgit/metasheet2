/**
 * MessageBus - Core messaging infrastructure
 * Sprint 5: Integrated PatternManager for O(log N) pattern matching
 *
 * Feature Flag: ENABLE_PATTERN_TRIE
 * - true: Use PatternTrie for O(log N) matching (default in production)
 * - false: Use legacy regex array for O(N) matching (fallback)
 */

import { randomUUID } from 'crypto'
import { coreMetrics } from '../metrics/metrics'
import { delayService } from '../../services/DelayService'
import { dlqService } from '../../services/DeadLetterQueueService'
import { BackoffStrategy } from '../../utils/BackoffStrategy'
import type { BackoffOptions } from '../../utils/BackoffStrategy'
import { Logger } from '../../core/logger'
import { PatternManager } from '../../messaging/pattern-manager'
import type { MessageBusSubscription } from '../../messaging/types'

const logger = new Logger('MessageBus')

export type MessagePriority = 'low' | 'normal' | 'high'

interface PublishOptions {
  priority?: MessagePriority
  correlationId?: string
  replyTo?: string
  maxRetries?: number
  timeoutMs?: number // for request/reply
  expiryMs?: number // relative milliseconds until expiry
  expiresAt?: number // absolute epoch ms; overrides expiryMs
  delay?: number // delay in ms
  backoff?: BackoffOptions
  headers?: Record<string, unknown>
}

interface InternalMessage<T = unknown> {
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

type Handler<T = unknown, R = unknown> = (msg: InternalMessage<T>) => Promise<R> | R

interface Subscription {
  id: string
  topic: string
  handler: Handler<unknown, unknown>
  plugin?: string
}

interface PendingRpc<T = unknown> {
  resolve: (value: T) => void
  reject: (reason?: Error) => void
  timeout: NodeJS.Timeout
  /** Cleanup function to unsubscribe reply topic (Sprint 6 Day 3 fix) */
  cleanup?: () => void
}

/** Legacy pattern subscription for fallback mode */
interface LegacyPatternSub {
  id: string
  pattern: string
  regex: RegExp
  handler: Handler<unknown, unknown>
  plugin?: string
}

/**
 * Message Handler Interceptor interface
 * Allows wrapping handlers for cross-cutting concerns like sharding, tracing, etc.
 */
export interface MessageHandlerInterceptor {
  wrap<T = unknown, R = unknown>(handler: Handler<T, R>): Handler<T, R>
}

/**
 * MessageBus Configuration
 */
interface MessageBusConfig {
  /** Enable PatternTrie for O(log N) matching (default: true) */
  enablePatternTrie?: boolean
  /** Default retry count for failed messages */
  defaultRetries?: number
  /** PatternManager configuration */
  patternManagerConfig?: {
    cacheTtlMs?: number
    optimizationMode?: 'memory' | 'speed' | 'balanced'
  }
}

class MessageBus {
  // Exact topic subscriptions (always used)
  private subs: Map<string, Subscription[]> = new Map()

  // Legacy pattern subscriptions (fallback mode)
  private legacyPatternSubs: LegacyPatternSub[] = []

  // New PatternManager for Trie-based matching
  private patternManager: PatternManager | null = null

  // Feature flag for switching between implementations
  private readonly usePatternTrie: boolean

  private queue: InternalMessage[] = []
  private processing = false
  private pendingRpc: Map<string, PendingRpc> = new Map()
  private defaultRetries: number
  private interceptor?: MessageHandlerInterceptor

  constructor(config: MessageBusConfig = {}) {
    // Read feature flag from environment or config
    this.usePatternTrie = config.enablePatternTrie ??
      (process.env.ENABLE_PATTERN_TRIE !== 'false') // Default: enabled unless explicitly disabled

    this.defaultRetries = config.defaultRetries ?? 2

    if (this.usePatternTrie) {
      this.patternManager = new PatternManager(logger, coreMetrics, {
        enableMetrics: true,
        optimizationMode: config.patternManagerConfig?.optimizationMode ?? 'balanced',
        cacheTtlMs: config.patternManagerConfig?.cacheTtlMs ?? 10000
      })
      logger.info('MessageBus initialized with PatternTrie (O(log N) matching)')
    } else {
      logger.info('MessageBus initialized with legacy regex matching (O(N))')
    }
  }

  /**
   * Set a global message handler interceptor
   * Used for cross-cutting concerns like sharding context propagation
   */
  setInterceptor(interceptor: MessageHandlerInterceptor): void {
    this.interceptor = interceptor
    logger.info('MessageBus interceptor configured')
  }

  /**
   * Subscribe to an exact topic
   */
  subscribe<T = unknown, R = unknown>(topic: string, handler: Handler<T, R>, plugin?: string): string {
    const effectiveHandler = this.interceptor ? this.interceptor.wrap(handler) : handler
    
    const sub: Subscription = {
      id: `sub_${randomUUID()}`,
      topic,
      handler: effectiveHandler as Handler<unknown, unknown>,
      plugin
    }
    if (!this.subs.has(topic)) this.subs.set(topic, [])
    this.subs.get(topic)!.push(sub)
    return sub.id
  }

  /**
   * Pattern subscription with wildcard support
   *
   * With PatternTrie (ENABLE_PATTERN_TRIE=true):
   *   - Supports: user.*, *.login, user.*.action, *.*.event
   *   - O(log N) matching complexity
   *
   * Legacy mode (ENABLE_PATTERN_TRIE=false):
   *   - Supports: prefix.* only (e.g., "order.*")
   *   - O(N) matching complexity (regex scan)
   */
  subscribePattern<T = unknown, R = unknown>(pattern: string, handler: Handler<T, R>, plugin?: string): string {
    const effectiveHandler = this.interceptor ? this.interceptor.wrap(handler) : handler

    if (this.usePatternTrie && this.patternManager) {
      // New Trie-based implementation
      // Wrap handler to match PatternManager callback signature
      const wrappedCallback = (topic: string, message: unknown) => {
        const msg = message as InternalMessage<T>
        return effectiveHandler(msg)
      }

      return this.patternManager.subscribe(pattern, wrappedCallback, { plugin })
    } else {
      // Legacy implementation
      return this.subscribePatternLegacy(pattern, effectiveHandler, plugin)
    }
  }

  /**
   * Legacy pattern subscription (O(N) regex matching)
   * Kept for fallback compatibility
   */
  private subscribePatternLegacy<T = unknown, R = unknown>(
    pattern: string,
    handler: Handler<T, R>,
    plugin?: string
  ): string {
    const stars = (pattern.match(/\*/g) || []).length
    if (pattern === '*' || pattern === '.*') {
      throw new Error('Wildcard "*" alone not supported; use specific prefix like "order.*"')
    }
    if (stars > 1 || (stars === 1 && !pattern.endsWith('.*'))) {
      throw new Error('Only single trailing prefix.* supported in legacy mode (e.g. "order.*")')
    }

    let regex: RegExp
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2)
      const escaped = prefix.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
      regex = new RegExp('^' + escaped + '\\..+')
    } else {
      const escapedExact = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
      regex = new RegExp('^' + escapedExact + '$')
    }

    const id = `psub_${randomUUID()}`
    this.legacyPatternSubs.push({
      id,
      pattern,
      regex,
      handler: handler as Handler<unknown, unknown>,
      plugin
    })
    return id
  }

  /**
   * Unsubscribe by subscription ID
   */
  unsubscribe(subId: string): boolean {
    // Check exact topic subscriptions
    for (const [topic, arr] of this.subs.entries()) {
      const idx = arr.findIndex(s => s.id === subId)
      if (idx >= 0) {
        arr.splice(idx, 1)
        if (arr.length === 0) this.subs.delete(topic)
        return true
      }
    }

    // Check pattern subscriptions
    if (this.usePatternTrie && this.patternManager) {
      return this.patternManager.unsubscribeById(subId)
    } else {
      const pIdx = this.legacyPatternSubs.findIndex(p => p.id === subId)
      if (pIdx >= 0) {
        this.legacyPatternSubs.splice(pIdx, 1)
        return true
      }
    }

    return false
  }

  /**
   * Unsubscribe all subscriptions for a plugin
   * Used for plugin lifecycle management (deactivation/uninstall)
   */
  unsubscribeByPlugin(plugin: string): number {
    let count = 0

    // Remove exact topic subscriptions
    for (const arr of this.subs.values()) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].plugin === plugin) {
          arr.splice(i, 1)
          count++
        }
      }
    }

    // Remove pattern subscriptions
    if (this.usePatternTrie && this.patternManager) {
      count += this.patternManager.unsubscribeByPlugin(plugin)
    } else {
      for (let i = this.legacyPatternSubs.length - 1; i >= 0; i--) {
        if (this.legacyPatternSubs[i].plugin === plugin) {
          this.legacyPatternSubs.splice(i, 1)
          count++
        }
      }
    }

    return count
  }

  /**
   * Track subscriptions by plugin name for lifecycle cleanup
   * @deprecated Use subscribe() with plugin parameter instead
   */
  subscribeWithPlugin<T = unknown, R = unknown>(topic: string, handler: Handler<T, R>, plugin: string): string {
    return this.subscribe(topic, handler, plugin)
  }

  /**
   * Publish a message to a topic
   */
  async publish<T = unknown>(topic: string, payload: T, opts: PublishOptions = {}): Promise<string> {
    // Handle delay
    if (opts.delay && opts.delay > 0) {
      return delayService.schedule(topic, payload, opts.delay, {
        priority: opts.priority,
        headers: opts.headers
      })
    }

    const msg: InternalMessage<T> = {
      id: `msg_${randomUUID()}`,
      topic,
      payload,
      priority: opts.priority || 'normal',
      attempts: 0,
      maxRetries: opts.maxRetries ?? this.defaultRetries,
      correlationId: opts.correlationId,
      replyTo: opts.replyTo,
      createdAt: Date.now(),
      expiresAt: opts.expiresAt ?? (opts.expiryMs ? Date.now() + opts.expiryMs : undefined),
      backoff: opts.backoff,
      headers: opts.headers
    }

    // Immediate expiry short-circuit (avoid enqueuing stale messages)
    if (msg.expiresAt && msg.expiresAt <= Date.now()) {
      coreMetrics.inc('messagesExpired')
      return msg.id
    }

    this.enqueue(msg)
    this.processQueue()
    return msg.id
  }

  private enqueue(msg: InternalMessage) {
    // Insert based on priority (simple approach: unshift high, push low)
    if (msg.priority === 'high') {
      this.queue.unshift(msg)
    } else if (msg.priority === 'low') {
      this.queue.push(msg)
    } else {
      // normal -> middle: push then slight bubble behind high items
      const hiCount = this.queue.findIndex(m => m.priority !== 'high')
      if (hiCount === -1) this.queue.push(msg)
      else this.queue.splice(hiCount, 0, msg)
    }
  }

  /**
   * Process the message queue
   * Uses PatternManager.findMatches() when enabled for O(log N) matching
   */
  private async processQueue() {
    if (this.processing) return
    this.processing = true

    while (this.queue.length) {
      const msg = this.queue.shift()!

      // Expiry check
      if (msg.expiresAt && Date.now() >= msg.expiresAt) {
        coreMetrics.inc('messagesExpired')
        continue
      }

      // Gather all matching subscribers
      const allSubs = this.findMatchingSubscribers(msg.topic, msg)

      if (allSubs.length === 0) {
        // No subscriber -> if RPC request and expecting reply -> reject
        if (msg.replyTo && msg.correlationId) {
          const pending = this.pendingRpc.get(msg.correlationId)
          if (pending) {
            clearTimeout(pending.timeout)
            // Sprint 6 Day 3: Call cleanup to properly unsubscribe reply topic
            pending.cleanup?.()
            pending.reject(new Error('No subscriber for RPC target'))
          }
        }
        continue
      }

      // Execute handlers
      for (const sub of allSubs) {
        try {
          await sub.handler(msg)
          coreMetrics.inc('messagesProcessed')
        } catch (e) {
          await this.handleMessageError(msg, e)
        }
      }
    }

    this.processing = false
  }

  /**
   * Find all subscribers matching a topic
   * Uses PatternTrie when enabled for O(log N) complexity
   */
  private findMatchingSubscribers(
    topic: string,
    _msg: InternalMessage
  ): Array<{ id: string; handler: Handler<unknown, unknown>; plugin?: string }> {
    const result: Array<{ id: string; handler: Handler<unknown, unknown>; plugin?: string }> = []

    // Exact topic subscriptions (always checked)
    const exactSubs = this.subs.get(topic) || []
    for (const sub of exactSubs) {
      result.push({ id: sub.id, handler: sub.handler, plugin: sub.plugin })
    }

    // Pattern subscriptions
    if (this.usePatternTrie && this.patternManager) {
      // O(log N) Trie matching
      const matchResult = this.patternManager.findMatches(topic)

      for (const sub of matchResult.subscriptions) {
        const mbSub = sub as MessageBusSubscription
        // Wrap callback to handler signature
        const handler: Handler<unknown, unknown> = (internalMsg) => {
          return sub.callback(internalMsg.topic, internalMsg)
        }
        result.push({ id: sub.id, handler, plugin: mbSub.plugin })
      }
    } else {
      // O(N) Legacy regex matching
      for (const p of this.legacyPatternSubs) {
        if (p.regex.test(topic)) {
          result.push({ id: p.id, handler: p.handler, plugin: p.plugin })
        }
      }
    }

    return result
  }

  /**
   * Handle message processing errors with retry and DLQ logic
   */
  private async handleMessageError(msg: InternalMessage, e: unknown): Promise<void> {
    msg.attempts += 1
    coreMetrics.inc('messagesRetried')

    if (msg.attempts <= msg.maxRetries) {
      // Handle backoff
      const delay = msg.backoff ? BackoffStrategy.calculate(msg.attempts, msg.backoff) : 0
      if (delay > 0) {
        delayService.schedule(msg.topic, msg.payload, delay, {
          priority: msg.priority,
          headers: { ...msg.headers, 'x-retry-attempt': msg.attempts }
        })
      } else {
        this.enqueue(msg)
      }
    } else {
      // Send to DLQ
      try {
        await dlqService.enqueue(
          msg.topic,
          msg.payload,
          e instanceof Error ? e : new Error(String(e)),
          {
            ...msg.headers,
            originalMessageId: msg.id,
            correlationId: msg.correlationId,
            attempts: msg.attempts
          }
        )
      } catch (dlqError) {
        logger.error('Failed to enqueue to DLQ', dlqError instanceof Error ? dlqError : undefined)
      }

      if (msg.correlationId && this.pendingRpc.has(msg.correlationId)) {
        const pending = this.pendingRpc.get(msg.correlationId)!
        clearTimeout(pending.timeout)
        // Sprint 6 Day 3: Call cleanup to properly unsubscribe reply topic
        pending.cleanup?.()
        pending.reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
  }

  /**
   * RPC request - send and wait for response
   *
   * Sprint 6 Day 3: Fixed memory leak - reply subscriptions are now properly
   * cleaned up on timeout. Added rpc_active_correlations metric.
   */
  async request<TRequest = unknown, TResponse = unknown>(
    topic: string,
    payload: TRequest,
    timeoutMs = 3000
  ): Promise<TResponse> {
    const correlationId = randomUUID()
    const replyTopic = `__rpc.reply.${correlationId}`

    // Track active RPC correlations for monitoring
    coreMetrics.gauge('rpc_active_correlations', this.pendingRpc.size + 1)

    return new Promise<TResponse>((resolve, reject) => {
      // Must declare replySubId before timeout so it's accessible in cleanup
      let replySubId: string | null = null

      const cleanup = () => {
        // Clean up subscription to prevent memory leak
        if (replySubId) {
          this.unsubscribe(replySubId)
        }
        this.pendingRpc.delete(correlationId)
        // Update active correlations metric
        coreMetrics.gauge('rpc_active_correlations', this.pendingRpc.size)
      }

      const timeout = setTimeout(() => {
        cleanup()
        coreMetrics.inc('rpcTimeouts')
        reject(new Error('RPC timeout'))
      }, timeoutMs)

      this.pendingRpc.set(correlationId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        cleanup // Store cleanup function for use in processQueue
      })

      // Subscribe for reply - capture subscription ID for cleanup
      replySubId = this.subscribe<TResponse>(replyTopic, (msg) => {
        if (msg.correlationId !== correlationId) return
        const pending = this.pendingRpc.get(correlationId)
        if (pending) {
          clearTimeout(pending.timeout)
          pending.resolve(msg.payload as TResponse)
        }
        cleanup()
      })

      this.publish(topic, payload, { correlationId, replyTo: replyTopic })
    })
  }

  /**
   * Create an RPC handler for responding to requests
   */
  createRpcHandler<TRequest = unknown, TResponse = unknown>(
    topic: string,
    handler: (payload: TRequest) => Promise<TResponse> | TResponse,
    plugin?: string
  ): string {
    return this.subscribe<TRequest>(topic, async (msg) => {
      if (!msg.replyTo || !msg.correlationId) return
      try {
        const result = await handler(msg.payload)
        await this.publish(msg.replyTo, result, { correlationId: msg.correlationId })
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'RPC_ERROR'
        await this.publish(msg.replyTo, { error: errorMessage }, { correlationId: msg.correlationId })
      }
    }, plugin)
  }

  /**
   * Get statistics about the message bus
   */
  getStats(): {
    exactSubscriptions: number
    patternSubscriptions: number
    queueLength: number
    pendingRpcCount: number
    usePatternTrie: boolean
    patternManagerStats?: ReturnType<PatternManager['getStats']>
  } {
    const exactCount = Array.from(this.subs.values()).reduce((sum, arr) => sum + arr.length, 0)

    let patternCount = 0
    let patternManagerStats: ReturnType<PatternManager['getStats']> | undefined

    if (this.usePatternTrie && this.patternManager) {
      patternManagerStats = this.patternManager.getStats()
      patternCount = patternManagerStats.trie.totalSubscriptions
    } else {
      patternCount = this.legacyPatternSubs.length
    }

    return {
      exactSubscriptions: exactCount,
      patternSubscriptions: patternCount,
      queueLength: this.queue.length,
      pendingRpcCount: this.pendingRpc.size,
      usePatternTrie: this.usePatternTrie,
      patternManagerStats
    }
  }

  /**
   * Shutdown the message bus
   */
  async shutdown(): Promise<void> {
    if (this.patternManager) {
      await this.patternManager.shutdown()
    }

    // Clear pending RPCs - Sprint 6 Day 3: ensure cleanup is called
    for (const [_id, pending] of this.pendingRpc) {
      clearTimeout(pending.timeout)
      pending.cleanup?.()
      pending.reject(new Error('MessageBus shutdown'))
    }
    this.pendingRpc.clear()

    // Clear queue
    this.queue = []

    logger.info('MessageBus shutdown complete')
  }
}

// Export singleton instance with default configuration
export const messageBus = new MessageBus()

// Export class for custom instantiation
export { MessageBus }
export type { MessageBusConfig, InternalMessage, Handler, PublishOptions }
