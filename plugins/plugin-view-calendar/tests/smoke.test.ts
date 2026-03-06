import { describe, it, expect, vi } from 'vitest'
import CalendarPlugin from '../src/index'

interface RouteRegistration {
  method: string
  path: string
  handler: (req: any, res: any) => Promise<void>
}

function createResponse() {
  const response: any = {
    status: vi.fn(() => response),
    json: vi.fn(() => response),
  }
  return response
}

function createMockContext() {
  const routes: RouteRegistration[] = []
  const pluginApis = new Map<string, Record<string, (...args: any[]) => Promise<unknown> | unknown>>()
  const connectionHandlers: Array<(socket: any) => void> = []
  const messagingRequest = vi.fn()
  const eventEmit = vi.fn()

  const context = {
    metadata: {
      name: 'plugin-view-calendar',
      version: '1.0.0',
      path: '/tmp/plugin-view-calendar',
    },
    api: {
      http: {
        addRoute: vi.fn((method: string, path: string, handler: RouteRegistration['handler']) => {
          routes.push({ method, path, handler })
        }),
        removeRoute: vi.fn(),
        middleware: vi.fn(),
      },
      events: {
        emit: eventEmit,
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
      },
      messaging: {
        request: messagingRequest,
        publish: vi.fn(),
        subscribe: vi.fn(),
        subscribePattern: vi.fn(),
        unsubscribe: vi.fn(),
        rpcHandler: vi.fn(),
      },
      websocket: {
        broadcast: vi.fn(),
        broadcastTo: vi.fn(),
        sendTo: vi.fn(),
        join: vi.fn(),
        leave: vi.fn(),
        onConnection: vi.fn((handler: (socket: any) => void) => {
          connectionHandlers.push(handler)
        }),
      },
      database: {
        query: vi.fn().mockResolvedValue([]),
        transaction: vi.fn(),
        model: vi.fn(),
      },
    },
    core: {
      events: {
        emit: eventEmit,
      },
    },
    communication: {
      register: vi.fn((name: string, api: Record<string, (...args: any[]) => Promise<unknown> | unknown>) => {
        pluginApis.set(name, api)
      }),
      call: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    },
    storage: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
    config: {},
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as any

  return {
    context,
    routes,
    pluginApis,
    connectionHandlers,
    messagingRequest,
    eventEmit,
  }
}

describe('plugin-view-calendar smoke', () => {
  it('activates against the current plugin context contract', async () => {
    const plugin = new CalendarPlugin()
    const { context, routes, pluginApis, connectionHandlers, eventEmit } = createMockContext()

    await plugin.activate(context)

    expect(eventEmit).toHaveBeenCalledWith(
      'view:configProvider:register',
      expect.objectContaining({ viewType: 'calendar' }),
    )
    expect(routes.some((route) => route.path === '/api/calendar/:spreadsheetId/:viewId/config')).toBe(true)
    expect(pluginApis.get('calendar')).toEqual(
      expect.objectContaining({
        getConfig: expect.any(Function),
        getEvents: expect.any(Function),
        getConfigProvider: expect.any(Function),
      }),
    )
    expect(connectionHandlers).toHaveLength(1)
  })

  it('uses messaging for record queries and joins websocket rooms through socket handlers', async () => {
    const plugin = new CalendarPlugin()
    const {
      context,
      routes,
      pluginApis,
      connectionHandlers,
      messagingRequest,
    } = createMockContext()

    await plugin.activate(context)

    const updateConfigRoute = routes.find(
      (route) => route.method === 'PUT' && route.path === '/api/calendar/:spreadsheetId/:viewId/config',
    )
    expect(updateConfigRoute).toBeDefined()

    await updateConfigRoute!.handler(
      {
        params: { spreadsheetId: 'sheet-1', viewId: 'view-1' },
        body: {
          fieldMapping: {
            startDateField: 'start',
            titleField: 'title',
          },
        },
      },
      createResponse(),
    )

    messagingRequest.mockResolvedValue({
      success: true,
      data: {
        records: [
          {
            id: 'record-1',
            fields: {
              start: '2026-03-06T10:00:00.000Z',
              title: 'Sprint Review',
            },
          },
        ],
      },
    })

    const calendarApi = pluginApis.get('calendar')
    const result = await calendarApi!.getEvents({
      spreadsheetId: 'sheet-1',
      viewId: 'view-1',
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-31T23:59:59.000Z',
    }) as { events: Array<{ title: string; recordId: string }> }

    expect(messagingRequest).toHaveBeenCalledWith(
      'spreadsheet:records:query',
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        viewId: 'view-1',
      }),
    )
    expect(result.events).toEqual([
      expect.objectContaining({
        title: 'Sprint Review',
        recordId: 'record-1',
      }),
    ])

    const socketHandlers = new Map<string, (data: { spreadsheetId: string; viewId: string }) => void>()
    const socket = {
      join: vi.fn(),
      leave: vi.fn(),
      on: vi.fn((event: string, handler: (data: { spreadsheetId: string; viewId: string }) => void) => {
        socketHandlers.set(event, handler)
      }),
    }

    connectionHandlers[0](socket)
    socketHandlers.get('calendar:subscribe')!({ spreadsheetId: 'sheet-1', viewId: 'view-1' })
    socketHandlers.get('calendar:unsubscribe')!({ spreadsheetId: 'sheet-1', viewId: 'view-1' })

    expect(socket.join).toHaveBeenCalledWith('calendar:sheet-1:view-1')
    expect(socket.leave).toHaveBeenCalledWith('calendar:sheet-1:view-1')
  })
})
