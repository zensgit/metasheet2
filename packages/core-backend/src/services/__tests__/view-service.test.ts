/**
 * ViewService Unit Tests
 * Phase 1: Core functionality tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as viewService from '../view-service'

// Mock dependencies
vi.mock('../../db/db', () => ({
  db: {
    selectFrom: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn(),
    updateTable: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    returningAll: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    execute: vi.fn(),
  }
}))

vi.mock('../../metrics/metrics', () => ({
  metrics: {
    viewDataLatencySeconds: {
      labels: vi.fn().mockReturnValue({ observe: vi.fn() })
    },
    viewDataRequestsTotal: {
      labels: vi.fn().mockReturnValue({ inc: vi.fn() })
    }
  }
}))

describe('ViewService - Phase 1 Core', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getViewById', () => {
    it('should return view when found', async () => {
      const mockView = { id: 'v1', name: 'Test View', type: 'grid' }
      const { db } = await import('../../db/db')
      vi.mocked(db.executeTakeFirst).mockResolvedValue(mockView)

      const result = await viewService.getViewById('v1')

      expect(result).toEqual(mockView)
      expect(db.selectFrom).toHaveBeenCalledWith('views')
    })

    it('should return null when view not found', async () => {
      const { db } = await import('../../db/db')
      vi.mocked(db.executeTakeFirst).mockResolvedValue(undefined)

      const result = await viewService.getViewById('non-existent')

      expect(result).toBeNull()
    })
  })

  describe('getViewConfig', () => {
    it('should return normalized config when view exists', async () => {
      const mockView = {
        id: 'v1',
        name: 'Test View',
        type: 'grid',
        created_at: '2025-01-01',
        updated_at: '2025-01-02',
        config: { columns: ['a', 'b'] }
      }
      const { db } = await import('../../db/db')
      vi.mocked(db.executeTakeFirst).mockResolvedValue(mockView)

      const result = await viewService.getViewConfig('v1')

      expect(result).toMatchObject({
        id: 'v1',
        name: 'Test View',
        type: 'grid',
        columns: ['a', 'b']
      })
    })

    it('should return null when view not found', async () => {
      const { db } = await import('../../db/db')
      vi.mocked(db.executeTakeFirst).mockResolvedValue(undefined)

      const result = await viewService.getViewConfig('non-existent')

      expect(result).toBeNull()
    })
  })

  describe('updateViewConfig', () => {
    it('should update view configuration', async () => {
      const updatedView = { id: 'v1', name: 'Updated', type: 'grid' }
      const { db } = await import('../../db/db')
      vi.mocked(db.executeTakeFirst).mockResolvedValue(updatedView)

      const result = await viewService.updateViewConfig('v1', {
        name: 'Updated',
        type: 'grid',
        columns: ['x', 'y']
      })

      expect(result).toEqual(updatedView)
      expect(db.updateTable).toHaveBeenCalledWith('views')
    })
  })

  describe('queryGrid', () => {
    it('should return paginated grid data', async () => {
      const mockRows = [
        { id: 'r1', data: { col1: 'val1' } },
        { id: 'r2', data: { col1: 'val2' } }
      ]
      const mockView = { id: 'v1', table_id: 't1', type: 'grid' }
      const { db } = await import('../../db/db')
      vi.mocked(db.execute).mockResolvedValue(mockRows)
      vi.mocked(db.executeTakeFirst).mockResolvedValue({ c: 10 })

      const result = await viewService.queryGrid({
        view: mockView,
        page: 1,
        pageSize: 2,
        filters: {},
        sorting: {}
      })

      expect(result.data).toHaveLength(2)
      expect(result.meta.total).toBe(10)
      expect(result.meta.hasMore).toBe(true)
    })

    it('should handle empty results', async () => {
      const mockView = { id: 'v1', table_id: 't1', type: 'grid' }
      const { db } = await import('../../db/db')
      vi.mocked(db.execute).mockResolvedValue([])
      vi.mocked(db.executeTakeFirst).mockResolvedValue({ c: 0 })

      const result = await viewService.queryGrid({
        view: mockView,
        page: 1,
        pageSize: 50,
        filters: {},
        sorting: {}
      })

      expect(result.data).toEqual([])
      expect(result.meta.total).toBe(0)
      expect(result.meta.hasMore).toBe(false)
    })
  })

  describe('queryKanban', () => {
    it('should return kanban structure', async () => {
      const mockView = { id: 'v1', type: 'kanban', config: { groupBy: 'status' } }

      const result = await viewService.queryKanban({
        view: mockView,
        page: 1,
        pageSize: 50,
        filters: {}
      })

      expect(result).toHaveProperty('groups')
      expect(result).toHaveProperty('groupBy', 'status')
      expect(result.meta).toMatchObject({
        total: 0,
        page: 1,
        pageSize: 50,
        hasMore: false
      })
    })
  })
})

// ============================================================================
// Phase 2: RBAC Integration Tests
// ============================================================================

vi.mock('../rbac/table-perms', () => ({
  canReadTable: vi.fn(),
  canWriteTable: vi.fn()
}))

vi.mock('../config/flags', () => ({
  isFeatureEnabled: vi.fn()
}))

describe('ViewService - Phase 2 RBAC Integration', () => {
  const mockUser = { id: 'user123', roles: ['admin'], permissions: [] }
  const mockView = { id: 'v1', table_id: 't1', type: 'grid' }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('queryGridWithRBAC', () => {
    it('should allow query when RBAC check passes', async () => {
      const { canReadTable } = await import('../../rbac/table-perms')
      const { isFeatureEnabled } = await import('../../config/flags')
      const { db } = await import('../../db/db')

      vi.mocked(isFeatureEnabled).mockReturnValue(true)
      vi.mocked(canReadTable).mockResolvedValue(true)
      vi.mocked(db.execute).mockResolvedValue([{ id: 'r1' }])
      vi.mocked(db.executeTakeFirst).mockResolvedValue({ c: 1 })

      const result = await viewService.queryGridWithRBAC(mockUser, {
        view: mockView,
        page: 1,
        pageSize: 50,
        filters: {},
        sorting: {}
      })

      expect(canReadTable).toHaveBeenCalledWith(mockUser, 't1')
      expect(result.data).toBeDefined()
    })

    it('should deny query when RBAC check fails', async () => {
      const { canReadTable } = await import('../../rbac/table-perms')
      const { isFeatureEnabled } = await import('../../config/flags')

      vi.mocked(isFeatureEnabled).mockReturnValue(true)
      vi.mocked(canReadTable).mockResolvedValue(false)

      await expect(
        viewService.queryGridWithRBAC(mockUser, {
          view: mockView,
          page: 1,
          pageSize: 50,
          filters: {},
          sorting: {}
        })
      ).rejects.toThrow('Permission denied')

      expect(canReadTable).toHaveBeenCalledWith(mockUser, 't1')
    })

    it('should fall back to non-RBAC query when flag is disabled', async () => {
      const { canReadTable } = await import('../../rbac/table-perms')
      const { isFeatureEnabled } = await import('../../config/flags')
      const { db } = await import('../../db/db')

      vi.mocked(isFeatureEnabled).mockReturnValue(false)
      vi.mocked(db.execute).mockResolvedValue([])
      vi.mocked(db.executeTakeFirst).mockResolvedValue({ c: 0 })

      const result = await viewService.queryGridWithRBAC(mockUser, {
        view: mockView,
        page: 1,
        pageSize: 50,
        filters: {},
        sorting: {}
      })

      expect(canReadTable).not.toHaveBeenCalled()
      expect(result).toBeDefined()
    })

    it('should skip RBAC check for views without table_id', async () => {
      const { canReadTable } = await import('../../rbac/table-perms')
      const { isFeatureEnabled } = await import('../../config/flags')
      const { db } = await import('../../db/db')

      const viewWithoutTableId = { id: 'v1', type: 'grid' }
      vi.mocked(isFeatureEnabled).mockReturnValue(true)
      vi.mocked(db.execute).mockResolvedValue([])
      vi.mocked(db.executeTakeFirst).mockResolvedValue({ c: 0 })

      await viewService.queryGridWithRBAC(mockUser, {
        view: viewWithoutTableId,
        page: 1,
        pageSize: 50,
        filters: {},
        sorting: {}
      })

      expect(canReadTable).not.toHaveBeenCalled()
    })
  })

  describe('queryKanbanWithRBAC', () => {
    it('should allow query when RBAC check passes', async () => {
      const { canReadTable } = await import('../../rbac/table-perms')
      const { isFeatureEnabled } = await import('../../config/flags')

      vi.mocked(isFeatureEnabled).mockReturnValue(true)
      vi.mocked(canReadTable).mockResolvedValue(true)

      const result = await viewService.queryKanbanWithRBAC(mockUser, {
        view: mockView,
        page: 1,
        pageSize: 50,
        filters: {}
      })

      expect(canReadTable).toHaveBeenCalledWith(mockUser, 't1')
      expect(result).toBeDefined()
    })

    it('should deny query when RBAC check fails', async () => {
      const { canReadTable } = await import('../../rbac/table-perms')
      const { isFeatureEnabled } = await import('../../config/flags')

      vi.mocked(isFeatureEnabled).mockReturnValue(true)
      vi.mocked(canReadTable).mockResolvedValue(false)

      await expect(
        viewService.queryKanbanWithRBAC(mockUser, {
          view: mockView,
          page: 1,
          pageSize: 50,
          filters: {}
        })
      ).rejects.toThrow('Permission denied')
    })
  })

  describe('updateViewConfigWithRBAC', () => {
    it('should allow update when RBAC check passes', async () => {
      const { canWriteTable } = await import('../../rbac/table-perms')
      const { isFeatureEnabled } = await import('../../config/flags')
      const { db } = await import('../../db/db')

      vi.mocked(isFeatureEnabled).mockReturnValue(true)
      vi.mocked(canWriteTable).mockResolvedValue(true)
      vi.mocked(db.executeTakeFirst)
        .mockResolvedValueOnce(mockView) // getViewById
        .mockResolvedValueOnce({ id: 'v1', name: 'Updated' }) // updateViewConfig

      const result = await viewService.updateViewConfigWithRBAC(mockUser, 'v1', { name: 'Updated' })

      expect(canWriteTable).toHaveBeenCalledWith(mockUser, 't1')
      expect(result).toBeDefined()
    })

    it('should deny update when RBAC check fails', async () => {
      const { canWriteTable } = await import('../../rbac/table-perms')
      const { isFeatureEnabled } = await import('../../config/flags')
      const { db } = await import('../../db/db')

      vi.mocked(isFeatureEnabled).mockReturnValue(true)
      vi.mocked(canWriteTable).mockResolvedValue(false)
      vi.mocked(db.executeTakeFirst).mockResolvedValue(mockView)

      await expect(
        viewService.updateViewConfigWithRBAC(mockUser, 'v1', { name: 'Updated' })
      ).rejects.toThrow('Permission denied')
    })

    it('should throw error when view not found', async () => {
      const { isFeatureEnabled } = await import('../../config/flags')
      const { db } = await import('../../db/db')

      vi.mocked(isFeatureEnabled).mockReturnValue(true)
      vi.mocked(db.executeTakeFirst).mockResolvedValue(undefined)

      await expect(
        viewService.updateViewConfigWithRBAC(mockUser, 'non-existent', { name: 'Updated' })
      ).rejects.toThrow('View non-existent not found')
    })
  })
})
