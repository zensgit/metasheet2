import { beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../../../plugins/plugin-after-sales/index.cjs') as {
  activate: (context: FakeContext) => Promise<void>
}

type RegisteredHandler = (req: any, res: FakeResponse) => Promise<void>

interface FakeRowRaw {
  id: string
  tenant_id: string
  app_id: string
  project_id: string
  template_id: string
  template_version: string
  mode: string
  status: string
  created_objects_json: string
  created_views_json: string
  warnings_json: string
  display_name: string
  config_json: string
  last_install_at: Date
  created_at: Date
}

interface FakeDatabase {
  rows: FakeRowRaw[]
  query: (sql: string, params?: unknown[]) => Promise<FakeRowRaw[]>
}

interface FakeContext {
  api: {
    database: FakeDatabase
    http: {
      addRoute: (method: string, path: string, handler: RegisteredHandler) => void
    }
    multitable?: {
      provisioning?: {
        ensureObject: (input: {
          projectId: string
          descriptor: Record<string, unknown>
        }) => Promise<unknown>
        ensureView?: (input: {
          projectId: string
          sheetId: string
          descriptor: Record<string, unknown>
        }) => Promise<unknown>
      }
    }
    events: {
      emit: ReturnType<typeof vi.fn>
    }
  }
  communication: {
    register: ReturnType<typeof vi.fn>
  }
  logger: {
    info: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
}

class FakeResponse {
  statusCode = 200
  body: any = null

  status(code: number) {
    this.statusCode = code
    return this
  }

  json(payload: any) {
    this.body = payload
    return this
  }
}

function createFakeDatabase(): FakeDatabase {
  const db: FakeDatabase = {
    rows: [],
    async query(sql: string, params: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT')) {
        const [tenantId, appId] = params as [string, string]
        return db.rows.filter((row) => row.tenant_id === tenantId && row.app_id === appId)
      }
      if (normalized.startsWith('INSERT INTO')) {
        const [
          tenantId,
          appId,
          projectId,
          templateId,
          templateVersion,
          mode,
          status,
          createdObjectsJson,
          createdViewsJson,
          warningsJson,
          displayName,
          configJson,
        ] = params as string[]
        const now = new Date()
        const existingIndex = db.rows.findIndex(
          (row) => row.tenant_id === tenantId && row.app_id === appId,
        )
        const nextRow: FakeRowRaw = {
          id: existingIndex >= 0 ? db.rows[existingIndex].id : `fake-uuid-${db.rows.length + 1}`,
          tenant_id: tenantId,
          app_id: appId,
          project_id: projectId,
          template_id: templateId,
          template_version: templateVersion,
          mode,
          status,
          created_objects_json: createdObjectsJson,
          created_views_json: createdViewsJson,
          warnings_json: warningsJson,
          display_name: displayName,
          config_json: configJson,
          last_install_at: now,
          created_at: existingIndex >= 0 ? db.rows[existingIndex].created_at : now,
        }
        if (existingIndex >= 0) {
          db.rows[existingIndex] = nextRow
        } else {
          db.rows.push(nextRow)
        }
        return [nextRow]
      }
      return []
    },
  }
  return db
}

function createContext(): {
  context: FakeContext
  routes: Map<string, RegisteredHandler>
  ensureObject: ReturnType<typeof vi.fn>
  ensureView: ReturnType<typeof vi.fn>
  db: FakeDatabase
} {
  const routes = new Map<string, RegisteredHandler>()
  const db = createFakeDatabase()
  const ensureObject = vi.fn(async (input: { descriptor: Record<string, unknown> }) => {
    const objectId = String(input.descriptor.id)
    return {
      baseId: 'base_legacy',
      sheet: {
        id: `sheet_${objectId}`,
        baseId: 'base_legacy',
        name: String(input.descriptor.name || objectId),
        description: null,
      },
      fields: [],
    }
  })
  const ensureView = vi.fn(async (input: { sheetId: string; descriptor: Record<string, unknown> }) => ({
    id: `view_${String(input.descriptor.id)}`,
    sheetId: input.sheetId,
    name: String(input.descriptor.name || 'View'),
    type: 'grid',
    filterInfo: {},
    sortInfo: {},
    groupInfo: {},
    hiddenFieldIds: [],
    config: {},
  }))

  const context: FakeContext = {
    api: {
      database: db,
      http: {
        addRoute(method, path, handler) {
          routes.set(`${method} ${path}`, handler)
        },
      },
      multitable: {
        provisioning: {
          ensureObject,
          ensureView,
        },
      },
      events: {
        emit: vi.fn(),
      },
    },
    communication: {
      register: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
  }

  return { context, routes, ensureObject, ensureView, db }
}

function buildReq(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: 'user_42',
      tenantId: 'tenant_42',
    },
    body: {},
    ...overrides,
  }
}

