import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'express'
import { isAdmin } from '../../src/rbac/service'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../src/db/pg', () => ({
  pool: null,
}))

vi.mock('../../src/services/SnapshotService', () => ({}))
vi.mock('../../src/audit/audit', () => ({}))

import { initAdminRoutes } from '../../src/routes/admin-routes'

function getRouteHandler(router: Router, method: 'get', routePath: string) {
  const layer = (router as unknown as {
    stack?: Array<{
      route?: {
        path?: string
        methods?: Record<string, boolean>
        stack?: Array<{ handle: (req: any, res: any, next?: any) => Promise<void> | void }>
      }
    }>
  }).stack?.find((item) => item.route?.path === routePath && item.route?.methods?.[method])

  const stack = layer?.route?.stack ?? []
  if (stack.length === 0) {
    throw new Error(`Route handler not found for ${method.toUpperCase()} ${routePath}`)
  }
  return stack
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

describe('admin yjs status route', () => {
  const originalFlag = process.env.ENABLE_YJS_COLLAB

  beforeEach(() => {
    process.env.ENABLE_YJS_COLLAB = 'false'
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  afterEach(() => {
    process.env.ENABLE_YJS_COLLAB = originalFlag
    vi.restoreAllMocks()
  })

  it('returns injected Yjs runtime snapshot for admins', async () => {
    const router = initAdminRoutes({
      getYjsStatus: () => ({
        enabled: true,
        initialized: true,
        sync: { activeDocCount: 2, docIds: ['rec_1', 'rec_2'] },
        bridge: {
          pendingWriteCount: 1,
          observedDocCount: 2,
          flushSuccessCount: 5,
          flushFailureCount: 1,
        },
        socket: { activeRecordCount: 2, activeSocketCount: 3 },
      }),
    })

    const handlers = getRouteHandler(router, 'get', '/yjs/status')
    const response = createMockResponse()
    const next = vi.fn()

    await handlers[0]?.handle({ user: { id: 'admin_1', email: 'admin@example.com' } }, response, next)
    expect(next).toHaveBeenCalledTimes(1)

    await handlers[1]?.handle({ user: { id: 'admin_1', email: 'admin@example.com' } }, response)

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      success: true,
      yjs: {
        enabled: true,
        initialized: true,
        sync: { activeDocCount: 2, docIds: ['rec_1', 'rec_2'] },
        bridge: {
          pendingWriteCount: 1,
          observedDocCount: 2,
          flushSuccessCount: 5,
          flushFailureCount: 1,
        },
        socket: { activeRecordCount: 2, activeSocketCount: 3 },
      },
    })
  })

  it('falls back to feature-flag status when runtime is not initialized', async () => {
    process.env.ENABLE_YJS_COLLAB = 'true'
    const router = initAdminRoutes()
    const handlers = getRouteHandler(router, 'get', '/yjs/status')
    const response = createMockResponse()

    await handlers[0]?.handle({ user: { id: 'admin_2', email: 'admin@example.com' } }, response, vi.fn())
    await handlers[1]?.handle({ user: { id: 'admin_2', email: 'admin@example.com' } }, response)

    expect(response.body).toEqual({
      success: true,
      yjs: {
        enabled: true,
        initialized: false,
        sync: null,
        bridge: null,
        socket: null,
      },
    })
  })
})
