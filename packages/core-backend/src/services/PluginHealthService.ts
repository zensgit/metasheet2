/**
 * Plugin Health Service
 * Sprint 2: Plugin Health Monitoring
 *
 * Tracks plugin status, errors, and health metrics.
 */

import { eventBus } from '../integration/events/event-bus'
import { Logger } from '../core/logger'
import { metrics } from '../metrics/metrics'

export interface PluginHealth {
  pluginName: string
  status: 'active' | 'inactive' | 'error' | 'degraded'
  uptime: number // seconds
  activatedAt?: Date
  lastHeartbeat?: Date
  errorCount: number
  lastError?: {
    message: string
    timestamp: Date
  }
  metadata?: Record<string, unknown>
}

export class PluginHealthService {
  private logger: Logger
  private healthMap: Map<string, PluginHealth> = new Map()
  private startTime: number

  constructor() {
    this.logger = new Logger('PluginHealthService')
    this.startTime = Date.now()
    this.initializeListeners()
  }

  private initializeListeners() {
    // Listen for plugin activation
    eventBus.subscribe('plugin:activated', (payload: { pluginName: string }) => {
      this.updateStatus(payload.pluginName, 'active')
    })

    // Listen for plugin deactivation
    eventBus.subscribe('plugin:deactivated', (payload: { pluginName: string }) => {
      this.updateStatus(payload.pluginName, 'inactive')
    })

    // Listen for plugin errors
    eventBus.subscribe('plugin:error', (payload: { pluginName: string; error: string }) => {
      this.recordError(payload.pluginName, payload.error)
    })

    // Listen for plugin heartbeats (optional, if plugins emit this)
    eventBus.subscribe('plugin:heartbeat', (payload: { pluginName: string; data?: Record<string, unknown> }) => {
      this.recordHeartbeat(payload.pluginName, payload.data)
    })
  }

  /**
   * Update plugin status
   */
  updateStatus(pluginName: string, status: PluginHealth['status']) {
    const health = this.getOrCreateHealth(pluginName)
    health.status = status
    
    if (status === 'active') {
      health.activatedAt = new Date()
    }

    this.healthMap.set(pluginName, health)
    this.logger.info(`Plugin ${pluginName} status updated to ${status}`)
    
    // Update metrics
    try {
      // Reset other statuses to 0
      ['active', 'inactive', 'error', 'degraded'].forEach(s => {
        if (s !== status) {
          metrics.pluginStatus.labels(pluginName, s).set(0)
        }
      })
      metrics.pluginStatus.labels(pluginName, status).set(1)
    } catch { /* ignore */ }
  }

  /**
   * Record a plugin error
   */
  recordError(pluginName: string, error: string | Error) {
    const health = this.getOrCreateHealth(pluginName)
    health.errorCount++
    health.lastError = {
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date()
    }
    
    // If error count is high, mark as degraded
    if (health.errorCount > 5 && health.status === 'active') {
      health.status = 'degraded'
    }

    this.healthMap.set(pluginName, health)
    this.logger.warn(`Plugin ${pluginName} error recorded: ${health.lastError.message}`)
  }

  /**
   * Record a heartbeat
   */
  recordHeartbeat(pluginName: string, data?: Record<string, unknown>) {
    const health = this.getOrCreateHealth(pluginName)
    health.lastHeartbeat = new Date()
    if (data) {
      health.metadata = { ...health.metadata, ...data }
    }
    
    // If it was degraded but sending heartbeats, maybe recover?
    // For now, keep simple.
    
    this.healthMap.set(pluginName, health)
  }

  /**
   * Get health for a specific plugin
   */
  getPluginHealth(pluginName: string): PluginHealth | null {
    const health = this.healthMap.get(pluginName)
    if (!health) return null
    
    // Calculate dynamic uptime
    if (health.status === 'active' && health.activatedAt) {
      health.uptime = (Date.now() - health.activatedAt.getTime()) / 1000
    }
    
    return health
  }

  /**
   * Get all plugin healths
   */
  getAllPluginHealth(): PluginHealth[] {
    return Array.from(this.healthMap.values()).map(h => {
      if (h.status === 'active' && h.activatedAt) {
        return {
          ...h,
          uptime: (Date.now() - h.activatedAt.getTime()) / 1000
        }
      }
      return h
    })
  }

  private getOrCreateHealth(pluginName: string): PluginHealth {
    if (!this.healthMap.has(pluginName)) {
      this.healthMap.set(pluginName, {
        pluginName,
        status: 'inactive',
        uptime: 0,
        errorCount: 0
      })
    }
    return this.healthMap.get(pluginName)!
  }
}

export const pluginHealthService = new PluginHealthService()
