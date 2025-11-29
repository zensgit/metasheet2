/**
 * Metrics Integration Tests
 * Verifies metrics module exports and functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { metrics } from '../metrics'

describe('Metrics Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('HTTP Metrics', () => {
    it('should have httpRequestsTotal metric defined', () => {
      expect(metrics.httpRequestsTotal).toBeDefined()
      expect(typeof metrics.httpRequestsTotal.labels).toBe('function')
    })

    it('should have httpSummary metric defined', () => {
      expect(metrics.httpSummary).toBeDefined()
      expect(typeof metrics.httpSummary.labels).toBe('function')
    })
  })

  describe('RBAC Metrics', () => {
    it('should have rbacPermCacheHits for compatibility', () => {
      expect(metrics.rbacPermCacheHits).toBeDefined()
      expect(typeof metrics.rbacPermCacheHits.inc).toBe('function')
    })

    it('should have rbacPermCacheMiss for compatibility', () => {
      expect(metrics.rbacPermCacheMiss).toBeDefined()
      expect(typeof metrics.rbacPermCacheMiss.inc).toBe('function')
    })

    it('should have rbacPermCacheMisses (plural alias) for compatibility', () => {
      expect(metrics.rbacPermCacheMisses).toBeDefined()
      expect(typeof metrics.rbacPermCacheMisses.inc).toBe('function')
    })

    it('should have rbacDenials for compatibility', () => {
      expect(metrics.rbacDenials).toBeDefined()
      expect(typeof metrics.rbacDenials.inc).toBe('function')
    })

    it('should have authFailures for compatibility', () => {
      expect(metrics.authFailures).toBeDefined()
      expect(typeof metrics.authFailures.inc).toBe('function')
    })
  })

  describe('Auth Metrics', () => {
    it('should have jwtAuthFail metric defined', () => {
      expect(metrics.jwtAuthFail).toBeDefined()
      expect(typeof metrics.jwtAuthFail.labels).toBe('function')
    })
  })

  describe('Event Metrics', () => {
    it('should have eventsEmittedTotal metric defined', () => {
      expect(metrics.eventsEmittedTotal).toBeDefined()
      expect(typeof metrics.eventsEmittedTotal.inc).toBe('function')
    })

    it('should have messagesProcessedTotal metric defined', () => {
      expect(metrics.messagesProcessedTotal).toBeDefined()
      expect(typeof metrics.messagesProcessedTotal.inc).toBe('function')
    })

    it('should have messagesRetriedTotal metric defined', () => {
      expect(metrics.messagesRetriedTotal).toBeDefined()
      expect(typeof metrics.messagesRetriedTotal.inc).toBe('function')
    })

    it('should have messagesExpiredTotal metric defined', () => {
      expect(metrics.messagesExpiredTotal).toBeDefined()
      expect(typeof metrics.messagesExpiredTotal.inc).toBe('function')
    })
  })

  describe('Plugin Metrics', () => {
    it('should have pluginReloadTotal metric defined', () => {
      expect(metrics.pluginReloadTotal).toBeDefined()
      expect(typeof metrics.pluginReloadTotal.labels).toBe('function')
    })

    it('should have pluginReloadDuration metric defined', () => {
      expect(metrics.pluginReloadDuration).toBeDefined()
      expect(typeof metrics.pluginReloadDuration.labels).toBe('function')
    })
  })

  describe('Snapshot Metrics', () => {
    it('should have snapshotCreateTotal metric defined', () => {
      expect(metrics.snapshotCreateTotal).toBeDefined()
      expect(typeof metrics.snapshotCreateTotal.labels).toBe('function')
    })

    it('should have snapshotRestoreTotal metric defined', () => {
      expect(metrics.snapshotRestoreTotal).toBeDefined()
      expect(typeof metrics.snapshotRestoreTotal.labels).toBe('function')
    })

    it('should have snapshotOperationDuration metric defined', () => {
      expect(metrics.snapshotOperationDuration).toBeDefined()
      expect(typeof metrics.snapshotOperationDuration.labels).toBe('function')
    })

    it('should have snapshotCleanupTotal metric defined', () => {
      expect(metrics.snapshotCleanupTotal).toBeDefined()
      expect(typeof metrics.snapshotCleanupTotal.labels).toBe('function')
    })
  })

  describe('Cache Metrics', () => {
    it('should have cache_hits_total metric defined', () => {
      expect(metrics.cache_hits_total).toBeDefined()
      expect(typeof metrics.cache_hits_total.labels).toBe('function')
    })

    it('should have cache_miss_total metric defined', () => {
      expect(metrics.cache_miss_total).toBeDefined()
      expect(typeof metrics.cache_miss_total.labels).toBe('function')
    })

    it('should have cache_enabled metric defined', () => {
      expect(metrics.cache_enabled).toBeDefined()
      expect(typeof metrics.cache_enabled.labels).toBe('function')
    })
  })

  describe('Redis Metrics', () => {
    it('should have redisOperationDuration metric defined', () => {
      expect(metrics.redisOperationDuration).toBeDefined()
      expect(typeof metrics.redisOperationDuration.labels).toBe('function')
    })

    it('should have redisRecoveryAttemptsTotal metric defined', () => {
      expect(metrics.redisRecoveryAttemptsTotal).toBeDefined()
      expect(typeof metrics.redisRecoveryAttemptsTotal.labels).toBe('function')
    })
  })

  describe('Fallback Metrics', () => {
    it('should have fallbackRawTotal metric defined', () => {
      expect(metrics.fallbackRawTotal).toBeDefined()
      expect(typeof metrics.fallbackRawTotal.labels).toBe('function')
    })

    it('should have fallbackEffectiveTotal metric defined', () => {
      expect(metrics.fallbackEffectiveTotal).toBeDefined()
      expect(typeof metrics.fallbackEffectiveTotal.labels).toBe('function')
    })
  })

  describe('Metrics Export', () => {
    it('should export all required core metrics', () => {
      const requiredMetrics = [
        'jwtAuthFail',
        'approvalActions',
        'approvalConflict',
        'rbacPermCacheHits',
        'rbacPermCacheMiss',
        'rbacPermCacheMisses',
        'rbacDenials',
        'authFailures',
        'httpSummary',
        'httpRequestsTotal',
        'eventsEmittedTotal',
        'messagesProcessedTotal',
        'pluginReloadTotal',
        'snapshotCreateTotal',
        'cache_hits_total',
        'redisOperationDuration',
        'fallbackRawTotal'
      ]

      requiredMetrics.forEach(metricName => {
        expect(metrics).toHaveProperty(metricName)
        expect(metrics[metricName as keyof typeof metrics]).toBeDefined()
      })
    })

    it('should have the expected number of exported metrics', () => {
      const exportedKeys = Object.keys(metrics)
      // 43 metrics as of current metrics module (including RBAC metrics)
      expect(exportedKeys.length).toBe(43)
    })
  })
})
