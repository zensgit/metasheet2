/**
 * Health Aggregator Service
 * Sprint 7 Day 4: System-wide health monitoring and aggregation
 *
 * Collects health status from all subsystems:
 * - Database shards (connection pool)
 * - MessageBus queues
 * - Plugin health
 * - Rate limiting
 * - Memory/CPU usage
 *
 * Provides:
 * - Detailed health report via GET /health/detailed
 * - Alert triggering when health degrades
 */

import { EventEmitter } from 'events'
import { Logger } from '../core/logger'
import { poolManager } from '../integration/db/connection-pool'
import { messageBus } from '../integration/messaging/message-bus'
import { pluginHealthService, type PluginHealth } from './PluginHealthService'
import { getRateLimiter } from '../integration/rate-limiting'
import { DeadLetterQueueService } from './DeadLetterQueueService'
import { coreMetrics } from '../integration/metrics/metrics'

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

export interface SubsystemHealth {
  name: string
  status: HealthStatus
  message?: string
  details?: Record<string, unknown>
  lastCheck: string
}

export interface DatabaseHealth extends SubsystemHealth {
  details: {
    shards: Array<{
      name: string
      status: 'healthy' | 'unhealthy'
      totalConnections: number
      idleConnections: number
      activeConnections: number
      waitingClients: number
      error?: string
    }>
    totalShards: number
    healthyShards: number
    unhealthyShards: number
  }
}

export interface MessageBusHealth extends SubsystemHealth {
  details: {
    exactSubscriptions: number
    patternSubscriptions: number
    queueLength: number
    pendingRpcCount: number
    dlq: {
      pending: number
      retrying: number
      resolved: number
      total: number
    }
  }
}

export interface PluginSystemHealth extends SubsystemHealth {
  details: {
    plugins: PluginHealth[]
    totalPlugins: number
    activePlugins: number
    errorPlugins: number
    degradedPlugins: number
  }
}

export interface RateLimitingHealth extends SubsystemHealth {
  details: {
    activeBuckets: number
    totalAccepted: number
    totalRejected: number
    rejectionRate: number
    averageTokensRemaining: number
  }
}

export interface SystemResourceHealth extends SubsystemHealth {
  details: {
    memory: {
      heapUsed: number
      heapTotal: number
      external: number
      rss: number
      usagePercent: number
    }
    uptime: number
    nodeVersion: string
    platform: string
  }
}

export interface AggregatedHealth {
  status: HealthStatus
  timestamp: string
  uptime: number
  subsystems: {
    database: DatabaseHealth
    messageBus: MessageBusHealth
    plugins: PluginSystemHealth
    rateLimiting: RateLimitingHealth
    system: SystemResourceHealth
  }
  summary: {
    totalSubsystems: number
    healthySubsystems: number
    degradedSubsystems: number
    unhealthySubsystems: number
    overallHealthPercent: number
  }
  warnings: string[]
  errors: string[]
}

export interface HealthAggregatorConfig {
  /** Check interval in ms (default: 30000) */
  checkIntervalMs?: number
  /** Memory usage threshold for degraded status (default: 0.8 = 80%) */
  memoryThresholdDegraded?: number
  /** Memory usage threshold for unhealthy status (default: 0.95 = 95%) */
  memoryThresholdUnhealthy?: number
  /** DLQ pending threshold for warning (default: 100) */
  dlqPendingThreshold?: number
  /** Rate limit rejection threshold for warning (default: 0.1 = 10%) */
  rejectionRateThreshold?: number
  /** Enable automatic health checks (default: true) */
  enableAutoCheck?: boolean
  /** Enable alert publishing (default: true) */
  enableAlerts?: boolean
}

export class HealthAggregatorService extends EventEmitter {
  private readonly logger = new Logger('HealthAggregatorService')
  private readonly config: Required<HealthAggregatorConfig>
  private checkTimer: NodeJS.Timeout | null = null
  private lastHealth: AggregatedHealth | null = null
  private startTime: number = Date.now()
  private dlqService: DeadLetterQueueService | null = null

  constructor(config: HealthAggregatorConfig = {}) {
    super()
    this.config = {
      checkIntervalMs: config.checkIntervalMs ?? 30000,
      memoryThresholdDegraded: config.memoryThresholdDegraded ?? 0.8,
      memoryThresholdUnhealthy: config.memoryThresholdUnhealthy ?? 0.95,
      dlqPendingThreshold: config.dlqPendingThreshold ?? 100,
      rejectionRateThreshold: config.rejectionRateThreshold ?? 0.1,
      enableAutoCheck: config.enableAutoCheck ?? true,
      enableAlerts: config.enableAlerts ?? true
    }
  }

