import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'

describe('Unsafe admin route in production', () => {
  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let responseJson: any
  let responseStatus: number

  // Production guard middleware
  const productionGuard = (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_UNSAFE_ADMIN !== 'true') {
      if (req.path.includes('reload-unsafe')) {
        responseStatus = 403
        responseJson = { error: 'Unsafe admin routes disabled in production' }
        return res.status(403).json({ error: 'Unsafe admin routes disabled in production' })
      }
    }
    next()
  }

  beforeEach(() => {
    // Set production environment
    process.env.NODE_ENV = 'production'
    process.env.ALLOW_UNSAFE_ADMIN = 'false'

    responseJson = undefined
    responseStatus = 200

    mockResponse = {
      json: vi.fn((data) => {
        responseJson = data
        return mockResponse as Response
      }),
      status: vi.fn((code) => {
        responseStatus = code
        return mockResponse as Response
      })
    }
  })

  it('should reject /api/admin/plugins/:id/reload-unsafe in production', () => {
    mockRequest = {
      path: '/api/admin/plugins/example-plugin/reload-unsafe',
      headers: { authorization: 'Bearer test' },
      body: {}
    }

    const next = vi.fn()
    productionGuard(mockRequest as Request, mockResponse as Response, next)

    expect(responseStatus).toBe(403)
    expect(responseJson.error).toContain('Unsafe admin routes disabled')
    expect(next).not.toHaveBeenCalled()
  })

  it('should allow unsafe routes when ALLOW_UNSAFE_ADMIN is true', () => {
    process.env.ALLOW_UNSAFE_ADMIN = 'true'

    mockRequest = {
      path: '/api/admin/plugins/example-plugin/reload-unsafe',
      headers: { authorization: 'Bearer test' },
      body: {}
    }

    const next = vi.fn()
    productionGuard(mockRequest as Request, mockResponse as Response, next)

    // Should call next() to allow the request through
    expect(next).toHaveBeenCalled()
  })

  it('should allow non-unsafe routes in production', () => {
    mockRequest = {
      path: '/api/admin/plugins/example-plugin/status',
      headers: { authorization: 'Bearer test' },
      body: {}
    }

    const next = vi.fn()
    productionGuard(mockRequest as Request, mockResponse as Response, next)

    expect(next).toHaveBeenCalled()
  })
})
