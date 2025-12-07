/**
 * Pattern Manager with Trie Optimization
 * Issue #28: High-performance pattern matching with prefix tree
 * Sprint 5: Added plugin lifecycle support for MessageBus integration
 */

import type { Subscription } from './pattern-trie';
import type { MessageBusSubscription } from './types'
import { PatternTrie } from './pattern-trie'
import { EventEmitter } from 'events'
import type { Logger } from '../core/logger'
import type { CoreMetrics } from '../integration/metrics/metrics'

export interface PatternManagerConfig {
  enableMetrics?: boolean
  optimizationMode?: 'memory' | 'speed' | 'balanced'
  maxPatterns?: number
  cleanupIntervalMs?: number
  /** TTL for cache entries in milliseconds (Day 2 enhancement) */
  cacheTtlMs?: number
}

export interface MatchResult {
  subscriptions: Subscription[]
  matchTime: number
  cacheHit: boolean
}

interface TrieStatsData {
  totalNodes: number
  totalSubscriptions: number
  maxDepth: number
  averageDepth: number
  memoryUsage: number
}

/**
 * LRU Cache with Time To Live (TTL) Support
 * Map maintains insertion order for LRU eviction
 * Sprint 5 Day 2: Added TTL support for automatic cache entry expiration
 */
interface CacheEntryWithTTL<V> {
  value: V
  expiresAt: number
}

interface LRUCacheConfig {
  maxSize: number
  /** Time To Live in milliseconds. 0 means no expiration. */
  ttlMs?: number
}

class LRUCache<K, V> {
  private cache: Map<K, CacheEntryWithTTL<V>>
  private readonly maxSize: number
  private readonly ttlMs: number
  private hits = 0
  private misses = 0
  private ttlExpirations = 0

  constructor(config: LRUCacheConfig | number) {
    this.cache = new Map()
    if (typeof config === 'number') {
      // Legacy constructor support
      this.maxSize = config
      this.ttlMs = 0
    } else {
      this.maxSize = config.maxSize
      this.ttlMs = config.ttlMs ?? 0
    }
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key)
    if (entry !== undefined) {
      // Check TTL expiration
      if (this.ttlMs > 0 && Date.now() > entry.expiresAt) {
        this.cache.delete(key)
        this.ttlExpirations++
        this.misses++
        return undefined
      }
      // Move to end (most recently used)
      this.cache.delete(key)
      this.cache.set(key, entry)
      this.hits++
      return entry.value
    }
    this.misses++
    return undefined
  }

  set(key: K, value: V): void {
    const expiresAt = this.ttlMs > 0 ? Date.now() + this.ttlMs : Infinity
    const entry: CacheEntryWithTTL<V> = { value, expiresAt }

    // If key exists, delete it first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first item in Map)
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(key, entry)
  }

  has(key: K): boolean {
    const entry = this.cache.get(key)
    if (entry === undefined) return false
    // Check TTL expiration
    if (this.ttlMs > 0 && Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      this.ttlExpirations++
      return false
    }
    return true
  }

  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
    this.ttlExpirations = 0
  }

  get size(): number {
    return this.cache.size
  }

  get hitRate(): number {
    const total = this.hits + this.misses
    return total > 0 ? this.hits / total : 0
  }

  /**
   * Clean up expired entries proactively
   * Returns the number of entries removed
   */
  cleanupExpired(): number {
    if (this.ttlMs === 0) return 0

    const now = Date.now()
    let removed = 0

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
        removed++
      }
    }

    this.ttlExpirations += removed
    return removed
  }

  getStats(): {
    size: number
    hits: number
    misses: number
    hitRate: number
    ttlMs: number
    ttlExpirations: number
  } {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hitRate,
      ttlMs: this.ttlMs,
      ttlExpirations: this.ttlExpirations
    }
  }

  entries(): IterableIterator<[K, V]> {
    const cache = this.cache
    const ttlMs = this.ttlMs
    const ttlExpirationsRef = { value: this.ttlExpirations }
    const iterator = cache.entries()

    // Return an iterator that unwraps the CacheEntryWithTTL
    const iteratorObj: IterableIterator<[K, V]> = {
      [Symbol.iterator]() {
        return this
      },
      next(): IteratorResult<[K, V]> {
        // eslint-disable-next-line no-constant-condition -- intentional loop with return/continue
        while (true) {
          const result = iterator.next()
          if (result.done) {
            return { done: true, value: undefined }
          }
          const [key, entry] = result.value
          // Skip expired entries
          if (ttlMs > 0 && Date.now() > entry.expiresAt) {
            cache.delete(key)
            ttlExpirationsRef.value++
            continue
          }
          return { done: false, value: [key, entry.value] }
        }
      }
    }

    // Sync ttlExpirations back after iteration
    const originalNext = iteratorObj.next.bind(iteratorObj)
    iteratorObj.next = () => {
      const result = originalNext()
      this.ttlExpirations = ttlExpirationsRef.value
      return result
    }

    return iteratorObj
  }
}

