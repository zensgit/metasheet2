/**
 * SLO Service
 * Sprint 2: SLO & Error Budget Management
 *
 * Tracks Service Level Objectives and Error Budgets.
 * Includes visualization data and alerting capabilities.
 */

import { registry } from '../metrics/metrics'
import { Logger } from '../core/logger'
import { notificationService } from './NotificationService'

export interface SLOConfig {
  id: string
  name: string
  description?: string
  target: number // 0.0 to 1.0 (e.g. 0.999)
  windowDays: number
  indicator: {
    totalMetric: string
    errorMetric: string
    labels?: Record<string, string>
  }
  alertThresholds?: {
    warning: number // e.g. 50 (50% remaining)
    critical: number // e.g. 20 (20% remaining)
  }
}

export interface SLOStatus {
  id: string
  name: string
  target: number
  currentAvailability: number
  errorBudget: {
    total: number // Total allowed errors in window
    consumed: number // Errors observed
    remaining: number // Remaining allowed errors
    remainingPercentage: number
  }
  status: 'healthy' | 'at_risk' | 'violated'
}

export interface SLOVisualization {
  id: string
  name: string
  target: number
  current: number
  status: 'healthy' | 'at_risk' | 'violated'
  budgetBar: {
    total: number
    consumed: number
    remaining: number
    consumedPercent: number
    remainingPercent: number
  }
  trend: 'improving' | 'stable' | 'degrading'
  lastAlert?: {
    type: 'warning' | 'critical'
    message: string
    timestamp: Date
  }
}

export interface SLOAlert {
  sloId: string
  sloName: string
  type: 'warning' | 'critical' | 'recovery'
  message: string
  remainingBudget: number
  timestamp: Date
}

export class SLOService {
  private logger: Logger
  private slos: Map<string, SLOConfig> = new Map()
  private alertHistory: SLOAlert[] = []
  private previousStatus: Map<string, SLOStatus['status']> = new Map()
  private alertingEnabled: boolean = true

  constructor() {
    this.logger = new Logger('SLOService')
    this.initializeDefaultSLOs()
  }

  private initializeDefaultSLOs() {
    // Default HTTP Availability SLO
    this.addSLO({
      id: 'http-availability',
      name: 'HTTP API Availability',
      target: 0.999,
      windowDays: 30,
      indicator: {
        totalMetric: 'http_requests_total',
        errorMetric: 'http_requests_total', // We'll filter by status=5xx
        labels: {}
      },
      alertThresholds: {
        warning: 50, // Alert at 50% budget remaining
        critical: 20 // Critical alert at 20% budget remaining
      }
    })
  }

  /**
   * Enable or disable alerting
   */
  setAlertingEnabled(enabled: boolean): void {
    this.alertingEnabled = enabled
    this.logger.info(`Alerting ${enabled ? 'enabled' : 'disabled'}`)
  }

  addSLO(config: SLOConfig) {
    this.slos.set(config.id, config)
  }

  /**
   * Calculate current status for all SLOs
   * Note: This is a simplified implementation using current process metrics.
   * In a real distributed system, this should query Prometheus.
   */
  async getSLOStatus(): Promise<SLOStatus[]> {
    const rawMetrics = await registry.getMetricsAsJSON()
    // Transform prom-client metrics to our expected format
    const metrics = rawMetrics as Array<{
      name: string
      values?: Array<{ value: number; labels: Record<string, string> }>
    }>
    const results: SLOStatus[] = []

    for (const slo of this.slos.values()) {
      const status = await this.calculateSLO(slo, metrics)
      if (status) {
        results.push(status)
      }
    }

    return results
  }

  private async calculateSLO(slo: SLOConfig, metrics: Array<{ name: string; values?: Array<{ value: number; labels: Record<string, string> }> }>): Promise<SLOStatus | null> {
    // Find metrics
    const totalMetric = metrics.find(m => m.name === slo.indicator.totalMetric)
    
    if (!totalMetric) {
      return null
    }

    let totalCount = 0
    let errorCount = 0

    // Aggregate values
    if (totalMetric.values) {
      for (const value of totalMetric.values) {
        // Check if labels match
        let match = true
        if (slo.indicator.labels) {
          for (const [k, v] of Object.entries(slo.indicator.labels)) {
            if (value.labels[k] !== v) {
              match = false
              break
            }
          }
        }
        
        if (match) {
          totalCount += value.value
          
          // Check for error condition (e.g. status starts with 5)
          if (value.labels.status && value.labels.status.startsWith('5')) {
            errorCount += value.value
          }
        }
      }
    }

    if (totalCount === 0) {
      return {
        id: slo.id,
        name: slo.name,
        target: slo.target,
        currentAvailability: 1.0,
        errorBudget: {
          total: 0,
          consumed: 0,
          remaining: 0,
          remainingPercentage: 100
        },
        status: 'healthy'
      }
    }

    const currentAvailability = (totalCount - errorCount) / totalCount
    const allowedErrorRate = 1 - slo.target
    const totalAllowedErrors = Math.floor(totalCount * allowedErrorRate) // Approximation for window
    // In reality, budget is based on time window, but here we use request count approximation
    // Better approximation: Budget = Total Requests * (1 - Target)
    
    const remainingErrors = Math.max(0, totalAllowedErrors - errorCount)
    const remainingPercentage = totalAllowedErrors > 0 ? (remainingErrors / totalAllowedErrors) * 100 : 0

    let status: SLOStatus['status'] = 'healthy'
    if (remainingPercentage <= 0) {
      status = 'violated'
    } else if (remainingPercentage < 20) {
      status = 'at_risk'
    }

    const sloStatus: SLOStatus = {
      id: slo.id,
      name: slo.name,
      target: slo.target,
      currentAvailability,
      errorBudget: {
        total: totalAllowedErrors,
        consumed: errorCount,
        remaining: remainingErrors,
        remainingPercentage
      },
      status
    }

    // Check for alerting
    await this.checkAndSendAlerts(slo, sloStatus)

    return sloStatus
  }

