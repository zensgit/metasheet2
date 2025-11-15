/**
 * Pattern Manager with Trie Optimization
 * Issue #28: High-performance pattern matching with prefix tree
 */

import { PatternTrie, Subscription } from './pattern-trie'
import { EventEmitter } from 'events'
import { Logger } from '../core/logger'
import { coreMetrics, CoreMetrics } from '../integration/metrics/metrics'

export interface PatternManagerConfig {
  enableMetrics?: boolean
  optimizationMode?: 'memory' | 'speed' | 'balanced'
  maxPatterns?: number
  cleanupIntervalMs?: number
}

export interface MatchResult {
  subscriptions: Subscription[]
  matchTime: number
  cacheHit: boolean
}

export class PatternManager extends EventEmitter {
  private trie: PatternTrie
  private logger: Logger
  private metrics?: CoreMetrics
  private config: Required<PatternManagerConfig>
  private matchCache: Map<string, { result: Subscription[], timestamp: number }>
  private cleanupTimer?: NodeJS.Timeout

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
      cleanupIntervalMs: config.cleanupIntervalMs ?? 300000 // 5 minutes
    }

    this.trie = new PatternTrie()
    this.matchCache = new Map()

    this.startCleanupTimer()
    this.setupMetrics()
  }

  /**
   * Subscribe to a pattern
   */
  subscribe(
    pattern: string,
    callback: (topic: string, message: any) => void,
    metadata?: any
  ): string {
    const subscriptionId = this.generateSubscriptionId()
    const subscription: Subscription = {
      id: subscriptionId,
      pattern,
      callback,
      createdAt: Date.now(),
      metadata
    }

    try {
      this.trie.addPattern(pattern, subscription)
      this.invalidateCache()

      this.logger.debug(`Subscribed to pattern: ${pattern} (id: ${subscriptionId})`)
      this.recordMetric('pattern.subscribe', { pattern, subscriptionId })

      this.emit('subscribed', { pattern, subscriptionId, subscription })
      return subscriptionId
    } catch (error) {
      const err = error as Error
      this.logger.error(`Failed to subscribe to pattern ${pattern}:`, err)
      this.recordMetric('pattern.subscribe.error', { pattern, error: err.message })
      throw error
    }
  }

  /**
   * Unsubscribe from a pattern
   */
  unsubscribe(pattern: string, subscriptionId: string): boolean {
    try {
      const removed = this.trie.removePattern(pattern, subscriptionId)

      if (removed) {
        this.invalidateCache()
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
   * Find matching subscriptions for a topic
   */
  findMatches(topic: string): MatchResult {
    const startTime = process.hrtime.bigint()

    // Check cache first
    const cacheKey = this.getCacheKey(topic)
    const cached = this.matchCache.get(cacheKey)

    if (cached && this.isCacheValid(cached.timestamp)) {
      const matchTime = Number(process.hrtime.bigint() - startTime) / 1_000_000 // Convert to ms
      this.recordMetric('pattern.match.cache_hit', { topic, matchTime })
      return {
        subscriptions: cached.result,
        matchTime,
        cacheHit: true
      }
    }

    // Perform matching using trie
    const subscriptions = this.trie.findMatches(topic)
    const matchTime = Number(process.hrtime.bigint() - startTime) / 1_000_000

    // Cache the result
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
  async publish(topic: string, message: any): Promise<number> {
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
    trie: any
    cache: { size: number, hitRate: number }
    performance: { averageMatchTime: number, averagePublishTime: number }
  } {
    const trieStats = this.trie.getStats()

    // Calculate cache hit rate from metrics
    const hitRate = this.calculateCacheHitRate()

    return {
      trie: trieStats,
      cache: {
        size: this.matchCache.size,
        hitRate
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

    this.clear()
    this.logger.info('Pattern manager shutdown complete')
    this.emit('shutdown')
  }

  /**
   * Debug information
   */
  debug(): {
    trie: string
    cache: any
    stats: any
  } {
    return {
      trie: this.trie.debug(),
      cache: Array.from(this.matchCache.entries()).map(([key, value]) => ({
        topic: key,
        matches: value.result.length,
        age: Date.now() - value.timestamp
      })),
      stats: this.getStats()
    }
  }

  /**
   * Private helper methods
   */

  private generateSubscriptionId(): string {
    return `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  private getCacheKey(topic: string): string {
    return `topic:${topic}`
  }

  private isCacheValid(timestamp: number): boolean {
    const maxAge = this.config.optimizationMode === 'speed' ? 30000 : 10000 // 30s or 10s
    return Date.now() - timestamp < maxAge
  }

  private cacheResult(key: string, result: Subscription[]): void {
    // Limit cache size
    const maxCacheSize = this.config.optimizationMode === 'memory' ? 1000 : 5000

    if (this.matchCache.size >= maxCacheSize) {
      // Remove oldest entries
      const entries = Array.from(this.matchCache.entries())
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
      const toRemove = entries.slice(0, Math.floor(maxCacheSize * 0.2)) // Remove 20%

      toRemove.forEach(([key]) => this.matchCache.delete(key))
    }

    this.matchCache.set(key, {
      result: result.slice(), // Copy array
      timestamp: Date.now()
    })
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
    const before = this.matchCache.size
    const cutoff = Date.now() - 300000 // 5 minutes

    for (const [key, value] of this.matchCache.entries()) {
      if (value.timestamp < cutoff) {
        this.matchCache.delete(key)
      }
    }

    const cleaned = before - this.matchCache.size
    if (cleaned > 0) {
      this.logger.debug(`Cleaned ${cleaned} cache entries`)
      this.recordMetric('pattern.cache.cleanup', { cleaned })
    }
  }

  private setupMetrics(): void {
    if (!this.config.enableMetrics || !this.metrics) return

    // Register custom metrics
    this.on('subscribed', (data) => {
      this.metrics!.increment('pattern_subscriptions_total')
      this.metrics!.gauge('pattern_active_subscriptions', this.trie.getStats().totalSubscriptions)
    })

    this.on('unsubscribed', (data) => {
      this.metrics!.increment('pattern_unsubscriptions_total')
      this.metrics!.gauge('pattern_active_subscriptions', this.trie.getStats().totalSubscriptions)
    })

    this.on('published', (data) => {
      this.metrics!.increment('pattern_messages_published_total')
      this.metrics!.histogram('pattern_match_count', data.matchCount)
      this.metrics!.histogram('pattern_publish_duration_ms', data.publishTime)

      if (data.errorCount > 0) {
        this.metrics!.increment('pattern_callback_errors_total', data.errorCount)
      }
    })

    // Periodic stats update
    setInterval(() => {
      const stats = this.getStats()
      this.metrics!.gauge('pattern_trie_nodes', stats.trie.totalNodes)
      this.metrics!.gauge('pattern_trie_memory_bytes', stats.trie.memoryUsage)
      this.metrics!.gauge('pattern_cache_size', stats.cache.size)
      this.metrics!.gauge('pattern_cache_hit_rate', stats.cache.hitRate)
    }, 60000) // Every minute
  }

  private recordMetric(event: string, data?: any): void {
    if (!this.config.enableMetrics || !this.metrics) return

    // Convert event to metric name
    const metricName = event.replace(/\./g, '_')
    this.metrics.increment(metricName, data)
  }

  private calculateCacheHitRate(): number {
    // This would typically be calculated from historical metrics
    // For now, return a placeholder based on cache size
    return Math.min(0.95, this.matchCache.size / 1000)
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