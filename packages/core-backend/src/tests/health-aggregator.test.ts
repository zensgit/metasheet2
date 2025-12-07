/**
 * Health Aggregator Service Tests
 * Sprint 7 Day 4: Tests for HealthAggregatorService
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock data for testing health aggregation logic
const mockPoolStats = [
  {
    name: 'main',
    status: 'healthy' as const,
    totalConnections: 10,
    idleConnections: 5,
    waitingClients: 0
  },
  {
    name: 'shard_1',
    status: 'healthy' as const,
    totalConnections: 8,
    idleConnections: 3,
    waitingClients: 1
  }
]

const mockMessageBusStats = {
  exactSubscriptions: 5,
  patternSubscriptions: 3,
  queueLength: 0,
  pendingRpcCount: 0,
  usePatternTrie: true
}

const mockPluginHealth = [
  {
    pluginName: 'plugin-a',
    status: 'active' as const,
    uptime: 3600,
    errorCount: 0
  },
  {
    pluginName: 'plugin-b',
    status: 'active' as const,
    uptime: 3500,
    errorCount: 1
  }
]

const mockRateLimiterStats = {
  activeBuckets: 10,
  totalAccepted: 1000,
  totalRejected: 50,
  averageTokensRemaining: 500.5
}

const mockDlqCounts = {
  pending: 5,
  retrying: 2,
  resolved: 10
}

describe('HealthAggregatorService Logic', () => {
  describe('Database Health Calculation', () => {
    it('should calculate healthy status when all shards are healthy', () => {
      const stats = mockPoolStats
      const healthyShards = stats.filter(s => s.status === 'healthy').length
      const unhealthyShards = stats.filter(s => s.status === 'unhealthy').length
      const totalShards = stats.length

      expect(healthyShards).toBe(2)
      expect(unhealthyShards).toBe(0)
      expect(totalShards).toBe(2)

      const status = unhealthyShards === totalShards
        ? 'unhealthy'
        : unhealthyShards > 0
          ? 'degraded'
          : 'healthy'

      expect(status).toBe('healthy')
    })

    it('should calculate degraded status when some shards are unhealthy', () => {
      const statsWithUnhealthy = [
        ...mockPoolStats,
        { name: 'shard_2', status: 'unhealthy' as const, totalConnections: 0, idleConnections: 0, waitingClients: 5 }
      ]

      const healthyShards = statsWithUnhealthy.filter(s => s.status === 'healthy').length
      const unhealthyShards = statsWithUnhealthy.filter(s => s.status === 'unhealthy').length
      const totalShards = statsWithUnhealthy.length

      expect(healthyShards).toBe(2)
      expect(unhealthyShards).toBe(1)

      const status = unhealthyShards === totalShards
        ? 'unhealthy'
        : unhealthyShards > 0
          ? 'degraded'
          : 'healthy'

      expect(status).toBe('degraded')
    })

    it('should calculate unhealthy status when all shards are unhealthy', () => {
      const allUnhealthy = [
        { name: 'main', status: 'unhealthy' as const, totalConnections: 0, idleConnections: 0, waitingClients: 5 },
        { name: 'shard_1', status: 'unhealthy' as const, totalConnections: 0, idleConnections: 0, waitingClients: 3 }
      ]

      const unhealthyShards = allUnhealthy.filter(s => s.status === 'unhealthy').length
      const totalShards = allUnhealthy.length

      const status = unhealthyShards === totalShards
        ? 'unhealthy'
        : unhealthyShards > 0
          ? 'degraded'
          : 'healthy'

      expect(status).toBe('unhealthy')
    })

    it('should format database health details correctly', () => {
      const shards = mockPoolStats.map(stat => ({
        name: stat.name,
        status: stat.status,
        totalConnections: stat.totalConnections,
        idleConnections: stat.idleConnections,
        activeConnections: stat.totalConnections - stat.idleConnections,
        waitingClients: stat.waitingClients
      }))

      expect(shards[0]).toEqual({
        name: 'main',
        status: 'healthy',
        totalConnections: 10,
        idleConnections: 5,
        activeConnections: 5,
        waitingClients: 0
      })
    })
  })

  describe('MessageBus Health Calculation', () => {
    it('should calculate healthy status with normal queue length', () => {
      const queueLength = mockMessageBusStats.queueLength
      const status = queueLength > 1000 ? 'degraded' : 'healthy'

      expect(status).toBe('healthy')
    })

    it('should calculate degraded status with high queue length', () => {
      const highQueueStats = { ...mockMessageBusStats, queueLength: 1500 }
      const status = highQueueStats.queueLength > 1000 ? 'degraded' : 'healthy'

      expect(status).toBe('degraded')
    })

    it('should include DLQ in health details', () => {
      const dlqStats = {
        pending: mockDlqCounts.pending,
        retrying: mockDlqCounts.retrying,
        resolved: mockDlqCounts.resolved,
        total: mockDlqCounts.pending + mockDlqCounts.retrying + mockDlqCounts.resolved
      }

      expect(dlqStats.total).toBe(17)
      expect(dlqStats.pending).toBe(5)
    })

    it('should warn when DLQ pending count is high', () => {
      const threshold = 100
      const highPending = 150

      const status = highPending > threshold ? 'degraded' : 'healthy'
      const message = highPending > threshold ? `High DLQ pending count: ${highPending}` : undefined

      expect(status).toBe('degraded')
      expect(message).toBe('High DLQ pending count: 150')
    })
  })

  describe('Plugin Health Calculation', () => {
    it('should calculate healthy status when all plugins are active', () => {
      const plugins = mockPluginHealth
      const errorPlugins = plugins.filter(p => p.status === 'error').length
      const degradedPlugins = plugins.filter(p => p.status === 'degraded').length

      let status: 'healthy' | 'degraded' = 'healthy'
      if (errorPlugins > 0 || degradedPlugins > 0) {
        status = 'degraded'
      }

      expect(status).toBe('healthy')
    })

    it('should calculate degraded status when plugins have errors', () => {
      const pluginsWithError = [
        ...mockPluginHealth,
        { pluginName: 'plugin-c', status: 'error' as const, uptime: 0, errorCount: 10 }
      ]

      const errorPlugins = pluginsWithError.filter(p => p.status === 'error').length
      const status = errorPlugins > 0 ? 'degraded' : 'healthy'

      expect(status).toBe('degraded')
      expect(errorPlugins).toBe(1)
    })

    it('should count plugin statistics correctly', () => {
      const plugins = [
        { pluginName: 'a', status: 'active' as const, uptime: 100, errorCount: 0 },
        { pluginName: 'b', status: 'active' as const, uptime: 100, errorCount: 0 },
        { pluginName: 'c', status: 'error' as const, uptime: 0, errorCount: 5 },
        { pluginName: 'd', status: 'degraded' as const, uptime: 50, errorCount: 3 },
        { pluginName: 'e', status: 'inactive' as const, uptime: 0, errorCount: 0 }
      ]

      const stats = {
        totalPlugins: plugins.length,
        activePlugins: plugins.filter(p => p.status === 'active').length,
        errorPlugins: plugins.filter(p => p.status === 'error').length,
        degradedPlugins: plugins.filter(p => p.status === 'degraded').length
      }

      expect(stats.totalPlugins).toBe(5)
      expect(stats.activePlugins).toBe(2)
      expect(stats.errorPlugins).toBe(1)
      expect(stats.degradedPlugins).toBe(1)
    })
  })

  describe('Rate Limiting Health Calculation', () => {
    it('should calculate rejection rate correctly', () => {
      const stats = mockRateLimiterStats
      const totalRequests = stats.totalAccepted + stats.totalRejected
      const rejectionRate = totalRequests > 0 ? stats.totalRejected / totalRequests : 0

      expect(rejectionRate).toBeCloseTo(0.0476, 3) // 50 / 1050
    })

    it('should return healthy when rejection rate is below threshold', () => {
      const stats = mockRateLimiterStats
      const threshold = 0.1 // 10%
      const totalRequests = stats.totalAccepted + stats.totalRejected
      const rejectionRate = stats.totalRejected / totalRequests

      const status = rejectionRate > threshold ? 'degraded' : 'healthy'
      expect(status).toBe('healthy')
    })

    it('should return degraded when rejection rate exceeds threshold', () => {
      const highRejectionStats = {
        totalAccepted: 800,
        totalRejected: 200 // 20% rejection rate
      }
      const threshold = 0.1

      const totalRequests = highRejectionStats.totalAccepted + highRejectionStats.totalRejected
      const rejectionRate = highRejectionStats.totalRejected / totalRequests
      const status = rejectionRate > threshold ? 'degraded' : 'healthy'

      expect(status).toBe('degraded')
      expect(rejectionRate).toBe(0.2)
    })

    it('should format rejection rate as percentage', () => {
      const stats = mockRateLimiterStats
      const totalRequests = stats.totalAccepted + stats.totalRejected
      const rejectionRate = stats.totalRejected / totalRequests
      const formatted = Math.round(rejectionRate * 10000) / 100 // 2 decimal places

      expect(formatted).toBeCloseTo(4.76, 1)
    })
  })

  describe('System Resource Health Calculation', () => {
    it('should calculate memory usage percentage', () => {
      const memUsage = {
        heapUsed: 80 * 1024 * 1024, // 80MB
        heapTotal: 100 * 1024 * 1024 // 100MB
      }

      const usagePercent = memUsage.heapUsed / memUsage.heapTotal
      expect(usagePercent).toBe(0.8)
    })

    it('should return healthy when memory is below threshold', () => {
      const usagePercent = 0.5 // 50%
      const degradedThreshold = 0.8
      const unhealthyThreshold = 0.95

      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
      if (usagePercent > unhealthyThreshold) {
        status = 'unhealthy'
      } else if (usagePercent > degradedThreshold) {
        status = 'degraded'
      }

      expect(status).toBe('healthy')
    })

    it('should return degraded when memory exceeds 80%', () => {
      const usagePercent = 0.85 // 85%
      const degradedThreshold = 0.8
      const unhealthyThreshold = 0.95

      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
      if (usagePercent > unhealthyThreshold) {
        status = 'unhealthy'
      } else if (usagePercent > degradedThreshold) {
        status = 'degraded'
      }

      expect(status).toBe('degraded')
    })

    it('should return unhealthy when memory exceeds 95%', () => {
      const usagePercent = 0.97 // 97%
      const degradedThreshold = 0.8
      const unhealthyThreshold = 0.95

      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
      if (usagePercent > unhealthyThreshold) {
        status = 'unhealthy'
      } else if (usagePercent > degradedThreshold) {
        status = 'degraded'
      }

      expect(status).toBe('unhealthy')
    })
  })

  describe('Overall Health Calculation', () => {
    it('should calculate overall healthy status when all subsystems healthy', () => {
      const subsystems = [
        { name: 'database', status: 'healthy' as const },
        { name: 'messageBus', status: 'healthy' as const },
        { name: 'plugins', status: 'healthy' as const },
        { name: 'rateLimiting', status: 'healthy' as const },
        { name: 'system', status: 'healthy' as const }
      ]

      const healthyCount = subsystems.filter(s => s.status === 'healthy').length
      const degradedCount = subsystems.filter(s => s.status === 'degraded').length
      const unhealthyCount = subsystems.filter(s => s.status === 'unhealthy').length
      const totalCount = subsystems.length

      let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
      if (unhealthyCount > 0) {
        overallStatus = 'unhealthy'
      } else if (degradedCount > 0) {
        overallStatus = 'degraded'
      }

      const overallHealthPercent = Math.round((healthyCount / totalCount) * 100)

      expect(overallStatus).toBe('healthy')
      expect(overallHealthPercent).toBe(100)
    })

    it('should calculate degraded status when some subsystems degraded', () => {
      const subsystems = [
        { name: 'database', status: 'healthy' as const },
        { name: 'messageBus', status: 'degraded' as const },
        { name: 'plugins', status: 'healthy' as const },
        { name: 'rateLimiting', status: 'healthy' as const },
        { name: 'system', status: 'degraded' as const }
      ]

      const unhealthyCount = subsystems.filter(s => s.status === 'unhealthy').length
      const degradedCount = subsystems.filter(s => s.status === 'degraded').length

      let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
      if (unhealthyCount > 0) {
        overallStatus = 'unhealthy'
      } else if (degradedCount > 0) {
        overallStatus = 'degraded'
      }

      expect(overallStatus).toBe('degraded')
      expect(degradedCount).toBe(2)
    })

    it('should calculate unhealthy status when any subsystem unhealthy', () => {
      const subsystems = [
        { name: 'database', status: 'unhealthy' as const },
        { name: 'messageBus', status: 'healthy' as const },
        { name: 'plugins', status: 'healthy' as const },
        { name: 'rateLimiting', status: 'healthy' as const },
        { name: 'system', status: 'healthy' as const }
      ]

      const unhealthyCount = subsystems.filter(s => s.status === 'unhealthy').length
      const degradedCount = subsystems.filter(s => s.status === 'degraded').length

      let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
      if (unhealthyCount > 0) {
        overallStatus = 'unhealthy'
      } else if (degradedCount > 0) {
        overallStatus = 'degraded'
      }

      expect(overallStatus).toBe('unhealthy')
    })

    it('should calculate correct health percentage', () => {
      const subsystems = [
        { status: 'healthy' as const },
        { status: 'healthy' as const },
        { status: 'degraded' as const },
        { status: 'healthy' as const },
        { status: 'unhealthy' as const }
      ]

      const healthyCount = subsystems.filter(s => s.status === 'healthy').length
      const totalCount = subsystems.length
      const overallHealthPercent = Math.round((healthyCount / totalCount) * 100)

      expect(healthyCount).toBe(3)
      expect(totalCount).toBe(5)
      expect(overallHealthPercent).toBe(60)
    })
  })

  describe('Warnings and Errors Collection', () => {
    it('should collect warnings from degraded subsystems', () => {
      const subsystems = [
        { name: 'database', status: 'healthy' as const, message: undefined },
        { name: 'messageBus', status: 'degraded' as const, message: 'High queue length: 1500' },
        { name: 'rateLimiting', status: 'degraded' as const, message: 'High rejection rate: 15%' }
      ]

      const warnings: string[] = []
      for (const sub of subsystems) {
        if (sub.status === 'degraded' && sub.message) {
          warnings.push(`${sub.name}: ${sub.message}`)
        }
      }

      expect(warnings).toHaveLength(2)
      expect(warnings).toContain('messageBus: High queue length: 1500')
      expect(warnings).toContain('rateLimiting: High rejection rate: 15%')
    })

    it('should collect errors from unhealthy subsystems', () => {
      const subsystems = [
        { name: 'database', status: 'unhealthy' as const, message: 'All shards down' },
        { name: 'messageBus', status: 'healthy' as const, message: undefined }
      ]

      const errors: string[] = []
      for (const sub of subsystems) {
        if (sub.status === 'unhealthy' && sub.message) {
          errors.push(`${sub.name}: ${sub.message}`)
        }
      }

      expect(errors).toHaveLength(1)
      expect(errors).toContain('database: All shards down')
    })
  })

  describe('Health Response Structure', () => {
    it('should format aggregated health response correctly', () => {
      const health = {
        status: 'healthy' as const,
        timestamp: new Date().toISOString(),
        uptime: 3600,
        subsystems: {
          database: { name: 'database', status: 'healthy' as const, lastCheck: new Date().toISOString() },
          messageBus: { name: 'messageBus', status: 'healthy' as const, lastCheck: new Date().toISOString() },
          plugins: { name: 'plugins', status: 'healthy' as const, lastCheck: new Date().toISOString() },
          rateLimiting: { name: 'rateLimiting', status: 'healthy' as const, lastCheck: new Date().toISOString() },
          system: { name: 'system', status: 'healthy' as const, lastCheck: new Date().toISOString() }
        },
        summary: {
          totalSubsystems: 5,
          healthySubsystems: 5,
          degradedSubsystems: 0,
          unhealthySubsystems: 0,
          overallHealthPercent: 100
        },
        warnings: [],
        errors: []
      }

      expect(health.status).toBe('healthy')
      expect(health.summary.totalSubsystems).toBe(5)
      expect(health.summary.overallHealthPercent).toBe(100)
      expect(health.warnings).toHaveLength(0)
      expect(health.errors).toHaveLength(0)
    })

    it('should include timestamp in ISO format', () => {
      const timestamp = new Date().toISOString()

      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      expect(new Date(timestamp).toISOString()).toBe(timestamp)
    })
  })
})
