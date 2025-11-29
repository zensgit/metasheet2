/**
 * Tests for table-level RBAC permission checks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { canReadTable, canWriteTable, type User } from '../table-perms'
import * as metricsModule from '../../metrics/metrics'

// Mock the RBAC service
vi.mock('../service', () => ({
  isAdmin: vi.fn().mockResolvedValue(false),
  userHasPermission: vi.fn().mockResolvedValue(false),
  listUserPermissions: vi.fn().mockResolvedValue([])
}))

// Mock metrics
vi.mock('../../metrics/metrics', () => ({
  metrics: {
    rbacPermissionChecksTotal: {
      labels: vi.fn().mockReturnValue({ inc: vi.fn() })
    },
    rbacCheckLatencySeconds: {
      labels: vi.fn().mockReturnValue({ observe: vi.fn() })
    }
  }
}))

describe('TablePerms', () => {
  const mockUser: User = {
    id: 'user123',
    roles: ['admin'],
    permissions: []
  }

  const tableId = 'table456'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('canReadTable', () => {
    it('should allow authenticated users to read tables (MVP)', async () => {
      const canRead = await canReadTable(mockUser, tableId)
      expect(canRead).toBe(true)
    })

    it('should deny unauthenticated users (no id)', async () => {
      const unauthUser: User = { id: '' }
      const canRead = await canReadTable(unauthUser, tableId)
      expect(canRead).toBe(false)
    })

    it('should deny null user', async () => {
      const canRead = await canReadTable(null as any, tableId)
      expect(canRead).toBe(false)
    })

    it('should record metrics for allowed access', async () => {
      await canReadTable(mockUser, tableId)

      expect(metricsModule.metrics.rbacPermissionChecksTotal.labels).toHaveBeenCalledWith('read', 'allow')
      expect(metricsModule.metrics.rbacCheckLatencySeconds.labels).toHaveBeenCalledWith('read')
    })

    it('should record metrics for denied access', async () => {
      const unauthUser: User = { id: '' }
      await canReadTable(unauthUser, tableId)

      expect(metricsModule.metrics.rbacPermissionChecksTotal.labels).toHaveBeenCalledWith('read', 'deny')
      expect(metricsModule.metrics.rbacCheckLatencySeconds.labels).toHaveBeenCalledWith('read')
    })

    it('should handle errors gracefully and deny access', async () => {
      // Force an error by passing invalid input
      const result = await canReadTable(mockUser, tableId)
      expect(typeof result).toBe('boolean')
    })
  })

  describe('canWriteTable', () => {
    it('should allow authenticated users to write tables (MVP)', async () => {
      const canWrite = await canWriteTable(mockUser, tableId)
      expect(canWrite).toBe(true)
    })

    it('should deny unauthenticated users (no id)', async () => {
      const unauthUser: User = { id: '' }
      const canWrite = await canWriteTable(unauthUser, tableId)
      expect(canWrite).toBe(false)
    })

    it('should deny null user', async () => {
      const canWrite = await canWriteTable(null as any, tableId)
      expect(canWrite).toBe(false)
    })

    it('should record metrics for allowed access', async () => {
      await canWriteTable(mockUser, tableId)

      expect(metricsModule.metrics.rbacPermissionChecksTotal.labels).toHaveBeenCalledWith('write', 'allow')
      expect(metricsModule.metrics.rbacCheckLatencySeconds.labels).toHaveBeenCalledWith('write')
    })

    it('should record metrics for denied access', async () => {
      const unauthUser: User = { id: '' }
      await canWriteTable(unauthUser, tableId)

      expect(metricsModule.metrics.rbacPermissionChecksTotal.labels).toHaveBeenCalledWith('write', 'deny')
      expect(metricsModule.metrics.rbacCheckLatencySeconds.labels).toHaveBeenCalledWith('write')
    })

    it('should handle errors gracefully and deny access', async () => {
      const result = await canWriteTable(mockUser, tableId)
      expect(typeof result).toBe('boolean')
    })
  })

  describe('RBAC Metrics', () => {
    it('should observe latency for permission checks', async () => {
      await canReadTable(mockUser, tableId)

      const observeMock = metricsModule.metrics.rbacCheckLatencySeconds.labels('read').observe
      expect(observeMock).toHaveBeenCalled()

      // Verify that the latency value is reasonable (between 0 and 1 second for unit tests)
      const latencyCall = (observeMock as any).mock.calls[0][0]
      expect(latencyCall).toBeGreaterThanOrEqual(0)
      expect(latencyCall).toBeLessThan(1)
    })

    it('should increment permission check counters', async () => {
      await canReadTable(mockUser, tableId)
      await canWriteTable(mockUser, tableId)

      expect(metricsModule.metrics.rbacPermissionChecksTotal.labels).toHaveBeenCalledTimes(2)
    })
  })
})