  /**
   * Start health monitoring
   */
  start(dlqService?: DeadLetterQueueService): void {
    this.dlqService = dlqService ?? null
    this.startTime = Date.now()

    if (this.config.enableAutoCheck) {
      this.checkTimer = setInterval(async () => {
        try {
          await this.checkHealth()
        } catch (error) {
          this.logger.error('Health check failed', error instanceof Error ? error : undefined)
        }
      }, this.config.checkIntervalMs)

      // Don't prevent process from exiting
      if (this.checkTimer.unref) {
        this.checkTimer.unref()
      }
    }

    this.logger.info('HealthAggregatorService started', {
      checkIntervalMs: this.config.checkIntervalMs,
      autoCheckEnabled: this.config.enableAutoCheck
    })

    coreMetrics.increment('health_aggregator_started')
  }

  /**
   * Stop health monitoring
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }

    this.logger.info('HealthAggregatorService stopped')
    coreMetrics.increment('health_aggregator_stopped')
  }

  /**
   * Perform a health check and return aggregated results
   */
  async checkHealth(): Promise<AggregatedHealth> {
    const timestamp = new Date().toISOString()
    const warnings: string[] = []
    const errors: string[] = []

    // Collect health from all subsystems in parallel
    const [
      databaseHealth,
      messageBusHealth,
      pluginHealth,
      rateLimitingHealth,
      systemHealth
    ] = await Promise.all([
      this.checkDatabaseHealth(),
      this.checkMessageBusHealth(),
      this.checkPluginHealth(),
      this.checkRateLimitingHealth(),
      this.checkSystemHealth()
    ])

    // Collect warnings and errors
    const subsystems = [databaseHealth, messageBusHealth, pluginHealth, rateLimitingHealth, systemHealth]

    for (const subsystem of subsystems) {
      if (subsystem.status === 'degraded' && subsystem.message) {
        warnings.push(`${subsystem.name}: ${subsystem.message}`)
      }
      if (subsystem.status === 'unhealthy' && subsystem.message) {
        errors.push(`${subsystem.name}: ${subsystem.message}`)
      }
    }

    // Calculate summary
    const healthyCount = subsystems.filter(s => s.status === 'healthy').length
    const degradedCount = subsystems.filter(s => s.status === 'degraded').length
    const unhealthyCount = subsystems.filter(s => s.status === 'unhealthy').length
    const totalCount = subsystems.length

    // Determine overall status
    let overallStatus: HealthStatus = 'healthy'
    if (unhealthyCount > 0) {
      overallStatus = 'unhealthy'
    } else if (degradedCount > 0) {
      overallStatus = 'degraded'
    }

    const overallHealthPercent = totalCount > 0
      ? Math.round((healthyCount / totalCount) * 100)
      : 100

    const health: AggregatedHealth = {
      status: overallStatus,
      timestamp,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      subsystems: {
        database: databaseHealth,
        messageBus: messageBusHealth,
        plugins: pluginHealth,
        rateLimiting: rateLimitingHealth,
        system: systemHealth
      },
      summary: {
        totalSubsystems: totalCount,
        healthySubsystems: healthyCount,
        degradedSubsystems: degradedCount,
        unhealthySubsystems: unhealthyCount,
        overallHealthPercent
      },
      warnings,
      errors
    }

    // Check for status change and emit alerts
    if (this.lastHealth && this.config.enableAlerts) {
      if (this.lastHealth.status !== health.status) {
        await this.emitHealthAlert(health)
      }
    }

    this.lastHealth = health

    // Update metrics
    coreMetrics.gauge('health_overall_percent', overallHealthPercent)
    coreMetrics.gauge('health_subsystems_healthy', healthyCount)
    coreMetrics.gauge('health_subsystems_degraded', degradedCount)
    coreMetrics.gauge('health_subsystems_unhealthy', unhealthyCount)

    this.emit('healthCheck', health)
    return health
  }

  /**
   * Get the last cached health check result
   */
  getLastHealth(): AggregatedHealth | null {
    return this.lastHealth
  }

