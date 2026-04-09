import { beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../../../plugins/plugin-after-sales/index.cjs') as {
  activate: (context: FakeContext) => Promise<void>
  deactivate: () => Promise<void>
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
  failNextQuery?: string
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
        getObjectSheetId: (projectId: string, objectId: string) => string
        getFieldId: (projectId: string, objectId: string, fieldId: string) => string
        findObjectSheet?: (input: {
          projectId: string
          objectId: string
        }) => Promise<{
          id: string
          baseId: string | null
          name: string
          description: string | null
        } | null>
        resolveFieldIds?: (input: {
          projectId: string
          objectId: string
          fieldIds: string[]
        }) => Promise<Record<string, string>>
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
      records?: {
        listRecords?: (input: {
          sheetId: string
          limit?: number
          offset?: number
        }) => Promise<unknown>
        queryRecords?: (input: {
          sheetId: string
          filters?: Record<string, string | number | boolean | null>
          search?: string
          limit?: number
          offset?: number
        }) => Promise<unknown>
        createRecord: (input: {
          sheetId: string
          data: Record<string, unknown>
        }) => Promise<unknown>
        getRecord: (input: {
          sheetId: string
          recordId: string
        }) => Promise<unknown>
        patchRecord: (input: {
          sheetId: string
          recordId: string
          changes: Record<string, unknown>
        }) => Promise<unknown>
        deleteRecord?: (input: {
          sheetId: string
          recordId: string
        }) => Promise<unknown>
      }
    }
    events: {
      on: ReturnType<typeof vi.fn>
      off: ReturnType<typeof vi.fn>
      emit: ReturnType<typeof vi.fn>
    }
  }
  communication: {
    register: ReturnType<typeof vi.fn>
    call: ReturnType<typeof vi.fn>
  }
  logger: {
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
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
      if (db.failNextQuery) {
        const errorMessage = db.failNextQuery
        db.failNextQuery = undefined
        throw new Error(errorMessage)
      }
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
  getObjectSheetId: ReturnType<typeof vi.fn>
  getFieldId: ReturnType<typeof vi.fn>
  findObjectSheet: ReturnType<typeof vi.fn>
  resolveFieldIds: ReturnType<typeof vi.fn>
  listRecords: ReturnType<typeof vi.fn>
  queryRecords: ReturnType<typeof vi.fn>
  createRecord: ReturnType<typeof vi.fn>
  getRecord: ReturnType<typeof vi.fn>
  patchRecord: ReturnType<typeof vi.fn>
  deleteRecord: ReturnType<typeof vi.fn>
  communicationCall: ReturnType<typeof vi.fn>
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
  // The mock getFieldId returns `${projectId}:${objectId}:${fieldId}`. Build
  // physical record keys that match, so getRecord/patchRecord return data in
  // the same physical-id shape the real multitable seam would use.
  const MOCK_PROJECT_ID = 'tenant_42:after-sales'
  const pk = (field: string) => `${MOCK_PROJECT_ID}:serviceTicket:${field}`
  const getObjectSheetId = vi.fn((projectId: string, objectId: string) => `${projectId}:${objectId}:sheet`)
  const getFieldId = vi.fn((projectId: string, objectId: string, fieldId: string) => `${projectId}:${objectId}:${fieldId}`)
  const findObjectSheet = vi.fn(async (input: { projectId: string; objectId: string }) => ({
    id: `${input.projectId}:${input.objectId}:sheet`,
    baseId: 'base_legacy',
    name: input.objectId,
    description: null,
  }))
  const resolveFieldIds = vi.fn(async (input: {
    projectId: string
    objectId: string
    fieldIds: string[]
  }) => Object.fromEntries(
    input.fieldIds.map((fieldId) => [fieldId, `${input.projectId}:${input.objectId}:${fieldId}`]),
  ))
  const createRecord = vi.fn(async (input: { sheetId: string; data: Record<string, unknown> }) => ({
    id: input.sheetId.includes('serviceRecord') ? 'rec_service_001' : 'rec_ticket_001',
    sheetId: input.sheetId,
    version: 1,
    data: input.data,
  }))
  const listRecords = vi.fn(async (input: { sheetId: string }) => ([
    input.sheetId.includes('serviceRecord')
      ? {
          id: 'rec_service_001',
          sheetId: input.sheetId,
          version: 2,
          data: {
            [srPk('ticketNo')]: 'TK-2001',
            [srPk('visitType')]: 'onsite',
            [srPk('scheduledAt')]: '2026-04-09T09:00:00Z',
            [srPk('technicianName')]: 'Tech One',
            [srPk('workSummary')]: 'Replaced motor',
            [srPk('result')]: 'resolved',
          },
        }
      : {
          id: 'rec_ticket_001',
          sheetId: input.sheetId,
          version: 3,
          data: {
            [pk('ticketNo')]: 'TK-2001',
            [pk('title')]: 'No cooling output',
            [pk('source')]: 'phone',
            [pk('priority')]: 'high',
            [pk('status')]: 'new',
          },
        },
  ]))
  const queryRecords = vi.fn(async (input: { sheetId: string }) => ([
    input.sheetId.includes('serviceRecord')
      ? {
          id: 'rec_service_001',
          sheetId: input.sheetId,
          version: 2,
          data: {
            [srPk('ticketNo')]: 'TK-2001',
            [srPk('visitType')]: 'onsite',
            [srPk('scheduledAt')]: '2026-04-09T09:00:00Z',
            [srPk('technicianName')]: 'Tech One',
            [srPk('workSummary')]: 'Replaced motor',
            [srPk('result')]: 'resolved',
          },
          filters: input.filters,
          search: input.search,
        }
      : {
          id: 'rec_ticket_001',
          sheetId: input.sheetId,
          version: 3,
          data: {
            [pk('ticketNo')]: 'TK-2001',
            [pk('title')]: 'No cooling output',
            [pk('source')]: 'phone',
            [pk('priority')]: 'high',
            [pk('status')]: 'new',
          },
          filters: input.filters,
          search: input.search,
        },
  ]))
  const getRecord = vi.fn(async (input: { sheetId: string; recordId: string }) => ({
    id: input.recordId,
    sheetId: input.sheetId,
    version: 3,
    data: input.sheetId.includes('serviceRecord')
      ? {
          [srPk('ticketNo')]: 'TK-2001',
          [srPk('visitType')]: 'onsite',
          [srPk('scheduledAt')]: '2026-04-09T09:00:00Z',
          [srPk('technicianName')]: 'Tech One',
          [srPk('workSummary')]: 'Replaced motor',
          [srPk('result')]: 'resolved',
        }
      : {
          [pk('ticketNo')]: 'TK-2001',
          [pk('title')]: 'No cooling output',
          [pk('source')]: 'phone',
          [pk('priority')]: 'high',
          [pk('status')]: 'new',
        },
  }))
  const patchRecord = vi.fn(async (input: { sheetId: string; recordId: string; changes: Record<string, unknown> }) => ({
    id: input.recordId,
    sheetId: input.sheetId,
    version: 4,
    data: input.sheetId.includes('serviceRecord')
      ? {
          [srPk('ticketNo')]: 'TK-2001',
          [srPk('visitType')]: 'onsite',
          [srPk('scheduledAt')]: '2026-04-09T09:00:00Z',
          [srPk('technicianName')]: 'Tech One',
          [srPk('workSummary')]: 'Replaced motor',
          [srPk('result')]: 'resolved',
          ...input.changes,
        }
      : {
          [pk('ticketNo')]: 'TK-2001',
          [pk('title')]: 'No cooling output',
          [pk('source')]: 'phone',
          [pk('priority')]: 'high',
          [pk('status')]: 'new',
          ...input.changes,
        },
  }))
  const deleteRecord = vi.fn(async (input: { sheetId: string; recordId: string }) => ({
    id: input.recordId,
    sheetId: input.sheetId,
    version: 4,
  }))
  const communicationCall = vi.fn(async (pluginName: string, method: string, payload: Record<string, unknown>) => {
    if (pluginName === 'after-sales-approval-bridge' && method === 'getRefundApproval') {
      return {
        id: 'approval_001',
        sourceSystem: 'after-sales',
        workflowKey: 'after-sales-refund',
        businessKey: `after-sales:${payload.projectId}:ticket:${payload.ticketId}:refund`,
        status: 'pending',
      }
    }
    return { ok: true, pluginName, method, payload }
  })

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
          getObjectSheetId,
          getFieldId,
          findObjectSheet,
          resolveFieldIds,
          ensureObject,
          ensureView,
        },
        records: {
          listRecords,
          queryRecords,
          createRecord,
          getRecord,
          patchRecord,
          deleteRecord,
        },
      },
      events: {
        on: vi.fn((eventName: string) => `sub:${eventName}`),
        off: vi.fn(),
        emit: vi.fn(),
      },
    },
    communication: {
      register: vi.fn(),
      call: communicationCall,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }

  return {
    context,
    routes,
    ensureObject,
    ensureView,
    getObjectSheetId,
    getFieldId,
    findObjectSheet,
    resolveFieldIds,
    listRecords,
    queryRecords,
    createRecord,
    getRecord,
    patchRecord,
    deleteRecord,
    communicationCall,
    db,
  }
}