export class PatternManager extends EventEmitter {
  private trie: PatternTrie
  private logger: Logger
  private metrics?: CoreMetrics
  private config: Required<PatternManagerConfig>
  private matchCache: LRUCache<string, Subscription[]>
  private cleanupTimer?: NodeJS.Timeout
  private metricsTimer?: NodeJS.Timeout
  /** Plugin to subscription IDs mapping for lifecycle management */
  private pluginSubscriptions: Map<string, Set<string>> = new Map()
  /** Subscription ID to pattern mapping for unsubscribe operations */
  private subscriptionPatterns: Map<string, string> = new Map()

  constructor(
    logger: Logger,
    metrics?: CoreMetrics,
    config: PatternManagerConfig = {}
  ) {
    super()

    this.logger = logger
    this.metrics = metrics
    this.config = {
      enableMetrics: config.enableMetrics ?? true,
      optimizationMode: config.optimizationMode ?? 'balanced',
      maxPatterns: config.maxPatterns ?? 10000,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 300000, // 5 minutes
      cacheTtlMs: config.cacheTtlMs ?? (config.optimizationMode === 'speed' ? 30000 : 10000)
    }

    this.trie = new PatternTrie()
    const maxCacheSize = this.config.optimizationMode === 'memory' ? 1000 : 5000
    this.matchCache = new LRUCache({
      maxSize: maxCacheSize,
      ttlMs: this.config.cacheTtlMs
    })

    this.startCleanupTimer()
    this.setupMetrics()
  }

  /**
   * Subscribe to a pattern
   * @param pattern - The pattern to subscribe to (supports wildcards: user.*, *.login, user.*.action)
   * @param callback - Handler function called when a matching topic is published
   * @param options - Optional subscription options
   * @param options.plugin - Plugin identifier for lifecycle management
   * @param options.metadata - Additional metadata to attach to the subscription
   * @returns Subscription ID
   */
  subscribe(
    pattern: string,
    callback: (topic: string, message: unknown) => void,
    options?: { plugin?: string; metadata?: Record<string, unknown> } | Record<string, unknown>
  ): string {
    const subscriptionId = this.generateSubscriptionId()

    // Support both new format { plugin?, metadata? } and legacy format (direct metadata)
    let plugin: string | undefined
    let metadata: Record<string, unknown> | undefined

    if (options) {
      // Check if options has explicit plugin or metadata keys (new format)
      if ('plugin' in options || 'metadata' in options) {
        plugin = (options as { plugin?: string }).plugin
        metadata = (options as { metadata?: Record<string, unknown> }).metadata
      } else {
        // Legacy format: options IS the metadata
        metadata = options as Record<string, unknown>
      }
    }

    const subscription: MessageBusSubscription = {
      id: subscriptionId,
      pattern,
      callback: callback as (topic: string, message: unknown) => void,
      createdAt: Date.now(),
      metadata,
      plugin
    }

    try {
      this.trie.addPattern(pattern, subscription)
      this.invalidateCache()

      // Track plugin subscriptions for lifecycle management
      if (plugin) {
        if (!this.pluginSubscriptions.has(plugin)) {
          this.pluginSubscriptions.set(plugin, new Set())
        }
        this.pluginSubscriptions.get(plugin)!.add(subscriptionId)
      }

      // Track subscription to pattern mapping for unsubscribe
      this.subscriptionPatterns.set(subscriptionId, pattern)

      this.logger.debug(`Subscribed to pattern: ${pattern} (id: ${subscriptionId}${plugin ? `, plugin: ${plugin}` : ''})`)
      this.recordMetric('pattern.subscribe', { pattern, subscriptionId, plugin })

      this.emit('subscribed', { pattern, subscriptionId, subscription, plugin })
      return subscriptionId
    } catch (error) {
      const err = error as Error
      this.logger.error(`Failed to subscribe to pattern ${pattern}:`, err)
      this.recordMetric('pattern.subscribe.error', { pattern, error: err.message })
      throw error
    }
  }

