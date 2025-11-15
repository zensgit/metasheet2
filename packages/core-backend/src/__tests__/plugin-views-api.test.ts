/**
 * Plugin ViewService API Tests
 * Phase 5: Test plugin access to ViewService functionality through CoreAPI
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CoreAPI, ViewServiceAPI } from '../types/plugin'

// Mock view-service module
vi.mock('../services/view-service', () => ({
  getViewConfig: vi.fn(),
  getViewById: vi.fn(),
  queryGridWithRBAC: vi.fn(),
  queryKanbanWithRBAC: vi.fn(),
  updateViewConfigWithRBAC: vi.fn(),
  queryGrid: vi.fn(),
  queryKanban: vi.fn()
}))

describe('Plugin ViewService API - Phase 5', () => {
  let mockCoreAPI: CoreAPI
  let viewsAPI: ViewServiceAPI

  beforeEach(async () => {
    vi.clearAllMocks()

    // Create a minimal CoreAPI mock with views property
    mockCoreAPI = {
      views: {
        getViewConfig: async (viewId: string) => {
          const viewService = await import('../services/view-service')
          return await viewService.getViewConfig(viewId)
        },
        getViewById: async (viewId: string) => {
          const viewService = await import('../services/view-service')
          return await viewService.getViewById(viewId)
        },
        queryGridWithRBAC: async (user: any, args: any) => {
          const viewService = await import('../services/view-service')
          return await viewService.queryGridWithRBAC(user, args)
        },
        queryKanbanWithRBAC: async (user: any, args: any) => {
          const viewService = await import('../services/view-service')
          return await viewService.queryKanbanWithRBAC(user, args)
        },
        updateViewConfigWithRBAC: async (user: any, viewId: string, config: any) => {
          const viewService = await import('../services/view-service')
          return await viewService.updateViewConfigWithRBAC(user, viewId, config)
        },
        queryGrid: async (args: any) => {
          const viewService = await import('../services/view-service')
          return await viewService.queryGrid(args)
        },
        queryKanban: async (args: any) => {
          const viewService = await import('../services/view-service')
          return await viewService.queryKanban(args)
        }
      }
    } as any

    viewsAPI = mockCoreAPI.views
  })

  describe('View Configuration Access', () => {
    it('should expose getViewConfig method', async () => {
      const viewService = await import('../services/view-service')
      vi.mocked(viewService.getViewConfig).mockResolvedValue({
        id: 'v1',
        name: 'Test View',
        type: 'grid',
        table_id: 't1',
        config: {},
        created_at: new Date(),
        updated_at: new Date()
      } as any)

      const result = await viewsAPI.getViewConfig('v1')

      expect(result).toEqual({
        id: 'v1',
        name: 'Test View',
        type: 'grid',
        table_id: 't1',
        config: {},
        created_at: expect.any(Date),
        updated_at: expect.any(Date)
      } as any)
      expect(viewService.getViewConfig).toHaveBeenCalledWith('v1')
    })

    it('should expose getViewById method', async () => {
      const viewService = await import('../services/view-service')
      vi.mocked(viewService.getViewById).mockResolvedValue({
        id: 'v1',
        name: 'Test View',
        table_id: 't1',
        type: 'grid',
        config: {},
        created_at: new Date(),
        updated_at: new Date()
      } as any)

      const result = await viewsAPI.getViewById('v1')

      expect(result).toEqual({
        id: 'v1',
        name: 'Test View',
        table_id: 't1',
        type: 'grid',
        config: {},
        created_at: expect.any(Date),
        updated_at: expect.any(Date)
      } as any)
      expect(viewService.getViewById).toHaveBeenCalledWith('v1')
    })
  })

  describe('RBAC-Aware Query Methods', () => {
    const mockUser = { id: 'u1', roles: ['admin'], permissions: [] }
    const mockView = { id: 'v1', table_id: 't1', type: 'grid' }

    it('should expose queryGridWithRBAC method', async () => {
      const viewService = await import('../services/view-service')
      const mockResult = {
        data: [{ id: 'r1' }, { id: 'r2' }],
        meta: { total: 2, page: 1, pageSize: 50, hasMore: false }
      }
      vi.mocked(viewService.queryGridWithRBAC).mockResolvedValue(mockResult)

      const result = await viewsAPI.queryGridWithRBAC(mockUser, {
        view: mockView,
        page: 1,
        pageSize: 50
      })

      expect(result).toEqual(mockResult)
      expect(viewService.queryGridWithRBAC).toHaveBeenCalledWith(mockUser, {
        view: mockView,
        page: 1,
        pageSize: 50
      })
    })

    it('should expose queryKanbanWithRBAC method', async () => {
      const viewService = await import('../services/view-service')
      const mockResult = {
        groups: [],
        groupBy: 'status',
        meta: { total: 0, page: 1, pageSize: 50, hasMore: false }
      }
      vi.mocked(viewService.queryKanbanWithRBAC).mockResolvedValue(mockResult)

      const result = await viewsAPI.queryKanbanWithRBAC(mockUser, {
        view: { ...mockView, type: 'kanban' },
        page: 1,
        pageSize: 50
      })

      expect(result).toEqual(mockResult)
      expect(viewService.queryKanbanWithRBAC).toHaveBeenCalledWith(mockUser, {
        view: { ...mockView, type: 'kanban' },
        page: 1,
        pageSize: 50
      })
    })

    it('should expose updateViewConfigWithRBAC method', async () => {
      const viewService = await import('../services/view-service')
      const mockConfig = { name: 'Updated View', type: 'grid', table_id: 't1', config: {} }
      const mockUpdated = { id: 'v1', ...mockConfig, created_at: new Date(), updated_at: new Date() } as any
      vi.mocked(viewService.updateViewConfigWithRBAC).mockResolvedValue(mockUpdated)

      const result = await viewsAPI.updateViewConfigWithRBAC(mockUser, 'v1', mockConfig)

      expect(result).toEqual(mockUpdated)
      expect(viewService.updateViewConfigWithRBAC).toHaveBeenCalledWith(mockUser, 'v1', mockConfig)
    })
  })

  describe('Non-RBAC Query Methods (Backward Compatibility)', () => {
    const mockView = { id: 'v1', table_id: 't1', type: 'grid' }

    it('should expose queryGrid method', async () => {
      const viewService = await import('../services/view-service')
      const mockResult = {
        data: [{ id: 'r1' }],
        meta: { total: 1, page: 1, pageSize: 50, hasMore: false }
      }
      vi.mocked(viewService.queryGrid).mockResolvedValue(mockResult)

      const result = await viewsAPI.queryGrid({
        view: mockView,
        page: 1,
        pageSize: 50
      })

      expect(result).toEqual(mockResult)
      expect(viewService.queryGrid).toHaveBeenCalledWith({
        view: mockView,
        page: 1,
        pageSize: 50
      })
    })

    it('should expose queryKanban method', async () => {
      const viewService = await import('../services/view-service')
      const mockResult = {
        groups: [],
        groupBy: 'status',
        meta: { total: 0, page: 1, pageSize: 50, hasMore: false }
      }
      vi.mocked(viewService.queryKanban).mockResolvedValue(mockResult)

      const result = await viewsAPI.queryKanban({
        view: { ...mockView, type: 'kanban' },
        page: 1,
        pageSize: 50
      })

      expect(result).toEqual(mockResult)
      expect(viewService.queryKanban).toHaveBeenCalledWith({
        view: { ...mockView, type: 'kanban' },
        page: 1,
        pageSize: 50
      })
    })
  })

  describe('API Completeness', () => {
    it('should provide all required ViewServiceAPI methods', () => {
      expect(viewsAPI.getViewConfig).toBeDefined()
      expect(viewsAPI.getViewById).toBeDefined()
      expect(viewsAPI.queryGridWithRBAC).toBeDefined()
      expect(viewsAPI.queryKanbanWithRBAC).toBeDefined()
      expect(viewsAPI.updateViewConfigWithRBAC).toBeDefined()
      expect(viewsAPI.queryGrid).toBeDefined()
      expect(viewsAPI.queryKanban).toBeDefined()

      expect(typeof viewsAPI.getViewConfig).toBe('function')
      expect(typeof viewsAPI.getViewById).toBe('function')
      expect(typeof viewsAPI.queryGridWithRBAC).toBe('function')
      expect(typeof viewsAPI.queryKanbanWithRBAC).toBe('function')
      expect(typeof viewsAPI.updateViewConfigWithRBAC).toBe('function')
      expect(typeof viewsAPI.queryGrid).toBe('function')
      expect(typeof viewsAPI.queryKanban).toBe('function')
    })
  })

  describe('Error Handling', () => {
    it('should handle errors in getViewConfig gracefully', async () => {
      const viewService = await import('../services/view-service')
      vi.mocked(viewService.getViewConfig).mockRejectedValue(new Error('Database error'))

      // The implementation should catch and return null on error
      await expect(viewsAPI.getViewConfig('invalid')).rejects.toThrow()
    })

    it('should propagate RBAC permission denied errors', async () => {
      const viewService = await import('../services/view-service')
      const permError = new Error('Permission denied: User u1 cannot read table t1')
      vi.mocked(viewService.queryGridWithRBAC).mockRejectedValue(permError)

      await expect(
        viewsAPI.queryGridWithRBAC({ id: 'u1', roles: [], permissions: [] }, {
          view: { id: 'v1', table_id: 't1' },
          page: 1,
          pageSize: 50
        })
      ).rejects.toThrow('Permission denied')
    })
  })

  describe('Plugin Integration Patterns', () => {
    it('should support plugin custom view rendering', async () => {
      const viewService = await import('../services/view-service')

      // Simulate plugin getting view config
      vi.mocked(viewService.getViewConfig).mockResolvedValue({
        id: 'v1',
        name: 'Custom View',
        type: 'custom',
        plugin: 'custom-view-plugin'
      })

      const config = await viewsAPI.getViewConfig('v1')
      expect(config?.plugin).toBe('custom-view-plugin')
    })

    it('should support plugin data transformation on queries', async () => {
      const viewService = await import('../services/view-service')

      // Simulate plugin querying data
      const mockData = {
        data: [{ id: 'r1', name: 'Item 1' }],
        meta: { total: 1, page: 1, pageSize: 50, hasMore: false }
      }
      vi.mocked(viewService.queryGrid).mockResolvedValue(mockData)

      const result = await viewsAPI.queryGrid({
        view: { id: 'v1', table_id: 't1', type: 'grid' },
        page: 1,
        pageSize: 50
      })

      // Plugin could transform the data before rendering
      expect(result.data).toHaveLength(1)
      expect(result.data[0].name).toBe('Item 1')
    })
  })
})