  /**
   * Check database shard health
   */
  private async checkDatabaseHealth(): Promise<DatabaseHealth> {
    const lastCheck = new Date().toISOString()

    try {
      const poolStats = await poolManager.getPoolStats()

      const shards = poolStats.map(stat => ({
        name: stat.name,
        status: stat.status,
        totalConnections: stat.totalConnections,
        idleConnections: stat.idleConnections,
        activeConnections: stat.totalConnections - stat.idleConnections,
        waitingClients: stat.waitingClients,
        error: stat.error
      }))

      const healthyShards = shards.filter(s => s.status === 'healthy').length
      const unhealthyShards = shards.filter(s => s.status === 'unhealthy').length
      const totalShards = shards.length

      let status: HealthStatus = 'healthy'
      let message: string | undefined

      if (unhealthyShards > 0) {
        if (unhealthyShards === totalShards) {
          status = 'unhealthy'
          message = 'All database shards are unhealthy'
        } else {
          status = 'degraded'
          message = `${unhealthyShards}/${totalShards} database shards are unhealthy`
        }
      }

      return {
        name: 'database',
        status,
        message,
        lastCheck,
        details: {
          shards,
          totalShards,
          healthyShards,
          unhealthyShards
        }
      }
    } catch (error) {
      return {
        name: 'database',
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Failed to check database health',
        lastCheck,
        details: {
          shards: [],
          totalShards: 0,
          healthyShards: 0,
          unhealthyShards: 0
        }
      }
    }
  }

  /**
   * Check MessageBus health
   */
  private async checkMessageBusHealth(): Promise<MessageBusHealth> {
    const lastCheck = new Date().toISOString()

    try {
      const stats = messageBus.getStats()

      // Get DLQ stats if available
      let dlqStats = { pending: 0, retrying: 0, resolved: 0, total: 0 }
      if (this.dlqService) {
        // Use list method to get counts for each status
        const [pendingResult, retryingResult, resolvedResult] = await Promise.all([
          this.dlqService.list({ status: 'pending', limit: 1 }),
          this.dlqService.list({ status: 'retrying', limit: 1 }),
          this.dlqService.list({ status: 'resolved', limit: 1 })
        ])
        dlqStats = {
          pending: pendingResult.total,
          retrying: retryingResult.total,
          resolved: resolvedResult.total,
          total: pendingResult.total + retryingResult.total + resolvedResult.total
        }
      }

      let status: HealthStatus = 'healthy'
      let message: string | undefined

      // Check for high queue length
      if (stats.queueLength > 1000) {
        status = 'degraded'
        message = `High message queue length: ${stats.queueLength}`
      }

      // Check for high DLQ pending count
      if (dlqStats.pending > this.config.dlqPendingThreshold) {
        status = status === 'degraded' ? 'degraded' : 'degraded'
        message = message
          ? `${message}; High DLQ pending count: ${dlqStats.pending}`
          : `High DLQ pending count: ${dlqStats.pending}`
      }

      return {
        name: 'messageBus',
        status,
        message,
        lastCheck,
        details: {
          exactSubscriptions: stats.exactSubscriptions,
          patternSubscriptions: stats.patternSubscriptions,
          queueLength: stats.queueLength,
          pendingRpcCount: stats.pendingRpcCount,
          dlq: dlqStats
        }
      }
    } catch (error) {
      return {
        name: 'messageBus',
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Failed to check MessageBus health',
        lastCheck,
        details: {
          exactSubscriptions: 0,
          patternSubscriptions: 0,
          queueLength: 0,
          pendingRpcCount: 0,
          dlq: { pending: 0, retrying: 0, resolved: 0, total: 0 }
        }
      }
    }
  }

  /**
   * Check plugin system health
   */
  private async checkPluginHealth(): Promise<PluginSystemHealth> {
    const lastCheck = new Date().toISOString()

    try {
      const plugins = pluginHealthService.getAllPluginHealth()

      const totalPlugins = plugins.length
      const activePlugins = plugins.filter(p => p.status === 'active').length
      const errorPlugins = plugins.filter(p => p.status === 'error').length
      const degradedPlugins = plugins.filter(p => p.status === 'degraded').length

      let status: HealthStatus = 'healthy'
      let message: string | undefined

      if (errorPlugins > 0) {
        status = 'degraded'
        message = `${errorPlugins} plugin(s) in error state`
      }

      if (degradedPlugins > 0) {
        status = 'degraded'
        message = message
          ? `${message}; ${degradedPlugins} plugin(s) degraded`
          : `${degradedPlugins} plugin(s) degraded`
      }

      return {
        name: 'plugins',
        status,
        message,
        lastCheck,
        details: {
          plugins,
          totalPlugins,
          activePlugins,
          errorPlugins,
          degradedPlugins
        }
      }
    } catch (error) {
      return {
        name: 'plugins',
        status: 'unknown',
        message: error instanceof Error ? error.message : 'Failed to check plugin health',
        lastCheck,
        details: {
          plugins: [],
          totalPlugins: 0,
          activePlugins: 0,
          errorPlugins: 0,
          degradedPlugins: 0
        }
      }
    }
  }