function buildReq(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: 'user_42',
      tenantId: 'tenant_42',
      role: 'admin',
      roles: ['admin'],
      perms: ['*:*', 'after_sales:admin'],
    },
    body: {},
    ...overrides,
  }
}

// Physical field id helper matching the mock getFieldId: `${projectId}:${objectId}:${fieldId}`
const MOCK_PROJECT_ID = 'tenant_42:after-sales'
const stPk = (field: string) => `${MOCK_PROJECT_ID}:serviceTicket:${field}`
const srPk = (field: string) => `${MOCK_PROJECT_ID}:serviceRecord:${field}`

describe('plugin-after-sales routes', () => {
  let routes: Map<string, RegisteredHandler>
  let ensureObject: ReturnType<typeof vi.fn>
  let ensureView: ReturnType<typeof vi.fn>
  let getObjectSheetId: ReturnType<typeof vi.fn>
  let getFieldId: ReturnType<typeof vi.fn>
  let findObjectSheet: ReturnType<typeof vi.fn>
  let resolveFieldIds: ReturnType<typeof vi.fn>
  let listRecords: ReturnType<typeof vi.fn>
  let queryRecords: ReturnType<typeof vi.fn>
  let createRecord: ReturnType<typeof vi.fn>
  let getRecord: ReturnType<typeof vi.fn>
  let patchRecord: ReturnType<typeof vi.fn>
  let deleteRecord: ReturnType<typeof vi.fn>
  let db: FakeDatabase
  let communicationRegister: ReturnType<typeof vi.fn>
  let communicationCall: ReturnType<typeof vi.fn>
  let eventsOn: ReturnType<typeof vi.fn>
  let eventsOff: ReturnType<typeof vi.fn>
  let eventsEmit: ReturnType<typeof vi.fn>
  let currentContext: FakeContext

  beforeEach(async () => {
    const setup = createContext()
    currentContext = setup.context
    routes = setup.routes
    ensureObject = setup.ensureObject
    ensureView = setup.ensureView
    getObjectSheetId = setup.getObjectSheetId
    getFieldId = setup.getFieldId
    findObjectSheet = setup.findObjectSheet
    resolveFieldIds = setup.resolveFieldIds
    listRecords = setup.listRecords
    queryRecords = setup.queryRecords
    createRecord = setup.createRecord
    getRecord = setup.getRecord
    patchRecord = setup.patchRecord
    deleteRecord = setup.deleteRecord
    db = setup.db
    communicationRegister = setup.context.communication.register
    communicationCall = setup.context.communication.call
    eventsOn = setup.context.api.events.on
    eventsOff = setup.context.api.events.off
    eventsEmit = setup.context.api.events.emit
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

  it('warns once per request when tenantId is missing and falls back to default', async () => {
    const handler = routes.get('GET /api/after-sales/projects/current')
    const firstRes = new FakeResponse()
    const secondRes = new FakeResponse()
    const req = buildReq({
      method: 'GET',
      path: '/api/after-sales/projects/current',
      user: {
        id: 'user_42',
        role: 'admin',
        roles: ['admin'],
        perms: ['*:*', 'after_sales:admin'],
      },
    })

    await handler?.(req, firstRes)
    await handler?.(req, secondRes)

    expect(firstRes.statusCode).toBe(200)
    expect(secondRes.statusCode).toBe(200)
    expect(currentContext.logger.warn).toHaveBeenCalledTimes(1)
    expect(currentContext.logger.warn).toHaveBeenCalledWith(
      'After-sales request missing tenantId; falling back to default',
      expect.objectContaining({
        method: 'GET',
        path: '/api/after-sales/projects/current',
        userId: 'user_42',
      }),
    )
  })

  it('surfaces ledger-read-failed for current when the ledger read throws', async () => {
    const handler = routes.get('GET /api/after-sales/projects/current')
    const res = new FakeResponse()
    db.failNextQuery = 'simulated ledger read failure'

    await handler?.(buildReq(), res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'ledger-read-failed',
        message: 'failed to read install ledger: simulated ledger read failure',
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

  it('returns 403 for install when caller lacks admin access', async () => {
    const handler = routes.get('POST /api/after-sales/projects/install')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: {
        id: 'user_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:read'],
      },
      body: {
        templateId: 'after-sales-default',
      },
    }), res)

    expect(res.statusCode).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(ensureObject).not.toHaveBeenCalled()
    expect(ensureView).not.toHaveBeenCalled()
    expect(db.rows).toHaveLength(0)
  })

  it('returns 403 for ticket-created when caller lacks after-sales write access', async () => {
    const handler = routes.get('POST /api/after-sales/events/ticket-created')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: {
        id: 'user_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:read'],
      },
      body: {
        ticket: {
          id: 'ticket_001',
          ticketNo: 'TK-1001',
          title: 'Broken compressor',
          priority: 'urgent',
        },
      },
    }), res)

    expect(res.statusCode).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(res.body.error.message).toBe('After-sales write access required')
    expect(ensureObject).not.toHaveBeenCalled()
  })

  it('creates a service ticket record and emits ticket.created', async () => {
    const handler = routes.get('POST /api/after-sales/tickets')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket']),
      created_views_json: JSON.stringify(['ticket-board']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      body: {
        ticket: {
          ticketNo: 'TK-2001',
          title: 'No cooling output',
          priority: 'high',
          source: 'phone',
          assigneeCandidates: [{ id: 'tech_001', type: 'user' }],
        },
      },
    }), res)

    expect(res.statusCode).toBe(201)
    expect(createRecord).toHaveBeenCalledWith({
      sheetId: 'tenant_42:after-sales:serviceTicket:sheet',
      data: {
        [stPk('ticketNo')]: 'TK-2001',
        [stPk('title')]: 'No cooling output',
        [stPk('source')]: 'phone',
        [stPk('priority')]: 'high',
        [stPk('status')]: 'new',
      },
    })
    expect(findObjectSheet).toHaveBeenCalledWith({
      projectId: 'tenant_42:after-sales',
      objectId: 'serviceTicket',
    })
    expect(resolveFieldIds).toHaveBeenCalled()
    expect(getObjectSheetId).not.toHaveBeenCalled()
    expect(getFieldId).not.toHaveBeenCalled()
    expect(eventsEmit).toHaveBeenCalledWith(
      'ticket.created',
      expect.objectContaining({
        projectId: 'tenant_42:after-sales',
        ticket: expect.objectContaining({
          id: 'rec_ticket_001',
          ticketNo: 'TK-2001',
          priority: 'high',
        }),
      }),
    )
    expect(res.body.data.ticket.id).toBe('rec_ticket_001')
    expect(res.body.data.event).toEqual({
      accepted: true,
      event: 'ticket.created',
    })
  })

  it('treats blank refundAmount as missing when creating a ticket', async () => {
    const handler = routes.get('POST /api/after-sales/tickets')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket']),
      created_views_json: JSON.stringify(['ticket-board']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      body: {
        ticket: {
          ticketNo: 'TK-2002',
          title: 'Rattling noise',
          refundAmount: '   ',
        },
      },
    }), res)

    expect(res.statusCode).toBe(201)
    expect(createRecord).toHaveBeenCalledWith({
      sheetId: 'tenant_42:after-sales:serviceTicket:sheet',
      data: {
        [stPk('ticketNo')]: 'TK-2002',
        [stPk('title')]: 'Rattling noise',
        [stPk('source')]: 'web',
        [stPk('priority')]: 'normal',
        [stPk('status')]: 'new',
      },
    })
  })

  it('returns 409 when creating a ticket before install', async () => {
    const handler = routes.get('POST /api/after-sales/tickets')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      body: {
        ticket: {
          ticketNo: 'TK-2001',
          title: 'No cooling output',
        },
      },
    }), res)

    expect(res.statusCode).toBe(409)
    expect(res.body.error.code).toBe('AFTER_SALES_NOT_INSTALLED')
    expect(createRecord).not.toHaveBeenCalled()
  })

  it('lists tickets through the multitable read seam', async () => {
    const handler = routes.get('GET /api/after-sales/tickets')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket']),
      created_views_json: JSON.stringify(['ticket-board']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await handler?.(buildReq({
      user: {
        id: 'reader_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:read'],
      },
      query: {
        status: 'new',
      },
    }), res)

    expect(res.statusCode).toBe(200)
    expect(queryRecords).toHaveBeenCalledWith({
      sheetId: 'tenant_42:after-sales:serviceTicket:sheet',
      filters: {
        [stPk('status')]: 'new',
      },
      search: null,
      limit: undefined,
      offset: undefined,
    })
    expect(res.body.data).toEqual({
      projectId: 'tenant_42:after-sales',
      tickets: [
        {
          id: 'rec_ticket_001',
          version: 3,
          data: {
            ticketNo: 'TK-2001',
            title: 'No cooling output',
            source: 'phone',
            priority: 'high',
            status: 'new',
          },
        },
      ],
      count: 1,
    })
    expect(findObjectSheet).toHaveBeenCalledWith({
      projectId: 'tenant_42:after-sales',
      objectId: 'serviceTicket',
    })
    expect(resolveFieldIds).toHaveBeenCalledWith({
      projectId: 'tenant_42:after-sales',
      objectId: 'serviceTicket',
      fieldIds: ['status'],
    })
    expect(getObjectSheetId).not.toHaveBeenCalled()
    expect(getFieldId).not.toHaveBeenCalled()
  })

  it('returns 403 for service-records when caller lacks after-sales write access', async () => {
    const handler = routes.get('POST /api/after-sales/service-records')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: {
        id: 'user_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:read'],
      },
      body: {
        serviceRecord: {
          ticketNo: 'TK-SR-001',
          visitType: 'onsite',
          scheduledAt: '2026-04-09T09:00:00Z',
        },
      },
    }), res)

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'After-sales write access required',
      },
    })
    expect(createRecord).not.toHaveBeenCalled()
  })

  it('returns 401 for service-records list when user is missing', async () => {
    const handler = routes.get('GET /api/after-sales/service-records')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: null,
    }), res)

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'User ID not found',
      },
    })
    expect(queryRecords).not.toHaveBeenCalled()
    expect(listRecords).not.toHaveBeenCalled()
  })

  it('returns 403 for service-records list when caller lacks after-sales read access', async () => {
    const handler = routes.get('GET /api/after-sales/service-records')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: {
        id: 'user_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: [],
      },
    }), res)

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'After-sales read access required',
      },
    })
    expect(queryRecords).not.toHaveBeenCalled()
    expect(listRecords).not.toHaveBeenCalled()
  })

  it('returns 409 when service-records are created before install', async () => {
    const handler = routes.get('POST /api/after-sales/service-records')
    const res = new FakeResponse()

    await handler?.(buildReq({
      body: {
        serviceRecord: {
          ticketNo: 'TK-SR-001',
          visitType: 'onsite',
          scheduledAt: '2026-04-09T09:00:00Z',
        },
      },
    }), res)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'AFTER_SALES_NOT_INSTALLED',
        message: 'After-sales must be installed before creating service records',
      },
    })
    expect(createRecord).not.toHaveBeenCalled()
  })

  it('returns 409 when service-records are listed from a failed install state', async () => {
    const handler = routes.get('GET /api/after-sales/service-records')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'reinstall',
      status: 'failed',
      created_objects_json: JSON.stringify(['serviceTicket', 'serviceRecord']),
      created_views_json: JSON.stringify(['ticket-board', 'serviceRecord-calendar']),
      warnings_json: JSON.stringify(['service record create failed']),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await handler?.(buildReq(), res)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'AFTER_SALES_NOT_INSTALLED',
        message: 'After-sales must be installed before listing service records',
      },
    })
    expect(queryRecords).not.toHaveBeenCalled()
    expect(listRecords).not.toHaveBeenCalled()
  })

  it('returns empty service-record results when no records match', async () => {
    const handler = routes.get('GET /api/after-sales/service-records')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket', 'serviceRecord']),
      created_views_json: JSON.stringify(['ticket-board', 'serviceRecord-calendar']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })
    queryRecords.mockResolvedValueOnce([])

    await handler?.(buildReq({
      query: {
        ticketNo: 'TK-SR-404',
      },
    }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        projectId: 'tenant_42:after-sales',
        serviceRecords: [],
        count: 0,
      },
    })
  })

  it('returns 400 when service-record visitType is invalid', async () => {
    const handler = routes.get('POST /api/after-sales/service-records')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket', 'serviceRecord']),
      created_views_json: JSON.stringify(['ticket-board', 'serviceRecord-calendar']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await handler?.(buildReq({
      body: {
        serviceRecord: {
          ticketNo: 'TK-SR-001',
          visitType: 'driveby',
          scheduledAt: '2026-04-09T09:00:00Z',
        },
      },
    }), res)

    expect(res.statusCode).toBe(400)
    expect(res.body.error.code).toBe('AFTER_SALES_EVENT_VALIDATION_FAILED')
    expect(createRecord).not.toHaveBeenCalled()
  })

  it('returns 404 when service-record ticketNo does not match an existing ticket', async () => {
    const handler = routes.get('POST /api/after-sales/service-records')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket', 'serviceRecord']),
      created_views_json: JSON.stringify(['ticket-board', 'serviceRecord-calendar']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })
    queryRecords.mockResolvedValueOnce([])

    await handler?.(buildReq({
      body: {
        serviceRecord: {
          ticketNo: 'TK-SR-404',
          visitType: 'onsite',
          scheduledAt: '2026-04-09T09:00:00Z',
        },
      },
    }), res)

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'After-sales ticket TK-SR-404 not found',
      },
    })
    expect(createRecord).not.toHaveBeenCalled()
  })

  it('returns 400 when service-record scheduledAt is missing', async () => {
    const handler = routes.get('POST /api/after-sales/service-records')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket', 'serviceRecord']),
      created_views_json: JSON.stringify(['ticket-board', 'serviceRecord-calendar']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await handler?.(buildReq({
      body: {
        serviceRecord: {
          ticketNo: 'TK-SR-001',
          visitType: 'onsite',
        },
      },
    }), res)

    expect(res.statusCode).toBe(400)
    expect(res.body.error.code).toBe('AFTER_SALES_EVENT_VALIDATION_FAILED')
    expect(createRecord).not.toHaveBeenCalled()
  })

  it('creates and lists service records through the multitable seam', async () => {
    const createHandler = routes.get('POST /api/after-sales/service-records')
    const listHandler = routes.get('GET /api/after-sales/service-records')
    const createRes = new FakeResponse()
    const listRes = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket', 'serviceRecord']),
      created_views_json: JSON.stringify(['ticket-board', 'serviceRecord-calendar']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await createHandler?.(buildReq({
      body: {
        serviceRecord: {
          ticketNo: 'TK-2001',
          visitType: 'onsite',
          scheduledAt: '2026-04-09T09:00:00Z',
          completedAt: '2026-04-09T10:30:00Z',
          technicianName: 'Tech One',
          workSummary: 'Replaced motor',
          result: 'resolved',
        },
      },
    }), createRes)

    expect(createRes.statusCode).toBe(201)
    expect(createRes.body).toEqual({
      ok: true,
      data: {
        projectId: 'tenant_42:after-sales',
        serviceRecord: {
            id: 'rec_service_001',
            version: 1,
            data: {
            ticketNo: 'TK-2001',
            visitType: 'onsite',
            scheduledAt: '2026-04-09T09:00:00Z',
            completedAt: '2026-04-09T10:30:00Z',
            technicianName: 'Tech One',
            workSummary: 'Replaced motor',
            result: 'resolved',
          },
        },
        event: {
          accepted: true,
          event: 'service.recorded',
        },
      },
    })
    expect(createRecord).toHaveBeenCalledWith({
      sheetId: 'tenant_42:after-sales:serviceRecord:sheet',
      data: {
        [srPk('ticketNo')]: 'TK-2001',
        [srPk('visitType')]: 'onsite',
        [srPk('scheduledAt')]: '2026-04-09T09:00:00Z',
        [srPk('completedAt')]: '2026-04-09T10:30:00Z',
        [srPk('technicianName')]: 'Tech One',
        [srPk('workSummary')]: 'Replaced motor',
        [srPk('result')]: 'resolved',
      },
    })
    expect(eventsEmit).toHaveBeenCalledWith(
      'service.recorded',
      expect.objectContaining({
        tenantId: 'tenant_42',
        projectId: 'tenant_42:after-sales',
        ticketNo: 'TK-2001',
        serviceRecord: expect.objectContaining({
          id: 'rec_service_001',
          ticketNo: 'TK-2001',
          visitType: 'onsite',
          scheduledAt: '2026-04-09T09:00:00Z',
          completedAt: '2026-04-09T10:30:00Z',
          technicianName: 'Tech One',
          workSummary: 'Replaced motor',
          result: 'resolved',
        }),
      }),
    )

    await listHandler?.(buildReq({
      query: {
        ticketNo: 'TK-2001',
        result: 'resolved',
        search: 'motor',
        limit: '5',
        offset: '2',
      },
    }), listRes)

    expect(listRes.statusCode).toBe(200)
    expect(queryRecords).toHaveBeenCalledWith({
      sheetId: 'tenant_42:after-sales:serviceRecord:sheet',
      filters: {
        [srPk('ticketNo')]: 'TK-2001',
        [srPk('result')]: 'resolved',
      },
      search: 'motor',
      limit: 5,
      offset: 2,
    })
    expect(listRes.body).toEqual({
      ok: true,
      data: {
        projectId: 'tenant_42:after-sales',
        serviceRecords: [
          {
            id: 'rec_service_001',
            version: 2,
            data: {
              ticketNo: 'TK-2001',
              visitType: 'onsite',
              scheduledAt: '2026-04-09T09:00:00Z',
              technicianName: 'Tech One',
              workSummary: 'Replaced motor',
              result: 'resolved',
            },
          },
        ],
        count: 1,
      },
    })
  })

  it('requests a ticket refund by patching the record and emitting ticket.refundRequested', async () => {
    const handler = routes.get('POST /api/after-sales/tickets/:ticketId/refund-request')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket']),
      created_views_json: JSON.stringify(['ticket-board']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      params: {
        ticketId: 'rec_ticket_001',
      },
      body: {
        refundAmount: 88.5,
        requesterName: 'Alice',
        reason: 'Damaged fan motor',
      },
    }), res)

    expect(res.statusCode).toBe(202)
    expect(getRecord).toHaveBeenCalledWith({
      sheetId: 'tenant_42:after-sales:serviceTicket:sheet',
      recordId: 'rec_ticket_001',
    })
    expect(patchRecord).toHaveBeenCalledWith({
      sheetId: 'tenant_42:after-sales:serviceTicket:sheet',
      recordId: 'rec_ticket_001',
      changes: {
        [stPk('refundAmount')]: 88.5,
        [stPk('refundStatus')]: 'pending',
      },
    })
    const refundRequestedCall = eventsEmit.mock.calls.find(([eventName]) => eventName === 'ticket.refundRequested')
    expect(refundRequestedCall).toBeTruthy()
    expect(refundRequestedCall?.[1]).toEqual(expect.objectContaining({
      projectId: 'tenant_42:after-sales',
      ticketNo: 'TK-2001',
      title: 'No cooling output',
      ticket: expect.objectContaining({
        id: 'rec_ticket_001',
        ticketNo: 'TK-2001',
        title: 'No cooling output',
        refundAmount: 88.5,
        requestedBy: 'writer_42',
        requestedByName: 'Alice',
        reason: 'Damaged fan motor',
      }),
    }))
    expect(res.body.data.event).toEqual({
      accepted: true,
      event: 'ticket.refundRequested',
    })
  })

  it('returns 404 when refund is requested for a missing ticket', async () => {
    const handler = routes.get('POST /api/after-sales/tickets/:ticketId/refund-request')
    const res = new FakeResponse()
    getRecord.mockRejectedValueOnce(Object.assign(new Error('Record not found: rec_missing'), {
      code: 'NOT_FOUND',
    }))

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket']),
      created_views_json: JSON.stringify(['ticket-board']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      params: {
        ticketId: 'rec_missing',
      },
      body: {
        refundAmount: 88.5,
      },
    }), res)

    expect(res.statusCode).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(patchRecord).not.toHaveBeenCalled()
  })

  it('loads refund approval status for a ticket through the bridge seam', async () => {
    const handler = routes.get('GET /api/after-sales/tickets/:ticketId/refund-approval')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket']),
      created_views_json: JSON.stringify(['ticket-board']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await handler?.(buildReq({
      user: {
        id: 'reader_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:read'],
      },
      params: {
        ticketId: 'rec_ticket_001',
      },
    }), res)

    expect(res.statusCode).toBe(200)
    expect(communicationCall).toHaveBeenCalledWith(
      'after-sales-approval-bridge',
      'getRefundApproval',
      {
        projectId: 'tenant_42:after-sales',
        ticketId: 'rec_ticket_001',
        businessKey: undefined,
      },
    )
    expect(res.body.data).toEqual({
      projectId: 'tenant_42:after-sales',
      approval: expect.objectContaining({
        id: 'approval_001',
        status: 'pending',
      }),
    })
  })

  it('deletes a ticket through the multitable delete seam', async () => {
    const handler = routes.get('DELETE /api/after-sales/tickets/:ticketId')
    const res = new FakeResponse()

    db.rows.push({
      id: 'fake-uuid-1',
      tenant_id: 'tenant_42',
      app_id: 'after-sales',
      project_id: 'tenant_42:after-sales',
      template_id: 'after-sales-default',
      template_version: '0.1.0',
      mode: 'enable',
      status: 'installed',
      created_objects_json: JSON.stringify(['serviceTicket']),
      created_views_json: JSON.stringify(['ticket-board']),
      warnings_json: JSON.stringify([]),
      display_name: 'After-sales',
      config_json: JSON.stringify({}),
      last_install_at: new Date(),
      created_at: new Date(),
    })

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      params: {
        ticketId: 'rec_ticket_001',
      },
    }), res)

    expect(res.statusCode).toBe(200)
    expect(deleteRecord).toHaveBeenCalledWith({
      sheetId: 'tenant_42:after-sales:serviceTicket:sheet',
      recordId: 'rec_ticket_001',
    })
    expect(res.body.data).toEqual({
      projectId: 'tenant_42:after-sales',
      ticketId: 'rec_ticket_001',
      version: 4,
      deleted: true,
    })
  })

  it('emits ticket.created and returns accepted event metadata', async () => {
    const handler = routes.get('POST /api/after-sales/events/ticket-created')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      body: {
        ticket: {
          id: 'ticket_001',
          ticketNo: 'TK-1001',
          title: 'Broken compressor',
          priority: 'urgent',
          assigneeCandidates: [
            { id: 'tech_001', type: 'user' },
          ],
        },
      },
    }), res)

    expect(res.statusCode).toBe(202)
    expect(res.body).toEqual({
      ok: true,
      data: {
        accepted: true,
        event: 'ticket.created',
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
      },
    })
    expect(eventsEmit).toHaveBeenCalledWith(
      'ticket.created',
      expect.objectContaining({
        tenantId: 'tenant_42',
        projectId: 'tenant_42:after-sales',
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        ticket: expect.objectContaining({
          id: 'ticket_001',
          priority: 'urgent',
        }),
      }),
    )
  })

  it('emits ticket.refundRequested with requester fallback and returns accepted metadata', async () => {
    const handler = routes.get('POST /api/after-sales/events/ticket-refund-requested')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      body: {
        ticket: {
          id: 'ticket_001',
          ticketNo: 'TK-1001',
          title: 'Refund request',
          refundAmount: 88.5,
        },
      },
    }), res)

    expect(res.statusCode).toBe(202)
    expect(res.body).toEqual({
      ok: true,
      data: {
        accepted: true,
        event: 'ticket.refundRequested',
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
      },
    })
    expect(eventsEmit).toHaveBeenCalledWith(
      'ticket.refundRequested',
      expect.objectContaining({
        tenantId: 'tenant_42',
        projectId: 'tenant_42:after-sales',
        ticketNo: 'TK-1001',
        title: 'Refund request',
        ticket: expect.objectContaining({
          id: 'ticket_001',
          refundAmount: 88.5,
          requestedBy: 'writer_42',
        }),
      }),
    )
  })

  it('returns 400 when refund-requested payload is malformed', async () => {
    const handler = routes.get('POST /api/after-sales/events/ticket-refund-requested')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      body: {
        ticket: {
          id: 'ticket_001',
          ticketNo: 'TK-1001',
          title: 'Refund request',
        },
      },
    }), res)

    expect(res.statusCode).toBe(400)
    expect(res.body.error.code).toBe('AFTER_SALES_EVENT_VALIDATION_FAILED')
  })

  it('emits ticket.overdue and returns accepted metadata', async () => {
    const handler = routes.get('POST /api/after-sales/events/ticket-overdue')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      body: {
        ticket: {
          id: 'ticket_001',
          ticketNo: 'TK-1001',
          title: 'Overdue visit',
          assignedTo: 'tech_001',
          assignedSupervisor: 'lead_001',
        },
        overdueWebhook: {
          id: 'https://hooks.example.com/after-sales-overdue',
          type: 'webhook',
        },
      },
    }), res)

    expect(res.statusCode).toBe(202)
    expect(res.body).toEqual({
      ok: true,
      data: {
        accepted: true,
        event: 'ticket.overdue',
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
      },
    })
    expect(eventsEmit).toHaveBeenCalledWith(
      'ticket.overdue',
      expect.objectContaining({
        tenantId: 'tenant_42',
        projectId: 'tenant_42:after-sales',
        assignedTo: expect.objectContaining({ id: 'tech_001', type: 'user' }),
        overdueWebhook: expect.objectContaining({
          id: 'https://hooks.example.com/after-sales-overdue',
          type: 'webhook',
        }),
      }),
    )
  })

  it('emits followup.due and returns accepted metadata', async () => {
    const handler = routes.get('POST /api/after-sales/events/followup-due')
    const res = new FakeResponse()

    await handler?.(buildReq({
      user: {
        id: 'writer_42',
        tenantId: 'tenant_42',
        role: 'user',
        roles: ['user'],
        perms: ['after_sales:write'],
      },
      body: {
        ticket: {
          id: 'ticket_001',
          ticketNo: 'TK-1001',
          title: 'Follow-up call',
        },
        followUp: {
          id: 'followup_001',
          owner: {
            id: 'csr_001',
            type: 'user',
          },
        },
      },
    }), res)

    expect(res.statusCode).toBe(202)
    expect(res.body).toEqual({
      ok: true,
      data: {
        accepted: true,
        event: 'followup.due',
        projectId: 'tenant_42:after-sales',
        ticketId: 'ticket_001',
        followUpId: 'followup_001',
      },
    })
    expect(eventsEmit).toHaveBeenCalledWith(
      'followup.due',
      expect.objectContaining({
        tenantId: 'tenant_42',
        projectId: 'tenant_42:after-sales',
        followUpOwner: expect.objectContaining({ id: 'csr_001', type: 'user' }),
      }),
    )
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
      'serviceRecord',
      'partItem',
      'followUp',
    ])
    expect(res.body.data.installResult.createdViews).toEqual([
      'ticket-board',
      'installedAsset-grid',
      'customer-grid',
      'serviceRecord-calendar',
      'partItem-grid',
      'followUp-grid',
    ])
    expect(ensureObject).toHaveBeenCalledTimes(6)
    expect(ensureView).toHaveBeenCalledTimes(6)
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
    expect(ensureView).toHaveBeenNthCalledWith(4, {
      projectId: 'tenant_42:after-sales',
      sheetId: 'sheet_serviceRecord',
      descriptor: expect.objectContaining({
        id: 'serviceRecord-calendar',
        objectId: 'serviceRecord',
        type: 'calendar',
      }),
    })
    expect(ensureView).toHaveBeenNthCalledWith(5, {
      projectId: 'tenant_42:after-sales',
      sheetId: 'sheet_partItem',
      descriptor: expect.objectContaining({
        id: 'partItem-grid',
        objectId: 'partItem',
        type: 'grid',
      }),
    })
    expect(ensureView).toHaveBeenNthCalledWith(6, {
      projectId: 'tenant_42:after-sales',
      sheetId: 'sheet_followUp',
      descriptor: expect.objectContaining({
        id: 'followUp-grid',
        objectId: 'followUp',
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
        getRefundApproval: expect.any(Function),
        submitRefundApproval: expect.any(Function),
        submitRefundApprovalDecision: expect.any(Function),
        sendNotificationTopic: expect.any(Function),
        handleRefundApprovalDecisionCallback: expect.any(Function),
        emitTicketCreated: expect.any(Function),
        emitTicketRefundRequested: expect.any(Function),
        emitTicketOverdue: expect.any(Function),
        emitFollowUpDue: expect.any(Function),
        createTicket: expect.any(Function),
        requestTicketRefund: expect.any(Function),
        listTickets: expect.any(Function),
        deleteTicket: expect.any(Function),
      }),
    )
  })

  it('registers workflow event listeners on activate', async () => {
    expect(eventsOn).toHaveBeenCalledWith('ticket.created', expect.any(Function))
    expect(eventsOn).toHaveBeenCalledWith('ticket.assigned', expect.any(Function))
    expect(eventsOn).toHaveBeenCalledWith('ticket.overdue', expect.any(Function))
    expect(eventsOn).toHaveBeenCalledWith('ticket.refundRequested', expect.any(Function))
    expect(eventsOn).toHaveBeenCalledWith('approval.pending', expect.any(Function))
    expect(eventsOn).toHaveBeenCalledWith('followup.due', expect.any(Function))
  })

  it('unsubscribes workflow event listeners on deactivate', async () => {
    await plugin.deactivate()

    expect(eventsOff).toHaveBeenCalledTimes(6)
    expect(eventsOff).toHaveBeenNthCalledWith(1, 'sub:ticket.created')
    expect(eventsOff).toHaveBeenNthCalledWith(2, 'sub:ticket.assigned')
    expect(eventsOff).toHaveBeenNthCalledWith(3, 'sub:ticket.overdue')
    expect(eventsOff).toHaveBeenNthCalledWith(4, 'sub:ticket.refundRequested')
    expect(eventsOff).toHaveBeenNthCalledWith(5, 'sub:approval.pending')
    expect(eventsOff).toHaveBeenNthCalledWith(6, 'sub:followup.due')
  })

  it('cleans up prior workflow subscriptions before re-activating', async () => {
    const nextSetup = createContext()

    await plugin.activate(nextSetup.context)

    expect(currentContext.api.events.off).toHaveBeenCalledTimes(6)
    expect(currentContext.api.events.off).toHaveBeenNthCalledWith(1, 'sub:ticket.created')
    expect(currentContext.api.events.off).toHaveBeenNthCalledWith(2, 'sub:ticket.assigned')
    expect(currentContext.api.events.off).toHaveBeenNthCalledWith(3, 'sub:ticket.overdue')
    expect(currentContext.api.events.off).toHaveBeenNthCalledWith(4, 'sub:ticket.refundRequested')
    expect(currentContext.api.events.off).toHaveBeenNthCalledWith(5, 'sub:approval.pending')
    expect(currentContext.api.events.off).toHaveBeenNthCalledWith(6, 'sub:followup.due')
    expect(nextSetup.context.api.events.on).toHaveBeenCalledWith('ticket.created', expect.any(Function))
    expect(nextSetup.context.api.events.on).toHaveBeenCalledWith('ticket.assigned', expect.any(Function))
    expect(nextSetup.context.api.events.on).toHaveBeenCalledWith('ticket.overdue', expect.any(Function))
    expect(nextSetup.context.api.events.on).toHaveBeenCalledWith('ticket.refundRequested', expect.any(Function))
    expect(nextSetup.context.api.events.on).toHaveBeenCalledWith('approval.pending', expect.any(Function))
    expect(nextSetup.context.api.events.on).toHaveBeenCalledWith('followup.due', expect.any(Function))
  })
})
