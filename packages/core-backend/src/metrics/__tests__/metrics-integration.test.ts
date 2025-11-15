/**
 * Metrics Integration Tests
 * Phase 4: Verify metrics compatibility and integration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { metrics } from '../metrics'

describe('Metrics Integration - Phase 4', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('ViewService Metrics', () => {
    it('should have viewDataLatencySeconds metric defined', () => {
      expect(metrics.viewDataLatencySeconds).toBeDefined()
      expect(typeof metrics.viewDataLatencySeconds.labels).toBe('function')
    })

    it('should have viewDataRequestsTotal metric defined', () => {
      expect(metrics.viewDataRequestsTotal).toBeDefined()
      expect(typeof metrics.viewDataRequestsTotal.labels).toBe('function')
    })

    it('should record view data latency', () => {
      const labelsFn = vi.spyOn(metrics.viewDataLatencySeconds, 'labels')

      // Simulate calling labels
      const labeled = metrics.viewDataLatencySeconds.labels('grid', '200')

      expect(labelsFn).toHaveBeenCalledWith('grid', '200')
      expect(labeled).toBeDefined()
      expect(typeof labeled.observe).toBe('function')
    })

    it('should record view data requests', () => {
      const labelsFn = vi.spyOn(metrics.viewDataRequestsTotal, 'labels')

      // Simulate calling labels
      const labeled = metrics.viewDataRequestsTotal.labels('grid', 'ok')

      expect(labelsFn).toHaveBeenCalledWith('grid', 'ok')
      expect(labeled).toBeDefined()
      expect(typeof labeled.inc).toBe('function')
    })
  })

  describe('RBAC Metrics', () => {
    it('should have rbacPermissionChecksTotal metric defined', () => {
      expect(metrics.rbacPermissionChecksTotal).toBeDefined()
      expect(typeof metrics.rbacPermissionChecksTotal.labels).toBe('function')
    })

    it('should have rbacCheckLatencySeconds metric defined', () => {
      expect(metrics.rbacCheckLatencySeconds).toBeDefined()
      expect(typeof metrics.rbacCheckLatencySeconds.labels).toBe('function')
    })

    it('should record RBAC permission checks', () => {
      const labelsFn = vi.spyOn(metrics.rbacPermissionChecksTotal, 'labels')

      // Simulate calling labels
      const labeled = metrics.rbacPermissionChecksTotal.labels('read', 'allow')

      expect(labelsFn).toHaveBeenCalledWith('read', 'allow')
      expect(labeled).toBeDefined()
      expect(typeof labeled.inc).toBe('function')
    })

    it('should record RBAC check latency', () => {
      const labelsFn = vi.spyOn(metrics.rbacCheckLatencySeconds, 'labels')

      // Simulate calling labels
      const labeled = metrics.rbacCheckLatencySeconds.labels('read')

      expect(labelsFn).toHaveBeenCalledWith('read')
      expect(labeled).toBeDefined()
      expect(typeof labeled.observe).toBe('function')
    })
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

  describe('Legacy RBAC Compatibility Metrics', () => {
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

    it('should have rbacPermQueriesReal for RealShare compatibility', () => {
      expect(metrics.rbacPermQueriesReal).toBeDefined()
      expect(typeof metrics.rbacPermQueriesReal.inc).toBe('function')
    })

    it('should have rbacPermQueriesSynth for RealShare compatibility', () => {
      expect(metrics.rbacPermQueriesSynth).toBeDefined()
      expect(typeof metrics.rbacPermQueriesSynth.inc).toBe('function')
    })
  })

  describe('Metrics Label Compatibility', () => {
    it('should support all view types in viewDataLatencySeconds', () => {
      const viewTypes = ['grid', 'kanban', 'gallery', 'form']
      const statuses = ['200', '403', '404', '500']

      viewTypes.forEach(type => {
        statuses.forEach(status => {
          const labeled = metrics.viewDataLatencySeconds.labels(type, status)
          expect(labeled).toBeDefined()
          expect(typeof labeled.observe).toBe('function')
        })
      })
    })

    it('should support all result types in viewDataRequestsTotal', () => {
      const viewTypes = ['grid', 'kanban']
      const results = ['ok', 'error']

      viewTypes.forEach(type => {
        results.forEach(result => {
          const labeled = metrics.viewDataRequestsTotal.labels(type, result)
          expect(labeled).toBeDefined()
          expect(typeof labeled.inc).toBe('function')
        })
      })
    })

    it('should support all RBAC actions and results', () => {
      const actions = ['read', 'write']
      const results = ['allow', 'deny', 'error']

      actions.forEach(action => {
        results.forEach(result => {
          const labeled = metrics.rbacPermissionChecksTotal.labels(action, result)
          expect(labeled).toBeDefined()
          expect(typeof labeled.inc).toBe('function')
        })
      })
    })
  })

  describe('Metrics Export', () => {
    it('should export all required metrics', () => {
      const requiredMetrics = [
        'jwtAuthFail',
        'approvalActions',
        'approvalConflict',
        'rbacPermCacheHits',
        'rbacPermCacheMiss',
        'rbacPermCacheMisses',
        'rbacDenials',
        'authFailures',
        'rbacPermQueriesReal',
        'rbacPermQueriesSynth',
        'httpSummary',
        'httpRequestsTotal',
        'viewDataLatencySeconds',
        'viewDataRequestsTotal',
        'rbacPermissionChecksTotal',
        'rbacCheckLatencySeconds'
      ]

      requiredMetrics.forEach(metricName => {
        expect(metrics).toHaveProperty(metricName)
        expect(metrics[metricName as keyof typeof metrics]).toBeDefined()
      })
    })

    it('should have exactly the expected number of exported metrics', () => {
      const exportedKeys = Object.keys(metrics)
      // 16 metrics as defined in the metrics module
      expect(exportedKeys.length).toBe(16)
    })
  })
})