  /**
   * Check rate limiting health
   */
  private async checkRateLimitingHealth(): Promise<RateLimitingHealth> {
    const lastCheck = new Date().toISOString()

    try {
      const rateLimiter = getRateLimiter()
      const stats = rateLimiter.getGlobalStats()

      const totalRequests = stats.totalAccepted + stats.totalRejected
      const rejectionRate = totalRequests > 0
        ? stats.totalRejected / totalRequests
        : 0

      let status: HealthStatus = 'healthy'
      let message: string | undefined

      if (rejectionRate > this.config.rejectionRateThreshold) {
        status = 'degraded'
        message = `High rejection rate: ${(rejectionRate * 100).toFixed(2)}%`
      }

      return {
        name: 'rateLimiting',
        status,
        message,
        lastCheck,
        details: {
          activeBuckets: stats.activeBuckets,
          totalAccepted: stats.totalAccepted,
          totalRejected: stats.totalRejected,
          rejectionRate: Math.round(rejectionRate * 10000) / 100, // percentage with 2 decimals
          averageTokensRemaining: stats.averageTokensRemaining
        }
      }
    } catch (error) {
      return {
        name: 'rateLimiting',
        status: 'unknown',
        message: error instanceof Error ? error.message : 'Failed to check rate limiting health',
        lastCheck,
        details: {
          activeBuckets: 0,
          totalAccepted: 0,
          totalRejected: 0,
          rejectionRate: 0,
          averageTokensRemaining: 0
        }
      }
    }
  }

  /**
   * Check system resource health (memory, CPU)
   */
  private async checkSystemHealth(): Promise<SystemResourceHealth> {
    const lastCheck = new Date().toISOString()

    try {
      const memUsage = process.memoryUsage()
      const usagePercent = memUsage.heapUsed / memUsage.heapTotal

      let status: HealthStatus = 'healthy'
      let message: string | undefined

      if (usagePercent > this.config.memoryThresholdUnhealthy) {
        status = 'unhealthy'
        message = `Critical memory usage: ${(usagePercent * 100).toFixed(1)}%`
      } else if (usagePercent > this.config.memoryThresholdDegraded) {
        status = 'degraded'
        message = `High memory usage: ${(usagePercent * 100).toFixed(1)}%`
      }

      return {
        name: 'system',
        status,
        message,
        lastCheck,
        details: {
          memory: {
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external,
            rss: memUsage.rss,
            usagePercent: Math.round(usagePercent * 10000) / 100
          },
          uptime: process.uptime(),
          nodeVersion: process.version,
          platform: process.platform
        }
      }
    } catch (error) {
      return {
        name: 'system',
        status: 'unknown',
        message: error instanceof Error ? error.message : 'Failed to check system health',
        lastCheck,
        details: {
          memory: {
            heapUsed: 0,
            heapTotal: 0,
            external: 0,
            rss: 0,
            usagePercent: 0
          },
          uptime: 0,
          nodeVersion: process.version,
          platform: process.platform
        }
      }
    }
  }

  /**
   * Emit health alert via MessageBus
   */
  private async emitHealthAlert(health: AggregatedHealth): Promise<void> {
    try {
      const alertTopic = `system.alert.health.${health.status}`

      await messageBus.publish(alertTopic, {
        type: 'health_status_change',
        timestamp: health.timestamp,
        previousStatus: this.lastHealth?.status || 'unknown',
        currentStatus: health.status,
        overallHealthPercent: health.summary.overallHealthPercent,
        warnings: health.warnings,
        errors: health.errors,
        subsystems: Object.entries(health.subsystems).map(([name, sub]) => ({
          name,
          status: sub.status,
          message: sub.message
        }))
      })

      this.logger.warn('Health status changed', {
        previousStatus: this.lastHealth?.status,
        currentStatus: health.status,
        overallHealthPercent: health.summary.overallHealthPercent
      })

      coreMetrics.increment('health_alerts_emitted', { status: health.status })
    } catch (error) {
      this.logger.error('Failed to emit health alert', error instanceof Error ? error : undefined)
    }
  }
}

// Singleton instance
let healthAggregatorInstance: HealthAggregatorService | null = null

export function getHealthAggregator(config?: HealthAggregatorConfig): HealthAggregatorService {
  if (!healthAggregatorInstance) {
    healthAggregatorInstance = new HealthAggregatorService(config)
  }
  return healthAggregatorInstance
}

export function resetHealthAggregator(): void {
  if (healthAggregatorInstance) {
    healthAggregatorInstance.stop()
    healthAggregatorInstance = null
  }
}
