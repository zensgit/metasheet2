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
        getObjectSheetId: (projectId: string, objectId: string) => string
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
  createRecord: ReturnType<typeof vi.fn>
  getRecord: ReturnType<typeof vi.fn>
  patchRecord: ReturnType<typeof vi.fn>
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
  const createRecord = vi.fn(async (input: { sheetId: string; data: Record<string, unknown> }) => ({
    id: 'rec_ticket_001',
    sheetId: input.sheetId,
    version: 1,
    data: input.data,
  }))
  const getRecord = vi.fn(async (input: { sheetId: string; recordId: string }) => ({
    id: input.recordId,
    sheetId: input.sheetId,
    version: 3,
    data: {
      ticketNo: 'TK-2001',
      title: 'No cooling output',
      source: 'phone',
      priority: 'high',
      status: 'new',
    },
  }))
  const patchRecord = vi.fn(async (input: { sheetId: string; recordId: string; changes: Record<string, unknown> }) => ({
    id: input.recordId,
    sheetId: input.sheetId,
    version: 4,
    data: {
      ticketNo: 'TK-2001',
      title: 'No cooling output',
      source: 'phone',
      priority: 'high',
      status: 'new',
      ...input.changes,
    },
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
          getObjectSheetId: (projectId: string, objectId: string) => `${projectId}:${objectId}:sheet`,
          ensureObject,
          ensureView,
        },
        records: {
          createRecord,
          getRecord,
          patchRecord,
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
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
  }

  return { context, routes, ensureObject, ensureView, createRecord, getRecord, patchRecord, db }
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

describe('plugin-after-sales routes', () => {
  let routes: Map<string, RegisteredHandler>
  let ensureObject: ReturnType<typeof vi.fn>
  let ensureView: ReturnType<typeof vi.fn>
  let createRecord: ReturnType<typeof vi.fn>
  let getRecord: ReturnType<typeof vi.fn>
  let patchRecord: ReturnType<typeof vi.fn>
  let db: FakeDatabase
  let communicationRegister: ReturnType<typeof vi.fn>
  let eventsOn: ReturnType<typeof vi.fn>
  let eventsEmit: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const setup = createContext()
    routes = setup.routes
    ensureObject = setup.ensureObject
    ensureView = setup.ensureView
    createRecord = setup.createRecord
    getRecord = setup.getRecord
    patchRecord = setup.patchRecord
    db = setup.db
    communicationRegister = setup.context.communication.register
    eventsOn = setup.context.api.events.on
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
        ticketNo: 'TK-2001',
        title: 'No cooling output',
        source: 'phone',
        priority: 'high',
        status: 'new',
      },
    })
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
        refundAmount: 88.5,
      },
    })
    expect(eventsEmit).toHaveBeenCalledWith(
      'ticket.refundRequested',
      expect.objectContaining({
        projectId: 'tenant_42:after-sales',
        ticket: expect.objectContaining({
          id: 'rec_ticket_001',
          ticketNo: 'TK-2001',
          refundAmount: 88.5,
          requestedBy: 'writer_42',
          requestedByName: 'Alice',
          reason: 'Damaged fan motor',
        }),
      }),
    )
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
        submitRefundApproval: expect.any(Function),
        sendNotificationTopic: expect.any(Function),
        emitTicketCreated: expect.any(Function),
        emitTicketRefundRequested: expect.any(Function),
        emitTicketOverdue: expect.any(Function),
        emitFollowUpDue: expect.any(Function),
        createTicket: expect.any(Function),
        requestTicketRefund: expect.any(Function),
      }),
    )
  })

  it('registers workflow event listeners on activate', async () => {
    expect(eventsOn).toHaveBeenCalledWith('ticket.created', expect.any(Function))
    expect(eventsOn).toHaveBeenCalledWith('ticket.assigned', expect.any(Function))
    expect(eventsOn).toHaveBeenCalledWith('ticket.refundRequested', expect.any(Function))
    expect(eventsOn).toHaveBeenCalledWith('approval.pending', expect.any(Function))
  })
})
