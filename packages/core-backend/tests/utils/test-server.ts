/**
 * Test server utilities
 * Provides Express app setup and request helpers for testing
 */

import express, { type Express } from 'express'
import request from 'supertest'
import { vi } from 'vitest'

// Mock authentication middleware
export const mockAuth = (userId: string = 'test-user-id') => {
  return (req: any, res: any, next: any) => {
    req.user = { id: userId }
    next()
  }
}

// Create test Express app
export function createTestApp(withAuth: boolean = false): Express {
  const app = express()

  // Basic middleware
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))

  // Add mock auth if requested
  if (withAuth) {
    app.use(mockAuth())
  }

  return app
}

// Request helpers
export class TestRequest {
  constructor(private app: Express) {}

  get(path: string) {
    return request(this.app).get(path)
  }

  post(path: string, data?: any) {
    const req = request(this.app).post(path)
    if (data) {
      req.send(data)
    }
    return req
  }

  put(path: string, data?: any) {
    const req = request(this.app).put(path)
    if (data) {
      req.send(data)
    }
    return req
  }

  delete(path: string) {
    return request(this.app).delete(path)
  }
}

// Response matchers
export const responseMatchers = {
  toHaveSuccessResponse: (received: any) => {
    const hasOk = received.body?.ok === true
    const hasData = 'data' in received.body
    const pass = hasOk && hasData

    return {
      pass,
      message: () => pass
        ? 'Expected response not to be successful'
        : `Expected response to be successful with ok: true and data field. Got: ${JSON.stringify(received.body)}`
    }
  },

  toHaveErrorResponse: (received: any, expectedCode?: string) => {
    const hasOk = received.body?.ok === false
    const hasError = 'error' in received.body
    const codeMatches = !expectedCode || received.body?.error?.code === expectedCode
    const pass = hasOk && hasError && codeMatches

    return {
      pass,
      message: () => pass
        ? `Expected response not to be error${expectedCode ? ` with code ${expectedCode}` : ''}`
        : `Expected response to be error${expectedCode ? ` with code ${expectedCode}` : ''}. Got: ${JSON.stringify(received.body)}`
    }
  },

  toHaveStatus: (received: any, expectedStatus: number) => {
    const pass = received.status === expectedStatus

    return {
      pass,
      message: () => pass
        ? `Expected status not to be ${expectedStatus}`
        : `Expected status ${expectedStatus}, but got ${received.status}`
    }
  }
}

// Mock database setup for tests
export function setupMockDatabase() {
  const mockDb = {
    selectFrom: vi.fn(),
    insertInto: vi.fn(),
    updateTable: vi.fn(),
    deleteFrom: vi.fn(),
    transaction: vi.fn(),
    fn: { max: vi.fn() }
  }

  // Mock the db import
  vi.doMock('../../src/db/db', () => ({
    db: mockDb
  }))

  return mockDb
}

// Helper to create mock request with user context
export function createMockRequest(overrides: any = {}) {
  return {
    params: {},
    query: {},
    body: {},
    user: { id: 'test-user-id' },
    ...overrides
  }
}

// Helper to create mock response
export function createMockResponse() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis()
  }

  return res
}