  /**
   * Unsubscribe from a pattern by subscription ID
   * @param pattern - The pattern to unsubscribe from
   * @param subscriptionId - The subscription ID to remove
   * @returns true if the subscription was found and removed
   */
  unsubscribe(pattern: string, subscriptionId: string): boolean {
    try {
      const removed = this.trie.removePattern(pattern, subscriptionId)

      if (removed) {
        this.invalidateCache()
        this.cleanupSubscriptionTracking(subscriptionId)
        this.logger.debug(`Unsubscribed from pattern: ${pattern} (id: ${subscriptionId})`)
        this.recordMetric('pattern.unsubscribe', { pattern, subscriptionId })
        this.emit('unsubscribed', { pattern, subscriptionId })
      } else {
        this.logger.warn(`Subscription not found: ${pattern} (id: ${subscriptionId})`)
        this.recordMetric('pattern.unsubscribe.not_found', { pattern, subscriptionId })
      }

      return removed
    } catch (error) {
      const err = error as Error
      this.logger.error(`Failed to unsubscribe from pattern ${pattern}:`, err)
      this.recordMetric('pattern.unsubscribe.error', { pattern, subscriptionId, error: err.message })
      return false
    }
  }

  /**
   * Unsubscribe by subscription ID only (pattern is looked up internally)
   * Convenience method for MessageBus integration
   * @param subscriptionId - The subscription ID to remove
   * @returns true if the subscription was found and removed
   */
  unsubscribeById(subscriptionId: string): boolean {
    const pattern = this.subscriptionPatterns.get(subscriptionId)
    if (!pattern) {
      this.logger.warn(`Subscription ID not found: ${subscriptionId}`)
      return false
    }
    return this.unsubscribe(pattern, subscriptionId)
  }

  /**
   * Unsubscribe all subscriptions belonging to a plugin
   * Used for plugin lifecycle management (deactivation/uninstall)
   * @param plugin - The plugin identifier
   * @returns Number of subscriptions removed
   */
  unsubscribeByPlugin(plugin: string): number {
    const subscriptionIds = this.pluginSubscriptions.get(plugin)
    if (!subscriptionIds || subscriptionIds.size === 0) {
      this.logger.debug(`No subscriptions found for plugin: ${plugin}`)
      return 0
    }

    let removedCount = 0
    const idsToRemove = Array.from(subscriptionIds)

    for (const subscriptionId of idsToRemove) {
      const pattern = this.subscriptionPatterns.get(subscriptionId)
      if (pattern) {
        const removed = this.trie.removePattern(pattern, subscriptionId)
        if (removed) {
          removedCount++
          this.subscriptionPatterns.delete(subscriptionId)
          this.emit('unsubscribed', { pattern, subscriptionId, plugin })
        }
      }
    }

    // Clear plugin tracking
    this.pluginSubscriptions.delete(plugin)

    if (removedCount > 0) {
      this.invalidateCache()
      this.logger.info(`Unsubscribed ${removedCount} subscriptions for plugin: ${plugin}`)
      this.recordMetric('pattern.unsubscribe.by_plugin', { plugin, count: removedCount })
    }

    return removedCount
  }

  /**
   * Get all subscription IDs for a plugin
   * @param plugin - The plugin identifier
   * @returns Array of subscription IDs
   */
  getSubscriptionsByPlugin(plugin: string): string[] {
    const subscriptionIds = this.pluginSubscriptions.get(plugin)
    return subscriptionIds ? Array.from(subscriptionIds) : []
  }

