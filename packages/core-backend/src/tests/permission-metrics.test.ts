/**
 * Permission Denied Metrics Test Suite
 * Issue #35: Permission denied metric test enhancement
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { MetricsCollector } from '../metrics/collector'
import { PermissionChecker } from '../rbac/permission-checker'
import { AuthMiddleware } from '../auth/middleware'

describe('Permission Denied Metrics', () => {
  let metricsCollector: MetricsCollector
  let permissionChecker: PermissionChecker
  let authMiddleware: AuthMiddleware

  beforeEach(() => {
    metricsCollector = new MetricsCollector()
    permissionChecker = new PermissionChecker(metricsCollector)
    authMiddleware = new AuthMiddleware(permissionChecker, metricsCollector)
  })

  afterEach(() => {
    metricsCollector.reset()
  })

  describe('Unauthorized API Endpoint Access', () => {
    it('should emit metasheet_auth_failures_total metric on unauthorized access', async () => {
      const req = {
        headers: {},
        path: '/api/admin/users',
        method: 'GET'
      }

      const result = await authMiddleware.checkAuth(req)

      expect(result.authorized).toBe(false)
      expect(result.reason).toBe('no_token')

      const metrics = metricsCollector.getMetrics()
      expect(metrics['metasheet_auth_failures_total']).toBeDefined()
      expect(metrics['metasheet_auth_failures_total'].labels).toEqual({
        reason: 'no_token',
        endpoint: '/api/admin/users',
        method: 'GET'
      })
      expect(metrics['metasheet_auth_failures_total'].value).toBe(1)
    })

    it('should emit 403 status metric on permission denied', async () => {
      const req = {
        headers: { authorization: 'Bearer valid-token' },
        path: '/api/admin/settings',
        method: 'PUT',
        user: { id: 'user123', role: 'viewer' }
      }

      const result = await permissionChecker.checkPermission(req.user, 'admin:write')

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('insufficient_role')

      const metrics = metricsCollector.getMetrics()
      expect(metrics['metasheet_api_requests_total']).toBeDefined()

      const forbidden = metrics['metasheet_api_requests_total'].find(
        m => m.labels.status === '403'
      )
      expect(forbidden).toBeDefined()
      expect(forbidden.value).toBeGreaterThan(0)
    })
  })

  describe('Insufficient Role Permissions', () => {
    it('should track role-based permission denials', async () => {
      const testCases = [
        { role: 'viewer', resource: 'spreadsheet', action: 'edit', expected: false },
        { role: 'editor', resource: 'spreadsheet', action: 'delete', expected: false },
        { role: 'viewer', resource: 'report', action: 'export', expected: false }
      ]

      for (const testCase of testCases) {
        const user = { id: `user-${testCase.role}`, role: testCase.role }
        const result = await permissionChecker.checkPermission(
          user,
          `${testCase.resource}:${testCase.action}`
        )

        expect(result.allowed).toBe(testCase.expected)
      }

      const metrics = metricsCollector.getMetrics()
      const rbacDenials = metrics['metasheet_rbac_denials_total']

      expect(rbacDenials).toBeDefined()
      expect(rbacDenials.value).toBe(3)
    })

    it('should include resource type in rbac denial metrics', async () => {
      const resources = ['spreadsheet', 'workflow', 'approval', 'report']

      for (const resource of resources) {
        const user = { id: 'viewer1', role: 'viewer' }
        await permissionChecker.checkPermission(user, `${resource}:delete`)
      }

      const metrics = metricsCollector.getMetrics()
      const rbacMetrics = metrics['metasheet_rbac_denials_total']

      expect(rbacMetrics).toBeDefined()

      for (const resource of resources) {
        const resourceMetric = rbacMetrics.find(
          m => m.labels.resource_type === resource
        )
        expect(resourceMetric).toBeDefined()
        expect(resourceMetric.labels.action).toBe('delete')
        expect(resourceMetric.labels.role).toBe('viewer')
      }
    })
  })

  describe('Resource-level Access Denial', () => {
    it('should track resource ownership denials', async () => {
      const req = {
        user: { id: 'user456', role: 'editor' },
        resource: {
          type: 'spreadsheet',
          id: 'sheet123',
          owner: 'user789'
        },
        action: 'delete'
      }

      const result = await permissionChecker.checkResourceAccess(req)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('not_owner')

      const metrics = metricsCollector.getMetrics()
      expect(metrics['metasheet_rbac_denials_total']).toBeDefined()

      const ownershipDenial = metrics['metasheet_rbac_denials_total'].find(
        m => m.labels.reason === 'not_owner'
      )
      expect(ownershipDenial).toBeDefined()
      expect(ownershipDenial.labels.resource_type).toBe('spreadsheet')
    })

    it('should track department-based access denials', async () => {
      const req = {
        user: { id: 'user123', department: 'sales' },
        resource: {
          type: 'approval',
          id: 'appr456',
          allowedDepartments: ['hr', 'finance']
        },
        action: 'view'
      }

      const result = await permissionChecker.checkDepartmentAccess(req)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('department_restricted')

      const metrics = metricsCollector.getMetrics()
      const deptDenial = metrics['metasheet_rbac_denials_total'].find(
        m => m.labels.reason === 'department_restricted'
      )
      expect(deptDenial).toBeDefined()
      expect(deptDenial.value).toBe(1)
    })
  })

  describe('Token Expiration and Invalidation', () => {
    it('should track expired token metrics', async () => {
      const req = {
        headers: {
          authorization: 'Bearer expired-token'
        },
        path: '/api/spreadsheets'
      }

      const result = await authMiddleware.validateToken(req.headers.authorization)

      expect(result.valid).toBe(false)
      expect(result.reason).toBe('token_expired')

      const metrics = metricsCollector.getMetrics()
      expect(metrics['metasheet_auth_failures_total']).toBeDefined()

      const expiredMetric = metrics['metasheet_auth_failures_total'].find(
        m => m.labels.reason === 'token_expired'
      )
      expect(expiredMetric).toBeDefined()
      expect(expiredMetric.value).toBeGreaterThan(0)
    })

    it('should track invalidated token metrics', async () => {
      const invalidTokens = [
        'malformed-token',
        'revoked-token-123',
        'blacklisted-token-456'
      ]

      for (const token of invalidTokens) {
        await authMiddleware.validateToken(`Bearer ${token}`)
      }

      const metrics = metricsCollector.getMetrics()
      const invalidMetrics = metrics['metasheet_auth_failures_total'].filter(
        m => ['invalid_token', 'revoked_token'].includes(m.labels.reason)
      )

      expect(invalidMetrics.length).toBeGreaterThan(0)
      const totalInvalid = invalidMetrics.reduce((sum, m) => sum + m.value, 0)
      expect(totalInvalid).toBe(3)
    })
  })

  describe('Metrics Aggregation and Reporting', () => {
    it('should provide Prometheus-compatible output', () => {
      // Simulate various permission denials
      metricsCollector.incrementAuthFailure('permission_denied', '/api/admin', 'POST')
      metricsCollector.incrementAuthFailure('insufficient_role', '/api/settings', 'PUT')
      metricsCollector.incrementRbacDenial('spreadsheet', 'delete', 'editor', 'not_owner')
      metricsCollector.incrementApiRequest('/api/users', 'GET', 403)

      const promOutput = metricsCollector.toPrometheusFormat()

      expect(promOutput).toContain('# HELP metasheet_auth_failures_total')
      expect(promOutput).toContain('# TYPE metasheet_auth_failures_total counter')
      expect(promOutput).toContain('metasheet_auth_failures_total{reason="permission_denied"')
      expect(promOutput).toContain('metasheet_rbac_denials_total{resource_type="spreadsheet"')
      expect(promOutput).toContain('metasheet_api_requests_total{status="403"')
    })

    it('should reset metrics correctly', () => {
      metricsCollector.incrementAuthFailure('test', '/api/test', 'GET')
      expect(metricsCollector.getMetrics()['metasheet_auth_failures_total']).toBeDefined()

      metricsCollector.reset()
      const metrics = metricsCollector.getMetrics()
      expect(Object.keys(metrics).length).toBe(0)
    })
  })
})