describe('plugin-after-sales routes', () => {
  let routes: Map<string, RegisteredHandler>
  let ensureObject: ReturnType<typeof vi.fn>
  let ensureView: ReturnType<typeof vi.fn>
  let db: FakeDatabase
  let communicationRegister: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const setup = createContext()
    routes = setup.routes
    ensureObject = setup.ensureObject
    ensureView = setup.ensureView
    db = setup.db
    communicationRegister = setup.context.communication.register
    await plugin.activate(setup.context)
  })

  it('returns 401 for current when user is missing', async () => {
    const handler = routes.get('GET /api/after-sales/projects/current')
    const res = new FakeResponse()

    await handler?.({ user: null }, res)

    expect(res.statusCode).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns not-installed for current when ledger is empty', async () => {
    const handler = routes.get('GET /api/after-sales/projects/current')
    const res = new FakeResponse()

    await handler?.(buildReq(), res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        status: 'not-installed',
      },
    })
  })

  it('rejects an unknown template id on install', async () => {
    const handler = routes.get('POST /api/after-sales/projects/install')
    const res = new FakeResponse()

    await handler?.(buildReq({
      body: {
        templateId: 'unknown-template',
      },
    }), res)

    expect(res.statusCode).toBe(400)
    expect(res.body.error.code).toBe('invalid-template-id')
  })

  it('installs the default blueprint and returns project routes', async () => {
    const handler = routes.get('POST /api/after-sales/projects/install')
    const res = new FakeResponse()

    await handler?.(buildReq({
      body: {
        templateId: 'after-sales-default',
        displayName: 'Acme Support',
        config: {
          defaultSlaHours: 24,
          urgentSlaHours: 4,
        },
      },
    }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.projectId).toBe('tenant_42:after-sales')
    expect(res.body.data.routes).toEqual({
      home: '/p/plugin-after-sales/after-sales',
      apiBase: '/api/after-sales',
    })
    expect(res.body.data.installResult.status).toBe('installed')
    expect(res.body.data.installResult.createdObjects).toEqual([
      'serviceTicket',
      'installedAsset',
      'customer',
    ])
    expect(res.body.data.installResult.createdViews).toEqual([
      'ticket-board',
      'installedAsset-grid',
      'customer-grid',
    ])
    expect(ensureObject).toHaveBeenCalledTimes(3)
    expect(ensureView).toHaveBeenCalledTimes(3)
    expect(ensureView).toHaveBeenNthCalledWith(1, {
      projectId: 'tenant_42:after-sales',
      sheetId: 'sheet_serviceTicket',
      descriptor: expect.objectContaining({
        id: 'ticket-board',
        objectId: 'serviceTicket',
        type: 'kanban',
      }),
    })
    expect(ensureView).toHaveBeenNthCalledWith(2, {
      projectId: 'tenant_42:after-sales',
      sheetId: 'sheet_installedAsset',
      descriptor: expect.objectContaining({
        id: 'installedAsset-grid',
        objectId: 'installedAsset',
        type: 'grid',
      }),
    })
    expect(ensureView).toHaveBeenNthCalledWith(3, {
      projectId: 'tenant_42:after-sales',
      sheetId: 'sheet_customer',
      descriptor: expect.objectContaining({
        id: 'customer-grid',
        objectId: 'customer',
        type: 'grid',
      }),
    })
    expect(db.rows).toHaveLength(1)
  })

  it('returns 409 when enable is called twice for the same tenant', async () => {
    const handler = routes.get('POST /api/after-sales/projects/install')
    const first = new FakeResponse()
    const second = new FakeResponse()

    await handler?.(buildReq({
      body: {
        templateId: 'after-sales-default',
      },
    }), first)
    await handler?.(buildReq({
      body: {
        templateId: 'after-sales-default',
      },
    }), second)

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(409)
    expect(second.body.error.code).toBe('already-installed')
  })

  it('registers notification and approval adapter methods on plugin communication api', async () => {
    expect(communicationRegister).toHaveBeenCalledTimes(1)
    expect(communicationRegister).toHaveBeenCalledWith(
      'after-sales',
      expect.objectContaining({
        getManifest: expect.any(Function),
        getNotificationTopics: expect.any(Function),
        buildRefundApprovalCommand: expect.any(Function),
        submitRefundApproval: expect.any(Function),
        sendNotificationTopic: expect.any(Function),
      }),
    )
  })
})