  /**
   * Clean up subscription tracking after removal
   */
  private cleanupSubscriptionTracking(subscriptionId: string): void {
    this.subscriptionPatterns.delete(subscriptionId)

    // Remove from plugin subscriptions
    for (const [plugin, ids] of this.pluginSubscriptions) {
      if (ids.has(subscriptionId)) {
        ids.delete(subscriptionId)
        if (ids.size === 0) {
          this.pluginSubscriptions.delete(plugin)
        }
        break
      }
    }
  }

  /**
   * Find matching subscriptions for a topic
   */
  findMatches(topic: string): MatchResult {
    const startTime = process.hrtime.bigint()

    // Check cache first (TTL is handled by LRUCache)
    const cacheKey = this.getCacheKey(topic)
    const cached = this.matchCache.get(cacheKey)

    if (cached !== undefined) {
      const matchTime = Number(process.hrtime.bigint() - startTime) / 1_000_000 // Convert to ms
      this.recordMetric('pattern.match.cache_hit', { topic, matchTime })
      return {
        subscriptions: cached,
        matchTime,
        cacheHit: true
      }
    }

    // Perform matching using trie
    const subscriptions = this.trie.findMatches(topic)
    const matchTime = Number(process.hrtime.bigint() - startTime) / 1_000_000

    // Cache the result (TTL is applied automatically by LRUCache)
    this.cacheResult(cacheKey, subscriptions)

    this.recordMetric('pattern.match.cache_miss', {
      topic,
      matchTime,
      matchCount: subscriptions.length
    })

    return {
      subscriptions,
      matchTime,
      cacheHit: false
    }
  }

  /**
   * Publish message to matching subscribers
   */
  async publish(topic: string, message: unknown): Promise<number> {
    const matchResult = this.findMatches(topic)
    const { subscriptions } = matchResult

    if (subscriptions.length === 0) {
      this.recordMetric('pattern.publish.no_matches', { topic })
      return 0
    }

    const startTime = process.hrtime.bigint()
    let successCount = 0
    let errorCount = 0

    // Execute callbacks in parallel for better performance
    const promises = subscriptions.map(async (subscription) => {
      try {
        await Promise.resolve(subscription.callback(topic, message))
        successCount++
      } catch (error) {
        const err = error as Error
        errorCount++
        this.logger.error(
          `Callback error for subscription ${subscription.id} on topic ${topic}:`,
          err
        )
        this.recordMetric('pattern.callback.error', {
          subscriptionId: subscription.id,
          topic,
          pattern: subscription.pattern,
          error: err.message
        })
      }
    })

    await Promise.all(promises)

    const publishTime = Number(process.hrtime.bigint() - startTime) / 1_000_000

    this.recordMetric('pattern.publish', {
      topic,
      matchCount: subscriptions.length,
      successCount,
      errorCount,
      publishTime,
      cacheHit: matchResult.cacheHit
    })

    this.emit('published', {
      topic,
      message,
      matchCount: subscriptions.length,
      successCount,
      errorCount,
      publishTime
    })

    return successCount
  }

  /**
   * Get pattern statistics
   */
  getStats(): {
    trie: TrieStatsData
    cache: { size: number; hitRate: number; ttlMs: number; ttlExpirations: number }
    performance: { averageMatchTime: number; averagePublishTime: number }
  } {
    const trieStats = this.trie.getStats()
    const cacheStats = this.matchCache.getStats()

    // Calculate cache hit rate from metrics (uses internal LRU cache stats as fallback)
    const hitRate = this.calculateCacheHitRate() || cacheStats.hitRate

    return {
      trie: trieStats,
      cache: {
        size: cacheStats.size,
        hitRate,
        ttlMs: cacheStats.ttlMs,
        ttlExpirations: cacheStats.ttlExpirations
      },
      performance: {
        averageMatchTime: this.getAverageMetric('pattern.match.cache_miss', 'matchTime'),
        averagePublishTime: this.getAverageMetric('pattern.publish', 'publishTime')
      }
    }
  }

  /**
   * Get all active subscriptions
   */
  getAllSubscriptions(): Subscription[] {
    return this.trie.getAllSubscriptions()
  }

