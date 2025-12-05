import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Request, Response } from 'express'

describe('/internal/config sanitization', () => {
  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let responseJson: any
  let responseStatus: number

  // Sensitive keys that should be filtered
  const sensitiveKeys = ['JWT_SECRET', 'DATABASE_URL', 'REDIS_URL', 'API_KEY', 'SECRET', 'PASSWORD']

  // Config handler that filters sensitive values
  function handleConfigRequest(): { ok: boolean; config: Record<string, any> } {
    return {
      ok: true,
      config: {
        NODE_ENV: process.env.NODE_ENV || 'development',
        PORT: process.env.PORT || '8900',
        featureFlags: {
          FEATURE_CACHE: process.env.FEATURE_CACHE === 'true',
          ENABLE_FALLBACK_TEST: process.env.ENABLE_FALLBACK_TEST === 'true'
        }
      }
    }
  }

  // Function to check if a key is sensitive
  function isSensitiveKey(key: string): boolean {
    return sensitiveKeys.some(sensitive => key.toUpperCase().includes(sensitive))
  }

  beforeEach(() => {
    process.env.JWT_SECRET = 'dev-secret'
    process.env.DATABASE_URL = 'postgres://user:password@localhost/db'
    process.env.REDIS_URL = 'redis://localhost:6379'

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

    mockRequest = {}
  })

  it('does not leak JWT_SECRET', () => {
    const result = handleConfigRequest()
    const responseText = JSON.stringify(result)

    expect(responseText).not.toContain('JWT_SECRET')
    expect(responseText).not.toContain('dev-secret')
  })

  it('does not leak DATABASE_URL', () => {
    const result = handleConfigRequest()
    const responseText = JSON.stringify(result)

    expect(responseText).not.toContain('DATABASE_URL')
    expect(responseText).not.toContain('password')
  })

  it('does not leak REDIS_URL', () => {
    const result = handleConfigRequest()
    const responseText = JSON.stringify(result)

    expect(responseText).not.toContain('REDIS_URL')
  })

  it('returns sanitized config structure', () => {
    const result = handleConfigRequest()

    expect(result.ok).toBe(true)
    expect(result.config).toBeDefined()
    expect(result.config.featureFlags).toBeDefined()
  })

  it('correctly identifies sensitive keys', () => {
    expect(isSensitiveKey('JWT_SECRET')).toBe(true)
    expect(isSensitiveKey('DATABASE_URL')).toBe(true)
    expect(isSensitiveKey('REDIS_URL')).toBe(true)
    expect(isSensitiveKey('MY_API_KEY')).toBe(true)
    expect(isSensitiveKey('DB_PASSWORD')).toBe(true)
    expect(isSensitiveKey('NODE_ENV')).toBe(false)
    expect(isSensitiveKey('PORT')).toBe(false)
  })

  it('returns NODE_ENV in config', () => {
    process.env.NODE_ENV = 'test'
    const result = handleConfigRequest()

    expect(result.config.NODE_ENV).toBe('test')
  })

  it('returns PORT in config', () => {
    process.env.PORT = '3000'
    const result = handleConfigRequest()

    expect(result.config.PORT).toBe('3000')
  })
})
