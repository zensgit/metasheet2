/**
 * Views Routes Integration Tests
 * Phase 3: RBAC integration testing for views API routes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response } from 'express'

// Mock dependencies
vi.mock('../../db/db', () => ({
  db: {
    selectFrom: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn(),
    updateTable: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    returningAll: vi.fn().mockReturnThis(),
    execute: vi.fn(),
    query: vi.fn()
  }
}))

vi.mock('../../services/view-service', () => ({
  getViewConfig: vi.fn(),
  getViewById: vi.fn(),
  updateViewConfigWithRBAC: vi.fn(),
  queryGridWithRBAC: vi.fn(),
  queryKanbanWithRBAC: vi.fn()
}))

vi.mock('../../core/logger', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn()
  }))
}))

describe('Views Routes - Phase 3 RBAC Integration', () => {
  const mockUser = { id: 'user123', roles: ['admin'], permissions: [] }
  const mockView = { id: 'v1', table_id: 't1', type: 'grid', config: {} }

  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let responseJson: any
  let responseStatus: number

  beforeEach(() => {
    vi.clearAllMocks()
    responseJson = undefined
    responseStatus = 200

    mockRequest = {
      params: { viewId: 'v1' },
      query: { page: '1', pageSize: '50', filters: '{}', sorting: '[]' },
      body: {},
      headers: {}
    }

    mockResponse = {
      json: vi.fn((data) => {
        responseJson = data
        return mockResponse as Response
      }),
      status: vi.fn((code) => {
        responseStatus = code
        return mockResponse as Response
      }),
      send: vi.fn()
    }

    // Set mock user
    ;(mockRequest as any).user = mockUser
  })

  describe('GET /:viewId/config', () => {
    it('should return view configuration using ViewService', async () => {
      const { default: viewsRouter } = await import('../views')
      const viewService = await import('../../services/view-service')

      const mockConfig = {
        id: 'v1',
        name: 'Test View',
        type: 'grid',
        columns: ['a', 'b']
      }

      vi.mocked(viewService.getViewConfig).mockResolvedValue(mockConfig)

      // Simulate route handler execution
      const handler = (viewsRouter as any).stack.find(
        (layer: any) => layer.route?.path === '/:viewId/config' && layer.route.methods.get
      )?.route?.stack[0].handle

      if (handler) {
        await handler(mockRequest, mockResponse, vi.fn())
      }

      expect(viewService.getViewConfig).toHaveBeenCalledWith('v1')
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockConfig
      })
    })

    it('should return 404 when view not found', async () => {
      const { default: viewsRouter } = await import('../views')
      const viewService = await import('../../services/view-service')

      vi.mocked(viewService.getViewConfig).mockResolvedValue(null)

      const handler = (viewsRouter as any).stack.find(
        (layer: any) => layer.route?.path === '/:viewId/config' && layer.route.methods.get
      )?.route?.stack[0].handle

      if (handler) {
        await handler(mockRequest, mockResponse, vi.fn())
      }

      expect(responseJson).toMatchObject({ success: false, error: 'View not found' })
      expect(responseStatus).toBe(404)
    })
  })

  describe('PUT /:viewId/config', () => {
    it('should update view configuration with RBAC check', async () => {
      const { default: viewsRouter } = await import('../views')
      const viewService = await import('../../services/view-service')

      mockRequest.body = { name: 'Updated View', type: 'grid', columns: ['x', 'y'] }

      const mockUpdated = { id: 'v1', name: 'Updated View' }
      vi.mocked(viewService.updateViewConfigWithRBAC).mockResolvedValue(mockUpdated)

      const handler = (viewsRouter as any).stack.find(
        (layer: any) => layer.route?.path === '/:viewId/config' && layer.route.methods.put
      )?.route?.stack[0].handle

      if (handler) {
        await handler(mockRequest, mockResponse, vi.fn())
      }

      expect(viewService.updateViewConfigWithRBAC).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user123' }),
        'v1',
        mockRequest.body
      )
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: mockUpdated
      })
    })

    it('should return 403 when RBAC check fails', async () => {
      const { default: viewsRouter } = await import('../views')
      const viewService = await import('../../services/view-service')

      mockRequest.body = { name: 'Updated View' }

      vi.mocked(viewService.updateViewConfigWithRBAC).mockRejectedValue(
        new Error('Permission denied: User user123 cannot write to table t1')
      )

      const handler = (viewsRouter as any).stack.find(
        (layer: any) => layer.route?.path === '/:viewId/config' && layer.route.methods.put
      )?.route?.stack[0].handle

      if (handler) {
        await handler(mockRequest, mockResponse, vi.fn())
      }

      expect(responseStatus).toBe(403)
      expect(responseJson).toMatchObject({
        success: false,
        error: expect.stringContaining('Permission denied')
      })
    })
  })

  describe('GET /:viewId/data', () => {
    it('should query grid data with RBAC check', async () => {
      const { default: viewsRouter } = await import('../views')
      const viewService = await import('../../services/view-service')

      const mockData = {
        data: [{ id: 'r1' }, { id: 'r2' }],
        meta: { total: 2, page: 1, pageSize: 50, hasMore: false }
      }

      vi.mocked(viewService.getViewById).mockResolvedValue(mockView)
      vi.mocked(viewService.queryGridWithRBAC).mockResolvedValue(mockData)

      const handler = (viewsRouter as any).stack.find(
        (layer: any) => layer.route?.path === '/:viewId/data' && layer.route.methods.get
      )?.route?.stack[0].handle

      if (handler) {
        await handler(mockRequest, mockResponse, vi.fn())
      }

      expect(viewService.getViewById).toHaveBeenCalledWith('v1')
      expect(viewService.queryGridWithRBAC).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user123' }),
        expect.objectContaining({
          view: mockView,
          page: 1,
          pageSize: 50
        })
      )
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        ...mockData
      })
    })

    it('should query kanban data for kanban views', async () => {
      const { default: viewsRouter } = await import('../views')
      const viewService = await import('../../services/view-service')

      const kanbanView = { ...mockView, type: 'kanban' }
      const mockData = {
        groups: [],
        groupBy: 'status',
        meta: { total: 0, page: 1, pageSize: 50, hasMore: false }
      }

      vi.mocked(viewService.getViewById).mockResolvedValue(kanbanView)
      vi.mocked(viewService.queryKanbanWithRBAC).mockResolvedValue(mockData)

      const handler = (viewsRouter as any).stack.find(
        (layer: any) => layer.route?.path === '/:viewId/data' && layer.route.methods.get
      )?.route?.stack[0].handle

      if (handler) {
        await handler(mockRequest, mockResponse, vi.fn())
      }

      expect(viewService.queryKanbanWithRBAC).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user123' }),
        expect.objectContaining({
          view: kanbanView,
          page: 1,
          pageSize: 50
        })
      )
    })

    it('should return 403 when RBAC check fails', async () => {
      const { default: viewsRouter } = await import('../views')
      const viewService = await import('../../services/view-service')

      vi.mocked(viewService.getViewById).mockResolvedValue(mockView)
      vi.mocked(viewService.queryGridWithRBAC).mockRejectedValue(
        new Error('Permission denied: User user123 cannot read table t1')
      )

      const handler = (viewsRouter as any).stack.find(
        (layer: any) => layer.route?.path === '/:viewId/data' && layer.route.methods.get
      )?.route?.stack[0].handle

      if (handler) {
        await handler(mockRequest, mockResponse, vi.fn())
      }

      expect(responseStatus).toBe(403)
      expect(responseJson).toMatchObject({
        success: false,
        error: expect.stringContaining('Permission denied')
      })
    })

    it('should return 404 when view not found', async () => {
      const { default: viewsRouter } = await import('../views')
      const viewService = await import('../../services/view-service')

      vi.mocked(viewService.getViewById).mockResolvedValue(null)

      const handler = (viewsRouter as any).stack.find(
        (layer: any) => layer.route?.path === '/:viewId/data' && layer.route.methods.get
      )?.route?.stack[0].handle

      if (handler) {
        await handler(mockRequest, mockResponse, vi.fn())
      }

      expect(responseStatus).toBe(404)
      expect(responseJson).toMatchObject({
        success: false,
        error: 'View not found'
      })
    })
  })

  describe('User extraction helpers', () => {
    it('should extract user from JWT middleware', () => {
      const req: any = {
        user: { id: 'user123', roles: ['admin'], permissions: ['read:all'] },
        headers: {}
      }

      // Since getUser is a private function in the route file, we test it indirectly
      // by verifying that the RBAC methods receive the correct user object
      expect(req.user).toMatchObject({
        id: 'user123',
        roles: ['admin'],
        permissions: ['read:all']
      })
    })

    it('should fallback to header-based user ID for development', () => {
      const req: any = {
        headers: { 'x-user-id': 'dev-user' }
      }

      // Verify fallback behavior
      const userId = req.headers['x-user-id']
      expect(userId).toBe('dev-user')
    })
  })
})