  /**
   * Check SLO status and send alerts if thresholds are crossed
   */
  private async checkAndSendAlerts(slo: SLOConfig, status: SLOStatus): Promise<void> {
    if (!this.alertingEnabled) return

    const thresholds = slo.alertThresholds || { warning: 50, critical: 20 }
    const previousState = this.previousStatus.get(slo.id)
    const remainingPct = status.errorBudget.remainingPercentage

    let alertType: SLOAlert['type'] | null = null
    let message = ''

    // Check for critical threshold crossing
    if (remainingPct <= thresholds.critical && previousState !== 'violated') {
      alertType = 'critical'
      message = `CRITICAL: SLO "${slo.name}" has only ${remainingPct.toFixed(1)}% error budget remaining!`
    }
    // Check for warning threshold crossing
    else if (remainingPct <= thresholds.warning && remainingPct > thresholds.critical && previousState === 'healthy') {
      alertType = 'warning'
      message = `WARNING: SLO "${slo.name}" has ${remainingPct.toFixed(1)}% error budget remaining.`
    }
    // Check for recovery
    else if (remainingPct > thresholds.warning && (previousState === 'at_risk' || previousState === 'violated')) {
      alertType = 'recovery'
      message = `RECOVERY: SLO "${slo.name}" has recovered to ${remainingPct.toFixed(1)}% error budget remaining.`
    }

    // Update previous status
    this.previousStatus.set(slo.id, status.status)

    // Send alert if needed
    if (alertType) {
      const alert: SLOAlert = {
        sloId: slo.id,
        sloName: slo.name,
        type: alertType,
        message,
        remainingBudget: remainingPct,
        timestamp: new Date()
      }

      this.alertHistory.push(alert)
      await this.sendAlertNotification(alert)
    }
  }

  /**
   * Send alert notification through notification service
   */
  private async sendAlertNotification(alert: SLOAlert): Promise<void> {
    this.logger.warn(`SLO Alert: ${alert.message}`)

    try {
      await notificationService.send({
        channel: 'webhook',
        recipients: [{ id: 'ops-webhook', type: 'webhook' }],
        subject: `[${alert.type.toUpperCase()}] SLO Alert: ${alert.sloName}`,
        content: alert.message,
        data: {
          sloId: alert.sloId,
          sloName: alert.sloName,
          alertType: alert.type,
          remainingBudget: alert.remainingBudget,
          timestamp: alert.timestamp.toISOString()
        },
        metadata: {
          source: 'SLOService',
          priority: alert.type === 'critical' ? 'high' : 'normal'
        }
      })
    } catch (error) {
      this.logger.error('Failed to send SLO alert notification', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Get visualization data for all SLOs
   */
  async getVisualization(): Promise<SLOVisualization[]> {
    const statuses = await this.getSLOStatus()

    return statuses.map(status => {
      const lastAlert = this.alertHistory
        .filter(a => a.sloId === status.id)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]

      return {
        id: status.id,
        name: status.name,
        target: status.target * 100,
        current: status.currentAvailability * 100,
        status: status.status,
        budgetBar: {
          total: status.errorBudget.total,
          consumed: status.errorBudget.consumed,
          remaining: status.errorBudget.remaining,
          consumedPercent: status.errorBudget.total > 0
            ? (status.errorBudget.consumed / status.errorBudget.total) * 100
            : 0,
          remainingPercent: status.errorBudget.remainingPercentage
        },
        trend: this.calculateTrend(status.id),
        lastAlert: lastAlert ? {
          type: lastAlert.type === 'recovery' ? 'warning' : lastAlert.type,
          message: lastAlert.message,
          timestamp: lastAlert.timestamp
        } : undefined
      }
    })
  }

  /**
   * Calculate trend based on alert history
   */
  private calculateTrend(sloId: string): SLOVisualization['trend'] {
    const recentAlerts = this.alertHistory
      .filter(a => a.sloId === sloId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 3)

    if (recentAlerts.length === 0) return 'stable'

    const hasRecovery = recentAlerts.some(a => a.type === 'recovery')
    const hasCritical = recentAlerts.some(a => a.type === 'critical')

    if (hasRecovery && !hasCritical) return 'improving'
    if (hasCritical) return 'degrading'
    return 'stable'
  }

  /**
   * Get alert history
   */
  getAlertHistory(sloId?: string, limit: number = 100): SLOAlert[] {
    let alerts = [...this.alertHistory]

    if (sloId) {
      alerts = alerts.filter(a => a.sloId === sloId)
    }

    return alerts
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit)
  }

  /**
   * Get SLO configuration
   */
  getSLOConfig(id: string): SLOConfig | undefined {
    return this.slos.get(id)
  }

  /**
   * Get all SLO configurations
   */
  getAllSLOConfigs(): SLOConfig[] {
    return Array.from(this.slos.values())
  }

  /**
   * Update SLO alert thresholds
   */
  updateAlertThresholds(id: string, thresholds: { warning: number; critical: number }): boolean {
    const slo = this.slos.get(id)
    if (!slo) return false

    slo.alertThresholds = thresholds
    this.slos.set(id, slo)
    this.logger.info(`Updated alert thresholds for SLO ${id}: warning=${thresholds.warning}%, critical=${thresholds.critical}%`)
    return true
  }
}

export const sloService = new SLOService()
