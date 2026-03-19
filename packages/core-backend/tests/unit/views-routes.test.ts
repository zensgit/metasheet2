import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  authAllowed: true,
  authUser: {
    id: 'user-1',
  },
  tableRbacEnabled: false,
}))

const poolQuery = vi.hoisted(() => vi.fn())
const canReadTable = vi.hoisted(() => vi.fn())
const canWriteTable = vi.hoisted(() => vi.fn())
const eventBusOn = vi.hoisted(() => vi.fn())

const configRegistry = vi.hoisted(() => ({
  register: vi.fn(),
  get: vi.fn(),
}))

const dataRegistry = vi.hoisted(() => ({
  register: vi.fn(),
  get: vi.fn(),
}))

const configProvider = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  deleteConfig: vi.fn(),
  toApiFormat: vi.fn(),
  transformConfig: vi.fn(),
}))

const dataProvider = vi.hoisted(() => ({
  getData: vi.fn(),
  getGroupedData: vi.fn(),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, res: Response, next: (error?: unknown) => void) => {
    if (!state.authAllowed) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } })
      return
    }
    req.user = state.authUser as never
    next()
  },
}))

vi.mock('../../src/config/flags', () => ({
  isFeatureEnabled: (flag: string) => flag === 'FEATURE_TABLE_RBAC_ENABLED' && state.tableRbacEnabled,
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      query: poolQuery,
    }),
  },
}))

vi.mock('../../src/core/view-config-registry', () => ({
  getViewConfigRegistry: () => configRegistry,
}))

vi.mock('../../src/core/view-data-registry', () => ({
  getViewDataRegistry: () => dataRegistry,
}))

vi.mock('../../src/core/default-view-data-provider', () => ({
  getDefaultViewDataProvider: () => dataProvider,
}))

vi.mock('../../src/core/EventBusService', () => ({
  eventBus: {
    on: eventBusOn,
  },
}))

vi.mock('../../src/core/logger', () => ({
  Logger: class {
    info() {}
    debug() {}
    error() {}
  },
}))

vi.mock('../../src/rbac/table-perms', () => ({
  canReadTable,
  canWriteTable,
}))

import { viewsRouter } from '../../src/routes/views'

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
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
  }
}

async function runLayer(
  handle: (req: Request, res: Response, next: (error?: unknown) => void) => unknown,
  req: Request,
  res: Response,
) {
  await new Promise<void>((resolve, reject) => {
    try {
      const maybePromise = handle(req, res, (error?: unknown) => {
        if (error) reject(error)
        else resolve()
      })
      if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
        Promise.resolve(maybePromise).then(() => resolve()).catch(reject)
      } else if (handle.length < 3) {
        resolve()
      } else if ((res as Response & { headersSent?: boolean }).headersSent) {
        resolve()
      }
    } catch (error) {
      reject(error)
    }
  })
}

async function invokeRoute(
  method: 'get' | 'put',
  path: string,
  options: {
    url: string
    params?: Record<string, string>
    query?: Record<string, unknown>
    body?: Record<string, unknown>
  },
) {
  const router = viewsRouter()
  const routeLayer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!routeLayer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: options.url,
    originalUrl: options.url,
    headers: {},
    query: options.query ?? {},
    params: options.params ?? {},
    body: options.body ?? {},
    user: undefined,
  } as unknown as Request

  const res = createMockResponse()

  for (const middlewareLayer of router.stack.filter((entry) => !entry.route)) {
    await runLayer(middlewareLayer.handle, req, res)
    if (res.headersSent) return res
  }

  for (const handlerLayer of routeLayer.route.stack) {
    await runLayer(handlerLayer.handle, req, res)
    if (res.headersSent && handlerLayer.handle.length >= 3) break
  }

  return res
}

describe('views routes', () => {
  beforeEach(() => {
    state.authAllowed = true
    state.authUser = { id: 'user-1' }
    state.tableRbacEnabled = false

    poolQuery.mockReset()
    canReadTable.mockReset()
    canWriteTable.mockReset()
    eventBusOn.mockReset()
    configRegistry.register.mockReset()
    configRegistry.get.mockReset()
    dataRegistry.register.mockReset()
    dataRegistry.get.mockReset()
    configProvider.getConfig.mockReset()
    configProvider.saveConfig.mockReset()
    configProvider.deleteConfig.mockReset()
    configProvider.toApiFormat.mockReset()
    configProvider.transformConfig.mockReset()
    dataProvider.getData.mockReset()
    dataProvider.getGroupedData.mockReset()

    configProvider.transformConfig.mockImplementation((value: unknown) => value)
    dataRegistry.get.mockReturnValue(dataProvider)
    configRegistry.get.mockReturnValue(configProvider)
  })

  it('requires authentication before serving view configuration', async () => {
    state.authAllowed = false

    const response = await invokeRoute('get', '/:viewId/config', {
      url: '/view-1/config',
      params: { viewId: 'view-1' },
    })

    expect(response.statusCode).toBe(401)
    expect(poolQuery).not.toHaveBeenCalled()
  })

  it('returns 403 when table read access is denied for view data', async () => {
    state.tableRbacEnabled = true
    poolQuery.mockResolvedValueOnce({
      rows: [{
        id: 'view-1',
        type: 'grid',
        table_id: 'table-1',
        config: '{}',
        filters: '[]',
        sorting: '[]',
        visible_fields: '[]',
      }],
    })
    canReadTable.mockResolvedValue(false)

    const response = await invokeRoute('get', '/:viewId/data', {
      url: '/view-1/data',
      params: { viewId: 'view-1' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ success: false, error: 'Forbidden' })
    expect(canReadTable).toHaveBeenCalledWith({ id: 'user-1' }, 'table-1')
    expect(dataProvider.getData).not.toHaveBeenCalled()
  })

  it('returns view data when table read access is granted', async () => {
    state.tableRbacEnabled = true
    poolQuery.mockResolvedValueOnce({
      rows: [{
        id: 'view-1',
        type: 'grid',
        table_id: 'table-1',
        config: '{}',
        filters: '[]',
        sorting: '[]',
        visible_fields: '[]',
      }],
    })
    canReadTable.mockResolvedValue(true)
    dataProvider.getData.mockResolvedValue({
      data: [{ id: 'row-1' }],
      meta: { total: 1, page: 1, pageSize: 50, hasMore: false },
    })

    const response = await invokeRoute('get', '/:viewId/data', {
      url: '/view-1/data',
      params: { viewId: 'view-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      success: true,
      data: [{ id: 'row-1' }],
      meta: { total: 1, page: 1, pageSize: 50, hasMore: false },
    })
    expect(canReadTable).toHaveBeenCalledWith({ id: 'user-1' }, 'table-1')
    expect(dataProvider.getData).toHaveBeenCalledTimes(1)
  })

  it('returns 403 when table write access is denied for updating config', async () => {
    state.tableRbacEnabled = true
    poolQuery.mockResolvedValueOnce({
      rows: [{ type: 'grid', table_id: 'table-1' }],
    })
    canWriteTable.mockResolvedValue(false)

    const response = await invokeRoute('put', '/:viewId/config', {
      url: '/view-1/config',
      params: { viewId: 'view-1' },
      body: { title: 'Blocked update' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ success: false, error: 'Forbidden' })
    expect(canWriteTable).toHaveBeenCalledWith({ id: 'user-1' }, 'table-1')
    expect(configProvider.saveConfig).not.toHaveBeenCalled()
    expect(poolQuery).toHaveBeenCalledTimes(1)
  })
})
