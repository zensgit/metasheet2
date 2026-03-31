import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  authUser: {
    id: 'admin-1',
    role: 'user',
  },
}))

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

const syncMocks = vi.hoisted(() => ({
  getDirectorySyncStatus: vi.fn(),
  acknowledgeAlert: vi.fn(),
  getDirectorySyncHistory: vi.fn(),
}))

const deprovisionMocks = vi.hoisted(() => ({
  listDeprovisions: vi.fn(),
  getDeprovision: vi.fn(),
  rollbackDeprovision: vi.fn(),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: (error?: unknown) => void) => {
    req.user = state.authUser as never
    next()
  },
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isAdmin,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

vi.mock('../../src/directory/DirectorySyncService', () => ({
  getDirectorySyncStatus: syncMocks.getDirectorySyncStatus,
  acknowledgeAlert: syncMocks.acknowledgeAlert,
  getDirectorySyncHistory: syncMocks.getDirectorySyncHistory,
}))

vi.mock('../../src/directory/deprovision-ledger', () => ({
  listDeprovisions: deprovisionMocks.listDeprovisions,
  getDeprovision: deprovisionMocks.getDeprovision,
  rollbackDeprovision: deprovisionMocks.rollbackDeprovision,
}))

import { adminDirectoryRouter } from '../../src/routes/admin-directory'

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    headers: {} as Record<string, string>,
    textBody: '',
    status(code: number) {
      this.statusCode = code
      return this
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = String(value)
      return this
    },
    write(chunk: unknown) {
      this.textBody += String(chunk)
      return true
    },
    end(chunk?: unknown) {
      if (chunk != null) this.textBody += String(chunk)
      this.headersSent = true
      return this
    },
    json(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
  } as Response & {
    statusCode: number
    body: unknown
    headersSent: boolean
    headers: Record<string, string>
    textBody: string
  }
}

async function invokeRoute(
  method: 'get' | 'post',
  path: string,
  options: {
    query?: Record<string, unknown>
    params?: Record<string, string>
    body?: Record<string, unknown>
  } = {},
) {
  const router = adminDirectoryRouter()
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: {},
    query: options.query ?? {},
    params: options.params ?? {},
    body: options.body ?? {},
    user: undefined,
  } as unknown as Request

  const res = createMockResponse()

  for (const routeLayer of layer.route.stack) {
    await new Promise<void>((resolve, reject) => {
      try {
        const maybePromise = routeLayer.handle(req, res, (error?: unknown) => {
          if (error) reject(error)
          else resolve()
        })
        if (maybePromise && typeof maybePromise.then === 'function') {
          Promise.resolve(maybePromise).then(() => resolve()).catch(reject)
        } else if (routeLayer.handle.length < 3) {
          resolve()
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  return res
}

describe('admin-directory routes', () => {
  beforeEach(() => {
    state.authUser = { id: 'admin-1', role: 'user' }
    rbacMocks.isAdmin.mockReset()
    auditMocks.auditLog.mockReset()
    syncMocks.getDirectorySyncStatus.mockReset()
    syncMocks.acknowledgeAlert.mockReset()
    syncMocks.getDirectorySyncHistory.mockReset()
    deprovisionMocks.listDeprovisions.mockReset()
    deprovisionMocks.getDeprovision.mockReset()
    deprovisionMocks.rollbackDeprovision.mockReset()
  })

  it('returns sync status for admin', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    syncMocks.getDirectorySyncStatus.mockResolvedValue({
      lastSyncAt: '2026-03-30T10:00:00.000Z',
      nextSyncAt: '2026-03-30T11:00:00.000Z',
      status: 'completed',
      hasAlert: false,
      alertMessage: null,
      alertAcknowledgedAt: null,
      alertAcknowledgedBy: null,
    })

    const res = await invokeRoute('get', '/api/admin/directory/sync/status')

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        status: 'completed',
        hasAlert: false,
      },
    })
  })

  it('rejects non-admin access to sync status', async () => {
    rbacMocks.isAdmin.mockResolvedValue(false)

    const res = await invokeRoute('get', '/api/admin/directory/sync/status')

    expect(res.statusCode).toBe(403)
  })

  it('acknowledges alert and logs audit', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    syncMocks.acknowledgeAlert.mockResolvedValue({
      lastSyncAt: '2026-03-30T10:00:00.000Z',
      nextSyncAt: null,
      status: 'failed',
      hasAlert: false,
      alertMessage: 'Sync failed',
      alertAcknowledgedAt: '2026-03-30T10:05:00.000Z',
      alertAcknowledgedBy: 'admin-1',
    })

    const res = await invokeRoute('post', '/api/admin/directory/sync/acknowledge')

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ ok: true })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'directory.sync.acknowledge',
        resourceType: 'directory-sync',
      }),
    )
  })

  it('returns paginated sync history', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    syncMocks.getDirectorySyncHistory.mockResolvedValue({
      items: [
        { id: 'h-1', status: 'completed', message: null, syncedCount: 42, failedCount: 0, createdAt: '2026-03-30T10:00:00.000Z' },
      ],
      total: 1,
    })

    const res = await invokeRoute('get', '/api/admin/directory/sync/history', {
      query: { page: '1', pageSize: '10' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ ok: true })
    const body = res.body as { data: { items: unknown[]; total: number; page: number; pageSize: number } }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.total).toBe(1)
    expect(body.data.page).toBeDefined()
    expect(body.data.pageSize).toBeDefined()
  })

  it('returns paginated deprovision list', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    deprovisionMocks.listDeprovisions.mockResolvedValue({
      items: [
        {
          id: 'dp-1',
          targetUserId: 'user-99',
          performedBy: 'admin-1',
          reason: 'Left company',
          userSnapshot: {},
          status: 'executed',
          rolledBackBy: null,
          rolledBackAt: null,
          createdAt: '2026-03-30T10:00:00.000Z',
          updatedAt: '2026-03-30T10:00:00.000Z',
        },
      ],
      total: 1,
    })

    const res = await invokeRoute('get', '/api/admin/directory/deprovisions', {
      query: { page: '1', pageSize: '10' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.body as { data: { items: unknown[]; total: number } }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.total).toBe(1)
  })

  it('returns single deprovision by id', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    deprovisionMocks.getDeprovision.mockResolvedValue({
      id: 'dp-1',
      targetUserId: 'user-99',
      performedBy: 'admin-1',
      reason: 'Left company',
      userSnapshot: { email: 'user@example.com', role: 'user' },
      status: 'executed',
      rolledBackBy: null,
      rolledBackAt: null,
      createdAt: '2026-03-30T10:00:00.000Z',
      updatedAt: '2026-03-30T10:00:00.000Z',
    })

    const res = await invokeRoute('get', '/api/admin/directory/deprovisions/:id', {
      params: { id: 'dp-1' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      data: { id: 'dp-1', status: 'executed' },
    })
  })

  it('returns 404 for missing deprovision', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    deprovisionMocks.getDeprovision.mockResolvedValue(null)

    const res = await invokeRoute('get', '/api/admin/directory/deprovisions/:id', {
      params: { id: 'nonexistent' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('rolls back a deprovision and logs audit', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    deprovisionMocks.rollbackDeprovision.mockResolvedValue({
      record: {
        id: 'dp-1',
        targetUserId: 'user-99',
        performedBy: 'admin-1',
        reason: 'Left company',
        userSnapshot: { email: 'user@example.com' },
        status: 'rolled-back',
        rolledBackBy: 'admin-1',
        rolledBackAt: '2026-03-30T11:00:00.000Z',
        createdAt: '2026-03-30T10:00:00.000Z',
        updatedAt: '2026-03-30T11:00:00.000Z',
      },
      snapshot: { email: 'user@example.com' },
    })

    const res = await invokeRoute('post', '/api/admin/directory/deprovisions/:id/rollback', {
      params: { id: 'dp-1' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      data: { record: { id: 'dp-1', status: 'rolled-back' } },
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'directory.deprovision.rollback',
        resourceId: 'dp-1',
      }),
    )
  })

  it('returns 404 when rolling back already rolled-back deprovision', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    deprovisionMocks.rollbackDeprovision.mockResolvedValue({ record: null, snapshot: null })

    const res = await invokeRoute('post', '/api/admin/directory/deprovisions/:id/rollback', {
      params: { id: 'dp-1' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 500 when sync status service throws', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    syncMocks.getDirectorySyncStatus.mockRejectedValue(new Error('DB connection lost'))

    const res = await invokeRoute('get', '/api/admin/directory/sync/status')

    expect(res.statusCode).toBe(500)
  })
})
