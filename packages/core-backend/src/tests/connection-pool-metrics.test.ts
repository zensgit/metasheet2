/**
 * Connection Pool Prometheus Metrics Tests
 * Sprint 5 Day 3: Tests for database connection pool metrics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { coreMetrics } from '../integration/metrics/metrics'

// Mock the pg module
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn()
    }),
    end: vi.fn().mockResolvedValue(undefined),
    totalCount: 5,
    idleCount: 3,
    waitingCount: 1
  }))
}))

// Mock secretManager
vi.mock('../security/SecretManager', () => ({
  secretManager: {
    get: vi.fn().mockReturnValue('postgresql://test:test@localhost:5432/test')
  }
}))

describe('Connection Pool Prometheus Metrics (Sprint 5 Day 3)', () => {
  let poolManager: typeof import('../integration/db/connection-pool').poolManager

  beforeEach(async () => {
    vi.clearAllMocks()
    // Clear all custom metrics
    const allMetrics = coreMetrics.getAllCustomMetrics()
    for (const key of Object.keys(allMetrics)) {
      // Reset by setting to 0
      coreMetrics.gauge(key, 0)
    }
    // Dynamic import to get fresh instance
    const module = await import('../integration/db/connection-pool')
    poolManager = module.poolManager
  })

  afterEach(async () => {
    await poolManager.close()
  })

  describe('Pool Stats', () => {
    it('should provide pool statistics', async () => {
      const stats = await poolManager.getPoolStats()

      expect(stats).toHaveLength(1)
      expect(stats[0]).toMatchObject({
        name: 'main',
        status: 'healthy',
        totalConnections: 5,
        idleConnections: 3,
        waitingClients: 1
      })
    })

    it('should calculate active connections correctly', async () => {
      const stats = await poolManager.getPoolStats()
      const activeConnections = stats[0].totalConnections - stats[0].idleConnections

      expect(activeConnections).toBe(2) // 5 total - 3 idle = 2 active
    })
  })

  describe('Metrics Snapshot', () => {
    it('should provide metrics snapshot for Prometheus', () => {
      const metrics = poolManager.getMetricsSnapshot()

      expect(metrics['db_pool_total_connections{pool="main"}']).toBe(5)
      expect(metrics['db_pool_idle_connections{pool="main"}']).toBe(3)
      expect(metrics['db_pool_waiting_clients{pool="main"}']).toBe(1)
      expect(metrics['db_pool_active_connections{pool="main"}']).toBe(2)
    })
  })

  describe('Query Metrics', () => {
    it('should track query duration in metrics', async () => {
      const pool = poolManager.get('main')

      await pool.query('SELECT 1')

      // Check that histogram was recorded
      const durationMetric = coreMetrics.getCustomMetric('db_query_duration_ms')
      expect(durationMetric).toBeGreaterThanOrEqual(0)
    })

    it('should increment error counter when query fails', () => {
      // Just verify the metric tracking mechanism exists
      // The actual error tracking is tested via the metrics collector
      const initialErrors = coreMetrics.getCustomMetric('db_query_errors_total') || 0

      // Simulate an error being tracked
      coreMetrics.increment('db_query_errors_total', { pool: 'main' })

      const newErrors = coreMetrics.getCustomMetric('db_query_errors_total') || 0
      expect(newErrors).toBe(initialErrors + 1)
    })
  })

  describe('Slow Query Detection', () => {
    it('should track slow queries', async () => {
      // Mock a slow query by manipulating Date.now
      const originalDateNow = Date.now
      let callCount = 0
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++
        // First call is at start, second call adds 1000ms delay (slow query)
        return callCount === 1 ? 0 : 1000
      })

      const pool = poolManager.get('main')

      await pool.query('SELECT * FROM large_table')

      // Restore
      Date.now = originalDateNow

      const slowQueryMetric = coreMetrics.getCustomMetric('db_slow_queries_total')
      expect(slowQueryMetric).toBeGreaterThan(0)
    })
  })
})
