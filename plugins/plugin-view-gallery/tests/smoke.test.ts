import { describe, it, expect, vi } from 'vitest'
import GalleryPlugin from '../src/index'

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
      name: 'plugin-view-gallery',
      version: '1.0.0',
      path: '/tmp/plugin-view-gallery',
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

describe('plugin-view-gallery smoke', () => {
  it('activates against the current plugin context contract', async () => {
    const plugin = new GalleryPlugin()
    const { context, routes, pluginApis, connectionHandlers, eventEmit } = createMockContext()

    await plugin.activate(context)

    expect(eventEmit).toHaveBeenCalledWith(
      'view:configProvider:register',
      expect.objectContaining({ viewType: 'gallery' }),
    )
    expect(routes.some((route) => route.path === '/api/gallery/:spreadsheetId/:viewId/records')).toBe(true)
    expect(pluginApis.get('gallery')).toEqual(
      expect.objectContaining({
        getConfig: expect.any(Function),
        updateConfig: expect.any(Function),
        getConfigProvider: expect.any(Function),
      }),
    )
    expect(connectionHandlers).toHaveLength(1)
  })

  it('updates config through plugin communication and queries records through messaging', async () => {
    const plugin = new GalleryPlugin()
    const {
      context,
      routes,
      pluginApis,
      connectionHandlers,
      messagingRequest,
    } = createMockContext()

    await plugin.activate(context)

    const galleryApi = pluginApis.get('gallery')!
    const config = await galleryApi.updateConfig({
      spreadsheetId: 'sheet-1',
      viewId: 'view-1',
      config: {
        cardTemplate: {
          titleField: 'title',
          coverField: 'cover',
          visibleFields: ['title'],
        },
      },
    }) as { cardTemplate: { titleField?: string } }

    expect(config.cardTemplate.titleField).toBe('title')

    messagingRequest.mockResolvedValue({
      success: true,
      data: {
        records: [
          {
            id: 'record-1',
            fields: {
              title: 'Gallery Card',
              cover: 'https://example.com/cover.png',
            },
          },
        ],
        total: 1,
      },
    })

    const listRecordsRoute = routes.find(
      (route) => route.method === 'GET' && route.path === '/api/gallery/:spreadsheetId/:viewId/records',
    )
    expect(listRecordsRoute).toBeDefined()

    const response = createResponse()
    await listRecordsRoute!.handler(
      {
        params: { spreadsheetId: 'sheet-1', viewId: 'view-1' },
        query: { page: '1', pageSize: '20', search: '' },
      },
      response,
    )

    expect(messagingRequest).toHaveBeenCalledWith(
      'spreadsheet:records:query',
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        viewId: 'view-1',
      }),
    )
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          records: [
            expect.objectContaining({
              title: 'Gallery Card',
              coverUrl: 'https://example.com/cover.png',
            }),
          ],
        }),
      }),
    )

    const socketHandlers = new Map<string, (data: { spreadsheetId: string; viewId: string }) => void>()
    const socket = {
      join: vi.fn(),
      leave: vi.fn(),
      on: vi.fn((event: string, handler: (data: { spreadsheetId: string; viewId: string }) => void) => {
        socketHandlers.set(event, handler)
      }),
    }

    connectionHandlers[0](socket)
    socketHandlers.get('gallery:subscribe')!({ spreadsheetId: 'sheet-1', viewId: 'view-1' })
    socketHandlers.get('gallery:unsubscribe')!({ spreadsheetId: 'sheet-1', viewId: 'view-1' })

    expect(socket.join).toHaveBeenCalledWith('gallery:sheet-1:view-1')
    expect(socket.leave).toHaveBeenCalledWith('gallery:sheet-1:view-1')
  })
})