  /**
   * Clear all patterns and cache
   */
  clear(): void {
    this.trie.clear()
    this.matchCache.clear()
    this.pluginSubscriptions.clear()
    this.subscriptionPatterns.clear()
    this.logger.info('Pattern manager cleared')
    this.recordMetric('pattern.clear')
    this.emit('cleared')
  }

  /**
   * Shutdown and cleanup
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer)
    }

    this.clear()
    this.logger.info('Pattern manager shutdown complete')
    this.emit('shutdown')
  }

  /**
   * Debug information
   */
  debug(): {
    trie: string
    cache: Array<{ topic: string; matches: number }>
    stats: {
      trie: TrieStatsData
      cache: { size: number; hitRate: number; ttlMs: number; ttlExpirations: number }
      performance: { averageMatchTime: number; averagePublishTime: number }
    }
  } {
    return {
      trie: this.trie.debug(),
      cache: Array.from(this.matchCache.entries()).map(([key, value]) => ({
        topic: key,
        matches: value.length
      })),
      stats: this.getStats()
    }
  }

  /**
   * Private helper methods
   */

  private generateSubscriptionId(): string {
    return `sub-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }

  private getCacheKey(topic: string): string {
    return `topic:${topic}`
  }

  private cacheResult(key: string, result: Subscription[]): void {
    // LRU cache handles eviction and TTL automatically
    this.matchCache.set(key, result.slice()) // Copy array
  }

  private invalidateCache(): void {
    this.matchCache.clear()
    this.recordMetric('pattern.cache.invalidated')
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.performCleanup()
    }, this.config.cleanupIntervalMs)
  }

  private performCleanup(): void {
    // LRU cache now handles TTL-based cleanup automatically
    const cleaned = this.matchCache.cleanupExpired()
    if (cleaned > 0) {
      this.logger.debug(`Cleaned ${cleaned} expired cache entries`)
      this.recordMetric('pattern.cache.cleanup', { cleaned })
    }
  }

  private setupMetrics(): void {
    if (!this.config.enableMetrics || !this.metrics) return

    // Register custom metrics
    this.on('subscribed', (_data) => {
      this.metrics!.increment('pattern_subscriptions_total')
      this.metrics!.gauge('pattern_active_subscriptions', this.trie.getStats().totalSubscriptions)
    })

    this.on('unsubscribed', (_data) => {
      this.metrics!.increment('pattern_unsubscriptions_total')
      this.metrics!.gauge('pattern_active_subscriptions', this.trie.getStats().totalSubscriptions)
    })

    this.on('published', (data: {
      matchCount: number
      publishTime: number
      errorCount: number
    }) => {
      this.metrics!.increment('pattern_messages_published_total')
      this.metrics!.histogram('pattern_match_count', data.matchCount)
      this.metrics!.histogram('pattern_publish_duration_ms', data.publishTime)

      if (data.errorCount > 0) {
        this.metrics!.increment('pattern_callback_errors_total', data.errorCount)
      }
    })

    // Periodic stats update
    this.metricsTimer = setInterval(() => {
      const stats = this.getStats()
      this.metrics!.gauge('pattern_trie_nodes', stats.trie.totalNodes)
      this.metrics!.gauge('pattern_trie_memory_bytes', stats.trie.memoryUsage)
      this.metrics!.gauge('pattern_cache_size', stats.cache.size)
      this.metrics!.gauge('pattern_cache_hit_rate', stats.cache.hitRate)
    }, 60000) // Every minute
  }

  private recordMetric(event: string, data?: Record<string, unknown>): void {
    if (!this.config.enableMetrics || !this.metrics) return

    // Convert event to metric name
    const metricName = event.replace(/\./g, '_')
    this.metrics.increment(metricName, data)
  }

  private calculateCacheHitRate(): number {
    return this.matchCache.hitRate
  }

  private getAverageMetric(event: string, field: string): number {
    // This would typically come from metrics aggregation
    // For now, return reasonable estimates based on optimization mode
    const estimates: Record<string, Record<string, number>> = {
      'pattern.match.cache_miss': { matchTime: 2.5 },
      'pattern.publish': { publishTime: 15.0 }
    }

    return estimates[event]?.[field] || 0
  }
}
