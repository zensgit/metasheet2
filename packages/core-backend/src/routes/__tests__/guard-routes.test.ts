import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'

describe('Production Guards', () => {
  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let responseJson: any
  let responseStatus: number

  // Fallback test guard middleware
  const fallbackTestGuard = (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === 'production' && process.env.ENABLE_FALLBACK_TEST !== 'true') {
      if (req.path.includes('/internal/test/fallback')) {
        return res.status(404).json({ error: 'Not found' })
      }
    }
    next()
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOW_UNSAFE_ADMIN = 'false'
    process.env.ENABLE_FALLBACK_TEST = 'false'

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

  it('hides fallback test route in production when disabled', () => {
    mockRequest = {
      path: '/internal/test/fallback',
      body: { mode: 'http_error' }
    }

    const next = vi.fn()
    fallbackTestGuard(mockRequest as Request, mockResponse as Response, next)

    expect(responseStatus).toBe(404)
    expect(next).not.toHaveBeenCalled()
  })

  it('allows fallback test route when ENABLE_FALLBACK_TEST is true', () => {
    process.env.ENABLE_FALLBACK_TEST = 'true'

    mockRequest = {
      path: '/internal/test/fallback',
      body: { mode: 'http_error' }
    }

    const next = vi.fn()
    fallbackTestGuard(mockRequest as Request, mockResponse as Response, next)

    expect(next).toHaveBeenCalled()
  })

  it('allows fallback test route in non-production environments', () => {
    process.env.NODE_ENV = 'development'

    mockRequest = {
      path: '/internal/test/fallback',
      body: { mode: 'http_error' }
    }

    const next = vi.fn()
    fallbackTestGuard(mockRequest as Request, mockResponse as Response, next)

    expect(next).toHaveBeenCalled()
  })

  it('allows other routes in production', () => {
    mockRequest = {
      path: '/api/some-other-route',
      body: {}
    }

    const next = vi.fn()
    fallbackTestGuard(mockRequest as Request, mockResponse as Response, next)

    expect(next).toHaveBeenCalled()
  })
})
